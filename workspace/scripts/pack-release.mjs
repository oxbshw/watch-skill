#!/usr/bin/env node
/**
 * Pack every publishable package, and read what came out.
 *
 * A manifest describes what a package *intends* to ship. A tarball is what it
 * actually ships, and the two disagree more often than anyone expects: an
 * `exports` entry pointing at a declaration nobody generated, a `files` glob
 * that quietly stopped matching, a `workspace:` range that only pnpm can
 * resolve, a stray log or profile directory swept in by a broad pattern.
 *
 * So this packs with **pnpm**, not npm — pnpm is what rewrites `workspace:^`
 * into a real range, and a tarball packed the other way is one nobody outside
 * this repository could install — and then opens each tarball and checks it:
 *
 * - nothing in it may be a credential, a `.env`, a log, a QA profile, or a
 *   path from the machine that built it;
 * - every `exports` target, `bin` and `types` entry must be a file that is
 *   really in there;
 * - no dependency may still say `workspace:`, name a private package, or
 *   mention the scope this project used to publish under.
 *
 * What it writes is evidence: `inventory/packed-artifacts.json` records name,
 * version, size, SHA-256, unpacked size, the full file list, dependencies and
 * exports for all twenty, so a later claim about a release can be checked
 * against the artifacts rather than against a memory of them.
 *
 * Usage:
 *   node scripts/pack-release.mjs
 *   node scripts/pack-release.mjs --out <dir>
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { audit } from './verify-publishable.mjs'
import { byCodeUnit } from './lib/order.mjs'
import { resolvePnpm } from './lib/process.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Things that must never be inside a tarball, by the name they arrive under. */
const FORBIDDEN_FILES = [
  { rule: 'dotenv', pattern: /(^|\/)\.env(\.|$)/ },
  { rule: 'npm-credentials', pattern: /(^|\/)\.npmrc$/ },
  { rule: 'log', pattern: /\.log$/ },
  { rule: 'private-key', pattern: /\.(pem|key|p12|pfx|jks)$/ },
  { rule: 'ssh-key', pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/ },
  { rule: 'vcs', pattern: /(^|\/)\.git(\/|$)/ },
  { rule: 'nested-install', pattern: /(^|\/)node_modules(\/|$)/ },
  { rule: 'qa-profile', pattern: /(^|\/)(\.dsh-home|qa|screenshots)(\/|$)/ },
  { rule: 'build-cache', pattern: /\.tsbuildinfo$/ },
]

/** Things that must never be inside a *file* in a tarball. */
const FORBIDDEN_CONTENT = [
  { rule: 'maintainer-drive', pattern: /[A-Za-z]:[\\/]{1,2}(Users|watch-skill|watch-toolchain)/ },
  { rule: 'maintainer-home', pattern: /\/(Users|home)\/[A-Za-z0-9._-]+\// },
  { rule: 'stale-scope', pattern: /@watchskill\// },
  { rule: 'workspace-protocol', pattern: /"workspace:/ },
  { rule: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/ },
  { rule: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { rule: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  { rule: 'aws-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'authorization-header', pattern: /[Aa]uthorization:\s*(Bearer|Basic)\s+[A-Za-z0-9._-]{16,}/ },
]

/** Files worth scanning as text at all. */
const TEXT = /\.(js|mjs|cjs|ts|mts|cts|d\.ts|json|yml|yaml|md|map|html|css|txt)$/

/** Run a command and hand back everything it did. */
function run(command, args, options = {}) {
  const ran = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
}

/**
 * Run pnpm, through the boundary the product uses.
 *
 * This used to build a quoted command string and ask for a shell, because on
 * Windows `pnpm` is a `.cmd` and Node will not spawn one otherwise. That
 * worked — and it was a *second* answer to a question the shipped CLI answered
 * differently and wrongly, which is how `spawn EINVAL` reached a user's
 * machine. `resolvePnpm` is now the single answer: it finds the `.js` entry
 * behind the shim (a real pnpm install, or the Corepack shim a Node
 * distribution provides) so Node runs it directly, with no shell and no
 * quoting, on every platform. A path with a space is then simply an argument.
 */
function pnpmPack(args, cwd) {
  const pnpm = resolvePnpm()
  if (pnpm === null) {
    return { code: 1, stdout: '', stderr: 'no pnpm this tooling can run was found' }
  }
  return run(pnpm.command, [...pnpm.prefix, ...args], { cwd })
}

/**
 * Every path inside a tarball, without unpacking it.
 *
 * Run from the tarball's own directory with a bare filename, because a tar
 * that sees `D:\...` reads the drive letter as a remote host and tries to
 * connect to it.
 */
function listing(tarball) {
  const ran = run('tar', ['-tzf', basename(tarball)], { cwd: dirname(tarball) })
  if (ran.code !== 0) throw new Error(`tar could not read ${tarball}: ${ran.stderr}`)
  return ran.stdout.split('\n')
    .map(line => line.trim().replace(/^package\//, ''))
    .filter(line => line !== '' && !line.endsWith('/'))
    .sort()
}

/** One file out of a tarball, as text. */
function extract(tarball, path) {
  const ran = run('tar', ['-xzOf', basename(tarball), `package/${path}`],
    { cwd: dirname(tarball), maxBuffer: 64 * 1024 * 1024 })
  return ran.code === 0 ? ran.stdout : null
}

/** Every file an `exports` map points at, however deeply it nests. */
function exportTargets(exports_) {
  const out = []
  const walk = value => {
    if (typeof value === 'string') { out.push(value); return }
    if (value === null || typeof value !== 'object') return
    for (const nested of Object.values(value)) walk(nested)
  }
  walk(exports_)
  return out.filter(target => target.startsWith('./')).map(target => target.slice(2))
}

/** Pack one package and describe what came out of it. */
function packOne(entry, out) {
  const dir = join(ROOT, entry.dir)
  const packed = pnpmPack(['pack', '--pack-destination', out], dir)
  if (packed.code !== 0) {
    throw new Error(`pnpm pack failed for ${entry.manifest.name}:\n${packed.stderr}`)
  }
  const filename = packed.stdout.trim().split('\n').map(line => line.trim())
    .reverse().find(line => line.endsWith('.tgz'))
  if (filename === undefined) throw new Error(`pnpm pack printed no tarball for ${entry.dir}`)

  const tarball = join(out, filename.split(/[\\/]/).pop())
  const bytes = readFileSync(tarball)
  const files = listing(tarball)
  const manifest = JSON.parse(extract(tarball, 'package.json') ?? '{}')

  let unpacked = 0
  const problems = []
  const say = (rule, file, detail) => problems.push({ package: manifest.name, rule, file, detail })

  for (const file of files) {
    for (const { rule, pattern } of FORBIDDEN_FILES) {
      if (pattern.test(file)) say(rule, file, 'must not be published')
    }
  }

  for (const file of files) {
    if (!TEXT.test(file)) continue
    const text = extract(tarball, file)
    if (text === null) continue
    unpacked += Buffer.byteLength(text)
    for (const { rule, pattern } of FORBIDDEN_CONTENT) {
      // Redacted on purpose: a report that quotes the finding publishes it.
      if (pattern.test(text)) say(rule, file, 'matched a forbidden content rule')
    }
  }

  // What it says it ships must be in there. `exports` pointing at a
  // declaration nobody generated is the failure this catches, and it is
  // invisible until somebody installs the package.
  const promised = new Set([
    ...exportTargets(manifest.exports ?? {}),
    ...Object.values(manifest.bin ?? {}).map(path => path.replace(/^\.\//, '')),
    ...(manifest.types === undefined ? [] : [manifest.types]),
    ...(manifest.main === undefined ? [] : [manifest.main]),
  ])
  const have = new Set(files)
  for (const target of promised) {
    if (target === 'package.json') continue
    if (!have.has(target)) say('missing-file', target, 'is promised by the manifest and absent')
  }

  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith('workspace:')) {
        say('workspace-protocol', 'package.json', `${dep} is still a workspace range`)
      }
      if (dep === '@deepwatch/desktop' || dep === '@deepwatch/monorepo') {
        say('private-dependency', 'package.json', `${dep} is never published`)
      }
    }
  }

  return {
    record: {
      file: filename.split(/[\\/]/).pop(),
      name: manifest.name,
      version: manifest.version,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fileCount: files.length,
      unpackedTextBytes: unpacked,
      dependencies: manifest.dependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      exports: Object.keys(manifest.exports ?? {}).sort(),
      bin: Object.keys(manifest.bin ?? {}).sort(),
      files,
    },
    problems,
  }
}

function main() {
  const outFlag = process.argv.indexOf('--out')
  const out = outFlag >= 0 ? process.argv[outFlag + 1] : join(ROOT, '.release-artifacts')

  const report = audit()
  if (report.problems.length > 0) {
    for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
    process.stderr.write('\npack: refusing to pack a workspace that fails its metadata gate\n')
    return 1
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const entries = []
  for (const parent of ['packages/watch', 'apps']) {
    const at = join(ROOT, parent)
    if (!existsSync(at)) continue
    for (const name of readdirSync(at)) {
      const path = join(at, name, 'package.json')
      if (!existsSync(path)) continue
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (manifest.private === true) continue
      entries.push({ dir: `${parent}/${name}`, manifest })
    }
  }

  const records = []
  const problems = []
  for (const entry of entries.sort((a, b) => byCodeUnit(a.manifest.name, b.manifest.name))) {
    process.stdout.write(`  packing ${entry.manifest.name}\n`)
    const packed = packOne(entry, out)
    records.push(packed.record)
    problems.push(...packed.problems)
  }

  // Nothing may be in the output directory that this run did not pack — a
  // stale tarball from an earlier version is exactly the artifact somebody
  // publishes by accident.
  const stray = readdirSync(out).filter(
    name => !records.some(record => record.file === name))
  for (const name of stray) {
    problems.push({ package: '(output)', rule: 'stray-artifact', file: name, detail: 'not packed by this run' })
  }

  const inventory = {
    generatedBy: 'scripts/pack-release.mjs',
    note: 'Packed with pnpm, which rewrites workspace: ranges. Nothing here has '
      + 'been published; these are local artifacts used for install testing.',
    packedAt: new Date().toISOString().slice(0, 10),
    directory: outFlag >= 0 ? out : '.release-artifacts',
    counts: {
      packages: records.length,
      bytes: records.reduce((total, record) => total + record.bytes, 0),
      files: records.reduce((total, record) => total + record.fileCount, 0),
    },
    packages: records,
  }
  const serialised = `${JSON.stringify(inventory, null, 2)}\n`
  writeFileSync(join(ROOT, 'inventory', 'packed-artifacts.json'), serialised)
  // And beside the tarballs themselves, so the artifact directory describes
  // what is in it. `deepwatch setup --artifacts <dir>` reads this to check
  // every tarball's digest before installing one, and a directory of tarballs
  // with no inventory is a directory nobody can verify.
  writeFileSync(join(out, 'packed-artifacts.json'), serialised)

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`  ${problem.package}: ${problem.rule} in ${problem.file} — ${problem.detail}\n`)
    }
    process.stderr.write(`\npack: ${problems.length} problem(s) in the packed artifacts\n`)
    return 1
  }
  const megabytes = (inventory.counts.bytes / 1024 / 1024).toFixed(1)
  process.stdout.write(
    `\npacked ${records.length} packages, ${inventory.counts.files} files, ${megabytes} MB `
    + `into ${inventory.directory}\n`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`pack: ${error.message}\n`)
    process.exitCode = 1
  }
}
