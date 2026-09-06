/**
 * What a memory is, and the rules that govern it.
 *
 * This module is pure: no storage, no Cordis, no Node. Everything here is a
 * type or a decision function, so the rules that decide what an agent may
 * remember about someone can be read and tested on their own — which is the
 * only way they stay honest as the surrounding code grows.
 *
 * The governing decisions are ADR-006 (the ledger is the authority),
 * ADR-007 (`taste.md` is a projection, not a prompt) and ADR-008 (learning is
 * proposed, never self-promoted).
 *
 * @module @deepwatch/dsh-memory/records
 */

// ── identity ────────────────────────────────────────────────────────────────

/** What kind of thing is being remembered. */
export type MemoryKind =
  /** How this person likes to work. */
  | 'preference'
  /** Something asserted about the world. */
  | 'fact'
  /** Something that happened, and what came of it. */
  | 'episode'
  /** A choice that was made, and why. */
  | 'decision'
  /** A correction or working rule learned from an outcome. */
  | 'lesson'
  /** A sequence of steps that proved itself. */
  | 'procedure'
  /** An attempt that failed, kept so it is not repeated. */
  | 'failure'

/**
 * How far a memory reaches.
 *
 * The narrowest scope that fits is always the right one. "Write in Egyptian
 * Arabic" may be a personal preference; "use TypeScript here" is about one
 * project and has no business travelling to a Python one.
 */
export type MemoryScope = 'user' | 'workspace' | 'project' | 'session' | 'agent'

/**
 * Where a memory came from.
 *
 * `explicit_user` is the strongest origin and the most restricted: it can only
 * be produced by an authenticated action the person actually took. Content
 * that arrived from a page, a file or an import can never mint one, because
 * that is exactly how a document would write its own instructions into
 * someone's profile.
 */
export type MemoryOrigin = 'explicit_user' | 'observed' | 'inferred' | 'imported' | 'system'

/** Where a memory is in its life. */
export type MemoryStatus =
  /** Suggested, not yet acting on anything. */
  | 'proposed'
  /** In force. */
  | 'active'
  /** Contradicted, and not injected while it stays that way. */
  | 'disputed'
  /** Replaced by something newer. */
  | 'superseded'
  /** Past its validity window. */
  | 'expired'
  /** Forgotten. Retained only as a tombstone. */
  | 'deleted'

/** How carefully a memory must be handled. */
export type MemorySensitivity = 'public' | 'private' | 'sensitive' | 'restricted'

/** The durable memory modes a profile can be in. */
export type MemoryMode = 'off' | 'session_only' | 'local_personal' | 'workspace_shared'

/** One thing remembered. */
export interface MemoryRecord {
  readonly memoryId: string
  readonly kind: MemoryKind
  readonly subjectScope: MemoryScope
  /** Which workspace, project or session this belongs to; empty for `user`. */
  readonly scopeId: string
  readonly content: string
  readonly origin: MemoryOrigin
  /** Where this came from — a message, a file, an import. */
  readonly sourceRefs: readonly string[]
  /** Evidence ids, when a memory is anchored to something observed. */
  readonly evidenceRefs: readonly string[]
  readonly confidence: number
  readonly status: MemoryStatus
  readonly sensitivity: MemorySensitivity
  readonly validFrom: string
  readonly validUntil: string | null
  readonly createdAt: string
  readonly updatedAt: string
  /** When a person last affirmed it. Null if they never have. */
  readonly lastConfirmedAt: string | null
  readonly supersedes: readonly string[]
  readonly contradictedBy: readonly string[]
  /** BCP-47 of the content, so a correction is never stored only in translation. */
  readonly locale: string | null
}

// ── events ──────────────────────────────────────────────────────────────────

/**
 * What can happen to a memory.
 *
 * The ledger of these is the authority; every record above is a fold over
 * them. That is what makes "forget" mean something: the projection is rebuilt
 * from events, so a tombstoned record cannot survive in a stale index.
 */
export type MemoryEventKind =
  | 'candidate.created'
  | 'record.activated'
  | 'record.confirmed'
  | 'record.disputed'
  /** A proposal was declined. Tombstoned, like a forget, and for the same reason. */
  | 'record.rejected'
  | 'record.superseded'
  | 'record.forgotten'
  | 'record.scope_moved'
  | 'user.edited'
  | 'context.injected'
  | 'projection.rebuilt'

/** One entry in the ledger. Append-only; never rewritten. */
export interface MemoryEvent {
  readonly eventId: string
  readonly kind: MemoryEventKind
  readonly memoryId: string
  readonly at: string
  /** Who caused it: a person, the agent, or the system. */
  readonly actor: 'user' | 'agent' | 'system'
  /** The record state this event asserts, for the events that carry one. */
  readonly record: MemoryRecord | null
  /** Free-form detail: a reason, a diff, an inclusion trace. */
  readonly detail: Readonly<Record<string, unknown>>
}

// ── trust ───────────────────────────────────────────────────────────────────

/**
 * How much weight an origin carries when two memories disagree.
 *
 * A person saying something outranks the agent noticing it, which outranks the
 * agent guessing. Imported content sits at the bottom on purpose: a file that
 * says "the user prefers X" is a claim made by a document, not by a person.
 */
const ORIGIN_RANK: Record<MemoryOrigin, number> = {
  explicit_user: 4,
  system: 3,
  observed: 2,
  inferred: 1,
  imported: 0,
}

/** Whether `candidate` should take precedence over `existing`. */
export function outranks(candidate: MemoryRecord, existing: MemoryRecord): boolean {
  const candidateRank = ORIGIN_RANK[candidate.origin]
  const existingRank = ORIGIN_RANK[existing.origin]
  if (candidateRank !== existingRank) return candidateRank > existingRank
  // Same standing: the more recent statement wins. A person who changes their
  // mind should not have to argue with what they said last month.
  return candidate.createdAt > existing.createdAt
}

/**
 * Whether a memory may be injected into a turn's context.
 *
 * Only `active` records are instructions. A proposal has not been agreed to; a
 * disputed or superseded record is history, and injecting it would re-apply
 * something the person already rejected.
 */
export function isInjectable(record: MemoryRecord, now: string): boolean {
  if (record.status !== 'active') return false
  if (record.validUntil !== null && record.validUntil <= now) return false
  return record.validFrom <= now
}

// ── scope ───────────────────────────────────────────────────────────────────

/** The scope a retrieval is running in. */
export interface ScopeContext {
  readonly userId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly sessionId: string
}

/**
 * Whether a record is visible from a scope.
 *
 * Deny by default, and never widen: a project memory is visible inside that
 * project and nowhere else, and a workspace memory does not reach a different
 * workspace even for the same person. The one direction that broadens is
 * `user`, which is the point of a personal preference.
 *
 * This function is the single place cross-scope leakage could be introduced,
 * which is why it is small enough to read in one go.
 */
export function isInScope(record: MemoryRecord, scope: ScopeContext): boolean {
  switch (record.subjectScope) {
    case 'user':
      return record.scopeId === scope.userId
    case 'workspace':
      return record.scopeId === scope.workspaceId
    case 'project':
      return record.scopeId === scope.projectId
    case 'session':
      return record.scopeId === scope.sessionId
    case 'agent':
      // Agent-scoped memory belongs to the deployment, not to a person, and is
      // readable wherever that agent runs.
      return true
  }
}

/** What a memory mode permits. */
export interface ModePolicy {
  /** Whether anything is written to the durable ledger at all. */
  readonly persists: boolean
  /** Whether memory from earlier sessions may be retrieved. */
  readonly recallsAcrossSessions: boolean
  /** Scopes a record may be created in under this mode. */
  readonly allowedScopes: readonly MemoryScope[]
}

/** Resolve what one memory mode allows. */
export function modePolicy(mode: MemoryMode): ModePolicy {
  switch (mode) {
    case 'off':
      // Nothing is written and nothing is recalled. The agent still works; it
      // simply starts each session knowing nothing about the person.
      return { persists: false, recallsAcrossSessions: false, allowedScopes: [] }
    case 'session_only':
      // Written, but never reaches a later session. Useful within a long task
      // without accumulating a profile.
      return { persists: true, recallsAcrossSessions: false, allowedScopes: ['session'] }
    case 'local_personal':
      return {
        persists: true,
        recallsAcrossSessions: true,
        allowedScopes: ['user', 'workspace', 'project', 'session'],
      }
    case 'workspace_shared':
      // Knowledge and decisions are shared; personal taste is not, so `user`
      // scope is deliberately absent from what this mode may write.
      return {
        persists: true,
        recallsAcrossSessions: true,
        allowedScopes: ['workspace', 'project', 'session'],
      }
  }
}

// ── what may be remembered at all ───────────────────────────────────────────

/**
 * Subjects that are never inferred.
 *
 * Matched against the content of an *inferred* candidate. A person may tell
 * the agent anything they like about themselves and it will be remembered as
 * `explicit_user`; what is forbidden is the agent deciding these things about
 * someone from how they write, what they sound like, or what they happen to
 * have on screen.
 */
const PROTECTED_SUBJECTS = [
  // `medical` and `condition` were both missing from the first version, so
  // the plainest phrasing of a health claim — "has a medical condition" —
  // passed the guard entirely; a wiki-import test found it. The direction to
  // err in here is refusal: a false positive costs an inferred memory that a
  // person can still state themselves, and a false negative lets an agent
  // conclude something about someone's health.
  /\b(health|ill|unwell|sick|illness|disease|medical\w*|clinical|disorder|symptom\w*|diagnos\w*|disabilit\w*|disabled|medication|therapy|pregnan\w*|depress\w*|anxiet\w*|addict\w*)\b/i,
  /\b(religio\w*|faith|muslim|christian|jewish|hindu|buddhist|atheist)\b/i,
  /\b(politic\w*|left-wing|right-wing|votes? for|party affiliation)\b/i,
  /\b(sexual orientation|gay|lesbian|bisexual|transgender)\b/i,
  /\b(ethnicit\w*|race|racial|nationality|immigration status)\b/i,
  /\b(biometric|face print|voice print|fingerprint)\b/i,
  /\b(union member|criminal record|convicted)\b/i,
]

/** Why a candidate was refused, or null when it may be stored. */
export type RefusalReason =
  | 'protected_subject_inference'
  | 'origin_not_authenticatable'
  | 'scope_not_allowed_by_mode'
  | 'memory_disabled'

/** The outcome of checking whether a candidate may be stored. */
export interface AdmissionDecision {
  readonly admitted: boolean
  readonly reason: RefusalReason | null
  /** A sentence naming what would make it acceptable. Empty when admitted. */
  readonly explanation: string
}

const ADMITTED: AdmissionDecision = Object.freeze({
  admitted: true,
  reason: null,
  explanation: '',
})

/**
 * Whether a candidate memory may be stored at all.
 *
 * Runs before anything reaches the ledger, because the ledger is append-only:
 * a record that should never have existed cannot be un-appended, only
 * tombstoned, and a tombstone still says it once existed.
 */
export function admit(
  candidate: MemoryRecord,
  mode: MemoryMode,
  options: { readonly userAuthenticated: boolean } = { userAuthenticated: false },
): AdmissionDecision {
  const policy = modePolicy(mode)

  if (!policy.persists) {
    return {
      admitted: false,
      reason: 'memory_disabled',
      explanation: 'Durable memory is off for this profile. Enable it in Settings → Memory.',
    }
  }

  if (candidate.origin === 'explicit_user' && !options.userAuthenticated) {
    // The one origin that outranks everything else can only come from an
    // action a person actually took. Without this, any imported document could
    // write its own claims into a profile at the highest trust level.
    return {
      admitted: false,
      reason: 'origin_not_authenticatable',
      explanation:
        'Only an action the person took can create an explicit memory. '
        + 'Store this as observed or inferred, or ask them to confirm it.',
    }
  }

  // Every origin except an authenticated person stating it themselves. The
  // first version checked `inferred` only, which left the arrival path that
  // actually matters wide open: a protected-subject claim read off a page or
  // heard in a transcript arrives as `observed`, not as `inferred`, and an
  // imported file arrives as `imported`. A security test found it by aiming
  // the same corpus at every door rather than at the one it was written for.
  if (candidate.origin !== 'explicit_user' && isProtectedSubject(candidate.content)) {
    return {
      admitted: false,
      reason: 'protected_subject_inference',
      explanation:
        'This is not something to conclude about someone from how they write or what they '
        + 'have on screen. If they state it themselves, it can be stored as explicit.',
    }
  }

  if (!policy.allowedScopes.includes(candidate.subjectScope)) {
    return {
      admitted: false,
      reason: 'scope_not_allowed_by_mode',
      explanation:
        `A ${candidate.subjectScope}-scoped memory cannot be created in ${mode} mode. `
        + `Allowed here: ${policy.allowedScopes.length === 0 ? 'none' : policy.allowedScopes.join(', ')}.`,
    }
  }

  return ADMITTED
}

/** Whether content is about something that must never be inferred. */
export function isProtectedSubject(content: string): boolean {
  return PROTECTED_SUBJECTS.some(pattern => pattern.test(content))
}

// ── activation ──────────────────────────────────────────────────────────────

/**
 * Changes a memory must never make on its own, whatever its confidence.
 *
 * A memory is a statement about preferences and knowledge. It is not a grant
 * of authority, and confidence is not consent — a record at 0.99 that says
 * "always approve uploads" is still a preference someone has to agree to.
 */
/**
 * Actions that are irreversible, spend money, or move data off the machine.
 *
 * Matched independently of word order and of inflection. An earlier version
 * used sequential patterns — verb, then qualifier — and a test caught that
 * "always allow sending data to external services" slipped through both: the
 * qualifier came first, and `\bsend\b` does not match "sending". A check whose
 * coverage depends on how a sentence happens to be arranged is not a check.
 */
const HIGH_IMPACT_ACTIONS =
  /\b(upload|send|transmit|share|publish|post|export|sync)\w*\b/i

/** Destinations that mean data leaves the machine. */
const EGRESS_TARGETS = /\b(cloud|remote|external|internet|server|api|third[- ]party)\w*\b/i

/** Actions that are irreversible or spend money, wherever they appear. */
const ALWAYS_HIGH_IMPACT = [
  /\b(delete|remove|drop|purge|wipe|destroy|erase)\w*\b/i,
  /\b(pay|purchase|buy|transfer|charge|invoice|subscribe|refund)\w*\b/i,
  // `token` has to be qualified. Unqualified, it matched "a one-token
  // budget" — and in a product where context tokens are discussed constantly,
  // a rule that fires on every mention of them stops being read at all. The
  // cost of a check nobody trusts is higher than the cost of naming the
  // credential kinds explicitly.
  /\b(credential|api[- ]?keys?|passwords?|passphrase|private[- ]key)\w*\b/i,
  /\b(access|auth|authorization|bearer|refresh|session|secret|personal[- ]access)[- ]tokens?\b/i,
  /\b(secrets?|api[- ]?secret)\b/i,
]

/** Words that turn a permission into a standing one. */
const STANDING_PERMISSION =
  /\b(automatic\w*|always|never ask|without ask\w*|silently|by default|no confirmation)\b/i

/** Words that grant. */
const GRANT = /\b(approve|allow|permit|authoriz\w*|grant|enable|consent)\w*\b/i

/** Weakening a safeguard, in either order. */
const WEAKEN = /\b(disable|bypass|skip|turn off|ignore|suppress|opt out)\w*\b/i
const SAFEGUARD = /\b(check|verification|verify|approval|security|guard|review|confirm\w*)\b/i

/**
 * Whether a memory would change something a person must decide themselves.
 *
 * Errs toward proposing. A false positive costs one confirmation click; a false
 * negative means a preference silently authorized something irreversible.
 */
export function isHighImpact(content: string): boolean {
  if (ALWAYS_HIGH_IMPACT.some(pattern => pattern.test(content))) return true
  // Moving data off the machine, however the sentence is arranged.
  if (HIGH_IMPACT_ACTIONS.test(content) && EGRESS_TARGETS.test(content)) return true
  // A standing grant: "always approve", "approve automatically", either way.
  if (GRANT.test(content) && STANDING_PERMISSION.test(content)) return true
  // Turning a safeguard off.
  if (WEAKEN.test(content) && SAFEGUARD.test(content)) return true
  return false
}

/** What should happen to a candidate that was admitted. */
export type ActivationDecision =
  /** Acts immediately. */
  | { readonly action: 'activate' }
  /** Recorded, and shown, but not acting until someone agrees. */
  | { readonly action: 'propose'; readonly reason: string }

/**
 * Whether an admitted candidate may start acting immediately.
 *
 * The asymmetry is deliberate. Getting a low-risk preference wrong costs a
 * slightly worse answer that the person can correct. Getting a high-impact one
 * wrong costs something that cannot be taken back, so those always wait for a
 * person — including when the person appeared to ask for it, because "always
 * approve uploads" is exactly the sentence someone would want to see before it
 * takes effect.
 */
export function activationFor(
  candidate: MemoryRecord,
  options: { readonly inferredThreshold?: number } = {},
): ActivationDecision {
  if (isHighImpact(candidate.content)) {
    return {
      action: 'propose',
      reason:
        'This would change what happens without asking. It needs an explicit approval, '
        + 'not a confidence score.',
    }
  }

  if (candidate.origin === 'explicit_user') return { action: 'activate' }

  if (candidate.origin === 'imported') {
    // Imported content is a claim by a document. It is worth keeping and worth
    // showing, but it has not been agreed to by anyone.
    return {
      action: 'propose',
      reason: 'Imported content is a claim by its source, not by the person.',
    }
  }

  const threshold = options.inferredThreshold ?? 0.8
  if (candidate.confidence >= threshold) return { action: 'activate' }
  return {
    action: 'propose',
    reason: `Confidence ${candidate.confidence.toFixed(2)} is below the ${threshold.toFixed(2)} threshold.`,
  }
}

// ── correction ──────────────────────────────────────────────────────────────

/**
 * Which existing records a correction should supersede.
 *
 * Scoped to the same subject scope on purpose: correcting how the agent writes
 * in one project should not silently rewrite the preference for every other
 * one. A person who wants that says so, and gets a `user`-scoped record.
 */
export function supersededBy(
  correction: MemoryRecord,
  existing: readonly MemoryRecord[],
): readonly MemoryRecord[] {
  return existing.filter(record =>
    record.memoryId !== correction.memoryId
    && record.kind === correction.kind
    && record.subjectScope === correction.subjectScope
    && record.scopeId === correction.scopeId
    && (record.status === 'active' || record.status === 'proposed')
    && outranks(correction, record))
}
