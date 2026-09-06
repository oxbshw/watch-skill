/**
 * Rules about how results may be presented.
 *
 * These live in the contracts package rather than in a component because they
 * are product rules, not styling choices. "Green belongs to VERIFIED alone" is
 * the same commitment whether it is rendered by a React card, a terminal
 * summary or a CI annotation, and keeping it here means there is one place to
 * change it and one place to test it.
 *
 * Everything below is a pure function over data that already crossed the wire.
 * No DOM, no React, no Node.
 *
 * @module @deepwatch/dsh-contracts/presentation
 */

import type { Freshness, Verdict } from './index.js'

/** How a result is allowed to be presented. */
export type ResultTone = 'success' | 'error' | 'caution'

/**
 * The tone one verdict is rendered in.
 *
 * `INCONCLUSIVE`, `STALE`, `BLOCKED` and `UNVERIFIED` share the caution tone
 * on purpose. They are not failures, and styling them as errors teaches people
 * to dismiss them — which is how an unproven result comes to be accepted as a
 * proven one. They are also not successes, which is the more obvious half.
 */
export function verdictTone(verdict: Verdict): ResultTone {
  if (verdict === 'VERIFIED') return 'success'
  if (verdict === 'FAILED') return 'error'
  return 'caution'
}

/** The sentence to show when Watch Core supplied no reason of its own. */
const FALLBACK_REASON: Record<Verdict, string> = {
  VERIFIED: 'Every required check passed against valid evidence.',
  FAILED: 'A required check failed.',
  UNVERIFIED: 'Nothing executable was checked, so nothing was established.',
  INCONCLUSIVE: 'The evidence conflicts, or a check could not be run.',
  STALE: 'The evidence no longer describes the current source.',
  BLOCKED: 'Policy or a missing dependency prevented verification.',
}

/** Every verdict the taxonomy defines, for exhaustive validation. */
const VERDICTS = new Set<string>([
  'VERIFIED', 'FAILED', 'UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED',
])

/** Wording per freshness state, so the distinction survives without colour. */
const FRESHNESS_LABEL: Record<Freshness, string | null> = {
  current: null,
  stale: 'stale',
  gap: 'gap in capture',
  expired: 'expired',
  unavailable: 'freshness unknown',
}

/** How a freshness state should be labelled, or null when it needs no label. */
export function freshnessLabel(freshness: Freshness): string | null {
  return FRESHNESS_LABEL[freshness]
}

/** One check inside a verification contract, as a result carries it. */
export interface PresentableCheck {
  readonly checkId: string
  readonly kind: string
  readonly description: string | null
  /**
   * Tri-state on purpose. A check that could not run is not a check that
   * failed, and flattening the two turns "we did not look" into "it is broken"
   * — or, worse, the reverse.
   */
  readonly passed: boolean | null
  readonly detail: string | null
}

/** A verification result, ready to render. */
export interface PresentableVerdict {
  readonly verdict: Verdict
  readonly reason: string
  readonly checks: readonly PresentableCheck[]
  readonly contractDigest: string
  readonly assurance: string | null
}

/**
 * Parse a tool result into a verdict.
 *
 * Returns null rather than guessing. A result this cannot read renders as a
 * generic row, which is honest; inventing a verdict to fill a card would not
 * be.
 */
export function parseVerdict(value: unknown): PresentableVerdict | null {
  const record = asRecord(value)
  if (record === null) return null
  const verdict = record['verdict']
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return null
  const checks = Array.isArray(record['checks']) ? record['checks'] : []
  const reason = record['reason']
  return {
    verdict: verdict as Verdict,
    reason: typeof reason === 'string' && reason !== ''
      ? reason
      : FALLBACK_REASON[verdict as Verdict],
    checks: checks.flatMap(parseCheck),
    contractDigest: typeof record['contractDigest'] === 'string' ? record['contractDigest'] : '',
    assurance: typeof record['assurance'] === 'string' ? record['assurance'] : null,
  }
}

function parseCheck(value: unknown): PresentableCheck[] {
  const record = asRecord(value)
  if (record === null || typeof record['checkId'] !== 'string') return []
  return [{
    checkId: record['checkId'],
    kind: typeof record['kind'] === 'string' ? record['kind'] : 'check',
    description: typeof record['description'] === 'string' ? record['description'] : null,
    passed: typeof record['passed'] === 'boolean' ? record['passed'] : null,
    detail: typeof record['detail'] === 'string' ? record['detail'] : null,
  }]
}

/** One cited moment, ready to render. */
export interface PresentableCitation {
  readonly evidenceId: string
  readonly text: string
  /** Milliseconds into the source, or null for a citation with no timing. */
  readonly atMs: number | null
  readonly modality: string
  readonly provenance: string
  readonly freshness: Freshness
}

/** An evidence-linked answer, ready to render. */
export interface PresentableAnswer {
  readonly answer: string
  readonly citations: readonly PresentableCitation[]
  /** The engine's own assessment of whether it had enough to answer. */
  readonly groundedness: 'sufficient' | 'insufficient' | null
}

/**
 * Parse a source-query result into an answer.
 *
 * Returns null for a refusal or an unreadable payload, so a failure never
 * renders as a grounded answer with nothing behind it.
 */
export function parseAnswer(value: unknown): PresentableAnswer | null {
  const record = asRecord(value)
  if (record === null || record['ok'] !== true) return null
  if (typeof record['answer'] !== 'string') return null
  const evidence = Array.isArray(record['evidence']) ? record['evidence'] : []
  const groundedness = record['groundedness']
  return {
    answer: record['answer'],
    citations: evidence.flatMap(parseCitation),
    groundedness: groundedness === 'sufficient' || groundedness === 'insufficient'
      ? groundedness
      : null,
  }
}

function parseCitation(value: unknown): PresentableCitation[] {
  const record = asRecord(value)
  if (record === null || typeof record['evidenceId'] !== 'string') return []
  const range = asRecord(record['temporalRange'])
  const start = range === null ? undefined : range['startMs']
  const freshness = record['freshness']
  return [{
    evidenceId: record['evidenceId'],
    text: typeof record['text'] === 'string' ? record['text'] : '',
    atMs: typeof start === 'number' && Number.isFinite(start) ? start : null,
    modality: typeof record['modality'] === 'string' ? record['modality'] : 'text',
    provenance: typeof record['provenance'] === 'string' ? record['provenance'] : 'observation',
    // An unrecognized value becomes `unavailable`, never `current`. Defaulting
    // an unknown to the reassuring answer is exactly the wrong direction.
    freshness: typeof freshness === 'string' && freshness in FRESHNESS_LABEL
      ? freshness as Freshness
      : 'unavailable',
  }]
}

/**
 * Format a media position the way a person reads one.
 *
 * @returns `m:ss` under an hour, `h:mm:ss` above it, or null when there is no
 * usable timestamp — which a caller renders as no timestamp rather than as
 * `0:00`, because those mean different things.
 */
export function formatTimestamp(atMs: number | null): string | null {
  if (atMs === null || !Number.isFinite(atMs)) return null
  const total = Math.max(0, Math.floor(atMs / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  if (total < 3600) return `${String(Math.floor(total / 60))}:${seconds}`
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0')
  return `${String(Math.floor(total / 3600))}:${minutes}:${seconds}`
}

/** Narrow an unknown to a plain object, excluding null and arrays. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
