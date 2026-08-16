/**
 * The workspace's parts. Presentational — none of them decide anything.
 *
 * Two rules run through the whole file. Status is never carried by colour
 * alone: every state has a word, and an operator with a colour-vision
 * difference gets the same answer. And nothing a page authored is ever
 * rendered as prose the workspace appears to be asserting — it goes through
 * {@link Untrusted}, which fences and quotes it.
 */
"use client";

import { useMemo, useState } from "react";
import type {
  Approval,
  EvidenceTab,
  MediaTransport,
  ObserverRun,
  RailSession,
  SessionReceipt,
  SessionStatus,
  Snapshot,
  TriggerView,
  WorkspaceEvent,
} from "@/types";
import { EVIDENCE_TABS } from "@/types";

type Tone = "ok" | "bad" | "warn" | "info" | "mute";

export function Chip({
  tone = "mute",
  dot = false,
  children,
  title,
  "data-testid": testId,
}: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
  title?: string;
  "data-testid"?: string;
}) {
  return (
    <span className="chip" data-tone={tone} title={title} data-testid={testId}>
      {dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Mark() {
  return (
    <span className="mark">
      {/* Bundled inline. A remote icon would be a request the CSP forbids. */}
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.2" fill="none" stroke="var(--accent)" strokeWidth="1.9" />
        <circle cx="12" cy="12" r="3.4" fill="var(--accent)" />
      </svg>
      Watch&nbsp;Skill
    </span>
  );
}

const SESSION_TONE: Record<string, Tone> = {
  running: "ok",
  starting: "info",
  paused: "warn",
  stopping: "warn",
  stopped: "mute",
  finalized: "mute",
  failed: "bad",
};

/** The live badge. Never says LIVE for a session that has ended. */
export function SessionBadge({ session }: { session: SessionStatus | null }) {
  if (!session) return <Chip tone="mute">NO SESSION</Chip>;
  const label =
    session.state === "running"
      ? "LIVE"
      : session.state === "paused"
        ? "PAUSED"
        : session.state === "failed"
          ? "FAILED"
          : session.state === "finalized" || session.state === "stopped"
            ? "ENDED"
            : session.state.toUpperCase();
  const tone = SESSION_TONE[session.state] ?? "mute";
  return (
    <Chip tone={tone} dot={session.state === "running"}>
      {label}
    </Chip>
  );
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function Header({
  snapshot,
  transportKind,
  connection,
  onToggleTheme,
}: {
  snapshot: Snapshot;
  transportKind: string;
  connection: string;
  onToggleTheme: () => void;
}) {
  const session = snapshot.session;
  const media = session
    ? Number(
        (session.stats as Record<string, number>)?.["frames_captured"] ?? 0,
      ) / Math.max(session.source.fps, 0.001)
    : 0;
  const offline = Boolean(
    (snapshot.policy as { offline?: boolean }).offline,
  );
  const resources = snapshot.resources;
  return (
    <header className="header panel" style={{ margin: 10, marginBottom: 0 }}>
      <Mark />
      <span className="title" title={session?.session_id ?? "no session"}>
        {session ? session.session_id : "No session"}
      </span>
      {session ? (
        <Chip tone="mute">{session.source.kind}</Chip>
      ) : null}
      <SessionBadge session={session} />
      {connection !== "connected" ? (
        <Chip tone={connection === "offline" ? "bad" : "warn"}>
          {connection.toUpperCase()}
        </Chip>
      ) : null}
      <span className="clocks" aria-label="session clocks">
        <span title="media clock">media {clock(media)}</span>
        <span title="wall clock">
          wall {clock(session?.elapsed_seconds ?? 0)}
        </span>
      </span>
      <span className="spacer" />
      <Chip
        tone="info"
        title={
          snapshot.assurance.external.available
            ? "an external boundary is available"
            : snapshot.assurance.external.reason
        }
      >
        assurance: {snapshot.assurance.best_available}
      </Chip>
      <Chip tone={offline ? "ok" : "mute"}>
        {offline ? "offline" : "network allowed"}
      </Chip>
      <Chip
        tone={resources.memory_measurement_unavailable ? "warn" : "mute"}
        title={`admission: ${resources.admission}; scope: ${resources.scope}`}
      >
        browsers {resources.active_count}/{resources.limit}
        {resources.memory_measurement_unavailable ? " · unmeasured" : ""}
      </Chip>
      <Chip tone="mute">{transportKind}</Chip>
      <button className="ghost" onClick={onToggleTheme} aria-label="Toggle theme">
        ◐
      </button>
    </header>
  );
}

export function Rail({
  sessions,
  activeId,
  collapsed,
  onSelect,
  onToggle,
  onNew,
}: {
  sessions: RailSession[];
  activeId: string | null;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggle: () => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
      (s) =>
        s.session_id.toLowerCase().includes(needle) ||
        s.source_kind.toLowerCase().includes(needle),
    );
  }, [sessions, query]);

  return (
    <nav className="panel rail" aria-label="Sessions">
      <div className="panel-head">
        {!collapsed && <span>Sessions</span>}
        <span className="spacer" />
        <button
          className="ghost"
          onClick={onToggle}
          aria-label={collapsed ? "Expand session rail" : "Collapse session rail"}
          aria-expanded={!collapsed}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      {!collapsed && (
        <>
          <div style={{ padding: "8px 8px 0" }}>
            <button className="primary" style={{ width: "100%" }} onClick={onNew}>
              New watch
            </button>
          </div>
          <input
            className="search"
            placeholder="Search sessions"
            aria-label="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </>
      )}
      <div className="rail-list">
        {shown.length === 0 && !collapsed ? (
          <p className="empty">No sessions yet.</p>
        ) : null}
        {shown.map((s) => (
          <button
            key={s.session_id}
            className="rail-item"
            aria-current={s.session_id === activeId}
            onClick={() => onSelect(s.session_id)}
            title={`${s.session_id} — ${s.state}`}
          >
            <span
              className="dot"
              style={{
                color:
                  s.state === "running"
                    ? "var(--ok)"
                    : s.state === "failed"
                      ? "var(--bad)"
                      : "var(--ink-3)",
              }}
              aria-hidden="true"
            />
            {!collapsed && (
              <span className="rail-body">
                <span className="id">{s.session_id.replace(/^live_/, "")}</span>
                <span className="meta">
                  {s.source_kind} · {s.state} · {clock(s.elapsed_seconds)}
                </span>
              </span>
            )}
          </button>
        ))}
      </div>
    </nav>
  );
}

/** How each delivery mode is named, and what the name promises.
 *
 * These strings are load-bearing. "LIVE VIDEO" and "SNAPSHOT" are different
 * claims about whether what you are looking at is happening now, and the one
 * bug this table exists to prevent is a still image wearing the word LIVE.
 */
export const TRANSPORT_LABEL: Record<MediaTransport, string> = {
  stream: "LIVE VIDEO",
  frames: "LIVE FRAMES",
  snapshot: "SNAPSHOT",
  replay: "REPLAY",
  none: "NO PREVIEW",
};

const TRANSPORT_TONE: Record<MediaTransport, Tone> = {
  stream: "ok",
  frames: "ok",
  snapshot: "warn",
  replay: "info",
  none: "mute",
};

const TRANSPORT_MEANING: Record<MediaTransport, string> = {
  stream: "continuous session-scoped frames — you are watching this now",
  frames: "bounded throttled frame updates — live, but not every frame",
  snapshot: "a periodic still, not continuous video — this is what it looked like a moment ago",
  replay: "a finished session being reviewed — nothing here is happening now",
  none: "no preview is available for this session",
};

/** The live stage.
 *
 * A periodic still is labelled SNAPSHOT, never LIVE. The difference between
 * "you are watching this" and "this is what it looked like a moment ago"
 * matters most exactly when someone is deciding whether to intervene.
 */
export function Stage({
  session,
  frameUrl,
  transport,
  selected,
  onCommand,
  busy,
  frameAgeMs,
  fps,
}: {
  session: SessionStatus | null;
  frameUrl: string | null;
  transport: MediaTransport;
  selected: WorkspaceEvent | null;
  onCommand: (command: string) => void;
  busy: string | null;
  frameAgeMs?: number | null;
  fps?: number | null;
}) {
  const running = session?.state === "running";
  return (
    <section className="panel stage" aria-label="Live stage">
      <div className="panel-head">
        <span>Live stage</span>
        <Chip
          tone={TRANSPORT_TONE[transport]}
          dot={transport === "stream" || transport === "frames"}
          title={TRANSPORT_MEANING[transport]}
          data-testid="transport-label"
        >
          {TRANSPORT_LABEL[transport]}
        </Chip>
        <span className="spacer" />
        {typeof fps === "number" && fps > 0 ? (
          <span className="subtle" style={{ fontSize: 11.5 }}>
            {fps.toFixed(1)} fps
            {typeof frameAgeMs === "number"
              ? ` · frame ${(frameAgeMs / 1000).toFixed(1)}s old`
              : ""}
          </span>
        ) : null}
        {session ? (
          <span className="subtle" style={{ fontSize: 11.5 }}>
            {session.events_total} events · seq {session.last_seq}
          </span>
        ) : null}
      </div>

      <div className="stage-frame">
        {frameUrl ? (
          <img src={frameUrl} alt={`Current frame of ${session?.session_id}`} />
        ) : (
          <div className="stage-empty">
            <h3>{session ? "Waiting for the first frame" : "No session open"}</h3>
            <p>
              {session
                ? "Structured evidence is already arriving; the preview appears once a frame is captured."
                : "Start a watch from the rail, or call watch_live to begin observing a source."}
            </p>
          </div>
        )}
        <div className="stage-overlay">
          {selected ? (
            <Chip tone="info">
              @{selected.media_ts.toFixed(2)}s · {selected.type}
            </Chip>
          ) : null}
          {session?.error ? <Chip tone="bad">{session.error.error}</Chip> : null}
        </div>
      </div>

      <div className="stage-bar">
        <button
          onClick={() => onCommand(running ? "pause" : "resume")}
          disabled={!session || busy !== null || session.state === "failed"}
        >
          {busy === "pause" || busy === "resume"
            ? "Working…"
            : running
              ? "Pause"
              : "Resume"}
        </button>
        <button
          onClick={() => onCommand("stop")}
          disabled={!session || busy !== null || !running}
        >
          {busy === "stop" ? "Stopping…" : "Stop"}
        </button>
        <button
          onClick={() => onCommand("finalize")}
          disabled={!session || busy !== null || running}
        >
          Finalize
        </button>
        <span className="spacer" />
        {session ? (
          <span className="subtle" style={{ fontSize: 11.5 }}>
            {session.source.fps} fps · {session.source.profile}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/** Page-authored text, fenced.
 *
 * Shown in full and quoted. Dropping it would hide an attack from the person
 * who most needs to see it; rendering it plainly would let a page issue what
 * looks like an instruction inside our own interface.
 */
export function Untrusted({ text }: { text: string }) {
  return (
    <div className="untrusted">
      <span className="untrusted-label">
        Untrusted — text written by the observed page
      </span>
      <span>{text}</span>
    </div>
  );
}

function confidenceLabel(value: number | null): string {
  if (value === null || value === undefined) return "";
  return `${Math.round(value * 100)}%`;
}

export function EvidenceCard({
  event,
  onSelect,
  selected,
}: {
  event: WorkspaceEvent;
  onSelect: (event: WorkspaceEvent) => void;
  selected: boolean;
}) {
  const inference = event.provenance === "inference";
  return (
    <article
      className="card"
      data-provenance={event.provenance ?? "observation"}
      data-selected={selected}
      style={selected ? { outline: "2px solid var(--accent)" } : undefined}
    >
      <div className="card-head">
        <button
          className="ghost"
          style={{ padding: 0, minHeight: 0, border: 0 }}
          onClick={() => onSelect(event)}
          aria-label={`Seek to ${event.media_ts.toFixed(2)} seconds`}
        >
          <span className="card-ts">{event.media_ts.toFixed(2)}s</span>
        </button>
        <Chip tone={inference ? "warn" : "info"}>
          {inference ? "inferred" : "observed"}
        </Chip>
        <span>{event.type}</span>
        {event.detector ? <span className="subtle">· {event.detector}</span> : null}
        {event.confidence !== null && inference ? (
          <span className="subtle">· {confidenceLabel(event.confidence)}</span>
        ) : null}
        {event.redacted ? <Chip tone="mute">redacted</Chip> : null}
        {event.navigation_epoch ? (
          <span className="subtle">· epoch {event.navigation_epoch}</span>
        ) : null}
      </div>

      {event.untrusted ? (
        <Untrusted text={event.summary} />
      ) : (
        <p className="card-summary">{event.summary}</p>
      )}

      {event.evidence.length > 0 ? (
        <div className="row" style={{ marginTop: 6 }}>
          {event.evidence.map((ref) => (
            <Chip key={ref.artifact_id} tone="mute" title={ref.artifact_id}>
              {ref.kind}
            </Chip>
          ))}
        </div>
      ) : null}

      <details className="raw">
        <summary>Structured detail</summary>
        <pre>{JSON.stringify(event.detail, null, 1)}</pre>
      </details>
    </article>
  );
}

export function EvidencePanel({
  events,
  triggers,
  observer,
  approvals,
  tab,
  onTab,
  onSelect,
  selectedSeq,
}: {
  events: WorkspaceEvent[];
  triggers: TriggerView[];
  observer: ObserverRun | null;
  approvals: Approval[];
  tab: EvidenceTab;
  onTab: (tab: EvidenceTab) => void;
  onSelect: (event: WorkspaceEvent) => void;
  selectedSeq: number | null;
}) {
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const event of events) out[event.tab] = (out[event.tab] ?? 0) + 1;
    out["triggers"] = triggers.reduce((n, t) => n + t.firings.length, 0);
    out["actions"] = approvals.length + (observer?.action_id ? 1 : 0);
    out["verification"] = observer?.attempts.length ?? 0;
    return out;
  }, [events, triggers, observer, approvals]);

  const shown = useMemo(
    () => events.filter((event) => event.tab === tab).slice(-200).reverse(),
    [events, tab],
  );

  return (
    <section className="panel evidence" aria-label="Evidence">
      <div className="tabs" role="tablist" aria-label="Evidence categories">
        {EVIDENCE_TABS.map((name) => (
          <button
            key={name}
            role="tab"
            className="tab"
            aria-selected={tab === name}
            onClick={() => onTab(name)}
          >
            {name} <span className="count">{counts[name] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="cards" role="tabpanel" aria-label={`${tab} evidence`}>
        {tab === "triggers" ? (
          <TriggerList triggers={triggers} />
        ) : tab === "verification" ? (
          <VerificationList observer={observer} />
        ) : tab === "actions" ? (
          <ApprovalList approvals={approvals} observer={observer} />
        ) : shown.length === 0 ? (
          <p className="empty">Nothing in {tab} yet.</p>
        ) : (
          shown.map((event) => (
            <EvidenceCard
              key={event.seq}
              event={event}
              onSelect={onSelect}
              selected={event.seq === selectedSeq}
            />
          ))
        )}
      </div>
    </section>
  );
}

function TriggerList({ triggers }: { triggers: TriggerView[] }) {
  if (triggers.length === 0) return <p className="empty">No triggers defined.</p>;
  return (
    <>
      {triggers.map((trigger) => (
        <article className="card" key={trigger.trigger_id}>
          <div className="card-head">
            <span className="card-ts">{trigger.trigger_id.slice(0, 12)}</span>
            <Chip tone={trigger.state === "enabled" ? "ok" : "mute"}>
              {trigger.state}
            </Chip>
            <span>{trigger.condition}</span>
            {trigger.dry_run ? <Chip tone="warn">dry run</Chip> : null}
          </div>
          <p className="card-summary">
            {trigger.fired} fired · {trigger.suppressed} suppressed
          </p>
          {trigger.firings.slice(-4).map((firing) => (
            <div key={firing.seq} className="card-head" style={{ marginTop: 4 }}>
              <span className="card-ts">{firing.media_ts.toFixed(2)}s</span>
              <span className="subtle">{firing.reason}</span>
              {firing.suppressed ? (
                <Chip tone="mute">suppressed: {firing.suppressed}</Chip>
              ) : (
                <Chip tone="warn">fired</Chip>
              )}
            </div>
          ))}
        </article>
      ))}
    </>
  );
}

function VerificationList({ observer }: { observer: ObserverRun | null }) {
  if (!observer || observer.attempts.length === 0) {
    return <p className="empty">No verification attempts yet.</p>;
  }
  return (
    <>
      {[...observer.attempts].reverse().map((attempt) => (
        <article className="card" key={`${attempt.iteration}-${attempt.run_id}`}>
          <div className="card-head">
            <span className="card-ts">#{attempt.iteration}</span>
            <Chip
              tone={
                attempt.verdict === "pass"
                  ? "ok"
                  : attempt.unavailable
                    ? "warn"
                    : "bad"
              }
            >
              {attempt.verdict}
            </Chip>
            {attempt.assurance ? (
              <span className="subtle">· {attempt.assurance}</span>
            ) : null}
          </div>
          <p className="card-summary" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>
            {attempt.run_id || "no run id"}
          </p>
        </article>
      ))}
    </>
  );
}

function ApprovalList({
  approvals,
  observer,
}: {
  approvals: Approval[];
  observer: ObserverRun | null;
}) {
  if (approvals.length === 0 && !observer?.action_id) {
    return <p className="empty">No actions proposed.</p>;
  }
  return (
    <>
      {approvals.map((approval) => (
        <article className="card" key={approval.approval_id}>
          <div className="card-head">
            <span className="card-ts">{approval.approval_id.slice(0, 12)}</span>
            <Chip tone={approval.status === "pending" ? "warn" : "mute"}>
              {approval.status}
            </Chip>
            {approval.used ? <Chip tone="mute">spent</Chip> : null}
          </div>
          <p className="card-summary">{approval.summary}</p>
          <p className="subtle" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
            effect {approval.effect_digest.slice(0, 26)}…
          </p>
        </article>
      ))}
    </>
  );
}

const OBSERVER_TONE: Record<string, Tone> = {
  verified: "ok",
  failed: "bad",
  exhausted: "bad",
  verification_failed: "bad",
  awaiting_approval: "warn",
  correction_proposed: "warn",
  cancelled: "mute",
};

/** The verification workspace.
 *
 * A success here always names the oracle and the assurance level it was
 * established at. A green word on its own would be the exact claim this
 * product exists to avoid making.
 */
export function ObserverPanel({
  observer,
  approvals,
  onApprove,
  onReject,
  onCancel,
  busy,
}: {
  observer: ObserverRun | null;
  approvals: Approval[];
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
  onCancel: () => void;
  busy: string | null;
}) {
  if (!observer) {
    return (
      <section className="panel" aria-label="Verification">
        <div className="panel-head">Verification</div>
        <p className="empty">
          No Observer run for this session. Success has not been declared, so
          nothing is being checked.
        </p>
      </section>
    );
  }

  const tone = OBSERVER_TONE[observer.state] ?? "info";
  const pending = approvals.find((a) => a.approval_id === observer.approval_id);
  const assurance = observer.assurance || "";

  return (
    <section className="panel" aria-label="Verification">
      <div className="panel-head">
        Verification
        <span className="spacer" />
        <span className="subtle" style={{ fontSize: 11.5 }}>
          iteration {observer.iteration}/{observer.budgets["max_iterations"]}
        </span>
      </div>
      <div className="observer">
        <div className="verdict" data-state={observer.state} role="status">
          <Chip tone={tone}>{observer.state.replace(/_/g, " ")}</Chip>
          <span className="verdict-text">
            <span className="verdict-title">
              {observer.state === "verified"
                ? `Verified by a deterministic oracle at ${assurance || "unknown"} assurance`
                : observer.stop_reason || "In progress"}
            </span>
            {observer.state === "verified" && observer.verified_by ? (
              <span className="verdict-sub">
                run {observer.verified_by} · postcondition{" "}
                {observer.postcondition.contract_id}
              </span>
            ) : null}
          </span>
        </div>

        <dl className="kv">
          <dt>Postcondition</dt>
          <dd>{observer.postcondition.contract_id}</dd>
          <dt>Digest</dt>
          <dd className="mono">
            {observer.postcondition.contract_digest.slice(0, 30)}…
          </dd>
          <dt>Assurance</dt>
          <dd>{assurance || "not yet established"}</dd>
          <dt>Attempts</dt>
          <dd>
            {observer.attempts.length} ·{" "}
            {observer.attempts.map((a) => a.verdict).join(", ") || "none"}
          </dd>
        </dl>

        {observer.correction ? (
          <div className="effect">
            <strong style={{ fontSize: 12 }}>Proposed correction</strong>
            <p className="subtle" style={{ margin: "3px 0 0", fontSize: 12 }}>
              {observer.correction.summary}
            </p>
            <pre>{JSON.stringify(observer.correction.inputs, null, 1)}</pre>
          </div>
        ) : null}

        {pending ? (
          <div className="row">
            <button
              className="primary"
              onClick={() => onApprove(pending.approval_id)}
              disabled={busy !== null}
            >
              {busy === "approve" ? "Approving…" : "Approve this exact effect"}
            </button>
            <button
              className="danger"
              onClick={() => onReject(pending.approval_id)}
              disabled={busy !== null}
            >
              Reject
            </button>
          </div>
        ) : null}

        {!observer.finished ? (
          <button className="ghost" onClick={onCancel} disabled={busy !== null}>
            Cancel run
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function Timeline({
  events,
  selectedSeq,
  onSelect,
}: {
  events: WorkspaceEvent[];
  selectedSeq: number | null;
  onSelect: (event: WorkspaceEvent) => void;
}) {
  const lanes = useMemo(() => {
    const grouped = new Map<string, WorkspaceEvent[]>();
    for (const event of events) {
      const list = grouped.get(event.lane) ?? [];
      list.push(event);
      grouped.set(event.lane, list);
    }
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);

  const span = useMemo(
    () => Math.max(1, ...events.map((e) => e.media_ts)),
    [events],
  );

  if (events.length === 0) {
    return (
      <section className="panel timeline" aria-label="Timeline">
        <p className="empty">The timeline fills as evidence arrives.</p>
      </section>
    );
  }

  return (
    <section className="panel timeline" aria-label="Timeline">
      <div className="timeline-head">
        <strong style={{ fontSize: 12.5 }}>Timeline</strong>
        <span className="subtle" style={{ fontSize: 11.5 }}>
          {events.length} events over {span.toFixed(1)}s
        </span>
      </div>
      {lanes.map(([lane, items]) => (
        <div className="lane" key={lane}>
          <span className="lane-name" title={lane}>
            {lane}
          </span>
          <div className="lane-track">
            {/* Bounded: a long session must not create a DOM node per event. */}
            {items.slice(-120).map((event) => (
              <button
                key={event.seq}
                className="marker"
                data-lane={lane}
                aria-pressed={event.seq === selectedSeq}
                style={{ left: `${(event.media_ts / span) * 100}%` }}
                title={`${event.media_ts.toFixed(2)}s — ${event.summary.slice(0, 80)}`}
                onClick={() => onSelect(event)}
                aria-label={`${lane} at ${event.media_ts.toFixed(2)} seconds: ${event.summary.slice(0, 60)}`}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="axis">
        <span>0.00s</span>
        <span>{span.toFixed(2)}s</span>
      </div>
    </section>
  );
}

export function ReceiptStrip({ receipt }: { receipt: SessionReceipt | null }) {
  if (!receipt) return null;
  return (
    <div className="row" style={{ padding: "0 12px 10px" }}>
      <span className="subtle" style={{ fontSize: 11.5 }}>
        capture receipt:
      </span>
      {receipt.channels.map((channel) => (
        <Chip
          key={channel.channel}
          tone={channel.observed ? "ok" : "mute"}
          title={`${channel.description} — ${channel.observed ? `${channel.count} seen` : "none seen"}`}
        >
          {channel.observed ? "✓" : "—"} {channel.channel}
        </Chip>
      ))}
    </div>
  );
}
