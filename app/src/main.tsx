/**
 * Entry point. Picks the transport, then gets out of the way.
 *
 * Inside an MCP host the official `useApp` hook connects over postMessage and
 * the app talks to the Python server through the host. Standalone — the dev
 * host and the Playwright proof — it talks to the same canonical functions
 * over a small local endpoint. The UI code is identical either way, which is
 * the point: swapping the transport must not change what is true.
 */
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables } from "@modelcontextprotocol/ext-apps/react";
import App from "./App";
import { McpTransport, StandaloneTransport, standaloneBase } from "./transport";
import "./styles.css";

function Hosted() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "watch-skill-workspace", version: "0.1.0" },
    capabilities: {},
  });
  useHostStyleVariables(app);

  const transport = useMemo(() => (app ? new McpTransport(app) : null), [app]);

  if (error) {
    return (
      <div className="stage-empty" style={{ margin: "auto" }} role="alert">
        <h3>Host connection failed</h3>
        <p>{error.message}</p>
      </div>
    );
  }
  if (!isConnected || !transport) {
    return (
      <div className="stage-empty" style={{ margin: "auto" }} role="status">
        <h3>Connecting to host…</h3>
        <p>Waiting for the MCP App handshake.</p>
      </div>
    );
  }
  return <App transport={transport} />;
}

function Root() {
  const base = standaloneBase();
  if (base !== null) {
    return <App transport={new StandaloneTransport(base)} />;
  }
  return <Hosted />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
