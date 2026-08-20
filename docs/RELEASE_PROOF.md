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

---

# Browser Runtime season — `1.3.0rc2`

Operator mode: Watch Skill drives a browser itself and proves its own actions.
Everything below is measured on the reference machine.

## Architecture

One browser subsystem, two modes, sharing the page, the navigation policy, the
resource lease, the per-session profile, the navigation epochs and the evidence
log. `watch_skill.operate` is built on the existing `BrowserSource` rather than
beside it; the enabling piece is `BrowserSource.call`, which is the command
queue `navigate` and `evaluate` already used, with a reply slot. Operator
actions therefore run on the one thread that owns the page, interleaved with
the capture loop, with no second stack and no lock.

| Layer | Module |
| --- | --- |
| Types — actions, targets, receipts, verdicts | `operate/types.py` |
| Observation | `operate/observe.py` |
| Target resolution | `operate/resolve.py` |
| Execution and verification | `operate/execute.py` |
| Recovery policies | `operate/recover.py` |
| Runtime and task API | `operate/runtime.py` |
| Benchmark + fixture site | `operate/benchmark.py`, `operate/fixture_site.py` |

## Browser capability, measured

All against a real Chromium and the bundled local fixture site
(`tests/operate/test_browser_runtime.py`, 17 tests, all passing):

| Capability | Result |
| --- | --- |
| Navigation with verified effect | pass |
| Form fill, select, checkbox, submit | pass — 5-step task, `verified=True` |
| Accessible-name resolution | pass, strategy `label`, confidence 0.93 |
| Ambiguity refused | pass — 2 matches, `TARGET_AMBIGUOUS`, not guessed |
| Destructive action below confidence floor | pass — `POLICY_REFUSED` |
| Action with no expectation | pass — `UNVERIFIED`, not success |
| Click that dispatches but changes nothing | pass — `VERIFICATION_FAILED` |
| **Page says "Saved", `PATCH` returns 500** | **pass — rejected, request named in the receipt** |
| Late-rendering control | pass — settled and retried |
| Intercepting modal | pass — dismissed, retried, verified on attempt 2 |
| Side-effecting action never retried | pass — attempt stays 1 |
| New tab in the page graph | pass |
| Target inside an iframe | pass |
| Task stops at first failed step | pass |
| Prompt injection stays evidence | pass |

## Benchmark

`python -m watch_skill.operate.benchmark` — nine tasks, nine categories, ground
truth read from the fixture site's server state rather than from the browser.

| Metric | Value |
| --- | --- |
| correct_verdict_rate | **1.0** |
| **false_success_rate** | **0.0** |
| verified_task_success_rate | 0.667 |
| first_attempt_success_rate | 0.667 |
| recovery_success_rate | 0.5 |
| mean steps / attempts per task | 2.33 / 3.0 |
| median latency | 11.2 s |
| p95 latency | 19.9 s |
| by category | form, iframe, network, recovery, safety, security, tabs, timing, validation — all 1/1 |

The remaining third of `verified_task_success_rate` is tasks that are *supposed*
to be refused — an ambiguous "Delete account" and a save whose request fails.
Refusing them is the correct answer and is scored as such.

The benchmark earned its place immediately by finding a design bug the unit
tests missed: `TaskResult.verified` required every receipt to have succeeded,
but receipts record every attempt, so a step fixed by recovery left its failed
attempt in the list and a working recovery engine guaranteed an unverified
task. Verification is now judged on the final attempt per action.

## Stability

`tests/operate/test_browser_runtime.py`, isolated fresh process per run:

**20 executed / 20 passed / 0 failed / 0 skipped / 0 leaked processes.**

Free memory across the twenty runs stayed flat (2778 MB → 2700 MB), with the
last run's dip explained by an unrelated concurrent build. No Chromium,
ffmpeg or Playwright driver survived any run.

## Demo

`scripts/make_browser_demo.py` records the two things worth demonstrating:

1. A subscribe modal intercepts a click. Classified `target_obscured`,
   overlay dismissed, retried, **verified on attempt 2**, with the recovery
   trail on the receipt.
2. A settings page paints "Saved" while its `PATCH` returns 500. The runtime
   rejects it: *"PATCH /api/save returned 500 while the UI reported success"*,
   and the server's own `save_attempts` counter corroborates it.

Output in `build/browser-demo/` — generated, not committed.

## Security posture for operator mode

- Actions are a **closed enum**; no field a page could populate names a tool,
  a command or a shell.
- Uploads take an explicit file list from the caller. A page cannot request one.
- Script execution is not part of the public action surface.
- Network records strip query strings — a URL is evidence, a URL carrying a
  session token is a leak.
- Observed text is preserved verbatim as evidence and fenced as page-authored
  wherever it reaches a model context.
- The context-level route handler applies the navigation policy to every page
  in the context, adopted popups included.

## Version — `1.3.0rc2`

Incremented from `rc1` because this season materially changed the prepared RC
contents. Still `1.3.0`: purely additive — `watch_skill.operate` is a new
package, no CLI command or MCP tool was removed or renamed, and
`WORKSPACE_SCHEMA_VERSION` and `LIVE_SCHEMA_VERSION` are both still `1`.

Fourteen version surfaces are aligned: `pyproject.toml`, `uv.lock`,
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (metadata and
entry), ten `skills/*/SKILL.md`, and `watch_skill.__version__`.

## The last failure: a precondition asked at the wrong moment

Two consecutive full suites on frozen HEAD `7ea8bda` gave **run 1: 1 failed**,
**run 2: 0 failed**, with nothing changed in between. The failure:

```
tests/live/test_browser_receipt.py::test_every_declared_browser_channel_produces_evidence
CaptureError: [live.browser.memory_pressure] 1086 MB is free; this session
needs about 450 MB and 700 MB must remain for everything else
```

The governor was right again. The test's precondition,
`require_verification_browser(1)`, computes exactly the governor's requirement
— 450 MB for the browser plus a 700 MB reserve — and it had passed moments
earlier. Then free memory fell 64 MB below the line before the browser started.

**Not the scenario's own cost.** The pool takes its lease *before* spending
memory, and measuring free memory at the precondition and again immediately
before `start_live`, five times, gave a **0 MB** drop each time. The
`FixtureApp` costs nothing measurable.

**It is the machine.** Sampling free memory at 4 Hz through a run of
`tests/live` and `tests/observer` (1673 samples over 420 s):

| | |
| --- | --- |
| median free | 2073 MB |
| range | 1058 – 2324 MB |
| worst downward excursion within 1 s | **336 MB** |
| worst downward excursion within 3 s | 546 MB |
| worst downward excursion within 5 s | 640 MB |

That rules out the obvious fix. A safety margin on the precondition would need
to exceed ~640 MB to cover a five-second excursion, and 640 MB on top of the
governor's own 1150 MB requirement means the test never runs on a 7.9 GB host.
Making a race rarer by an unmeasurable amount, at the cost of never running the
test, is not a fix.

**Fix.** Ask the question once, where it is actually decided. A memory refusal
that escapes a test is the same condition the precondition already skips for,
so `pytest_runtest_setup` and `pytest_runtest_call` wrappers in
`tests/conftest.py` record it as a skip carrying the governor's own numbers.

The guard matters as much as the fix: a refusal is only converted when its
`required_mb` is within 2× the governor's configured requirement. If a browser
ever starts demanding materially more than the pool is configured for, that is
a regression, and it still fails. A regression hiding behind a resource skip
would be worse than the flake it replaces.

`tests/live/test_memory_refusal_skip.py` — 9 tests — pins both halves,
including four that run a real pytest subprocess on a generated refusing test
and assert the outcome is `skipped` for a busy machine and `failed` / `error`
for a ruinous cost. A hook that was defined but never registered would pass
every unit test while the suite kept failing, so the wiring is proved
separately from the logic.

## Final gates — frozen HEAD `5fd47b5`

### Two consecutive full suites

| Run | Collected | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| 3 | 1513 | 1489 | **0** | 24 |
| 4 | 1513 | 1488 | **0** | 25 |

Run 4's extra skip is `test_observer_loop::test_broken_app_observed_corrected_and_independently_verified`,
declined by the *existing* two-browser precondition (2050 MB needed). It is not
the new refusal path.

The green is checked rather than assumed. In both runs:

| | Run 3 | Run 4 |
| --- | --- | --- |
| `test_every_declared_browser_channel_produces_evidence` | passed | passed |
| `tests/operate` | 24 passed, 0 skipped | 24 passed, 0 skipped |
| `test_workspace_accessibility` | 6 passed, 0 skipped | 6 passed, 0 skipped |
| skips attributable to the new refusal hook | **0** | **0** |

A suite that went green by skipping the subsystem under test would prove
nothing, so that was measured rather than hoped for.

### Test collection, `3f34cf0` → this release

Baseline collected in a throwaway worktree at the season's starting commit:
**1479 → 1504** at `7ea8bda` (**+25**), then **1513** after the refusal tests.

| File | Base → Head |
| --- | --- |
| `tests/operate/test_browser_runtime.py` | — → 17 |
| `tests/operate/test_benchmark.py` | — → 7 |
| `tests/live/test_memory_refusal_skip.py` | — → 9 |
| `tests/test_docs_links.py` | 104 → 105 |

No file lost a test and none was converted to a skip. No conftest or pytest
configuration changed the collection — the only `pyproject.toml` edit is the
version string. The `test_docs_links.py` increment is that suite parametrising
over documentation files: adding `docs/browser-runtime.md` earned it one more
case.

### Build

| Gate | Result |
| --- | --- |
| `ruff check .` | clean |
| `tsc --noEmit` | clean |
| `next build` + static export | 4 pages, 113 kB first load |
| workspace inline | 6 scripts + 1 stylesheet → 502.5 KiB single document |
| **committed `workspace.html` vs freshly built** | **byte-identical — the tree stayed clean across a full rebuild** |
| `uv build` | `watch_skill-1.3.0rc2-py3-none-any.whl` (724 KB), `.tar.gz` (6.1 MB) |

### Install and smoke, from the built wheel

| Gate | Result |
| --- | --- |
| Clean venv, base wheel | installs; 79-package closure |
| `watch-skill --help` | ok |
| `watch-skill doctor` | ok — reports each absent optional feature and the command that adds it |
| `watch_skill.__version__` from site-packages | `1.3.0rc2` |
| **Installed-wheel browser smoke** | **PASS** |

The smoke drives a real Chromium from `site-packages`, never the source tree,
and checks the two things that matter: a five-step form task verified
end to end (`navigate`, `fill` via label, `select` via label, `check` and
`click` via role+name), and the false-success page **rejected** —
*"PATCH /api/save returned 500 while the UI reported success"*.

One caveat, stated rather than hidden: a fresh `playwright install chromium`
could not complete on this host — `cdn.playwright.dev` returned `ECONNRESET`
and then `ETIMEDOUT` on repeated attempts. Playwright was therefore pinned to
`1.61.0` in the clean venv so the smoke could use the already-cached Chromium
build. Both `1.61.0` and the `1.62.0` that resolved by default are inside the
declared `playwright>=1.61,<2`. The browser download path itself is
**unproven** on this host.

### Security and supply chain

| Gate | Result |
| --- | --- |
| Repository secret scan | clean — 528 tracked text files |
| Built-artifact secret scan (wheel + sdist) | clean — 696 packaged files |
| `npm audit` (production) | **0 vulnerabilities** |
| `npm audit` (including dev) | **0 vulnerabilities** |
| Python audit — `[all]` closure (116 packages) | **No known vulnerabilities** |
| Python audit — `[langchain]`, `[llamaindex]`, `[autogen]`, `[openai-agents]` | clean |
| Python audit — `[diarize]` | 1: `lightning 2.6.5` PYSEC-2026-3624 |
| Python audit — `[crewai]` | 2: `chromadb 1.1.1` PYSEC-2026-311, `json-repair 0.25.2` GHSA-xf7x-x43h-rpqh |

Every closure was resolved from the **built wheel**, per extra, rather than
read off the development environment — which is what makes "clean" mean
something. The recommended install, `watch-skill[all]`, is clean.

The three findings are all transitive, none is a package Watch Skill declares,
and none is in `[all]`:

- **`lightning`** (via `pyannote.audio`, `[diarize]`): RCE when
  `load_from_checkpoint` reads an attacker-controlled checkpoint. **No fix
  published.** Watch Skill loads only models the user chose to download.
- **`chromadb`** (via `crewai`): pre-auth code injection in a ChromaDB
  *server* endpoint. **No fix published.** Watch Skill runs no Chroma server.
- **`json-repair`** (via `crewai`): unbounded CPU on a self-referencing JSON
  Schema `$ref`. Fixed in `0.60.1`, and a constraint resolves cleanly —
  `watch-skill[crewai]` plus `json-repair>=0.60.1` gives `crewai 0.134.0` with
  `json-repair 0.63.3`.

The `json-repair` constraint is **not** applied to `pyproject.toml`. Pinning a
transitive dependency of an optional third-party adapter is how installs break
later, the defect is not reachable from Watch Skill's own code, and the user
can apply the constraint above in one line. Recorded here so the decision is
visible rather than silent.

### SBOMs

| SBOM | Spec | Components | Strict schema validation |
| --- | --- | --- | --- |
| Python (shipped closure) | CycloneDX 1.6 | 79 | **valid** |
| JavaScript (production) | CycloneDX 1.5 | 115 | **1 error** |

A correction to the previous report, which called the JavaScript SBOM
"structurally valid": under strict CycloneDX 1.5 validation it is not. One
external reference fails, and exactly one —

```
cross-spawn [vcs] git@github.com:moxystudio/node-cross-spawn.git
```

`npm sbom` emitted an SCP-style git address where the schema requires an
IRI-reference. It is npm's output, not this project's dependency data: all 115
components carry a name, a version and a purl, and the Python SBOM's only
entry without a purl is `watch-skill` itself, which has none because it was
installed from a local wheel rather than an index.

## The rendered-workspace gates, measured rather than assumed

A later suite pair on the final HEAD gave **run 5: 2 failed**, **run 6: 0
failed**. Neither failure was in this season's subsystem, and run 6 did not
retire them — it *skipped* both. So they were measured directly.

### `test_first_render_meets_its_budget`

Ten isolated runs, nothing else running, each launching its own Chromium and
loading the shipped bundle three times:

| Runs | Median range | Worst single sample | Budget | Result |
| --- | --- | --- | --- | --- |
| 10 | 1594 – 2250 ms | 2437 ms | 4000 ms | **10/10 pass** |

Roughly 2.4× headroom, and the measurement is of the real artifact:
`DevHost` serves `workspace_html()` — the same 502.5 KiB inlined document that
ships inside the Python package — over a plain local HTTP server. No dev
server, no compilation, nothing synthetic.

Against that baseline the two failures read clearly:

| Where | Samples | Median |
| --- | --- | --- |
| baseline (10 runs) | 1547 – 2437 | 1594 – 2250 |
| back-to-back UI runs | 1641, 4266, 5140 | 4266 |
| full suite on a degraded host | 4641, 13937, 14078 | 13937 |

Both failures keep a first sample inside the normal band and then lose the
later ones. That is interference arriving mid-run, not a slow baseline — and
the suite corroborates it: run 5 took **2964 s** against runs 3 and 4's
**1053 s** and **1086 s** on identical code, a 2.8× degraded host.

The test's own docstring says it is "measured with nothing competing". Nothing
enforces that. It is a documented precondition that is never checked — the
same shape of defect as the memory precondition fixed above, and it is
**recorded here rather than fixed**, because the honest options are a
contention precondition this host cannot measure reliably, or weakening the
gate. `FIRST_RENDER_BUDGET_MS` was not changed in either direction.

### `test_the_whole_scenario_is_visible_in_the_rendered_workspace`

Its one failure was diagnosed, not dismissed. The approve click **landed** —
Playwright's `click()` auto-waits, so a missing button would have raised there
instead. The button then reads as `(gone)` because the locator matches the
accessible name "Approve this exact effect", and a successful click flips that
label to "Approving…". The error banner was empty, no request failed, and the
approval stayed `pending`: the `approve_action` transport call had not
resolved inside the test's 30 s wait on a host running 2.8× slow.

### What this host does not prove

`test_the_whole_scenario_is_visible_in_the_rendered_workspace` and
`test_keyboard_reaches_every_control` hold **two** governed browsers and need
2550 MB free. This machine sits at roughly 2100 – 2400 MB. They skipped in
every one of five targeted runs and in suites 3, 4 and 6; they ran exactly
once, in the degraded run 5, where one of them failed.

**These two tests are unproven on this machine.** Three green suites do not
change that, which is precisely why the skip inventory is reported alongside
the pass count rather than underneath it.

## Closing gates — final HEAD `1e4ae40`

### Two consecutive clean full suites

| Run | Collected | Passed | Failed | Skipped | Wall |
| --- | --- | --- | --- | --- | --- |
| 7 | 1513 | 1491 | **0** | 22 | 1690 s |
| 8 | 1513 | 1491 | **0** | 22 | 1457 s |

Identical, and identical in the way that matters — both **ran** the tests
rather than skipping them:

| | Run 7 | Run 8 |
| --- | --- | --- |
| `test_every_declared_browser_channel_produces_evidence` | passed | passed |
| `test_first_render_meets_its_budget` | passed | passed |
| `test_the_whole_scenario_is_visible_in_the_rendered_workspace` | passed | passed |
| `test_keyboard_reaches_every_control` | passed | passed |
| `tests/operate` | 24 passed, 0 skipped | 24 passed, 0 skipped |
| skips from the memory-refusal hook | **0** | **0** |

### Correction: the two-browser scenarios are proven

An earlier section of this document, written after runs 5 and 6, said
`test_the_whole_scenario_is_visible_in_the_rendered_workspace` and
`test_keyboard_reaches_every_control` were "unproven on this machine". **That
is no longer true.** Both ran and passed in runs 7 and 8. The statement was
accurate when written — they had skipped in five targeted runs and three of
four suites, and failed the once they ran — and it is superseded rather than
deleted, because a report that quietly edits its own history is worth less
than one that shows where it was wrong.

What made the difference was free memory, not a code change. The scenarios
need 2550 MB; the host had it during these runs and had not during the others.

### Skip inventory — 22, in 7 reasons, all deliberate

| Count | Reason |
| --- | --- |
| 8 | real-model live VLM gate (`WATCHSKILL_TEST_REAL_VLM_LIVE`) |
| 7 | real-model ASR gate (`WATCHSKILL_TEST_REAL_ASR`) |
| 3 | no local vision model reachable |
| 1 | real-model VLM gate (`WATCHSKILL_TEST_REAL_VLM`) |
| 1 | real local-ASR recognition (`WATCHSKILL_TEST_LOCAL_ASR`) |
| 1 | real-model rendered gate (`WATCHSKILL_TEST_REAL_VLM_LIVE`) |
| 1 | POSIX permission bits — Linux-only, covered by the `ubuntu-latest` CI job |

**Zero resource skips.** Every skip is either an opt-in real-model gate or the
Linux-only executable-bit test. Nothing was skipped for want of memory, which
is the first time this season that has been true of a full suite.
