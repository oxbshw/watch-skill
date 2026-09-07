#!/usr/bin/env node
/**
 * One place that knows what version this repository is.
 *
 * Two products ship from here on separate trains — Watch Skill to PyPI as
 * `core-v*`, DeepWatch to npm as `deepwatch-v*` — and until now a version bump
 * was a hand-run search and replace across sixty-odd files. That is how a
 * release ends up with a stable manifest depending on a prerelease sibling: not
 * because anybody decided to, but because one file was missed.
 *
 * So this rewrites every *active* surface from one declaration, and refuses to
 * touch the ones that must stay historically true.
 *
 * **Active versus historical.** A changelog entry that says what 1.4.0rc1
 * contained is a record of a release that happened; rewriting it to say 1.4.0
 * would be falsifying history to make a grep come out clean. The same goes for
 * an audit document, a past screenshot manifest, or a lockfile hash pinning a
 * build that was really made. Those are listed in {@link HISTORICAL} and are
 * never rewritten. Everything else — manifests, inventories, install commands,
 * badges, generated metadata — describes what somebody installs today, and must
 * be stable.
 *
 * Usage:
 *   node scripts/promote-versions.mjs --check          report drift, change nothing
 *   node scripts/promote-versions.mjs --write          rewrite the active surfaces
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')

/**
 * The versions this repository ships, and the ones it is leaving behind.
 *
 * `from` is a list because a promotion may run twice, and because a surface
 * left on an older prerelease is exactly what this exists to catch.
 */
export const VERSIONS = {
  core: { name: 'Watch Skill', to: '1.4.1', from: ['1.4.0rc1', '1.4.0'] },
  // `0.1.0-preview.0` and `0.1.0` are gone from `from` because their promotions
  // are finished: nothing active carries either, and the one place `0.1.0`
  // still appears is `firstPublicationTag`, which records the tag that first
  // put the scope on npm. That is a fact about a release that happened, and
  // leaving the version in this list would rewrite it every time.
  deepwatch: { name: 'DeepWatch', to: '0.1.2', from: ['0.1.1'] },
}

/**
 * Files whose older versions are the point of the file.
 *
 * Matched as repository-relative prefixes. A changelog, an audit record and a
 * past capture manifest describe releases that really happened. Rewriting any
 * of them would make the repository lie in order to make a search come out
 * empty.
 *
 * `uv.lock` is deliberately *not* here, and the distinction is worth stating.
 * Most of a lockfile is third-party resolution and none of this touches it —
 * but the lock also records the project's **own** version, and that entry is a
 * live claim about the package being built, not a record of a past build. Left
 * behind, `uv` reports the lock as stale against `pyproject.toml` and the
 * lockfile gate fails. Only the self-version line matches the promotion, so
 * rewriting it changes exactly that.
 */
export const HISTORICAL = [
  'CHANGELOG.md',
  // Two records of somebody else's dependency graph. Nothing in either is a
  // claim about this project's version, and the promotion cannot tell
  // `powershell-utils@0.1.0` -- a real third party that happens to share our
  // number -- from one of ours.
  //
  // Promoting DeepWatch 0.1.0 to 0.1.1 rewrote exactly those lines. In the
  // closure it invented a dependency range upstream never published and broke
  // the capture's self-digest, so `managed:check` failed with "edited by
  // hand". In the lockfile it rewrote `powershell-utils` and `yocto-queue` to
  // versions that do not exist, and every CI job died at install with
  //
  //     ERR_PNPM_FETCH_404  GET .../yocto-queue-0.1.1.tgz: Not Found
  //
  // The lockfile is here and `uv.lock` deliberately is not, and the difference
  // is what each records about *us*. `uv.lock` carries the Python project's
  // own version, which is a live claim that must move. A pnpm lockfile records
  // this workspace's own packages as `link:packages/...` with
  // `specifier: workspace:*` and no version string at all -- so every version
  // in it belongs to somebody else, and the promotion has no legitimate work
  // to do here.
  'workspace/inventory/dsh-closure.json',
  'workspace/pnpm-lock.yaml',
  // Generated from the lockfile, and it carries both halves: `firstParty`
  // holds this project's packages and moves with a release, `thirdParty` holds
  // everybody else's and must not. A search-and-replace cannot see the
  // difference -- it rewrote the same two third-party entries here that it
  // rewrote in the lockfile -- and it does not need to, because
  // `gen-sbom.mjs` derives the whole file and `sbom-determinism.test.mjs`
  // fails when it disagrees with what the lockfile resolves. Regenerate it;
  // never rewrite it.
  'workspace/docs/sbom.json',
  // Two more generated records of somebody else's graph, and the same trap
  // the lockfile carries: upstream publishes
  // `@deepseek-ai/node-addon-landlock-run@0.1.1`, which is DeepWatch's own
  // outgoing version written by a different project. Promoting it would name
  // a release nobody made. Both files are derived -- `gen-inventory.mjs` and
  // `gen-managed-runtime.mjs` own them and their `:check` gates fail when
  // they disagree with the tree -- so this project's own versions in them
  // move by regeneration, which is the only way they should move at all.
  'workspace/inventory/packages.json',
  'workspace/inventory/managed-runtime.json',
  'docs/release-proof.md',
  'docs/history/',
  'workspace/docs/history/',
  'workspace/docs/screenshot-manifest.json',
  // The captions name the amounts, versions and health a running build
  // actually showed. Promoting them would relabel a photograph.
  'workspace/docs/screenshots-release.md',
  'workspace/docs/screenshot-manifest.md',
]

/**
 * Files whose prerelease strings are test *inputs*, not claims about a release.
 *
 * A test that proves `0.1.0-preview.0` earns the `preview` dist-tag has to name
 * that version, and promoting it would delete the case being tested. These are
 * not historical records — they are live assertions about how prerelease shapes
 * are handled, and they must keep working long after no prerelease ships.
 *
 * Deliberately a short, explicit list rather than "anything under tests/":
 * a test that hardcodes the *product's own* version is exactly the drift this
 * script exists to catch, and blanket-exempting the suite would hide it.
 */
export const FIXTURES = [
  // Quotes the command that failed, at the version that shipped it:
  //   npx --yes @deepwatch/cli@<that version> setup --yes
  // Promoting it would make the test claim a later version failed, and
  // the whole point of the file is which one did.
  'workspace/tests/registry-install.test.mjs',
  'workspace/tests/first-publish.test.mjs',
  'workspace/tests/stable-versions.test.mjs',
  // This file. It has to name the versions it promotes *from*, in VERSIONS
  // above and in the prose explaining the distinction, so scanning itself for
  // prerelease strings finds its own definition and reports the tree unclean
  // forever. Rewriting them would erase the mapping and leave a script that
  // promotes nothing.
  'workspace/scripts/promote-versions.mjs',
]

/** Whether a repository-relative path is a historical record. */
export function isHistorical(path) {
  const norm = path.replace(/\\/g, '/')
  return HISTORICAL.some(entry => norm === entry || norm.startsWith(entry))
}

/** Whether a path's prerelease strings are test inputs rather than claims. */
export function isFixture(path) {
  return FIXTURES.includes(path.replace(/\\/g, '/'))
}

/**
 * Every tracked file mentioning a version being promoted away from.
 *
 * `git grep` exits 1 when it matches nothing, and that is this script's success
 * case rather than an error — a clean tree finds no prerelease strings at all.
 * Throwing there made `--check` fail loudest exactly when it had nothing to
 * report.
 */
function candidates() {
  const patterns = [...VERSIONS.core.from, ...VERSIONS.deepwatch.from]
  const found = new Set()
  for (const pattern of patterns) {
    let out = ''
    try {
      out = execFileSync('git', ['grep', '-l', '--fixed-strings', pattern], {
        cwd: REPO, encoding: 'utf8',
      })
    } catch (error) {
      // Exit 1 is "no matches". Anything else is a real git failure.
      if (error.status !== 1) throw error
      continue
    }
    for (const line of out.trim().split('\n')) if (line !== '') found.add(line)
  }
  return [...found].sort()
}

/**
 * One version string, matched only where it is the whole version.
 *
 * A plain substring replace was enough while no version being promoted away
 * from was a prefix of a version that must not move. `0.1.1` is: the Harness
 * this distribution pins is `0.1.1-rc.2`, and promoting DeepWatch to `0.1.2`
 * rewrote it to `0.1.2-rc.2` — a Harness nobody published, in the lockfile
 * that exists to say which one was measured. `1.4.0rc1` is the same shape
 * from the other side.
 *
 * So a version has to end where it ends: not followed by another digit, a
 * dot, a dash or a letter, and not preceded by a digit or a dot. Everything
 * a release actually writes — `v0.1.1`, `~0.1.1`, `@0.1.1`, `"0.1.1"`,
 * `0.1.1,` — still matches.
 */
export function exactly(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![0-9.])${escaped}(?![0-9A-Za-z.-])`, 'g')
}

/** Rewrite one file's active version strings; returns how many it changed. */
function promote(path) {
  const full = join(REPO, path)
  const before = readFileSync(full, 'utf8')
  let after = before
  for (const product of Object.values(VERSIONS)) {
    // Longest first, so `1.4.0` never eats the `1.4.0` inside `1.4.0rc1`
    // before the entry that names the prerelease has had its turn.
    for (const stale of [...product.from].sort((a, b) => b.length - a.length)) {
      after = after.replace(exactly(stale), product.to)
    }
  }
  if (after === before) return { path, changed: 0, after: null }
  const changed = before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length
  return { path, changed, after }
}

function main(argv) {
  const write = argv.includes('--write')
  const check = argv.includes('--check') || !write

  const active = []
  const skipped = []
  for (const path of candidates()) {
    if (isHistorical(path) || isFixture(path)) { skipped.push(path); continue }
    const result = promote(path)
    if (result.changed > 0) active.push(result)
  }

  if (write) {
    for (const { path, after } of active) writeFileSync(join(REPO, path), after, 'utf8')
    process.stdout.write(
      `promoted ${String(active.length)} active file(s) to `
      + `${VERSIONS.core.name} ${VERSIONS.core.to} / `
      + `${VERSIONS.deepwatch.name} ${VERSIONS.deepwatch.to}\n`)
    for (const { path, changed } of active) {
      process.stdout.write(`  ${path} (${String(changed)} line(s))\n`)
    }
    process.stdout.write(`kept historical: ${String(skipped.length)}\n`)
    for (const path of skipped) process.stdout.write(`  ${path}\n`)
    return 0
  }

  if (check) {
    if (active.length === 0) {
      process.stdout.write(
        `versions are stable: ${VERSIONS.core.name} ${VERSIONS.core.to}, `
        + `${VERSIONS.deepwatch.name} ${VERSIONS.deepwatch.to}\n`)
      process.stdout.write(`historical records left alone: ${String(skipped.length)}\n`)
      return 0
    }
    process.stderr.write(
      `${String(active.length)} active surface(s) still carry a prerelease version:\n`)
    for (const { path, changed } of active) {
      process.stderr.write(`  ${path} (${String(changed)} line(s))\n`)
    }
    process.stderr.write('\nRun `node scripts/promote-versions.mjs --write`.\n')
    return 1
  }
  return 0
}

// `pathToFileURL` rather than a hand-built `file://` string: on Windows the real
// URL is `file:///D:/…` and a two-slash spelling never matches, so the guard
// silently declines to run and the command exits 0 having done nothing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
