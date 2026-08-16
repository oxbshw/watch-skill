# Season: Product Completion — execution ledger

A running record of what was built, what was proved, and what remains. One row
per slice, updated when the slice commits. Proof classification is deliberate:
**machine-tested** means it ran against real hardware/processes on this
machine, **real-model-tested** means a real model produced the output,
**deterministic-tested** means a controlled stand-in proved the transport and
contract, **implemented-only** means code exists and unit tests pass but no
end-to-end proof ran.

## Inherited state (verified at session start)

| Fact | Value |
| --- | --- |
| Repository | `oxbshw/watch-skill` |
| Branch | `feat/v2-live-vision` |
| HEAD | `20d2e19` |
| Working tree | clean |
| Local commits ahead of `origin/main` | 24 |
| `origin/main` | `cb3c430` |
| Offline suite | 1218 passed, 18 skipped, 0 failed |
| Ruff | clean |
| Pushed / merged / tagged / released | none |

Environment: Windows 10 Pro, Python 3.11.15 (`.venv`), Node v22.18.0,
npm 11.8.0, Playwright 1.61.0 with Chromium 1228 present.

## Slices

| # | Slice | Status | Commit | Proof |
| --- | --- | --- | --- | --- |
| 1 | Production live browser source | **done** | `8825f07`, `HEAD` | machine-tested |
| 2 | Persistent temporal entities and actions | pending | — | — |
| 3 | Durable deterministic triggers | pending | — | — |
| 4 | Verification Oracle SDK | pending | — | — |
| 5 | Observer Loop | pending | — | — |
| 6 | MCP App / live workspace | pending | — | — |
| 7 | Plugin protocol and adapters | pending | — | — |
| 8 | Typed SDKs | pending | — | — |
| 9 | Skill consolidation | pending | — | — |
| 10 | Pulse and observability | pending | — | — |
| 11 | Security and privacy hardening | pending | — | — |
| 12 | Documentation, examples, packaging | pending | — | — |

## Slice 1 — production live browser source

Two synchronized channels from one Chromium page: real JPEG frames through the
existing scene-change / OCR / rolling-buffer / clip machinery, and structured
evidence (navigation, console, page errors, failed requests, response
metadata, DOM and accessibility changes, downloads, popups, dialogs, crashes)
through a new event type. Both land in the one live event log, so CLI, REST,
MCP and Python read the same session.

**Machine-tested on this machine** — real Chromium 1228, real page, real
frames, 13 tests in `tests/live/test_browser_live.py`:

| Claim | How it is proved |
| --- | --- |
| Pixels and structure both arrive before the browser closes | Asserted against `source.running` being true, not against a wall clock |
| Frames are real images | First two bytes are the JPEG magic number |
| A 500 response and a network failure are different facts | Separate event kinds, both asserted |
| Navigation epochs separate pages | Fixture navigates on its own; a console message from page 2 is never attributed to page 1 |
| One page change advances the epoch once | `max(epoch) == 2` for two navigations |
| Cancellation closes every browser process | The per-session profile directory deletes — which Windows only permits once the last process holding it exits |
| A killed browser is reported honestly | Process tree killed mid-session; the session must reach `failed` with a `live.browser.*` code and a fix |
| Evidence survives the process | Read back in a fresh interpreter via subprocess |
| Secrets never reach the log | The fixture's approval token is absent from the serialized event log |
| Page instructions are fenced, not obeyed | Every page-derived event is `page_authored` with `provenance: observation`, and may not claim a browser-level kind |
| A metadata-endpoint URL never reaches Chromium | Refused before launch, no profile created |
| An error pins media on both sides | Frames exist before *and* after the error timestamp |
| Four surfaces agree | Same id, state, source kind and navigation epoch from Python, REST, CLI and a real in-process MCP client |

**Deterministic-tested** — 30 tests in `tests/live/test_browser_policy.py`
covering scheme refusal, cloud metadata endpoints (v4 and v6), loopback,
private and link-local ranges, DNS rebinding (a public-looking name resolving
inward), resolver failure failing closed, host allowlists, credential-shaped
value masking, header and URL redaction, truncation accounting, and forged
event kinds.

Also in this slice:

- A latent data-loss bug in the live event log, found and fixed (`8825f07`).
  Verified by running the old implementation side by side with the new one:
  30 of 150 events stored versus 150 of 150.
- `watch_skill.live.fixture_app` — a rights-clear broken application written
  here, used by every browser proof and by the Observer Loop demo.
- `browser` capability upgraded from `probed` to `machine_tested`.
- `LiveEvent.to_public()` now carries `detail`. Without it, structured browser
  evidence existed in the database and was invisible from every surface.

**Not done in this slice**: page audio (a browser session forces `audio` off
rather than reporting it degraded every time), Firefox/WebKit, multi-page
sessions.

## Blockers

| Blocker | Detail | Effect |
| --- | --- | --- |
| Real VLM proof | Insufficient disk/RAM for a local VLM download; inherited from the previous season and not retried in this environment. | Semantic vision remains deterministic-tested only. |
</content>
</invoke>
