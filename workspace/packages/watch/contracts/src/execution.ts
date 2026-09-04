/**
 * What one tool call did, recorded because it happened rather than because the
 * model mentioned it.
 *
 * **Why this exists.** An owner evaluation ran 47 model rounds and 76 tool
 * calls — 30 shell, 30 reads, 5 writes, 4 greps, 3 subagents — and Watch
 * recorded none of them. Not because the recording failed: because nothing was
 * listening. Watch's tools were tools the model could choose to call, so a
 * model that never thought about Watch left a product whose entire subject is
 * evidence with an empty ledger, a Library reporting `Index is behind the
 * store`, and a Compare with nothing to compare. The agent wrote its own
 * `verification.json`, reread it with a second generic tool, and reported PASS.
 *
 * The fix is not a better prompt. A capability that depends on the model
 * remembering it exists is not a capability, it is a suggestion. These records
 * are minted from the Harness's own tool-dispatch lifecycle, so a call is
 * recorded whether or not anything in the conversation has ever heard of Watch.
 *
 * **What a record is not.** It is not a verdict. `state: 'completed'` means the
 * dispatch returned; it says nothing about whether the thing the caller wanted
 * is true. Every record starts `UNVERIFIED` and only a verification contract
 * evaluated against evidence may move it — never a tool's own exit code, and
 * never a file the model wrote claiming success. That separation is the reason
 * {@link AgentExecutionState} and {@link Verdict} are two types in this package
 * and not one.
 *
 * @module @deepwatch/dsh-contracts/execution
 */

import type { AgentExecutionState, Verdict } from './index.js'

/**
 * The contract version these records are written under.
 *
 * Read by the Bridge and by the Library indexer: a record from a newer writer
 * is refused rather than half-understood. Bumped when a field's meaning
 * changes, not when one is added with a safe absence.
 */
export const EXECUTION_RECORD_VERSION = 1

/**
 * What a call did to the world, as far as the Host can tell from the boundary.
 *
 * Classified from the tool's declared surface rather than guessed from its
 * name, and `unknown` is a real answer: a tool this distribution has never
 * seen is not assumed harmless. Verification treats `unknown` as unproved
 * rather than as `none`, so a classification gap fails closed.
 */
export type SideEffectClass =
  /** Observed state without changing it. */
  | 'read'
  /** Changed durable state. */
  | 'write'
  /** Ran a process. */
  | 'execute'
  /** Reached beyond this machine. */
  | 'network'
  /** Changed nothing outside the conversation — a todo edit, a plan note. */
  | 'none'
  /** Not classifiable from the boundary. Never treated as `none`. */
  | 'unknown'

/**
 * Where a call's paths resolved, relative to the workspace a person chose.
 *
 * `outside_workspace` is recorded rather than hidden. The evaluation that
 * prompted this work searched other drives, read unrelated locations and wrote
 * under the system temporary directory, and none of it appeared anywhere a
 * person could see. An attempt that was refused is still something the owner
 * is entitled to know happened.
 */
export type WorkspaceScope =
  /** Every affected path resolved inside the selected workspace. */
  | 'inside'
  /** At least one path resolved outside it. Recorded whether or not it ran. */
  | 'outside_workspace'
  /** No workspace is selected, so containment could not be decided. */
  | 'no_workspace'
  /** The call names no path. */
  | 'not_applicable'

/** What the containment gate did about it. */
export type ScopeDecision = 'allowed' | 'denied' | 'approved' | 'not_evaluated'

/**
 * The identity that makes a retry a retry rather than a second action.
 *
 * Four parts, all of them stable across an attempt: the session, the turn, the
 * call the model asked for, and which attempt this is. Two records sharing the
 * first three are attempts at one action; a ledger that keyed on the call alone
 * would show a retried write as two writes, which is the difference between
 * "this happened twice" and "this was tried twice and happened once".
 */
export interface ExecutionIdentity {
  readonly sessionId: string
  /** The agent turn this call belongs to, as the loop numbers it. */
  readonly turnId: string
  /** The model-requested call id. Nested dispatches carry their own. */
  readonly callId: string
  /** 1 for the first attempt. */
  readonly attempt: number
}

/**
 * One tool call, from the boundary that dispatched it.
 *
 * Every field here is either observed at the lifecycle or derived from it. None
 * of it is reported by the tool about itself, and none of it is asserted by the
 * model.
 */
export interface ToolExecutionRecord extends ExecutionIdentity {
  readonly version: number
  /**
   * `<sessionId>/<turnId>/<callId>#<attempt>`, the one spelling.
   *
   * Written by {@link executionKey} so two producers cannot disagree about
   * whether a retry is a duplicate.
   */
  readonly idempotencyKey: string
  /** The root model-requested call, when this is a nested dispatch. */
  readonly rootCallId: string | null
  /**
   * The subagent whose turn this call belongs to, and the parent turn that
   * spawned it. Both null for a call the top-level agent made directly.
   */
  readonly subagentId: string | null
  readonly parentTurnId: string | null
  readonly toolName: string
  readonly state: AgentExecutionState
  readonly startedAt: string
  readonly endedAt: string | null
  readonly durationMs: number | null
  /**
   * How the dispatch ended, in the boundary's own words: `ok`, the tool's
   * failure code, `denied`, or `cancelled`. Not a verdict.
   */
  readonly exitStatus: string | null
  readonly sideEffect: SideEffectClass
  readonly scope: WorkspaceScope
  readonly scopeDecision: ScopeDecision
  /**
   * Paths the call affected, workspace-relative.
   *
   * Relative because an absolute path carries the operating system user's name
   * and the shape of somebody's disk, and neither belongs in a record that is
   * exported, indexed and shown. A path outside the workspace is not recorded
   * as a path at all — {@link WorkspaceScope} says it happened and
   * `outsidePathCount` says how many, which is the fact without the disclosure.
   */
  readonly paths: readonly string[]
  readonly outsidePathCount: number
  /** The arguments, redacted and bounded. Never the raw argument object. */
  readonly inputSummary: string
  /** The result, redacted and bounded. Never the full output. */
  readonly outputSummary: string
  /** `sha256:…` over the full untruncated output, so the summary is checkable. */
  readonly outputDigest: string
  /**
   * The provenance turn that authorised the provider request this call belongs
   * to, correlating a tool action back to the person who asked for it. Null
   * when the call ran outside any authorised turn, which is itself worth
   * seeing.
   */
  readonly authorisedBy: string | null
  /**
   * Always `UNVERIFIED` at mint.
   *
   * A tool that returned is a tool that returned. Only
   * {@link VerificationOutcome} moves this, and only from evidence.
   */
  readonly verification: Verdict
}

/** The one spelling of an execution's identity. */
export function executionKey(identity: ExecutionIdentity): string {
  return `${identity.sessionId}/${identity.turnId}/${identity.callId}#${String(identity.attempt)}`
}

/**
 * Whether two records describe attempts at the same action.
 *
 * The question a ledger asks before it shows a person "this ran twice".
 */
export function isSameAction(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  return a.sessionId === b.sessionId && a.turnId === b.turnId && a.callId === b.callId
}

/**
 * How long the bounded summaries may be.
 *
 * Bounded because the evaluation that prompted this recorded 2.9M tokens of
 * context, and a ledger that stored every shell transcript would be a second
 * copy of it. Long enough to identify what happened, short enough that a
 * thousand records stay readable and indexable.
 */
export const SUMMARY_LIMIT = 512

/**
 * Cut a summary to {@link SUMMARY_LIMIT}, saying so when it was cut.
 *
 * The marker matters: a reader who cannot tell a short output from a truncated
 * one will eventually read a truncation as the whole answer.
 */
export function boundSummary(text: string, limit: number = SUMMARY_LIMIT): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit)}… (${String(collapsed.length)} chars)`
}

/**
 * Patterns whose *value* must never reach a record.
 *
 * Keys, bearer tokens and the assignment forms they arrive in. This is a
 * belt-and-braces pass over text that has already been shaped by the caller: the
 * summaries are built from arguments and results the Host chose to include, and
 * this catches the case where a secret is inside one of them — a shell command
 * line with an inline token, an error quoting an Authorization header.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Provider key shapes: sk-…, sk-ant-…, ghp_…, and friends.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/gu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  // Bearer and Basic credentials wherever they appear.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gu,
  // `KEY=value`, `--token value`, `"apiKey": "value"` and their neighbours.
  /\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)\s*[=:]\s*\S+/giu,
  /--(?:api-?key|token|password|secret)(?:[=\s]+)\S+/giu,
]

/** What a redacted secret is replaced by, so the fact survives the value. */
export const SECRET_PLACEHOLDER = '<redacted>'

/**
 * Remove secret-shaped material from text bound for a record.
 *
 * Deliberately conservative about what it calls a secret and deliberately
 * blunt about what it does with one: the replacement keeps the shape of the
 * line so a reader can still see that a token was passed, without the token.
 *
 * This is not the only defence and must not be treated as one. The Host does
 * not put environment dumps or credential values into summaries in the first
 * place; this is what catches the ones that arrive inside something else.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, SECRET_PLACEHOLDER)
  return out
}

/**
 * Whether a string still looks like it carries a credential.
 *
 * Used by the export gate and by tests, which need to assert absence rather
 * than trust the redactor that produced the text.
 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    // `RegExp` with `g` carries `lastIndex` between calls; a fresh one per test
    // keeps this a pure predicate.
    const probe = new RegExp(pattern.source, pattern.flags.replace('g', ''))
    return probe.test(text)
  })
}
