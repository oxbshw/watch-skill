"use client";

/**
 * The workspace shell: fetch canonical state, render it, send commands back.
 *
 * The invariants that matter, all enforced here rather than in the parts:
 *
 * - Every reconnect re-snapshots. Component state is never treated as the
 *   truth after a gap, because the thing most likely to have changed while we
 *   were away is an approval.
 * - Deltas are cursor-based and additive; a reported gap forces a re-snapshot
 *   rather than rendering a hole nobody can see.
 * - Events are bounded in state. A long session must not grow memory without
 *   limit just because nobody closed the tab.
 * - Polling backs off when the document is hidden and stops when the session
 *   has ended — there is nothing further to learn about a finished session.
 * - Mutations carry a session version and an idempotency key, so a
 *   double-click is safe and a stale command is refused visibly.
 * - The preview transport is whatever the host says it can honour, and the
 *   label follows the transport rather than the other way around.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EvidencePanel,
  Header,
  ObserverPanel,
  Rail,
  ReceiptStrip,
  Stage,
  Timeline,
} from "./parts";
import VisionPanel from "./VisionPanel";
import type {
  ConnectionState,
  EvidenceTab,
  MediaTransport,
  Snapshot,
  WorkspaceEvent,
} from "@/types";
import type { WorkspaceTransport } from "@/transport";
import { PreviewDriver, percentile } from "@/preview";
import type { PreviewCapability } from "@/preview";

const MAX_EVENTS_IN_STATE = 1500;
const POLL_ACTIVE_MS = 700;
const POLL_HIDDEN_MS = 5000;
const MAX_BACKOFF_MS = 15_000;

function mergeEvents(
  previous: WorkspaceEvent[],
  incoming: WorkspaceEvent[],
): WorkspaceEvent[] {
  if (incoming.length === 0) return previous;
  // Deduplicate by sequence. A retried request or an overlapping batch must
  // not render the same event twice — a timeline that double-counts is worse
  // than one that is briefly behind.
  const seen = new Set(previous.map((event) => event.seq));
  const merged = previous.slice();
  for (const event of incoming) {
    if (!seen.has(event.seq)) {
      seen.add(event.seq);
      merged.push(event);
    }
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged.length > MAX_EVENTS_IN_STATE
    ? merged.slice(merged.length - MAX_EVENTS_IN_STATE)
    : merged;
}

export default function Workspace({
  transport,
}: {
  transport: WorkspaceTransport;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<WorkspaceEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<EvidenceTab>("browser");
  const [selected, setSelected] = useState<WorkspaceEvent | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameAgeMs, setFrameAgeMs] = useState<number | null>(null);
  const [fps, setFps] = useState<number>(0);

  const failures = useRef(0);
  const mounted = useRef(true);
  const driver = useRef<PreviewDriver | null>(null);

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute("data-theme", theme);
      try {
        localStorage.setItem("ws-theme", theme);
      } catch {
        // A host that blocks storage still gets the theme for this session.
      }
    }
  }, [theme]);

  const reload = useCallback(
    async (target?: string | null) => {
      try {
        const next = await transport.snapshot(target ?? sessionId);
        if (!mounted.current) return;
        setSnapshot(next);
        setEvents(next.events);
        setCursor(next.cursor);
        setSessionId(next.session?.session_id ?? null);
        setConnection("connected");
        setError(null);
        failures.current = 0;
      } catch (caught) {
        if (!mounted.current) return;
        failures.current += 1;
        setConnection(failures.current > 3 ? "offline" : "reconnecting");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [transport, sessionId],
  );

  // First render: one snapshot, always.
  useEffect(() => {
    void reload(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Incremental catch-up.
  useEffect(() => {
    const active = snapshot?.session;
    if (!active) return undefined;
    const finished =
      active.state === "finalized" ||
      active.state === "stopped" ||
      active.state === "failed";

    let timer: number | undefined;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      try {
        const delta = await transport.delta(active.session_id, cursor);
        if (cancelled || !mounted.current) return;
        if (delta.gap) {
          // A hole we cannot see is worse than a reload we can.
          await reload(active.session_id);
        } else if (delta.events.length > 0) {
          setEvents((previous) => mergeEvents(previous, delta.events));
          setCursor(delta.cursor);
        }
        setConnection("connected");
        failures.current = 0;
      } catch {
        if (cancelled || !mounted.current) return;
        failures.current += 1;
        setConnection(failures.current > 3 ? "offline" : "reconnecting");
      }
      if (cancelled) return;
      const backoff =
        failures.current > 0
          ? Math.min(POLL_ACTIVE_MS * 2 ** failures.current, MAX_BACKOFF_MS)
          : hidden
            ? POLL_HIDDEN_MS
            : POLL_ACTIVE_MS;
      timer = window.setTimeout(() => void tick(), backoff);
    };

    // A finished session has nothing further to say; poll slowly so a
    // reopened tab still notices a finalize, then stop.
    timer = window.setTimeout(
      () => void tick(),
      finished ? POLL_HIDDEN_MS : POLL_ACTIVE_MS,
    );
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [snapshot?.session, cursor, transport, reload]);

  // Periodically refresh the parts a delta does not carry — observer state,
  // approvals, resource pressure. Cheaper than pushing them per event.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void reload(sessionId);
    }, 2500);
    return () => window.clearInterval(id);
  }, [reload, sessionId]);

  // --- the preview ---------------------------------------------------------

  const capability = (snapshot as unknown as { preview?: PreviewCapability })
    ?.preview;
  const capabilityKey = capability
    ? `${capability.transport}:${capability.session ?? ""}`
    : "none";

  useEffect(() => {
    driver.current?.stop();
    driver.current = null;
    setFrameUrl(null);

    const base = transport.kind === "standalone" ? standaloneOrigin() : null;
    if (
      base === null ||
      !capability ||
      (capability.transport !== "frames" && capability.transport !== "stream")
    ) {
      return undefined;
    }

    const instance = new PreviewDriver(
      base,
      capability,
      (frame) => {
        if (!mounted.current) return;
        setFrameUrl(frame.url);
        setFrameAgeMs(instance.stats.frameAgeMs);
        setFps(instance.stats.fps);
      },
      () => {
        // A preview that cannot fetch is a degraded preview, not a broken
        // workspace. The evidence path is unaffected and keeps running.
        if (mounted.current) setFps(0);
      },
    );
    driver.current = instance;
    instance.start();
    return () => {
      instance.stop();
      driver.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilityKey, transport.kind]);

  // Exposed for the rendered proof: the numbers the preview is actually
  // delivering, read from the driver rather than recomputed from React state.
  useEffect(() => {
    const id = window.setInterval(() => {
      const stats = driver.current?.stats;
      if (!stats) return;
      (window as unknown as Record<string, unknown>)["__watchSkillPreview"] = {
        framesDrawn: stats.framesDrawn,
        framesDropped: stats.framesDropped,
        reconnects: stats.reconnects,
        fps: Number(stats.fps.toFixed(2)),
        frameAgeMs: stats.frameAgeMs,
        frameAgeP50: percentile(stats.ageSamples, 50),
        frameAgeP95: percentile(stats.ageSamples, 95),
        firstFrameMs: stats.firstFrameMs,
      };
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const mediaTransport: MediaTransport = useMemo(() => {
    if (!snapshot?.session) return "none";
    if (capability?.transport === "replay") return "replay";
    if (frameUrl !== null && capability?.transport === "frames") return "frames";
    if (frameUrl !== null && capability?.transport === "stream") return "stream";
    if (frameUrl !== null) return "snapshot";
    return "none";
  }, [snapshot?.session, capability?.transport, frameUrl]);

  const command = useCallback(
    async (name: string, args: Record<string, unknown> = {}) => {
      if (!snapshot?.session) return;
      setBusy(name);
      try {
        await transport.call(name, {
          ...args,
          session: snapshot.session.session_id,
          // The server decides whether this command is still applicable.
          session_version: snapshot.session.last_seq,
          idempotency_key: `${snapshot.session.session_id}:${name}:${snapshot.session.last_seq}`,
        });
        await reload(snapshot.session.session_id);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(null);
      }
    },
    [snapshot, transport, reload],
  );

  const approve = useCallback(
    async (approvalId: string) => {
      setBusy("approve");
      try {
        await transport.call("approve_action", { approval_id: approvalId });
        await reload(sessionId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(null);
      }
    },
    [transport, reload, sessionId],
  );

  const reject = useCallback(
    async (approvalId: string) => {
      setBusy("reject");
      try {
        await transport.call("reject_action", { approval_id: approvalId });
        await reload(sessionId);
      } finally {
        setBusy(null);
      }
    },
    [transport, reload, sessionId],
  );

  if (!snapshot) {
    return (
      <div className="shell">
        <div className="stage-empty" style={{ margin: "auto" }} role="status">
          <h3>{error ? "Cannot reach the workspace" : "Opening workspace…"}</h3>
          <p>{error ?? "Fetching canonical state from the Watch Skill core."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <Header
        snapshot={snapshot}
        transportKind={transport.kind}
        connection={connection}
        onToggleTheme={() =>
          setTheme((current) => (current === "dark" ? "light" : "dark"))
        }
      />
      <div className="body" data-rail={railCollapsed ? "collapsed" : "expanded"}>
        <Rail
          sessions={snapshot.rail.sessions}
          activeId={sessionId}
          collapsed={railCollapsed}
          onSelect={(id) => void reload(id)}
          onToggle={() => setRailCollapsed((v) => !v)}
          onNew={() => void reload(null)}
        />
        {/* A scrolling column, not a fixed grid. Grid rows sized `auto` let a
            tall observer panel overflow its track and paint over the controls
            beneath it — which made the approve button unclickable while still
            looking perfectly fine in a screenshot. */}
        <div className="center">
          <Stage
            session={snapshot.session}
            frameUrl={frameUrl}
            transport={mediaTransport}
            selected={selected}
            onCommand={(name) => void command(name)}
            busy={busy}
            frameAgeMs={frameAgeMs}
            fps={fps}
          />
          <VisionPanel
            events={events}
            vision={snapshot.session?.detectors?.["semantic"]}
          />
          <ObserverPanel
            observer={snapshot.observer}
            approvals={snapshot.approvals}
            onApprove={(id) => void approve(id)}
            onReject={(id) => void reject(id)}
            onCancel={() => void command("observer_cancel")}
            busy={busy}
          />
          <div>
            <Timeline
              events={events}
              selectedSeq={selected?.seq ?? null}
              onSelect={setSelected}
            />
            <ReceiptStrip receipt={snapshot.receipt} />
          </div>
        </div>
        <EvidencePanel
          events={events}
          triggers={snapshot.triggers}
          observer={snapshot.observer}
          approvals={snapshot.approvals}
          tab={tab}
          onTab={setTab}
          onSelect={setSelected}
          selectedSeq={selected?.seq ?? null}
        />
      </div>
      {error ? (
        <div className="banner" data-tone="bad" role="alert" style={{ margin: 10 }}>
          {error}
        </div>
      ) : (
        <div aria-live="polite" className="sr-only">
          {connection === "connected"
            ? `Connected. ${events.length} events.`
            : `Connection ${connection}.`}
        </div>
      )}
    </div>
  );
}

/** The origin the standalone build was served from.
 *
 * Read from the document rather than compiled in, for the same reason the API
 * base is: the bundle inside the Python package must contain no origin at all.
 */
function standaloneOrigin(): string | null {
  if (typeof document === "undefined") return null;
  const tag = document.querySelector('meta[name="watch-skill-api"]');
  if (tag === null) return null;
  return (tag.getAttribute("content") ?? "").replace(/\/$/, "");
}
