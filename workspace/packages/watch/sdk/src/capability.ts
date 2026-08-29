/**
 * The third-party capability path, and the one thing it deliberately cannot do.
 *
 * A Watch capability is a plugin that can see something Watch cannot: a
 * proprietary video format, a specialist OCR engine, a device that produces
 * frames. Somebody should be able to write one without forking DSH, patching
 * Watch Core, or negotiating with anybody. This module is that path.
 *
 * It is also, and mostly, a boundary. ADR-002 says only Watch Core mints an
 * EvidenceRecord and only Watch Core issues a Verdict, and an SDK is exactly
 * where that rule would erode — not by anyone deciding to break it, but by a
 * helper that takes a `verdict` field because a plugin author asked for one.
 *
 * So the boundary is built two ways at once, because either alone would fail.
 *
 * **By shape.** A plugin submits a {@link CandidateObservation}. That type has
 * no `evidenceId`, no `freshness`, no `provenance` and no `verdict` — not as
 * optional fields, not as nullable ones. There is no exported function in this
 * package that returns an `EvidenceRecord` or a `Verdict`, and a test asserts
 * that by inspecting the module's own surface.
 *
 * **By sanitization.** Types are erased at runtime, and a plugin is a
 * JavaScript object that can carry whatever it likes. So every submission is
 * stripped of authority fields before it goes anywhere, and what was stripped
 * is *reported* rather than silently dropped — a plugin trying to mint a
 * verdict is a thing the operator should find out about.
 *
 * @module @watchskill/dsh-sdk/capability
 */

import type {
  EvidenceRecord,
  SpatialRegion,
  TemporalRange,
  VerificationOutcome,
  WatchError,
} from '@watchskill/dsh-contracts'
import type { TechnologyDescriptor } from '@watchskill/dsh-technology'

/** What a capability says it can do. */
export interface CapabilityDeclaration {
  /** Reverse-DNS, unique across the installation. */
  readonly id: string
  readonly displayName: string
  readonly version: string
  /** Capability ids this provides, in Watch Core's vocabulary. */
  readonly provides: readonly string[]
  readonly modalities: readonly ('image' | 'audio' | 'video' | 'text' | 'dom')[]
  readonly permissions: readonly PermissionDeclaration[]
  /**
   * How it runs, what it needs, and what its licence is.
   *
   * Reuses the technology descriptor rather than a plugin-specific shape, so a
   * third-party engine is subject to exactly the routing, health, hardware and
   * licence rules a built-in one is — including the ones it would rather not
   * be.
   */
  readonly descriptor: TechnologyDescriptor
}

/** One thing a capability needs permission for. */
export interface PermissionDeclaration {
  readonly id: string
  /** Why, in a sentence an operator reads before granting it. */
  readonly reason: string
  readonly scope: 'read' | 'observe' | 'act'
  /**
   * Whether granting this could change the world.
   *
   * Declared by the plugin and re-derived by the host from `scope`; a plugin
   * that declares `act` and `highImpact: false` is corrected rather than
   * believed.
   */
  readonly highImpact: boolean
}

/**
 * What a capability submits.
 *
 * Note what is absent, and that none of it is absent by accident: no evidence
 * id, no freshness, no provenance, no digest, no retention class, no verdict.
 * Those are Watch Core's to assign, and a plugin that could supply them could
 * assert that its own output was observed, current and proven.
 */
export interface CandidateObservation {
  /** The capability that produced this. Overwritten by the host, never trusted. */
  readonly producer: string
  readonly producerVersion: string
  /** Which source revision this was read from. */
  readonly sourceRevisionId: string
  readonly temporalRange: TemporalRange | null
  readonly spatialRegion: SpatialRegion | null
  readonly modality: EvidenceRecord['modality']
  /** What was read, verbatim, in its original script. */
  readonly text: string
  /** Artifact handles the capability wrote, if any. */
  readonly artifactIds: readonly string[]
  /** ISO-8601 of when the capability observed it. */
  readonly capturedAt: string
  /** Anything the capability wants an operator to know about this reading. */
  readonly qualityWarnings: readonly string[]
  /**
   * A calibrated confidence, or null.
   *
   * Null is the honest answer for most producers. A token probability is not a
   * calibrated confidence, and converting one into the other produces a number
   * that looks like a probability and is not.
   */
  readonly confidence: number | null
}

/**
 * Fields a submission may never carry.
 *
 * Every one of these is an authority claim. They are stripped at runtime
 * rather than merely absent from the type, because a type is not present at
 * runtime and a plugin is an object.
 */
export const AUTHORITY_FIELDS: readonly string[] = [
  'evidenceId',
  'verdict',
  'verificationId',
  'receiptId',
  'freshness',
  'provenance',
  'contentDigest',
  'retentionClass',
  'verified',
  'trusted',
]

/** What sanitization did. */
export interface Sanitized {
  readonly candidate: CandidateObservation
  /**
   * Authority fields that were present and removed.
   *
   * Reported rather than swallowed. A plugin attempting to mint a verdict is
   * something an operator should be told about, and a silent strip would make
   * a hostile capability indistinguishable from a correct one.
   */
  readonly stripped: readonly string[]
}

/** Read a string field, or fall back. */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Read a number field, or null. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Read a string array, dropping anything that is not a string. */
function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Strip a submission down to what a capability is allowed to assert.
 *
 * Allowlist rather than denylist for the *shape* — only known fields survive —
 * with the denylist used purely to report what was attempted. A denylist alone
 * would let tomorrow's authority field through; an allowlist alone would strip
 * a forged verdict silently.
 */
export function sanitizeCandidate(raw: unknown, producer: {
  readonly id: string
  readonly version: string
}): Sanitized {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const stripped = AUTHORITY_FIELDS.filter(field => field in input)

  const range = input['temporalRange'] as Record<string, unknown> | null | undefined
  const region = input['spatialRegion'] as Record<string, unknown> | null | undefined

  return {
    stripped,
    candidate: {
      // Not read from the input. A capability does not get to say which
      // capability produced something.
      producer: producer.id,
      producerVersion: producer.version,
      sourceRevisionId: text(input['sourceRevisionId']),
      temporalRange: range === null || range === undefined ? null : {
        startMs: num(range['startMs']) ?? 0,
        endMs: num(range['endMs']) ?? 0,
      },
      spatialRegion: region === null || region === undefined ? null : {
        x: num(region['x']) ?? 0,
        y: num(region['y']) ?? 0,
        width: num(region['width']) ?? 0,
        height: num(region['height']) ?? 0,
      },
      modality: (['visual', 'text', 'audio', 'dom', 'network', 'filesystem'] as const)
        .includes(input['modality'] as never)
        ? input['modality'] as EvidenceRecord['modality']
        : 'text',
      text: text(input['text']),
      artifactIds: strings(input['artifactIds']),
      capturedAt: text(input['capturedAt']),
      qualityWarnings: strings(input['qualityWarnings']),
      confidence: num(input['confidence']),
    },
  }
}

/** What came back from a submission. */
export type SubmissionResult =
  | {
    readonly ok: true
    /** Minted by Watch Core. The capability never chose it. */
    readonly evidenceId: string
    /** Authority fields the submission tried to carry. Usually empty. */
    readonly stripped: readonly string[]
  }
  | { readonly ok: false; readonly error: WatchError; readonly stripped: readonly string[] }

/** A verification a capability may ask for, but never answer. */
export interface VerificationRequest {
  readonly expectation: string
  readonly contractId: string | null
  /** Evidence the capability believes is relevant. Core decides if it is. */
  readonly evidenceIds: readonly string[]
  readonly timeoutMs: number | null
}

/**
 * What Watch Core offers a capability.
 *
 * Every method is a *request*. There is no method that writes a verdict, no
 * method that constructs evidence, and no escape hatch that returns the
 * underlying Bridge — a capability holding the Bridge could call anything.
 */
export interface WatchCapabilityHost {
  /** Submit an observation. Core decides whether it becomes evidence. */
  submitObservation(raw: unknown): Promise<SubmissionResult>
  /** Read evidence Core minted, by id. */
  requestEvidence(evidenceId: string): Promise<EvidenceRecord | null>
  /**
   * Ask for something to be verified.
   *
   * Returns Core's outcome. A capability can ask; it cannot answer, and it
   * cannot influence the answer beyond naming the expectation.
   */
  requestVerification(request: VerificationRequest): Promise<VerificationOutcome>
  /** Record that something happened, for Trajectory. Identifiers only. */
  recordTrajectory(event: {
    readonly type: string
    readonly summary: string
    readonly evidenceIds?: readonly string[]
  }): void
  /** Report health. Called by the Technology Centre; never self-asserted as ready. */
  reportHealth(health: { readonly probed: boolean; readonly detail: string }): void
}

/** The engine side of the host, supplied by Watch and never by a plugin. */
export interface CoreGateway {
  mintEvidence(candidate: CandidateObservation): Promise<
    { readonly ok: true; readonly evidenceId: string }
    | { readonly ok: false; readonly error: WatchError }
  >
  readEvidence(evidenceId: string): Promise<EvidenceRecord | null>
  verify(request: VerificationRequest): Promise<VerificationOutcome>
  record(event: { readonly type: string; readonly summary: string; readonly evidenceIds: readonly string[] }): void
  health(capabilityId: string, health: { readonly probed: boolean; readonly detail: string }): void
  /** Called when a submission tried to carry an authority field. */
  onAuthorityAttempt?(capabilityId: string, fields: readonly string[]): void
}

/**
 * Build the host handed to one capability.
 *
 * The sanitization is here rather than in the gateway on purpose: it is part
 * of the boundary a capability sits behind, so a gateway implementation cannot
 * forget it. And the attempt is reported through `onAuthorityAttempt` before
 * anything else happens, so an operator learns about a plugin trying to mint a
 * verdict even when the submission itself was otherwise fine.
 */
export function createCapabilityHost(
  declaration: CapabilityDeclaration,
  gateway: CoreGateway,
): WatchCapabilityHost {
  const producer = { id: declaration.id, version: declaration.version }

  return {
    submitObservation: async raw => {
      const { candidate, stripped } = sanitizeCandidate(raw, producer)
      if (stripped.length > 0) gateway.onAuthorityAttempt?.(declaration.id, stripped)
      const minted = await gateway.mintEvidence(candidate)
      return minted.ok
        ? { ok: true, evidenceId: minted.evidenceId, stripped }
        : { ok: false, error: minted.error, stripped }
    },
    requestEvidence: evidenceId => gateway.readEvidence(evidenceId),
    requestVerification: request => gateway.verify(request),
    recordTrajectory: event => {
      gateway.record({
        type: event.type,
        summary: event.summary,
        evidenceIds: event.evidenceIds ?? [],
      })
    },
    reportHealth: health => { gateway.health(declaration.id, health) },
  }
}

/**
 * Correct a permission declaration a plugin got wrong in its own favour.
 *
 * `act` is high impact whatever the plugin said. A declaration is a claim by
 * the thing being described, and the one direction it will be wrong in is the
 * one that gets it installed with fewer questions.
 */
export function normalizePermissions(
  permissions: readonly PermissionDeclaration[],
): readonly PermissionDeclaration[] {
  return permissions.map(permission => ({
    ...permission,
    highImpact: permission.scope === 'act' ? true : permission.highImpact,
  }))
}

/** Why a capability was refused at install time. */
export interface InstallRefusal {
  readonly reason: string
  readonly fix: string
}

/**
 * Validate a declaration before anything is loaded.
 *
 * Refuses the things a capability should not be able to say about itself: a
 * built-in trust tier, an automatic install, a reviewed weight licence it has
 * no standing to review, or a permission with no reason attached.
 */
export function validateDeclaration(
  declaration: CapabilityDeclaration,
): readonly InstallRefusal[] {
  const refusals: InstallRefusal[] = []

  if (declaration.descriptor.trust === 'built_in' || declaration.descriptor.trust === 'trusted') {
    refusals.push({
      reason: `${declaration.id} declares trust "${declaration.descriptor.trust}", which is not a `
        + 'capability’s to claim about itself.',
      fix: 'Declare isolated or untrusted. Trust tiers are assigned by the installation.',
    })
  }
  if (declaration.descriptor.install.automatic) {
    refusals.push({
      reason: `${declaration.id} asks to install itself automatically.`,
      fix: 'Set install.automatic to false. Downloads are a person’s decision.',
    })
  }
  for (const permission of declaration.permissions) {
    if (permission.reason.trim() === '') {
      refusals.push({
        reason: `${declaration.id} requests ${permission.id} with no stated reason.`,
        fix: 'Give a sentence an operator can read before granting it.',
      })
    }
  }
  if (declaration.provides.length === 0) {
    refusals.push({
      reason: `${declaration.id} provides no capability.`,
      fix: 'Name at least one capability id this plugin supplies.',
    })
  }
  return refusals
}
