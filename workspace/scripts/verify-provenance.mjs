#!/usr/bin/env node
/**
 * The gate that would have caught the stale artifact set.
 *
 * A release candidate was accepted at one commit and its npm artifacts had
 * been packed at another — three commits earlier, from a dirty tree. Exactly
 * one package differed in content: `@deepwatch/dsh-memory` was missing
 * `restrictAll`, the memory-permission hardening the accepted source added.
 * Every existing check passed, because every existing check compared
 * `name@version`, and both byte sets wore the same version.
 *
 * This compares content. Each condition below is one way that release went
 * wrong, or one way a near-miss of it would:
 *
 * 1. **dirty worktree** — the pack recorded `clean: false` and nobody read it.
 * 2. **source drift** — the manifest's commit or tree is not the one here.
 * 3. **stale artifact** — an artifact predates the accepted source.
 * 4. **same version, different bytes** — the defect itself, stated directly.
 * 5. **installed content drift** — what a room installed is not what was sealed.
 * 6. **missing artifact or digest** — a set with a hole is not a set.
 * 7. **inventory disagreement** — `SHA256SUMS` and the inventory must be one fact.
 *
 * A failure names the package and the two digests, because "provenance failed"
 * sends somebody to re-run the build and "these bytes are from an older
 * commit" sends them to repack.
 *
 * Usage:
 *   node scripts/verify-provenance.mjs --artifacts <dir> --manifest <file>
 *     [--installed <node_modules dir>] [--expect-commit <sha>] [--json]
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { artifactDigests, sourceIdentity } from './gen-provenance-manifest.mjs'

/** One reason a set is not publishable. */
function failure(code, detail, fix) {
  return { code, detail, fix }
}

/**
 * Check a sealed set against its manifest and the source it claims.
 *
 * Pure apart from reading the filesystem, and returns every failure rather
 * than the first: a person repacking wants the whole list, not one at a time.
 */
export function verifyProvenance({
  artifactsDir, manifest, installedDir = null, expectCommit = null, repo = undefined,
}) {
  const failures = []
  const source = sourceIdentity(repo)

  // 1. A dirty tree cannot name the source of its own artifacts.
  if (source.clean === false) {
    failures.push(failure(
      'worktree_dirty',
      `${String(source.dirtyEntries)} uncommitted or untracked entries in the worktree`,
      'Commit or stash, then rebuild the artifacts from the clean head.'))
  }

  // 2. The manifest must describe the source that is actually here.
  if (manifest.source?.commit !== source.commit) {
    failures.push(failure(
      'source_commit_drift',
      `sealed at ${String(manifest.source?.commit).slice(0, 12)}, `
      + `checkout is at ${String(source.commit).slice(0, 12)}`,
      'Rebuild the artifacts from this head, or check out the head they were sealed from.'))
  }
  if (manifest.source?.tree !== source.tree) {
    failures.push(failure(
      'source_tree_drift',
      `sealed tree ${String(manifest.source?.tree).slice(0, 12)}, `
      + `checkout tree ${String(source.tree).slice(0, 12)}`,
      'The tree differs even where the commit matches. Rebuild from the clean tree.'))
  }

  // 3. An artifact set sealed before the accepted head is stale by definition.
  if (expectCommit !== null && manifest.source?.commit !== expectCommit) {
    failures.push(failure(
      'artifact_older_than_source',
      `artifacts came from ${String(manifest.source?.commit).slice(0, 12)}, `
      + `accepted source is ${expectCommit.slice(0, 12)}`,
      'Repack from the accepted head. Do not re-designate an older set as accepted.'))
  }
  if (manifest.source?.clean === false) {
    failures.push(failure(
      'sealed_from_dirty_tree',
      'the artifact set records clean: false',
      'These bytes name a commit that does not describe them. Repack from a clean tree.'))
  }

  // 6. Present on disk, and digested. A hole is not a set.
  const onDisk = existsSync(artifactsDir) ? artifactDigests(artifactsDir) : []
  const diskByName = new Map(onDisk.map(entry => [entry.file, entry]))
  const sealedByName = new Map((manifest.artifacts ?? []).map(entry => [entry.file, entry]))

  for (const [file, sealed] of sealedByName) {
    if (typeof sealed.sha256 !== 'string' || sealed.sha256.length !== 64) {
      failures.push(failure('digest_missing', `${file} has no usable sha256 in the manifest`,
        'Regenerate the manifest from the artifact directory.'))
      continue
    }
    const actual = diskByName.get(file)
    if (actual === undefined) {
      failures.push(failure('artifact_missing', `${file} is sealed but not present`,
        'Restore the artifact, or reseal the set that actually exists.'))
      continue
    }
    // 4. The defect itself: one version, two byte sets.
    if (actual.sha256 !== sealed.sha256) {
      failures.push(failure(
        'content_mismatch',
        `${file}${sealed.version ? ` (${String(sealed.name)}@${String(sealed.version)})` : ''} `
        + `is sealed as ${sealed.sha256.slice(0, 16)}… and is ${actual.sha256.slice(0, 16)}… on disk`,
        'Same name and version, different bytes. Repack from the accepted source.'))
    }
  }
  for (const file of diskByName.keys()) {
    if (!sealedByName.has(file)) {
      failures.push(failure('artifact_unsealed', `${file} is present but not in the manifest`,
        'Reseal the set so every artifact it ships is covered.'))
    }
  }

  // 7. `SHA256SUMS` and the manifest must be one fact, not two.
  const sums = join(artifactsDir, 'SHA256SUMS')
  if (existsSync(sums)) {
    for (const line of readFileSync(sums, 'utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue
      const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
      if (match === null) {
        failures.push(failure('sums_unreadable', `SHA256SUMS has a line that is not a digest: ${line.slice(0, 40)}`,
          'Regenerate SHA256SUMS from the manifest.'))
        continue
      }
      const [, digest, file] = match
      const sealed = sealedByName.get(file)
      if (sealed === undefined) {
        failures.push(failure('sums_extra', `SHA256SUMS lists ${file}, which the manifest does not`,
          'Regenerate both from one pass so they cannot disagree.'))
      } else if (sealed.sha256 !== digest) {
        failures.push(failure('sums_disagree',
          `${file}: SHA256SUMS says ${digest.slice(0, 16)}…, manifest says ${sealed.sha256.slice(0, 16)}…`,
          'Regenerate both from one pass so they cannot disagree.'))
      }
    }
  } else if (sealedByName.size > 0) {
    failures.push(failure('sums_missing', 'no SHA256SUMS beside the artifacts',
      'Generate it with gen-provenance-manifest.mjs.'))
  }

  // 5. What a room installed must be what was sealed.
  if (installedDir !== null) {
    failures.push(...verifyInstalled(installedDir, manifest))
  }

  return { ok: failures.length === 0, failures, source, checked: onDisk.length }
}

/**
 * Whether an installed tree carries the content that was sealed.
 *
 * Compares the installed package's own files against the tarball's, which is
 * the question a clean room actually raises: a set can be sealed correctly and
 * a room can still have been provisioned from an older copy that happened to
 * be lying around.
 */
export function verifyInstalled(installedDir, manifest) {
  const failures = []
  const scope = join(installedDir, '@deepwatch')
  if (!existsSync(scope)) return failures
  const sealedByName = new Map(
    (manifest.artifacts ?? []).filter(entry => entry.name).map(entry => [entry.name, entry]))

  for (const dir of readdirSync(scope).sort()) {
    const manifestPath = join(scope, dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const sealed = sealedByName.get(installed.name)
    if (sealed === undefined) {
      failures.push(failure('installed_unsealed',
        `${String(installed.name)} is installed but not in the sealed set`,
        'Reprovision the room from the sealed artifacts only.'))
      continue
    }
    if (installed.version !== sealed.version) {
      failures.push(failure('installed_version_drift',
        `${String(installed.name)} is ${String(installed.version)}, sealed as ${String(sealed.version)}`,
        'Reprovision the room from the sealed artifacts only.'))
    }
  }
  return failures
}

/** A digest over an installed package's shipped files, for content comparison. */
export function installedContentDigest(dir) {
  const hash = createHash('sha256')
  const walk = current => {
    for (const entry of readdirSync(current).sort()) {
      if (entry === 'node_modules') continue
      const path = join(current, entry)
      if (statSync(path).isDirectory()) { walk(path); continue }
      hash.update(entry).update(readFileSync(path))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

function main(argv) {
  const flag = name => {
    const at = argv.indexOf(name)
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null
  }
  const artifactsDir = flag('--artifacts')
  const manifestPath = flag('--manifest')
  if (artifactsDir === null || manifestPath === null) {
    process.stderr.write('verify-provenance: --artifacts <dir> and --manifest <file> are required\n')
    return 2
  }
  if (!existsSync(manifestPath)) {
    process.stderr.write(`verify-provenance: no manifest at ${manifestPath}\n`)
    return 2
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const result = verifyProvenance({
    artifactsDir,
    manifest,
    installedDir: flag('--installed'),
    expectCommit: flag('--expect-commit'),
  })

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.ok ? 0 : 1
  }
  if (result.ok) {
    process.stdout.write(
      `provenance verified: ${String(result.checked)} artifacts match the source they were sealed from\n`)
    return 0
  }
  process.stderr.write(`provenance REJECTED — ${String(result.failures.length)} finding(s)\n\n`)
  for (const item of result.failures) {
    process.stderr.write(`  ${item.code}\n    ${item.detail}\n    fix: ${item.fix}\n\n`)
  }
  return 1
}

// `pathToFileURL` rather than a hand-built `file://` string: on Windows the
// real URL is `file:///D:/…` and a two-slash spelling never matches, so the
// hand-built comparison silently declined to run and the command exited 0
// having done nothing. A gate that quietly does nothing is worse than no gate.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
