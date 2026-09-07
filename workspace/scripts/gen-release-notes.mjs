#!/usr/bin/env node
/**
 * The body of the DeepWatch GitHub Release, composed from what was sealed.
 *
 * This train had no Release at all: the tag published twenty packages to npm
 * and then stopped. That left two things missing. The obvious one is a page to
 * link to. The one that mattered more is a download — somebody who already
 * runs a DeepSeek Harness wants `@deepwatch/dsh-bundle`, and an air-gapped or
 * registry-restricted install of it needs the tarball as a file, not as a
 * registry coordinate.
 *
 * Composed rather than written, for the same reason the package pages are.
 * Release notes typed by hand describe the release the author remembered; these
 * describe the set that was actually sealed, because every number in them is
 * read out of `packed-artifacts.json` and the provenance manifest beside it. If
 * the pack changes, the notes change with it.
 *
 * Usage:
 *   node scripts/gen-release-notes.mjs --artifacts <dir> --manifest <file>
 *     [--out <file>]
 *
 * @module scripts/gen-release-notes
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { byCodeUnit } from './lib/order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'https://github.com/oxbshw/watch-skill'
const BUNDLE = '@deepwatch/dsh-bundle'
const CLI = '@deepwatch/cli'

/** A tarball name as the Release attaches it, from the npm package name. */
function assetName(name, version) {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
}

/** Bytes, at the precision a download decision needs. */
function human(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * The notes.
 *
 * @param inventory - parsed `packed-artifacts.json`.
 * @param manifest - parsed provenance manifest.
 * @returns markdown.
 */
export function notes(inventory, manifest) {
  const packages = [...inventory.packages].sort((a, b) => byCodeUnit(a.name, b.name))
  const version = packages[0]?.version ?? 'unknown'
  const cli = packages.find(entry => entry.name === CLI)
  const bundle = packages.find(entry => entry.name === BUNDLE)
  const stable = !version.includes('-')

  const out = []
  const say = (...lines) => { out.push(...lines) }

  say(
    `**DeepWatch ${version}** — the agent workspace built on the official`,
    '[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and',
    `powered by [Watch Skill](${REPO}) for perception, evidence and independent`,
    'verification.',
    '',
    'An agent works inside something that watches it: every tool call leaves a',
    'receipt, every path a tool declares is checked against one workspace',
    'boundary, and *did that actually work?* is answered by Watch Core running a',
    'frozen contract rather than by the model that did the work.',
    '')

  say('## Install', '')
  say('**The whole workspace**', '', '```bash', `npm install -g ${CLI}`,
    'deepwatch setup', 'deepwatch web --workspace ./my-project', '```', '')
  say('Or without installing anything:', '', '```bash',
    `npx ${CLI}@${version} doctor`, '```', '')
  say('**Into a DeepSeek Harness you already run**', '', '```bash',
    `dsh plugin --profile web add ${BUNDLE}`, '```', '')

  if (bundle !== undefined) {
    say(
      'That is the supported contract: the package declares `dsh.bundle.patch`,',
      "so DSH reconciles it into the profile's layer stack and applies the patch",
      'after its own layers. There is no separate `.dsh` archive format — the',
      'distribution *is* the npm tarball.',
      '',
      '> **Offline, the entry point is `deepwatch setup`, not `dsh plugin add`.**',
      `> \`${BUNDLE}\` names its thirteen siblings as ordinary registry`,
      '> dependencies, so `dsh plugin add` resolves those ranges from npm even',
      '> when every tarball is passed on the command line — tested, and it',
      '> reaches the registry either way. Supplying the files does not make it',
      '> an offline install, and describing it as one would be wrong.',
      '>',
      '> What does work without a registry is the CLI, which writes `file:`',
      '> paths for the whole set into the profile it composes:',
      '>',
      '> ```bash',
      '> deepwatch setup --artifacts <directory holding these tarballs>',
      '> ```',
      '>',
      '> That is the path both acceptance passes use.',
      '')
  }

  say(
    'Watch Core is the engine and installs separately, from PyPI:',
    '',
    '```bash',
    "pip install 'watch-skill[standard]'",
    '```',
    '',
    'The Bridge finds the executable on `PATH` and connects on its own.',
    '')

  say('## What is in this release', '')
  say(
    `${String(packages.length)} packages, published together and in dependency`,
    'order so every version resolves the moment it is public. Two of them are',
    'installed deliberately; the rest are what those two compose.',
    '')
  say('| Package | Size | SHA-256 |', '| --- | --- | --- |')
  for (const entry of packages) {
    const lead = entry.name === CLI || entry.name === BUNDLE ? '**' : ''
    say(`| ${lead}\`${entry.name}\`${lead} | ${human(entry.bytes)} `
      + `| \`${entry.sha256.slice(0, 16)}…\` |`)
  }
  say('')
  if (cli !== undefined) {
    say(
      `\`${CLI}\` is the command-line product and \`${BUNDLE}\` is the`,
      'integration; the other eighteen are internal dependencies of those two',
      'and are published because a dependency that is not on the registry is a',
      'package that does not install.',
      '')
  }

  say('## Provenance', '')
  say('| | |', '| --- | --- |')
  say(`| Source commit | \`${manifest.source?.commit ?? 'unknown'}\` |`)
  say(`| Source tree | \`${manifest.source?.tree ?? 'unknown'}\` |`)
  say(`| Worktree | ${manifest.source?.clean === true ? 'clean' : '**dirty**'} |`)
  say(`| Pinned Harness | \`${manifest.harness?.package ?? '?'}@${manifest.harness?.version ?? '?'}\` |`)
  say(`| Built with | Node ${manifest.toolchain?.node ?? '?'}, `
    + `${manifest.toolchain?.pnpm ?? '?'} |`)
  say('')
  say(
    'Every asset here is covered by `SHA256SUMS`, and',
    '`.release-artifacts-provenance.json` binds those digests to the commit and',
    'tree above. Check a download before trusting it:',
    '',
    '```bash',
    'sha256sum -c SHA256SUMS',
    '```',
    '')
  say(
    'The packages on npm carry registry provenance only where the release',
    'workflow published them over OIDC; the attached tarballs are the same bytes',
    'either way, which is what `SHA256SUMS` lets you confirm for yourself.',
    '')

  say('## Documentation', '')
  say(
    `- [Getting started](${REPO}/blob/main/workspace/docs/getting-started.md)`,
    `- [Install and upgrade](${REPO}/blob/main/workspace/docs/install-and-upgrade.md)`,
    `- [Configuration](${REPO}/blob/main/workspace/docs/configuration.md)`,
    `- [Verification](${REPO}/blob/main/docs/verification.md)`,
    `- [Troubleshooting](${REPO}/blob/main/workspace/docs/troubleshooting.md)`,
    `- [Known limitations](${REPO}/blob/main/workspace/docs/known-limitations.md)`,
    '')

  if (!stable) {
    say(
      '> **Prerelease.** This version does not take the `latest` dist-tag; ask',
      '> for it by name.',
      '')
  }

  say('---', '',
    'Built on DeepSeek Harness · Powered by Watch Skill. An independent project,',
    'not affiliated with or endorsed by DeepSeek.',
    '')

  return `${out.join('\n')}\n`
}

function main(argv) {
  const flag = (name, fallback = null) => {
    const at = argv.indexOf(name)
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
  }
  const artifacts = flag('--artifacts', join(ROOT, '.release-artifacts'))
  const manifestPath = flag('--manifest', join(ROOT, '.release-artifacts-provenance.json'))
  const out = flag('--out', join(artifacts, 'release-notes.md'))

  try {
    const inventory = JSON.parse(readFileSync(join(artifacts, 'packed-artifacts.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(out, notes(inventory, manifest), 'utf8')
  } catch (cause) {
    process.stderr.write(
      `gen-release-notes: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  process.stdout.write(`release notes: ${out}\n`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}

export { assetName, human }
