/**
 * No active public surface may ship a prerelease version.
 *
 * A version bump used to be a hand-run search and replace across sixty files,
 * and the failure that produces is never loud: one manifest keeps a
 * `-preview.0` self-version, or a stable package declares a prerelease
 * dependency on a sibling, and the release looks finished until somebody
 * installs it and npm cannot resolve the tree.
 *
 * So the rule is asserted rather than remembered. Everything a person installs,
 * reads, or resolves against must carry the stable version; the records of past
 * releases must not be rewritten to match, because a changelog that claims
 * 1.4.0 shipped what 1.4.0rc1 shipped is a lie told to make a grep come out
 * empty.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')

const { VERSIONS, isHistorical } = await import(
  pathToFileURL(join(ROOT, 'scripts', 'promote-versions.mjs')).href)

/** Shapes that mean "not a stable release", whatever the number in front. */
const PRERELEASE = /\d+\.\d+\.\d+-(?:preview|rc|alpha|beta|dev)\b/

/** Every publishable package manifest in the workspace. */
function publishable() {
  const found = []
  for (const parent of ['packages/watch', 'apps']) {
    const at = join(ROOT, parent)
    if (!existsSync(at)) continue
    for (const name of readdirSync(at)) {
      const path = join(at, name, 'package.json')
      if (!existsSync(path)) continue
      found.push({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) })
    }
  }
  return found
}

describe('the stable version matrix', () => {
  test('Watch Skill declares the stable version everywhere it is read from', () => {
    const pyproject = readFileSync(join(REPO, 'pyproject.toml'), 'utf8')
    const declared = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1]
    assert.equal(declared, VERSIONS.core.to)

    // The lockfile records the project's own version. Left behind, `uv` reports
    // the lock as stale and the lockfile gate fails.
    const lock = readFileSync(join(REPO, 'uv.lock'), 'utf8')
    const self = /name = "watch-skill"\nversion = "([^"]+)"/.exec(lock)?.[1]
    assert.equal(self, VERSIONS.core.to, 'uv.lock disagrees with pyproject.toml')

    for (const file of ['server.json', '.claude-plugin/plugin.json']) {
      const text = readFileSync(join(REPO, file), 'utf8')
      assert.doesNotMatch(text, PRERELEASE, `${file} carries a prerelease version`)
      assert.ok(text.includes(VERSIONS.core.to), `${file} does not declare ${VERSIONS.core.to}`)
    }
  })

  test('every DeepWatch package is at the stable version', () => {
    const found = publishable()
    assert.ok(found.length >= 20, `expected at least 20 packages, found ${String(found.length)}`)
    for (const { path, manifest } of found) {
      assert.equal(manifest.version, VERSIONS.deepwatch.to,
        `${manifest.name} is ${manifest.version}`)
      assert.doesNotMatch(manifest.version, PRERELEASE, `${path} is a prerelease`)
    }
  })

  test('the workspace root manifest matches its packages', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    assert.equal(root.version, VERSIONS.deepwatch.to)
  })

  test('no package depends on a prerelease sibling', () => {
    // The failure this catches is a stable package that cannot install: npm
    // resolves a `-preview` range against a registry that only has stable.
    for (const { manifest } of publishable()) {
      for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
        for (const [name, range] of Object.entries(manifest[field] ?? {})) {
          if (!name.startsWith('@deepwatch/')) continue
          assert.doesNotMatch(String(range), PRERELEASE,
            `${manifest.name} → ${name}@${range} is a prerelease range`)
        }
      }
    }
  })

  test('the private Desktop package tracks the DeepWatch product version', () => {
    // Unpublished, but not unversioned: a Desktop shell reporting a different
    // number than the Web build it hosts is a support question nobody can answer.
    const desktop = JSON.parse(
      readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'))
    assert.equal(desktop.private, true, 'Desktop must stay unpublished in this release')
    assert.equal(desktop.version, VERSIONS.deepwatch.to)
  })
})

describe('no active surface carries a prerelease string', () => {
  test('the promotion script reports a clean tree', () => {
    // The authoritative answer: one place knows every active surface, and it
    // exits non-zero while any of them is stale.
    const run = execFileSync(process.execPath,
      [join(ROOT, 'scripts', 'promote-versions.mjs'), '--check'],
      { cwd: ROOT, encoding: 'utf8' })
    assert.match(run, /versions are stable/)
  })

  test('records of past releases are deliberately left alone', () => {
    // The other half of the rule. If this ever passes because the changelog was
    // rewritten, the guarantee above has been bought with a falsified history.
    assert.equal(isHistorical('CHANGELOG.md'), true)
    assert.equal(isHistorical('docs/release-proof.md'), true)
    assert.equal(isHistorical('workspace/docs/history/anything.md'), true)
    assert.equal(isHistorical('pyproject.toml'), false)
    assert.equal(isHistorical('uv.lock'), false)
  })
})

describe('release tags name the right product', () => {
  test('the two trains keep their own prefixes', () => {
    // `core-v*` publishes Python to PyPI; `deepwatch-v*` publishes npm. A bare
    // `v*` trigger once meant a tag intended for one product released the other.
    const core = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
    const deepwatch = readFileSync(
      join(REPO, '.github', 'workflows', 'release-deepwatch.yml'), 'utf8')
    assert.match(core, /core-v/, 'the Watch Skill train lost its tag prefix')
    assert.match(deepwatch, /deepwatch-v/, 'the DeepWatch train lost its tag prefix')
    assert.doesNotMatch(core, /^\s+-\s+["']?v\*["']?\s*$/m, 'a bare v* trigger is back')
    assert.doesNotMatch(deepwatch, /^\s+-\s+["']?v\*["']?\s*$/m, 'a bare v* trigger is back')
  })
})
