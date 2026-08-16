/**
 * How the workspace reaches canonical state.
 *
 * Two backends, one interface. Inside an MCP host the app calls the server's
 * existing tools through {@link App.callServerTool}; standalone — the local
 * dev host, and the Playwright proof — it calls a small HTTP endpoint that
 * serves the *same* canonical functions. Neither path lets the UI invent
 * state, which is the property that matters: swapping the transport must not
 * change what is true.
 *
 * Reconnect always re-snapshots. A client that reconnects and trusts its own
 * component state is a client that shows an approval somebody already
 * granted, or hides one still waiting.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import type { Delta, Snapshot } from "./types";

export interface WorkspaceTransport {
  readonly kind: "mcp" | "standalone";
  snapshot(sessionId?: string | null): Promise<Snapshot>;
  delta(sessionId: string, afterSeq: number): Promise<Delta>;
  /** A current-frame URL, or null when no preview is available. Always
   *  session-scoped and short-lived — never a filesystem path. */
  frameUrl(sessionId: string, seq: number): string | null;
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

const MAX_PAYLOAD_BYTES = 4_000_000;

/** Parse a canonical payload defensively.
 *
 * The host is not hostile, but a malformed or oversized message must produce
 * a clear error rather than a half-rendered workspace. Size is checked before
 * parse because the failure we are avoiding is memory, not correctness. */
function parsePayload<T>(raw: string, what: string): T {
  if (raw.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`${what} exceeded ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${what} was not an object`);
  }
  return parsed as T;
}

function textOf(result: unknown, what: string): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) throw new Error(`${what} had no content`);
  for (const block of content) {
    const candidate = block as { type?: string; text?: string };
    if (candidate?.type === "text" && typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  throw new Error(`${what} contained no text block`);
}

export class McpTransport implements WorkspaceTransport {
  readonly kind = "mcp" as const;

  constructor(private readonly app: App) {}

  async snapshot(sessionId?: string | null): Promise<Snapshot> {
    const result = await this.app.callServerTool({
      name: "workspace_snapshot",
      arguments: sessionId ? { session: sessionId } : {},
    });
    return parsePayload<Snapshot>(textOf(result, "snapshot"), "snapshot");
  }

  async delta(sessionId: string, afterSeq: number): Promise<Delta> {
    const result = await this.app.callServerTool({
      name: "workspace_delta",
      arguments: { session: sessionId, after_seq: afterSeq },
    });
    return parsePayload<Delta>(textOf(result, "delta"), "delta");
  }

  frameUrl(): string | null {
    // Frames reach a hosted app as resources, not URLs. Returning null here
    // makes the stage fall back to its honest "no preview" state rather than
    // fabricating a link the sandbox would refuse anyway.
    return null;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return this.app.callServerTool({ name: tool, arguments: args });
  }
}

export class StandaloneTransport implements WorkspaceTransport {
  readonly kind = "standalone" as const;

  constructor(private readonly base: string) {}

  private async get<T>(path: string, what: string): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`);
    return parsePayload<T>(await response.text(), what);
  }

  async snapshot(sessionId?: string | null): Promise<Snapshot> {
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    return this.get<Snapshot>(`/api/snapshot${query}`, "snapshot");
  }

  async delta(sessionId: string, afterSeq: number): Promise<Delta> {
    return this.get<Delta>(
      `/api/delta?session=${encodeURIComponent(sessionId)}&after_seq=${afterSeq}`,
      "delta",
    );
  }

  frameUrl(sessionId: string, seq: number): string | null {
    return `${this.base}/api/frame?session=${encodeURIComponent(sessionId)}&v=${seq}`;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.base}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, arguments: args }),
    });
    if (!response.ok) throw new Error(`${tool}: HTTP ${response.status}`);
    return JSON.parse(await response.text()) as unknown;
  }
}

/** Where a standalone build should talk to, if anywhere.
 *
 * The *presence* of the meta tag is the signal, not its value. The dev host
 * injects it empty, meaning "same origin" — which is what the bundle shipped
 * inside the Python package needs, because that build must contain no origin
 * at all and must not phone anywhere unless a host puts it somewhere that
 * serves the API. An absent tag means we are inside an MCP host.
 */
export function standaloneBase(): string | null {
  if (typeof document === "undefined") return null;
  const tag = document.querySelector('meta[name="watch-skill-api"]');
  if (tag === null) return null;
  return (tag.getAttribute("content") ?? "").replace(/\/$/, "");
}
