#!/usr/bin/env node
/**
 * The keywords each published package is found by, in one place.
 *
 * npm search weights `keywords` heavily and every package here carried three
 * shared terms plus one or two of its own — enough to find a package you can
 * already name, and useless to anyone searching for what it does.
 *
 * Two rules, and they are the reason this is generated rather than hand-edited
 * twenty times:
 *
 * - **Every term has to be true of that package.** A keyword is a claim about
 *   what the package is for. `ocr` belongs on the bundle that brings OCR and
 *   not on the brand tokens, however much traffic the word carries.
 * - **The shared set is shared.** Anything true of all twenty lives in `BASE`,
 *   so a rename happens once.
 *
 *   node scripts/gen-package-keywords.mjs           # check, exit 1 on drift
 *   node scripts/gen-package-keywords.mjs --write   # apply
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages', 'watch')

/** True of every published package: what it is, and what it is part of. */
const BASE = [
  'deepwatch',
  'deepseek-harness',
  'watch-skill',
  'ai-agent',
  'agent-workspace',
]

/**
 * What each package is for, in the words somebody would search.
 *
 * Keyed by the directory, not the npm name, because the directory is what this
 * script walks and a mismatch should be a missing entry rather than a silent
 * fallback to the shared set.
 */
const SPECIFIC = {
  cli: ['cli', 'mcp', 'video-understanding', 'evidence', 'verification', 'local-first'],
  bundle: ['plugin', 'dsh-plugin', 'agent-tools', 'video', 'ocr', 'evidence', 'verification'],
  'core-bridge': ['bridge', 'watch-core', 'json-rpc', 'stdio', 'python'],
  tools: ['agent-tools', 'tool-calling', 'evidence', 'verification', 'video', 'ocr'],
  library: ['library', 'index', 'search', 'evidence', 'receipts'],
  live: ['live', 'capture', 'screen-capture', 'streaming'],
  memory: ['memory', 'event-sourcing', 'append-only', 'ledger'],
  technology: ['capabilities', 'role-bindings', 'providers', 'models', 'inventory'],
  contracts: ['contracts', 'protocol', 'wire-format', 'typescript'],
  trajectory: ['trajectory', 'receipts', 'audit-trail', 'observability'],
  workspace: ['workspace', 'containment', 'boundary', 'sandbox'],
  tenancy: ['tenancy', 'rbac', 'audit', 'collaboration'],
  sdk: ['sdk', 'plugin-development', 'capabilities', 'extensions'],
  adapters: ['adapters', 'obsidian', 'llmwiki', 'integrations'],
  wiki: ['wiki', 'knowledge-base', 'notes'],
  brand: ['ui', 'react', 'design-tokens', 'branding'],
  'client-evidence': ['ui', 'react', 'evidence', 'verdict', 'verification'],
  'client-memory': ['ui', 'react', 'memory', 'timeline'],
  'client-remotes': ['ui', 'react', 'typert', 'rpc'],
  'client-settings': ['ui', 'react', 'settings', 'diagnostics', 'role-bindings'],
}

/** Directory name -> the keyword list that package should carry. */
function wanted(directory) {
  const specific = SPECIFIC[directory]
  if (specific === undefined) return null
  // Deduplicated and ordered: shared terms first, then what this one is for,
  // so a reader of the published page sees the family before the detail.
  return [...new Set([...BASE, ...specific])]
}

function main(argv) {
  const write = argv.includes('--write')
  const drift = []
  const missing = []
  let checked = 0

  for (const directory of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, directory, 'package.json')
    let pkg
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch {
      continue
    }
    if (pkg.private === true) continue

    const expected = wanted(directory)
    if (expected === null) {
      missing.push(`${pkg.name ?? directory} (directory "${directory}")`)
      continue
    }
    checked += 1

    const current = pkg.keywords ?? []
    const same = current.length === expected.length
      && current.every((term, index) => term === expected[index])
    if (same) continue

    drift.push(pkg.name ?? directory)
    if (write) {
      pkg.keywords = expected
      writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    }
  }

  if (missing.length > 0) {
    process.stdout.write(
      `${missing.length} published package(s) have no entry in SPECIFIC:\n`
      + missing.map(name => `  ${name}\n`).join('')
      + 'Add one. A package nobody wrote keywords for is a package nobody finds.\n')
    return 1
  }

  if (drift.length === 0) {
    process.stdout.write(`keywords are current: ${String(checked)} package(s)\n`)
    return 0
  }

  if (write) {
    process.stdout.write(
      `wrote keywords for ${String(drift.length)} package(s):\n`
      + drift.map(name => `  ${name}\n`).join(''))
    return 0
  }

  process.stdout.write(
    `${String(drift.length)} package(s) carry keywords this file does not describe:\n`
    + drift.map(name => `  ${name}\n`).join('')
    + 'Run `node scripts/gen-package-keywords.mjs --write`.\n')
  return 1
}

process.exitCode = main(process.argv.slice(2))
