/**
 * What a person is told when a conversation cannot run, and what they are not.
 *
 * A prompt failed and the Chat surface showed the reader
 * `@deepseek-ai/dsh-system-prompt`, the route id `llm-deepseek`, the provider
 * key `deepseek-official`, the environment variable `DEEPSEEK_API_KEY`, and a
 * paragraph of sandbox-policy text. Every one of those is true, and not one of
 * them told the reader what to do. Worse, two of them named a provider they had
 * never chosen, so the message actively misled: it read as *DeepWatch is a
 * DeepSeek product that is broken* rather than *nothing is bound yet*.
 *
 * This module draws the line. A raw provider or runtime failure is classified
 * into one of a small closed set of {@link FailureKind}s, each of which becomes
 * a card with a title, one sentence, and exactly one next action. The detailed
 * technical facts are not destroyed — they go to Diagnostics and the Session
 * Log, redacted — but they never render in an ordinary conversation.
 *
 * **Two rules hold everything here together.**
 *
 * The first is that a card carries no implementation identity.
 * {@link assertNoInternalDisclosure} is the executable form of that rule, and
 * it is applied to every card this module produces rather than trusted to
 * review.
 *
 * The second is that nothing here ever carries credential material — and
 * "material" includes the things people reach for when they are trying to be
 * helpful about a key without printing it: a prefix, a suffix, a length, a
 * fingerprint, a hash. A reader does not need to be told their key is 51
 * characters long, and an attacker reading a shared screenshot does.
 *
 * @module @deepwatch/dsh-contracts/failures
 */

import type { ReadinessBlocker } from './readiness.js'

/**
 * The closed set of things a person can be told went wrong.
 *
 * Closed on purpose. Every raw failure maps onto one of these or onto
 * {@link FailureKind.unavailable}, and there is no passthrough case that
 * renders a provider's own words: a provider message is written for an API
 * consumer, arrives unlocalised, and has no obligation to avoid naming
 * internals.
 */
export type FailureKind =
  /** No model is bound to this capability. The first-run case. */
  | 'not_configured'
  /** A complete binding exists, but no provider request has succeeded. */
  | 'not_tested'
  /** A credential is referenced and the store could not produce it. */
  | 'credential_unavailable'
  /** The provider answered and rejected the credential. */
  | 'credential_rejected'
  /** The bound model is not one the provider offers any more. */
  | 'model_unavailable'
  /** The provider did not answer usefully. */
  | 'provider_unreachable'
  /** The provider answered and declined for rate reasons. */
  | 'rate_limited'
  /** Policy on this machine forbids the request. */
  | 'policy_forbids'
  /** Something else. Deliberately vague to the reader, detailed in Diagnostics. */
  | 'unavailable'

/** Where a card's action sends a person. */
export type FailureActionTarget =
  /** The Role Bindings screen, at the role that is blocked. */
  | 'role-bindings'
  /** The provider credential screen. */
  | 'provider-credential'
  /** The model picker for the bound provider. */
  | 'model-selection'
  /** Diagnostics, for the redacted technical detail. */
  | 'diagnostics'
  /** Nothing to configure; the reader can only try again. */
  | 'retry'

/** One card, as a conversation renders it. */
export interface FailureCard {
  readonly kind: FailureKind
  /** A short heading, in a person's words. Never an error code. */
  readonly title: string
  /** One sentence saying what is true. Never a stack trace, never a route id. */
  readonly detail: string
  /** The label of the single action that fixes this. */
  readonly action: string
  readonly target: FailureActionTarget
  /**
   * Whether Diagnostics holds more about this.
   *
   * Every card offers the path; this says whether following it will find
   * anything, so the product does not send somebody to an empty screen.
   */
  readonly hasDiagnostics: boolean
}

/** The card each kind renders as. */
const CARDS: Readonly<Record<FailureKind, Omit<FailureCard, 'kind' | 'hasDiagnostics'>>> = {
  not_configured: {
    title: 'Chat model is not configured',
    detail: 'Choose a provider and a model, then assign one to Chat. Nothing is sent until you do.',
    action: 'Choose models and roles',
    target: 'role-bindings',
  },
  not_tested: {
    title: 'Chat provider has not been tested',
    detail: 'The provider and model are assigned, but no provider request has succeeded yet.',
    action: 'Run provider test',
    target: 'role-bindings',
  },
  credential_unavailable: {
    title: 'Credential is unavailable',
    detail: 'A credential is assigned to this provider, and it could not be read on this machine.',
    action: 'Review the provider credential',
    target: 'provider-credential',
  },
  credential_rejected: {
    title: 'Provider rejected the credential',
    detail: 'The provider answered and would not accept the credential saved for it.',
    action: 'Update the provider credential',
    target: 'provider-credential',
  },
  model_unavailable: {
    title: 'Model is no longer available',
    detail: 'The provider no longer offers the model assigned to this capability.',
    action: 'Choose another model',
    target: 'model-selection',
  },
  provider_unreachable: {
    title: 'Provider is temporarily unreachable',
    detail: 'No usable answer came back from the provider. Nothing was charged and no turn was recorded.',
    action: 'Try again',
    target: 'retry',
  },
  rate_limited: {
    title: 'Request was rate-limited',
    detail: 'The provider declined this request for rate reasons. Waiting and retrying usually clears it.',
    action: 'Try again',
    target: 'retry',
  },
  policy_forbids: {
    title: 'This machine’s policy blocked the request',
    detail: 'A policy in force here does not permit this request. Diagnostics records which one.',
    action: 'Open Diagnostics',
    target: 'diagnostics',
  },
  unavailable: {
    title: 'The request could not be completed',
    detail: 'Something went wrong before a reply could be produced. Diagnostics has the detail.',
    action: 'Open Diagnostics',
    target: 'diagnostics',
  },
}

/**
 * The card for one kind.
 *
 * @param kind - the classified failure.
 * @param hasDiagnostics - whether a redacted record was written for it.
 * @returns a card safe to render in an ordinary conversation.
 */
export function failureCard(kind: FailureKind, hasDiagnostics = true): FailureCard {
  const card = CARDS[kind]
  return { kind, ...card, hasDiagnostics }
}

/**
 * The card a readiness blocker becomes.
 *
 * The two vocabularies are separate because they answer different questions —
 * a blocker is "what is missing", a card is "what a person sees when they tried
 * anyway" — and this is the one place they are joined, so a blocker can never
 * reach a reader with no card defined for it.
 */
export function cardForBlocker(blocker: ReadinessBlocker): FailureCard {
  const kind: FailureKind = blocker === 'credential_inaccessible'
    ? 'credential_unavailable'
    : blocker === 'provider_untested'
      ? 'not_tested'
      : blocker === 'credential_rejected'
      ? 'credential_rejected'
      : blocker === 'provider_unreachable'
        ? 'provider_unreachable'
        : blocker === 'provider_rate_limited'
          ? 'rate_limited'
      : blocker === 'model_unavailable' || blocker === 'model_invalid'
        ? 'model_unavailable'
        : blocker === 'policy_forbids' || blocker === 'consent_required'
          ? 'policy_forbids'
          : 'not_configured'
  return failureCard(kind)
}

/**
 * Classify a raw failure without letting its words through.
 *
 * The input is read for *signals* — an HTTP status, a taxonomy code the
 * Harness already normalised — and the output is a kind. The raw text is
 * never returned, never embedded, and never partially quoted, because a
 * provider's message is exactly where the internal identifiers come from.
 *
 * @param signal - what the runtime managed to normalise about the failure.
 * @returns the kind a reader is told about.
 */
export function classifyFailure(signal: {
  /** HTTP status observed at the provider boundary, when there was one. */
  readonly status?: number | undefined
  /** The Harness's own taxonomy code (`AUTH`, `RATE_LIMIT`, `NO_ADAPTER`, …). */
  readonly code?: string | undefined
}): FailureKind {
  const { status, code } = signal
  if (code === 'MISSING_CREDENTIAL') return 'credential_unavailable'
  if (code === 'NO_ADAPTER' || code === 'MODEL_NOT_FOUND') return 'model_unavailable'
  if (code === 'AUTH') return 'credential_rejected'
  if (code === 'RATE_LIMIT') return 'rate_limited'
  if (status === 401 || status === 403) return 'credential_rejected'
  if (status === 404) return 'model_unavailable'
  if (status === 429) return 'rate_limited'
  if (status !== undefined && status >= 500) return 'provider_unreachable'
  return 'unavailable'
}

/**
 * Implementation identity that may not appear in an ordinary conversation.
 *
 * Each of these was on screen when a person's first prompt failed. They are
 * matched as *shapes* rather than as a list of literals, because the list
 * would go stale on the next baseline bump while the shapes — a scoped package
 * name, an adapter route id, a screaming-snake environment variable — do not.
 */
const INTERNAL_SHAPES: readonly { readonly what: string, readonly pattern: RegExp }[] = [
  { what: 'a scoped package name', pattern: /@(?:deepseek-ai|deepwatch|earendil-works)\/[a-z0-9-]+/i },
  { what: 'an adapter route id', pattern: /\bllm-[a-z0-9-]+\b/i },
  { what: 'a provider route key', pattern: /\b[a-z0-9]+-official\b/i },
  { what: 'an environment variable name', pattern: /\b[A-Z][A-Z0-9]*_(?:API_KEY|KEY|TOKEN|SECRET|BASE_URL)\b/ },
  { what: 'a stack frame', pattern: /\bat\s+[\w$.<>]+\s+\([^)]*:\d+:\d+\)/ },
  { what: 'a module specifier', pattern: /\b(?:node|file):[/\\]{2}?[^\s"']+/i },
  { what: 'a sandbox or approval policy identifier', pattern: /\b(?:sandbox|approval)Policy\b|\bpolicy:[a-z-]+/i },
]

/**
 * Throw when text bound for an ordinary conversation carries an internal name.
 *
 * Applied to cards at construction rather than to the screen at review time.
 * The failure it prevents is not hypothetical: every shape above is one that
 * actually reached a reader, and the reason each got there was that some layer
 * passed a provider or runtime string through "just this once".
 *
 * @param where - the surface being guarded, so a failure says what to fix.
 * @param text - the candidate copy.
 */
export function assertNoInternalDisclosure(where: string, text: string): void {
  for (const { what, pattern } of INTERNAL_SHAPES) {
    const found = pattern.exec(text)
    if (found === null) continue
    throw new Error(
      `${where} carries ${what} (${found[0]}). Implementation identity belongs in `
      + 'Diagnostics, not in a conversation.')
  }
}

/**
 * Whether a card is safe to render, as a boolean rather than a throw.
 *
 * The same check for callers that are validating a table of copy rather than
 * building one value — a test over every kind, typically.
 */
export function isDisclosureSafe(text: string): boolean {
  return !INTERNAL_SHAPES.some(shape => shape.pattern.test(text))
}
