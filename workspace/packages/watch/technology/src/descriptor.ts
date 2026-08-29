/**
 * Technology descriptors, and the lifecycle that keeps them honest.
 *
 * The distinction this module exists to hold: **not everything intelligent is
 * a provider.** DSH's Models and Providers surface is excellent for chat
 * endpoints with credentials and a model catalog, and Watch keeps it. But an
 * OCR binary, a Whisper worker, a Playwright runtime and a camera are not
 * chat endpoints, and forcing them into that shape means inventing fields that
 * do not apply and hiding fields that do — like which GPU is needed, or
 * whether the thing has ever actually run here.
 *
 * So there are five things, not one:
 *
 * | Term | What it is |
 * |---|---|
 * | Provider Connection | a service, with a protocol and a credential reference |
 * | Engine Runtime | a local executable, model or worker |
 * | Adapter | what binds either to a Watch contract |
 * | Capability | the thing that can be consumed |
 * | Role Binding | which implementation serves a given use |
 *
 * The rule that runs through all of it: **presence is not readiness.** A model
 * directory on disk, a binary on PATH, a name in a catalog — none of those
 * mean a real request has succeeded here, and the lifecycle keeps the
 * difference visible instead of collapsing it into "installed".
 *
 * @module @watchskill/dsh-technology/descriptor
 */

/** What kind of thing a descriptor describes. */
export type TechnologyKind = 'provider' | 'engine' | 'adapter'

/** Where it runs. */
export type TechnologyRuntime =
  /** Somebody else's service, over the network. */
  | 'remote'
  /** A process this machine starts. */
  | 'local_process'
  /** A library loaded in-process. */
  | 'local_library'
  /** Inside the browser. */
  | 'browser'
  /** Hardware attached to this machine. */
  | 'device'

/**
 * The capability families a technology can serve.
 *
 * Deliberately not one flat list of models: an engine that reads documents and
 * an engine that transcribes speech fail in different ways, need different
 * hardware, and are qualified against different fixtures.
 */
export type CapabilityFamily =
  | 'visual'
  | 'document_ocr'
  | 'speech'
  | 'audio'
  | 'browser_gui'
  | 'retrieval'
  | 'verification'
  | 'capture'
  | 'agent'

/**
 * The roles a technology can be bound to.
 *
 * These are what a user actually chooses between. A single provider connection
 * may serve several; a local Whisper worker serves exactly one.
 */
export type RoleId =
  | 'agent_model'
  | 'visual_perception'
  | 'verifier'
  | 'asr'
  | 'audio_understanding'
  | 'speaker_diarization'
  | 'embeddings'
  | 'reranking'
  | 'ocr_layout'

/** Every role, for enumeration in settings and in tests. */
export const ROLES: readonly RoleId[] = [
  'agent_model',
  'visual_perception',
  'verifier',
  'asr',
  'audio_understanding',
  'speaker_diarization',
  'embeddings',
  'reranking',
  'ocr_layout',
]

/**
 * Where a technology is in its life.
 *
 * The states between `installed` and `ready` are the point. Collapsing them —
 * treating a present binary as a working one — is how a product ends up
 * offering a button that fails.
 */
export type TechnologyState =
  /** Known to exist, nothing checked. */
  | 'discovered'
  /** Not on this machine. */
  | 'not_installed'
  | 'installing'
  /** On disk. Says nothing about whether it works. */
  | 'installed'
  /** A cheap check passed: a version query, a resolved path. */
  | 'probed'
  /** A real operation ran here and succeeded. */
  | 'machine_tested'
  /** Usable, and known to be. */
  | 'ready'
  /** Works, but not fully. */
  | 'degraded'
  /** Cannot work here, with a reason. */
  | 'unavailable'
  /** Wrong version for this build. */
  | 'incompatible'
  /** Turned off by the user or by policy. */
  | 'disabled'

/** States from which a technology may actually be used. */
const USABLE_STATES = new Set<TechnologyState>(['ready', 'degraded'])

/**
 * Whether a technology may be offered to a user right now.
 *
 * `probed` and `installed` are deliberately excluded. A resolved binary is a
 * resolved binary; it is not evidence that this capability works, and a
 * surface that treats it as one will eventually offer something that fails.
 */
export function isUsable(state: TechnologyState): boolean {
  return USABLE_STATES.has(state)
}

/** What a technology needs from the machine. */
export interface HardwareRequirement {
  /** Whether it needs a GPU at all. */
  readonly gpu: 'none' | 'optional' | 'required'
  readonly minVramGb: number | null
  readonly minRamGb: number | null
  /** Named accelerators, e.g. `cuda`, `metal`. */
  readonly accelerators: readonly string[]
}

/** What a technology does with data. */
export interface PrivacyBehavior {
  /** Whether using it sends anything off this machine. */
  readonly egress: 'none' | 'metadata_only' | 'content'
  /** Whether it may run under `offline_only`. */
  readonly worksOffline: boolean
  /**
   * Whether using it requires explicit consent beyond holding a credential.
   *
   * Holding an API key is not consent to upload a frame, and the two are
   * tracked separately for exactly that reason.
   */
  readonly requiresEgressConsent: boolean
}

/** How a technology is obtained. */
export interface InstallStrategy {
  readonly method: 'bundled' | 'package_manager' | 'download' | 'byo' | 'none'
  /** Approximate download size, so a person can decide before it starts. */
  readonly downloadBytes: number | null
  /** Never true without an explicit user action. */
  readonly automatic: false
}

/** Licence and provenance, tracked separately for code and for weights. */
export interface Provenance {
  /** SPDX identifier of the *code*. */
  readonly codeLicense: string
  /**
   * SPDX identifier of the model weights, when there are any.
   *
   * Separate from the code licence on purpose: an MIT repository does not make
   * its published weights MIT, and treating the two as one is how a
   * distribution ships something it had no right to.
   */
  readonly weightsLicense: string | null
  /** The exact revision, so "which version" is never a guess. */
  readonly revision: string | null
  readonly sourceUrl: string | null
  /** Whether the weight licence has actually been reviewed for distribution. */
  readonly weightsLicenseReviewed: boolean
}

/** How much of the machine a technology may take. */
export interface ResourceLimits {
  readonly maxConcurrency: number
  readonly timeoutMs: number
  readonly maxMemoryMb: number | null
}

/** How much a technology is trusted with. */
export type TrustLevel =
  /** Shipped and signed with this product. */
  | 'built_in'
  /** Reviewed, runs in-process. */
  | 'trusted'
  /** Runs in its own process. */
  | 'isolated'
  /** Runs isolated, and is assumed hostile. */
  | 'untrusted'

/** One technology, described completely enough to decide about it. */
export interface TechnologyDescriptor {
  readonly id: string
  readonly displayName: string
  readonly version: string
  readonly kind: TechnologyKind
  readonly capabilities: readonly CapabilityFamily[]
  /** What it can consume: `image`, `audio`, `video`, `text`, `dom`. */
  readonly modalities: readonly string[]
  /** Roles this technology is able to serve. */
  readonly roles: readonly RoleId[]
  readonly runtime: TechnologyRuntime
  /** Protocols it speaks, for a remote technology. */
  readonly protocols: readonly string[]
  readonly endpoints: readonly string[]
  /**
   * A reference to a credential DSH holds — never the credential.
   *
   * Watch stores no keys. There is one credential store and it is DSH's.
   */
  readonly credentialReference: string | null
  readonly hardware: HardwareRequirement
  readonly privacy: PrivacyBehavior
  readonly install: InstallStrategy
  readonly provenance: Provenance
  readonly resources: ResourceLimits
  readonly trust: TrustLevel
  /** How its health is checked, named so a person knows what will run. */
  readonly probeMethod: string | null
  readonly testMethod: string | null
}

/** What a health check found. */
export interface TechnologyHealth {
  readonly technologyId: string
  readonly state: TechnologyState
  /** What was actually detected: versions, paths, device names. */
  readonly detected: Readonly<Record<string, string>>
  readonly missing: readonly string[]
  /** Concrete next steps. Never a bare "setup failed". */
  readonly fixes: readonly string[]
  /** ISO-8601, or null when nothing has ever been checked. */
  readonly lastCheckedAt: string | null
  /** Why it is degraded or unavailable, when it is. */
  readonly reason: string | null
}

/** Health for a technology nobody has looked at yet. */
export function unchecked(technologyId: string): TechnologyHealth {
  return {
    technologyId,
    // Not `not_installed`: nobody looked, and reporting absence we did not
    // establish is the same error as reporting readiness we did not establish.
    state: 'discovered',
    detected: {},
    missing: [],
    fixes: [],
    lastCheckedAt: null,
    reason: null,
  }
}

/**
 * A role bound to an implementation.
 *
 * Deliberately not "a model setting". A role can be served by a remote
 * provider or by a local engine, and the binding records which — along with
 * the policy that governs it, because the same engine may be acceptable for
 * one workspace and not another.
 */
export interface RoleBinding {
  readonly role: RoleId
  readonly technologyId: string
  /** The specific model or endpoint, when the technology offers several. */
  readonly model: string | null
  /** Where this binding applies. */
  readonly scope: 'workspace' | 'project' | 'session'
  readonly scopeId: string
  /** Fall back to this technology when the primary is unavailable. */
  readonly fallbackTechnologyId: string | null
  /**
   * Whether fallback may cross a privacy boundary.
   *
   * False by default and deliberately so: falling back from a local engine to
   * a cloud one because the local one was busy would send data off the machine
   * for a reason nobody agreed to.
   */
  readonly allowEgressFallback: boolean
}

/** Why a binding was refused. */
export type BindingRefusal =
  | 'role_not_supported'
  | 'technology_not_usable'
  | 'offline_policy'
  | 'egress_consent_missing'

/** The outcome of checking a binding. */
export interface BindingDecision {
  readonly allowed: boolean
  readonly reason: BindingRefusal | null
  readonly explanation: string
}

const ALLOWED: BindingDecision = Object.freeze({
  allowed: true,
  reason: null,
  explanation: '',
})

/** The policy a binding is evaluated against. */
export interface EgressPolicy {
  readonly offlineOnly: boolean
  /** Whether the user consented to media leaving this machine. */
  readonly egressConsent: boolean
}

/**
 * Whether a role may be bound to a technology.
 *
 * Checked in order of how badly getting it wrong would go: a capability
 * mismatch is a broken feature, but an egress violation is data leaving a
 * machine without consent, so the privacy checks are the ones that cannot be
 * short-circuited by anything above them.
 */
export function canBind(
  role: RoleId,
  descriptor: TechnologyDescriptor,
  health: TechnologyHealth,
  policy: EgressPolicy,
): BindingDecision {
  if (!descriptor.roles.includes(role)) {
    return {
      allowed: false,
      reason: 'role_not_supported',
      explanation: `${descriptor.displayName} does not serve the ${role} role.`,
    }
  }

  if (!isUsable(health.state)) {
    return {
      allowed: false,
      reason: 'technology_not_usable',
      explanation:
        `${descriptor.displayName} is ${health.state}. `
        + (health.fixes[0] ?? 'Check it in Settings → Technology.'),
    }
  }

  if (policy.offlineOnly && !descriptor.privacy.worksOffline) {
    return {
      allowed: false,
      reason: 'offline_policy',
      explanation:
        `${descriptor.displayName} sends data off this machine, and this profile is offline-only.`,
    }
  }

  if (descriptor.privacy.requiresEgressConsent && !policy.egressConsent) {
    return {
      allowed: false,
      reason: 'egress_consent_missing',
      explanation:
        `${descriptor.displayName} would send content off this machine. `
        + 'Holding a credential for it is not the same as agreeing to that.',
    }
  }

  return ALLOWED
}

/**
 * Whether falling back from one technology to another is permitted.
 *
 * The case worth refusing: a local engine is busy, so the request quietly goes
 * to a cloud one. Nothing failed, nobody was asked, and content left the
 * machine. Fallback across a privacy boundary requires the binding to have
 * said so explicitly.
 */
export function canFallBack(
  from: TechnologyDescriptor,
  to: TechnologyDescriptor,
  binding: RoleBinding,
): BindingDecision {
  const wouldEgress = from.privacy.egress === 'none' && to.privacy.egress !== 'none'
  if (wouldEgress && !binding.allowEgressFallback) {
    return {
      allowed: false,
      reason: 'egress_consent_missing',
      explanation:
        `Falling back from ${from.displayName} to ${to.displayName} would send content off `
        + 'this machine. Enable egress fallback on this binding if that is intended.',
    }
  }
  return ALLOWED
}
