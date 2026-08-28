#!/usr/bin/env node
/**
 * The DSH UI slot vocabulary, read from DSH's own slot contract.
 *
 * Two sources, because neither is complete on its own.
 *
 * DSH ships a machine-readable catalogue — key, kind, scope, a summary and the
 * declaring file — embedded in `dsh-cordis-client-runner`. That is the
 * contract, and it is the only place `kind` and `scope` can be read rather than
 * guessed. But it omits two slots DSH demonstrably renders
 * (`conversation.composer.bar`, `conversation.input.attachments`), and the
 * runtime proves they exist: registering into the first throws
 * "single slot conversation.composer.bar already has a registration".
 *
 * Scraping `renderSlot()` call sites finds those two and misses three others
 * (`root`, `sidebar`, `details`) that are mounted as container seats rather
 * than through a call this can see.
 *
 * So the inventory is the union, and a slot the catalogue does not describe is
 * recorded with `kind: "unknown"`. `verify-slots.mjs` then treats unknown as
 * strictly as `single`: if we cannot prove a seat is safe to join, taking it
 * needs the same written justification as shadowing one.
 *
 * Three fields matter downstream:
 *
 *   kind    `list` is additive. `keyed` requires `options.key`. `single` holds
 *           one entry per priority, so a second registration *shadows* rather
 *           than joins — and shadowing a seat DSH fills removes an official
 *           capability instead of adding a Watch one.
 *   scope   `root` slots are mounted for the whole application; `session` slots
 *           live inside a session and are simply absent until one is open. A
 *           session-scoped registration that draws nothing on a blank
 *           workspace is correct behaviour, not a dead registration.
 *   key     the name a registration has to match exactly.
 *
 * Registering into a name absent from this catalogue is not an error at any
 * level: `slots.register` accepts it, the plugin loads, its tests pass, and
 * nothing is ever drawn. That is why the vocabulary is extracted rather than
 * remembered, and committed so `verify-slots.mjs` runs in a fresh clone with no
 * DSH tree present.
 *
 * Usage:
 *   node scripts/gen-dsh-slots.mjs              write the inventory
 *   node scripts/gen-dsh-slots.mjs --check      fail if it is stale
 *
 * Set WATCH_DSH_TREE to a tree containing the installed @deepseek-ai packages.
 * The default is the install-smoke tree.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'inventory', 'dsh-slots.json')

/** Trees that may hold a real DSH install, in preference order. */
const CANDIDATES = [
  process.env.WATCH_DSH_TREE,
  'G:/watch-smoke/node_modules',
  'G:/watch-manual/dsh-home/profiles/web/node_modules',
  join(ROOT, 'node_modules'),
].filter(path => path !== undefined)

/**
 * One catalogue entry, as DSH serialises it.
 *
 * The field order is fixed by the generator upstream uses, so a positional
 * match is safe and much cheaper than parsing the surrounding object.
 */
const CATALOGUE
  = /\{\s*key:\s*["']([a-z][a-zA-Z0-9.]+)["'],\s*kind:\s*["'](single|list|keyed)["'],\s*scope:\s*["'](root|session)["']/g

/** A call site, for the slots the catalogue leaves out. */
const RENDER_SLOT = /renderSlot\(\s*["']([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)["']/g

function* clientBundles(dir, depth = 0) {
  if (depth > 8) return
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry)
    let stats
    try { stats = statSync(path) } catch { continue }
    if (stats.isDirectory()) yield* clientBundles(path, depth + 1)
    else if (entry === 'client.js' && path.includes('deepseek')) yield path
  }
}

function main() {
  const check = process.argv.includes('--check')

  const tree = CANDIDATES.find(path => existsSync(path))
  if (tree === undefined) {
    // In check mode with no DSH tree the committed inventory is all there is,
    // and that is the normal fresh-clone case rather than a failure.
    if (check && existsSync(OUT)) {
      process.stdout.write('dsh-slots: no DSH tree here; keeping the committed inventory\n')
      return
    }
    process.stderr.write('watch: no DSH install found. Set WATCH_DSH_TREE.\n')
    process.exit(1)
  }

  const slots = new Map()
  let bundles = 0
  for (const path of clientBundles(tree)) {
    bundles += 1
    const source = readFileSync(path, 'utf8')
    const owner = /@deepseek-ai[\\/]([^\\/]+)/.exec(path)?.[1] ?? 'unknown'
    for (const match of source.matchAll(CATALOGUE)) {
      const [, name, kind, scope] = match
      const existing = slots.get(name)
      if (existing === undefined) {
        slots.set(name, { kind, scope, declaredBy: new Set([owner]), source: 'contract' })
      } else {
        existing.kind = kind
        existing.scope = scope
        existing.source = 'contract'
        existing.declaredBy.add(owner)
      }
    }
    for (const match of source.matchAll(RENDER_SLOT)) {
      const name = match[1]
      if (slots.has(name)) continue
      slots.set(name, {
        kind: 'unknown', scope: 'unknown', declaredBy: new Set([owner]), source: 'call-site',
      })
    }
  }

  if (slots.size === 0) {
    process.stderr.write(
      `watch: found ${String(bundles)} bundle(s) under ${tree} but no slot catalogue\n`,
    )
    process.exit(1)
  }

  // The DSH version these came from, so a bump that moves a slot is visible.
  let version = 'unknown'
  const manifest = join(tree, '@deepseek-ai', 'dsh', 'package.json')
  if (existsSync(manifest)) version = JSON.parse(readFileSync(manifest, 'utf8')).version

  const document = {
    generatedBy: 'scripts/gen-dsh-slots.mjs',
    dshVersion: version,
    note:
      "DSH's own slot contract, read from the catalogue it embeds in "
      + 'dsh-cordis-client-runner. Registering into a name absent from this list '
      + 'is a silent no-op: it loads, it tests green, it never draws. `kind` '
      + 'decides what a registration means — list is additive, single shadows '
      + '(and shadowing a seat DSH fills removes an official capability), keyed '
      + 'requires options.key. `scope` says where it renders: a root slot is '
      + 'always mounted, a session slot is absent until a session is open. '
      + 'A slot found only at a call site carries kind "unknown", and the gate '
      + 'treats unknown exactly as strictly as single.',
    bundlesScanned: bundles,
    slots: Object.fromEntries(
      [...slots.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => [name, {
          kind: entry.kind,
          scope: entry.scope,
          source: entry.source,
          declaredBy: [...entry.declaredBy].sort(),
        }]),
    ),
  }

  const json = `${JSON.stringify(document, null, 2)}\n`

  if (check) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== json) {
      process.stderr.write('watch: inventory/dsh-slots.json is stale — run `node scripts/gen-dsh-slots.mjs`\n')
      process.exit(1)
    }
    process.stdout.write(`dsh-slots: current — ${String(slots.size)} slot(s)\n`)
    return
  }

  writeFileSync(OUT, json, 'utf8')

  const tally = {}
  for (const entry of slots.values()) {
    tally[entry.kind] = (tally[entry.kind] ?? 0) + 1
    tally[entry.scope] = (tally[entry.scope] ?? 0) + 1
  }
  process.stdout.write(
    `dsh-slots: ${String(slots.size)} slot(s) from ${String(bundles)} bundle(s), DSH ${version}\n`
    + Object.entries(tally).sort()
      .map(([label, count]) => `  ${label.padEnd(8)} ${String(count)}\n`).join(''),
  )
}

main()
