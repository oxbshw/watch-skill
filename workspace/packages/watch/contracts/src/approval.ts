/**
 * An approval covers one action, and only the action it was shown.
 *
 * The failure this module exists to prevent is subtle and completely silent
 * when it happens. A person is shown "click Confirm on the payment page" and
 * approves it. Between the approval and the dispatch, something changes the
 * action — a different target, a different page, an extra field — and the
 * approval, which was for a description rather than for a value, still
 * applies. The receipt then records a properly approved action nobody agreed
 * to, and it looks correct in every audit.
 *
 * So an approval binds to a digest of the exact action, and
 * {@link checkApproval} refuses when the action's digest is not the one that
 * was approved. Not warns, not re-prompts silently — refuses, and says which
 * field moved, because "your approval no longer matches" is a sentence a
 * person can act on and "permission denied" is not.
 *
 * Three other properties come along with it, and each closes a way an approval
 * gets stretched past what it covered:
 *
 * - **It expires.** An approval held open across a long session is an approval
 *   whose context the person no longer remembers.
 * - **It is single-use by default.** A "yes" to one click is not a yes to
 *   every click of that shape.
 * - **It names who gave it.** An approval with no subject cannot be audited,
 *   and an unauditable approval is indistinguishable from an assumed one.
 *
 * @module @deepwatch/dsh-contracts/approval
 */

/** What the person actually agreed to. */
export interface Approval {
  readonly approvalId: string
  /**
   * Digest of the exact action that was shown.
   *
   * The load-bearing field. Everything else is metadata about the agreement;
   * this is the agreement.
   */
  readonly inputDigest: string
  /** A short description of what was shown, for the audit trail and the UI. */
  readonly summary: string
  readonly grantedByUserId: string
  readonly grantedAtMs: number
  readonly expiresAtMs: number
  /**
   * How many times it may be used.
   *
   * One, unless somebody deliberately granted more. A standing approval is a
   * real thing people sometimes want and never the default.
   */
  readonly maxUses: number
  readonly uses: number
  /** Set when the approval was withdrawn before it was used. */
  readonly revokedAtMs: number | null
}

/** An action asking to be dispatched. */
export interface PendingAction {
  readonly operationId: string
  readonly inputDigest: string
  readonly summary: string
  /** Whether this could change something outside Watch. */
  readonly consequential: boolean
}

/** Why an approval did not cover an action. */
export type ApprovalRefusalCode =
  | 'no_approval'
  | 'digest_mismatch'
  | 'expired'
  | 'revoked'
  | 'exhausted'
  | 'wrong_person'

/** The outcome of checking an approval against an action. */
export type ApprovalDecision =
  | { readonly ok: true; readonly approval: Approval }
  | {
    readonly ok: false
    readonly code: ApprovalRefusalCode
    readonly message: string
    readonly fix: string
  }

/** Refuse, with something the person can do about it. */
function refuse(
  code: ApprovalRefusalCode,
  message: string,
  fix: string,
): ApprovalDecision {
  return { ok: false, code, message, fix }
}

/**
 * Whether an approval covers an action.
 *
 * The digest comparison is first and is the whole point. Note that it happens
 * before the expiry check: an action that does not match should say so rather
 * than say "expired", because those two suggest completely different next
 * steps, and telling somebody to approve again when the action changed
 * underneath them is how the change gets approved.
 */
export function checkApproval(
  approval: Approval | null,
  action: PendingAction,
  context: { readonly nowMs: number; readonly actorUserId: string },
): ApprovalDecision {
  if (!action.consequential) {
    // Reading something needs no approval, and requiring one would train
    // people to click through the ones that matter.
    return approval === null
      ? refuse('no_approval', 'No approval was supplied.', 'This action needs none; dispatch it directly.')
      : { ok: true, approval }
  }

  if (approval === null) {
    return refuse(
      'no_approval',
      `"${action.summary}" could change something outside Watch and has no approval.`,
      'Ask the person to approve this specific action.',
    )
  }

  if (approval.inputDigest !== action.inputDigest) {
    return refuse(
      'digest_mismatch',
      `The approval was granted for "${approval.summary}", and this action is `
      + `"${action.summary}". The approval does not cover it.`,
      'Show the person the action as it is now and ask again.',
    )
  }

  if (approval.revokedAtMs !== null) {
    return refuse('revoked', 'That approval was withdrawn.', 'Ask again if it is still wanted.')
  }

  if (approval.expiresAtMs <= context.nowMs) {
    return refuse(
      'expired',
      'That approval has expired.',
      'Ask again, so the person is deciding with the current context.',
    )
  }

  if (approval.uses >= approval.maxUses) {
    return refuse(
      'exhausted',
      `That approval was for ${String(approval.maxUses)} use(s) and has been used `
      + `${String(approval.uses)} time(s).`,
      'Ask again for this action.',
    )
  }

  if (approval.grantedByUserId !== context.actorUserId) {
    return refuse(
      'wrong_person',
      'That approval was granted by somebody else.',
      'Approvals are not transferable. Ask the person acting to approve it themselves.',
    )
  }

  return { ok: true, approval }
}

/** Record that an approval was spent. */
export function consume(approval: Approval): Approval {
  return { ...approval, uses: approval.uses + 1 }
}

/** Withdraw an approval before it is used. */
export function revoke(approval: Approval, atMs: number): Approval {
  return { ...approval, revokedAtMs: atMs }
}

/**
 * How long an approval lasts by default.
 *
 * Two minutes: long enough for a page to load and an action to dispatch, short
 * enough that it cannot survive somebody walking away from the machine.
 */
export const DEFAULT_APPROVAL_TTL_MS = 120_000

/**
 * Grant an approval for exactly one action.
 *
 * Takes the action rather than a description, so an approval cannot be minted
 * for something vaguer than what will be dispatched — which is the other half
 * of the digest rule, and the half that is easy to leave out.
 */
export function grantFor(
  action: PendingAction,
  context: {
    readonly approvalId: string
    readonly grantedByUserId: string
    readonly nowMs: number
    readonly ttlMs?: number
    readonly maxUses?: number
  },
): Approval {
  return {
    approvalId: context.approvalId,
    inputDigest: action.inputDigest,
    summary: action.summary,
    grantedByUserId: context.grantedByUserId,
    grantedAtMs: context.nowMs,
    expiresAtMs: context.nowMs + (context.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
    maxUses: context.maxUses ?? 1,
    uses: 0,
    revokedAtMs: null,
  }
}
