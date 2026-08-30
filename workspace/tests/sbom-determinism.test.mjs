/**
 * The SBOM must describe this distribution, not the machine that printed it.
 *
 * `installedPackages` walked `node_modules/.pnpm`. Optional native binaries
 * are installed only for the host, so a Windows machine saw eight win32
 * packages and none of the forty-two built for other targets, and a Linux
 * machine saw the mirror image. Both wrote `docs/sbom.json`. Whichever ran
 * last won, the other's diff reappeared, and `npm run check` was a command
 * that modified a tracked file as a side effect of verifying it.
 *
 * The set now comes from the lockfile, which is byte-identical on every
 * machine. That is the whole of the fix, and the third test is the one that
 * states it: the committed document and the lockfile have to agree exactly,
 * because if they do then no property of the host could have influenced it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SUPPORTED_LOCKFILE_VERSION,
  parseLockfilePackages,
  platformFamily,
  splitSpec,
} from '../scripts/lib/pnpm-lockfile.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCKFILE = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
const SBOM = JSON.parse(readFileSync(join(ROOT, 'docs', 'sbom.json'), 'utf8'))

/** The deliberate per-package licence decisions, as matchers. */
const REVIEWED = JSON.parse(
  readFileSync(join(ROOT, 'inventory', 'licence-review.json'), 'utf8'))
  .packages.map(entry => ({ ...entry, pattern: new RegExp(entry.match) }))

test('a scoped spec splits on the last @, not the first', () => {
  assert.deepEqual(splitSpec('@scope/name@1.2.3'), { name: '@scope/name', version: '1.2.3' })
  assert.deepEqual(splitSpec('plain@0.1.0'), { name: 'plain', version: '0.1.0' })
  assert.equal(splitSpec('@scope/name'), null)
})

test('an unrecognised lockfile version stops the build rather than shortening the list', () => {
  const bumped = LOCKFILE.replace(
    /^lockfileVersion:.*$/m, "lockfileVersion: '99.0'")
  assert.throws(() => parseLockfilePackages(bumped), /understands 9\.0/)
  assert.equal(SUPPORTED_LOCKFILE_VERSION, '9.0')
})

test('platform variants are grouped by the package they are builds of', () => {
  assert.equal(platformFamily('lightningcss-win32-x64-msvc'), 'lightningcss')
  assert.equal(platformFamily('lightningcss-linux-arm64-musl'), 'lightningcss')
  assert.equal(platformFamily('@rolldown/binding-darwin-arm64'), '@rolldown/binding')
  assert.equal(platformFamily('typescript'), null, 'a portable package has no family')
})

test('the committed SBOM lists exactly what the lockfile resolves', () => {
  const locked = parseLockfilePackages(LOCKFILE)
  const fromLock = new Set(locked.map(pkg => `${pkg.name}@${pkg.version}`))
  const fromSbom = new Set(SBOM.thirdParty.map(pkg => `${pkg.name}@${pkg.version}`))

  const missing = [...fromLock].filter(spec => !fromSbom.has(spec))
  const extra = [...fromSbom].filter(spec => !fromLock.has(spec))

  assert.deepEqual(missing, [],
    'the lockfile resolves these and the SBOM does not name them')
  assert.deepEqual(extra, [],
    'these came from somewhere other than the lockfile, so they vary by host')
})

test('every platform-specific package is present for every platform', () => {
  const locked = parseLockfilePackages(LOCKFILE)
  const constrained = locked.filter(pkg => pkg.os.length > 0)
  assert.ok(constrained.length > 0, 'this repository does resolve native binaries')

  const named = new Set(SBOM.thirdParty.map(pkg => `${pkg.name}@${pkg.version}`))
  for (const pkg of constrained) {
    assert.ok(named.has(`${pkg.name}@${pkg.version}`),
      `${pkg.name} is built for ${pkg.os.join('/')} and must appear regardless of the host`)
  }

  // Windows installs eight of these. If the count ever equals what one host
  // materialises, the generator has gone back to reading the disk.
  const platforms = new Set(constrained.flatMap(pkg => pkg.os))
  assert.ok(platforms.size > 1, `only ${[...platforms].join(', ')} survived`)
})

test('the builds of one package agree on a licence, or a review says why not', () => {
  const byFamily = new Map()
  for (const pkg of SBOM.thirdParty) {
    const family = platformFamily(pkg.name)
    if (family === null) continue
    const key = `${family}@${pkg.version}`
    if (!byFamily.has(key)) byFamily.set(key, new Set())
    byFamily.get(key).add(pkg.license)
  }
  for (const [family, licenses] of byFamily) {
    if (licenses.size === 1) continue
    // sharp is the real case: its glibc builds declare
    // `Apache-2.0 AND LGPL-3.0-or-later` while its musl and wasm builds
    // declare nothing at all, shipping the same libvips payload either way.
    // The disagreement is upstream's, and quoting one half would be picking at
    // random — so a family that disagrees is quoted from its review instead.
    const entry = REVIEWED.find(rule => rule.pattern.test(family))
    assert.ok(entry !== undefined,
      `${family} states ${[...licenses].join(' and ')}, and no review says which`)
    for (const license of licenses) {
      assert.ok(entry.licenses.includes(license),
        `${family} now states ${license}, which its review does not cover`)
    }
  }
})

test('a package with no licence is reviewed deliberately, not merely tolerated', () => {
  // Nineteen packages in the Harness closure ship no `license` field. That is
  // upstream's omission and cannot be fixed from here, so what this holds is
  // the next best thing: each is named in `inventory/licence-review.json` with
  // what it is, how it arrives, and whether DeepWatch redistributes it. A new
  // one appears and this fails, which is the point.
  const unknown = SBOM.thirdParty.filter(pkg => pkg.license === 'UNKNOWN')
  const unreviewed = unknown.filter(pkg => !REVIEWED.some(
    rule => rule.pattern.test(pkg.name) && rule.licenses.includes('UNKNOWN')))
  assert.deepEqual(unreviewed.map(pkg => pkg.name), [])
})
