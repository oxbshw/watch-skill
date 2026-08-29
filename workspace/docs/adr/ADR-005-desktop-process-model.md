# ADR-005: Desktop process and security model

- Status: Accepted
- Date: 2026-08-27

## Context

The product already needs a full Node runtime for DSH and a Python runtime for
Watch Core. Desktop must add native capture, keychain and supervision without
producing a second user interface to maintain.

## Decision

Electron hosts **the same Workspace packages** as Web. Desktop adds bootstrap
and native capability only; it never forks the UI.

| Process | Owns | Does not own |
|---|---|---|
| Electron main | lifecycle, windows, updates, child supervision, native dialogs | domain UI, untrusted plugin execution |
| Preload | typed minimal IPC | a raw filesystem or process bridge |
| Renderer | the Watch Workspace UI | Node integration, direct filesystem |
| DSH Host | Cordis, sessions, tools, plugins | Electron APIs |
| Watch Core | perception, evidence, verification | unnegotiated native commands |

Security invariants: `nodeIntegration: false`, `contextIsolation: true`,
renderer sandbox, strict CSP, IPC sender validation, navigation and new-window
allowlists, native permission requests denied by default, no raw secrets in
argv or logs, signed full-package updates with no remote code patching, and
child processes killed by instance-scoped identity rather than by process-name
scan.

Startup order: single-instance lock → app-data paths and migration preflight →
one-time bootstrap secret → DSH Host on `127.0.0.1` with a random port → Watch
Core start and protocol handshake → readiness before the trusted renderer
origin opens. Shutdown stops admission, applies the settle-or-cancel policy,
flushes receipts, and terminates owned children.

## Rejected alternative

**Tauri.** It adds a Rust toolchain and a system WebView without removing the
Node or Python runtimes, producing three runtimes and divergent rendering
between Web and Desktop. Electron's size is accepted in exchange for fidelity,
and is mitigated by lazy plugin activation.
