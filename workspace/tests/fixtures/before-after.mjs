/**
 * The same task, run twice, with one thing changed in between.
 *
 * A before/after fixture is only useful if the *interesting* difference is not
 * the first one. So this pair is arranged the way real runs are: several
 * innocuous divergences arrive before the one that matters, and the one that
 * matters is a verdict flipping from FAILED to VERIFIED.
 *
 * That ordering is the whole point. A surface that reports "first divergence"
 * sends someone to an extra OCR frame at 1.2s; a surface that reports "first
 * *meaningful* divergence" sends them to the moment the outcome changed.
 *
 * Everything here is fixed: sequences, timestamps, evidence ids and cursors.
 */

const BASE_TIME = 1_700_000_000_000

/** One DSH tool call event. */
export function toolCall(seq, callId, name) {
  return {
    type: 'tool/call',
    seq,
    time: BASE_TIME + seq,
    data: { callId, name, arguments: {}, turn: 1, step: seq },
  }
}

/** One DSH tool result event carrying a Watch payload. */
export function toolResult(seq, callId, value) {
  return {
    type: 'tool/result',
    seq,
    time: BASE_TIME + seq,
    data: {
      turn: 1,
      message: {
        source: { callId },
        content: [{ content: [{ type: 'text', text: JSON.stringify(value) }] }],
      },
    },
  }
}

/** An observation with evidence at one moment. */
function observation(evidenceId, atMs) {
  return {
    ok: true,
    answer: 'observed',
    groundedness: 'sufficient',
    evidence: [{
      evidenceId,
      sourceRevisionId: 'src@rev1',
      temporalRange: { startMs: atMs, endMs: atMs + 500 },
      modality: 'visual',
      provenance: 'observation',
      freshness: 'current',
    }],
  }
}

/** A verification result. */
function verification(verdict, verificationId, evidenceIds) {
  return { ok: true, verdict, verificationId, evidenceRefs: evidenceIds }
}

/**
 * The run before the fix.
 *
 * Observations at 1.2s, 3.4s and 9.0s, then a verification that failed.
 */
export const BEFORE_EVENTS = [
  toolCall(1, 'b1', 'watch_ask_source'),
  toolResult(2, 'b1', observation('ev_before_1', 1_200)),
  toolCall(3, 'b2', 'watch_ask_source'),
  toolResult(4, 'b2', observation('ev_before_2', 3_400)),
  toolCall(5, 'b3', 'watch_ask_source'),
  toolResult(6, 'b3', observation('ev_before_3', 9_000)),
  toolCall(7, 'b4', 'watch_verify'),
  toolResult(8, 'b4', verification('FAILED', 'ver_before', ['ev_before_3'])),
]

/**
 * The run after the fix.
 *
 * The 1.2s observation produced different evidence — an innocuous difference,
 * and the *earliest* one. The 3.4s observation is identical. The 9.0s
 * verification now passes, which is the difference somebody actually made.
 */
export const AFTER_EVENTS = [
  toolCall(1, 'a1', 'watch_ask_source'),
  toolResult(2, 'a1', observation('ev_after_1', 1_200)),
  toolCall(3, 'a2', 'watch_ask_source'),
  toolResult(4, 'a2', observation('ev_before_2', 3_400)),
  toolCall(5, 'a3', 'watch_ask_source'),
  toolResult(6, 'a3', observation('ev_after_3', 9_000)),
  toolCall(7, 'a4', 'watch_verify'),
  toolResult(8, 'a4', verification('VERIFIED', 'ver_after', ['ev_after_3'])),
]

/**
 * Modalities for the evidence in both runs.
 *
 * Supplied separately, the way a caller would supply resolved evidence: the
 * projection holds ids, and what sense produced them is a property of the
 * evidence rather than of the record.
 */
export const CHANNEL_HINTS = new Map([
  ['ev_before_1', { modality: 'visual' }],
  ['ev_after_1', { modality: 'visual' }],
  ['ev_before_2', { modality: 'audio' }],
  ['ev_before_3', { modality: 'dom' }],
  ['ev_after_3', { modality: 'dom' }],
])
