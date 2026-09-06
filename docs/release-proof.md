# Release proof

Evidence for the current release candidate: what was measured, on what, and
what the measurements do not cover. Pass or fail comes from continuous
integration; timing and memory figures come from the local host described
below. Nothing is estimated.

Historical debugging lives in commit history. This page records the final
artifact.

## Where the evidence comes from

Two sources, and they answer different questions. Continuous integration
decides whether the suite passes; the local host is where the timing and
memory figures are measured, because those are hardware-bound.

### Continuous integration

Every pull request, and every push to `main`, runs the offline suite on a
six-way matrix:

| | Python 3.11 | Python 3.12 | Python 3.13 |
|---|---|---|---|
| `ubuntu-latest` | pass | pass | pass |
| `windows-latest` | pass | pass | pass |

3.13 is in the matrix because `pyproject.toml` claims it. It was advertised
and never executed for a while, which is the same unverified claim as a
documented integration nobody tests.

Beside that suite: Ruff; the Workspace gate, whose own matrix runs on Linux,
macOS and Windows and carries a browser end-to-end pass, a cold build and the
packed artifacts; the two installer scripts on all three platforms; and a
`uvx` smoke of the candidate wheel on all three. A multi-arch Docker build with
an SBOM and a signed provenance attestation runs when the image's own inputs
change.

This matters more than a local run, and it was added to this page only after
it caught three defects a Windows-only workflow could not see: a verification
check type that opened a relative path on POSIX, a request handler that probed
hardware on every call, and a server that accepted connections before it could
answer them. A suite that passes on one platform through one invocation is a
narrower claim than it looks.

It is still catching them. Three of the last four defects surfaced on exactly
one cell of the matrix and would have shipped without it: an engine too old to
have the `bridge` command reported on macOS as a failed handshake, a disposal
check that read the whole machine's process table while sibling test files ran
in parallel, and a live cursor asserted to return the same batch twice against
a stream that was still producing. The fourth — a manual-profile overlay still
composing a twenty-second startup budget after the product moved to forty-five —
no matrix would have found, because no job builds that profile. It was found by
reading what the profile composes, and the gate that now checks it reads the
generators rather than only the declarations.

### Reference host

Timing and memory figures — *Browser runtime*, *Benchmark* and *Local model
latency* below — were measured here, so the class of machine is part of the
result.

| | |
|---|---|
| CPU | dual-core x86-64 laptop processor, ~2.6 GHz, 4 threads |
| RAM | 8 GiB |
| GPU | integrated graphics, no CUDA — CPU-only inference |
| OS | Windows 10 |
| Python | 3.11 |

A modest machine is deliberate. The browser governor, the memory preconditions,
and the model latency figures are only interesting where memory and CPU are
actually scarce; on a generous host every admission check passes and proves
nothing. Expect faster numbers on modern hardware, and read the latency figures
as an upper bound rather than a target.

The candidate's own local suite ran on a different, larger Windows 11 laptop —
16 threads, 16 GiB, Python 3.12 — which is why its skip count is lower than the
reference host's would be. Where a figure below comes from that run it says so.
Nothing is averaged across the two.

The *Browser runtime*, *Benchmark*, *Local model latency* and SBOM figures were
measured on the reference host on 2026-08-20 and are carried forward. They are
that measurement, not a fresh one, and they say so rather than being restated as
if they were. `src/watch_skill/operate/` — everything the browser figures
describe — has not changed since. The vision client and three `perceive` modules
have, in one commit that added an external-backend benchmark and fixed a
`KeyError` on circled digits, so read the latency figures as the same order of
magnitude rather than as a re-measurement.

## Method

Test counts come from the JUnit XML pytest writes, read by
`scripts/test_report.py`. Progress characters in terminal output are not a data
format — they wrap and carry percentage columns, and counting them produced
wrong totals in two earlier reports.

```bash
uv run pytest --junitxml=results.xml
uv run python scripts/test_report.py results.xml --skips
```

## Test results

`pytest` and `python -m pytest` used to disagree here: the second puts the
working directory on `sys.path` and the first does not, and for a while that
difference was the only reason five modules imported at all. `pythonpath = ["."]`
in `pyproject.toml` settles it, so both invocations now collect the same suite.

| | Collected | Passed | Failed | Skipped |
|---|---|---|---|---|
| Local snapshot, 2026-09-03 | 4642 | 4618 | 0 | 24 |

CI runs the same suite on all six matrix jobs and every one passes; the counts
there differ from the local run because the Linux jobs execute tests a Windows
host skips, and vice versa.

Skip counts move with free memory: scenarios that hold a governed browser skip
when the machine cannot afford one, and say by how much.

A pass count alone would not say much, because the resource-sensitive
scenarios can skip rather than fail. What matters is that they ran: the live
browser capability receipt, the workspace first-render budget, the two-browser
workspace scenarios, and the seventeen browser runtime tests.

### Skips

Twenty-three of the twenty-four are fixed and deliberate; one varied with free
memory. Eighteen of the fixed ones are opt-in gates for real models, off by
default because a suite that silently downloads several hundred megabytes is
not a suite that can be trusted to be offline. See
[testing tiers](testing.md).

| Count | Reason | Runs where |
|---|---|---|
| 8 | live VLM gate (`WATCHSKILL_TEST_REAL_VLM_LIVE`) | opt-in, with an interpreter carrying torch |
| 7 | ASR gate (`WATCHSKILL_TEST_REAL_ASR`) | opt-in |
| 3 | no local Ollama vision model reachable, and no provider named | a machine running one |
| 1 | VLM gate (`WATCHSKILL_TEST_REAL_VLM`) | opt-in |
| 1 | local ASR recognition (`WATCHSKILL_TEST_LOCAL_ASR`) | opt-in, with faster-whisper |
| 1 | rendered VLM gate (`WATCHSKILL_TEST_REAL_VLM_LIVE`) | opt-in |
| 1 | POSIX permission bits | the `ubuntu-latest` jobs |
| 1 | external benchmark fixtures deliberately not generated | a run that generates them first |
| 1 | resource skip: two governed browsers, 2550 MB wanted and 2520 MB free | see below |

No skip here hides a test this machine could have run. The resource skip is the
one that could, so it was re-run on its own with the machine quiet and it
passed. That is recorded as a separate isolated run, not folded into the
snapshot above: the suite skipped it, and a rerun proving it works does not
change what the suite did.

## Browser runtime

Seventeen capability tests drive a real Chromium against the bundled fixture
site. The behaviours worth naming:

| Behaviour | Result |
|---|---|
| Accessible-name resolution | strategy `label`, confidence 0.93 |
| Two matching elements, no explicit index | refused as ambiguous, not guessed |
| Destructive action resolved below the 0.75 floor | refused |
| Action carrying no expectation | `UNVERIFIED`, never `SUCCEEDED` |
| Click that dispatches but changes nothing | `VERIFICATION_FAILED` |
| Page renders "Saved" while `PATCH` returns 500 | rejected, request named in the receipt |
| Intercepting modal | dismissed, retried, verified on attempt 2 |
| Side-effecting action after failure | not retried; attempt stays 1 |
| Injected instructions in page text | preserved as evidence, cannot act |

### Stability

`tests/operate/test_browser_runtime.py`, twenty isolated runs, fresh process
each time: 20 executed, 20 passed, 0 failed, 0 leaked processes. Free memory
across the campaign stayed flat. No Chromium, ffmpeg, or Playwright driver
survived any run.

## Benchmark

```bash
python -m watch_skill.operate.benchmark --out build/benchmark
```

Nine tasks across nine categories against a bundled local fixture site. Ground
truth is read from the site's server state rather than from anything the
browser reported, so a page that renders a false success cannot score one.

| Metric | Value |
|---|---|
| correct_verdict_rate | 1.0 |
| false_success_rate | 0.0 |
| verified_task_success_rate | 0.667 |
| first_attempt_success_rate | 0.667 |
| recovery_success_rate | 0.5 |
| mean steps / attempts per task | 2.33 / 3.0 |
| median / p95 latency | 11.2 s / 19.9 s |

Read as: on this nine-task fixture benchmark, every ground-truth verdict was
classified correctly and no false-success verdict was produced. The remaining
third of `verified_task_success_rate` is tasks designed to be refused — an
ambiguous "Delete account" and a save whose request fails — where refusal is
the correct answer and is scored as such.

### What the benchmark does not establish

Nine tasks on one synthetic site is a regression gate, not a capability claim.
It does not measure performance on real websites, does not cover
authentication, single-page-app routing, shadow DOM, or CAPTCHAs, and produces
no comparison against any other tool. No competitor was measured under this
methodology, so no comparison is offered.

## Local model latency

Measured on the reference host; full method in [VLM performance](vlm-performance.md).

| | |
|---|---|
| Inference p50, idle machine | 47.1 s |
| Inference range under concurrent test load | 48.9 – 81.8 s |
| Worker spawn + model load, cold | 8.4 s |

Both numbers are reported rather than averaged. The second is what a session on
a working laptop actually experiences, and it is the reason local VLM inference
never sits in the path of an interactive action.

## Packaging

| Check | Result |
|---|---|
| `ruff check .` | clean |
| `tsc --noEmit`, `next build`, inline | clean |
| Committed `workspace.html` vs a fresh build | byte-identical |
| Wheel / sdist | 724 KB / 6.1 MB |
| Clean-venv install from the wheel, CLI, `doctor` | pass |
| Browser task driven from the installed wheel | pass |

The installed-wheel check matters more than the import check: it runs a
multi-step browser task from `site-packages` and requires both a verified
success and a correctly rejected false success.

## Distribution

Every channel below was checked against the live service on 2026-09-03 rather
than copied from an earlier report.

| Channel | State |
|---|---|
| PyPI `watch-skill` | Two published versions: `1.2.0`, which carries the `latest` tag, and the `1.3.0rc2` pre-release. The source here is `1.4.0rc1` and is not installable from PyPI. |
| Agent Skills (skills.sh) | Badge endpoint returns HTTP 200, `Skills: 2.1K`; the project page returns HTTP 200. Ten `SKILL.md` files in the repository. |
| GHCR `ghcr.io/oxbshw/watch-skill` | OCI index with `linux/amd64` and `linux/arm64`, plus two attestation manifests. |
| GitHub releases | `v1.2.0` is the latest release and `v1.3.0rc2` the newest pre-release; each carries a wheel, an sdist and `watch-skill.skill`. Nothing is tagged for `1.4.0rc1`. |
| npm | Nothing published, under any name. `watch-skill`, `@oxbshw/watch-skill` and `watch-skill-mcp` return 404, and a scope search for `@deepwatch` returns zero packages, so the twenty DeepWatch tarballs exist only as verified archives. `npx skills` runs Vercel's CLI. See [DECISIONS](DECISIONS.md). |
| MCP Registry | `server.json` committed and schema-validated; not yet published. |

A published version is not a claim about this candidate. `uvx --from
"watch-skill[standard]"` resolves `1.2.0` today, so the pre-publication checks
below run against the wheel built from this commit and never against the
registry — testing what PyPI already has would say nothing about `1.4.0rc1`.

The README states PyPI as the install channel and no longer reads as though
`npx skills add` were installing an npm package.

### Installed-wheel checks

| Check | Result |
|---|---|
| `watch-skill --version` | `1.4.0rc1` |
| `watch-skill doctor --no-fix --json` | valid JSON, 16 checks |
| MCP `initialize` over real stdio | ok |
| `tools/list` over real stdio | 39 tools |
| PyPI description carries the `mcp-name` marker | yes, survives the README rewrite |
| sdist / wheel hygiene | no `node_modules`, `.next`, caches or build junk |

## Security

| Check | Result |
|---|---|
| Secret scan, repository | clean |
| Secret scan, built wheel and sdist | clean |
| `npm audit`, production and dev | 0 vulnerabilities |
| Python audit, default and `[all]` closures | no known vulnerabilities |
| Zero egress with provider keys present | pass |
| Child-process credential redaction | pass |
| CSP validation and remote-asset rejection | pass |
| Prompt-injection boundary | pass |

Dependency audits are resolved per declared extra from the built wheel rather
than read off a development environment, because a development environment
contains tooling the product does not ship.

Three advisories affect optional integration extras and none is a package Watch
Skill declares directly:

| Extra | Package | Status |
|---|---|---|
| `diarize` | `lightning` | no fix published upstream |
| `crewai` | `chromadb` | no fix published upstream |
| `crewai` | `json-repair` | fix available upstream |

`json-repair` is not pinned. Pinning a third-party framework's transitive
dependency is how installs break later; the constraint is documented for anyone
who needs it.

### SBOM

| SBOM | Format | Components | Validation |
|---|---|---|---|
| Python | CycloneDX 1.6 | 79 | valid |
| JavaScript | CycloneDX 1.5 | 115 | one field fails strict validation |

npm emits `git@github.com:...` as `cross-spawn`'s VCS reference, and CycloneDX
1.5 requires an IRI there. The component data is correct; the serialization of
one field is not.

## Known limitations

- **Two-browser scenarios need headroom.** Scenarios holding a live source and
  a verifier at once require roughly 2550 MB free, and skip with the shortfall
  named when the machine cannot afford it. That is about what else is running,
  not about how much the machine has: the 2026-09-03 snapshot skipped one on a
  16 GiB host with 2520 MB free, and it passed when re-run on its own.
- **Local VLM inference is slow on CPU-only hardware.** Tens of seconds per
  inference. It is asynchronous evidence, not an interactive path.
- **The workspace first-render budget assumes an idle host.** The gate measures
  4000 ms against a 1594–2250 ms median, but the measurement is sensitive to
  whatever else the machine is doing.
- **The Linux executable-bit test does not run on Windows.** It is covered by
  the `ubuntu-latest` CI job.
- **The benchmark fixture is synthetic.** See the scope note above.

## Reproducing

```bash
uv sync --extra all
uv run pytest --junitxml=results.xml
uv run python scripts/test_report.py results.xml --skips

uv run python -m watch_skill.operate.benchmark --out build/benchmark
uv run pytest tests/operate/test_browser_runtime.py
uv run python scripts/secret_scan.py
```
