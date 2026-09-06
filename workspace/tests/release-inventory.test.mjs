/**
 * The tracked inventory may not carry anything a pack run invents.
 *
 * `npm run release:artifacts` wrote digests, byte sizes, a date and an output
 * directory into `inventory/packed-artifacts.json`, which git tracks. So the
 * documented release sequence could not be walked: packing dirtied the
 * worktree, and the very next command the guide gives refuses a dirty tree.
 *
 *     npm run release:artifacts
 *     npm run first-publish:dry-run
 *     first-publish: the worktree is dirty
 *
 * Every gate passed while that was true, because `check` never packs and the
 * jobs that pack never looked at `git status` afterwards. The gate that walks
 * the sequence is `scripts/verify-release-sequence.mjs`; this file holds the
 * cheaper half — the shape of the tracked file itself — so the reason is
 * written down next to the rule, and a field creeping back is a unit failure
 * rather than a release-day one.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => readFileSync(join(ROOT, relative), 'utf8')

const TRACKED = JSON.parse(read('inventory/packed-artifacts.json'))
const PACK = read('scripts/pack-release.mjs')

/**
 * Facts that belong to one pack and to no other.
 *
 * `packedAt` and `directory` are here for the same reason as the digest: they
 * describe the run rather than the source, so packing twice would rewrite
 * them, so packing would dirty the tree.
 */
const PER_RUN = ['sha256', 'bytes', 'unpackedBytes', 'packedAt', 'directory', 'commit', 'file']

/** Every key anywhere in a structure, so a field cannot hide one level down. */
function keysOf(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, found)
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      found.add(key)
      keysOf(nested, found)
    }
  }
  return found
}

describe('the tracked release inventory describes the source, not a run', () => {
  test('no per-run fact appears anywhere in it', () => {
    const keys = keysOf(TRACKED)
    for (const field of PER_RUN) {
      assert.equal(keys.has(field), false,
        `\`${field}\` is true of one pack and not of the source, so packing would `
        + 'rewrite this tracked file and the release sequence would not walk')
    }
  })

  test('it still carries what a publication has to be checked against', () => {
    assert.equal(TRACKED.counts.packages, 20)
    assert.equal(TRACKED.packages.length, 20)
    assert.equal(TRACKED.publishOrder.length, 20)
    for (const record of TRACKED.packages) {
      assert.equal(typeof record.name, 'string')
      assert.equal(typeof record.version, 'string')
      assert.equal(record.access, 'public', `${record.name} is not public`)
      assert.ok(Array.isArray(record.files) && record.files.length > 0,
        `${record.name} records no file list, so a changed tarball would pass`)
      assert.equal(typeof record.dependencies, 'object')
    }
  })

  test('the publish order is the graph order, not a hand-kept list', () => {
    // Both come from the manifests. Recording the order without deriving it is
    // how a new dependency edge gets published in the wrong sequence.
    assert.match(PACK, /publishOrder\(\)\.map\(entry => entry\.name\)/)
    const names = new Set(TRACKED.packages.map(record => record.name))
    for (const name of TRACKED.publishOrder) {
      assert.ok(names.has(name), `${name} is in the publish order and not in the inventory`)
    }
  })

  test('the positive control: a digest in this shape would be caught', () => {
    // The rule is only worth having if it fails on the file it was written
    // for. This is the structure that shipped.
    const asItWas = {
      counts: { packages: 20 },
      packedAt: '2026-09-02',
      packages: [{ name: '@deepwatch/cli', sha256: 'a'.repeat(64), bytes: 1 }],
    }
    const keys = keysOf(asItWas)
    assert.ok(PER_RUN.some(field => keys.has(field)),
      'the detector does not catch the exact structure that caused the defect')
  })
})

describe('the digests are written beside the tarballs instead', () => {
  test('the pack writes the per-run inventory into its output directory', () => {
    assert.match(PACK, /writeFileSync\(join\(out, 'packed-artifacts\.json'\)/)
  })

  test('and the tracked one from source-derived records only', () => {
    assert.match(PACK, /writeFileSync\(join\(ROOT, 'inventory', 'packed-artifacts\.json'\)/)
    assert.match(PACK, /packages: records\.map\(structural\)/)
  })

  test('every consumer of a digest reads the inventory beside the archives', () => {
    // A digest compared against a different pack's record is either a false
    // alarm or, once the bytes are reproducible, a real check — but it must be
    // deliberate. These read the directory they were handed.
    for (const relative of ['scripts/first-publish.mjs', 'packages/watch/cli/src/lib/provision.ts']) {
      assert.match(read(relative), /join\(directory, 'packed-artifacts\.json'\)/,
        `${relative} does not read the inventory beside the tarballs`)
    }
  })
})

describe('the sequence itself is a gate', () => {
  const SEQUENCE = read('scripts/verify-release-sequence.mjs')
  const WORKFLOW = readFileSync(
    join(ROOT, '..', '.github', 'workflows', 'workspace-ci.yml'), 'utf8')

  test('it runs the guide’s commands in the guide’s order', () => {
    assert.match(SEQUENCE, /npm\('release:artifacts'\)/)
    assert.match(SEQUENCE, /npm\('first-publish:dry-run'\)/)
  })

  test('it checks the worktree before, between and after', () => {
    const checks = [...SEQUENCE.matchAll(/requireClean\('([^']+)'\)/g)].map(match => match[1])
    assert.equal(checks.length, 3, 'a check between the commands is the whole point')
    assert.deepEqual(checks, [
      'before packing', 'after packing', 'after the first-publish dry run',
    ])
  })

  test('it counts untracked files, which is where the first one hid', () => {
    assert.match(SEQUENCE, /--untracked-files=all/)
  })

  test('CI runs it, and the reproducibility gate beside it', () => {
    assert.match(WORKFLOW, /npm run verify:release-sequence/)
    assert.match(WORKFLOW, /npm run verify:pack-reproducible/)
  })
})
