#!/usr/bin/env node
/**
 * Pack the same commit twice, and require the same twenty archives.
 *
 * This did not hold. `@deepwatch/dsh-bundle` declares thirteen siblings
 * through pnpm's `workspace:` protocol; pnpm resolved those to concrete ranges
 * while packing, and wrote the rewritten `dependencies` object back in a
 * different key order on each run. One archive's digest and size moved for a
 * reason that had nothing to do with its contents, and the release guide had a
 * section explaining that reproducibility was simply not available here.
 *
 * It was available. The pack now stages a canonical manifest — the same
 * ranges, resolved by this repository, sorted by code unit — for the length of
 * one `pnpm pack`, so pnpm has nothing to rewrite and nothing to reorder.
 *
 * Reproducibility is worth a gate rather than a paragraph because of what it
 * buys: an archive can be verified against a digest recorded by a *different*
 * pack, which is what lets a reviewer check that the tarballs being published
 * are the ones the candidate commit produces. Without it, every digest check
 * is only ever a check against the run that made it.
 *
 * Two packs, two temporary directories, and no use of `.release-artifacts` —
 * this gate must not disturb the artifacts a release run has already made.
 *
 * Usage:
 *   node scripts/verify-pack-reproducible.mjs
 *   node scripts/verify-pack-reproducible.mjs --json
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')

/** One pack into a directory of its own, returning what it recorded. */
function packInto(label) {
  const out = mkdtempSync(join(tmpdir(), `deepwatch-pack-${label}-`))
  const ran = spawnSync(
    process.execPath, [join(ROOT, 'scripts', 'pack-release.mjs'), '--out', out],
    { cwd: ROOT, encoding: 'utf8' })
  if (ran.status !== 0) {
    rmSync(out, { recursive: true, force: true })
    throw new Error(`pack ${label} exited ${String(ran.status)}:\n${ran.stderr || ran.stdout}`)
  }
  const inventory = JSON.parse(readFileSync(join(out, 'packed-artifacts.json'), 'utf8'))
  rmSync(out, { recursive: true, force: true })
  return inventory
}

function main() {
  let first
  let second
  try {
    first = packInto('a')
    second = packInto('b')
  } catch (error) {
    process.stderr.write(`\npack-reproducible: ${String(error.message)}\n`)
    return 1
  }

  const left = new Map(first.packages.map(record => [record.name, record]))
  const right = new Map(second.packages.map(record => [record.name, record]))
  const moved = []
  const identical = []

  for (const [name, record] of left) {
    const other = right.get(name)
    if (other === undefined) {
      moved.push({ name, detail: 'the second pack did not produce it' })
      continue
    }
    if (record.sha256 === other.sha256) { identical.push(name); continue }
    moved.push({
      name,
      detail: `${record.sha256.slice(0, 16)} (${String(record.bytes)} bytes) -> `
        + `${other.sha256.slice(0, 16)} (${String(other.bytes)} bytes)`,
    })
  }
  for (const name of right.keys()) {
    if (!left.has(name)) moved.push({ name, detail: 'only the second pack produced it' })
  }

  const result = {
    ok: moved.length === 0 && identical.length === 20,
    packages: left.size,
    identical: identical.length,
    moved,
  }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.ok ? 0 : 1
  }

  process.stdout.write(
    `\npack reproducibility\n\n  identical  ${String(result.identical)}/${String(result.packages)}\n`)
  if (!result.ok) {
    process.stderr.write('\n')
    for (const entry of moved) process.stderr.write(`  ${entry.name}: ${entry.detail}\n`)
    process.stderr.write(
      '\npack-reproducible: two packs of one commit produced different archives\n')
    return 1
  }
  process.stdout.write('\nTwo packs of this commit produce the same twenty archives.\n')
  return 0
}

process.exit(main())
