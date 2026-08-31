/**
 * A packed-artifact directory, made to order, for the checks that are about
 * the *directory* rather than about what is inside the tarballs.
 *
 * Reading an artifact set is a verification step with a lot of ways to fail —
 * a missing file, an extra one, a rename, a wrong size, a wrong digest, a
 * link, an unpacked package, a short inventory. Every one of those is worth a
 * test, and none of them needs a real tarball: the reader hashes bytes and
 * compares them to an inventory, and bytes that are not a valid gzip stream
 * fail exactly the same checks as bytes that are.
 *
 * Real tarballs are used where a real install happens — see
 * `scripts/verify-packed-install.mjs` and the release gates — because that is
 * where their contents start to matter. Using them here would make a
 * millisecond of assertion depend on a two-minute pack.
 *
 * @module tests/fixtures/artifact-set
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The published DeepWatch set, in the order the inventory records it. */
export const DEEPWATCH_PACKAGES = [
  '@deepwatch/cli',
  '@deepwatch/dsh-adapters',
  '@deepwatch/dsh-bundle',
  '@deepwatch/dsh-client-brand',
  '@deepwatch/dsh-client-evidence',
  '@deepwatch/dsh-client-memory',
  '@deepwatch/dsh-client-remotes',
  '@deepwatch/dsh-client-settings',
  '@deepwatch/dsh-contracts',
  '@deepwatch/dsh-core-bridge',
  '@deepwatch/dsh-library',
  '@deepwatch/dsh-live',
  '@deepwatch/dsh-memory',
  '@deepwatch/dsh-sdk',
  '@deepwatch/dsh-technology',
  '@deepwatch/dsh-tenancy',
  '@deepwatch/dsh-tools',
  '@deepwatch/dsh-trajectory',
  '@deepwatch/dsh-wiki',
  '@deepwatch/dsh-workspace',
]

/** The file name `pnpm pack` gives a package at a version. */
export function tarballName(name, version) {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
}

/**
 * Write a complete, self-describing artifact directory.
 *
 * @param {string} version - the version every package is packed at.
 * @param {object} [options] - what to do differently, for the refusal cases.
 * @param {string} [options.dir] - where to write it; a temp directory by default.
 * @param {(rows: object[]) => object[]} [options.inventory] - rewrite the
 * inventory rows before they are written, so a test can describe a directory
 * that does not match what is on disk.
 * @param {(dir: string) => void} [options.after] - do something to the finished
 * directory, such as adding an extra file or corrupting one.
 * @returns {{ directory: string, rows: object[] }} the directory and its rows.
 */
export function writeArtifactSet(version, options = {}) {
  const directory = options.dir ?? mkdtempSync(join(tmpdir(), 'deepwatch-artifacts-'))
  mkdirSync(directory, { recursive: true })

  const rows = []
  for (const name of DEEPWATCH_PACKAGES) {
    const file = tarballName(name, version)
    // Deterministic bytes, so a digest is stable across runs and a test that
    // changes one byte is changing something a reader can see.
    const body = Buffer.from(`deepwatch artifact fixture: ${name}@${version}\n`, 'utf8')
    writeFileSync(join(directory, file), body)
    rows.push({
      file,
      name,
      version,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
  }

  const written = options.inventory === undefined ? rows : options.inventory(rows)
  writeFileSync(join(directory, 'packed-artifacts.json'), `${JSON.stringify({
    generatedBy: 'tests/fixtures/artifact-set.mjs',
    note: 'A fixture. Real release directories are written by scripts/pack-release.mjs.',
    counts: { packages: written.length },
    packages: written,
  }, null, 2)}\n`)

  options.after?.(directory)
  return { directory, rows }
}
