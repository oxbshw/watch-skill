# Validation matrix

Every check that was run, the command that ran it, and what it returned. Rows
for things that were not run say so and why; an empty cell would read as a pass.

Measured on Windows 10 Pro 19045, Node v22.18.0, pnpm 10.29.1, Electron
33.4.11, against DSH 0.1.1-rc.2 @ `b150a551b8d4`.

## Gates

All seven verification gates, run individually, exit code and wall time
observed.

| Gate | Command | Exit | Time | Result |
| --- | --- | --- | --- | --- |
| Parity | `npm run verify:parity` | 0 | 1281ms | 40 capabilities classified, 40 DSH client products covered |
| Bundle | `npm run verify:bundle` | 0 | 4523ms | 11 additive rows, no collision with 137 DSH baseline rows |
| Desktop security | `npm run verify:desktop` | 0 | 1217ms | 9 declared channels, posture intact |
| Verdict authority | `npm run verify:verdict` | 0 | 1261ms | 154 source files, no product code mints a verdict |
| Slots | `npm run verify:slots` | 0 | 1402ms | 11 targets, all rendered by DSH 0.1.1-rc.2 |
| Portability | `npm run verify:portability` | 0 | 1289ms | 149 source files, no machine-specific assumption in shipped code |
| Signing | `npm run verify:signing` | 0 | 1214ms | configuration valid, development build, credentials absent |

Signing fails closed when a release is asked for:

| Command | Exit | Output |
| --- | --- | --- |
| `node scripts/verify-signing.mjs` | 0 | development build, 2 credentials absent, must be labelled unsigned |
| `node scripts/verify-signing.mjs --release` | **1** | names the 2 missing variables and refuses |

## Full suite

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check` | 0 | **1191 tests, 205 suites, 0 failures** across 42 test files |
| `npm run check` in a cold clone | 0 | **1190 tests, 0 failures**, 1m45s |

The cold clone ran one test fewer because it predates the settings-label guard
added afterwards.

## Composition

| Question | Answer | How it was established |
| --- | --- | --- |
| Rows in the composed profile | 145 | `dsh --dump-config` |
| Watch rows present | 10 of 10 | derived from the bundle, each found in the dump |
| Upstream rows lost | 0 | id-set diff against the profile without the overlay |
| Upstream rows Watch disables | 1 — `ui-brand-official` | the only `disabled: true` the bundle declares |
| That one recorded as intentional | yes | parity register: `intentionally_replaced`, ADR-001, replaced by `@deepwatch/dsh-brand` |
| Rows the manual overlay disables | 0 | disabled-set diff: identical with and without the overlay |

Every DSH agent capability is present in the composed tree: `agent-loop`,
`agent-presets`, `agent-instructions`, `compaction-basic`, `attachment-local`,
`api-remotes`, permissions, approvals, subagents, `bash-sandbox`,
`pwsh-sandbox`, `command-compact`. The 26 rows disabled in the composed profile
are DSH's own web-profile defaults plus the one replacement above.

## Applications

| | Web | Desktop |
| --- | --- | --- |
| Started from | cold clone at `71300c0` | cold clone at `71300c0` |
| Application data | `<rc root>/dsh-home` | `<rc root>/desktop` |
| HTTP | 200 | 200 (own host) |
| Served build digest | `5bbd2c3e529bee45` | `5bbd2c3e529bee45` |
| Byte-identical | — | yes |
| Mode | — | `normal`, not safe mode |
| Restart | relaunched, HTTP 200 | relaunched, HTTP 200, new pid |
| Persistent state across restart | 15 files, `1d3a27d156352c2d`, unchanged | — |

## Capture while the Desktop is running

`node scripts/qa-lifecycle-check.mjs` — **19 of 19 checks passed**.

| Check | Observed |
| --- | --- |
| Desktop alive before, during, after | pid 14536 throughout |
| Capture run 1 | exit 0, 80293ms |
| Capture run 2 | exit 0, 78940ms |
| Watch Core children | 4 → 4 → 4 |
| Host answers after each run | yes |
| Served build unchanged | `5bbd2c3e529bee45` throughout |
| Desktop restarted during capture | no |
| Two runs produce the same shot list | 38 vs 38, same order |
| Capture processes left running | 0 |

## End to end, against the cold build

| Area | Checks | Result |
| --- | --- | --- |
| Library index | 9 fixtures indexed, health `ready`, every path inside the root | pass |
| Library search | `demo` 9 hits, `verified` 2, absent term 0 | pass |
| Persist and reload | same health, same size, same answers | pass |
| Compare | all six dispositions reached by constructed cases | pass |
| Compare determinism | two calls byte-identical | pass |
| Live sources | 7 offered, exactly 1 can act (`browser-operator`) | pass |
| Live permission | start without asking refuses and reports `denied` | pass |
| Live capture | granted → `active` → 3 observations → `stopped` → released | pass |
| Live verdict authority | the receipt asserts no verdict | pass |

## OCR

Measured on this machine's CPU against an 18-sample generated corpus, judged
against thresholds committed before the run
(`packages/watch/technology/src/ocr-qualification.ts`).

| Workload | CER | Word accuracy | Passes thresholds |
| --- | --- | --- | --- |
| `ui_text` | 0.0074 | 0.9792 | yes |
| overall | 0.2355 | 0.7255 | — |
| Latin (15 samples) | 0.1669 | 0.7889 | — |
| Other scripts (2 samples) | 0.7500 | 0.2500 | no |

Reported per workload rather than as one number, so a workload the engine
cannot do at all does not hide behind one it can. The test asserts at least one
workload fails; a corpus everything passes is not evidence.

## Screenshots

| | |
| --- | --- |
| Shots defined | 38 |
| Captured | 22 |
| Not captured | 16 |
| Byte-identical duplicates | 0 |
| Reviewed by opening the file | all 22 |
| Pass | 22 |
| Fail | 0 |
| Blocked | 16 |

Full detail in [screenshot-manifest.md](screenshot-manifest.md). The 16 blocked
shots are the mode tabs and the tablist: DSH hides the session header while a
session is blank, so they need a turn, and a turn needs a provider key.

An earlier run of the same capture reported 38 successes, of which 16 were
byte-identical copies of an empty workspace filed under mode names.

## Adversarial input

`tests/hostile-input.test.mjs` — 28 tests, 0 failures. Each corresponds to a
defect that was real and fails without its fix.

| Input | Before | After |
| --- | --- | --- |
| `..%2f` in a path | accepted | refused |
| Record missing `tags` | TypeError, index lost | normalized and indexed |
| 5.4MB record | — | indexed in under 10s, searchable |
| Damaged stored index (6 forms) | — | `corrupt` with a reason, rebuildable |
| Handshake without `schemaDigests` | TypeError out of `connect()` | degrades, connects |
| Body that is not JSON | `deadline_exceeded` after 1506ms | `protocol_violation` in 2ms |
| Frame with no Content-Length | `deadline_exceeded` after 1508ms | `protocol_violation` in 2ms |
| Content-Length of 1GiB | hung indefinitely | `protocol_violation` in 2ms |
| Requests against a failing engine | one orphaned process each | none outlive the Bridge |
| `https://example.com@evil.com` | opened `evil.com` | refused |

## Not run

| What | Why |
| --- | --- |
| Linux and macOS | no such machine available; CI matrix defined but never executed, since running it requires pushing |
| Signed build | no signing credential exists here and none can be obtained from this repository |
| Mode tab screenshots | need a session that is not blank, which needs a provider key |
| The agent loop itself | needs a provider key |
| Camera, microphone, screen capture | needs real hardware and a human granting permission |

See [platform-support.md](platform-support.md) for the full external-requirement
list.
