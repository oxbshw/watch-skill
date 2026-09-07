/**
 * `setup` can install the published packages, and says so accurately.
 *
 * This is the defect 0.1.1 exists for. The `@deepwatch` scope was published on
 * 2026-09-07, and `setup` went on refusing every install that did not name a
 * local artifact directory:
 *
 *     deepwatch: no DeepWatch artifact directory was given, and the DeepWatch
 *                packages are not published, so there is nowhere to get them.
 *
 * `npx --yes @deepwatch/cli@0.1.0 setup --yes` exited 2 with that message
 * while twenty packages were on npm. It was not a stale comment: the refusal
 * was executable, and the code behind it had a second fault the refusal hid --
 * `artifact-copy` returned early in registry mode without populating the
 * package list, so the manifest would have been written with no DeepWatch
 * packages in it at all.
 *
 * Both faults are held here, each by a check that fails against the old
 * implementation. The reconstructions below are the point: a test that only
 * asserted the new behaviour would pass just as well against a build that
 * never had the bug.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ARTIFACT_DIR, DEEPWATCH_PACKAGE_COUNT, managedManifest, registryPackages,
} from '../packages/watch/cli/lib/lib/provision.js'
import { DEEPWATCH_PACKAGES } from '../packages/watch/cli/lib/generated/managed-runtime.js'
import { SCOPE_PUBLISHED, VERSION } from '../packages/watch/cli/lib/version.js'
import { publishOrder } from '../scripts/publish-order.mjs'

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..')
const SETUP = readFileSync(
  join(WORKSPACE, 'packages', 'watch', 'cli', 'src', 'setup.ts'), 'utf8')

/** The setup source with its prose removed, for "this is gone" assertions. */
const SETUP_CODE = SETUP
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('the refusal that outlived its reason', () => {
  test('setup no longer refuses an install that names no artifact directory', () => {
    // The exact sentence a new user met. It may still appear in the module
    // note explaining the defect, which is why this reads the stripped source.
    assert.doesNotMatch(SETUP_CODE, /nowhere to get them/)
    assert.doesNotMatch(SETUP_CODE, /packages are not published/)
  })

  test('the registry branch builds a package set instead of returning 2', () => {
    assert.match(SETUP_CODE, /packages = registryPackages\(VERSION\)/)
  })

  test('the CLI no longer claims the scope is unpublished', () => {
    assert.equal(SCOPE_PUBLISHED, true)
  })
})

describe('the registry package set', () => {
  test('it is the release set minus the CLI, at one exact version', () => {
    const packages = registryPackages(VERSION)
    // `readArtifacts` skips `@deepwatch/cli`, because the managed runtime is
    // the Harness and what it composes -- not a second copy of the command the
    // person already ran. The two modes must build the same tree.
    assert.equal(packages.length, DEEPWATCH_PACKAGE_COUNT - 1)
    assert.equal(packages.some(entry => entry.name === '@deepwatch/cli'), false)
    for (const entry of packages) {
      assert.equal(entry.version, VERSION)
      assert.equal(entry.source, 'registry')
      // Null rather than the empty string: there is no digest this product
      // computed, and a provenance field of '' reads as one that was computed
      // and came back empty.
      assert.equal(entry.integrity, null)
      assert.equal(entry.file, null)
    }
  })

  test('the generated names are the published set, in publication order', () => {
    // Generated from the manifests by the same walk that orders a release, so
    // a package added to the workspace cannot be missing from an install.
    assert.deepEqual([...DEEPWATCH_PACKAGES], publishOrder().map(entry => entry.name))
    assert.equal(DEEPWATCH_PACKAGES.length, DEEPWATCH_PACKAGE_COUNT)
  })
})

describe('the manifest the managed runtime is built from', () => {
  test('registry entries are exact versions, not file: paths', () => {
    const manifest = JSON.parse(managedManifest(registryPackages(VERSION)))
    for (const name of DEEPWATCH_PACKAGES) {
      if (name === '@deepwatch/cli') continue
      assert.equal(manifest.dependencies[name], VERSION,
        `${name} must be installed by exact version`)
    }
  })

  test('the old implementation would have written a file: path naming nothing', () => {
    // The counterexample. `managedManifest` used to write
    // `file:${ARTIFACT_DIR}/${entry.file}` for every entry, unconditionally.
    // A registry entry has no file, so that template produced a specification
    // naming a tarball called "null" -- an install that fails at npm rather
    // than at the mistake.
    const oldRule = entry => `file:${ARTIFACT_DIR}/${entry.file}`
    const entry = registryPackages(VERSION)[0]
    assert.equal(oldRule(entry), `file:${ARTIFACT_DIR}/null`,
      'the counterexample must reproduce what the old template produced')
    assert.equal(managedManifest([entry]).includes('file:'), false,
      'a registry-sourced manifest must contain no file: specification')
  })

  test('artifact entries still install from the copied tarball', () => {
    // The other half of the branch, so a fix for registry mode cannot quietly
    // break the mode that already worked.
    const artifact = {
      name: '@deepwatch/dsh-bundle',
      version: VERSION,
      source: 'local-artifacts',
      file: 'deepwatch-dsh-bundle-0.1.0.tgz',
      from: 'D:/somewhere/deepwatch-dsh-bundle-0.1.0.tgz',
      bytes: 1234,
      integrity: 'sha256:abc',
    }
    const manifest = JSON.parse(managedManifest([artifact]))
    assert.equal(manifest.dependencies['@deepwatch/dsh-bundle'],
      `file:${ARTIFACT_DIR}/deepwatch-dsh-bundle-0.1.0.tgz`)
  })

  test('a registry manifest still carries the whole audited closure', () => {
    // The DeepWatch packages are added to the generated dependency set, never
    // substituted for it: `--legacy-peer-deps` installs no peers, so dropping
    // the closure here would produce a Harness that will not start.
    const manifest = JSON.parse(managedManifest(registryPackages(VERSION)))
    assert.notEqual(manifest.dependencies['@deepseek-ai/dsh'], undefined,
      'the pinned Harness is missing from the manifest')
    assert.ok(Object.keys(manifest.dependencies).length > DEEPWATCH_PACKAGE_COUNT,
      'the required peer set is missing')
  })
})

describe('the empty-package-set fault the refusal was hiding', () => {
  test('a registry install would have produced a runtime with no DeepWatch in it', () => {
    // `artifact-copy` returned early unless the mode was local-artifacts, and
    // `kept` -- the list the manifest is built from -- stayed empty. Even with
    // the refusal removed, this is what the old provisioner would have built.
    const mode = 'registry'
    const oldKept = []
    if (mode === 'local-artifacts') oldKept.push(...registryPackages(VERSION))
    const wouldHaveBuilt = JSON.parse(managedManifest(oldKept))
    const deepwatchIn = Object.keys(wouldHaveBuilt.dependencies)
      .filter(name => name.startsWith('@deepwatch/'))
    assert.deepEqual(deepwatchIn, [],
      'the counterexample must reproduce the empty set the old code produced')

    // And what it builds now.
    const now = JSON.parse(managedManifest(registryPackages(VERSION)))
    assert.equal(
      Object.keys(now.dependencies).filter(name => name.startsWith('@deepwatch/')).length,
      DEEPWATCH_PACKAGE_COUNT - 1)
  })
})
