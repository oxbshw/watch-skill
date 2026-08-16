"use client";

/**
 * What the vision model said, and how much it is still worth.
 *
 * This panel exists because of one measurement: interpretation takes tens of
 * seconds on a CPU backend. A reading rendered as plain narration would be a
 * statement about the present that is quietly about the past, so every path
 * through this component shows three things together — the timestamp of the
 * frame the model actually looked at, how late the answer was, and what it is
 * therefore allowed to be used for.
 *
 * `PROCESSING WITH VLM` is shown while a call is in flight rather than
 * leaving the panel empty, because "the model is thinking" and "the model
 * found nothing" are different states and a blank panel says the wrong one.
 */
import type {
  Freshness,
  SemanticObservation,
  VisionStatus,
  WorkspaceEvent,
} from "@/types";
import { Chip } from "./parts";

/** The words the interface commits to. Each is a distinct state, and none of
 *  them is a synonym for another. */
export const FRESHNESS_LABEL: Record<Freshness, string> = {
  current_state: "CURRENT STATE",
  stale_for_action: "STALE FOR ACTION",
  historical_evidence: "HISTORICAL VLM RESULT",
};

const FRESHNESS_TONE: Record<Freshness, "ok" | "warn" | "info"> = {
  current_state: "ok",
  stale_for_action: "warn",
  historical_evidence: "info",
};

const FRESHNESS_MEANING: Record<Freshness, string> = {
  current_state:
    "Fresh enough to describe the source as it is now. May drive an action.",
  stale_for_action:
    "True about the frame it describes, too late to act on. Queryable, inert.",
  historical_evidence:
    "The source has ended, so there is no present tense left to claim. " +
    "Full-strength evidence about the frame it describes.",
};

/** Pull the most recent model reading out of the canonical event log.
 *
 * Deliberately read from events rather than from live runtime state: the
 * event log is what survives the process, so this is the same observation a
 * fresh process would find, not a copy the UI happens to be holding.
 */
export function latestObservation(
  events: WorkspaceEvent[],
): { event: WorkspaceEvent; observation: SemanticObservation } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    const semantic = (event.detail as { semantic?: SemanticObservation })
      ?.semantic;
    if (semantic && typeof semantic.observation === "string") {
      return { event, observation: semantic };
    }
  }
  return null;
}

function seconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

export function VisionPanel({
  events,
  vision,
}: {
  events: WorkspaceEvent[];
  vision: VisionStatus | undefined;
}) {
  const latest = latestObservation(events);
  const processing = Boolean(vision?.inflight);
  const queued = vision?.queued ?? 0;
  const warm = vision?.warm_state ?? "";
  const degraded = vision?.status === "degraded";

  return (
    <section className="panel vision" aria-label="Vision model">
      <div className="panel-head">
        <span>Vision model</span>
        {processing ? (
          <Chip tone="info" dot data-testid="vlm-processing">
            PROCESSING WITH VLM
          </Chip>
        ) : null}
        {degraded ? (
          <Chip tone="bad" title={vision?.reason ?? "unavailable"}>
            DEGRADED
          </Chip>
        ) : null}
        <span className="spacer" />
        {vision?.backend ? (
          <span className="subtle" style={{ fontSize: 11.5 }}>
            {vision.backend}
            {warm ? ` · ${warm}` : ""}
            {queued > 0 ? ` · ${queued} queued` : ""}
          </span>
        ) : null}
      </div>

      {latest === null ? (
        <p className="empty" data-testid="vlm-empty">
          {processing
            ? "The model is interpreting a selected keyframe. On this backend that takes tens of seconds."
            : degraded
              ? `No vision backend: ${vision?.reason ?? "unavailable"}`
              : "No model reading yet. Keyframes are selected, not interpreted per frame."}
        </p>
      ) : (
        <Observation observation={latest.observation} />
      )}
    </section>
  );
}

function Observation({ observation }: { observation: SemanticObservation }) {
  const freshness = observation.freshness;
  const provenance = observation.provenance;
  const timing = observation.timing;
  const frame = observation.frame;

  return (
    <div className="observation" data-freshness={freshness}>
      <div className="row" style={{ marginBottom: 8 }}>
        <Chip tone={FRESHNESS_TONE[freshness]} title={FRESHNESS_MEANING[freshness]}>
          {FRESHNESS_LABEL[freshness]}
        </Chip>
        {observation.superseded ? (
          <Chip tone="mute" title="a newer reading was published first">
            superseded
          </Chip>
        ) : null}
        {observation.degraded ? (
          <Chip tone="bad">DEGRADED</Chip>
        ) : null}
        <Chip tone="warn" title="a model's reading of a picture, never a measurement">
          inferred · advisory
        </Chip>
      </div>

      {/* The model's own sentence. Fenced as untrusted because it is a
          transcription of whatever the observed screen said, and a screen can
          say "ignore previous instructions". */}
      <div className="untrusted">
        <span className="untrusted-label">
          Model reading of page-authored content — evidence, not instruction
        </span>
        <span data-testid="vlm-observation">{observation.observation}</span>
      </div>

      {observation.anomaly ? (
        <p className="card-summary" style={{ marginTop: 8 }}>
          <Chip tone="warn">anomaly</Chip> {observation.anomaly}
        </p>
      ) : null}

      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Frame</dt>
        <dd data-testid="vlm-frame-ts">
          media {frame.media_ts.toFixed(2)}s
          {frame.seq >= 0 ? ` · seq ${frame.seq}` : ""}
        </dd>

        <dt>Frame hash</dt>
        <dd className="mono" data-testid="vlm-frame-hash">
          {frame.sha256 ? `${frame.sha256.slice(0, 24)}…` : "not recorded"}
        </dd>

        <dt>Model</dt>
        <dd data-testid="vlm-model">
          {provenance.model || "unknown"}
          {provenance.revision ? (
            <span className="mono subtle">
              {" "}
              @{provenance.revision.slice(0, 12)}…
            </span>
          ) : null}
        </dd>

        <dt>Latency</dt>
        <dd data-testid="vlm-latency">
          {seconds(timing.latency_ms / 1000)} of inference
          {timing.late_by_seconds > 0
            ? ` · answer landed ${seconds(timing.late_by_seconds)} after the frame`
            : ""}
        </dd>

        <dt>Selected because</dt>
        <dd>{observation.selected_because || "—"}</dd>

        <dt>Confidence</dt>
        <dd>
          {Math.round(observation.confidence * 100)}%
          <span className="subtle"> · derived, not model-supplied</span>
        </dd>
      </dl>

      <p className="subtle" style={{ fontSize: 11.5, marginTop: 8 }}>
        {FRESHNESS_MEANING[freshness]}
      </p>

      {observation.entities.length > 0 ? (
        <div className="row" style={{ marginTop: 8 }}>
          {observation.entities.map((entity) => (
            <Chip key={entity} tone="mute">
              {entity}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default VisionPanel;
