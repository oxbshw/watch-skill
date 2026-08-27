/**
 * Watch records registered into DeepSeek Harness's own event system.
 *
 * This is the seam the plan insists on. Watch does **not** build a second
 * tracker: it registers a `ConversationNodeDefinition` into
 * `ctx.conversationEvents` — the same registry Trajectory itself uses — and a
 * view target into `ctx.conversationViews`. Both read the single session event
 * log DSH already owns.
 *
 * What that buys is not tidiness. It means a Watch record and the Tool record
 * it came from cannot disagree about when something happened, because they are
 * two projections of the same event at the same sequence number. A separate
 * Watch ledger would eventually drift, and the drift would be invisible.
 *
 * The Trajectory *contribution* union is closed in upstream's own package, so
 * Watch rows cannot be injected into the existing Trajectory ledger without an
 * upstream patch. Rather than take one, Watch registers its own view target
 * over the same events — the arrangement upstream already uses for `chat` and
 * `trajectory`, and additive by construction.
 *
 * @module @watchskill/dsh-trajectory/definition
 */

import type { WatchProjection } from './projection.js'
import type { WatchTrajectoryRecord } from './events.js'
import { emptyProjection } from './projection.js'
import { isWatchTool, recordsFromToolResult, toolResultValue } from './events.js'

/**
 * The two DSH registries this module needs.
 *
 * Structural rather than imported from Cordis: these are two method
 * signatures, and taking a framework dependency for them would tie a pure
 * module to a runtime it never uses. The browser half passes its real context.
 */
export interface WatchRegistries {
  readonly conversationEvents: { register(definition: unknown): void }
  readonly conversationViews: { register(definition: unknown): void }
}

/** The view target Watch publishes. Distinct from `trajectory` and `chat`. */
export const WATCH_TARGET = 'watchEvidence'

/** What one Watch context accumulates between a tool call and its result. */
interface WatchContextState {
  readonly callId: string
  readonly toolName: string
  readonly turn: number | null
  readonly step: number | null
  readonly correlationId: string | null
  readonly records: readonly WatchTrajectoryRecord[]
}

/** The narrow slice of a DSH session event this definition reads. */
interface EventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The Watch event Definition.
 *
 * Typed structurally rather than against upstream's exported generics: this
 * package must build outside the DSH monorepo, where those types are reachable
 * only through the packages the browser bundle is allowed to import. The shape
 * is checked against the real contract by the round-trip tests, which run the
 * same extraction over real event shapes.
 */
export function watchTrajectoryDefinition(sessionId: string): unknown {
  return {
    kind: 'watch-evidence',
    target: WATCH_TARGET,

    /**
     * Claim the Watch tool calls and their results.
     *
     * Keyed by call id, so a call and its result assemble into one context the
     * way every other business definition in DSH does.
     */
    match(event: EventLike): { id: string; role: 'start' | 'update' } | null {
      if (event.type === 'tool/call') {
        const callId = str(event.data['callId'])
        return callId !== null && isWatchTool(event.data['name'])
          ? { id: callId, role: 'start' }
          : null
      }
      if (event.type === 'tool/result') {
        const message = event.data['message'] as Record<string, unknown> | undefined
        const source = message?.['source'] as Record<string, unknown> | undefined
        const callId = str(source?.['callId'])
        return callId === null ? null : { id: callId, role: 'update' }
      }
      return null
    },

    start(_context: unknown, match: { event: EventLike }): WatchContextState {
      const event = match.event
      const args = event.data['arguments'] as Record<string, unknown> | undefined
      return {
        callId: str(event.data['callId']) ?? '',
        toolName: str(event.data['name']) ?? '',
        turn: num(event.data['turn']),
        step: num(event.data['step']),
        correlationId: str(args?.['correlationId']),
        records: [],
      }
    },

    update(
      context: { state: WatchContextState },
      match: { event: EventLike },
    ): WatchContextState {
      if (match.event.type !== 'tool/result') return context.state
      const records = recordsFromToolResult(
        match.event,
        {
          sessionId,
          turn: context.state.turn,
          step: context.state.step,
          callId: context.state.callId,
          toolName: context.state.toolName,
          correlationId: context.state.correlationId,
        },
        toolResultValue(match.event),
      )
      return records.length === 0 ? context.state : { ...context.state, records }
    },

    /**
     * Publish this context's records, or nothing.
     *
     * A Watch tool that produced no record — a refusal, an unreadable result —
     * contributes no row at all. DSH's own Tool record already shows that the
     * call happened and how it ended; adding an empty Watch row beside it
     * would put a claim in the ledger that nothing backs.
     */
    buildViewNode(context: {
      key: string
      kind: string
      id: string
      state?: WatchContextState
      start?: { event: EventLike }
    }): unknown {
      const state = context.state
      if (state === undefined || state.records.length === 0) return null
      return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target: WATCH_TARGET,
        anchorSeq: context.start?.event.seq ?? state.records[0]?.seq ?? 0,
        data: { records: state.records },
      }
    },
  }
}

/** The node shape the view builder folds. */
interface WatchViewNode {
  readonly key: string
  readonly anchorSeq: number
  readonly data: { readonly records: readonly WatchTrajectoryRecord[] }
}

/**
 * The Watch view target's incremental builder.
 *
 * Rebuilds the whole projection on change rather than patching it. The record
 * set for one session is small — tens of rows, not thousands — and a full fold
 * is the same code path replay uses, so the live view and a reopened one
 * cannot diverge. Patching would be faster and would introduce exactly the
 * class of bug this whole design exists to rule out.
 */
class WatchViewBuilder {
  readonly empty: WatchProjection
  private nodes = new Map<string, WatchViewNode>()

  constructor(private readonly sessionId: string) {
    this.empty = emptyProjection(sessionId)
  }

  replace(input: { nodes: readonly WatchViewNode[] }): WatchProjection {
    this.nodes = new Map(input.nodes.map(node => [node.key, node]))
    return this.build()
  }

  patch(input: { nodes: readonly WatchViewNode[] }): WatchProjection {
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.build()
  }

  private build(): WatchProjection {
    const records = [...this.nodes.values()]
      .flatMap(node => node.data.records)
      .sort((a, b) => {
        const bySeq = a.seq - b.seq
        return bySeq !== 0 ? bySeq : a.recordId.localeCompare(b.recordId)
      })

    const byEvidence = new Map<string, WatchTrajectoryRecord>()
    const byRecord = new Map<string, WatchTrajectoryRecord>()
    for (const record of records) {
      byRecord.set(record.recordId, record)
      for (const evidenceId of record.refs.evidenceIds) {
        if (!byEvidence.has(evidenceId)) byEvidence.set(evidenceId, record)
      }
    }
    return { sessionId: this.sessionId, records, byEvidence, byRecord }
  }
}

/**
 * Register the Watch definition and view target.
 *
 * Both registrations ride Cordis effects, so unloading the plugin removes them
 * and the workspace returns to stock DSH with no Watch rows and no leftover
 * target — which is the uninstall path the bundle promises.
 */
export function registerWatchTrajectory(ctx: WatchRegistries, sessionId: string): void {
  const registries = ctx
  registries.conversationViews.register({
    target: WATCH_TARGET,
    create: () => new WatchViewBuilder(sessionId),
  })
  registries.conversationEvents.register(watchTrajectoryDefinition(sessionId))
}

export { WatchViewBuilder }
