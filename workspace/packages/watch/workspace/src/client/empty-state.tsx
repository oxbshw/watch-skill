/**
 * What this product says about itself before anyone has typed anything.
 *
 * A blank session is the most-read screen in any conversational product, and
 * in a DeepWatch profile it was reading as somebody else's: a fish, the
 * headline "Into the Unknown", and a "Preview" badge with nothing explaining
 * what was in preview. Correct for the Harness, and not what a person had
 * installed.
 *
 * This is DeepWatch's own sentence in that space — what the product is *for*,
 * in three clauses that name the loop it closes.
 *
 * **What it deliberately does not do is pretend to be a menu.** The obvious
 * thing to put here is a row of capability buttons: Start task, Watch source,
 * Inspect evidence, Open Library. Every one of them needs an action this seat
 * does not have — switching the active `conversation.view` is the chat store's,
 * not a dock component's — so each would be a control that does nothing when
 * pressed. A dead button teaches people the product is broken faster than a
 * missing one teaches them anything at all, which is the rule the settings
 * surfaces already follow, and it applies hardest on the first screen.
 *
 * **On the headline above it.** The upstream hero text is not replaceable from
 * a plugin in this baseline, and the ways it is not are worth recording so the
 * next person does not spend an afternoon finding out:
 *
 *   - it is `hero.headline` in `ui-conversation`'s own dictionary, and
 *     `LocaleService.register` refuses a second owner for a
 *     `(namespace, locale)` pair, so no dictionary can shadow it;
 *   - the hero exposes three slots — the brand mark, the workspace picker and
 *     the agent-preset chip — and none carries the text;
 *   - the hero is rendered by `ConversationRoot`, which sits in the `single`
 *     slot `conversation` and is not exported, so owning it means
 *     reimplementing the whole conversation skeleton.
 *
 * So this sits underneath rather than instead, in the one seat in the hero that
 * is a list and is genuinely free. Replacing the headline needs an upstream
 * `conversation.hero.headline` slot or a locale-override API; either is small,
 * and neither is something a distribution may fake by hiding somebody else's
 * text with a stylesheet.
 *
 * @module @deepwatch/dsh-workspace/empty-state
 */

import type { ReactNode } from 'react'

/**
 * The product, in three clauses.
 *
 * Each names one half of the loop: capture what happened, keep why it
 * mattered, and check that the fix actually worked. It is deliberately not a
 * feature list — a person reading a blank screen wants to know what the thing
 * is for, and a list of nouns does not tell them.
 */
export const EMPTY_STATE_LINE = 'See what happened. Remember why. Verify what worked.'

/**
 * What is genuinely running before anything is configured.
 *
 * Named because the alternative reads as a broken installation. A local-first
 * product whose first screen lists nothing it can do looks unfinished, and a
 * product that lists everything it *could* do looks configured when it is not.
 * These four need no provider and no credential, which is what makes saying so
 * honest.
 */
export const OFFLINE_CAPABILITIES = [
  'evidence', 'memory', 'verification', 'a supervised browser',
] as const

/** What the empty state is handed by the input dock. */
export interface WatchEmptyStateProps {
  /** The session's own snapshot; `blank` is the phase this belongs to. */
  readonly session?: { readonly composerPhase?: string } | undefined
}

/**
 * The DeepWatch line for a blank session.
 *
 * @param props.session - the conversation snapshot from the input dock's zone.
 * @returns the line while the session is blank, and nothing once it is not.
 */
export function WatchEmptyState({ session }: WatchEmptyStateProps): ReactNode {
  // Only in the blank phase. Left rendered afterwards it would sit above the
  // composer for the whole conversation, which is an advertisement rather than
  // an empty state.
  if (session?.composerPhase !== 'blank') return null

  return (
    <section
      data-watch-empty-state=""
      aria-label="What DeepWatch is for"
      style={{
        display: 'flex', flexDirection: 'column', gap: '4px',
        alignItems: 'center', textAlign: 'center',
        padding: '2px 12px 10px',
      }}
    >
      <p style={{
        margin: 0,
        // Sized to sit under the hero headline rather than compete with it:
        // two things claiming to be the title is worse than one that is
        // somebody else's.
        fontSize: '14px', lineHeight: 1.5, fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
        maxWidth: '46ch',
      }}
      >
        {EMPTY_STATE_LINE}
      </p>
      <p style={{
        margin: 0, fontSize: '12px', lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary)',
        maxWidth: '52ch',
      }}
      >
        {`Runs on this machine without a model: ${
          OFFLINE_CAPABILITIES.slice(0, -1).join(', ')} and ${
          OFFLINE_CAPABILITIES[OFFLINE_CAPABILITIES.length - 1] ?? ''}.`}
      </p>
    </section>
  )
}
