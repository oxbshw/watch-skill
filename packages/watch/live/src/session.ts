/**
 * Live: watching something while it is still happening.
 *
 * The engine already produces live observations. What did not exist was the
 * client half — and the client half is where every interesting failure lives,
 * because a live surface has to be correct about time it did not see.
 *
 * Four decisions carry this module.
 *
 * **A cursor is the only ordering authority.** Events are read by cursor, and
 * a repeated cursor returns the same events. That makes a retry free: a caller
 * that times out, reconnects and re-asks cannot lose an event or receive one
 * twice, which is what makes a flaky network a nuisance instead of a source of
 * fabricated history.
 *
 * **A gap is a fact, not a rendering problem.** When a delta does not continue
 * from the cursor the client holds, the client does not interpolate, does not
 * guess, and does not quietly skip forward. It records a gap with its own
 * range and asks for a fresh snapshot. The gap stays in the buffer afterwards.
 * Every alternative — smoothing, backfilling, "probably nothing happened" —
 * converts missing evidence into evidence, which is the one thing this product
 * cannot do.
 *
 * **Three clocks, never one.** Wall clock, media clock and session clock
 * disagree constantly during a live observation, and each answers a different
 * question: when did this happen in the world, where is it in the source, and
 * how far into watching are we. Collapsing them produces a subtitle attributed
 * to the wrong second.
 *
 * **The buffer is bounded.** A session left running for eight hours must not
 * grow a browser tab without limit. Trimming drops the oldest ordinary events
 * and keeps three things forever: gaps, pinned moments, and the count of what
 * was trimmed. A buffer that silently forgot a gap would let a long session
 * end up looking cleaner than a short one.
 *
 * @module @watchskill/dsh-live/session
 */

import type { TemporalRange } from '@watchskill/dsh-contracts'

/** What a live session is watching. */
export type LiveKind = 'file_replay' | 'stream' | 'browser'

/** What kind of thing one live event is. */
export type LiveEventKind =
  | 'speech'
  | 'ocr'
  | 'frame'
  | 'detector'
  | 'status'
  /** Capture stopped. Produced by the engine, or minted locally on a cursor break. */
  | 'gap'

/** One thing observed, as the engine reports it. */
export interface LiveEvent {
  /** Monotonic within the session. */
  readonly seq: number
  /** The cursor *after* this event, for resuming. */
  readonly cursor: string
  readonly kind: LiveEventKind
  /** Wall clock, epoch milliseconds. */
  readonly at: number
  /** Position on the source's own clock. Null for events with no media position. */
  readonly mediaMs: number | null
  /** One line. Presentation only. */
  readonly text: string
  /** Range this event covers, for a gap or a span. */
  readonly range: TemporalRange | null
  /** Evidence this event resolves to, when the engine minted any. */
  readonly evidenceIds: readonly string[]
}

/** Connection state of the observation channel. */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'lost' | 'stopped'

/** Whether the session itself is running. */
export type LiveStatus = 'starting' | 'observing' | 'stopping' | 'finalized' | 'discarded'

/** The three clocks, read together so they cannot drift apart in the UI. */
export interface LiveClocks {
  /** Epoch milliseconds of the most recent event. Null before the first. */
  readonly wallMs: number | null
  /** Position in the source. Null for a source with no media clock. */
  readonly mediaMs: number | null
  /** Milliseconds since the session started. */
  readonly sessionMs: number
  /**
   * Observation latency: how far behind the wall clock the newest event is.
   *
   * Reported rather than corrected. A live view that hid its own lag would
   * make "what is on screen right now" mean something it does not.
   */
  readonly latencyMs: number | null
}

/** A moment somebody chose to keep. */
export interface PinnedMoment {
  readonly momentId: string
  readonly atMediaMs: number | null
  readonly atWallMs: number
  readonly note: string
  readonly evidenceIds: readonly string[]
}

/** Everything the Live surface renders. */
export interface LiveSessionState {
  readonly sessionId: string
  readonly target: string
  readonly kind: LiveKind
  readonly status: LiveStatus
  readonly connection: ConnectionState
  /** The cursor to resume from. Empty before the first read. */
  readonly cursor: string
  readonly startedAtMs: number
  readonly events: readonly LiveEvent[]
  /** Every gap, kept whatever the buffer drops. */
  readonly gaps: readonly TemporalRange[]
  readonly pinned: readonly PinnedMoment[]
  readonly clocks: LiveClocks
  /** How many ordinary events the bound dropped. */
  readonly trimmed: number
  /**
   * Set when the client knows its view is not continuous.
   *
   * Cleared only by a fresh snapshot. Nothing else clears it, because nothing
   * else re-establishes continuity.
   */
  readonly needsSnapshot: boolean
  /** Why the last read failed, when one did. */
  readonly lastError: string | null
}

/** How large a session buffer may grow. */
export interface BufferLimits {
  /** Ordinary events kept. Gaps and pinned moments are exempt. */
  readonly maxEvents: number
}

/** The default bound. Roughly an hour of dense observation. */
export const DEFAULT_LIMITS: BufferLimits = { maxEvents: 2000 }

/** Begin a session, before anything has been observed. */
export function startSession(input: {
  readonly sessionId: string
  readonly target: string
  readonly kind: LiveKind
  readonly startedAtMs: number
}): LiveSessionState {
  return {
    sessionId: input.sessionId,
    target: input.target,
    kind: input.kind,
    status: 'starting',
    connection: 'connecting',
    cursor: '',
    startedAtMs: input.startedAtMs,
    events: [],
    gaps: [],
    pinned: [],
    clocks: { wallMs: null, mediaMs: null, sessionMs: 0, latencyMs: null },
    trimmed: 0,
    needsSnapshot: false,
    lastError: null,
  }
}

/** What one read of the observation channel returned. */
export interface LiveDelta {
  /** The cursor this delta continues from. Empty means "from the beginning". */
  readonly fromCursor: string
  readonly nextCursor: string
  readonly events: readonly LiveEvent[]
  readonly status: LiveStatus
  /**
   * True when the engine is answering a snapshot request rather than a delta.
   *
   * A snapshot replaces the client's continuity assumption; a delta extends
   * it. Conflating them is how a reconnect ends up appending the beginning of
   * the session to the end of it.
   */
  readonly isSnapshot: boolean
  /** Gaps the engine itself reported. */
  readonly gaps?: readonly TemporalRange[]
}

/** Recompute the clocks from the newest event. */
function clocksFrom(
  state: LiveSessionState,
  events: readonly LiveEvent[],
  nowMs: number,
): LiveClocks {
  const newest = events[events.length - 1]
  if (newest === undefined) {
    return { wallMs: null, mediaMs: null, sessionMs: nowMs - state.startedAtMs, latencyMs: null }
  }
  return {
    wallMs: newest.at,
    mediaMs: newest.mediaMs,
    sessionMs: nowMs - state.startedAtMs,
    // Never negative. A clock skew that made the newest event look like it
    // arrived from the future would render as a nonsense latency.
    latencyMs: Math.max(0, nowMs - newest.at),
  }
}

/**
 * Trim the buffer to its bound.
 *
 * Gaps and pinned events survive. The trim count is carried so the surface can
 * say "1,204 earlier events dropped" rather than presenting a partial history
 * as a complete one.
 */
function bound(
  events: readonly LiveEvent[],
  pinned: readonly PinnedMoment[],
  limits: BufferLimits,
): { readonly events: readonly LiveEvent[]; readonly dropped: number } {
  if (events.length <= limits.maxEvents) return { events, dropped: 0 }

  const pinnedEvidence = new Set(pinned.flatMap(moment => moment.evidenceIds))
  const keepAlways = (event: LiveEvent): boolean =>
    event.kind === 'gap' || event.evidenceIds.some(id => pinnedEvidence.has(id))

  const protectedEvents = events.filter(keepAlways)
  const ordinary = events.filter(event => !keepAlways(event))
  const room = Math.max(0, limits.maxEvents - protectedEvents.length)
  const kept = ordinary.slice(Math.max(0, ordinary.length - room))

  const keptIds = new Set([...protectedEvents, ...kept].map(event => event.seq))
  return {
    events: events.filter(event => keptIds.has(event.seq)),
    dropped: ordinary.length - kept.length,
  }
}

/** Mint the gap a cursor break implies, with the range it actually covers. */
function cursorBreakGap(state: LiveSessionState, delta: LiveDelta): LiveEvent | null {
  const last = state.events[state.events.length - 1]
  const next = delta.events[0]
  if (last === undefined || next === undefined) return null
  return {
    seq: last.seq + 0.5,
    cursor: state.cursor,
    kind: 'gap',
    at: last.at,
    mediaMs: last.mediaMs,
    text: 'observation gap — the stream did not continue from the last cursor',
    range: last.mediaMs === null || next.mediaMs === null
      ? null
      : { startMs: last.mediaMs, endMs: next.mediaMs },
    evidenceIds: [],
  }
}

/**
 * Apply one delta or snapshot to the session.
 *
 * The three cases, in the order they are checked:
 *
 * 1. **A snapshot** replaces the event view outright and clears
 *    `needsSnapshot`. This is the only thing that re-establishes continuity.
 * 2. **A delta that continues from the held cursor** appends. This is the
 *    ordinary case.
 * 3. **A delta that does not** is a break. A gap event is minted at the seam,
 *    `needsSnapshot` is set, and the delta's events are *not* appended —
 *    appending them would splice two discontinuous stretches into something
 *    that reads as continuous.
 *
 * Re-applying the same delta is a no-op, which is what makes a retry safe.
 */
export function applyDelta(
  state: LiveSessionState,
  delta: LiveDelta,
  nowMs: number,
  limits: BufferLimits = DEFAULT_LIMITS,
): LiveSessionState {
  const engineGaps = delta.gaps ?? []

  if (delta.isSnapshot) {
    const { events, dropped } = bound(delta.events, state.pinned, limits)
    return {
      ...state,
      status: delta.status,
      connection: delta.status === 'observing' ? 'live' : state.connection,
      cursor: delta.nextCursor,
      events,
      gaps: mergeGaps(state.gaps, [...engineGaps, ...rangesOf(delta.events)]),
      clocks: clocksFrom(state, events, nowMs),
      trimmed: state.trimmed + dropped,
      needsSnapshot: false,
      lastError: null,
    }
  }

  // An already-applied delta. Returning the same state is what makes a retry
  // after a timeout free rather than a source of duplicates.
  if (delta.nextCursor === state.cursor) return state

  if (delta.fromCursor !== state.cursor) {
    const gap = cursorBreakGap(state, delta)
    const events = gap === null ? state.events : [...state.events, gap]
    return {
      ...state,
      connection: 'reconnecting',
      events,
      gaps: mergeGaps(state.gaps, gap?.range === null || gap?.range === undefined ? [] : [gap.range]),
      clocks: clocksFrom(state, events, nowMs),
      needsSnapshot: true,
      lastError: `cursor ${delta.fromCursor} does not continue from ${state.cursor || '(start)'}`,
    }
  }

  const appended = [...state.events, ...delta.events]
  const { events, dropped } = bound(appended, state.pinned, limits)
  return {
    ...state,
    status: delta.status,
    connection: delta.status === 'observing' ? 'live' : state.connection,
    cursor: delta.nextCursor,
    events,
    gaps: mergeGaps(state.gaps, [...engineGaps, ...rangesOf(delta.events)]),
    clocks: clocksFrom(state, events, nowMs),
    trimmed: state.trimmed + dropped,
    lastError: null,
  }
}

/** Ranges of the gap events in a batch. */
function rangesOf(events: readonly LiveEvent[]): readonly TemporalRange[] {
  return events
    .filter(event => event.kind === 'gap' && event.range !== null)
    .map(event => event.range as TemporalRange)
}

/** Union of two gap lists, deduplicated and ordered. */
function mergeGaps(
  existing: readonly TemporalRange[],
  incoming: readonly TemporalRange[],
): readonly TemporalRange[] {
  const seen = new Map<string, TemporalRange>()
  for (const range of [...existing, ...incoming]) {
    seen.set(`${String(range.startMs)}:${String(range.endMs)}`, range)
  }
  return [...seen.values()].sort((left, right) => left.startMs - right.startMs)
}

/** Record that the channel dropped. */
export function connectionLost(state: LiveSessionState, reason: string): LiveSessionState {
  return {
    ...state,
    connection: 'lost',
    // A lost connection always needs a snapshot on return. Even if no event
    // was missed, the client cannot know that, and assuming it is how a gap
    // goes unrecorded.
    needsSnapshot: true,
    lastError: reason,
  }
}

/** Record that a reconnect attempt is under way. */
export function reconnecting(state: LiveSessionState): LiveSessionState {
  return { ...state, connection: 'reconnecting' }
}

/**
 * Pin a moment.
 *
 * Pinning protects the events it references from being trimmed. That is the
 * whole reason pins take evidence ids: a pin that pointed only at a timestamp
 * would survive a trim while the thing it pointed at did not.
 */
export function pinMoment(
  state: LiveSessionState,
  moment: PinnedMoment,
): LiveSessionState {
  if (state.pinned.some(existing => existing.momentId === moment.momentId)) return state
  return { ...state, pinned: [...state.pinned, moment] }
}

/** Stop the session, keeping or discarding what it observed. */
export function finish(state: LiveSessionState, finalize: boolean): LiveSessionState {
  return {
    ...state,
    status: finalize ? 'finalized' : 'discarded',
    connection: 'stopped',
  }
}

/**
 * The replayable record of a finished session.
 *
 * A finalized session has to reopen as what it was. This is the value that
 * makes that true — and it deliberately keeps `trimmed`, so a replay of a long
 * session says how much of it the live view did not retain rather than
 * presenting what survived as the whole thing.
 */
export interface LiveReplay {
  readonly sessionId: string
  readonly target: string
  readonly kind: LiveKind
  readonly status: LiveStatus
  readonly events: readonly LiveEvent[]
  readonly gaps: readonly TemporalRange[]
  readonly pinned: readonly PinnedMoment[]
  readonly trimmed: number
}

/** Freeze a finished session into its replay record. */
export function toReplay(state: LiveSessionState): LiveReplay {
  return {
    sessionId: state.sessionId,
    target: state.target,
    kind: state.kind,
    status: state.status,
    events: state.events,
    gaps: state.gaps,
    pinned: state.pinned,
    trimmed: state.trimmed,
  }
}

/**
 * Digest of a replay, so "reopening it shows the same thing" is assertable.
 *
 * FNV-1a over event identity and gap ranges — the same construction the
 * trajectory projection uses, and for the same reason.
 */
export function replayDigest(replay: LiveReplay): string {
  let hash = 0x811c9dc5
  const feed = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  feed(`${replay.sessionId}|${replay.status}|${String(replay.trimmed)}`)
  for (const event of replay.events) feed(`|${String(event.seq)}:${event.kind}:${event.cursor}`)
  for (const gap of replay.gaps) feed(`|gap:${String(gap.startMs)}-${String(gap.endMs)}`)
  return hash.toString(16).padStart(8, '0')
}

/**
 * One line describing the session's honesty, for the surface header.
 *
 * Always says the gap count and the trim count, including when both are zero.
 * A message that appears only when something is wrong is a message people
 * learn to not look for.
 */
export function describeContinuity(state: LiveSessionState): string {
  const parts = [
    state.gaps.length === 0 ? 'no gaps' : `${String(state.gaps.length)} gap(s)`,
    state.trimmed === 0 ? 'nothing dropped' : `${String(state.trimmed)} earlier event(s) dropped`,
  ]
  if (state.needsSnapshot) parts.push('view not continuous — resnapshot pending')
  return parts.join(' · ')
}
