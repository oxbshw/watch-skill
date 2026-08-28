#!/usr/bin/env node
/**
 * Every slot Watch registers into must be a slot DSH actually renders, and the
 * registration must match that slot's declared kind.
 *
 * This gate exists because of the failure it was written to catch. Four Watch
 * client packages were complete, unit-tested and green while targeting nine
 * slot names that do not exist upstream — `sidebar.nav`, `inspector.panel`,
 * `workspace.memory` and others. Nothing complained. `slots.register` accepts
 * any string, the plugin loads, the components pass their tests, and the
 * product renders as stock DSH because nothing is ever drawn.
 *
 * That is the worst shape a bug can have: everything green, nothing visible.
 * A component test cannot catch it, because the component is fine. Only the
 * pairing of registration against `renderSlot` can, so that pairing is checked
 * here against `inventory/dsh-slots.json` — generated from the pinned packages
 * by `gen-dsh-slots.mjs`, and committed so this runs in a fresh clone.
 *
 * The inventory also records each slot's declared kind, and the kind decides
 * what a registration means:
 *
 *   list    many entries, ordered. Purely additive, and the safe default.
 *   keyed   requires `options.key`; without one the registration throws at boot.
 *   single  one entry per priority. A second at the same priority throws, and
 *           at a different priority it *shadows* the first. Shadowing a seat
 *           DSH already fills does not add a Watch capability — it removes an
 *           official one, which this distribution is never allowed to do.
 *
 * Without this, a slot's kind can only be learned by booting the app and
 * reading the exception, one slot per restart.
 *
 * Usage: node scripts/verify-slots.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INVENTORY = join(ROOT, 'inventory', 'dsh-slots.json')
const CLIENT_ROOT = join(ROOT, 'packages', 'watch')

/**
 * The single slots Watch is allowed to occupy, and why.
 *
 * All three are the brand identity, and they are legitimate for one reason:
 * the bundle disables `ui-brand-official`, so nothing of DSH's is displaced —
 * the seat is empty when Watch takes it. This is the single entry the parity
 * register marks `intentionally_replaced`.
 *
 * Attribution does not rely on a shadow at all: `sidebar.footer.action` is a
 * list, so it sits alongside whatever else is there.
 *
 * Anything added here needs the same two things: an empty seat, and a reason.
 */
const SHADOWS = new Map([
  ['sidebar.brand.mark', 'ui-brand-official is disabled by the bundle, so the seat is empty'],
  ['sidebar.brand.name', 'ui-brand-official is disabled by the bundle, so the seat is empty'],
  ['conversation.hero.brand.mark', 'ui-brand-official is disabled by the bundle, so the seat is empty'],
])

/**
 * Actual registrations — these place a component, so cardinality applies.
 * `occupy(name, …)` is the helper the Watch packages share for the same thing.
 */
const REGISTRATIONS = [
  /\bregister\(\s*\{[^}]*\bname:\s*['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g,
  /\boccupy\(\s*['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g,
]

/**
 * `slots.inject(name, …)` declares a dependency on a slot existing before
 * registering into it. It places nothing, so it carries no key and displaces
 * nothing. The name still has to be real; nothing else applies.
 */
const DECLARATIONS = [
  /\bslots\.inject\(\s*['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g,
]

/** `key` as ES shorthand (`{ name, key }`) counts as much as `key: value`. */
const CARRIES_KEY = /(^|[^A-Za-z0-9_])key\s*[:,}]/

function* clientSources(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === 'dist') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* clientSources(path)
    else if (/\.(tsx|ts)$/.test(entry) && !entry.endsWith('.d.ts')) yield path
  }
}

function main() {
  if (!existsSync(INVENTORY)) {
    process.stderr.write('watch: inventory/dsh-slots.json is missing — run `node scripts/gen-dsh-slots.mjs`\n')
    process.exit(1)
  }

  const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'))
  const known = new Set(Object.keys(inventory.slots))
  const kindOf = name => inventory.slots[name]?.kind ?? 'unknown'

  /** Slots Watch defines for itself, by rendering them in its own components. */
  const ownSlots = new Set()
  const sources = []
  for (const path of clientSources(CLIENT_ROOT)) {
    const source = readFileSync(path, 'utf8')
    sources.push([relative(ROOT, path).replace(/\\/g, '/'), source])
    for (const match of source.matchAll(/renderSlot\(\s*['"]([a-z][a-zA-Z0-9.]+)['"]/g)) {
      ownSlots.add(match[1])
    }
  }

  const findings = []
  const used = new Map()

  for (const [rel, source] of sources) {
    source.split('\n').forEach((line, index) => {
      const where = `${rel}:${String(index + 1)}`
      for (const [patterns, places] of [[REGISTRATIONS, true], [DECLARATIONS, false]]) {
        for (const pattern of patterns) {
          pattern.lastIndex = 0
          for (const match of line.matchAll(pattern)) {
            const name = match[1]
            if (!used.has(name)) used.set(name, [])
            used.get(name).push(where)

            if (!known.has(name)) {
              if (!ownSlots.has(name)) {
                findings.push(`${where}  registers into "${name}", which DSH never renders`)
              }
              continue
            }
            if (!places) continue

            const kind = kindOf(name)
            if (kind === 'single' && !SHADOWS.has(name)) {
              findings.push(
                `${where}  registers into the single slot "${name}". A second entry there `
                + 'shadows whatever DSH put in it rather than sitting beside it — declare it '
                + 'in SHADOWS with a reason, or use a list slot.',
              )
            }
            if (kind === 'keyed' && !CARRIES_KEY.test(line)) {
              findings.push(
                `${where}  registers into the keyed slot "${name}" without options.key, `
                + 'which throws at boot.',
              )
            }
          }
        }
      }
    })
  }

  if (findings.length > 0) {
    process.stderr.write('watch: slot registrations that would not do what they say\n\n')
    for (const finding of findings) process.stderr.write(`  ${finding}\n`)
    process.stderr.write(
      `\nwatch: ${String(findings.length)} bad registration(s). `
      + `DSH ${inventory.dshVersion} renders ${String(known.size)} slot(s); `
      + 'see inventory/dsh-slots.json.\n',
    )
    process.exit(1)
  }

  process.stdout.write(
    `slots: ${String(used.size)} target(s), all rendered by DSH ${inventory.dshVersion}\n`
    + [...used.keys()].sort().map(name => `  ${kindOf(name).padEnd(7)} ${name}\n`).join(''),
  )
}

main()
