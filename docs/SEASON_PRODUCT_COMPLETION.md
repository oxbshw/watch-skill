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
| 2 | Persistent temporal entities and actions | **actions done**, entities pending | `HEAD` | machine-tested |
| 3 | Durable deterministic triggers | pending | — | — |
| 4 | Verification Oracle SDK | **done** | `HEAD` | machine-tested |
| 5 | Observer Loop | **done** | `HEAD` | machine-tested |
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

## Slices 2 (actions), 4 and 5 — governance, oracles, and the loop

### Governed actions (`watch_skill.actions`)

An action is a durable row moving through named states, not a function call
that either happened or did not. `succeeded` and `verified` are different
states written by different callers, so "it ran without erroring" can never be
reported as "it worked".

Approval is bound to an **effect digest** — a hash of exactly what will happen
— rather than to an action id, so an approved action that changes its payload
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
| Satisfy the approval oracle from the agent's own evidence dict | Fails — the oracle reads the store, in a separate process |

Executors are a closed registry keyed by `kind`. There is no "run this
command" executor: a command assembled from a string is a command that page
content can rewrite. A new `Channel.ACTION` egress gate sits in front of every
outbound effect, so offline mode closes it like every other channel — approval
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
— one controlled demonstration, passing on this machine:

1. a deliberately broken browser application, served on loopback;
2. success declared as two required postconditions (a DOM read and a server
   read), frozen first — a correction that only repainted the page would
   satisfy one and fail the other;
3. live browser observation, asserted while the session is still `running`;
4. a before clip cut from the rolling buffer, spanning both sides of the event;
5. verification failing against the real page;
6. a correction proposed, and the loop stopping at `awaiting_approval` —
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
errored on Windows — turning any contract containing one into `inconclusive`.
Fixed, and the end-to-end proof is what caught it.

**Not done in these slices**: temporal entity storage (Slice 2's entity half),
triggers (Slice 3).

## Blockers

| Blocker | Detail | Effect |
| --- | --- | --- |
| Real VLM proof | Insufficient disk/RAM for a local VLM download; inherited from the previous season and not retried in this environment. | Semantic vision remains deterministic-tested only. |
</content>
</invoke>
