#!/usr/bin/env node
/**
 * The DSH UI slot vocabulary, read out of the pinned packages.
 *
 * A slot exists because a DSH component calls `renderSlot("name", …)`. That
 * call is the *definition* — the host saying "anything registered here will be
 * drawn". Registering into a name that no component renders is not an error at
 * any level: `slots.register` accepts it, the plugin loads, the tests pass, and
 * nothing ever appears. It is the quietest possible failure, and it is why the
 * product could be fully built, fully tested and still look like stock DSH.
 *
 * So the vocabulary is extracted rather than remembered, from the same pinned
 * version the profile installs, and written to `inventory/dsh-slots.json` where
 * `verify-slots.mjs` can check Watch's registrations against it offline.
 *
 * Two details worth keeping straight:
 *
 *   - `renderSlot` frequently carries a `fallback`. An unregistered brand slot
 *     therefore renders DeepSeek's own mark rather than nothing, which is why
 *     brand needs both a Watch registration *and* the official row disabled.
 *   - i18n keys look exactly like slot names (`session.new`, `toggle.open`).
 *     Only `renderSlot` call sites count; a bare dotted string does not.
 *
 * Usage:
 *   node scripts/gen-dsh-slots.mjs              write the inventory
 *   node scripts/gen-dsh-slots.mjs --check      fail if it is stale
 *
 * Set WATCH_DSH_TREE to point at a tree containing the installed
 * @deepseek-ai packages. The default is the install-smoke tree.
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

/** The definition side. Only these names are real slots. */
const RENDER_SLOT = /renderSlot\(\s*["']([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)["']/g

/**
 * The cardinality side: a parent entry's children table declares each child
 * slot's kind, and the kind decides what a registration into it means.
 *
 *   single  one entry per priority. A second at the same priority throws; at a
 *           different priority it *shadows* — and shadowing a slot DSH already
 *           fills replaces an official capability rather than adding to it.
 *   list    many entries, ordered. The only kind that is safely additive.
 *   keyed   requires `options.key`; a registration without one throws.
 *
 * Without this, the only way to learn a slot's kind is to boot the app and
 * read the exception — one slot per restart.
 */
const SLOT_KIND = /["']([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*)["']\s*:\s*\{\s*kind:\s*["'](single|keyed|list)["']/g

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
    // In check mode with no DSH tree, the committed inventory is all we have —
    // and that is the normal fresh-clone case, so it is not a failure.
    if (check && existsSync(OUT)) {
      process.stdout.write('dsh-slots: no DSH tree here; keeping the committed inventory\n')
      return
    }
    process.stderr.write('watch: no DSH install found. Set WATCH_DSH_TREE.\n')
    process.exit(1)
  }

  const slots = new Map()
  const kinds = new Map()
  let bundles = 0
  for (const path of clientBundles(tree)) {
    bundles += 1
    const source = readFileSync(path, 'utf8')
    const owner = /@deepseek-ai[\\/]([^\\/]+)/.exec(path)?.[1] ?? 'unknown'
    for (const match of source.matchAll(RENDER_SLOT)) {
      const name = match[1]
      if (!slots.has(name)) slots.set(name, new Set())
      slots.get(name).add(owner)
    }
    for (const match of source.matchAll(SLOT_KIND)) kinds.set(match[1], match[2])
  }

  if (slots.size === 0) {
    process.stderr.write(`watch: found ${String(bundles)} bundle(s) under ${tree} but no renderSlot call\n`)
    process.exit(1)
  }

  // The DSH version these came from, so a bump that moves a slot is visible.
  let version = 'unknown'
  for (const candidate of [join(tree, '@deepseek-ai', 'dsh', 'package.json')]) {
    if (existsSync(candidate)) version = JSON.parse(readFileSync(candidate, 'utf8')).version
  }

  const document = {
    generatedBy: 'scripts/gen-dsh-slots.mjs',
    dshVersion: version,
    note:
      'Slot names DSH actually renders. Extracted from renderSlot() call sites in '
      + 'the pinned packages — the definition side. Registering into a name absent '
      + 'from this list is a silent no-op: it loads, it tests green, it never draws.',
    bundlesScanned: bundles,
    slots: Object.fromEntries(
      [...slots.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, owners]) => [name, {
          kind: kinds.get(name) ?? 'unknown',
          renderedBy: [...owners].sort(),
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

  const byKind = {}
  for (const name of slots.keys()) {
    const kind = kinds.get(name) ?? 'unknown'
    byKind[kind] = (byKind[kind] ?? 0) + 1
  }
  process.stdout.write(
    `dsh-slots: ${String(slots.size)} slot(s) from ${String(bundles)} bundle(s), DSH ${version}
`
    + Object.entries(byKind).sort()
      .map(([kind, count]) => `  ${kind.padEnd(8)} ${String(count)}
`).join(''),
  )
}

main()
