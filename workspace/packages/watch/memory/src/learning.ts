/**
 * Governed self-learning: the agent may propose, it may not promote.
 *
 * Continuous improvement is a real requirement. Ungoverned self-modification is
 * a failure that is close to undetectable after the fact, because the system
 * that changed is also the system reporting on the change — it will tell you
 * the change was good, in exactly the same voice it used before.
 *
 * So the split is structural rather than advisory. Proposing produces an inert
 * record. Promoting is a separate operation with its own preconditions, and no
 * amount of confidence on the proposal side satisfies any of them.
 *
 * Three refusals do most of the work here.
 *
 * **Some targets are never proposable.** Not "proposable and then refused at
 * promotion" — refused at the moment of proposal, because a queue full of
 * pending changes to the system prompt is itself a problem, and reviewing them
 * one at a time is how one eventually gets through.
 *
 * **Self-approval is not approval.** The proposer cannot be the approver. An
 * agent that could approve its own work would satisfy every rule below while
 * changing whatever it liked.
 *
 * **Safety is not tradeable.** Quality, cost and latency are weighed against
 * each other. A safety regression blocks promotion no matter what improved
 * alongside it, because the alternative is a system that learns its way past
 * its own guardrails one favourable trade at a time.
 *
 * @module @deepwatch/dsh-memory/learning
 */

/**
 * What an agent is allowed to propose.
 *
 * A closed list, and deliberately modest: memory, routing and skills. Learning
 * here means auditable improvement to those. It does not mean training on user
 * data, and automatic fine-tuning is out of scope.
 */
export type CandidateKind =
  /** Something that went wrong once and should not go wrong the same way again. */
  | 'lesson'
  /** "For this kind of task, prefer that engine." */
  | 'routing_rule'
  /** A non-governing template. Never the system prompt. */
  | 'prompt_patch'
  /** A change to a skill's own instructions. */
  | 'skill_patch'
  /** A repeatable sequence worth naming. */
  | 'workflow'
  /** A case for the evaluation set, after redaction. */
  | 'eval_case'

/**
 * Surfaces an agent may never modify on its own, at any confidence.
 *
 * Each one is here because changing it would let the agent change the rules
 * that constrain it. The system prompt governs behavior; verification authority
 * decides what counts as proven; permissions and trust tiers decide what may
 * run; production code and signing keys decide what ships; retention policy
 * decides what is kept about a person.
 */
export const FORBIDDEN_TARGETS = [
  'system_prompt',
  'verification_authority',
  'permission_preset',
  'plugin_trust_tier',
  'production_code',
  'signing_key',
  'retention_policy',
] as const

export type ForbiddenTarget = (typeof FORBIDDEN_TARGETS)[number]

/** Where a candidate would take effect. */
export interface CandidateTarget {
  /** A stable surface identifier, e.g. `skill:watch-verify` or `routing:ocr`. */
  readonly surface: string
  /** The specific thing within it, when the change is narrower than the surface. */
  readonly path: string | null
}

/** How far along the promotion pipeline a candidate is. */
export type PromotionStage =
  /** Recorded, inert, changing nothing. */
  | 'proposed'
  /** Replaying against approved fixtures. */
  | 'evaluating'
  /** Replay finished; the numbers exist. */
  | 'evaluated'
  /** A human or a signed policy said yes. */
  | 'approved'
  /** Live for a fraction of traffic. */
  | 'canary'
  /** Live. */
  | 'active'
  /** Was live, has been withdrawn. */
  | 'rolled_back'
  /** Will not be promoted. */
  | 'rejected'

/** A proposed change, before anything has happened to it. */
export interface LearningCandidate {
  readonly candidateId: string
  readonly kind: CandidateKind
  readonly target: CandidateTarget
  /** The agent or subagent that proposed it. Never the approver. */
  readonly proposedBy: string
  readonly proposedAt: string
  /** What the change actually is. */
  readonly content: string
  /** Why the agent thinks so. Read by a reviewer; never a substitute for one. */
  readonly rationale: string
  /** Observations this was drawn from, so a reviewer can go look. */
  readonly evidenceIds: readonly string[]
  readonly stage: PromotionStage
}

/** Why a proposal was refused. */
export type ProposalRefusal =
  | 'forbidden_target'
  | 'unknown_kind'
  | 'empty_content'
  | 'no_evidence'
  | 'prompt_patch_would_govern'

/** The outcome of proposing. Either a candidate exists or it does not. */
export type ProposalResult =
  | { readonly accepted: true; readonly candidate: LearningCandidate }
  | { readonly accepted: false; readonly reason: ProposalRefusal; readonly detail: string }

/** Whether a surface is one nothing may propose against. */
export function isForbiddenTarget(surface: string): boolean {
  const normalized = surface.toLowerCase()
  return FORBIDDEN_TARGETS.some(
    forbidden => normalized === forbidden || normalized.startsWith(`${forbidden}:`),
  )
}

/**
 * Whether a prompt patch would touch governing text.
 *
 * `prompt_patch` is allowed for non-governing templates — a summary format, a
 * report layout. That distinction is the only reason the kind is permitted at
 * all, so it is checked rather than trusted: a patch that files itself under a
 * template surface while editing the instructions that constrain the agent is
 * the exact evasion this exists for.
 */
function wouldGovern(target: CandidateTarget, content: string): boolean {
  if (/^(system|policy|governance|guardrail)/i.test(target.surface)) return true
  return /\b(ignore|override|disregard|bypass)\b[\s\S]{0,60}\b(instruction|rule|policy|constraint|guardrail|safeguard)/i
    .test(content)
}

const KINDS = new Set<string>([
  'lesson', 'routing_rule', 'prompt_patch', 'skill_patch', 'workflow', 'eval_case',
])

/**
 * Propose a change.
 *
 * Returns an inert record on success. Nothing about a successful proposal
 * changes behavior — that is the point of the operation.
 */
export function propose(input: {
  readonly candidateId: string
  readonly kind: string
  readonly target: CandidateTarget
  readonly proposedBy: string
  readonly proposedAt: string
  readonly content: string
  readonly rationale: string
  readonly evidenceIds: readonly string[]
}): ProposalResult {
  if (!KINDS.has(input.kind)) {
    return {
      accepted: false,
      reason: 'unknown_kind',
      detail: `${input.kind} is not a candidate kind an agent may propose`,
    }
  }
  if (isForbiddenTarget(input.target.surface)) {
    return {
      accepted: false,
      reason: 'forbidden_target',
      detail:
        `${input.target.surface} governs what the agent may do, so it cannot be `
        + 'changed by the agent. A person edits it directly.',
    }
  }
  if (input.content.trim() === '') {
    return { accepted: false, reason: 'empty_content', detail: 'a candidate with no change' }
  }
  if (input.evidenceIds.length === 0) {
    return {
      accepted: false,
      reason: 'no_evidence',
      detail:
        'a candidate names the observations it was drawn from, so a reviewer can '
        + 'check the reasoning rather than the conclusion',
    }
  }
  if (input.kind === 'prompt_patch' && wouldGovern(input.target, input.content)) {
    return {
      accepted: false,
      reason: 'prompt_patch_would_govern',
      detail: 'prompt_patch covers non-governing templates only',
    }
  }

  return {
    accepted: true,
    candidate: {
      candidateId: input.candidateId,
      kind: input.kind as CandidateKind,
      target: input.target,
      proposedBy: input.proposedBy,
      proposedAt: input.proposedAt,
      content: input.content,
      rationale: input.rationale,
      evidenceIds: [...input.evidenceIds],
      stage: 'proposed',
    },
  }
}

/** One measured axis, before and after. */
export interface MetricDelta {
  readonly before: number
  readonly after: number
}

/** What replaying a candidate against approved fixtures produced. */
export interface CandidateEvaluation {
  readonly candidateId: string
  /** The fixture set it was replayed on, by digest, so a claim is checkable. */
  readonly fixtureSetDigest: string
  readonly casesRun: number
  /** Higher is better. */
  readonly quality: MetricDelta
  /** Lower is better. */
  readonly cost: MetricDelta
  /** Lower is better. */
  readonly latencyMs: MetricDelta
  /**
   * Safety violations observed during replay. Lower is better, and unlike the
   * others this one is not tradeable.
   */
  readonly safetyViolations: MetricDelta
  readonly evaluatedAt: string
}

/** An approval, by someone who is not the proposer. */
export interface Approval {
  readonly approvedBy: string
  readonly approvedAt: string
  /** A signed policy may approve in place of a person; the id is recorded. */
  readonly policyId: string | null
}

/** Why a promotion was refused. */
export type PromotionRefusal =
  | 'not_evaluated'
  | 'no_cases_run'
  | 'safety_regressed'
  | 'quality_regressed'
  | 'not_approved'
  | 'self_approved'
  | 'wrong_stage'

export type PromotionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: PromotionRefusal; readonly detail: string }

/**
 * Whether a candidate may be promoted.
 *
 * Every clause is a separate refusal with its own reason, rather than one
 * boolean, because "promotion refused" is not an answer anybody can act on.
 */
export function canPromote(
  candidate: LearningCandidate,
  evaluation: CandidateEvaluation | null,
  approval: Approval | null,
): PromotionDecision {
  if (candidate.stage !== 'evaluated' && candidate.stage !== 'approved') {
    return {
      allowed: false,
      reason: 'wrong_stage',
      detail: `a candidate at ${candidate.stage} has not been through evaluation`,
    }
  }
  if (evaluation === null) {
    return {
      allowed: false,
      reason: 'not_evaluated',
      detail: 'nothing was replayed, so there is nothing to compare against',
    }
  }
  if (evaluation.casesRun === 0) {
    return {
      allowed: false,
      reason: 'no_cases_run',
      detail:
        'an evaluation over zero cases reports no regressions because it measured nothing',
    }
  }
  if (evaluation.safetyViolations.after > evaluation.safetyViolations.before) {
    return {
      allowed: false,
      reason: 'safety_regressed',
      detail:
        `safety violations rose ${String(evaluation.safetyViolations.before)} → `
        + `${String(evaluation.safetyViolations.after)}; no improvement elsewhere offsets this`,
    }
  }
  if (evaluation.quality.after < evaluation.quality.before) {
    return {
      allowed: false,
      reason: 'quality_regressed',
      detail: `quality fell ${String(evaluation.quality.before)} → ${String(evaluation.quality.after)}`,
    }
  }
  if (approval === null) {
    return {
      allowed: false,
      reason: 'not_approved',
      detail: 'a reviewer or a signed policy has to say yes',
    }
  }
  if (approval.policyId === null && approval.approvedBy === candidate.proposedBy) {
    return {
      allowed: false,
      reason: 'self_approved',
      detail: `${candidate.proposedBy} proposed this and cannot also approve it`,
    }
  }
  return { allowed: true }
}

/** A promoted candidate, live or on its way there. */
export interface Activation {
  readonly candidateId: string
  /** Monotonic per target, so "roll back to the previous one" is unambiguous. */
  readonly version: number
  readonly target: CandidateTarget
  readonly activatedAt: string
  readonly approvedBy: string
  /** The version this replaced, or null for the first. */
  readonly supersedes: number | null
  /** Fraction of traffic, 0..1. Below 1 this is a canary. */
  readonly trafficShare: number
  readonly evaluationDigest: string
}

/**
 * Promote an evaluated, approved candidate.
 *
 * Throws rather than returning a failure: reaching this with a candidate
 * `canPromote` would refuse means a caller skipped the check, and returning a
 * value there would let the skip go unnoticed.
 */
export function promote(
  candidate: LearningCandidate,
  evaluation: CandidateEvaluation,
  approval: Approval,
  options: { readonly previousVersion: number | null; readonly trafficShare?: number },
): Activation {
  const decision = canPromote({ ...candidate, stage: 'approved' }, evaluation, approval)
  if (!decision.allowed) {
    throw new Error(`watch: refusing to promote ${candidate.candidateId}: ${decision.detail}`)
  }
  const share = options.trafficShare ?? 1
  return {
    candidateId: candidate.candidateId,
    version: (options.previousVersion ?? 0) + 1,
    target: candidate.target,
    activatedAt: approval.approvedAt,
    approvedBy: approval.policyId ?? approval.approvedBy,
    supersedes: options.previousVersion,
    trafficShare: Math.min(1, Math.max(0, share)),
    evaluationDigest: evaluation.fixtureSetDigest,
  }
}

/** Whether an activation is still a canary rather than fully live. */
export function isCanary(activation: Activation): boolean {
  return activation.trafficShare < 1
}

/**
 * Withdraw an activation.
 *
 * Returns what is live afterwards: the version this superseded, or null when it
 * was the first and withdrawing it leaves the target as it was originally. A
 * promotion that cannot be undone is not governed, so this is part of the
 * contract rather than an operational afterthought.
 */
export function rollback(activation: Activation): { readonly liveVersion: number | null } {
  return { liveVersion: activation.supersedes }
}

/** A one-line summary of what a candidate would do, for a review queue. */
export function describeCandidate(candidate: LearningCandidate): string {
  const where = candidate.target.path === null
    ? candidate.target.surface
    : `${candidate.target.surface}/${candidate.target.path}`
  return `${candidate.kind} → ${where} (${candidate.stage}, proposed by ${candidate.proposedBy})`
}
