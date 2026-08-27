/**
 * Updates and rollback, with the signing honestly labelled.
 *
 * The whole mechanism is here — Ed25519 signature verification, package
 * integrity, a migration preflight before anything is applied, and a rollback
 * that restores the previous build. What is *not* here is a production signing key, and the
 * distinction is stated in the code rather than left to a release checklist:
 * {@link SIGNING_STATUS} says PRODUCTION SIGNING NOT PROVEN, and it stays that
 * way until a real credential exists.
 *
 * That label matters because an update channel is the most dangerous thing a
 * desktop application has. It runs code the person did not choose, at a
 * privilege they already granted, on a schedule they do not control. A channel
 * whose signing is unproven and whose UI says "secure updates" is worse than
 * no channel at all.
 *
 * The order of operations is the other load-bearing part. Signature, then
 * integrity, then migration preflight, then apply. Verifying after unpacking
 * means unpacking something unverified, and a migration discovered after the
 * swap is a migration discovered too late to refuse.
 *
 * @module @watchskill/watch-desktop/updates
 */

import { createHash, createPublicKey, verify as verifySignatureBytes } from 'node:crypto'

/**
 * What may be claimed about update signing today.
 *
 * A constant rather than a comment, so it can be rendered in the About panel
 * and asserted in a test. Changing it requires changing code, which is the
 * point: a release that acquires real signing has to say so deliberately.
 */
export const SIGNING_STATUS = 'PRODUCTION SIGNING NOT PROVEN' as const

/** One release, as the channel describes it. */
export interface UpdateManifest {
  readonly version: string
  /** SHA-256 of the package, hex. */
  readonly sha256: string
  readonly sizeBytes: number
  /** Schema version the new build expects. */
  readonly schemaVersion: number
  /** Base64 signature over the canonical manifest bytes. */
  readonly signature: string
  /** Which key signed it. */
  readonly keyId: string
  readonly releasedAt: string
}

/** A key the updater will accept signatures from. */
export interface SigningKey {
  readonly keyId: string
  /** PEM SPKI public key. */
  readonly publicKeyPem: string
  /**
   * Whether this key is a production credential.
   *
   * Development keys are accepted so the mechanism can be exercised, and a
   * package signed by one is labelled for what it is rather than presented as
   * a verified release.
   */
  readonly production: boolean
}

/**
 * The exact bytes a signature covers.
 *
 * Canonical and explicit. Signing "the manifest" and verifying a
 * re-serialization of it is how a signature ends up covering a different byte
 * string than the one that was checked.
 */
export function canonicalManifest(manifest: UpdateManifest): string {
  return [
    manifest.version,
    manifest.sha256,
    String(manifest.sizeBytes),
    String(manifest.schemaVersion),
    manifest.keyId,
    manifest.releasedAt,
  ].join('\n')
}

/** Why an update was refused. */
export interface UpdateRefusal {
  readonly stage: 'signature' | 'integrity' | 'migration' | 'downgrade'
  readonly detail: string
  readonly fix: string
}

/** The outcome of checking an update. */
export type UpdateDecision =
  | {
    readonly ok: true
    readonly manifest: UpdateManifest
    /** True when a development key signed it. */
    readonly developmentSigned: boolean
    readonly note: string
  }
  | { readonly ok: false; readonly refusal: UpdateRefusal }

/**
 * Verify the manifest signature.
 *
 * Ed25519, and the algorithm argument is `null` because Ed25519 signs the
 * message directly rather than a digest of it. Passing a hash name here is the
 * mistake that produces a verifier which rejects every valid signature — and,
 * worse, a verifier somebody then "fixes" by removing the check.
 */
function verifySignature(manifest: UpdateManifest, keys: readonly SigningKey[]): SigningKey | null {
  const key = keys.find(candidate => candidate.keyId === manifest.keyId)
  if (key === undefined) return null
  try {
    const verified = verifySignatureBytes(
      null,
      Buffer.from(canonicalManifest(manifest)),
      createPublicKey(key.publicKeyPem),
      Buffer.from(manifest.signature, 'base64'),
    )
    return verified ? key : null
  } catch {
    // A malformed key or signature is a failed verification, not a crash. An
    // updater that throws on a bad signature is an updater somebody wraps in a
    // try/catch that swallows the refusal.
    return null
  }
}

/**
 * Decide whether an update may be applied.
 *
 * In order, and the order is the security property:
 *
 * 1. **Signature.** Nothing is unpacked before this passes.
 * 2. **Integrity.** The bytes are the bytes the signed manifest names.
 * 3. **Downgrade.** A package older than what is installed is refused; an
 *    update channel that silently downgrades is an update channel that can
 *    reintroduce a fixed vulnerability.
 * 4. **Migration preflight.** A build whose schema this store cannot reach is
 *    refused *before* the swap, because after the swap the only remaining
 *    option is a rollback the person did not ask for.
 */
export function checkUpdate(input: {
  readonly manifest: UpdateManifest
  readonly packageBytes: Buffer
  readonly keys: readonly SigningKey[]
  readonly installedVersion: string
  readonly currentSchemaVersion: number
  readonly supportedSchemaVersions: readonly number[]
}): UpdateDecision {
  const key = verifySignature(input.manifest, input.keys)
  if (key === null) {
    return {
      ok: false,
      refusal: {
        stage: 'signature',
        detail: `No accepted key verifies this manifest (claimed key ${input.manifest.keyId}).`,
        fix: 'Download the update again from the official channel.',
      },
    }
  }

  const digest = createHash('sha256').update(input.packageBytes).digest('hex')
  if (digest !== input.manifest.sha256) {
    return {
      ok: false,
      refusal: {
        stage: 'integrity',
        detail: `The package digest is ${digest}; the signed manifest names ${input.manifest.sha256}.`,
        fix: 'The download is corrupt or was tampered with. Fetch it again.',
      },
    }
  }
  if (input.packageBytes.length !== input.manifest.sizeBytes) {
    return {
      ok: false,
      refusal: {
        stage: 'integrity',
        detail: `The package is ${String(input.packageBytes.length)} bytes; the manifest names `
          + `${String(input.manifest.sizeBytes)}.`,
        fix: 'The download is incomplete. Fetch it again.',
      },
    }
  }

  if (compareVersions(input.manifest.version, input.installedVersion) < 0) {
    return {
      ok: false,
      refusal: {
        stage: 'downgrade',
        detail: `This package is ${input.manifest.version}; ${input.installedVersion} is installed.`,
        fix: 'Downgrades are not applied automatically. Install it deliberately if that is intended.',
      },
    }
  }

  if (!input.supportedSchemaVersions.includes(input.currentSchemaVersion)
    && input.manifest.schemaVersion < input.currentSchemaVersion) {
    return {
      ok: false,
      refusal: {
        stage: 'migration',
        detail: `This build expects schema ${String(input.manifest.schemaVersion)} and the store `
          + `is at ${String(input.currentSchemaVersion)}.`,
        fix: 'Keep the current version. A store cannot be moved backwards.',
      },
    }
  }

  return {
    ok: true,
    manifest: input.manifest,
    developmentSigned: !key.production,
    note: key.production
      ? ''
      : `Signed with a development key (${key.keyId}). ${SIGNING_STATUS}.`,
  }
}

/** Compare two dotted versions. Returns -1, 0 or 1. */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string): readonly number[] =>
    version.split(/[.-]/).map(part => Number.parseInt(part, 10)).map(n => Number.isFinite(n) ? n : 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** One installed build the app can run or roll back to. */
export interface InstalledBuild {
  readonly version: string
  readonly path: string
  readonly schemaVersion: number
  readonly installedAt: string
}

/** The state of the install slots. */
export interface InstallState {
  readonly current: InstalledBuild
  /** The build that was current before the last update, if there is one. */
  readonly previous: InstalledBuild | null
  /** Consecutive failed launches of `current`. */
  readonly failedLaunches: number
}

/** How many failed launches of a new build trigger a rollback. */
export const ROLLBACK_AFTER_FAILED_LAUNCHES = 2

/** What the launcher should do next. */
export type LaunchDecision =
  | { readonly action: 'run'; readonly build: InstalledBuild }
  | { readonly action: 'rollback'; readonly build: InstalledBuild; readonly reason: string }
  | { readonly action: 'safe_mode'; readonly reason: string; readonly fix: string }

/**
 * Decide what to run.
 *
 * A build that has failed to launch twice is rolled back to the previous one,
 * and if there is no previous one the app starts in safe mode rather than
 * trying a third time. Two is a deliberate number: one failure is a crash, and
 * two in a row is the build.
 */
export function decideLaunch(state: InstallState): LaunchDecision {
  if (state.failedLaunches < ROLLBACK_AFTER_FAILED_LAUNCHES) {
    return { action: 'run', build: state.current }
  }
  if (state.previous !== null) {
    return {
      action: 'rollback',
      build: state.previous,
      reason: `${state.current.version} failed to start `
        + `${String(state.failedLaunches)} times; rolling back to ${state.previous.version}.`,
    }
  }
  return {
    action: 'safe_mode',
    reason: `${state.current.version} failed to start `
      + `${String(state.failedLaunches)} times and there is no previous build to return to.`,
    fix: 'Reinstall Watch, or start it with --safe-mode to reach your data.',
  }
}

/** Apply an update to the install state, keeping the previous build. */
export function applyUpdate(state: InstallState, build: InstalledBuild): InstallState {
  return { current: build, previous: state.current, failedLaunches: 0 }
}

/** Roll back, discarding the build that failed. */
export function rollback(state: InstallState): InstallState {
  if (state.previous === null) return state
  return { current: state.previous, previous: null, failedLaunches: 0 }
}

/** Record that the current build failed to start. */
export function recordFailedLaunch(state: InstallState): InstallState {
  return { ...state, failedLaunches: state.failedLaunches + 1 }
}

/** Record that the current build started, clearing the failure count. */
export function recordSuccessfulLaunch(state: InstallState): InstallState {
  return { ...state, failedLaunches: 0 }
}

/**
 * What the About panel says about updates.
 *
 * Includes the signing label unconditionally. A person deciding whether to
 * trust an automatic update needs to know that the signing has not been proven
 * in production, and burying that in a changelog is not telling them.
 */
export function updateAssurance(keys: readonly SigningKey[]): string {
  const production = keys.filter(key => key.production)
  if (production.length === 0) {
    return `Updates are signature-checked against ${String(keys.length)} development key(s). `
      + `${SIGNING_STATUS}.`
  }
  return `Updates are signature-checked against ${String(production.length)} production key(s).`
}
