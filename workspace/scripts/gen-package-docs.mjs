#!/usr/bin/env node
/**
 * A README and a LICENSE in every published package.
 *
 * npm renders a package's README as its whole public page, and a package with
 * none shows a blank one — which, for twenty packages that are meaningless in
 * isolation, is exactly the wrong first impression. Somebody who arrives at
 * `@deepwatch/dsh-library` from a dependency tree needs one paragraph telling
 * them what it is, what it is part of, and what it needs.
 *
 * Composed rather than written, from what each manifest already declares: its
 * description, its exports, its peers. Twenty hand-written pages drift, and a
 * page that drifts is worse than a short one that cannot.
 *
 * The LICENSE is copied because npm ships whatever `LICENSE` file is beside a
 * manifest, and a package declaring `"license": "MIT"` with no text in the
 * tarball is a claim nobody can check offline.
 *
 * Usage:
 *   node scripts/gen-package-docs.mjs
 *   node scripts/gen-package-docs.mjs --check
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { byCodeUnit } from './lib/order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'https://github.com/oxbshw/watch-skill'
const LICENSE = readFileSync(join(ROOT, '..', 'LICENSE'), 'utf8')

/**
 * The pnpm catalog, so a peer range reads as a version rather than a protocol.
 *
 * `catalog:` is how this workspace states the Harness version once; it is
 * resolved at pack time and means nothing to somebody reading a package page.
 * Parsed by hand because the catalog is a flat block of `"name": version` and
 * adding a YAML dependency to print a README would be a poor trade.
 */
function catalog() {
  const text = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const start = text.indexOf('\ncatalog:')
  if (start < 0) return new Map()
  const entries = new Map()
  for (const line of text.slice(start + 1).split('\n').slice(1)) {
    if (!/^\s/.test(line)) break
    const match = /^\s+"?([^":]+)"?:\s*(\S+)/.exec(line)
    if (match !== null) entries.set(match[1], match[2])
  }
  return entries
}

const CATALOG = catalog()

/** A dependency range as a reader can act on it. */
function range(name, declared) {
  return declared.startsWith('catalog:') ? (CATALOG.get(name) ?? declared) : declared
}

/**
 * Packages whose README is written by hand, and why.
 *
 * `@deepwatch/dsh-bundle` is the one somebody installs deliberately, so its
 * page is an install guide rather than a description.
 */
const BUNDLE = '@deepwatch/dsh-bundle'
const HAND_WRITTEN = new Set([BUNDLE])

/** Every publishable package, with its manifest. */
function publishable() {
  const found = []
  for (const parent of ['packages/watch', 'apps']) {
    const at = join(ROOT, parent)
    if (!existsSync(at)) continue
    for (const name of readdirSync(at)) {
      const path = join(at, name, 'package.json')
      if (!existsSync(path)) continue
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (manifest.private === true) continue
      found.push({ dir: join(at, name), manifest })
    }
  }
  return found.sort((a, b) => byCodeUnit(a.manifest.name, b.manifest.name))
}

/** The page for one package, from what its manifest already says. */
function page(manifest) {
  const lines = [`# ${manifest.name}`, '', manifest.description, '']

  lines.push(
    'Part of **DeepWatch** — the Web and Desktop agent product built on the',
    'official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)',
    `packages and powered by [Watch Skill](${REPO}) for perception, evidence,`,
    'memory and independent verification.',
    '')

  const subpaths = Object.keys(manifest.exports ?? {})
    .filter(entry => entry !== './package.json')
  if (subpaths.length > 0) {
    lines.push('## Exports', '')
    for (const subpath of subpaths.sort()) {
      lines.push(`- \`${subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`}\``)
    }
    lines.push('')
  }

  const peers = Object.entries(manifest.peerDependencies ?? {})
  if (peers.length > 0) {
    const optional = manifest.peerDependenciesMeta ?? {}
    lines.push('## Peers', '', 'Provided by the host rather than installed here:', '')
    for (const [name, declared] of peers.sort(([a], [b]) => byCodeUnit(a, b))) {
      const note = optional[name]?.optional === true ? ' — optional' : ''
      lines.push(`- \`${name}@${range(name, declared)}\`${note}`)
    }
    lines.push('')
  }

  // Everything below is composed from what the manifest already declares,
  // restated where somebody arriving from a dependency tree will read it. A
  // page that asserts more than its manifest is a page that will drift.
  lines.push('## Install', '', '```sh', `npm install ${manifest.name}`, '```', '')
  if (manifest.name !== BUNDLE) {
    lines.push(
      `Rarely on its own. [\`${BUNDLE}\`](${REPO}/tree/main/workspace/packages/watch/bundle#readme)`,
      'composes this package with the rest of DeepWatch and is what a profile',
      'normally depends on; installing this one directly is for embedding a',
      'single piece in a composition you control.',
      '')
  }

  const node = manifest.engines?.node
  if (node !== undefined) {
    lines.push('## Requirements', '', `- Node \`${node}\``)
    if (Object.keys(manifest.peerDependencies ?? {}).length > 0) {
      lines.push('- The peers above, supplied by the host composition')
    }
    lines.push('')
  }

  // The version *is* the stability statement. Deriving the sentence from it
  // keeps the two from ever disagreeing.
  const version = manifest.version ?? ''
  const stability = /-preview\./.test(version)
    ? 'a preview release. The surface may change between previews, and it is '
      + 'published for evaluation rather than for production dependence.'
    : /-(rc|beta|alpha)\./.test(version)
      ? 'a pre-release. The surface is close to settled but not yet guaranteed.'
      : 'a stable release.'
  lines.push('## Stability', '', `\`${version}\` — ${stability}`, '')

  // `sideEffects: false` is a bundler fact about module evaluation, not a claim
  // about what the package does once a host mounts it. Naming which one is
  // meant is the difference between an accurate note and a misleading one.
  if (manifest.sideEffects === false) {
    lines.push('## Side effects', '',
      'Importing a module from this package evaluates no side effects, so a',
      'bundler may drop what a build does not use. Mounting it in a host is a',
      'separate matter: what it then reads or writes is governed by the',
      "workspace boundary and the host's permissions, not by this flag.",
      '')
  }

  lines.push(
    '## Where this fits',
    '',
    'These packages are composed together; installing one on its own is rarely',
    'what you want. The whole picture, the gates it has to pass, and how to run',
    'DeepWatch is in the',
    `[workspace README](${REPO}/tree/main/workspace#readme).`,
    '',
    '## Attribution',
    '',
    'Built on DeepSeek Harness · Powered by Watch Skill',
    '',
    'DeepWatch and Watch Skill are independent projects and are not affiliated',
    'with or endorsed by DeepSeek. MIT licensed; third-party notices are in',
    `[THIRD_PARTY_NOTICES.md](${REPO}/blob/main/workspace/THIRD_PARTY_NOTICES.md).`,
    '')

  return lines.join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  const stale = []
  let written = 0

  for (const { dir, manifest } of publishable()) {
    const files = [[join(dir, 'LICENSE'), LICENSE]]
    if (!HAND_WRITTEN.has(manifest.name)) files.push([join(dir, 'README.md'), page(manifest)])

    for (const [path, content] of files) {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : null
      if (current === content) continue
      if (check) {
        stale.push(`${manifest.name}: ${path.slice(ROOT.length + 1)} is out of date`)
      } else {
        writeFileSync(path, content, 'utf8')
        written += 1
      }
    }
  }

  if (check) {
    if (stale.length === 0) {
      process.stdout.write('package docs: up to date\n')
      return 0
    }
    for (const problem of stale) process.stderr.write(`  ${problem}\n`)
    process.stderr.write('\npackage docs: run node scripts/gen-package-docs.mjs\n')
    return 1
  }
  process.stdout.write(`package docs: ${written} file(s) written\n`)
  return 0
}

process.exitCode = main()
