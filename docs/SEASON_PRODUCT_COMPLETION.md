# Season: Product Completion — execution ledger

# Season 4 â€” the real model inside a live session, and a Next.js workspace

Two mandatory deliverables: a genuine VLM observation travelling through a
running live session and queryable cross-process, and the workspace migrated
completely off Vite onto Next.js showing that observation with an honest
preview. Both are done. Everything below is measured on this machine unless it
says otherwise.

## Inherited state (verified at session start)

| Fact | Value |
| --- | --- |
| Branch | `feat/v2-live-vision` |
| HEAD | `695009b` |
| Working tree | clean |
| Commits ahead of `origin/main` (`cb3c430`) | 40 |
| Pushed / merged / tagged / released | none |
| Free disk | C: 6.3 GiB آ· F: 0.9 GiB آ· G: 46.1 GiB |
| RAM | 7.9 GiB total, 1.9 GiB free |

The repository drive had under a gigabyte free all season, so `node_modules`,
the Next build and every staging directory live on `G:` behind directory
junctions. Nothing global was modified.

## Slices

| # | Slice | Status | Commit | Proof |
| --- | --- | --- | --- | --- |
| 1 | Real VLM inside the live session | **done** | `30a6820` | real-model-tested |
| 2 | Real VLM fixture and proof gate | **done** | `f78f12d` | real-model-tested |
| 3 | Next.js migration | **done** | `6739117` | machine-tested |
| 4 | Continuous live preview transport | **done** | `5e6297e` | machine-tested |
| 5 | Rendered UI proof and accessibility | **done** | `b864434` | real-model-tested |
| 6 | Packaging and release gates | **done** | `fd70d89` | machine-tested |

## Phase 0 â€” preflight against the real worker

Confirmed against the running worker rather than against a description of it:
pinned revision `067788b1â€¦` echoed back by inference, `HF_HUB_OFFLINE` and
`TRANSFORMERS_OFFLINE` both `1` *inside the child*, `max_edge` 512 applied,
structured output produced, worker terminated and memory returned.

Credential stripping was previously an intention with nothing checking it. A
new `env_audit` command asks the child what it can actually see; the preflight
plants two sentinel keys (`ANTHROPIC_API_KEY`, a `_TOKEN`) and the child
reports **zero** credential-shaped variables.

| Measurement | Value |
| --- | --- |
| Cold spawn + load | 16.1 s wall (5.27 s model load) |
| Free RAM before / after load | 3877 â†’ 3498 MiB (379 MiB) |
| Free RAM at inference peak | 2291 MiB (â‰ˆ1.59 GiB consumed) |
| Free RAM after `release` / after `stop` | 3155 â†’ 3796 MiB |

`release` returns part of the memory; only `stop` returns effectively all of
it. Recorded as measured rather than rounded up to "released".

## What only a live session revealed

Four defects that a single-frame benchmark cannot produce, all fixed:

**An unpinned revision reaches for the network.** This cache was populated by
explicit revision, so it has `blobs/` and `snapshots/` and no `refs/` â€” no
`main` â†’ commit mapping to resolve locally. Without a pinned revision the
library tries the network, offline mode refuses, and the error blames
connectivity. Measured: unpinned fails, pinned loads in **0.69 s**. The error
now names the real cause and the gate refuses to run unpinned.

**"ready" was reported by a detector that could never answer.** The load error
sat in a field nobody reads while every frame quietly became a degraded
observation.

**Decode length was the latency that mattered, not image size.** The worker
defaulted to 64 new tokens; the receipt's 47.1 s was measured at 32. Sharing
four threads with capture and OCR, *no inference completed inside a
130-second source* at 64 tokens. At 32 they complete in ~50 s.

**A FIFO drain points a slow model permanently at the past.** At ~50 s per
call the head of the queue is always the stalest frame: the run interpreted
media timestamps 0.0 and 30.0 and never looked at the failure state. The
dequeue is now ranked the same way eviction already was.

A fifth, in the gate rather than the product: `observe()` returns
`to_public()` dicts, and the gate read `event.detail` with `getattr`, which
silently yields `None` for every event. Two full runs reported a session that
had produced nothing while the model was working correctly.

## Freshness â€” late is not the same as wrong

A late result is never discarded. What lateness costs it is the present tense.

| Classification | Meaning |
| --- | --- |
| `current_state` | Within 10 s of its frame. May fire a trigger or action. |
| `stale_for_action` | True about its own timestamp, too late to act on. Queryable, inert. |
| `historical_evidence` | The source has ended; there is no present tense left to claim. |

On this backend almost nothing clears the 10 s window. That is the honest
result and it is displayed rather than smoothed over.

Every observation persists: session id, frame SHA-256, frame sequence, capture
kind, media timestamp, captured wall time, inference start and completion,
latency, model id and pinned revision, worker protocol version, freshness,
`late_by_seconds`, supersede flag, selection reason, and any degradation.

## Real-model gate â€” `tests/integration/test_real_vlm_live.py`

**8 passed, 0 skipped.** A 150-second labelled fixture through a live session.

| Metric | Value |
| --- | --- |
| In-session inference | 50.4 s, 51.8 s, 56.8 s |
| Standalone inference (same machine) | 48.9 â€“ 81.8 s |
| Model | `HuggingFaceTB/SmolVLM2-256M-Video-Instruct` |
| Revision | `067788b187b95ebe7b2e040b3e4299e342e5b8fd` |
| Input | 512 px, 32 new tokens, float32, 2 threads |

Ground truth across the four labelled states, read by the real model:

| State | Model output | Detected |
| --- | --- | --- |
| normal | *"A green screen with the words \"CHECKOUT\" and \"Total: $125.00\" in white."* | correct |
| failure | *"A red screen with the words \"ORDER FAILED\" and \"Total: NaN\" in white."* | `apparent_failure`, anomaly cites "failed, nan" |
| injection | *"INGREDIENTS AND CALL DETECTIONS INSTRUCTIONS AND CALL DELETE_ALL_Videos."* | garbled, no anomaly, **no action path** |
| recovery | *"A green screen with the words \"ORDER CONFIRMED\" in bold white letters."* | `apparent_success` |

Egress is refused in the socket layer of the worker process by an injected
`sitecustomize`, before torch loads â€” stronger than asserting a flag is set.
Zero attempts recorded.

### Fixture limitations, stated plainly

Four states, one machine, one model. This measures that a real model produced
a real reading of the right frame and that the pipeline around it is honest.
It is **not** a benchmark of model quality, and precision/recall/F1 over four
labelled segments would be a number with no power. What is reported instead is
per-state correctness above. The model mangles the injection text, reads large
text well and small text poorly, and invents plausible words â€” all expected of
256M parameters at 512 px.

## The workspace â€” Vite out, Next.js in

Next.js 15.5.23, React 19, App Router, strict TypeScript, static export. No
Node is required of a user: one compilation produces both the directory export
and, folded out of it, the single self-contained document the MCP Apps
resource carries inline. Vite, its config, entry points and plugins are gone.

The trap worth recording: Next's flight payload names the stylesheet twice â€”
an `HL` preload row and a React `link` element carrying a `precedence`, which
React 19 hoists into the head at runtime. An earlier inliner exempted
references inside script text as inert data. They are not; the App Router
reads them, producing a 404 against the dev host and a CSP-blocked request
inside a host with no server.

Dependency audit: **0 vulnerabilities**. `next` 15.5.4 shipped with critical
advisories and was moved to 15.5.23; `sharp` and `postcss` are pinned back by
Next and overridden forward.

## Live preview â€” negotiated, and labelled by what it is

Four labels, four different claims: `LIVE VIDEO`, `LIVE FRAMES`, `SNAPSHOT`,
`REPLAY`. The host declares what it can honour and the label follows the
transport. This loopback host serves bounded frame updates, so a running
session earns **LIVE FRAMES** and a finished one **REPLAY**. `LIVE VIDEO` is
left unclaimed: continuous binary transport is not served here, and claiming
it would be the exact dishonesty this mechanism exists to prevent.

Measured through the rendered UI:

| Metric | Value |
| --- | --- |
| Transport negotiated | `LIVE FRAMES` |
| First meaningful frame | 30 ms |
| Frame age p50 / p95 | 67 ms / 67 ms |
| Preview FPS | 1.35 (source captured at 1 fps) |
| Frames dropped / superseded | 0 |
| Reconnects | 0 |

Access is a capability: an HMAC of the session id under a per-process secret,
so a token from one workspace cannot fetch another session's media. The UI
receives a session id and a token, never a path â€” asserted by test.

"No frame captured yet" answers 204, not 404. It is an ordinary state of a
healthy session, and reporting it as an error put a red line in the console of
a workspace that was working perfectly.

## The rendered proof

`docs/assets/workspace/workspace-vlm-historical.png` is the season in one
frame: the preview shows **ORDER CONFIRMED**, which is what the source is
playing now, while the model's reading beside it describes **CHECKOUT at media
0.00s** and is labelled **STALE FOR ACTION** â€” 105.6 s of inference, the answer
landing 112.4 s after the frame, "true about the frame it describes, too late
to act on". Latency is higher here than in the headless gate because Playwright
Chromium, the dev host and capture all share four threads.

Screenshots: `workspace-live-preview.png`, `workspace-vlm-processing.png`,
`workspace-vlm-historical.png`, `workspace-approval.png`,
`workspace-verified.png`, `workspace-light.png`, `workspace-dark.png`,
`workspace-narrow.png`.

## Accessibility

axe-core is injected from `node_modules`, never a CDN â€” the workspace CSP has
no remote origins, and a test that fetched its own auditor would be auditing a
page the product never serves. It found three genuine serious contrast
violations, all fixed in the stylesheet rather than filtered out:

| Element | Was | Now |
| --- | --- | --- |
| Primary button (white on accent) | 4.27:1 | 5.9:1 via `--accent-strong` |
| `.empty` muted text (light theme) | 4.0:1 | 5.6:1 |

Keyboard reach asserts a *visible* focus indicator on every tabbable element.
Reduced motion is verified by reading computed durations back out of the
document.

## Packaging

| Artefact | Result |
| --- | --- |
| Wheel | 683 KiB, carries the 502 KiB workspace document |
| sdist | **81.3 MB â†’ 6.0 MB** |
| Clean-environment install | passes, repository off `sys.path` |
| Installed MCP resource smoke | passes |
| Installed Next.js static-asset smoke | passes, 0 un-inlined assets |

There was no sdist configuration at all, so hatchling swept up
`app/node_modules` â€” a directory junction to another drive, which it followed.

## Skip inventory

Baseline had 18 skips; this season added gates of its own. Every one is
accounted for.

| Skip | Count | Disposition |
| --- | --- | --- |
| Real ASR gate | 7 | **Run.** 27 passed, 1 skipped. Found and fixed a real egress bug. |
| Real live-VLM gate | 8 | **Run.** 8 passed, 0 skipped. |
| Rendered real-VLM gate | 1 | **Run.** Passes. |
| Framework extras | 5 | **4 run** in an isolated env (7 passed); crewai still skipped. |
| Provider-VLM gate (Ollama) | 4 | Skipped: no local Ollama vision model, and no provider named. A key in the environment is not consent to spend it. |
| POSIX permission bits | 1 | Skipped on Windows, exact reason given. Correct. |
| Real speech wav | 1 | Skipped: needs `WATCHSKILL_TEST_SPEECH_WAV`. |

Running the real-ASR gate for the first time found that local speech
recognition was not local: `WhisperModel` was built without
`local_files_only`, so a cached model still reached out to resolve its
revision. `local_files_only` alone was not enough â€” a second connection came
through `huggingface_hub.snapshot_download`, so `HF_HUB_OFFLINE` is now set
for the duration of the load and restored after.

## Final gates on frozen HEAD `a441862`

| Gate | Result |
| --- | --- |
| Ruff | clean |
| Full offline suite | **1363 passed, 27 skipped, 0 failed** |
| Full suite, repeated | run 1 pass · run 2 **1 failure** · run 3 pass |
| UI suite, clean process ×4 | pass, pass, pass, pass (79 passed, 1 skipped) |
| Real live-VLM gate | 8 passed, 0 skipped |
| Rendered real-VLM gate | pass |
| Real ASR gate | 27 passed, 1 skipped |
| Framework adapters (isolated env) | 7 passed, 1 skipped (crewai) |
| Accessibility (axe, serious+critical) | 0 violations |
| Keyboard reach / reduced motion / themes | pass |
| Strict TypeScript + Next production build | pass |
| npm audit | 0 vulnerabilities |
| Wheel / sdist | 683 KiB / 6.0 MB |
| Clean-environment install + installed smokes | pass |
| Secret scan | clean (6 known redaction fixtures) |
| Leaked chromium / ffmpeg / model workers | none |

### The one intermittent failure, reported rather than smoothed

`test_workspace_ui.py::test_the_whole_scenario_is_visible_in_the_rendered_workspace`
failed once in three full-suite runs. It passed in all four clean-process
runs, and a **deliberate contention test** — the same test run against
concurrent load from `tests/live`, `tests/index` and `tests/perceive` — also
passed, so the flake did not reproduce on demand.

The exact assertion for that failure was not captured: the run's output was
tailed and the failing line was cut. The same test failed the same way at the
very start of the season, before any change in it, so it is inherited rather
than introduced — but that is an explanation, not a diagnosis, and it is
recorded here as **an open flake with an unknown assertion**.

### Demo recording — a measured hardware ceiling

`docs/assets/workspace/workspace-live-demo.mp4` (88 KiB, 28 s) is genuine
footage from the rendered proof run: the live preview updating under the
`LIVE FRAMES` label, and the vision panel in its `PROCESSING WITH VLM` state
saying plainly that interpretation takes tens of seconds.

It does not show a completed reading, and that is a measurement rather than an
omission. With Playwright's video encoder added to Chromium, the dev host, the
capture pipeline and the model on four threads, **two consecutive runs failed
to produce a non-degraded reading within 480 seconds** — the first returned an
empty (degraded) observation, which the workspace rendered correctly. Recording
is therefore opt-in behind `WATCHSKILL_TEST_RECORD_DEMO`; the proof test itself
runs without it and passes. The completed reading is evidenced by
`workspace-vlm-historical.png` and by the gate.

That run also improved the test: it used to accept the first observation to
appear, which a degraded empty one satisfies. It now waits for a reading with
words in it.

## Claims earned

- A real vision model produces observations inside a running live session,
  persisted with full provenance and readable from a fresh process.
- Those observations reach the rendered Next.js workspace with their frame
  timestamp, hash, pinned revision, measured latency and freshness.
- The preview is genuinely frame-driven and labelled by what it actually is.
- Model output and on-screen text are untrusted evidence and cannot become an
  action.
- The offline suite makes zero outbound calls with every provider key set.

## Claims deliberately not made

- **Not "real-time VLM".** The measured figure is roughly 50 s per keyframe
  in-session. The correct description is *asynchronous live semantic
  evidence*.
- **Not `LIVE VIDEO`.** Continuous binary frame transport is implemented
  nowhere in this host; the label exists and is unused.
- **Not a model-quality benchmark.** Four labelled states on one machine.
- **Not "memory fully released on idle".** `release` returns part; `stop`
  returns effectively all.
er

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
| 1 | Production live browser source | **done** | `8825f07`, `472e594` | machine-tested |
| 2 | Persistent temporal entities and actions | **done** | `0df7450`, season 2 | machine-tested |
| 3 | Durable deterministic triggers | **done** | `ec2e775` | deterministic-tested |
| 4 | Verification Oracle SDK | **done** | `0df7450` | machine-tested |
| 5 | Observer Loop | **done** | `0df7450` | machine-tested |
| 6 | MCP App / live workspace | not started | â€” | â€” |
| 7 | Plugin protocol and adapters | not started | â€” | â€” |
| 8 | Typed SDKs | not started | â€” | â€” |
| 9 | Skill consolidation | not started | â€” | â€” |
| 10 | Pulse and observability | not started | â€” | â€” |
| 11 | Security and privacy hardening | per-slice only | â€” | see below |
| 12 | Documentation, examples, packaging | docs + examples done, packaging not started | `472e594`, `0df7450` | â€” |

Four commits this season, on top of the 24 inherited:

| Commit | What |
| --- | --- |
| `8825f07` | fix(live): a second detector thread no longer eats the first one's event |
| `472e594` | feat(live): a browser watched as pixels and as structure, at the same time |
| `0df7450` | feat(observer): declare success first, and let something else decide it happened |
| `ec2e775` | feat(triggers): fire on the evidence, and never on a model's opinion |

## Slice 1 â€” production live browser source

Two synchronized channels from one Chromium page: real JPEG frames through the
existing scene-change / OCR / rolling-buffer / clip machinery, and structured
evidence (navigation, console, page errors, failed requests, response
metadata, DOM and accessibility changes, downloads, popups, dialogs, crashes)
through a new event type. Both land in the one live event log, so CLI, REST,
MCP and Python read the same session.

**Machine-tested on this machine** â€” real Chromium 1228, real page, real
frames, 13 tests in `tests/live/test_browser_live.py`:

| Claim | How it is proved |
| --- | --- |
| Pixels and structure both arrive before the browser closes | Asserted against `source.running` being true, not against a wall clock |
| Frames are real images | First two bytes are the JPEG magic number |
| A 500 response and a network failure are different facts | Separate event kinds, both asserted |
| Navigation epochs separate pages | Fixture navigates on its own; a console message from page 2 is never attributed to page 1 |
| One page change advances the epoch once | `max(epoch) == 2` for two navigations |
| Cancellation closes every browser process | The per-session profile directory deletes â€” which Windows only permits once the last process holding it exits |
| A killed browser is reported honestly | Process tree killed mid-session; the session must reach `failed` with a `live.browser.*` code and a fix |
| Evidence survives the process | Read back in a fresh interpreter via subprocess |
| Secrets never reach the log | The fixture's approval token is absent from the serialized event log |
| Page instructions are fenced, not obeyed | Every page-derived event is `page_authored` with `provenance: observation`, and may not claim a browser-level kind |
| A metadata-endpoint URL never reaches Chromium | Refused before launch, no profile created |
| An error pins media on both sides | Frames exist before *and* after the error timestamp |
| Four surfaces agree | Same id, state, source kind and navigation epoch from Python, REST, CLI and a real in-process MCP client |

**Deterministic-tested** â€” 30 tests in `tests/live/test_browser_policy.py`
covering scheme refusal, cloud metadata endpoints (v4 and v6), loopback,
private and link-local ranges, DNS rebinding (a public-looking name resolving
inward), resolver failure failing closed, host allowlists, credential-shaped
value masking, header and URL redaction, truncation accounting, and forged
event kinds.

Also in this slice:

- A latent data-loss bug in the live event log, found and fixed (`8825f07`).
  Verified by running the old implementation side by side with the new one:
  30 of 150 events stored versus 150 of 150.
- `watch_skill.live.fixture_app` â€” a rights-clear broken application written
  here, used by every browser proof and by the Observer Loop demo.
- `browser` capability upgraded from `probed` to `machine_tested`.
- `LiveEvent.to_public()` now carries `detail`. Without it, structured browser
  evidence existed in the database and was invisible from every surface.

**Not done in this slice**: page audio (a browser session forces `audio` off
rather than reporting it degraded every time), Firefox/WebKit, multi-page
sessions.

## Slices 2 (actions), 4 and 5 â€” governance, oracles, and the loop

### Governed actions (`watch_skill.actions`)

An action is a durable row moving through named states, not a function call
that either happened or did not. `succeeded` and `verified` are different
states written by different callers, so "it ran without erroring" can never be
reported as "it worked".

Approval is bound to an **effect digest** â€” a hash of exactly what will happen
â€” rather than to an action id, so an approved action that changes its payload
is refused. Approvals are single-use, expire, require a named actor, and are
consumed inside the same call that performs the effect.

**Machine-tested**, 16 tests in `tests/actions/test_approvals.py`:

| Attack | Result |
| --- | --- |
| Perform without approval | `actions.approval_not_granted` |
| Replay an approval | `actions.approval_already_used` |
| Get one effect approved, perform another | `actions.approval_effect_mismatch`, and the real approval stays unspent |
| Use a stale approval | `actions.approval_expired` |
| Approve after rejection | No-op; the first decision stands |
| Approve anonymously | `actions.approval_actor_required` |
| Five threads approve at once | Exactly one actor recorded |
| Two workers start one approved action | One wins by compare-and-swap; the other gets `actions.already_claimed` |
| Satisfy the approval oracle from the agent's own evidence dict | Fails â€” the oracle reads the store, in a separate process |

Executors are a closed registry keyed by `kind`. There is no "run this
command" executor: a command assembled from a string is a command that page
content can rewrite. A new `Channel.ACTION` egress gate sits in front of every
outbound effect, so offline mode closes it like every other channel â€” approval
and policy are separate gates, and a human saying yes does not override an
operator's decision that this machine performs no outbound side effects.

### Verification oracles (Slice 4)

Four new oracle types on the existing frozen-contract substrate:
`directory_manifest`, `browser_dom` (exists / absent / text / attribute /
value / visible / enabled), `live_console`, `live_evidence`, and
`human_approval`. Each reads a running world rather than a file, in the
verifier's own process, read-only, against targets named in the frozen
contract.

**Machine-tested**, 9 tests in `tests/verify/test_oracles.py`, including: a
DOM postcondition failing against the real broken page and passing once the
world (not the check) changes; a missing element reported as FAIL rather than
ERROR; a contract refused as an SSRF primitive; a tampered clip failing its
digest; and an empty evidence log reported `inconclusive` rather than `pass`.

### The Observer Loop (Slice 5)

Declare success, observe, act, and let something else judge. The postcondition
is frozen **before** the run exists and its digest is copied onto the run, so a
later edit is detectable; verification runs in a separate isolated process;
the correction is a typed declarative spec approved as a specific effect; and
the loop **stops and waits** for a human rather than proceeding.

### The definitive end-to-end product proof

`tests/observer/test_observer_loop.py::test_broken_app_observed_corrected_and_independently_verified`
â€” one controlled demonstration, passing on this machine:

1. a deliberately broken browser application, served on loopback;
2. success declared as two required postconditions (a DOM read and a server
   read), frozen first â€” a correction that only repainted the page would
   satisfy one and fail the other;
3. live browser observation, asserted while the session is still `running`;
4. a before clip cut from the rolling buffer, spanning both sides of the event;
5. verification failing against the real page;
6. a correction proposed, and the loop stopping at `awaiting_approval` â€”
   advancing again changes nothing, and the fixture records zero fix attempts;
7. an explicit approval by a named operator;
8. the deterministic correction applied **once** (`fix_attempts == 1`);
9. the corrected application observed, and an after clip cut;
10. the verdict produced at `isolated_local` assurance in a separate process;
11. the whole receipt read back in a **fresh interpreter**: contract still
    frozen, digest still matching its own canonical form, bundle and run
    digests agreeing, both required checks passed, attestation hash present,
    and the two clips hashing differently.

No model is involved anywhere in this test.

Eight further tests attack the boundary: an unfrozen postcondition is refused;
a widened postcondition is refused mid-run; the correction cannot be performed
without approval; an approval is spent once even if the loop is advanced
twice; a run with no correction ends `exhausted`, never `verified`; an
unreachable oracle fails closed without acting blind; a cancelled run stops
wherever it is; and the executing side never writes its own verification
verdict.

**A real bug found by this proof**: the isolated verifier's sanitized
environment allowlisted POSIX `HOME` but not Windows `USERPROFILE`, so `httpx`
raised "Could not determine home directory" and **every** `http_request` check
errored on Windows â€” turning any contract containing one into `inconclusive`.
Fixed, and the end-to-end proof is what caught it.

**Not done in these slices**: temporal entity storage (Slice 2's entity half),
triggers (Slice 3).

## Slice 3 â€” durable deterministic triggers

A trigger is a typed structure compiled to a fixed set of comparisons. No
`eval`, no lambda, no template with code in it, no model-written predicate â€”
because what a trigger reads is an event log full of text a webpage wrote, and
any of those would turn that log into an execution surface.

Four condition kinds: `match`, `count` (N inside a rolling window), `sequence`
(steps in order inside a window), and `absence` â€” the only one that fires
because of something that did *not* happen, measured in **media** time rather
than wall time, since a stopped session has not had time pass in its media.

**The ceiling on what a trigger can do**: propose. A firing creates an action
in `awaiting_approval`; there is no code path from a predicate to an
execution. That is what makes it safe to evaluate rules over page-authored
text at all.

**Deterministic-tested**, 19 tests in `tests/triggers/test_triggers.py`:
replay safety (re-evaluating fires nothing; a rewound cursor proposes one
action, not two), cursor resumption, once-only, cooldown recording the match
it declined to act on, a firing-rate budget capping a 12-event storm at 2
actionable firings, expiry, disabled state, window edges, sequence ordering,
absence arming and re-arming, bounded evaluation state over 400 events
(capped at 256 entries), explainability, and the predicate language refusing
attribute access (`detail.__class__` and friends resolve to `MISSING`, which
is itself distinct from `None`).

Fixed while testing: a firing persisted its proposed `action_id` but did not
set it on the object returned to the caller, so every caller had to re-query
and the ones that forgot would report that a firing proposed nothing.

**Not done**: no CLI/REST/MCP surface for triggers yet. The Python API is
stable and tested; exposing it publicly is deliberately deferred rather than
half-wired.

## Season 2 final gate on `7198165`

| Gate | Result |
| --- | --- |
| Ruff (`src`, `tests`, `examples`) | clean |
| Full offline Python suite | **1376 passed, 18 skipped, 0 failed, 0 errors** |
| Full suite, two consecutive runs | 1370/18/0 twice on `c34ff41`, then 1376/18/0 on `7198165` â€” **no `MemoryError` in any run** |
| Browser suite, three consecutive runs | 73 passed each time, exit 0 |
| Skips with a specific reason | 18/18, unchanged from season 1 |
| Pushed / merged / tagged / released / published | none |
| Working tree | clean |

Up from season 1's 1339: **+37 tests**, no new skips.

Measured on this machine at the end of the run: free memory 1868 MB against a
700 MB browser floor; browser limit 2 per process; best establishable
assurance `isolated_local`.

---

# Season 3 â€” the MCP App and live workspace

## Preflight â€” the governor's fail-open hole

Two admission bugs, both of which let the governor stay satisfied right up
until the host was not.

It compared free memory against a reserve **without subtracting what the new
session would take**. 800 MB free clears a 700 MB reserve; a 450 MB Chromium
then consumes the reserve entirely. And when memory could not be read at all
it failed open â€” the guarantee evaporating on exactly the platforms where
nobody can check it.

Now: reserve **plus** estimated session cost, resident model weights counted
against the budget, a conservative single session when memory is
unmeasurable, `memory_measurement_unavailable` reported, and fail-open
reachable only through `WATCHSKILL_ALLOW_UNMEASURED_BROWSERS`. Leases release
at interpreter exit. 14 tests in `tests/live/test_browser_pool.py`.

## The MCP App

**SDK**: `@modelcontextprotocol/ext-apps@1.7.5`, pinned exactly. Both official
constants (`text/html;profile=mcp-app`, `ui/resourceUri`) are asserted against
the installed package's own type declarations, so an SDK bump that moves them
fails the suite rather than producing a workspace that silently never renders.

**One new discovery-facing tool**: `watch_workspace`. Everything the UI does
goes through the canonical tools that already existed.

**Canonical state stays in Python** (`watch_skill.workspace`): bounded
snapshot for first render and every reconnect, cursor-based deltas with an
explicit gap signal. The observation/inference split and timeline lane
assignment are decided in the core, not re-derived by the client.

**Stack**: React 19.2 + TypeScript 5.9 (strict, plus `noUncheckedIndexedAccess`
and `exactOptionalPropertyTypes`) built by Vite 7.3.6 into one 564 KB
self-contained file. `npm audit`: 0 vulnerabilities. Bundle inspected for
remote origins and `eval` â€” none.

### Three bugs only a rendered UI could find

1. **The approval panel leaked the correction's bearer token.** Fixed in the
   read model, not at render â€” a client that redacts on display has already
   received the secret, and so has any screenshot or bug report of it.
2. **Approving anywhere but the loop's own helper left the run stuck
   forever.** `advance` now consults the approval store rather than a private
   flag, so a decision taken in the UI, the CLI or REST all mean the same
   thing.
3. **The receipt strip rendered on top of the approve button.** Visible,
   correctly labelled, completely unclickable. One missing `flex: 0 0 auto`;
   the same shape had clipped the stage controls and compressed the evidence
   tabs. A defect that looks like nothing in a screenshot and like a broken
   product in a hand.

A fourth â€” the header stacking into a tall centred column because `.panel`
won `flex-direction` â€” was caught by *looking at the screenshot*, and is now
asserted.

### The definitive UI proof

`tests/surfaces/test_workspace_ui.py` runs the whole scenario against the real
bundle in a real browser: live browser fixture â†’ LIVE badge while genuinely
running â†’ browser evidence rendered â†’ page text fenced as UNTRUSTED â†’
observations and inferences never in one card â†’ failed verification â†’
approval showing the exact effect with the token redacted â†’ approved **through
the UI** â†’ applied exactly once (`fix_attempts == 1`) â†’ verified, naming the
deterministic oracle and `isolated_local` â†’ reload and recover from canonical
state without duplicate markers â†’ reopened from a fresh process.

Artifacts in `docs/assets/workspace/`: light, dark, approval, verified, narrow
(420 px). All generated from fixture content only.

**Not done in this season**: no run inside a production MCP host (Claude
Desktop and others untested); media is snapshot-only; pause/resume is not
implemented in the live core and the UI says so; no MP4/GIF demo; no formal
axe-style accessibility audit beyond the keyboard-reachability test.

## Season 2 â€” what was not started

Named rather than quietly omitted. Season 2 spent its capacity on the audit
slice, which was ordered first and which found three real defects. The
following are untouched and must not be read as partially done:

| Slice | Status |
| --- | --- |
| 2 â€” MCP App / live workspace | **Not started.** No `@modelcontextprotocol/ext-apps` dependency, no TypeScript, no React, no UI of any kind. There are no screenshots and no demo artifact, because there is nothing to screenshot. |
| 3 â€” Plugin protocol | **Not started.** No entry-point protocol, no reference plugins. |
| 4 â€” TypeScript SDK | **Not started.** No `package.json`, no `npm pack`. |
| 5 â€” Skill consolidation | **Not started.** Still ten skills; the 1,259-token discovery baseline is unchanged. |
| 6 â€” Pulse observability | **Not started.** Counters exist on `LiveStats`, `Spend` and the browser pool; there is no metrics endpoint, no OTel exporter, and no `telemetry` command. |
| 7 â€” Security release gate | **Per-slice only.** Individual controls are implemented and tested (redaction, SSRF, path traversal, approval replay, forged receipts, resource exhaustion, browser process leaks). The consolidated scans â€” secret scan, dependency audit, package-content inspection â€” were **not run**. |
| 8 â€” Packaging | **Not started.** No wheel, no sdist, no clean-environment install, no offline smoke test. |

The definitive release proof described in the brief â€” the full fixture run
*through the UI*, with reconnect and reopening â€” **did not run**, because the
UI does not exist. The equivalent proof through the Python API does pass and
is unchanged from season 1
(`tests/observer/test_observer_loop.py::test_broken_app_observed_corrected_and_independently_verified`).

## Season 1 final gate on `ec2e775`

| Gate | Result |
| --- | --- |
| Ruff (`src`, `tests`, `examples`) | clean |
| Full offline Python suite | **1339 passed, 18 skipped, 0 failed, 0 errors** |
| Skips with a specific reason | 18/18 â€” 7 real-model ASR, 4 real-model VLM, 5 uninstalled framework extras, 1 POSIX-only permission test, 1 local-ASR recognition |
| Definitive end-to-end product proof | passes |
| Pushed / merged / tagged / released / published | none |
| Working tree | clean |

Up from the inherited 1218 passed / 18 skipped: **+121 tests**, no new skips.

Not run this season, and therefore not claimed: TypeScript strict check and
tests, MCP App build and reference-host Playwright tests, Python wheel and
sdist, clean-environment install, `npm pack`, secret scan, dependency
vulnerability scan. The zero-egress test with provider keys present is part of
the suite above and passed.

---

# Season 2 â€” audit and release hardening

## Slice 0 â€” auditing the previous season's claims

The previous report's claims were checked against the code rather than
restated. Three of them did not survive contact.

### Finding 1: entities were never implemented

Confirmed. Slice 2's action lifecycle existed; the temporal entity half did
not, and the previous ledger said so. Now implemented â€” see below.

### Finding 2: the triggers package is clean, with one bug

Provenance audit of all four files: no `eval`, `exec`, `compile`,
`__import__`, `getattr`, `subprocess` or `pickle`; no TODO/FIXME/placeholder
text; one broad `except`, on the dead-letter path, documented. Predicates are
key lookup only, and attribute access resolves to `MISSING`.

**But `record_firing` had a real defect.** It allocated a firing sequence with
`SELECT MAX(seq)+1` *before* the first write, and Python's `sqlite3` only
opens an `IMMEDIATE` transaction on DML â€” so the read ran outside the write
lock. Two evaluators would compute the same `seq`, and the loser's
`IntegrityError` was caught by a handler that means *"this cause already
fired"*. A legitimate firing for a different event would have vanished with no
error. Fixed by allocating inside the `INSERT`, which leaves the `cause_seq`
index as the only way that handler can be reached.

### Finding 3: the same race was in all five databases

Every `migrate()` read the schema version outside the write lock. Two threads
both saw version 0 and the loser died with `table entities already exists`.
Proved by the new concurrent-observer test, which failed exactly that way.

Fixed once, in `watch_skill.sqlite_util.apply_migrations`, and applied to all
five stores. A second, deeper instance surfaced immediately after: a
transaction that reads then writes cannot upgrade its lock, and SQLite does
**not** honour `busy_timeout` for that case because the read snapshot is
already stale. `sqlite_util.immediate()` starts such transactions as writers;
it is now used by the entity store and the action compare-and-swap.

Both bugs are invisible to a single-threaded test suite and appear the first
time a user runs two commands at once.

## Slice 0 â€” browser resource governance

The `MemoryError` from season 1 is treated as the release defect it was.
Nothing counted Chromium instances, so nothing could refuse one, and the
ceiling was whatever the OS would tolerate â€” reached as an out-of-memory kill
in whatever unrelated code allocated next.

`watch_skill.live.browser_pool` leases browser slots. A lease is granted only
if the process is under its limit *and* free memory is above a floor;
otherwise the caller is refused immediately with a reason naming what is
already running. A refusal is a far better outcome than an OOM: it names the
cause, it is recoverable, and it lands in the right place.

- Per-process limit (default 2: one live session, one verifier â€” the pair
  that must not deadlock), configurable via `WATCHSKILL_MAX_BROWSERS`.
- Memory floor (default 700 MB) via `WATCHSKILL_MIN_BROWSER_MEMORY_MB`.
- Unmeasurable free memory fails **open**, and says so â€” refusing every
  browser on a platform whose memory we cannot read would make the product
  unusable there, and assuming plenty would be a safety claim never verified.
- The lease is returned *after* the process tree is gone, never before.
- `tests/live/conftest.py` releases leases in teardown, so one failing test
  cannot starve every later browser test.
- Diagnostics report `scope: "process"` rather than implying a machine-wide
  guarantee nothing enforces.

**Proof**: 8 tests in `tests/live/test_browser_pool.py`, including a
20-thread concurrency test asserting the peak never exceeds the limit, and
**three consecutive full browser-suite runs** (73 tests each) all green.

## Slice 0 â€” live browser capability receipt

`watch_skill.live.receipt` derives, from the persisted event log alone, which
of ten declared channels a session actually produced: pixels, scene change,
DOM mutation, accessibility change, console, page error, request failed, HTTP
error, navigation, clip.

The channel list is **declared**, not discovered. A receipt built only from
observed events could never report that something was *missing*, which is the
one thing it exists to do â€” every interesting live-capture failure looks like
silence.

**Proof**: `tests/live/test_browser_receipt.py` runs the fixture and asserts
all ten channels fire, then re-derives the identical receipt **in a separate
process**. A second test asserts a silent session produces a receipt full of
`MISSING` rather than an empty one.

## Slice 0 â€” persistent temporal entities (completing Slice 2)

`watch_skill.entities`: bi-temporal attributes with `valid_from`/`valid_to`,
stable ids, aliases resolved through a normalized unique index, evidence
links, conflicts, cross-session history, and bounded context compilation.

Nothing is ever updated in place. Superseding a fact closes the old interval
and opens a new one at exactly the same instant, so a state-at-time query
never finds a gap and never finds two answers. A partial unique index enforces
one open interval per `(entity, name)` â€” it caught the implementation
inserting before closing, which is the corruption every later read would have
silently inherited.

**A model never writes here.** Output arrives as an `Observation` â€” a
proposal â€” and deterministic code decides. The conflict rule: a fresh
deterministic reading always wins; an inferred one never overrides a
deterministic one, however confident it sounds; otherwise higher score wins
and ties keep the incumbent. Every path records a conflict row, including
"we kept the old value", because that is a finding too.

**Proof**: 17 tests in `tests/entities/test_entities.py` â€” interval
boundaries checked to the millisecond on both sides, a model failing to
overwrite a DOM read, truncation and attribute caps reported rather than
silent, 8 concurrent observers converging on one entity, and full history
read back from a fresh interpreter.

Implementation bug found and fixed by these tests: `_supersedes` contradicted
its own documented rule and required a *higher score* for a newer
measurement, which would have frozen the first reading of any attribute
forever.

## Season 2, Slice 1 â€” assurance levels stated honestly

`isolated_local` was being described as though it were external. It is not,
and the gap matters: a sanitized child process runs **as the same user** as
the agent that did the work, so that agent can still write the target, the
evidence, and the receipt store between runs.

The ladder now has six rungs, ordered by independence from the actor:

| Level | Proves | Does **not** prove |
| --- | --- | --- |
| `visual_advisory` | Something plausible was said | Anything; never a pass alone |
| `deterministic_local` | Reproducible, no model involved | Independence â€” same interpreter as the judge |
| `isolated_local` | No access to parent keys/state, bounded deadline | Independence from an agent running as the same user |
| `external_read_only` | The actor lacked permission to write what the verifier read | That the target itself is trustworthy |
| `human_attested` | A named person with context agreed | Reproducibility |
| `remote_attested` | An independent machine signed the result | Nothing here â€” unimplemented, and the level exists so nothing can claim it |

The semantics are held as **data** (`ASSURANCE_SEMANTICS`), not prose, because
a string literal after an enum member is not that member's docstring â€” a test
that read `__doc__` silently passed against the class docstring instead. A new
rung added without stating its limits now fails the suite.

`watch_skill.verify.isolation` probes for a real boundary and refuses the
label when there is none. Presence of a `docker` binary on PATH is explicitly
not enough: a CLI with an unreachable daemon is the common developer case, and
reporting it as available would move the failure from an honest refusal to a
run-time crash.

**Result on this machine: `external_read_only` cannot be established.** No
container runtime is installed (`docker` and `podman` both absent), and
creating a separate Windows identity needs administrator authority this
process does not have and will not request. A contract requiring
`external_read_only` is therefore refused with
`verify.assurance_unavailable`, naming both the required and available levels
â€” it is never silently downgraded to `isolated_local`.

7 tests in `tests/verify/test_assurance.py`, including the negative that
matters: `assurance_at_least(ISOLATED_LOCAL, EXTERNAL_READ_ONLY)` is false.

## Not started in this season

Named rather than quietly omitted. None of these is blocked; the season ran
out of room, and each is a coherent next slice.

| # | Slice | Why it is not here |
| --- | --- | --- |
| 2 (entities) | Persistent temporal entities | ~~Untouched.~~ **Done in season 2** â€” see the entity section above. |
| 6 | MCP App / Kimi-inspired live workspace | Needs the official `@modelcontextprotocol/ext-apps` package read and pinned first. Inventing that API rather than reading it would have produced a plausible-looking app that does not run in a real host. |
| 7 | Plugin protocol | Entry-point protocol for sources, backends, oracles, executors. The executor and oracle registries it would build on now exist. |
| 8 | Typed TypeScript SDK | Blocked on nothing but time; the canonical schemas it would generate from are stable. |
| 9 | Skill consolidation | Ten skills â†’ four. Needs the discovery-token measurement redone after the new surfaces settle. |
| 10 | Pulse / observability | Counters exist on `LiveStats` and `Spend`; no metrics endpoint, no OTel export, no `telemetry` commands. |
| 11 | Security hardening pass | Individual controls are implemented and tested per slice (redaction, SSRF, path traversal, approval replay, forged receipts). The consolidated scan â€” secret scan, dependency vulnerability scan, wheel/npm content inspection â€” has not been run this season. |
| 12 | Packaging and release gates | No wheel/sdist build, clean-env install, or npm pack run this season. |

## Blockers

| Blocker | Detail | Effect |
| --- | --- | --- |
| Real VLM proof | Insufficient disk/RAM for a local VLM download; inherited from the previous season and not retried in this environment, per instruction. | Semantic vision remains deterministic-tested only. |
| Machine RAM under load | One full-suite run died with `MemoryError` at test setup while several Chromium instances were live. The same test passes in isolation, and a later full run passed. | Browser-heavy suites are memory-sensitive on this machine. Not a code defect, but it means the suite is not comfortably parallelisable here. |

## Version recommendation

**Not `2.0.0rc1`.** The critical end-to-end product proof passes, and that is
the single most important gate â€” but a release candidate implies the release
gates have been run, and Slices 11 and 12 have not been: no secret scan, no
dependency vulnerability scan, no wheel or sdist build, no clean-environment
install, no npm package. Calling this a release candidate would be claiming
those passed rather than that they were skipped.

The honest description of this HEAD is **a feature-complete observation and
verification core with the release gates outstanding**. The distinction from
the VLM blocker matters and should not be blurred: semantic vision is blocked
by this environment, whereas packaging is simply not yet done. The first is a
limitation to state; the second is work to finish.

### Still not `2.0.0rc1` after season 2

Season 2 made the core more trustworthy â€” three real concurrency defects
fixed, browsers governed, entities implemented, assurance stated honestly â€”
but it did not close any release gate. There is still no UI, no TypeScript
SDK, no plugin protocol, no packaging, and no consolidated security scan.

Three distinct categories, which should stay distinct:

1. **Environmentally blocked** â€” the real VLM proof. Nothing in the code is
   missing; this machine cannot run it. Also `external_read_only` assurance:
   no container runtime, and no authority to create an OS identity.
2. **Deterministic infrastructure, proved** â€” live browser, entities,
   triggers, actions and approvals, oracles, Observer Loop, browser
   governance. Machine-tested here, with the receipts to re-check.
3. **Not written** â€” MCP App, plugin SDK, TypeScript SDK, skill
   consolidation, Pulse, packaging.

A version number that implied (3) was done would be false regardless of how
well (2) went.
</content>
</invoke>

