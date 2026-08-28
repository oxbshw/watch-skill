#!/usr/bin/env node
/**
 * Every slot Watch registers into must be a slot DSH actually renders.
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
 * Usage: node scripts/verify-slots.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INVENTORY = join(ROOT, 'inventory', 'dsh-slots.json')
const CLIENT_ROOT = join(ROOT, 'packages', 'watch')

/**
 * A registration: `slots.register({ name: 'x' })`, or the `occupy(name, …)`
 * helper the Watch packages share. Both forms carry the slot as the first
 * string, so both are matched the same way.
 */
const PATTERNS = [
  /\bregister\(\s*\{[^}]*\bname:\s*['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g,
  /\boccupy\(\s*['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g,
  /\bslots\.inject\(\s*['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g,
]

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
    const lines = source.split('\n')
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS) {
        pattern.lastIndex = 0
        for (const match of line.matchAll(pattern)) {
          const name = match[1]
          if (!used.has(name)) used.set(name, [])
          used.get(name).push(`${rel}:${String(index + 1)}`)
          if (!known.has(name) && !ownSlots.has(name)) {
            findings.push(
              `${rel}:${String(index + 1)}  registers into "${name}", which DSH never renders`,
            )
          }
        }
      }
    })
  }

  if (findings.length > 0) {
    process.stderr.write(
      'watch: slot registrations that will silently never render\n\n',
    )
    for (const finding of findings) process.stderr.write(`  ${finding}\n`)
    process.stderr.write(
      `\nwatch: ${String(findings.length)} dead registration(s). `
      + `DSH ${inventory.dshVersion} renders ${String(known.size)} slot(s); `
      + 'see inventory/dsh-slots.json.\n',
    )
    process.exit(1)
  }

  process.stdout.write(
    `slots: ${String(used.size)} registration target(s), all rendered by DSH ${inventory.dshVersion}\n`,
  )
}

main()
