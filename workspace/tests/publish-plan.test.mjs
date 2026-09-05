/**
 * Recovery from a half-finished release, and the one thing it must not do.
 *
 * Twenty packages publish in dependency order. When the fourteenth fails, the
 * thirteen before it are live and cannot be taken back, so the release has to
 * be resumable — and the obvious way to resume is to skip whatever is already
 * on the registry. That is the dangerous way. "Already published" is not the
 * same question as "already published *from this build*", and a resume that
 * cannot tell them apart will happily complete a release whose halves came
 * from different commits.
 *
 * So the plan compares integrity, not existence:
 *
 *   publish  the registry has nothing at this version
 *   skip     the registry has these exact bytes
 *   refuse   the registry has this version, built from something else
 *
 * The registry is injected here. These tests run offline and are about the
 * decision, not about npm.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildPlan, registryDist, tarballIntegrity } from '../scripts/publish-plan.mjs'
import { publishOrder } from '../scripts/publish-order.mjs'

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_INVENTORY = join(WORKSPACE, '.release-artifacts', 'packed-artifacts.json')

/** A packed set: one tiny "tarball" per publishable package, plus its inventory. */
function fakeArtifacts(root) {
  mkdirSync(root, { recursive: true })
  const packages = []
  for (const { name, version } of publishOrder()) {
    const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
    const body = Buffer.from(`tarball for ${name}@${version}`, 'utf8')
    writeFileSync(join(root, file), body)
    packages.push({
      file, name, version, access: 'public', bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
  }
  writeFileSync(join(root, 'packed-artifacts.json'),
    `${JSON.stringify({ generatedBy: 'test', packages }, null, 2)}\n`, 'utf8')
  return packages
}

/** An npm that reports `published` and nothing else, in `npm view dist` shape. */
function fakeRegistry(published) {
  return (args) => {
    const spec = args[1]
    const entry = published.get(spec)
    if (entry === undefined) {
      return { status: 1, stdout: '', stderr: `npm error code E404\nnpm error 404 '${spec}' is not in this registry.` }
    }
    return { status: 0, stdout: `${JSON.stringify(entry)}\n`, stderr: '' }
  }
}

describe('a release resumes only onto bytes it recognises', () => {
  test('nothing published: every package is planned for publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-fresh-'))
    try {
      fakeArtifacts(root)
      const plan = buildPlan({ artifacts: root, run: fakeRegistry(new Map()) })
      assert.equal(plan.ok, true)
      assert.equal(plan.entries.length, 20)
      assert.equal(plan.entries.every(entry => entry.action === 'publish'), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a partial release resumes: identical bytes are skipped, the rest publish', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-partial-'))
    try {
      const packages = fakeArtifacts(root)
      // The first thirteen made it before the job died.
      const published = new Map()
      for (const record of packages.slice(0, 13)) {
        published.set(`${record.name}@${record.version}`,
          { integrity: tarballIntegrity(join(root, record.file)), shasum: 'unused' })
      }
      const plan = buildPlan({ artifacts: root, run: fakeRegistry(published) })
      assert.equal(plan.ok, true)
      assert.equal(plan.entries.filter(entry => entry.action === 'skip').length, 13)
      assert.equal(plan.entries.filter(entry => entry.action === 'publish').length, 7)
      // The skipped ones say why, and the reason is the digest rather than
      // the name — that distinction is the whole point of this file.
      const skipped = plan.entries.find(entry => entry.action === 'skip')
      assert.match(skipped.reason, /these exact bytes/)
      assert.match(skipped.reason, /^already published/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a version published from something else is refused, not skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-foreign-'))
    try {
      const packages = fakeArtifacts(root)
      const published = new Map([[
        `${packages[0].name}@${packages[0].version}`,
        { integrity: 'sha512-c29tZXRoaW5nIGVsc2UgZW50aXJlbHk=', shasum: 'deadbeef' },
      ]])
      const plan = buildPlan({ artifacts: root, run: fakeRegistry(published) })
      assert.equal(plan.ok, false)
      const refused = plan.entries.filter(entry => entry.action === 'refuse')
      assert.equal(refused.length, 1)
      assert.match(refused[0].reason, /DIFFERENT bytes/)
      // And it never becomes a skip, however many later packages match.
      assert.equal(plan.entries.some(entry => entry.name === packages[0].name
        && entry.action === 'skip'), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a tarball that is not the sealed one is refused before the registry is asked', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-tamper-'))
    try {
      const packages = fakeArtifacts(root)
      writeFileSync(join(root, packages[0].file), Buffer.from('substituted', 'utf8'))
      let asked = 0
      const plan = buildPlan({
        artifacts: root,
        run: (...args) => { asked += 1; return fakeRegistry(new Map())(...args) },
      })
      assert.equal(plan.ok, false)
      const refused = plan.entries.find(entry => entry.name === packages[0].name)
      assert.equal(refused.action, 'refuse')
      assert.match(refused.reason, /does not match the sealed/)
      // Nineteen questions, not twenty: the substituted one was never asked
      // about, because a tarball that is not ours has no business being
      // compared to a registry entry.
      assert.equal(asked, 19)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the publish order is the plan order, so a resume stays resolvable', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-order-'))
    try {
      fakeArtifacts(root)
      const plan = buildPlan({ artifacts: root, run: fakeRegistry(new Map()) })
      assert.deepEqual(plan.entries.map(entry => entry.name),
        publishOrder().map(entry => entry.name))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('an unreachable registry is not an empty one', () => {
  test('E404 means "not published"', () => {
    const dist = registryDist('@deepwatch/cli', '0.1.0',
      () => ({ status: 1, stdout: '', stderr: "npm error code E404\nnpm error 404 Not Found" }))
    assert.equal(dist, null)
  })

  test('any other failure throws, rather than being read as "not published"', () => {
    // Treating an outage as "nothing is published" is how a resume turns into
    // twenty duplicate uploads, every one of which fails, on a release that
    // was actually fine.
    assert.throws(
      () => registryDist('@deepwatch/cli', '0.1.0',
        () => ({ status: 1, stdout: '', stderr: 'npm error network request to https://registry.npmjs.org failed' })),
      /npm view @deepwatch\/cli@0\.1\.0 failed/)
  })
})

test('the real packed inventory carries what the plan needs', () => {
  // Not a registry call — just that the fields this reads are the fields the
  // pack writes, so a change to `pack-release.mjs` cannot quietly strand it.
  const inventory = JSON.parse(readFileSync(REAL_INVENTORY, 'utf8'))
  assert.equal(inventory.packages.length, 20)
  for (const entry of inventory.packages) {
    assert.equal(typeof entry.file, 'string')
    assert.equal(typeof entry.name, 'string')
    assert.equal(typeof entry.version, 'string')
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
  }
})
