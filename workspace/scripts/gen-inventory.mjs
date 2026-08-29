#!/usr/bin/env node
/**
 * Generate the DeepSeek Harness source inventory this distribution is built
 * against.
 *
 * Phase 0 of the product plan forbids any claim that a capability "exists"
 * without a source path behind it. This script is how that rule is enforced:
 * it reads the pinned upstream checkout and emits machine-readable inventories
 * of packages, Cordis composition rows, UI slots, Remote services, and locale
 * namespaces. The parity register in inventory/parity.yml is checked against
 * these outputs, so a capability that disappears upstream cannot silently
 * disappear from Watch.
 *
 * Usage:
 *   node scripts/gen-inventory.mjs           write inventory/
 *   node scripts/gen-inventory.mjs --check   fail if inventory/ is stale
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = join(ROOT, 'upstream', 'deepseek-harness')
const OUT = join(ROOT, 'inventory')

const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'out', '.agents', 'website'])

/** Read the pinned baseline identity so every artifact is attributable. */
function readLock() {
  const text = readFileSync(join(ROOT, 'upstream', 'deepseek-harness.lock'), 'utf8')
  const field = (key) => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null
  }
  return { repository: field('repository'), commit: field('commit'), version: field('version'), tag: field('tag') }
}

/** Walk the checkout, yielding every file path that is not build output. */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) yield* walk(full)
    else yield full
  }
}

/** Classify a package by the workspace group that owns it. */
function groupOf(relDir) {
  const parts = relDir.split(sep)
  if (parts[0] === 'packages') return parts[1]
  if (parts[0] === 'vendor') return 'vendor'
  if (parts[0] === 'apps') return 'app'
  if (parts[0] === 'native') return 'native'
  if (parts[0] === 'python') return 'python'
  return parts[0] || 'root'
}

/** Collect every workspace package with the metadata parity work needs. */
function collectPackages(files) {
  const packages = []
  for (const file of files) {
    if (!file.endsWith(`${sep}package.json`)) continue
    const relDir = relative(UPSTREAM, dirname(file))
    if (relDir === '') continue
    if (relDir.includes(`${sep}tests${sep}`) || relDir.startsWith(`tests${sep}`)) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    if (typeof manifest.name !== 'string') continue
    packages.push({
      name: manifest.name,
      version: manifest.version ?? null,
      dir: relDir.split(sep).join('/'),
      group: groupOf(relDir),
      description: manifest.description ?? null,
      license: manifest.license ?? null,
      private: manifest.private === true,
      // The two declarations that make a package extensible from outside.
      clientHalf: manifest.dsh?.client ?? null,
      bundlePatch: manifest.dsh?.bundle?.patch ?? null,
    })
  }
  packages.sort((a, b) => a.name.localeCompare(b.name))
  return packages
}

/**
 * Read the Cordis composition rows a bundle contributes.
 *
 * The patch files are YAML with `!!js` expression tags, so a general YAML
 * parser would need the custom schema. Rows only ever need `id` and `name`
 * here, and those are plain scalars on their own lines, which a line scanner
 * reads without inventing a parser for expressions it must not evaluate.
 */
function collectComposition(files) {
  const rows = []
  for (const file of files) {
    if (!file.endsWith('cordis.patch.yml') && !file.endsWith('cordis.yml')) continue
    const rel = relative(UPSTREAM, file).split(sep).join('/')
    if (rel.includes('/tests/') || rel.includes('/fixtures/')) continue
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    let current = null
    for (const line of lines) {
      const id = /^\s*-?\s*id:\s*(.+?)\s*$/.exec(line)
      if (id) {
        if (current) rows.push(current)
        current = { source: rel, id: id[1].replace(/^["']|["']$/g, ''), module: null, disabled: false }
        continue
      }
      if (!current) continue
      const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
      if (name) current.module = name[1].replace(/^["']|["']$/g, '')
      if (/^\s*disabled:\s*true\s*$/.test(line)) current.disabled = true
    }
    if (current) rows.push(current)
  }
  return rows
}

/**
 * Collect the UI slot names client packages register into or open.
 *
 * `ctx.slots.register({ name: 'x' })` occupies a slot; `ctx.slots.inject('x')`
 * and `useSlot('x')` open one. Both directions matter: Watch occupies existing
 * slots, and needs to know which ones an upstream bump removed.
 */
function collectSlots(files) {
  const slots = new Map()
  const patterns = [
    [/slots\.register\(\s*\{\s*(?:[\s\S]{0,400}?)name:\s*'([^']+)'/g, 'register'],
    [/slots\.inject\(\s*'([^']+)'/g, 'inject'],
    [/useSlot(?:Entries|Single|s)?\(\s*'([^']+)'/g, 'consume'],
  ]
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue
    const rel = relative(UPSTREAM, file).split(sep).join('/')
    if (rel.includes('/tests/')) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes('slots')) continue
    for (const [pattern, kind] of patterns) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        const slot = match[1]
        // A computed slot name is a registration helper, not a slot identity.
        if (slot.includes('${')) continue
        if (!slots.has(slot)) slots.set(slot, { slot, register: [], inject: [], consume: [] })
        const record = slots.get(slot)
        if (!record[kind].includes(rel)) record[kind].push(rel)
      }
    }
  }
  return [...slots.values()].sort((a, b) => a.slot.localeCompare(b.slot))
}

/**
 * Collect Remote services and their methods.
 *
 * A Remote is the only path a browser half has to host behavior, so this list
 * is the real client-facing API surface. `super(ctx, 'name')` names the
 * service; `@Remote('method')` names one callable.
 */
function collectRemotes(files) {
  const services = []
  for (const file of files) {
    if (!/\.ts$/.test(file)) continue
    const rel = relative(UPSTREAM, file).split(sep).join('/')
    if (rel.includes('/tests/')) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes('TypertRemoteService')) continue
    const classPattern = /class\s+(\w+)\s+extends\s+TypertRemoteService\b([\s\S]*?)(?=\n(?:export\s+)?(?:class|function|const)\s|\n*$)/g
    let match
    while ((match = classPattern.exec(text)) !== null) {
      const [, className, body] = match
      const nameMatch = /super\(\s*\w+\s*,\s*'([^']+)'/.exec(body)
      const methods = []
      const remotePattern = /@Remote\(\s*'([^']+)'/g
      let method
      while ((method = remotePattern.exec(body)) !== null) methods.push(method[1])
      services.push({
        service: nameMatch ? nameMatch[1] : null,
        className,
        source: rel,
        methods: methods.sort(),
      })
    }
  }
  return services.sort((a, b) => String(a.service).localeCompare(String(b.service)))
}

/** Collect locale namespaces so Watch copy never collides with upstream keys. */
function collectLocaleNamespaces(files) {
  const namespaces = new Map()
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue
    const rel = relative(UPSTREAM, file).split(sep).join('/')
    if (rel.includes('/tests/')) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes('LocaleNamespaceMap')) continue
    const block = /interface\s+LocaleNamespaceMap\s*\{([\s\S]*?)\n\s*\}/g
    let match
    while ((match = block.exec(text)) !== null) {
      const keyPattern = /'([^']+)'\s*:/g
      let key
      while ((key = keyPattern.exec(match[1])) !== null) {
        if (!namespaces.has(key[1])) namespaces.set(key[1], rel)
      }
    }
  }
  return [...namespaces.entries()]
    .map(([namespace, source]) => ({ namespace, source }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace))
}

/** Serialize with a stable trailing newline so --check is a clean diff. */
function stable(value) {
  return JSON.stringify(value, undefined, 2) + '\n'
}

function main() {
  const check = process.argv.includes('--check')
  if (!existsSync(UPSTREAM)) {
    process.stderr.write(
      'watch: upstream checkout missing. Run `node scripts/upstream-sync.mjs` first.\n',
    )
    process.exit(2)
  }

  const baseline = readLock()
  const files = [...walk(UPSTREAM)]

  const packages = collectPackages(files)
  const composition = collectComposition(files)
  const slots = collectSlots(files)
  const remotes = collectRemotes(files)
  const locales = collectLocaleNamespaces(files)

  const header = { generatedFrom: baseline, generator: 'scripts/gen-inventory.mjs' }
  const artifacts = {
    'packages.json': stable({
      ...header,
      count: packages.length,
      byGroup: Object.fromEntries(
        [...new Set(packages.map(p => p.group))].sort()
          .map(g => [g, packages.filter(p => p.group === g).length]),
      ),
      packages,
    }),
    'composition.json': stable({ ...header, count: composition.length, rows: composition }),
    'slots.json': stable({ ...header, count: slots.length, slots }),
    'remotes.json': stable({ ...header, count: remotes.length, services: remotes }),
    'locales.json': stable({ ...header, count: locales.length, namespaces: locales }),
  }

  let stale = false
  for (const [file, content] of Object.entries(artifacts)) {
    const path = join(OUT, file)
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (existing === content) continue
    if (check) {
      stale = true
      process.stderr.write(`watch: inventory/${file} is stale\n`)
      continue
    }
    writeFileSync(path, content)
    process.stdout.write(`wrote inventory/${file}\n`)
  }

  if (check && stale) {
    process.stderr.write('watch: run `node scripts/gen-inventory.mjs` and commit the result\n')
    process.exit(1)
  }
  if (!check) {
    process.stdout.write(
      `\nbaseline ${baseline.version} (${baseline.commit?.slice(0, 12)})\n`
      + `  packages     ${packages.length}\n`
      + `  cordis rows  ${composition.length}\n`
      + `  slots        ${slots.length}\n`
      + `  remotes      ${remotes.length}\n`
      + `  locale ns    ${locales.length}\n`,
    )
  }
}

main()
