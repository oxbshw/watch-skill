# Release proof ledger

Closing the proof, stability and release-integrity gaps around work that was
already built. No product features were added in this pass.

Every number here comes from a run on this machine, and where a number in an
earlier report was wrong, the correction says so rather than quietly replacing
it.

## 1. Corrections to the previous report

| # | Claim made | What is actually true |
| --- | --- | --- |
| 1 | "7 commits this season" while listing 8 | **8** commits: `30a6820`, `f78f12d`, `6739117`, `5e6297e`, `b864434`, `fd70d89`, `a441862`, `dd0aadd`. The brief named seven boundaries; the demo became a separate eighth. |
| 2 | Full suite run twice consecutively | It was not. Run 1 passed, run 2 **failed**, run 3 passed — three runs, never two clean in a row. |
| 3 | Final suite run on the final HEAD | It predated `dd0aadd`. The suite had not been run on the HEAD that was reported. |
| 4 | One UI test failed, assertion lost | True, and it was my capture that lost it — `Select-Object -Last 4` cut the assertion out of the log. Diagnosed and fixed in the previous pass; the
remaining `database is locked` failure is diagnosed in §3 here. |
| 5 | "collected tests fell from ~1413 to 1390" | **False, and it was a counting error.** Both figures came from counting progress characters in terminal output. Real collection: **1420 → 1462 (+42)**. |
| 6 | "1363 passed, 27 skipped" | Same counting error. Authoritative JUnit XML: **1433 passed, 27 skipped, 2 failed = 1462**. |
| 7 | Demo shows processing, not a result | Fixed — §11. Encoding now runs after the session stops. |
| 8 | `0.7.0-rc1` recommended | A downgrade against existing `v1.0.0` and `v1.2.0` tags. Corrected in §12. |

A note on how #5 and #6 happened, because the lesson is the point: both came
from counting `.` and `s` characters in `pytest -q` output rather than reading
a machine-readable result. Progress output wraps, carries `[ nn%]` columns, and
is not a data format. Every count in this document comes from JUnit XML or from
a collection dump.

Even that had a trap. The first version of the XML parser used
`case.find("failure") or case.find("error")` — and an ElementTree element with
no children is falsy, so every failure was discarded and a run with two
failures reported as entirely green. Fixed, and worth stating: the tooling that
checks the tests needs checking too.

## 2. Test-collection diff — `695009b` → this release

| | |
| --- | --- |
| Baseline collected | 1420 |
| Head collected | 1462 |
| Net | **+42** |
| Added | 44 |
| Removed | 2 |
| Silently converted to skips | **0** |
| Skip marks removed | 0 |
| Removed by the Vite → Next.js migration | **0** |

Added, by file:

| File | Tests |
| --- | --- |
| `tests/live/test_vlm_backend.py` | 18 |
| `tests/integration/test_real_vlm_live.py` | 8 |
| `tests/surfaces/test_preview_transport.py` | 8 |
| `tests/live/test_semantic.py` | 5 |
| `tests/surfaces/test_workspace_accessibility.py` | 4 |
| `tests/surfaces/test_workspace_ui_vlm.py` | 1 |

Removed — both deliberate contract replacements, documented in `30a6820`:

| Removed | Replaced by |
| --- | --- |
| `test_a_frame_arriving_mid_call_is_skipped_not_queued` | `test_the_keyframe_queue_is_small_and_bounded` and `test_a_more_informative_frame_takes_the_slot_and_the_loser_is_recorded` — the "skip while busy" contract became a bounded priority queue. |
| `test_a_stale_answer_cannot_overwrite_a_newer_one` | `test_a_late_answer_is_published_as_evidence_not_discarded` — a late result is no longer discarded, so the old assertion asserted the opposite of the intended behaviour. |

No test disappeared without a named successor.

## 3. `database is locked` — root cause

**Symptom.** The entities concurrency test failed intermittently with
`OperationalError: database is locked`, only under threads, and despite WAL,
`busy_timeout = 30000`, `timeout = 30.0` and `IMMEDIATE` isolation all being in
place. Raising the timeout was therefore not a candidate fix.

**Evidence.** With another connection holding a write transaction and a
30-second busy timeout set on the connection under test:

| Statement | Result |
| --- | --- |
| `PRAGMA journal_mode = WAL` | `database is locked` after **0.000 s** |
| `BEGIN IMMEDIATE` | `database is locked` after **33.115 s** |

The second is the busy handler working. The first is SQLite declining to invoke
it: switching journal mode needs a brief exclusive lock, and that path returns
`SQLITE_BUSY` immediately.

**Root cause.** All eight database modules ran that pragma on *every* connect.
On an established database the mode is already `wal` and the attempt is free —
which is why normal use never saw it. On a *fresh* database, which every
isolated test and every new install starts with, the mode genuinely has to
change, so eight threads connecting at once became eight racers for a lock no
timeout covered.

**Fix.** `enable_wal()` in `sqlite_util`, used by all eight modules. It reads
the mode first and only attempts the switch when one is needed, so the common
path takes no exclusive lock at all. Losing the race is treated as another
connection doing the work — correct, because journal mode is a property of the
database file and persists once set.

**Regression proof.**

- `tests/test_sqlite_concurrency.py` pins the raw pragma failing under a 30 s
  timeout, asserts `enable_wal` does not raise while locked out and does switch
  once free, asserts the already-WAL path is free, and reproduces the original
  eight-thread race on a fresh database behind a barrier.
- `tests/entities/test_entities.py`: **25 consecutive clean runs**.
- The instrumented reproducer captured a real `database is locked` on that
  pragma during a 30-round run and **absorbed it with zero round failures**.
  Cumulative time on the write attempt fell from 2.992 s to 0.058 s.

## 4. Two further product defects found while auditing global state

**Live runners were never unregistered.** `_running[session_id]` was set on
start and removed by nothing. The process retained every finished session's
source, pipeline and frame buffers, and `running_session()` could return a
runner for a session that had already ended. Runners now leave the registry
when they stop.

**`Pipeline.stop(timeout=T)` cost up to 3T.** The timeout was applied to each
stage thread in turn rather than as a single deadline, so a three-stage
pipeline took three times the budget its caller asked for. Stage loops poll
every 200 ms; what spends the budget is a handler already running, and that is
now paid once. Pinned by a regression test.

## 5. Test isolation

Process-global state that outlived a test, and what was done about it:

| State | Before | Now |
| --- | --- | --- |
| Model registry | leaked (fixed previously) | reset per test |
| Browser leases | leaked (fixed previously) | released per test |
| Live session runners | leaked — kept browsers and ffmpeg alive | `stop_all()` per test |
| OCR engine cache | leaked, invisible to the governor | released before memory-sensitive scenarios |
| Embedding model cache | leaked, invisible to the governor | released before memory-sensitive scenarios |

The OCR cache is deliberately **not** cleared after every test. Clearing it per
test made a live session rebuild RapidOCR mid-run — tens of seconds of CPU
competing with model inference — and that starved the real-VLM gate into
completing **zero** inferences in 150 s where it had previously completed
three. It is released instead at the moment the memory is wanted, inside
`require_verification_browser`, immediately before free memory is measured.

## 6. Resource preconditions

The two-browser scenarios declare their measured cost rather than sharing one
constant. Measured after the leaks above were fixed: a live browser source with
OCR at steady state costs **196 MB**, peaks at **477 MB**, and returns all of it
at teardown (2334 MB free before, 2396 MB after).

| Scenario | Allowance | Why |
| --- | --- | --- |
| Observer loop | 900 MB | live source + verifier |
| Rendered UI proof | 1400 MB | the above plus a Playwright driver and the dev host; measured at ~1233 MB |

The previous single constant of 1340 MB was measured on the UI scenario *while*
the leaks were inflating it, then applied to the Observer scenario as well —
skipping a test this machine runs comfortably. No governor headroom was
reduced: the reserve, the per-session cost and the refusal are untouched.

## 7. Stability campaign

`tests/observer/test_observer_loop.py`, isolated fresh process per run:

**20 executed / 20 passed / 0 failed / 0 skipped / 0 leaked processes.**

Free memory across the twenty runs stayed flat (4430 MB → 4342 MB), which is
the leak fixes holding: before them, live runners kept browsers alive after
every test.

Two earlier attempts on the same code ran while another application held 4 GB
and while this session's own installs were competing; they produced 6 passes,
0 failures and 34 resource skips. Skips do not count toward the twenty.

## 8. Skip inventory

From JUnit XML on the final HEAD. Every skip is classified; none is described
as a pass.

| Tests | Subsystem | Reason | Class | Ran via opt-in gate | Release-blocking |
| --- | --- | --- | --- | --- | --- |
| 8 | live vision | real-model live VLM gate | external model | **Yes — 7 passed, 1 skipped** | No |
| 7 | ASR | real-model ASR gate | external model | **Yes — 27 passed, 1 skipped** | No |
| 3 | vision provider | no Ollama vision model running, none named | optional integration | No — a key in the environment is not consent to spend it | No |
| 1 | vision provider | `WATCHSKILL_TEST_REAL_VLM` unset | optional integration | No | No |
| 5 | adapters | framework extra not installed | optional dependency | 4 of 5 run in an isolated env; `crewai` not | No |
| 1 | live audio | `WATCHSKILL_TEST_LOCAL_ASR` unset | external model | **Yes — passed** | No |
| 1 | workspace UI | real-model rendered gate | external model | **Yes — passed** | No |
| 1 | health | POSIX permission bits | platform exclusion | N/A on Windows | **No longer** — see below |
| 1 | live audio | needs `WATCHSKILL_TEST_SPEECH_WAV` | test fixture | No | No |
| 0–3 | observer / UI | resource precondition | hardware constraint | Runs when ~2 GB is free | No |

**The POSIX skip is no longer release-blocking.** It asserts the *filesystem
effect* of `chmod` and can only run where permission bits exist. The guarantee
it protects — that every extracted Linux binary is granted an execute bit — is
now also asserted on any platform by
`test_every_extracted_linux_binary_is_asked_to_be_executable`, which runs the
real extraction path and checks the mode requested. The end-to-end assertion
remains covered by the existing `ubuntu-latest` job in `.github/workflows/ci.yml`.

It was **not** executed locally: this host has no WSL distribution installed
and no Docker. Inventing a Linux environment was out of scope, and pushing
merely to trigger CI is not a local proof.

## 9. Security and supply chain

| Gate | Result |
| --- | --- |
| Python dependency audit — shipped tree only | **No known vulnerabilities** (base wheel and `[all]` extras, audited by path) |
| Python dependency audit — full dev/tooling env | 1 finding: `setuptools 79.0.1`. **Not a shipped dependency** — nothing in watch-skill's tree requires it; it is required only by `packageurl-python`, a dependency of the SBOM tool, and by venv bootstrap. |
| npm dependency audit | **0 vulnerabilities** |
| Repository secret scan | clean — 512 tracked files |
| Built-artifact secret scan (wheel + sdist) | clean — 671 packaged files |
| Python SBOM | CycloneDX 1.6, 66 components, structurally valid, 0 incomplete entries |
| JavaScript SBOM | CycloneDX 1.5, 115 components, structurally valid, 0 incomplete entries |
| Zero egress with provider keys present | pass |
| Child-process credential redaction | pass — worker reports 0 credential-shaped variables with 2 sentinels planted |
| CSP validation / remote-asset rejection | pass |
| Prompt-injection boundary | pass |
| Approval-token redaction | pass |
| Side-effect idempotency | pass — the demo run applied its correction exactly once |

Both scans and both SBOMs were produced from the **final** artifacts, not an
earlier commit.

### Prompt / agent boundary

Observed content — OCR text, page text, transcripts, model output — is carried
as evidence and never as instruction. The workspace renders page-authored text
through a fenced `UNTRUSTED — TEXT WRITTEN BY THE OBSERVED PAGE` block; the
semantic observation schema is `advisory: true` with
`provenance.kind = model_inference` and has no field that could name a tool, a
command or an action; and verdicts are established by deterministic oracles,
not by a model. A late model reading additionally loses the right to drive a
present-tense action via its freshness classification.

## 10. Accessibility

| Gate | Result |
| --- | --- |
| axe-core scan (serious + critical) | **0 violations** |
| Full keyboard navigation | pass |
| Visible focus on every tabbable element | pass |
| Contrast | pass |
| Reduced motion | pass — computed durations read back, ≤1 ms |
| Narrow viewport (420 px) | pass — no horizontal body scroll |
| Screen-reader labels — preview, evidence, verdict | pass — plus a real tablist with exactly one selected tab and live regions present |

axe-core is injected from `node_modules`, never a CDN: the workspace CSP has no
remote origins, so a test that fetched its own auditor would be auditing a page
the product never serves.

## 11. Demo

`scripts/make_demo.py` records one genuine session and encodes it **after**
every worker has stopped. The previous attempt ran the encoder alongside live
capture and inference, starved the machine, and produced a clip that showed a
processing state and never a result.

Recorded run: **430 persisted events** across `browser_event`, `error`,
`scene_change`, `session_started`, `session_stopped` and `visible_text_change`;
verification attempts **1 fail → 2 pass** at `isolated_local`; correction
applied **exactly once**; contract digest `sha256:0eff84d0…`. The frame at the
verdict shows the live preview, the verified verdict naming its oracle and
assurance level, the exact proposed effect, and 189 browser events each fenced
as text the observed page wrote.

Output goes to `build/`, which is ignored — the artifact is generated, not
committed. A manifest records the session id, the beats with frame numbers, the
persisted event count and the verdict, so each displayed state traces back to
the session.

The vision panel reads `DEGRADED — no_semantic_backend` in this recording
because no VLM was attached to the demo session: at ~89 s per inference the
model would not have produced a reading inside the scenario. The real VLM is
proved by its own gate and by `docs/assets/workspace/workspace-vlm-historical.png`.

## 12. Version — `1.3.0rc1`

Applied to every canonical surface, all of which must agree exactly:
`pyproject.toml`, `uv.lock`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json` (both the metadata and the entry), the
ten `skills/*/SKILL.md` manifests, and `watch_skill.__version__` via
installed metadata — with release notes in `CHANGELOG.md`.
**Not tagged, not published.**

Fourteen surfaces, and the suite found the four that a manual sweep
missed: the skill manifests, `uv.lock`, the stale editable-install
metadata behind `__version__`, and a `1.3.0-rc.1` spelling in the plugin
manifests that `test_versions_agree_across_manifests` requires to match
`pyproject` character for character.

| Candidate | Verdict |
| --- | --- |
| `0.7.0-rc1` | Rejected — below the existing `v1.0.0` and `v1.2.0` tags. |
| `2.0.0rc1` / `2.0.0a1` | Rejected — nothing breaks, so this does not begin a v2 line. |
| `1.4.0rc1` | Rejected — `1.3.0` is unused: no tag, no changelog entry, no history. Skipping it would leave a permanent unexplained gap. |
| **`1.3.0rc1`** | **Chosen** — the next minor after `1.2.0`, as a release candidate. |

Compatibility, verified rather than assumed:

- CLI commands: **additions only** (`capture-capabilities` and two others); none removed.
- MCP tools: **2 added** (`watch_workspace`, `workspace_snapshot`); none removed.
- `WORKSPACE_SCHEMA_VERSION` and `LIVE_SCHEMA_VERSION`: both still `1`.
- MCP Apps contract byte-identical: SDK pin `1.7.5`, `text/html;profile=mcp-app`, `ui/resourceUri`, `ui://watch-skill/workspace`.
- Dependencies: additive extras only.

One behaviour change is called out in the release notes: local ASR no longer
downloads a missing model, and fails with the exact command to fetch it.
