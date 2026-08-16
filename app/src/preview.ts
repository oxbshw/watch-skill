/**
 * The live preview: latest frame wins, and it always says how old it is.
 *
 * The rules this enforces, none of which a naive `setInterval(() => img.src =
 * url + Date.now())` gets right:
 *
 * - **Bounded, latest-wins.** At most one frame request is in flight. If a
 *   fetch is slow, newer frames replace the pending target rather than
 *   queueing — a queue of stale frames is precisely what a live preview must
 *   not deliver, because by the time it drained none of it would be live.
 * - **Monotonic.** Frames never go backwards. An out-of-order response for an
 *   older media timestamp is dropped, counted, and not drawn.
 * - **Resumable.** The cursor is media time, so a reconnect asks for what
 *   comes after the last frame drawn instead of restarting the stream.
 * - **Honest.** Frame age, measured FPS and the reconnect count are reported
 *   so the interface can show what it is actually delivering.
 *
 * Object URLs are revoked as they are replaced. A preview that leaks one blob
 * per frame is a preview that ends a long session by exhausting the tab.
 */

export interface PreviewCapability {
  transport: "stream" | "frames" | "snapshot" | "replay" | "none";
  session?: string;
  token?: string;
  endpoint?: string;
  reason?: string;
}

export interface PreviewStats {
  framesDrawn: number;
  framesDropped: number;
  reconnects: number;
  fps: number;
  frameAgeMs: number | null;
  ageSamples: number[];
  firstFrameMs: number | null;
}

export interface PreviewFrame {
  url: string;
  mediaTs: number;
  wallTs: number;
  seq: number;
}

const MAX_AGE_SAMPLES = 300;

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.round((p / 100) * (ordered.length - 1))),
  );
  return ordered[index] ?? null;
}

/**
 * Drives one session's preview. Deliberately a plain class rather than a
 * hook so the loop can be started, stopped and measured without a React
 * render being involved in whether a frame is fetched.
 */
export class PreviewDriver {
  private timer: number | undefined;
  private stopped = false;
  private inFlight = false;
  private lastMediaTs = -1;
  private seq = 0;
  private currentUrl: string | null = null;
  private drawTimes: number[] = [];
  private startedAt = 0;

  readonly stats: PreviewStats = {
    framesDrawn: 0,
    framesDropped: 0,
    reconnects: 0,
    fps: 0,
    frameAgeMs: null,
    ageSamples: [],
    firstFrameMs: null,
  };

  constructor(
    private readonly base: string,
    private readonly capability: PreviewCapability,
    private readonly onFrame: (frame: PreviewFrame) => void,
    private readonly onError: (message: string) => void,
    private readonly intervalMs = 250,
  ) {}

  start(): void {
    this.stopped = false;
    this.startedAt = performance.now();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    if (this.currentUrl !== null) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  /** Resume from the last frame actually drawn, not from the beginning. */
  resume(): void {
    this.stats.reconnects += 1;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = window.setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const { session, token, endpoint } = this.capability;
    if (!session || !token || !endpoint) {
      this.onError("preview capability is incomplete");
      return;
    }
    // One request at a time. Skipping a tick is correct under pressure:
    // the next one will ask for whatever is newest by then.
    if (this.inFlight) {
      this.schedule(this.intervalMs);
      return;
    }
    this.inFlight = true;
    try {
      const metaUrl =
        `${this.base}${endpoint}/meta?session=${encodeURIComponent(session)}` +
        `&token=${encodeURIComponent(token)}&after=${this.lastMediaTs}`;
      const metaResponse = await fetch(metaUrl, {
        headers: { accept: "application/json" },
      });
      if (!metaResponse.ok) throw new Error(`meta HTTP ${metaResponse.status}`);
      const meta = (await metaResponse.json()) as {
        available?: boolean;
        media_ts?: number;
        wall_ts?: number;
      };

      if (meta.available === true && typeof meta.media_ts === "number") {
        if (meta.media_ts > this.lastMediaTs) {
          await this.fetchFrame(session, token, endpoint, meta.media_ts,
            meta.wall_ts ?? Date.now() / 1000);
        }
      }
    } catch (caught) {
      this.onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      this.inFlight = false;
      this.schedule(this.intervalMs);
    }
  }

  private async fetchFrame(
    session: string,
    token: string,
    endpoint: string,
    mediaTs: number,
    wallTs: number,
  ): Promise<void> {
    const url =
      `${this.base}${endpoint}/frame?session=${encodeURIComponent(session)}` +
      `&token=${encodeURIComponent(token)}&at=${mediaTs}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`frame HTTP ${response.status}`);
    // 204 means the frame the metadata promised is no longer in the buffer —
    // a sweep can retire it between the two calls. That is a normal race, not
    // an error, and the next tick will ask for whatever is newest by then.
    if (response.status === 204) {
      this.stats.framesDropped += 1;
      return;
    }
    const blob = await response.blob();
    if (blob.size === 0) {
      this.stats.framesDropped += 1;
      return;
    }

    // Monotonic. A response that lost a race describes an older moment than
    // what is already on screen, and drawing it would make the preview go
    // backwards in time.
    if (mediaTs <= this.lastMediaTs) {
      this.stats.framesDropped += 1;
      return;
    }
    this.lastMediaTs = mediaTs;
    this.seq += 1;

    const objectUrl = URL.createObjectURL(blob);
    const previous = this.currentUrl;
    this.currentUrl = objectUrl;
    if (previous !== null) URL.revokeObjectURL(previous);

    const now = performance.now();
    if (this.stats.firstFrameMs === null) {
      this.stats.firstFrameMs = Math.round(now - this.startedAt);
    }
    this.stats.framesDrawn += 1;

    const ageMs = Math.max(0, Date.now() - wallTs * 1000);
    this.stats.frameAgeMs = ageMs;
    this.stats.ageSamples.push(ageMs);
    if (this.stats.ageSamples.length > MAX_AGE_SAMPLES) {
      this.stats.ageSamples.shift();
    }

    this.drawTimes.push(now);
    while (this.drawTimes.length > 0 && now - (this.drawTimes[0] ?? 0) > 5000) {
      this.drawTimes.shift();
    }
    const windowMs = now - (this.drawTimes[0] ?? now);
    this.stats.fps =
      windowMs > 0 ? (this.drawTimes.length - 1) / (windowMs / 1000) : 0;

    this.onFrame({
      url: objectUrl,
      mediaTs,
      wallTs,
      seq: this.seq,
    });
  }
}
