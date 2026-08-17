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
| 4 | One UI test failed, assertion lost | True, and it was my capture that lost it — `Select-Object -Last 4` cut the assertion out of the log. Diagnosed in §3. |
| 5 | "collected tests fell from ~1413 to 1390" | **False, and it was a counting error.** Both figures came from counting progress characters in terminal output. Real collection: **1420 → 1462 (+42)**. |
| 6 | "1363 passed, 27 skipped" | Same counting error. Authoritative JUnit XML: **1433 passed, 27 skipped, 2 failed = 1462**. |
| 7 | Demo shows processing, not a result | True, and still true — §6 records why it is blocked on this host rather than claiming otherwise. |
| 8 | `0.7.0-rc1` recommended | A downgrade against existing `v1.0.0` and `v1.2.0` tags. Corrected in §7. |

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

## 2. Test-collection diff — `695009b` → `91f31dd`

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

## 3. The "UI flake" — root cause

**It was never a UI problem.** In the same run,
`tests/observer/test_observer_loop.py` failed with the identical cause, and the
product had been stating that cause plainly the whole time:

> the verifier was unavailable 2 times in a row: 962 MB is free; this session
> needs about 570 MB and 700 MB must remain for everything else

Both scenarios hold **two governed browsers at once**: the live browser source
for the whole run, and the Observer's verification browser during `advance()`.
`BrowserPool._reject_if_starved` requires
`min_available_mb + session_cost_mb + resident model memory` to be free. Near
that line, the *second* acquisition is decided by whatever else the machine is
doing — so the failure was intermittent, and it surfaced far from its cause as
`ObserverState.FAILED is not AWAITING_APPROVAL`, with the reason inside a repr
that pytest truncated.

Measured arithmetic on this machine:

| Condition | Needed | Free | Verdict |
| --- | --- | --- | --- |
| Empty model registry | 1150 MB | 1632 MB | admits |
| With the 500 MB ASR model resident | 1650 MB | 1632 MB | **refuses, by 18 MB** |

### Why it became reachable this season

The ASR model never used to load — it failed on a network call. The previous
commit fixed that, correctly. From then on it loaded, stayed resident in the
**process-global** model registry, and every later browser admission in that
process was charged 500 MB for it.

### System state at failure, for the record

7.9 GB total RAM; 0.9–1.8 GB free across attempts. 2.6 GB held by the
operator's own Chrome (1 parent, 34 children — confirmed not Playwright).
**No leaked test processes**: no stray Chromium, ffmpeg, ASR or VLM workers,
and no leaked browser leases.

### Fixes — none of them a timeout

1. **Process-global state is reset between tests.**
   `lifecycle_reset_for_tests()` has always existed for exactly this and
   nothing called it, so a model one test loaded stayed resident for every test
   after it. Browser leases are released for the same reason.
2. **The precondition is checked before the scenario starts**
   (`require_verification_browser`), skipping with the arithmetic when the
   machine cannot hold both browsers. It is a **resource skip and says so** —
   not a pass.
3. **The 4000 ms first-render budget moved to its own gate**, unchanged at
   4000 ms, judged on the median of three samples with nothing else running.
   Asserting it at the end of a scenario that had just driven two browsers, an
   Observer run and a full verification was measuring the machine's spare
   capacity, not the workspace's render cost.

### Diagnostics added, so this is never re-diagnosed from a tail

Every console error with the network events that explain it (not the first
three); `stop_reason`, attempts, pool diagnostics and free RAM on a failed
observer state; a Playwright trace written on every run, pass or fail; and a
dev host that no longer prints a traceback per aborted connection — those used
to bury the assertion under hundreds of lines.

### Residual honesty

Under a deliberately lowered memory budget the browsers are admitted but the
machine thrashes: three runs produced a `Page.reload` timeout, an approval-click
timeout, and a pass. That is a hardware ceiling, now measured rather than
asserted. **This machine cannot run the two-browser scenario reliably while
2.6 GB is held by another application.**

## 4. Skip inventory — all 27

From JUnit XML, 27 skips across 12 distinct reasons.

| # | Tests | Subsystem | Reason | Needs | Ran via opt-in gate | Release-blocking | CI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 8 × `test_real_vlm_live` | live vision | real-model live VLM gate | `WATCHSKILL_TEST_REAL_VLM_LIVE`, torch interpreter, pinned revision | **Yes — 8/8 passed** | No | `integration.yml` |
| 2 | 7 × `test_real_asr` | ASR | real-model ASR gate | `WATCHSKILL_TEST_REAL_ASR`, faster-whisper + cached model | **Yes — 27 passed, 1 skipped** | No | `integration.yml` |
| 3 | 3 × `test_real_vlm` | vision provider | no Ollama vision model running, no provider named | a local Ollama vision model, or `WATCHSKILL_TEST_VLM_PROVIDER` | No — a key in the environment is not consent to spend it | No | `integration.yml` |
| 4 | 1 × `test_the_blocker_is_recorded_when_no_model_is_reachable` | vision provider | `WATCHSKILL_TEST_REAL_VLM` unset | as above | No | No | `integration.yml` |
| 5 | 1 × `test_langchain_tools` | adapters | langchain extra not installed | `langchain-core` | **Yes — passed in isolated env** | No | `ci.yml` extras matrix |
| 6 | 1 × `test_openai_agents_tools` | adapters | openai-agents extra not installed | `openai-agents` | **Yes — passed** | No | `ci.yml` extras matrix |
| 7 | 1 × `test_llamaindex_tools` | adapters | llamaindex extra not installed | `llama-index-core` | **Yes — passed** | No | `ci.yml` extras matrix |
| 8 | 1 × `test_autogen_tools` | adapters | autogen extra not installed | `autogen-core` | **Yes — passed** | No | `ci.yml` extras matrix |
| 9 | 1 × `test_crewai_tools` | adapters | crewai extra not installed | `crewai` (heavy transitive tree) | **No** | No | `ci.yml` extras matrix |
| 10 | 1 × `test_local_whisper_transcribes_real_speech` | live audio | `WATCHSKILL_TEST_LOCAL_ASR` unset | faster-whisper + cached model | **Yes — passed** | No | `integration.yml` |
| 11 | 1 × `test_the_real_models_reading_is_visible_in_the_rendered_workspace` | workspace UI | real-model rendered gate | `WATCHSKILL_TEST_REAL_VLM_LIVE` | **Yes — passed** | No | `integration.yml` |
| 12 | 1 × `test_extracted_linux_binaries_are_executable` | health | POSIX permission bits | a POSIX host | N/A | **Yes — needs Linux CI before release** | `ci.yml` (Linux job) |

Nothing in this table is described as a pass. Rows 1, 2, 5–8, 10 and 11 were
run through their opt-in gates and passed there; the skip in the default suite
is the skip, and the gate result is the gate result.

Row 12 is the only release-blocking entry: a POSIX-only assertion that this
Windows host cannot execute and that must be covered by a Linux CI run before
any public release.

## 5. Security and accessibility gates

Each reported on its own, because "the audit was clean" is a summary that can
hide which audit did not run.

| Gate | Result |
| --- | --- |
| Python dependency audit (installed wheel env, `pip-audit`) | **No known vulnerabilities.** First pass flagged 6 in `pip` 24.0 — the venv's own bundled tool, not a shipped dependency; clean after upgrading it. |
| npm dependency audit | **0 vulnerabilities** |
| Repository secret scan | Clean — 6 matches, all deliberate redaction fixtures (`AKIAIOSFODNN7EXAMPLE` is AWS's published example) |
| **Built-artifact** secret scan (wheel + sdist, 667 files) | **Clean** |
| Python SBOM | `sbom/watch-skill-python.cdx.json` — CycloneDX 1.6, 144 components |
| JavaScript SBOM | `sbom/watch-skill-npm.cdx.json` — CycloneDX 1.5, 115 components |
| Zero egress with provider keys present | pass (`tests/test_policy.py`) |
| Child-process environment redaction | pass — worker `env_audit` reports 0 credential-shaped variables with 2 sentinels planted |
| CSP validation | pass (`test_the_policy_forbids_remote_code_and_eval`) |
| Remote-asset rejection | pass (`test_the_bundled_document_loads_nothing_remote`) |
| Prompt-injection boundary | pass (`tests/live/test_visual_injection.py`) |
| Approval-token redaction | pass (`tests/live/test_browser_policy.py`, and asserted in the UI scenario) |
| Side-effect idempotency | pass (`tests/actions/test_approvals.py`) |

125 tests across those suites: **125 passed, 0 skipped, 0 failed.**

### Accessibility — every required gate, not just the axe count

| Gate | Result |
| --- | --- |
| axe-core scan (serious + critical) | **0 violations** |
| Full keyboard navigation | pass — 40 tabs, every stop reachable |
| Visible focus | pass — every tabbable element asserted to have an outline or box-shadow |
| Contrast | pass — 3 serious defects found and fixed in the stylesheet last season, re-verified |
| Reduced motion | pass — computed durations read back from the document, ≤1 ms |
| Narrow viewport (420 px) | pass — no horizontal body scroll, header under 260 px, no button under 24 px |
| Screen-reader labels | pass — Live stage, Evidence, Verification, Sessions and Vision model all named; a real tablist with exactly one selected tab; live regions present |

axe-core is injected from `node_modules`, never a CDN: the workspace CSP has no
remote origins, so a test that fetched its own auditor would be auditing a page
the product never serves.

## 6. Demo — blocked, and why

**Not produced. The requirement is not met, and nothing here substitutes for
it.**

A demo showing all fifteen required states needs the full scenario — a live
browser source, evidence, a real SmolVLM observation, a failed postcondition,
a human approval, an exactly-once correction and a deterministic verification.
That scenario holds two governed browsers and, measured in §3, needs about
2.5 GB genuinely free. This host has 2.1 GB free while another application
holds 2.6 GB, so the scenario deterministically skips.

The low-overhead approach the brief describes — capture timestamped frames
during one genuine session, encode only after the session and the VLM worker
have stopped — is the right design and remains the plan. It does not help
here: the blocker is the session itself, not the encoding.

Retained as a **diagnostic artifact, not the demo**:
`docs/assets/workspace/workspace-live-demo.mp4` (88 KiB, 28 s), which shows a
genuine session with `LIVE FRAMES` and `PROCESSING WITH VLM` but no completed
reading. `docs/assets/workspace/workspace-vlm-historical.png` remains the
evidence that a completed real observation reaches the interface, with its
media timestamp, frame hash, 105.6 s latency and `STALE FOR ACTION` label.

What would unblock it: roughly 2.5 GB free on this host, or any host with
4 GB+ free.

## 7. Version recommendation — `1.4.0rc1`

**Internal recommendation only. The public version in `pyproject.toml` is
unchanged at `1.2.0`;** it is not moved to match a report.

| Candidate | Verdict |
| --- | --- |
| `0.7.0-rc1` | **Rejected.** Lower than the existing `v1.0.0` and `v1.2.0` tags — it would be a downgrade. |
| `2.0.0rc1` | **Rejected.** A release candidate asserts a feature-complete v2, and the ecosystem and remote-platform matrix are not complete. |
| `2.0.0a1` | Rejected: nothing here breaks a documented contract, so this does not begin a v2 line. |
| **`1.4.0rc1`** | **Chosen.** |

Reasoning, checked rather than assumed:

- The roadmap states this work "builds on them without breaking the contracts".
  It does.
- `WORKSPACE_SCHEMA_VERSION` and `LIVE_SCHEMA_VERSION` are both still `1`.
- The MCP Apps contract is byte-identical: SDK pin `1.7.5`, MIME
  `text/html;profile=mcp-app`, meta key `ui/resourceUri`, URI
  `ui://watch-skill/workspace`.
- Every schema change is **additive** — `preview`, `detectors.semantic`, and
  the new provenance/timing/freshness blocks on a semantic observation.
- The Vite → Next.js migration changed the build, not the resource contract.
- `1.4.0` rather than `1.3.0` because the unreleased changelog already holds a
  complete feature increment (live audio) ahead of this one.

One behavioural change is worth naming: **local ASR no longer downloads a
missing model at runtime.** A user without a cached model now gets a structured
error naming the exact command to fetch it. That is a deliberate hardening
consistent with the project's stated rule that a live session must never start
a download, and it fails loudly rather than silently — but it is a behaviour
change, and a release note must say so.

## 8. Final gates on frozen HEAD `21c8124`

Tree clean at freeze.

| Gate | Result |
| --- | --- |
| Full suite, run 1 | **1439 passed, 30 skipped, 1 failed** |
| Full suite, run 2 | **1441 passed, 29 skipped, 0 failed** |
| Two *consecutive* clean runs | **NOT ACHIEVED** |
| Ruff | clean |
| Security + accessibility suites | 125 passed, 0 skipped, 0 failed |
| Accessibility (6 gates) | all pass |
| Leaked Chromium / ffmpeg / VLM / ASR workers | none |
| Leaked browser leases | none (0 active) |
| Wheel / sdist | 683 KiB / 6.0 MB (unchanged) |
| Python audit / npm audit / secret scans / SBOMs | all pass (§5) |

Run 1's single failure was
`tests/entities/test_entities::test_concurrent_observers_converge_on_one_entity`
— `OperationalError: database is locked`. Worth stating plainly: the store is
already configured for concurrent access (WAL, `busy_timeout=30000`,
`timeout=30.0`, `isolation_level="IMMEDIATE"`), so a lock surviving 30 seconds
means the machine was starved, not that the configuration is wrong. It is a
different failure from the browser one and has **not** been root-caused.

Skips differ between the two runs (30 vs 29) because the resource skips added
in §3 depend on free memory at the moment they are evaluated. That is the
intended behaviour — the count moving is the precondition working — but it
means the skip total is a property of the host, not a constant.

**The gate is not met.** The brief requires two consecutive clean full suites
on one HEAD; this is one clean and one failed. No further commits were made
after `21c8124`, so a re-run starts from this same HEAD.

## 9. Remaining work before a public release

Ordered by what blocks a release first.

1. **Two consecutive clean full suites on one HEAD.** Not achieved (§8).
2. **Root-cause the `database is locked` failure** in
   `test_concurrent_observers_converge_on_one_entity`. Seen once in two runs;
   not diagnosed. The store's configuration is already correct, so the
   candidates are host starvation or a lock held across an unexpectedly long
   operation — that distinction has not been established.
3. **The demo showing all fifteen states** (§6). Blocked on ~2.5 GB free.
4. **The two-browser scenario needs a host with ~2.5 GB genuinely free.** This
   one has 2.1 GB while another application holds 2.6 GB, so
   `test_workspace_ui`, `test_observer_loop` and the rendered VLM proof all
   skip here rather than run.
5. **Linux CI coverage for the POSIX-only test** (skip inventory row 12) — the
   only release-blocking skip.
6. **20 clean isolated runs of the previously failing test.** Three were run
   before the corrected precondition landed (1 pass, 2 fail, both diagnosed);
   the remaining runs have not been executed under the corrected precondition.
7. `crewai` extra never exercised.
8. The v2 ecosystem and remote-platform matrix, which is why no `2.0.0`
   designation is claimed.
