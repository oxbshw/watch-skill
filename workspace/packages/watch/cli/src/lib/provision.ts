/**
 * Building the managed DeepWatch runtime: a self-contained directory holding
 * the pinned Harness, the DeepWatch packages, and everything either of them
 * needs to run — assembled somewhere else, proved to work, and moved into
 * place with one rename.
 *
 * Four facts drove this design, and each was measured rather than assumed.
 *
 * **The CLI's own `node_modules` is not the Harness's.** `setup` installs the
 * runtime under the user's DeepWatch home; the CLI lives wherever the user
 * installed it. Those are unrelated directories, so Node's resolver walking up
 * from the Harness never reaches `@deepwatch/dsh-bundle`. An earlier version
 * of this code assumed one shared tree and was wrong;
 * `tests/resolution-model.test.mjs` proves the resolution fails from real
 * separated directories, so nothing can quietly go back to assuming it. The
 * managed root therefore has to *contain* the bundle.
 *
 * **npm's default peer resolution does not finish here.** Two attempts,
 * roughly ten and seventy minutes, about 3 GB resident, no files written.
 * `--legacy-peer-deps` completes in seconds and installs no peers at all,
 * which leaves required peers missing and a Harness that will not start.
 * Neither mode is correct alone, so the required peers are supplied
 * explicitly, at exact versions, from a manifest derived at build time from
 * the audited closure — see `generated/managed-runtime.ts`. That the set is
 * complete is then *re-derived from the installed tree* rather than taken on
 * trust, because a precomputed list and a real `node_modules` are two
 * different things and only one of them is what boots.
 *
 * **Nothing under `@deepwatch` is published.** Before publication the
 * DeepWatch packages come from verified local tarballs whose directory is
 * named explicitly. The tarballs are copied *into* the runtime and installed
 * from the copies, so once setup finishes the runtime does not depend on where
 * they came from — an npx cache, a download directory, a mounted share, or the
 * source checkout. There is no silent fallback to a registry for a scope
 * nobody published.
 *
 * **A failed setup must not leave a broken one.** Everything happens in a
 * staging directory beside the destination. An existing healthy runtime is
 * moved aside rather than deleted, and is put back if the promotion does not
 * complete. The previous version installed straight into the final directory
 * and, when that failed, printed that nothing had been left behind while
 * leaving a manifest and a half-populated `node_modules` exactly where the
 * next run would find them and believe them.
 *
 * @module @deepwatch/cli/lib/provision
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import { resolveNpm, run } from './exec.js'
import type { Ran, RunOptions } from './exec.js'
import { installInvocation } from './install.js'
import { resolveBundle } from './bundle.js'
import { composeProfile } from './compose.js'
import {
  MANAGED_DEPENDENCIES, MANIFEST_DIGEST, REQUIRED_PEER_COUNT,
} from '../generated/managed-runtime.js'
import {
  BUNDLE_PACKAGE, BUNDLE_VERSION, HARNESS_PACKAGE, HARNESS_REGISTRY, HARNESS_VERSION,
} from '../version.js'

/** Where the DeepWatch packages are allowed to come from. Never inferred. */
export type SourceMode = 'local-artifacts' | 'registry'

/** How many DeepWatch tarballs a complete release set contains. */
export const DEEPWATCH_PACKAGE_COUNT = 20

/** The internal directory the runtime keeps its own copy of the tarballs in. */
export const ARTIFACT_DIR = '.artifacts'

/** One DeepWatch package the managed root must contain, and where it came from. */
export interface ManagedPackage {
  readonly name: string
  readonly version: string
  /** The tarball's file name, as the inventory records it. */
  readonly file: string
  /** Where it was read from. Replaced by the runtime's own copy before install. */
  readonly from: string
  readonly bytes: number
  /** `sha256:…`, verified at read and again after the copy. */
  readonly integrity: string
}

/** What provisioning would do, in the words it prints before doing it. */
export interface ManagedPlan {
  readonly registry: string
  readonly harness: { readonly package: string, readonly version: string }
  readonly mode: SourceMode
  /** Exact required peers, generated from the audited closure. */
  readonly peers: number
  readonly deepwatch: readonly ManagedPackage[]
  readonly artifacts: string | null
  readonly destination: string
  readonly manifestDigest: string
}

/** How provisioning ended. */
export type ProvisionOutcome =
  | 'installed'
  | 'no-package-manager'
  | 'artifacts-missing'
  | 'artifacts-mismatch'
  | 'install-failed'
  | 'peers-unresolved'
  | 'integrity-mismatch'
  | 'licence-refused'
  | 'harness-not-runnable'
  | 'bundle-unresolvable'
  | 'composition-failed'
  | 'receipt-failed'
  | 'promotion-failed'
  | 'locked'
  | 'cancelled'
  | 'timeout'

/** A phase of the transaction, named so a failure can say where it stopped. */
export type Phase =
  | 'artifact-copy'
  | 'artifact-recheck'
  | 'manifest'
  | 'install'
  | 'peers'
  | 'integrity'
  | 'licence'
  | 'harness-boot'
  | 'bundle'
  | 'composition'
  | 'receipt'
  | 'promote'

/** How long a phase took, so a slow setup is diagnosed rather than guessed at. */
export interface Timing {
  readonly phase: Phase
  readonly ms: number
}

/** What provisioning did, and what a person needs to know about it. */
export interface ProvisionReport {
  readonly outcome: ProvisionOutcome
  /** Which phase it stopped in. Absent only on success. */
  readonly phase?: Phase
  readonly detail: string
  readonly fix: string
  /** Present once a runtime is in place and validated. */
  readonly root?: string
  /** Where a failed attempt was kept, when it was kept. */
  readonly quarantined?: string
  /**
   * What was left behind and how to remove it.
   *
   * Empty means nothing was left. It is never empty while a quarantine
   * directory exists, because "nothing was changed" printed beside a directory
   * full of a failed attempt is the message that stops people looking in the
   * one place that would have told them what happened.
   */
  readonly cleanup: string
  readonly requiredPeers?: number
  readonly installedPackages?: number
  readonly timings?: readonly Timing[]
  readonly elapsedMs?: number
  /**
   * Peak resident memory of *this* process during the run.
   *
   * The package manager runs as a child, and its own peak is not observable
   * from here on any platform this ships to, so this is the CLI's figure and
   * is named for what it is rather than presented as the install's.
   */
  readonly peakRssBytes?: number
  readonly receipt?: string
}

/** How long the whole provisioning may take before it is a hang. */
const PROVISION_TIMEOUT_MS = 20 * 60 * 1000

/** How long the Harness gets to answer from a fresh install. */
const BOOT_TIMEOUT_MS = 3 * 60 * 1000

/** How long a lock may be held before it is treated as abandoned. */
const LOCK_STALE_MS = 30 * 60 * 1000

/** Licences the product will not install without a person deciding. */
const REFUSED_LICENCE = /^(unknown|unlicensed|see licen[cs]e)/i

/**
 * The exact dependency set the managed runtime is installed from.
 *
 * Generated at build time by walking the audited closure — never a
 * hand-written list, and never a range. Exposed as a function so the release
 * tooling and the tests read the same values the product does.
 */
export function managedDependencies(): Readonly<Record<string, string>> {
  return MANAGED_DEPENDENCIES
}

/** The digest of the generated manifest, for the receipt and the gates. */
export function managedManifestDigest(): string {
  return MANIFEST_DIGEST
}

/** The packed-artifact inventory that describes a local artifact directory. */
interface Inventory {
  packages?: {
    file?: string
    name?: string
    version?: string
    bytes?: number
    sha256?: string
  }[]
}

/** Why an artifact directory could not be used. */
export interface ArtifactFailure {
  readonly failure: 'artifacts-missing' | 'artifacts-mismatch'
  readonly detail: string
}

/** What a verified artifact directory holds. */
export interface ArtifactSet {
  readonly directory: string
  readonly packages: readonly ManagedPackage[]
  /** Every package the inventory listed, including the CLI. */
  readonly inventoryCount: number
}

/**
 * Whether an artifact directory is somewhere setup refuses to read from.
 *
 * The question is narrower than it looks, because the finished runtime never
 * depends on this directory: every tarball is copied into the runtime's own
 * `.artifacts/` and installed from the copy, and
 * `tests/managed-runtime.test.mjs` deletes the original and the source
 * checkout afterwards to prove it. So *where* the artifacts came from is not a
 * correctness problem on its own, and refusing a workspace's own
 * `.release-artifacts` would mean the release process could not verify its own
 * output without an extra copy nobody would check.
 *
 * What is refused is a location that can change underneath the verification.
 * A `node_modules` tree is rewritten by any package manager that happens to
 * run, including the one setup is about to start, so a digest checked there is
 * a digest that was true a moment ago. Everything else about the directory —
 * links, unpacked packages, extra tarballs — is checked by content, which is
 * the honest way to tell a release set from a build tree.
 */
function unsafeArtifactLocation(directory: string): string | null {
  if (directory.split(/[\\/]/).includes('node_modules')) {
    return 'the artifact directory is inside a node_modules tree, which a package '
      + 'manager may rewrite or remove between verifying a tarball and reading it'
  }
  return null
}

/**
 * The DeepWatch packages the managed root needs, read out of a local artifact
 * directory and checked, byte for byte, against the inventory beside them.
 *
 * Everything is refused rather than worked around: a missing tarball, an extra
 * one the inventory does not name, a renamed one, a wrong size, a wrong
 * digest, a symbolic link, an unpacked workspace directory, or a directory
 * whose location would make the finished runtime depend on something
 * temporary. This is the last point at which any of it is cheap to notice.
 *
 * The whole first-party set is taken rather than a computed closure: the
 * packages are released together at one version, npm satisfies each one's
 * ranges from its siblings on the same command line, and a "closure" computed
 * here is one more thing that can be subtly wrong. The CLI itself is excluded
 * — the managed root runs the product, it does not need the command that built
 * it.
 */
export function readArtifacts(directory: string): ArtifactSet | ArtifactFailure {
  if (!isAbsolute(directory)) {
    return {
      failure: 'artifacts-missing',
      detail: `--artifacts must name an absolute directory, and ${directory} is not one`,
    }
  }
  if (!existsSync(directory)) {
    return { failure: 'artifacts-missing', detail: `${directory} does not exist` }
  }
  const unsafe = unsafeArtifactLocation(realpathSync(directory))
  if (unsafe !== null) return { failure: 'artifacts-mismatch', detail: unsafe }

  const inventoryPath = join(directory, 'packed-artifacts.json')
  if (!existsSync(inventoryPath)) {
    return {
      failure: 'artifacts-missing',
      detail: `${directory} holds no packed-artifacts.json, so nothing there can be verified`,
    }
  }

  let inventory: Inventory
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as Inventory
  } catch (error) {
    return {
      failure: 'artifacts-mismatch',
      detail: `the inventory could not be read: ${String(error)}`,
    }
  }

  const records = inventory.packages ?? []
  if (records.length === 0) {
    return { failure: 'artifacts-mismatch', detail: 'the inventory names no packages' }
  }
  // Asked first, because a short inventory explains every other complaint that
  // would follow from it — an unnamed tarball, a missing bundle — and being
  // told the consequence rather than the cause sends people to the wrong fix.
  if (records.length !== DEEPWATCH_PACKAGE_COUNT) {
    return {
      failure: 'artifacts-mismatch',
      detail: `the inventory names ${String(records.length)} packages and a release set is `
        + String(DEEPWATCH_PACKAGE_COUNT),
    }
  }

  // Every tarball on disk must be accounted for. An extra one is refused
  // rather than ignored: a directory holding two versions of a package is one
  // nobody can say what a `file:` install would pick.
  const onDisk = new Set(readdirSync(directory).filter(name => name.endsWith('.tgz')))
  const named = new Set<string>()
  const packages: ManagedPackage[] = []

  for (const record of records) {
    const file = record.file
    const name = record.name
    if (typeof file !== 'string' || typeof name !== 'string') {
      return {
        failure: 'artifacts-mismatch',
        detail: 'the inventory has a row with no file or no package name',
      }
    }
    if (basename(file) !== file) {
      return {
        failure: 'artifacts-mismatch',
        detail: `the inventory names ${file}, which is a path rather than a file name`,
      }
    }
    named.add(file)

    const tarball = join(directory, file)
    if (!existsSync(tarball)) {
      return {
        failure: 'artifacts-missing',
        detail: `the inventory names ${file}, which is not in ${directory}`,
      }
    }
    const stats = lstatSync(tarball)
    if (stats.isSymbolicLink()) {
      return {
        failure: 'artifacts-mismatch',
        detail: `${file} is a symbolic link, so what would be installed is not what was verified`,
      }
    }
    if (!stats.isFile()) {
      return { failure: 'artifacts-mismatch', detail: `${file} is not a regular file` }
    }
    if (typeof record.bytes === 'number' && stats.size !== record.bytes) {
      return {
        failure: 'artifacts-mismatch',
        detail: `${file} is ${String(stats.size)} bytes and the inventory records `
          + String(record.bytes),
      }
    }
    const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    if (actual !== record.sha256) {
      return {
        failure: 'artifacts-mismatch',
        detail: `${file} does not match the digest the inventory records for it`,
      }
    }

    if (!name.startsWith('@deepwatch/')) continue
    if (record.version !== BUNDLE_VERSION) {
      return {
        failure: 'artifacts-mismatch',
        detail: `${name} in the inventory is ${String(record.version)} and this CLI `
          + `composes ${BUNDLE_VERSION}`,
      }
    }
    if (name === '@deepwatch/cli') continue
    packages.push({
      name,
      version: record.version,
      file,
      from: tarball,
      bytes: stats.size,
      integrity: `sha256:${actual}`,
    })
  }

  const extra = [...onDisk].filter(file => !named.has(file)).sort()
  if (extra.length > 0) {
    return {
      failure: 'artifacts-mismatch',
      detail: `${directory} holds ${String(extra.length)} tarball(s) the inventory does not `
        + `name, starting with ${String(extra[0])}`,
    }
  }
  // An unpacked package beside the tarballs is the shape of somebody having
  // pointed --artifacts at a build tree rather than at a release directory.
  for (const entry of readdirSync(directory)) {
    const at = join(directory, entry)
    if (lstatSync(at).isSymbolicLink()) {
      return {
        failure: 'artifacts-mismatch',
        detail: `${entry} in the artifact directory is a symbolic link`,
      }
    }
    if (statSync(at).isDirectory() && existsSync(join(at, 'package.json'))) {
      return {
        failure: 'artifacts-mismatch',
        detail: `${entry} is an unpacked package directory, and setup installs tarballs`,
      }
    }
  }

  if (!packages.some(entry => entry.name === BUNDLE_PACKAGE)) {
    return {
      failure: 'artifacts-missing',
      detail: `${BUNDLE_PACKAGE} is not in the inventory at ${directory}`,
    }
  }
  return { directory, packages, inventoryCount: records.length }
}

/** What provisioning would do, before it does any of it. */
export function managedPlan(
  destination: string, mode: SourceMode, artifacts: string | null,
  packages: readonly ManagedPackage[],
): ManagedPlan {
  return {
    registry: HARNESS_REGISTRY,
    harness: { package: HARNESS_PACKAGE, version: HARNESS_VERSION },
    mode,
    peers: REQUIRED_PEER_COUNT,
    deepwatch: packages,
    artifacts,
    destination,
    manifestDigest: MANIFEST_DIGEST,
  }
}

/** Every installed package in a tree, scopes expanded. */
export function installedPackages(root: string): Map<string, string> {
  const modules = join(root, 'node_modules')
  const found = new Map<string, string>()
  if (!existsSync(modules)) return found
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const name of readdirSync(join(modules, entry))) {
        found.set(`${entry}/${name}`, join(modules, entry, name))
      }
      continue
    }
    found.set(entry, join(modules, entry))
  }
  return found
}

/** One package's manifest, in the parts this reads. */
interface PeerManifest {
  name?: string
  version?: string
  license?: string
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** A package manifest, or null when it cannot be read. */
function manifestAt(dir: string): PeerManifest | null {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PeerManifest
  } catch {
    return null
  }
}

/**
 * Required peer dependencies the installed tree declares and does not contain.
 *
 * Derived from the tree itself, never from the manifest that built it. That is
 * the whole point: the generated manifest says what *should* close the set,
 * and this says whether it actually did. A precomputed list that is right and
 * an install that went wrong look identical from the manifest's side.
 *
 * Optional peers are skipped — an optional peer that is absent is a decision,
 * not a hole.
 */
export function missingRequiredPeers(root: string): Map<string, string> {
  const present = installedPackages(root)
  const missing = new Map<string, string>()
  for (const [, dir] of present) {
    const manifest = manifestAt(dir)
    if (manifest === null) continue
    const meta = manifest.peerDependenciesMeta ?? {}
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (meta[peer]?.optional === true) continue
      if (present.has(peer)) continue
      if (!missing.has(peer)) missing.set(peer, range)
    }
  }
  return missing
}

/** The manifest the managed root is built from: exact versions, no ranges. */
export function managedManifest(packages: readonly ManagedPackage[]): string {
  const dependencies: Record<string, string> = {}
  for (const [name, version] of Object.entries(MANAGED_DEPENDENCIES)) {
    dependencies[name] = version
  }
  for (const entry of packages) {
    // A relative specification, so the runtime describes itself without
    // carrying an absolute path from the machine that built it into a file the
    // product reads.
    dependencies[entry.name] = `file:${ARTIFACT_DIR}/${entry.file}`
  }
  const ordered: Record<string, string> = {}
  for (const name of Object.keys(dependencies).sort()) {
    ordered[name] = dependencies[name] as string
  }
  return `${JSON.stringify({
    name: 'deepwatch-managed-runtime',
    private: true,
    version: '0.0.0',
    description: 'Built by `deepwatch setup`. Delete this directory to remove it.',
    dependencies: ordered,
  }, null, 2)}\n`
}

/** A held lock, or the reason it could not be taken. */
interface Lock {
  readonly held: boolean
  readonly since?: string
  readonly release: () => void
}

/** Take the profile-scoped setup lock, recovering one that is plainly stale. */
export function takeLock(home: string): Lock {
  mkdirSync(home, { recursive: true })
  const lock = join(home, 'setup.lock')
  if (existsSync(lock)) {
    let stamp = 0
    try {
      stamp = (JSON.parse(readFileSync(lock, 'utf8')) as { at?: number }).at ?? 0
    } catch {
      stamp = 0
    }
    if (stamp > 0 && Date.now() - stamp < LOCK_STALE_MS) {
      return { held: false, since: new Date(stamp).toISOString(), release: () => {} }
    }
    // Bounded staleness recovery, by one documented rule: a lock older than
    // the longest a setup may take cannot belong to a live one.
    rmSync(lock, { force: true })
  }
  writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: Date.now() }, null, 2)}\n`, 'utf8')
  return { held: true, release: () => { rmSync(lock, { force: true }) } }
}

/** Options for one provisioning run. */
export interface ProvisionOptions {
  readonly home: string
  readonly destination: string
  readonly mode: SourceMode
  readonly artifacts: string | null
  readonly packages: readonly ManagedPackage[]
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  /**
   * How long the install may take before it is a hang rather than work.
   *
   * Twenty minutes by default, which is generous for a five-hundred-package
   * install on a slow connection and short enough that a wedged package
   * manager is eventually reported rather than waited on forever.
   */
  readonly timeoutMs?: number
  /** Called with each step, so a person watching sees progress. */
  readonly onStep?: (message: string) => void
  /**
   * Fail on purpose at one phase, to prove the transaction holds.
   *
   * Test-only, and deliberately a phase name rather than a boolean: a
   * counterfactual that can only break one phase proves only that phase.
   */
  readonly failAt?: Phase
  /**
   * The package manager to run, when it must not be the real one.
   *
   * Test-only, and the reason it exists is the same as `failAt`'s. The
   * transaction has twelve phases and each one has to be shown to leave the
   * destination alone when it fails. Proving that against the real npm would
   * mean five hundred packages downloaded twelve times to observe twelve
   * failures, which is slow enough that it would be run rarely and therefore
   * would not be a gate at all. With a stub the whole set runs offline in
   * seconds, and the real invocation is still exercised end to end by
   * `scripts/verify-packed-install.mjs` and by setup itself.
   */
  readonly installer?: { readonly command: string, readonly prefix: readonly string[] }
}

/** A phase that did not complete. Carries no stack a person would read. */
class PhaseFailure extends Error {}

/**
 * Build a managed runtime in staging, validate it, and promote it.
 *
 * The destination is never written to until every check has passed. An
 * existing runtime is moved aside rather than removed, and restored if the
 * promotion does not complete, so the failure modes are "the old one is still
 * there" and "the new one is there" and never "neither".
 */
export async function provisionManagedRuntime(
  options: ProvisionOptions,
): Promise<ProvisionReport> {
  const started = Date.now()
  const say = options.onStep ?? ((): void => {})
  const timings: Timing[] = []
  let peakRss = process.memoryUsage.rss()
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss())
  }, 500)
  sampler.unref?.()

  const npm = options.installer ?? resolveNpm(options.env)
  if (npm === null) {
    clearInterval(sampler)
    return {
      outcome: 'no-package-manager',
      detail: 'no npm this product can run was found beside this Node or on PATH',
      fix: 'Install Node with npm beside it, then run `deepwatch setup` again.',
      cleanup: '',
    }
  }

  const lock = takeLock(options.home)
  if (!lock.held) {
    clearInterval(sampler)
    return {
      outcome: 'locked',
      detail: `another setup has been building this runtime since ${String(lock.since)}`,
      fix: 'Wait for it to finish, or remove setup.lock in the DeepWatch home if no '
        + 'other setup is running. A lock older than thirty minutes is ignored.',
      cleanup: '',
    }
  }

  const stamp = `${String(process.pid)}-${String(Date.now())}`
  const staging = `${options.destination}.staging-${stamp}`
  const supplanted = `${options.destination}.previous-${stamp}`
  let promoted = false
  let reached: Phase = 'artifact-copy'

  /** Run one phase, timed, and let a deliberate failure out. */
  const phase = async <T>(name: Phase, body: () => Promise<T> | T): Promise<T> => {
    reached = name
    const at = Date.now()
    try {
      if (options.failAt === name) {
        throw new PhaseFailure(`the ${name} phase was made to fail on purpose`)
      }
      return await body()
    } finally {
      timings.push({ phase: name, ms: Date.now() - at })
    }
  }

  /** Everything a report has to say about what is left on disk. */
  const stopped = (
    outcome: ProvisionOutcome, at: Phase, detail: string, fix: string,
  ): ProvisionReport => ({
    outcome,
    phase: at,
    detail,
    fix,
    ...(existsSync(staging) ? { quarantined: staging } : {}),
    cleanup: existsSync(staging)
      ? `The failed attempt was kept at ${staging} so it can be looked at. Nothing at `
        + `${options.destination} was changed. Remove that directory when you no `
        + 'longer need it — setup never reuses it.'
      : '',
    timings,
    elapsedMs: Date.now() - started,
    peakRssBytes: peakRss,
  })

  try {
    mkdirSync(staging, { recursive: true })

    const kept: ManagedPackage[] = []
    await phase('artifact-copy', () => {
      if (options.mode !== 'local-artifacts') return
      const into = join(staging, ARTIFACT_DIR)
      mkdirSync(into, { recursive: true })
      for (const entry of options.packages) {
        copyFileSync(entry.from, join(into, entry.file))
        kept.push({ ...entry, from: join(into, entry.file) })
      }
    })

    await phase('artifact-recheck', () => {
      // The copies are hashed again. A byte that changed between the check and
      // the install is exactly what this exists for, and it costs a second.
      for (const entry of kept) {
        const actual = createHash('sha256').update(readFileSync(entry.from)).digest('hex')
        if (`sha256:${actual}` !== entry.integrity) {
          throw new PhaseFailure(`${entry.file} changed between verification and copy`)
        }
      }
    })

    await phase('manifest', () => {
      writeFileSync(join(staging, 'package.json'), managedManifest(kept), 'utf8')
      writeFileSync(join(staging, '.npmrc'), 'audit=false\nfund=false\n', 'utf8')
    })

    const install = await phase('install', async () => {
      say(`  installing ${HARNESS_PACKAGE}@${HARNESS_VERSION}, `
        + `${String(REQUIRED_PEER_COUNT)} exact required peers and `
        + `${String(kept.length)} DeepWatch packages`)
      return run(npm.command, [...npm.prefix, ...installInvocation()],
        runOptions(staging, options))
    })
    const failed = terminal(install)
    if (failed !== null) return stopped(failed.outcome, 'install', failed.detail, failed.fix)

    const installed = installedPackages(staging).size

    await phase('peers', () => {
      const missing = missingRequiredPeers(staging)
      if (missing.size === 0) return
      throw new PhaseFailure(
        `${String(missing.size)} required peer dependencies are missing from the installed `
        + `tree: ${[...missing.keys()].sort().slice(0, 5).join(', ')}`)
    })

    await phase('integrity', () => {
      for (const entry of kept) {
        const manifest = manifestAt(join(staging, 'node_modules', ...entry.name.split('/')))
        if (manifest === null) throw new PhaseFailure(`${entry.name} did not install`)
        if (manifest.version !== entry.version) {
          throw new PhaseFailure(
            `${entry.name} installed as ${String(manifest.version)} and the verified `
            + `artifact was ${entry.version}`)
        }
      }
    })

    await phase('licence', () => {
      const unnamed: string[] = []
      for (const [name, dir] of installedPackages(staging)) {
        const licence = manifestAt(dir)?.license
        if (typeof licence !== 'string' || REFUSED_LICENCE.test(licence)) unnamed.push(name)
      }
      if (unnamed.length > 0) {
        throw new PhaseFailure(
          `${String(unnamed.length)} installed package(s) declare no licence this product `
          + `can name: ${unnamed.sort().slice(0, 3).join(', ')}`)
      }
    })

    const entry = join(staging, 'node_modules', ...HARNESS_PACKAGE.split('/'), 'lib', 'bin.js')
    await phase('harness-boot', async () => {
      say('  checking the Harness starts')
      if (!existsSync(entry)) {
        throw new PhaseFailure('the install produced no Harness entry point')
      }
      const version = await run(process.execPath, [entry, '--version'],
        { env: options.env, timeoutMs: BOOT_TIMEOUT_MS, cwd: staging })
      if (version.code !== 0 || !version.stdout.includes(HARNESS_VERSION)) {
        throw new PhaseFailure(
          `the Harness did not report ${HARNESS_VERSION}: `
          + firstLine(version.stderr === '' ? version.stdout : version.stderr))
      }
    })

    await phase('bundle', () => {
      // Resolved from the Harness's own manifest, which is the anchor the
      // Harness resolves a profile layer from, and required to sit inside the
      // root about to be promoted. A bundle visible from anywhere else is not
      // the one that will be loaded.
      const anchor = join(staging, 'node_modules', ...HARNESS_PACKAGE.split('/'), 'package.json')
      const lookup = resolveBundle(anchor, staging)
      if (lookup.bundle === null) throw new PhaseFailure(lookup.detail)
    })

    await phase('composition', async () => {
      // Composition is rehearsed here in full, in a throwaway home inside
      // staging, and the rehearsal ends by opening the profile and asking it
      // for a page. Anything less passes on a runtime that cannot serve: the
      // first version of this checked `--dump-config`, which resolves a tree
      // without importing a plugin or binding a port, and a profile that died
      // on ERR_MODULE_NOT_FOUND got promoted with a tick beside it.
      const rehearsal = join(staging, '.compose-check')
      mkdirSync(rehearsal, { recursive: true })
      const composed = await composeProfile({
        dshEntry: entry,
        managedRoot: staging,
        dshHome: rehearsal,
        profile: 'deepwatch-precheck',
        env: options.env,
        timeoutMs: BOOT_TIMEOUT_MS,
        bootProbe: true,
        onStep: say,
      })
      if (composed.outcome !== 'composed' && composed.outcome !== 'already-composed') {
        throw new PhaseFailure(composed.detail)
      }
      rmSync(rehearsal, { recursive: true, force: true, maxRetries: 5 })
    })

    await phase('receipt', () => {
      writeFileSync(join(staging, 'deepwatch-install-receipt.json'), receiptFor({
        packages: kept,
        installed,
        artifacts: options.artifacts,
        mode: options.mode,
        elapsedMs: Date.now() - started,
        peakRssBytes: peakRss,
        timings,
      }), 'utf8')
    })

    await phase('promote', () => {
      // The old runtime is moved aside, not deleted. If the rename that puts
      // the new one in place fails, the old one goes back, so there is no
      // moment at which a person has neither.
      const hadPrevious = existsSync(options.destination)
      if (hadPrevious) renameSync(options.destination, supplanted)
      try {
        renameSync(staging, options.destination)
      } catch (error) {
        if (hadPrevious) renameSync(supplanted, options.destination)
        throw error instanceof Error ? error : new Error(String(error))
      }
      promoted = true
    })

    return {
      outcome: 'installed',
      detail: `${HARNESS_PACKAGE}@${HARNESS_VERSION} with ${BUNDLE_PACKAGE}@${BUNDLE_VERSION}`,
      fix: '',
      root: options.destination,
      cleanup: '',
      requiredPeers: REQUIRED_PEER_COUNT,
      installedPackages: installed,
      timings,
      elapsedMs: Date.now() - started,
      peakRssBytes: peakRss,
      receipt: join(options.destination, 'deepwatch-install-receipt.json'),
    }
  } catch (error) {
    return stopped(
      outcomeFor(reached), reached,
      error instanceof Error ? error.message : String(error), fixFor(reached))
  } finally {
    clearInterval(sampler)
    lock.release()
    if (existsSync(supplanted)) {
      // Either the promotion completed, in which case this is the superseded
      // runtime, or it never started, in which case it does not exist.
      rmSync(supplanted, { recursive: true, force: true, maxRetries: 5 })
    }
    void promoted
  }
}

/** Which outcome a phase failure is. */
function outcomeFor(at: Phase): ProvisionOutcome {
  switch (at) {
    case 'artifact-copy':
    case 'artifact-recheck': return 'artifacts-mismatch'
    case 'peers': return 'peers-unresolved'
    case 'integrity': return 'integrity-mismatch'
    case 'licence': return 'licence-refused'
    case 'harness-boot': return 'harness-not-runnable'
    case 'bundle': return 'bundle-unresolvable'
    case 'composition': return 'composition-failed'
    case 'receipt': return 'receipt-failed'
    case 'promote': return 'promotion-failed'
    default: return 'install-failed'
  }
}

/** What to do about a phase failure, in words that name the next step. */
function fixFor(at: Phase): string {
  switch (at) {
    case 'artifact-copy':
    case 'artifact-recheck':
      return 'Re-pack the release artifacts and run setup again with --artifacts '
        + 'naming the fresh directory.'
    case 'peers':
      return 'The generated runtime manifest did not close the required-peer set for '
        + 'this closure. Report it with the quarantined directory; installing the '
        + 'missing packages by hand produces a runtime this product does not test.'
    case 'integrity':
      return 'A package installed as a different version from the artifact it came '
        + 'from. Re-pack and run setup again.'
    case 'licence':
      return 'A package in the closure declares no licence. That is a decision for a '
        + 'person, not for setup.'
    case 'harness-boot':
      return 'The runtime installed and will not start. Report it with the quarantined '
        + 'directory, which holds the complete tree that failed.'
    case 'bundle':
    case 'composition':
      return 'The runtime installed and does not compose. Re-pack the artifacts and '
        + 'run setup again.'
    case 'promote':
      return 'The finished runtime could not be moved into place. Close anything using '
        + 'the DeepWatch home and run setup again; the previous runtime, if there '
        + 'was one, is exactly as it was.'
    default:
      return 'Nothing was installed where the runtime goes. Run setup again.'
  }
}

/** The receipt, which is what makes an install reviewable and reversible. */
function receiptFor(facts: {
  packages: readonly ManagedPackage[]
  installed: number
  artifacts: string | null
  mode: SourceMode
  elapsedMs: number
  peakRssBytes: number
  timings: readonly Timing[]
}): string {
  return `${JSON.stringify({
    installedBy: '@deepwatch/cli',
    harness: { package: HARNESS_PACKAGE, version: HARNESS_VERSION },
    registry: HARNESS_REGISTRY,
    bundle: { package: BUNDLE_PACKAGE, version: BUNDLE_VERSION },
    manifestDigest: MANIFEST_DIGEST,
    requiredPeers: REQUIRED_PEER_COUNT,
    installedPackages: facts.installed,
    installArguments: installInvocation(),
    deepwatchSource: facts.mode,
    // Provenance, and only that. The runtime installs from its own copies
    // under `.artifacts/`, so this path may disappear without affecting
    // anything: nothing reads it at boot and it is never served to a browser.
    deepwatchArtifactOrigin: facts.artifacts,
    deepwatchPackages: facts.packages.map(entry => ({
      name: entry.name,
      version: entry.version,
      file: entry.file,
      bytes: entry.bytes,
      integrity: entry.integrity,
    })),
    timings: facts.timings,
    // Said plainly, because a list of phases that stops two short of the end
    // reads like two phases that took no time.
    timingsNote:
      'Phases up to and including validation. Writing this receipt and '
      + 'promoting the runtime happen after it is written, so they are not in '
      + 'the list; the caller\'s report carries all twelve.',
    elapsedMs: facts.elapsedMs,
    // Named for what it is. The package manager runs as a child process and
    // its own peak is not observable from here, so this is not it.
    cliPeakRssBytes: facts.peakRssBytes,
    installedAt: new Date().toISOString(),
    remove: 'Delete this directory. Nothing outside it was written.',
  }, null, 2)}\n`
}

/**
 * Run options for one staged install.
 *
 * Built rather than spread because an absent `AbortSignal` must be an absent
 * property, not a property holding `undefined` — the difference matters under
 * `exactOptionalPropertyTypes`, and collapsing it would let a "no signal" call
 * look like a cancelled one.
 */
function runOptions(cwd: string, options: ProvisionOptions): RunOptions {
  const timeoutMs = options.timeoutMs ?? PROVISION_TIMEOUT_MS
  return options.signal === undefined
    ? { cwd, env: options.env, timeoutMs }
    : { cwd, env: options.env, timeoutMs, signal: options.signal }
}

/** A run that ended without an exit code of its own, as a report fragment. */
function terminal(ran: Ran): { outcome: ProvisionOutcome, detail: string, fix: string } | null {
  if (ran.failure === 'spawn-failed') {
    return {
      outcome: 'no-package-manager',
      detail: `npm could not be started: ${firstLine(ran.stderr)}`,
      fix: 'Install Node with npm beside it and run setup again.',
    }
  }
  if (ran.failure === 'cancelled') {
    return {
      outcome: 'cancelled',
      detail: 'setup was cancelled before the runtime was built',
      fix: 'Run `deepwatch setup` again when you are ready.',
    }
  }
  if (ran.failure === 'timeout') {
    return {
      outcome: 'timeout',
      detail: 'the install did not finish in time',
      fix: 'Check the network and run setup again.',
    }
  }
  if (ran.code !== 0) {
    return {
      outcome: 'install-failed',
      detail: firstLine(ran.stderr === '' ? ran.stdout : ran.stderr),
      fix: 'Run setup again.',
    }
  }
  return null
}

/** The first line of a child's output, for a message a person will read. */
function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'no output'
}
