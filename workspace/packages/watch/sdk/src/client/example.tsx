/**
 * The other half of a third-party capability: what it draws.
 *
 * A capability that can only submit observations is a capability whose output
 * shows up in DSH's generic tool row. Most authors will want their own view,
 * and the moment they do they are in the part of the product where ADR-002 is
 * easiest to break — because a view is where a verdict is *rendered*, and
 * rendering something as verified is one CSS class away from asserting it.
 *
 * So this example does the thing an author should copy, and refuses the thing
 * they should not:
 *
 * - It reads the value its own tool returned out of the conversation, with no
 *   Host round-trip, so there is no second source of truth to fall out of sync.
 * - It renders a verdict **verbatim** when Watch Core issued one, and renders
 *   nothing at all when it did not. There is no default, no fallback to a
 *   friendly word, and no path where a missing verdict becomes a shown one.
 * - It takes its tone from the brand package's status table, which is the same
 *   table that makes `success` reachable only from `VERIFIED`.
 *
 * Registration goes through the slot service, additively. A key the shipped
 * composition does not claim falls back to the generic row, so a third-party
 * view is never able to take a surface away from anything.
 *
 * @module @watchskill/dsh-sdk/client-example
 */

import type { ReactNode } from 'react'
import type { Verdict } from '@watchskill/dsh-contracts'

/**
 * The verdicts a view may render.
 *
 * Restated here rather than imported as a value, so a plugin that is compiled
 * against a newer contract cannot render a verdict this build has no tone for.
 */
const RENDERABLE: readonly string[] = [
  'VERIFIED', 'FAILED', 'UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED',
]

/** What the example capability's tool returns. */
export interface SubtitleReading {
  readonly ok: boolean
  readonly cues: readonly { readonly startMs: number; readonly text: string }[]
  /** Evidence Watch Core minted. The plugin never chose these ids. */
  readonly evidenceIds: readonly string[]
  /**
   * A verdict, when one was requested and Core issued it.
   *
   * Optional and nullable on purpose: absent is the normal case, and the view
   * has to be correct about it rather than filling it in.
   */
  readonly verdict?: Verdict | null
}

/**
 * Read a settled tool result, or return null.
 *
 * Null on anything unexpected — a running call, a failed one, a result that is
 * not JSON. The caller then renders nothing and DSH's generic row takes over,
 * which is the honest outcome: a view that could not read its own result must
 * not draw a card implying it did.
 */
export function readToolValue(block: unknown): SubtitleReading | null {
  if (typeof block !== 'object' || block === null) return null
  const settled = block as { kind?: unknown; content?: unknown; isError?: unknown }
  if (!('kind' in settled) || settled.isError === true) return null
  if (!Array.isArray(settled.content)) return null

  const text = settled.content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string')
    .map(part => part.text)
    .join('')
  if (text === '') return null

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (parsed['ok'] !== true) return null
    return {
      ok: true,
      cues: Array.isArray(parsed['cues'])
        ? parsed['cues'].filter((cue): cue is { startMs: number; text: string } =>
          typeof cue === 'object' && cue !== null
          && typeof (cue as { startMs?: unknown }).startMs === 'number'
          && typeof (cue as { text?: unknown }).text === 'string')
        : [],
      evidenceIds: Array.isArray(parsed['evidenceIds'])
        ? parsed['evidenceIds'].filter((id): id is string => typeof id === 'string')
        : [],
      // Read, never defaulted. `undefined` and `'UNVERIFIED'` are different
      // facts, and collapsing them is how a view invents a verdict.
      verdict: typeof parsed['verdict'] === 'string'
        && RENDERABLE.includes(parsed['verdict'])
        ? parsed['verdict'] as Verdict
        : null,
    }
  } catch {
    return null
  }
}

/** Props for {@link SubtitleReadingView}. */
export interface SubtitleReadingViewProps {
  readonly toolName: string
  readonly block: unknown
  /**
   * The brand's tone lookup, injected.
   *
   * A third-party view should not import the brand package directly — it is a
   * shell baseline module for Watch's own halves, not for a plugin's. Passing
   * it in keeps the example honest about what a capability actually has.
   */
  readonly tokenForStatus?: (status: string) => string
}

/**
 * The example view.
 *
 * Renders the cues it read, the evidence ids Core minted, and — only when one
 * exists — the verdict, verbatim.
 */
export function SubtitleReadingView(
  { block, tokenForStatus }: SubtitleReadingViewProps,
): ReactNode {
  const reading = readToolValue(block)
  if (reading === null) return null

  const tone = tokenForStatus ?? (() => 'inherit')

  return (
    <section data-example-capability="subtitle-reader">
      <ul data-example-cues="">
        {reading.cues.map(cue => (
          <li key={`${String(cue.startMs)}:${cue.text}`}>
            <span dir="ltr">{`${String(Math.floor(cue.startMs / 1000))}s `}</span>
            <span dir="auto">{cue.text}</span>
          </li>
        ))}
      </ul>
      <p data-example-evidence="">
        {reading.evidenceIds.length === 0
          ? 'No evidence was minted for this reading.'
          : `Evidence: ${reading.evidenceIds.join(', ')}`}
      </p>
      {/* No verdict, no element. A view that rendered "not yet verified" here
          would be putting a verification state on screen that nobody issued. */}
      {reading.verdict !== null && reading.verdict !== undefined && (
        <p data-example-verdict={reading.verdict} style={{ color: tone(reading.verdict) }}>
          {reading.verdict}
        </p>
      )}
    </section>
  )
}

/** The minimal shape of DSH's slot service a capability's browser half uses. */
export interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/**
 * Register the view, additively.
 *
 * Keyed to the capability's own tool name. A key the shipped composition does
 * not claim falls back to the generic tool row, which is what makes a
 * third-party view purely additive: it cannot take a surface away from
 * anything, including from Watch's own views.
 */
export function registerExampleView(slots: SlotService, toolName: string): void {
  slots.inject('tool.call.toolview', () => {
    slots.register({ name: 'tool.call.toolview', key: toolName }, SubtitleReadingView)
  })
}
