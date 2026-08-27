/**
 * The Watch browser half.
 *
 * It registers keyed tool views into DeepSeek Harness's own
 * `tool.call.toolview` slot, which means it needs no Host round-trip at all:
 * everything it renders is already in the conversation the workspace streamed.
 * That is what makes this the right first browser surface — it puts the
 * product's central distinction on screen without adding a second source of
 * truth to keep in sync.
 *
 * A key the shipped composition does not claim falls back to the generic tool
 * row, so registering for Watch's own tools is purely additive.
 *
 * @module @watchskill/dsh-client-evidence/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { parseVerdict, parseAnswer } from '@watchskill/dsh-contracts'
import { VerdictRow } from './VerdictRow.tsx'
import { SourceAnswerRow } from './SourceAnswerRow.tsx'

export { VerdictRow } from './VerdictRow.tsx'
export { SourceAnswerRow } from './SourceAnswerRow.tsx'
export { EvidenceInspector } from './EvidenceInspector.tsx'
export type { EvidenceInspectorProps, InspectableEvidence, InspectorState } from './EvidenceInspector.tsx'
// Re-exported from the trajectory package, which owns them: they have no DOM
// dependency, and the browser bundle inlines them rather than duplicating them.
export {
  WATCH_TARGET,
  WatchSelectionStore,
  WatchViewBuilder,
  registerWatchTrajectory,
  watchTrajectoryDefinition,
} from '@watchskill/dsh-trajectory'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/** The minimum of a settled tool call these views read. */
interface ToolCallOwnerProps {
  readonly toolName: string
  readonly block: unknown
}

/**
 * Read the JSON a tool returned out of its settled block.
 *
 * Returns null on anything unexpected — a running call, a failed one, a result
 * that is not JSON. The caller then renders nothing and DSH's generic tool row
 * takes over, which is the honest outcome: a view that cannot read its result
 * must not draw a card that implies it did.
 */
function toolValue(block: unknown): unknown {
  if (typeof block !== 'object' || block === null) return null
  const settled = block as { kind?: unknown; content?: unknown; isError?: unknown }
  // `kind` is present only once the call has settled.
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
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Render a verification result, or defer to the generic row. */
function WatchVerifyView({ block }: ToolCallOwnerProps): ReactNode {
  const payload = parseVerdict(toolValue(block))
  if (payload === null) return null
  return <VerdictRow payload={payload} />
}

/** Render an evidence-linked answer, or defer to the generic row. */
function WatchAskView({ block }: ToolCallOwnerProps): ReactNode {
  const payload = parseAnswer(toolValue(block))
  if (payload === null) return null
  return <SourceAnswerRow payload={payload} />
}

/** Register the Watch tool views into the conversation. */
export function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'watch_verify' },
    WatchVerifyView,
  ))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'watch_ask_source' },
    WatchAskView,
  ))
}
