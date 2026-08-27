/**
 * Watch Bridge wire contracts.
 *
 * Watch Core's Pydantic models are the semantic source of truth (ADR-004).
 * CI in `watch-skill` emits JSON Schema 2020-12 with a version and digest, and
 * the types below are the TypeScript face of that schema. Until the generator
 * lands, these are maintained by hand against the same contract and the
 * handshake carries `schemaDigest` so a drift is a negotiated, visible failure
 * rather than a runtime surprise.
 *
 * This package is browser-safe on purpose: no Node imports, no runtime
 * identity to share (no Symbol, no instanceof, no singleton state), so a
 * client bundle can inline it without duplicating a shared instance.
 *
 * @module @watchskill/dsh-contracts
 */

/** The Bridge protocol version this build of the Workspace speaks. */
export const WATCH_PROTOCOL_VERSION = 1

/** The protocol range this build can negotiate down to. */
export const WATCH_PROTOCOL_MIN = 1

// ── capability truth ────────────────────────────────────────────────────────

/**
 * How much is actually known about a capability.
 *
 * The distinction is the point: a package existing on disk, a model appearing
 * in a catalog, and a real request succeeding are three different facts, and
 * the UI is never allowed to render the first as if it were the third.
 */
export type CapabilityStatus =
  /** Code exists and is wired, but nothing has been executed against it. */
  | 'implemented'
  /** A real request ran on this machine and succeeded. */
  | 'machine_tested'
  /** A cheap probe (version query, binary present, endpoint reachable) passed. */
  | 'probed'
  /** Known to be unusable here, with a reason. */
  | 'unavailable'
  /** Never checked. Not the same as unavailable. */
  | 'not_tested'

/** One capability's truth, as reported by Watch Core's doctor. */
export interface CapabilityTruth {
  readonly capabilityId: string
  /** Owning plugin or engine, and its version when one is known. */
  readonly provider: string | null
  readonly providerVersion: string | null
  readonly status: CapabilityStatus
  /** What the capability needs, and what was actually detected. */
  readonly requirements: readonly string[]
  readonly detected: Readonly<Record<string, string>>
  readonly missing: readonly string[]
  /** Concrete next steps. Never a bare "setup failed". */
  readonly fixes: readonly string[]
  /** ISO-8601. Null when the capability has never been checked. */
  readonly lastCheckedAt: string | null
}

// ── handshake ───────────────────────────────────────────────────────────────

/**
 * What Watch Core returns when the Bridge connects.
 *
 * A protocol mismatch disables only the affected Watch features. The rest of
 * the Workspace stays openable in degraded or review mode, and the reported
 * versions are what the UI shows instead of a generic failure.
 */
export interface HandshakeResult {
  readonly coreVersion: string
  readonly coreBuild: string | null
  /** The version both sides agreed on, within [WATCH_PROTOCOL_MIN, requested]. */
  readonly protocolVersion: number
  readonly capabilities: readonly CapabilityTruth[]
  /** Digest per contract family, so schema drift is detectable at connect time. */
  readonly schemaDigests: Readonly<Record<string, string>>
  readonly policy: PolicySummary
  readonly limits: BridgeLimits
}

/** The policy Watch Core is enforcing, surfaced so the UI never misstates it. */
export interface PolicySummary {
  /** When true, no non-loopback egress is permitted from any role. */
  readonly offlineOnly: boolean
  /** Cloud perception is a separate consent from holding a provider API key. */
  readonly cloudPerceptionOptIn: boolean
  /** Durable personal memory mode chosen by the user. */
  readonly memoryMode: MemoryMode
  /** Retention class defaults applied to newly captured artifacts. */
  readonly defaultRetentionClass: string
}

/** Durable memory modes a profile can be in (ADR-006). */
export type MemoryMode = 'off' | 'session_only' | 'local_personal' | 'workspace_shared'

/** Transport limits the client must respect. */
export interface BridgeLimits {
  readonly maxRequestBytes: number
  readonly maxInFlight: number
  /** Milliseconds. A request without its own deadline inherits this one. */
  readonly defaultDeadlineMs: number
}

// ── health ──────────────────────────────────────────────────────────────────

/** Connection state of the Bridge, as the Workspace understands it. */
export type BridgePhase =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  /** Connected, but the negotiated protocol excludes some requested features. */
  | 'degraded'
  | 'failed'

/** The health projection the browser half renders. */
export interface WatchCoreHealth {
  readonly phase: BridgePhase
  /** Which transport is in use, so the UI never guesses. */
  readonly transport: 'stdio' | 'https' | 'mock' | null
  readonly handshake: HandshakeResult | null
  /** Populated when phase is 'failed' or 'degraded'. */
  readonly error: WatchError | null
  /** ISO-8601 of the last state change. */
  readonly changedAt: string
}

// ── errors ──────────────────────────────────────────────────────────────────

/**
 * The structured error contract shared with Watch Core.
 *
 * `fix` is not optional prose: a failure the user cannot act on is a failure
 * the product has not finished reporting.
 */
export interface WatchError {
  /** Dotted, stable, machine-readable. For example `live.cursor_expired`. */
  readonly error: string
  readonly message: string
  readonly fix: string
  readonly details: Readonly<Record<string, unknown>>
  readonly retryable: boolean
  readonly correlationId: string | null
}

/**
 * The failure arm of {@link WatchResult}.
 *
 * Named separately so a helper that only ever fails can say so in its return
 * type, and callers can read `.error` without narrowing a union first.
 */
export interface WatchFailure {
  readonly ok: false
  readonly error: WatchError
}

/** Result envelope used across the Bridge; mirrors the DSH Remote convention. */
export type WatchResult<T> =
  | { readonly ok: true; readonly value: T }
  | WatchFailure

// ── evidence and verification ───────────────────────────────────────────────

/** How a piece of evidence came to exist. Inference is never an observation. */
export type EvidenceProvenance = 'observation' | 'deterministic_derivation' | 'inference'

/** A half-open time range on a source's own clock, in milliseconds. */
export interface TemporalRange {
  readonly startMs: number
  readonly endMs: number
}

/** A rectangle in a frame's coordinate space. */
export interface SpatialRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Whether an observation still describes the current state of its source. */
export type Freshness = 'current' | 'stale' | 'gap' | 'expired' | 'unavailable'

/**
 * The minimum an evidence record carries.
 *
 * Minted by Watch Core only (ADR-002). A plugin submits a candidate; it never
 * constructs one of these as fact. `confidence` is deliberately allowed to be
 * null: a producer with no calibrated confidence must not invent one.
 */
export interface EvidenceRecord {
  readonly evidenceId: string
  readonly sourceRevisionId: string
  readonly artifactIds: readonly string[]
  readonly temporalRange: TemporalRange | null
  readonly spatialRegion: SpatialRegion | null
  readonly modality: 'visual' | 'text' | 'audio' | 'dom' | 'network' | 'filesystem'
  readonly provenance: EvidenceProvenance
  readonly producer: string
  readonly producerVersion: string
  readonly captureQuality: string | null
  readonly gaps: readonly TemporalRange[]
  readonly freshness: Freshness
  readonly contentDigest: string
  readonly retentionClass: string
  readonly confidence: number | null
}

/**
 * The verdict taxonomy.
 *
 * `VERIFIED` is not a synonym for "the agent finished". Confidence never
 * promotes `UNVERIFIED` to `VERIFIED`, at any value.
 */
export type Verdict =
  /** An executable expectation passed against valid evidence. */
  | 'VERIFIED'
  /** A required check failed. */
  | 'FAILED'
  /** No executable expectation, or not enough evidence to decide. */
  | 'UNVERIFIED'
  /** Evidence conflicts, or its quality is insufficient. */
  | 'INCONCLUSIVE'
  /** The evidence no longer describes the current source revision. */
  | 'STALE'
  /** Policy, permission or a missing dependency prevented verification. */
  | 'BLOCKED'

/** Agent execution state — deliberately separate from evidence and verdict. */
export type AgentExecutionState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** One check inside a verification contract. */
export interface VerificationCheck {
  readonly checkId: string
  readonly kind: string
  readonly description: string
  readonly passed: boolean | null
  readonly evidenceRefs: readonly string[]
  readonly detail: string | null
}

/** The outcome of running a verification contract. */
export interface VerificationOutcome {
  readonly verificationId: string
  readonly verdict: Verdict
  /** Why the verdict is what it is, in one sentence the UI can show verbatim. */
  readonly reason: string
  readonly checks: readonly VerificationCheck[]
  readonly contractDigest: string
  readonly evaluatedAt: string
}

/**
 * The receipt for one side-effecting action.
 *
 * A successful dispatch is not a successful effect. The receipt is what makes
 * that distinction inspectable after the fact.
 */
export interface ActionReceipt {
  readonly receiptId: string
  readonly operationId: string
  readonly idempotencyKey: string
  readonly inputDigest: string
  readonly approvalId: string | null
  readonly preObservationEvidenceIds: readonly string[]
  readonly postObservationEvidenceIds: readonly string[]
  /** Every candidate the resolver considered, so ambiguity is auditable. */
  readonly targetCandidates: readonly string[]
  readonly resolvedTarget: string | null
  /** Populated when the action was refused rather than dispatched. */
  readonly ambiguityReason: string | null
  readonly verification: VerificationOutcome | null
  readonly retries: number
  readonly terminalState: 'dispatched' | 'refused' | 'cancel_requested' | 'unknown'
}

// ── selection ───────────────────────────────────────────────────────────────

/**
 * The one selection every surface responds to.
 *
 * A tool card, a citation, the player, the timeline, Trajectory and the
 * inspector are projections of this single value, which is also what a deep
 * link serializes. There is no separate "media timeline" truth.
 */
export interface WatchSelection {
  readonly workspaceId: string
  readonly sessionId: string
  readonly runId: string | null
  readonly eventId: string | null
  readonly evidenceId: string | null
  readonly temporalRange: TemporalRange | null
  readonly artifactId: string | null
  readonly inspectorTab: string | null
  /** Which surface initiated the change, so a surface can skip echoing itself. */
  readonly origin: string
  /** Whether this selection is being replayed rather than followed live. */
  readonly historyMode: boolean
}

// ── JSON-RPC envelopes ──────────────────────────────────────────────────────

/** A JSON-RPC 2.0 request as the Bridge sends it. */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly method: string
  readonly params?: unknown
}

/** A JSON-RPC 2.0 notification (no response expected). */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

/** A JSON-RPC 2.0 response as Watch Core returns it. */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number | string | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

/**
 * JSON-RPC error codes the Bridge assigns meaning to.
 *
 * The reserved range is JSON-RPC's own; the Watch range starts at -32000 and
 * is what carries a {@link WatchError} in `data`.
 */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Application error: `data` is a {@link WatchError}. */
  WATCH_ERROR: -32000,
} as const

// ── helpers ─────────────────────────────────────────────────────────────────

/** Construct a well-formed error result without repeating the envelope shape. */
export function watchError(
  error: string,
  message: string,
  fix: string,
  options: {
    readonly details?: Readonly<Record<string, unknown>>
    readonly retryable?: boolean
    readonly correlationId?: string | null
  } = {},
): WatchFailure {
  return {
    ok: false,
    error: {
      error,
      message,
      fix,
      details: options.details ?? {},
      retryable: options.retryable ?? false,
      correlationId: options.correlationId ?? null,
    },
  }
}

/**
 * Whether a verdict may be rendered with the success affordance.
 *
 * Kept here rather than in each surface so no renderer can quietly widen it.
 * `INCONCLUSIVE`, `STALE` and `UNVERIFIED` are honest outcomes, not degrees of
 * success, and never turn green.
 */
export function isSuccessVerdict(verdict: Verdict): boolean {
  return verdict === 'VERIFIED'
}

/**
 * Negotiate a protocol version against what the peer offers.
 * @returns the agreed version, or null when the ranges do not overlap.
 */
export function negotiateProtocol(peerMin: number, peerMax: number): number | null {
  const agreed = Math.min(peerMax, WATCH_PROTOCOL_VERSION)
  return agreed >= Math.max(peerMin, WATCH_PROTOCOL_MIN) ? agreed : null
}
export * from './presentation.js'
