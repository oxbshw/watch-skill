#!/usr/bin/env node
/**
 * Fail when a DeepSeek Harness product capability has no parity decision.
 *
 * This is the gate behind the plan's release blocker "the parity manifest
 * contains an unknown capability". It reads the generated inventory — not a
 * hand-maintained list — so an upstream bump that adds, renames or removes a
 * client product package cannot pass until someone records what Watch does
 * with it.
 *
 * Usage: node scripts/verify-parity.mjs
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const VALID_STATUS = new Set(['preserved', 'extended', 'intentionally_replaced', 'not_applicable'])
const VALID_CLASSIFICATION = new Set([
  'DSH_EXISTING', 'DSH_EXTENDED', 'WATCH_EXISTING', 'WATCH_NEW', 'DEFERRED',
])

/**
 * Read the parity register.
 *
 * The register is a flat list of records with scalar fields, so a line scanner
 * reads it exactly. Pulling a YAML dependency in to parse a file this shape
 * would add a runtime dependency to a gate that must keep working when the
 * install tree is broken — which is precisely when parity questions get asked.
 */
function readRegister() {
  const text = readFileSync(join(ROOT, 'inventory', 'parity.yml'), 'utf8')
  const entries = []
  let current = null
  let inCapabilities = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (/^capabilities:\s*$/.test(line)) { inCapabilities = true; continue }
    if (!inCapabilities) continue
    if (/^\S/.test(line)) break
    const start = /^\s*-\s+id:\s*(.+)$/.exec(line)
    if (start) {
      if (current) entries.push(current)
      current = { id: start[1].trim(), line: raw }
      continue
    }
    if (!current) continue
    const field = /^\s+(\w+):\s*(.*)$/.exec(line)
    if (!field) continue
    const [, key, value] = field
    if (value === '' || value === '>-' || value === '>' || value === '|') continue
    current[key] = value.trim().replace(/^["']|["']$/g, '')
  }
  if (current) entries.push(current)
  return entries
}

function main() {
  const inventory = JSON.parse(readFileSync(join(ROOT, 'inventory', 'packages.json'), 'utf8'))
  const register = readRegister()
  const problems = []

  const declared = new Map()
  const seenIds = new Set()
  for (const entry of register) {
    if (seenIds.has(entry.id)) problems.push(`duplicate capability id: ${entry.id}`)
    seenIds.add(entry.id)
    if (!VALID_STATUS.has(entry.status)) {
      problems.push(`${entry.id}: invalid status ${JSON.stringify(entry.status ?? null)}`)
    }
    if (!VALID_CLASSIFICATION.has(entry.classification)) {
      problems.push(`${entry.id}: invalid classification ${JSON.stringify(entry.classification ?? null)}`)
    }
    if (entry.status === 'intentionally_replaced' && !entry.adr) {
      problems.push(`${entry.id}: intentionally_replaced requires an 'adr' field`)
    }
    if (entry.status === 'not_applicable' && !entry.reason) {
      problems.push(`${entry.id}: not_applicable requires a 'reason' field`)
    }
    if (entry.package) declared.set(entry.package, entry)
  }

  // Every shipped client product package needs a decision. The client tier is
  // the user-facing product surface; that is what parity is a promise about.
  const products = inventory.packages.filter(p => p.group === 'client' && !p.private)
  for (const pkg of products) {
    if (!declared.has(pkg.name)) {
      problems.push(`unclassified DSH capability: ${pkg.name} (${pkg.dir})`)
    }
  }

  // A register entry pointing at a package the baseline no longer ships is a
  // stale promise, and just as dangerous as a missing one.
  const shipped = new Set(inventory.packages.map(p => p.name))
  for (const [name, entry] of declared) {
    if (!shipped.has(name)) {
      problems.push(`${entry.id}: package ${name} is not in the pinned baseline`)
    }
  }

  const counts = {}
  for (const entry of register) counts[entry.status] = (counts[entry.status] ?? 0) + 1

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} parity problem(s)\n`)
    process.exit(1)
  }

  process.stdout.write(
    `parity: ${register.length} capabilities classified, ${products.length} DSH client products covered\n`
    + Object.entries(counts).sort().map(([k, v]) => `  ${k.padEnd(24)} ${v}\n`).join(''),
  )
}

main()
