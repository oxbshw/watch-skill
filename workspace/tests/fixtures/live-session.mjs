/**
 * A deterministic live session, from start to replay.
 *
 * Every timestamp, cursor and sequence number here is fixed. That is the point:
 * a live fixture that used real time would be a test that passes on a fast
 * machine and fails on a loaded one, and the behavior under test — what happens
 * when the stream does not continue from the cursor you hold — is precisely the
 * behavior a flaky test would be blamed for.
 *
 * The shape it describes:
 *
 *   start → three observations → the stream breaks mid-session →
 *   reconnect → a fresh snapshot → four more observations → finalize
 *
 * The break is deliberately a *cursor* break rather than a socket error,
 * because that is the case a client can get wrong silently. A dropped socket is
 * obvious. A delta that arrives claiming to continue from somewhere the client
 * has never been is the one that quietly splices two stretches of time into
 * something that reads as continuous.
 */

const START_WALL = 1_700_000_000_000

/** One observation, positioned on both the wall and the media clock. */
function event(seq, kind, mediaMs, text, extra = {}) {
  return {
    seq,
    cursor: `c${String(seq)}`,
    kind,
    at: START_WALL + mediaMs,
    mediaMs,
    text,
    range: null,
    evidenceIds: [],
    ...extra,
  }
}

/** The session as it is started. */
export const SESSION_START = {
  sessionId: 'live_fixture_1',
  target: 'https://example.test/stream',
  kind: 'stream',
  startedAtMs: START_WALL,
}

/** The first three observations, arriving in order from the beginning. */
export const FIRST_DELTA = {
  fromCursor: '',
  nextCursor: 'c3',
  isSnapshot: false,
  status: 'observing',
  events: [
    event(1, 'status', 0, 'capture started'),
    event(2, 'speech', 2_000, 'and now the deployment step'),
    event(3, 'ocr', 4_000, 'Deploy: in progress', { evidenceIds: ['ev_ocr_1'] }),
  ],
}

/**
 * A delta that does not continue from `c3`.
 *
 * The engine restarted its stream and is offering events from `c9`. A client
 * that appended these would produce a history in which nothing happened between
 * 4s and 30s — which is not what it observed, it is what it failed to observe.
 */
export const BROKEN_DELTA = {
  fromCursor: 'c8',
  nextCursor: 'c10',
  isSnapshot: false,
  status: 'observing',
  events: [
    event(9, 'speech', 30_000, 'so as you can see it went through'),
    event(10, 'ocr', 31_000, 'Deploy: succeeded', { evidenceIds: ['ev_ocr_2'] }),
  ],
}

/**
 * The snapshot taken after reconnecting.
 *
 * It carries the engine's own account of the gap. Note that it contains the
 * events from before the break as well: a snapshot is the whole current view,
 * not a continuation, and treating it as one is the other half of the same
 * mistake.
 */
export const RECOVERY_SNAPSHOT = {
  fromCursor: '',
  nextCursor: 'c10',
  isSnapshot: true,
  status: 'observing',
  gaps: [{ startMs: 4_000, endMs: 30_000 }],
  events: [
    event(1, 'status', 0, 'capture started'),
    event(2, 'speech', 2_000, 'and now the deployment step'),
    event(3, 'ocr', 4_000, 'Deploy: in progress', { evidenceIds: ['ev_ocr_1'] }),
    event(4, 'gap', 4_000, 'capture gap — the stream dropped', {
      range: { startMs: 4_000, endMs: 30_000 },
    }),
    event(9, 'speech', 30_000, 'so as you can see it went through'),
    event(10, 'ocr', 31_000, 'Deploy: succeeded', { evidenceIds: ['ev_ocr_2'] }),
  ],
}

/** Observation continues normally after recovery. */
export const CONTINUED_DELTA = {
  fromCursor: 'c10',
  nextCursor: 'c12',
  isSnapshot: false,
  status: 'observing',
  events: [
    event(11, 'speech', 33_000, 'and the health check is green'),
    event(12, 'detector', 34_000, 'page navigated to /status'),
  ],
}

/** A moment somebody kept, anchored to evidence so a trim cannot drop it. */
export const PINNED = {
  momentId: 'moment_1',
  atMediaMs: 4_000,
  atWallMs: START_WALL + 4_000,
  note: 'the deploy said in progress here',
  evidenceIds: ['ev_ocr_1'],
}

/** Wall-clock reading to use for each step, so latency is deterministic. */
export const NOW = {
  afterFirst: START_WALL + 4_500,
  afterBreak: START_WALL + 31_500,
  afterSnapshot: START_WALL + 31_600,
  afterContinued: START_WALL + 34_500,
}

/** Generate a long run of ordinary events, for the bounded-buffer test. */
export function longRun(count, fromSeq = 100) {
  const events = []
  for (let index = 0; index < count; index += 1) {
    const seq = fromSeq + index
    events.push(event(seq, 'speech', 40_000 + index * 100, `line ${String(index)}`))
  }
  return {
    fromCursor: 'c12',
    nextCursor: `c${String(fromSeq + count - 1)}`,
    isSnapshot: false,
    status: 'observing',
    events,
  }
}
