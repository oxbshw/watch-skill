/**
 * The canonical shapes the Python core sends.
 *
 * These are types over data the server owns, not a model the app maintains.
 * Nothing here is written by the UI: every field arrives in a snapshot or a
 * delta, and the app's job is to render it, not to decide it.
 */

export type EvidenceTab =
  | "observed"
  | "heard"
  | "browser"
  | "inferred"
  | "triggers"
  | "actions"
  | "verification";

export const EVIDENCE_TABS: readonly EvidenceTab[] = [
  "observed",
  "heard",
  "browser",
  "inferred",
  "triggers",
  "actions",
  "verification",
] as const;

export interface EvidenceRef {
  kind: string;
  artifact_id: string;
  media_ts: number;
}

export interface WorkspaceEvent {
  seq: number;
  media_ts: number;
  wall_ts: number;
  type: string;
  lane: string;
  tab: EvidenceTab;
  summary: string;
  confidence: number | null;
  provenance: "observation" | "inference" | null;
  detector: string;
  final: boolean;
  evidence: EvidenceRef[];
  /** True when a page authored any part of this. Rendered as a quoted
   *  specimen, never as text the workspace itself is asserting. */
  untrusted: boolean;
  redacted: boolean;
  navigation_epoch: number | null;
  detail: Record<string, unknown>;
}

export type SessionState =
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "finalized"
  | "failed";

export interface SessionSource {
  kind: string;
  target?: string;
  profile: string;
  fps: number;
}

export interface SessionStatus {
  session_id: string;
  state: SessionState;
  source: SessionSource;
  started_at: number;
  elapsed_seconds: number;
  last_seq: number;
  events_total: number;
  buffer_bytes: number;
  in_this_process: boolean;
  stats: Record<string, number | Record<string, number>>;
  /** Readiness per detector, `semantic` among them.
   *
   * Populated only for a session running in *this* process — the core says so
   * with `in_this_process`. A session read back from the store reports its
   * observations through the event log instead, which is the path that
   * survives a restart and the one the UI must not confuse for live state. */
  detectors?: Record<string, VisionStatus>;
  browser?: Record<string, unknown>;
  error?: { error: string; message: string; fix?: string } | null;
  finalized_video_id?: string | null;
}

export interface RailSession {
  session_id: string;
  state: SessionState;
  source_kind: string;
  started_at: number;
  elapsed_seconds: number;
  last_seq: number;
}

export interface VerificationAttempt {
  iteration: number;
  run_id: string;
  verdict: string;
  assurance: string;
  failure_signature: string;
  at: number;
  unavailable: boolean;
}

export interface ObserverRun {
  run_id: string;
  state: string;
  iteration: number;
  postcondition: { contract_id: string; contract_digest: string };
  budgets: Record<string, number>;
  spend: Record<string, unknown>;
  correction: {
    kind: string;
    summary: string;
    inputs: Record<string, unknown>;
    requires_approval: boolean;
  } | null;
  attempts: VerificationAttempt[];
  action_id: string | null;
  approval_id: string | null;
  session_id: string | null;
  stop_reason: string;
  finished: boolean;
  waiting_for_human: boolean;
  verified_by: string | null;
  /** The level the verdict was actually established at. Never omitted from a
   *  success: a green state whose oracle nobody can name is the exact claim
   *  this product exists to avoid making. */
  assurance?: string;
  oracle?: string;
}

export interface Approval {
  approval_id: string;
  action_id: string;
  effect_digest: string;
  summary: string;
  status: string;
  requested_at: number;
  expires_at: number | null;
  used: boolean;
}

export interface TriggerFiring {
  seq: number;
  cause_seq: number;
  media_ts: number;
  reason: string;
  suppressed: string;
  action_id: string | null;
}

export interface TriggerView {
  trigger_id: string;
  name: string;
  state: string;
  condition: string;
  dry_run: boolean;
  firings: TriggerFiring[];
  fired: number;
  suppressed: number;
}

export interface ChannelReceipt {
  channel: string;
  description: string;
  observed: boolean;
  count: number;
  first_media_ts: number | null;
  sample: string;
}

export interface SessionReceipt {
  session_id: string;
  complete: boolean;
  observed: string[];
  missing: string[];
  channels: ChannelReceipt[];
  totals: Record<string, number>;
}

export interface AssuranceLevel {
  level: string;
  proves: string;
  does_not_prove: string;
}

export interface Snapshot {
  schema_version: number;
  generated_at: number;
  session: SessionStatus | null;
  events: WorkspaceEvent[];
  cursor: number;
  rail: { sessions: RailSession[]; count: number; truncated: boolean };
  policy: Record<string, unknown>;
  assurance: {
    best_available: string;
    external: { available: boolean; reason: string; remedy: string };
    levels: AssuranceLevel[];
  };
  resources: {
    active_count: number;
    limit: number;
    configured_limit: number;
    available_memory_mb: number | null;
    memory_measurement_unavailable: boolean;
    admission: string;
    scope: string;
    refusals: number;
  };
  capabilities: Record<string, unknown>;
  observer: ObserverRun | null;
  approvals: Approval[];
  triggers: TriggerView[];
  receipt: SessionReceipt | null;
}

export interface Delta {
  session_id: string;
  state: SessionState;
  events: WorkspaceEvent[];
  count: number;
  after_seq: number;
  cursor: number;
  has_more: boolean;
  gap: boolean;
  session_version: number;
}

/** How the preview is actually being delivered.
 *
 * A snapshot is never labelled as continuous video: the distinction is the
 * difference between "you are watching this" and "this is what it looked like
 * a moment ago", and it matters most exactly when someone is deciding whether
 * to intervene.
 *
 * `stream` continuous session-scoped binary frames — LIVE VIDEO
 * `frames` bounded throttled frame updates — LIVE FRAMES
 * `snapshot` a periodic still — SNAPSHOT
 * `replay`  a finished session being reviewed — REPLAY
 * `none`    nothing to show, said plainly
 */
export type MediaTransport =
  | "stream"
  | "frames"
  | "snapshot"
  | "replay"
  | "none";

/** How fresh a model reading is, and therefore what it may be used for.
 *  Mirrors `watch_skill.live.semantic.Freshness` exactly. */
export type Freshness =
  | "current_state"
  | "stale_for_action"
  | "historical_evidence";

/** A model's reading of one frame, with everything needed to judge it.
 *
 * The timing block is not diagnostics. On a CPU backend an interpretation
 * takes tens of seconds, and a reading shown without its latency and its
 * frame timestamp is a claim about the present that is quietly about the
 * past. */
export interface SemanticObservation {
  media_ts: number;
  observation: string;
  entities: string[];
  actions: string[];
  ui_state: string;
  anomaly: string;
  uncertainty: string;
  confidence: number;
  provenance: {
    provider: string;
    model: string;
    kind: string;
    revision: string;
    worker_protocol_version: number;
    capture_kind: string;
  };
  frame: {
    sha256: string;
    seq: number;
    media_ts: number;
    captured_wall_ts: number;
  };
  timing: {
    inference_started_wall_ts: number;
    inference_completed_wall_ts: number;
    latency_ms: number;
    late_by_seconds: number;
  };
  freshness: Freshness;
  may_trigger_current_state_action: boolean;
  superseded: boolean;
  selected_because: string;
  evidence: string[];
  advisory: boolean;
  degraded: boolean;
  degraded_reason: string;
}

/** What the vision model is doing right now, as the session reports it. */
export interface VisionStatus {
  status: string;
  backend?: string;
  reason?: string;
  warm_state?: string;
  queued?: number;
  inflight?: boolean;
  interpreted?: number;
  budget_remaining?: number;
  last_skip_reason?: string;
  failures?: number;
}

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";
