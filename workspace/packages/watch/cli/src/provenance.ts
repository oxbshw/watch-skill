/**
 * What is actually installed here, named so it can be checked against what was
 * released.
 *
 * An evaluation of this candidate inspected an installed npm runtime and could
 * not say where it came from — which package versions composed it, which
 * Harness it was measured against, or whether any of it matched a released
 * artifact. Everything needed to answer that already existed in the release
 * manifest; nothing carried it to the machine the product runs on.
 *
 * **Derived, never stamped.** The identity here is a digest over the sorted
 * `name@version` list of the composed packages. That is a function of the
 * source and of nothing else: no wall-clock time, no CI run id, no absolute
 * path, no operating system user, no repository state. Two machines that
 * installed the same release compute the same digest, and a machine that
 * installed something else computes a different one — which is the entire
 * property a person needs and the only one that survives being copied around.
 *
 * It deliberately does not read git. A published install has no repository
 * beside it, and provenance that only works in a checkout is provenance that
 * does not work where it matters. The release manifest records the same digest
 * from the same inputs, so the chain is released-composition to
 * installed-composition without either end needing a `.git` directory.
 *
 * @module @deepwatch/cli/provenance
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  HARNESS_PACKAGE, HARNESS_VERSION, RELEASE_RUNTIME_DIGEST, VERSION,
} from './version.js'

/** The npm scope every first-party runtime package sits under. */
export const SCOPE = '@deepwatch'

/** One installed package, as its own manifest describes it. */
export interface InstalledPackage {
  readonly name: string
  readonly version: string
}

/** What this installation is, in terms anybody can recompute. */
export interface Provenance {
  /** The CLI asking the question. */
  readonly cli: InstalledPackage
  /** The Harness this build was measured against, and the one that is here. */
  readonly harness: {
    readonly package: string
    readonly expected: string
    readonly installed: string | null
    readonly matches: boolean
  }
  /** Every first-party package found in the runtime, sorted by name. */
  readonly packages: readonly InstalledPackage[]
  /**
   * `sha256:…` over the sorted `name@version` list.
   *
   * The whole identity, in one value that can be compared against the release
   * manifest without trusting anything else on the machine.
   */
  readonly compositionDigest: string
  /** The digest this release recorded for its runtime packages. */
  readonly releaseDigest: string
  /** Whether the installation is the composition this release published. */
  readonly matchesRelease: boolean
  /** Where the packages were read from, as a runtime-relative fact. */
  readonly resolved: boolean
}

/**
 * The digest of a composition.
 *
 * Sorted before hashing, so the order a directory happens to be read in cannot
 * change the answer; newline-joined so `a@1` + `b@2` cannot collide with
 * `a@1b@2`. Exported because the release manifest computes it from the source
 * tree and the CLI computes it from an installation, and two spellings of one
 * digest would be two digests.
 */
export function compositionDigest(packages: readonly InstalledPackage[]): string {
  const lines = [...packages]
    .map(entry => `${entry.name}@${entry.version}`)
    // Code-point order, never `localeCompare`. The digest has to be the same on
    // every machine that installed the same release, and locale-aware collation
    // is exactly the thing that is not.
    .sort()
    .join('\n')
  return `sha256:${createHash('sha256').update(lines, 'utf8').digest('hex')}`
}

/**
 * Read the first-party packages installed under one `node_modules`.
 *
 * Returns an empty list rather than throwing when the directory is not there:
 * a machine that has not run `setup` has no composition, which is a state to
 * report rather than an error to raise.
 */
export function readComposition(nodeModules: string): readonly InstalledPackage[] {
  const scope = join(nodeModules, SCOPE)
  if (!existsSync(scope)) return []
  const found: InstalledPackage[] = []
  for (const entry of readdirSync(scope, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = join(scope, entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: unknown, version?: unknown
      }
      if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') continue
      found.push({ name: parsed.name, version: parsed.version })
    } catch {
      // A package whose manifest will not parse is not part of a composition
      // this can vouch for, and guessing its identity would be worse than
      // leaving it out of a digest that is supposed to mean something.
      continue
    }
  }
  return found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** Read one installed package's version, or null when it is not there. */
export function installedVersion(nodeModules: string, name: string): string | null {
  const manifest = join(nodeModules, ...name.split('/'), 'package.json')
  if (!existsSync(manifest)) return null
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Describe this installation.
 *
 * Takes the runtime's `node_modules` rather than finding it, so the same
 * function answers for a profile, a managed home, or a directory under test
 * without any of them being special.
 */
export function describeProvenance(nodeModules: string | null): Provenance {
  const packages = nodeModules === null ? [] : readComposition(nodeModules)
  const installed = nodeModules === null
    ? null
    : installedVersion(nodeModules, HARNESS_PACKAGE)
  return {
    cli: { name: '@deepwatch/cli', version: VERSION },
    harness: {
      package: HARNESS_PACKAGE,
      expected: HARNESS_VERSION,
      installed,
      matches: installed === HARNESS_VERSION,
    },
    packages,
    compositionDigest: compositionDigest(packages),
    releaseDigest: RELEASE_RUNTIME_DIGEST,
    matchesRelease: packages.length > 0
      && compositionDigest(packages) === RELEASE_RUNTIME_DIGEST,
    resolved: packages.length > 0,
  }
}

/**
 * Render provenance as lines a person reads, with no machine identity in them.
 *
 * Paths are deliberately absent. A provenance report is the kind of output
 * people paste into an issue, and an absolute path carries the operating system
 * user's name and the shape of somebody's disk into a public thread.
 */
export function renderProvenance(provenance: Provenance): readonly string[] {
  const lines = [
    `cli            ${provenance.cli.name}@${provenance.cli.version}`,
    `harness        ${provenance.harness.package}@${
      provenance.harness.installed ?? 'not installed'} (built against ${
      provenance.harness.expected})`,
  ]
  if (!provenance.resolved) {
    lines.push('composition    no first-party packages found — run `deepwatch setup`')
    return lines
  }
  lines.push(`composition    ${String(provenance.packages.length)} package(s)`)
  lines.push(`digest         ${provenance.compositionDigest}`)
  lines.push(provenance.matchesRelease
    ? 'release        matches the published composition'
    : `release        DOES NOT match the published composition (${
      provenance.releaseDigest})`)
  for (const entry of provenance.packages) {
    lines.push(`               ${entry.name}@${entry.version}`)
  }
  return lines
}
