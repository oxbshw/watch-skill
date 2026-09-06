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
 * Composed rather than written, from three sources that each know something the
 * others do not:
 *
 * - **the manifest** — description, exports, peers, engines, version;
 * - **`src/index.ts`** — the `Config` interface a host actually reads, with the
 *   doc comment on each field, so the configuration section cannot drift from
 *   the code it describes;
 * - **`docs/package-notes.json`** — the prose neither of those can carry: who
 *   should install this, what it needs first, and where it sits.
 *
 * The notes file exists because the first version of this composed pages from
 * the manifest alone, and twenty pages then said the same four things. A
 * reader arriving at `@deepwatch/dsh-library` from a dependency tree learned
 * that it was "Part of DeepWatch" and that they probably did not want it —
 * which is true, and is not an answer to what it does or what it needs.
 *
 * Hand-editing a generated README is still wrong: the next run overwrites it
 * and `--check` says so first. Edit `docs/package-notes.json` instead, which is
 * the one file here a person is meant to write.
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

/** The hand-written half: audience, prerequisites, example, placement. */
const NOTES = JSON.parse(readFileSync(join(ROOT, 'docs', 'package-notes.json'), 'utf8'))

/**
 * The `Config` a host supplies, read out of the source that defines it.
 *
 * Parsed rather than imported: these are TypeScript sources, this script runs
 * before and after the build, and a documentation generator that only works on
 * a built tree is one that stops being run.
 *
 * Newlines are normalised first. A Windows checkout has CRLF, CI has LF, and a
 * generator whose output depends on that produces a file that is permanently
 * stale on one of the two.
 *
 * @param dir - the package directory.
 * @returns `{ name, type, doc }` per field, in declaration order.
 */
function configFields(dir) {
  const source = join(dir, 'src', 'index.ts')
  if (!existsSync(source)) return []
  const text = readFileSync(source, 'utf8').replace(/\r\n/g, '\n')
  const start = text.indexOf('export interface Config {')
  if (start < 0) return []
  const end = text.indexOf('\n}', start)
  if (end < 0) return []
  const body = text.slice(start + 'export interface Config {'.length, end)

  const fields = []
  // One doc comment (optional) followed by one `readonly name: type`. The
  // comment is collapsed to its first sentence: a package page is a summary,
  // and the twelve-line explanations in these files belong in the source.
  const shape = /(?:\/\*\*([\s\S]*?)\*\/\s*)?readonly\s+([A-Za-z0-9_]+)(\??):\s*([^\n]+?)\s*$/gm
  for (const match of body.matchAll(shape)) {
    const doc = (match[1] ?? '')
      .split('\n')
      .map(line => line.replace(/^\s*\*ered?\s?/, '').replace(/^\s*\*\s?/, '').trim())
      .filter(line => line !== '')
      .join(' ')
      .trim()
    const sentence = /^(.*?[.!?])(\s|$)/.exec(doc)
    fields.push({
      name: match[2],
      optional: match[3] === '?',
      type: match[4].replace(/,$/, '').trim(),
      doc: sentence === null ? doc : sentence[1],
    })
  }
  return fields
}

/**
 * Whether anything under the `@deepwatch` scope is on the registry.
 *
 * Declared once, in the workspace manifest, and read from there by everything
 * that shows an install command. Three pages used to state it in prose and the
 * README disagreed with the other two — which is how the front page ended up
 * telling a visitor to run `npm install -g @deepwatch/cli` against a scope
 * that holds nothing.
 *
 * @returns `'unpublished'` or `'published'`.
 */
function registryStatus() {
  return WORKSPACE_MANIFEST.deepwatch?.registryStatus ?? 'published'
}

/** The tag that publishes the scope for the first time. */
function firstPublicationTag() {
  return WORKSPACE_MANIFEST.deepwatch?.firstPublicationTag ?? 'deepwatch-v0.1.0'
}

const WORKSPACE_MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

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

/** The page for one package, from its manifest, its Config and its notes. */
function page(manifest, dir) {
  const note = NOTES.packages?.[manifest.name] ?? {}
  const role = note.role ?? 'shared'
  const lines = [`# ${manifest.name}`, '', manifest.description, '']

  lines.push(
    'Part of **DeepWatch** — the agent workspace built on the official',
    '[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)',
    `and powered by [Watch Skill](${REPO}) for perception, evidence, memory and`,
    'independent verification.',
    '')

  // The first question a reader has, answered before anything else: is this a
  // thing I install, or a thing that arrived in my tree? Twenty pages that all
  // open with "Part of DeepWatch" answer it for none of them.
  const label = NOTES.roles?.[role]
  if (label !== undefined) {
    lines.push(`> **${label}.**`, ...(note.audience === undefined ? [] : [`> ${note.audience}`]), '')
  } else if (note.audience !== undefined) {
    lines.push(`> ${note.audience}`, '')
  }

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
      const marker = optional[name]?.optional === true ? ' — optional' : ''
      lines.push(`- \`${name}@${range(name, declared)}\`${marker}`)
    }
    lines.push('')
  }

  // Everything below is composed from what the manifest already declares,
  // restated where somebody arriving from a dependency tree will read it. A
  // page that asserts more than its manifest is a page that will drift.
  lines.push('## Install', '')
  if (registryStatus() === 'unpublished') {
    // A page that shows an install command for a package nobody can install
    // wastes the first thing a reader does. The note goes above the block
    // rather than below it, because below it is after they have run it.
    lines.push(
      '> **Not on npm yet.** Nothing exists under the `@deepwatch` scope. This',
      `> package is published for the first time by the \`${firstPublicationTag()}\``,
      '> release; until then the command below resolves nothing, and',
      `> [the workspace README](${REPO}/tree/main/workspace#readme) has the path`,
      '> that works from a checkout.',
      '')
  }
  lines.push('```sh', `npm install ${manifest.name}`, '```', '')
  if (role !== 'product') {
    lines.push(
      `Rarely on its own. [\`${BUNDLE}\`](${REPO}/tree/main/workspace/packages/watch/bundle#readme)`,
      'composes this package with the rest of DeepWatch and is what a profile',
      'normally depends on; installing this one directly is for embedding a',
      'single piece in a composition you control.',
      '')
  }

  if (note.example !== undefined) {
    lines.push('## Example', '')
    if (note.example.caption !== undefined) lines.push(note.example.caption, '')
    // An example that installs from the registry is an install command like
    // any other, and it is far enough down the page that the callout above the
    // Install block no longer counts as nearby. Repeated rather than moved:
    // the reader who scrolled to a worked example is exactly the one who will
    // paste it without scrolling back up.
    if (registryStatus() === 'unpublished' && note.example.code.includes('@deepwatch/')) {
      lines.push(`> Pending the \`${firstPublicationTag()}\` release — see Install above.`, '')
    }
    lines.push(`\`\`\`${note.example.lang ?? 'sh'}`, note.example.code, '```', '')
  }

  // Read out of the `Config` interface rather than restated beside it. The
  // defaults live in the schema and the prose lives in the doc comments, so a
  // field added to the code appears here on the next run and a field removed
  // stops appearing.
  const fields = configFields(dir)
  if (fields.length > 0) {
    lines.push(
      '## Configuration',
      '',
      'Supplied by the host when it mounts this plugin.',
      '',
      '| Option | Type | |',
      '| --- | --- | --- |')
    for (const field of fields) {
      lines.push(`| \`${field.name}\`${field.optional ? ' *(optional)*' : ''} `
        + `| \`${field.type}\` | ${field.doc} |`)
    }
    lines.push('')
  }

  const node = manifest.engines?.node
  if (node !== undefined || note.prerequisites !== undefined) {
    lines.push('## Requirements', '')
    if (node !== undefined) lines.push(`- Node \`${node}\``)
    if (Object.keys(manifest.peerDependencies ?? {}).length > 0) {
      lines.push('- The peers above, supplied by the host composition')
    }
    lines.push('')
    if (note.prerequisites !== undefined) lines.push(note.prerequisites, '')
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

  // "Stable" and "1.0" are different claims, and a `0.x` version makes only
  // the first one. Said here rather than left to convention: a dependent
  // reading "a stable release" beside `^0.1.0` would reasonably expect the
  // guarantee a 1.x line gives, and this line does not give it.
  if (/^0\./.test(version) && !version.includes('-')) {
    lines.push(
      'Stable means tested, documented and supported — not 1.0. This is a',
      'pre-1.0 line, and semantic versioning gives `0.x` no compatibility',
      'guarantee across minor versions: **a `0.MINOR` bump may change or remove',
      'surface, and a patch will not.** Depend on it with a tilde range',
      `(\`~${version}\`) if you want that difference enforced by your lockfile`,
      'rather than by a changelog. The usual major-version promise starts at 1.0.',
      '')
  }

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

  lines.push('## Where this fits', '')
  if (note.fits !== undefined) lines.push(note.fits, '')
  lines.push(
    'The twenty packages and how they compose:',
    `[the package map](${REPO}/blob/main/workspace/docs/packages.md).`,
    'Running DeepWatch, and the gates a change has to pass:',
    `[the workspace README](${REPO}/tree/main/workspace#readme).`,
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
    if (!HAND_WRITTEN.has(manifest.name)) files.push([join(dir, 'README.md'), page(manifest, dir)])

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
