"use client";

/**
 * Transport selection, and nothing else.
 *
 * Which backend the workspace talks to is decided once, here, at mount:
 * inside an MCP host it is the official SDK's `App`; standalone — the dev
 * host and the Playwright proof — it is the HTTP endpoint that serves the
 * *same* canonical functions. Swapping the transport must not change what is
 * true, so the shell below this never learns which one it got.
 *
 * This is a client component and the page is statically exported. There is no
 * server render of session state to speak of: the canonical state lives in
 * the Python core, and pre-rendering a stale copy of it into the HTML would
 * mean shipping a workspace that shows yesterday's session for one frame.
 */
import { useEffect, useState } from "react";
import Workspace from "@/components/Workspace";
import { StandaloneTransport, standaloneBase } from "@/transport";
import type { WorkspaceTransport } from "@/transport";

export default function Page() {
  const [transport, setTransport] = useState<WorkspaceTransport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const base = standaloneBase();
    if (base !== null) {
      setTransport(new StandaloneTransport(base));
      return () => {
        cancelled = true;
      };
    }

    // Loaded lazily so the standalone build never pulls the MCP SDK into its
    // first chunk, and so a host that cannot provide it fails with a sentence
    // rather than a blank frame.
    void (async () => {
      try {
        const [{ App }, { McpTransport }] = await Promise.all([
          import("@modelcontextprotocol/ext-apps"),
          import("@/transport"),
        ]);
        const app = new App({
          name: "watch-skill-workspace",
          version: "0.2.0",
        });
        await app.connect();
        if (!cancelled) setTransport(new McpTransport(app));
      } catch (caught) {
        if (!cancelled) {
          setFailure(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (failure !== null) {
    return (
      <div className="shell">
        <div className="stage-empty" style={{ margin: "auto" }} role="alert">
          <h3>No workspace transport</h3>
          <p>
            This build is not running inside an MCP host and no local API was
            declared. {failure}
          </p>
        </div>
      </div>
    );
  }

  if (transport === null) {
    return (
      <div className="shell">
        <div className="stage-empty" style={{ margin: "auto" }} role="status">
          <h3>Opening workspace…</h3>
          <p>Connecting to the Watch Skill core.</p>
        </div>
      </div>
    );
  }

  return <Workspace transport={transport} />;
}
