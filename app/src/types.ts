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
  detectors?: Record<string, { status: string; reason?: string }>;
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

/** How the preview is actually being delivered. A snapshot is never labelled
 *  as continuous video: the distinction is the difference between "you are
 *  watching this" and "this is what it looked like a moment ago". */
export type MediaTransport = "stream" | "snapshot" | "none";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";
