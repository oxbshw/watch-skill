/**
 * Provenance that compares content, not labels.
 *
 * A release candidate was accepted at one commit while its npm artifacts had
 * been packed at another — three commits earlier, from a dirty tree. Exactly
 * one package differed: `@deepwatch/dsh-memory` was missing `restrictAll`, the
 * memory-permission hardening the accepted source added. Every gate passed,
 * because every gate compared `name@version`, and a version is a label a human
 * types rather than a function of the code. Two different byte sets wore one
 * identity and nothing could see it.
 *
 * The artifact set's own inventory had recorded `commit.clean: false` the whole
 * time. Recording a fact is not enforcing it, and the difference between those
 * two verbs is this file.
 *
 * Each test below is one of the ways that release went wrong, or one way a
 * near-miss of it would. The digests are content, so a package that changed
 * without its version changing is a mismatch — which is the property the old
 * check could not have.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { artifactDigests, sha256sums } from '../scripts/gen-provenance-manifest.mjs'
import { verifyProvenance } from '../scripts/verify-provenance.mjs'

/** A directory holding fake artifacts with real digests. */
function sealedSet(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dw-prov-'))
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes)
  return dir
}

/** The digest a byte string actually has, so a fixture cannot drift. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * A manifest describing a set, sealed at whatever source is claimed.
 *
 * `source` is supplied rather than read, because the point of most of these
 * tests is a manifest whose claimed source is *not* the checkout's.
 */
function manifestFor(dir, source, overrides = {}) {
  return {
    provenanceVersion: 1,
    source: { commit: null, tree: null, clean: true, dirtyEntries: 0, ...source },
    artifacts: artifactDigests(dir),
    ...overrides,
  }
}

describe('the defect that shipped', () => {
  test('one name@version with two byte sets is a mismatch', () => {
    // The whole reason this file exists. The old composition digest hashed
    // `@deepwatch/dsh-memory@0.1.0` and could not tell these apart.
    const hardened = 'export function restrictAll(directory) {}'
    const stale = 'export function nothingOfTheSort() {}'

    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': stale })
    const sealed = manifestFor(dir, {})
    // Seal the hardened bytes, ship the stale ones — the exact substitution.
    sealed.artifacts = sealed.artifacts.map(entry => ({
      ...entry,
      name: '@deepwatch/dsh-memory',
      version: '0.1.0',
      sha256: sha256(hardened),
    }))
    writeFileSync(join(dir, 'SHA256SUMS'), sha256sums(sealed), 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.equal(result.ok, false)
    const mismatch = result.failures.find(item => item.code === 'content_mismatch')
    assert.ok(mismatch, 'a differing byte set must be reported')
    assert.match(mismatch.detail, /@deepwatch\/dsh-memory@0\.1\.0/)
  })

  test('identical bytes under the same version pass', () => {
    // The other half: the gate must not cry wolf on an honest set, or it gets
    // switched off and the next stale tarball ships behind it.
    const bytes = 'export function restrictAll(directory) {}'
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': bytes })
    const sealed = manifestFor(dir, {})
    writeFileSync(join(dir, 'SHA256SUMS'), sha256sums(sealed), 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    const contentFindings = result.failures.filter(item => item.code === 'content_mismatch')
    assert.deepEqual(contentFindings, [])
  })
})

describe('the source a set claims', () => {
  test('a set sealed from a dirty tree is rejected', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, { clean: false, dirtyEntries: 9 })
    writeFileSync(join(dir, 'SHA256SUMS'), sha256sums(sealed), 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.equal(result.ok, false)
    assert.ok(result.failures.some(item => item.code === 'sealed_from_dirty_tree'))
  })

  test('an artifact older than the accepted source is rejected', () => {
    // `--expect-commit` is the accepted head. A set sealed anywhere else is
    // stale by definition, however well-formed it is.
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, { commit: 'a13c6e56d9434a734977f35c144162ca16c3d725' })
    writeFileSync(join(dir, 'SHA256SUMS'), sha256sums(sealed), 'utf8')

    const result = verifyProvenance({
      artifactsDir: dir,
      manifest: sealed,
      expectCommit: '474b7c659557273f55e726518604075f4538743a',
    })
    assert.equal(result.ok, false)
    const stale = result.failures.find(item => item.code === 'artifact_older_than_source')
    assert.ok(stale)
    assert.match(stale.fix, /Do not re-designate an older set as accepted/)
  })

  test('a commit that does not match the checkout is drift', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, { commit: '0'.repeat(40), tree: '1'.repeat(40) })
    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.ok(result.failures.some(item => item.code === 'source_commit_drift'))
    assert.ok(result.failures.some(item => item.code === 'source_tree_drift'))
  })
})

describe('a set with a hole is not a set', () => {
  test('a sealed artifact that is not there is reported', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, {})
    sealed.artifacts.push({
      file: 'deepwatch-dsh-tools-0.1.0.tgz', sha256: 'a'.repeat(64), bytes: 1, kind: 'npm',
    })
    writeFileSync(join(dir, 'SHA256SUMS'), sha256sums(sealed), 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.ok(result.failures.some(item => item.code === 'artifact_missing'))
  })

  test('an artifact nobody sealed is reported', () => {
    const dir = sealedSet({
      'deepwatch-dsh-memory-0.1.0.tgz': 'x',
      'deepwatch-dsh-tools-0.1.0.tgz': 'y',
    })
    const sealed = manifestFor(dir, {})
    sealed.artifacts = sealed.artifacts.filter(entry => !entry.file.includes('tools'))
    writeFileSync(join(dir, 'SHA256SUMS'), sha256sums(sealed), 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.ok(result.failures.some(item => item.code === 'artifact_unsealed'))
  })

  test('a manifest entry with no usable digest is reported', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, {})
    sealed.artifacts = sealed.artifacts.map(entry => ({ ...entry, sha256: 'short' }))
    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.ok(result.failures.some(item => item.code === 'digest_missing'))
  })
})

describe('the inventory and SHA256SUMS are one fact', () => {
  test('a disagreement between them is rejected', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, {})
    writeFileSync(
      join(dir, 'SHA256SUMS'),
      `${'b'.repeat(64)}  deepwatch-dsh-memory-0.1.0.tgz\n`, 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.ok(result.failures.some(item => item.code === 'sums_disagree'))
  })

  test('SHA256SUMS naming a file the manifest does not is rejected', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, {})
    writeFileSync(
      join(dir, 'SHA256SUMS'),
      `${sha256sums(sealed)}${'c'.repeat(64)}  deepwatch-dsh-ghost-0.1.0.tgz\n`, 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.ok(result.failures.some(item => item.code === 'sums_extra'))
  })

  test('a set with no SHA256SUMS at all is rejected', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const result = verifyProvenance({ artifactsDir: dir, manifest: manifestFor(dir, {}) })
    assert.ok(result.failures.some(item => item.code === 'sums_missing'))
  })
})

describe('what a room installed', () => {
  test('an installed package outside the sealed set is reported', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, {})
    sealed.artifacts = sealed.artifacts.map(entry => ({
      ...entry, name: '@deepwatch/dsh-memory', version: '0.1.0',
    }))

    const installed = mkdtempSync(join(tmpdir(), 'dw-inst-'))
    const pkg = join(installed, '@deepwatch', 'dsh-ghost')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@deepwatch/dsh-ghost', version: '0.1.0' }), 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed, installedDir: installed })
    assert.ok(result.failures.some(item => item.code === 'installed_unsealed'))
  })

  test('an installed version that differs from the sealed one is reported', () => {
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, {})
    sealed.artifacts = sealed.artifacts.map(entry => ({
      ...entry, name: '@deepwatch/dsh-memory', version: '0.1.0',
    }))

    const installed = mkdtempSync(join(tmpdir(), 'dw-inst-'))
    const pkg = join(installed, '@deepwatch', 'dsh-memory')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@deepwatch/dsh-memory', version: '0.0.9' }), 'utf8')

    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed, installedDir: installed })
    assert.ok(result.failures.some(item => item.code === 'installed_version_drift'))
  })
})

describe('every failure is actionable', () => {
  test('each finding names what to do about it', () => {
    // A gate whose message is "provenance failed" sends somebody to re-run the
    // build; one that says "these bytes are from an older commit" sends them to
    // repack. The second is the only useful kind.
    const dir = sealedSet({ 'deepwatch-dsh-memory-0.1.0.tgz': 'x' })
    const sealed = manifestFor(dir, { commit: '0'.repeat(40), clean: false, dirtyEntries: 3 })
    const result = verifyProvenance({ artifactsDir: dir, manifest: sealed })
    assert.ok(result.failures.length > 0)
    for (const item of result.failures) {
      assert.equal(typeof item.code, 'string')
      assert.ok(item.detail.length > 0, `${item.code} has no detail`)
      assert.ok(item.fix.length > 0, `${item.code} has no fix`)
    }
  })
})
