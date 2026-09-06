/**
 * What is actually inside a packed tarball.
 *
 * A packed filename is a lossy encoding of a scoped package name: `pnpm pack`
 * writes `@deepwatch/dsh-tools` as `deepwatch-dsh-tools-<version>.tgz`, and the
 * scope separator is gone. Three scripts used to reconstruct it with a prefix
 * rule — strip a hard-coded scope, put a slash back — and every one of them
 * broke the moment the scope changed, in a different way:
 *
 *   - one produced `@deepwatch-dsh-tools`, which pnpm refuses with
 *     `ERR_PNPM_INVALID_SELECTOR`, and the profile install failed with nothing
 *     in the message naming the cause;
 *   - one silently stopped matching and left the name unscoped, so an override
 *     pointed at a package that does not exist.
 *
 * The manifest inside the tarball is not lossy. This reads it, so a rename can
 * never split a filename convention from the name it is supposed to encode.
 *
 * @module scripts/lib/packed
 */

import { spawnSync } from 'node:child_process'
import { basename, dirname } from 'node:path'

/**
 * The package name a tarball declares.
 *
 * `tar -xO` streams one member to stdout, which every platform this product
 * supports has: Windows has shipped bsdtar since Windows 10 1803, and it is
 * what the release gates already use to inspect packed output.
 */
export function packageNameOf(tarball) {
  // Run it in the tarball's own directory and pass only the filename.
  // Windows ships bsdtar, which reads `D:/packed/x.tgz` as a *remote* spec —
  // `host:path` — and fails with "Cannot connect to D: resolve failed". A bare
  // name has no colon in it and no such ambiguity.
  const result = spawnSync('tar', ['-xOf', basename(tarball), 'package/package.json'], {
    cwd: dirname(tarball),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(
      `could not read the package name from ${basename(tarball)}: `
      + `${(result.stderr || result.stdout || '').trim() || 'tar failed'}`)
  }
  const name = JSON.parse(result.stdout).name
  if (typeof name !== 'string' || name === '') {
    throw new Error(`${basename(tarball)} declares no package name`)
  }
  return name
}

/** Every tarball, keyed by the package it holds. */
export function packedByName(tarballs) {
  const found = new Map()
  for (const tarball of tarballs) found.set(packageNameOf(tarball), tarball)
  return found
}
