# Changelog

## v1.4.0 — 2026-09-05

The first stable release of both products in this repository. Watch Skill
reaches **1.4.0**, and the twenty `@deepwatch/*` packages reach **0.1.0** — their
first publication rather than an update.

No product behaviour changed between `1.4.0rc1` and `1.4.0`. The candidate's
entry below still describes what the software does; this entry describes
finishing the path that puts it in front of somebody, which turned out to
contain three defects that only a stable release could expose.

### The first npm publication cannot use trusted publishing

`release-deepwatch.yml` publishes over OIDC with no token path at all. It cannot
perform the *first* publication, because npm requires a package to already exist
before a Trusted Publisher can be configured for it — npm's own documented
prerequisite for `npm trust`, and
[npm/cli#8544](https://github.com/npm/cli/issues/8544), the request to lift it,
is still open. PyPI has no such limitation, which is why Watch Core's train
needs no equivalent step.

So the first publication of the twenty packages uses a short-lived credential
held by the release owner, through `scripts/first-publish.mjs`, which refuses a
dirty tree, a wrong digest, a changed file list or dependency graph, a
`workspace:` fallback, and an order that does not match the manifest graph.

**That one publication is the only DeepWatch release without provenance
attestation.** Provenance is generated from a CI workload identity and a laptop
does not have one. Every release after it goes through the workflow, with
`--provenance` and a protected environment in front of it. Saying so here is
better than letting somebody find it as a missing badge.

[`docs/releasing.md`](workspace/docs/releasing.md) now carries the
`npm trust github` loop that configures all twenty publishers from a terminal,
and the `npm trust list` read-back that proves each one exists — the failure
being guarded against is a publisher that was silently not created on the
twentieth package.

### Post-publish verified the wrong version and reported green

`post-publish.yml` triggers on `release: published`. In `release.yml` the GitHub
Release is created by one job and PyPI receives the distributions from the
*next* one, so at the instant the workflow started, the newest version on PyPI
was still the previous release. Resolving "whatever is newest" at that moment
did not fail — it succeeded against the wrong version. A check that passes for
the wrong reason is worse than one that breaks.

It now takes the version from the release's own tag and waits, up to ten
minutes, for PyPI to serve exactly that version before any runner starts.
Dispatching it by hand with no version still smokes whatever is currently
newest, because in that case nothing is in flight.

### A stable version published under a prerelease dist-tag

`scripts/first-publish.mjs` hardcoded `--tag preview`. That was correct while
every version was `0.1.0-preview.N` and silently wrong the moment one was not:
a stable `0.1.0` published under `preview` leaves `npm i @deepwatch/cli`
resolving nothing at all, because `latest` would never have been created. The
bootstrap and the workflow now derive the tag from the version's shape by the
same rule, and both refuse a prerelease shape neither has a tag for, rather than
guessing about a publication that cannot be taken back.

`scripts/promote-versions.mjs` is the authority for a version change across the
tree. It separates the surfaces a promotion must update from the historical
records it must leave alone — a changelog that says `1.3.0` is not stale, it is
a record — and `tests/stable-versions.test.mjs` asserts the result: every
manifest at its stable version, no prerelease sibling dependency, both tag
prefixes intact, and no bare `v*` trigger that would let one product's tag
release the other.

### One branch

The repository now has a single branch. Every other branch was deleted only
after its commits were accounted for as contained, already applied, or
explicitly rejected with a reason and a condition for revisiting;
[`docs/branch-consolidation.md`](docs/branch-consolidation.md) records each
disposition and how to re-check it, because a deleted branch leaves no evidence
of itself and "merged" and "abandoned" look identical afterwards.

Dependabot stays enabled. A branch list that stays empty because nothing is
allowed to check dependencies is not a tidy repository.

### The README, and the evidence under it

The root README was rebuilt around the two ways in — the DeepWatch workspace,
and Watch Skill as an MCP server or Claude Skill — rather than presenting one
product with the other in a footnote. It states three tool counts separately,
because 39 standalone MCP tools, 22 DeepWatch `watch_*` tools and 47 advertised
profile entries are three different numbers that were previously used
interchangeably.

Every screenshot in it was recaptured from this release's build, in a clean room
composed only from the sealed artifacts. The version panel in those images reads
`1.4.0` and `0.1.0` because that is what was running when the shutter fell.

## v1.4.0rc1 — 2026-09-03 (release candidate)

The 1.4 candidate closes the real DeepWatch authority path: supervised browser
operations now return stable Core-owned evidence and receipts, Node talks to the
packed Python Bridge in required integration tests, and runtime readiness is one
truth shared by onboarding and Diagnostics. The companion DeepWatch workspace
remains an unpublished preview; its 20 npm packages are prepared as verified
tarballs and are not published by this release-candidate build.

The first-run and product surfaces now use one responsive DeepWatch design
language across Watch, Live, Memory, Library, Compare, settings and evidence.
“Into the Know” appears only on DeepWatch-owned surfaces until the pinned
Harness exposes a supported headline extension.

### Release closure — what an owner evaluation found, and what it changed

An owner evaluation of this candidate produced findings that split into two
kinds, and telling them apart mattered more than fixing them.

Two were errors in the evaluation itself, and are retracted here. The default
`deepwatch` profile was reported as advertising no agent tools; it advertises
47, and the measurement had read a preparation completion rather than the one
carrying tools. A workspace write was reported as refused by filesystem policy;
the harness had passed `path` to a tool whose advertised argument is
`file_path`, so a caller's typo was read as a policy decision. Both now have
gates that would have caught them.

The rest were real.

**One execution, one receipt.** A call the containment screen refused produced
two records: the truthful one, and then a second when the denial travelled back
through the dispatch layer as an ordinary error and settled as
`scopeDecision: 'allowed'`. Both carried the same idempotency key, and the
Library keeps receipts in a map keyed by exactly that — so the record an owner
read said the boundary let through a call the boundary had stopped. The ledger
is now keyed by execution identity and every producer writes through one
reconciliation: a denial is permanent, a terminal state is final, progress only
moves forward.

**Compare had no records.** The engine was correct and unreachable; the mode
was registered with no source of records at all. It now reads verifications
from the Library, copying Core's verdict verbatim — `null` included, so an
unruled record stays unruled rather than reading as agreement.

**An installation can now say which release it is.** `deepwatch doctor` reports
the composed packages, the Harness alongside the version this build was
measured against, and a digest the release manifest records from the same
inputs. Derived from the source and nothing else: no clock, no CI run id, no
path, no user, and no `.git` needed at either end.

**Shell containment is established rather than assumed.** Watch does not parse
command strings — a boundary built on guessing can be written around — so the
pinned Harness sandbox is the authority, and a gate now proves it across
absolute paths, traversal, redirection, a working directory argument, a
directory changed mid-command, a second interpreter and a junction resolving
outside the workspace. The assertion is no side effect, with a control case
proving the boundary still permits ordinary work.

**Three smaller things.** Pinning live evidence was a promise with no end: a
busy session pinned its whole buffer and retention quietly stopped applying, so
pins now yield to a byte budget, oldest first, while the newest window is
always kept. A binding records the kind of actor that wrote it — never an
identity — because a document written by a person pressing Save and one written
by a script were the same bytes. And the memory store, which is plaintext and
still says so, is created owner-only where the operating system enforces modes.

### Release closure, continued — three defects a real provider found

The evaluation above ran against a loopback stub. Running the same journey
against a real provider, from artifacts built for this candidate, found three
more things. All are fixed here.

**One workspace, not three.** An owner session was asked for
`owner-test/totals.json`, and the agent created it with the right bytes and the
right arithmetic. It could not then be verified. Three layers each answered
"which directory is this relative path in?" from somewhere different: the
agent's filesystem tools resolved against the Harness session workspace, which
the Harness derives from the host process's cwd; Watch Core was spawned with an
empty `cwd` and inherited whatever the Host had; and the verifier, handed no
`workingDir`, fell back to the directory it happened to be started in. The file
was real and the verdict was `INCONCLUSIVE` — honest, and worth nothing.

The fix is not a wider verifier. `deepwatch web|desktop --workspace <dir>` names
the one directory, resolved through its real path so a junction and its target
are one root; the launcher starts the Host *in* it and exports
`DEEPWATCH_WORKSPACE` beside it; and Core now reads that variable and has no
default at all — where nothing was established it stops with
`verify.workspace_unresolved` and a named fix rather than measuring against
wherever it happens to be sitting.

**The shell was outside the boundary it was meant to share.** Refused an
out-of-workspace write twice, the agent reached for `pwsh` instead. That call
was recorded `scope:not_applicable` — the classification for a call that touches
no filesystem — because `pwsh` spells its working directory `workdir` and the
path-argument list knew only `cwd`. Nothing escaped: the pinned Harness sandbox
is the enforcement authority, and the file outside was untouched. But Watch's
own record of what happened was wrong, and that record is the product. The
command string itself stays unscanned, deliberately and now in writing: quoting,
expansion and redirection decide where bytes land at runtime, so parsing it
would produce confident wrong answers in both directions.

**A version is not a fingerprint.** The sealed npm artifacts for this candidate
had been packed three commits behind the accepted source, from a dirty tree, and
every gate passed — because every gate compared `name@version`, and both byte
sets wore the same version. Exactly one package differed: `@deepwatch/dsh-memory`
did not carry the memory-permission hardening. Provenance is now content-bound:
a sealed manifest ties the exact commit and tree to a SHA-256 over every tarball,
the wheel and the sdist, and refuses to seal a dirty tree at all. The gate
rejects a set whose bytes, source, inventory or installed content disagree, and
`doctor` no longer claims an installation "matches the published composition" —
nothing has been published, so nothing has ever matched one.

### `watch-skill notes` — a write-up whose every line is checkable

A readable document for an indexed video: chapters, what was said, what was on
screen, and the frames to prove it. Assembled from the index rather than
generated, so every quote traces to a transcript segment, every frame to a kept
frame, and each carries the timestamp it came from. Deterministic — no model in
the path, so the same index always yields the same bytes.

```bash
watch-skill notes <video_id> --write notes.md
```

### Video-backend benchmark

`watch-skill bench video-backend adversal` measures whether an external
provider's output can be ingested into Watch Skill's evidence model without
inventing anything. Generated fixtures carry ground truth exact to the
millisecond; real footage derives its truth from the file itself by decoding
the window around each probe.

The scorer, ground truth and report are transport-independent, so a future
direct-API adapter reuses all of it. Results and method:
[`benchmarks/video_backends/`](benchmarks/video_backends/).

### Release engineering

The documented path to a first npm publication could not be walked. `npm run
release:artifacts` wrote digests, a date and an output directory into the
tracked inventory, and `npm run first-publish:dry-run` — the next command the
release guide gives — refuses a dirty tree. Packing now writes per-run facts
beside the tarballs and leaves the tracked inventory to what a pack of the
source is expected to produce, and `verify:release-sequence` runs the guide's
commands in order and checks the worktree between them.

Packing is reproducible. `@deepwatch/dsh-bundle` declares thirteen siblings
through pnpm's `workspace:` protocol, and pnpm wrote the ranges it resolved
back in a different key order on each run, so one archive's digest moved for a
reason unrelated to its contents. The pack stages a canonical manifest for the
length of one `pnpm pack`; two packs of one commit now produce twenty identical
archives.

A release-surface gate reads the documents, package descriptions, CLI help, the
documents inside all twenty tarballs, and the built wheel and sdist, refusing
unresolved template tokens, stale scopes and package counts, personal paths and
unfinished product claims. Both halves read one rule table, and every exemption
is one file, one rule and a reason.

### Changed

- `adapters/agents-md/AGENTS.md` is now
  `templates/agent-integration/AGENTS.example.md`. It is a template for a
  user's own project, it was named exactly like the file coding agents treat as
  policy for the repository they are in, and it shipped in the source
  distribution. The repository's own `AGENTS.md` is not published.
- The doc skeleton's holes are double-brace tokens in a syntax nothing else
  in the tree uses, rather than words that read like prose, and
  `scripts/validate_agent_docs.py` refuses any page outside the template that
  still carries one.
- Two agent pages pointed at `adapters/claude-skill/skills`, which no longer
  exists; both now name `skills/`.
- ADR-003 and `architecture.md` described a second repository that does not
  exist. Both halves live in `oxbshw/watch-skill`, on separate release trains,
  and what the ADR decides is the boundary between them.
- Records of past runs moved to `workspace/docs/history/`, with the commit each
  measured in its filename.
- Role Bindings and the Chat gate say why their controls are disabled when the
  Harness will not accept a settings write. Four controls were greyed out with
  the reason nowhere on either surface.

### Fixed

- `normalize_words` (and `benchmarks/asr_accuracy.py`) raised `KeyError` on
  Unicode digit-likes such as `①`, which `str.isdigit()` accepts but the
  ASCII spelling table does not hold. Found on OCR text lifted from a real
  slide.

- A Watch Core too old to have the `bridge` command could be reported as a
  failed handshake, with advice to retry it. The Bridge resolves its connection
  as soon as the engine is spawned, so the handshake write can reach a pipe
  whose engine has already quit — and that write knows only that the pipe
  broke, while the engine's exit carries the usage error saying what is
  actually wrong. Whichever arrived first was published, so one build diagnosed
  this correctly on Linux and Windows and misleadingly on macOS. A broken pipe
  now waits for the exit that explains it, and the reader gets the fix that
  works: upgrade Watch Core.

- The manual profile composed a twenty-second startup budget, below the
  forty-five seconds the product ships and below the floor a first cold start on
  a clean Windows machine has already exceeded. A profile built that way could
  still report a healthy engine as a dead one. The overlay now names only the
  binary, the transport and the argv, and inherits the shipped budget.

## v1.3.0rc2 — 2026-08-22 (pre-release)

A release candidate, published so the 1.3.0 line gets real use before it
becomes what `pip install watch-skill` gives you. `uvx` and `pip` still resolve
to 1.2.0 unless you ask for a pre-release:

```bash
uvx --from "watch-skill[standard]==1.3.0rc2" watch-skill setup
pip install --pre "watch-skill[standard]"
```

This entry covers the whole 1.3.0 line.

Adds operator mode: Watch Skill can drive a browser itself, and holds its own
actions to the same standard it holds anyone else's. Additive — no CLI command,
MCP tool or schema changed, and `watch_skill.operate` is a new package rather
than a modification of an existing one.

### Fixed

- **`sqlite_query` verification could not open its database on Linux or
  macOS.** The read-only connection URI was built by trimming a fixed prefix
  from the file URL, which left a Windows path intact but removed the leading
  slash on POSIX, so an absolute path became a relative one and every check of
  that type reported an error. The check type is documented as available on
  every platform and now is.
- **The workspace served capture capabilities by probing hardware on every
  request.** Each snapshot enumerated ffmpeg input devices once per capture
  kind and launched a browser driver to resolve the chromium path — about
  twenty seconds on a cold 8 GiB host, for an answer that cannot change
  without installing software. The probes are cached per process and resolved
  before the host serves, so opening the workspace no longer waits on them.
- **A dev host could accept a connection before it could answer one.** The
  listening socket exists from the moment the server is constructed, so a
  client connecting before the serving loop was scheduled saw an open socket
  and no reply. `start()` now returns only once the host has answered a
  request, and reports the bound address if it never does.

### Browser Runtime

One browser subsystem, two modes. *Observer* watches someone else work and
verifies the result; *operator* does the work and proves its own. They share
the page, the navigation policy, the resource lease, the per-session profile
and the evidence log — there is deliberately no second browser stack.

The rule everything is built around: **dispatching an action is not the same as
proving its effect.** Playwright returning from `click()` proves a click was
delivered and nothing more. So every action carries an expectation written down
beforehand, execution measures the effect, and the verdict is the comparison.
An action with no expectation is `UNVERIFIED`, never `SUCCEEDED`.

- **Action receipts.** Every step records how the target was found and with
  what confidence, what changed, which requests ran, the verdict, and any
  recovery. A receipt for a failure is more useful than one for a success.
- **Network-aware verification.** `network_ok` correlates the requests made
  during a step, which is what catches a page rendering "Saved" over a `PATCH`
  that returned 500.
- **Deterministic-first target resolution** — accessible role and name, then
  label, test id, placeholder, selector, text. Vision is last because it is the
  most expensive signal and the least stable across a redeploy. Ambiguity is
  refused rather than resolved to the first match, and a destructive action
  resolved below 0.75 confidence is refused outright.
- **Recovery by failure class**, bounded at three attempts: a stale node
  settles and re-resolves, an intercepting modal is dismissed, a missing
  control is waited for. Whether a retry is permitted at all is decided by the
  action's side-effect class first — clicking "Next" again is fine, clicking
  "Buy" again is not.
- **Popup handling is now a policy.** Observer mode still records and closes
  them; operator mode adopts them, because a `target="_blank"` link is often
  the task itself and an adopted popup joins the page graph, so it is watched.

### Benchmark

`python -m watch_skill.operate.benchmark` runs nine tasks against a bundled
local fixture site built to fail the way real sites fail. Each task carries a
ground-truth predicate read from the site's server state rather than from
anything the browser reported.

Across those nine tasks every ground-truth verdict was classified correctly and
no false-success verdict was produced. First-attempt success 0.667, recovery
success 0.5, median latency 11.2 s on an 8 GiB CPU-only host. Nine tasks on one
synthetic site is a regression gate, not a claim about real websites.

### One behaviour change worth reading

**Local speech recognition no longer downloads a missing model.** A cached
model used to still reach the network to resolve its revision, which meant a
live session could stall on a download nobody asked for. It now loads
cache-only and, when the model is absent, fails with the exact command to fetch
it deliberately. If you relied on the implicit download, fetch the model once
before watching:

```
python -c "from faster_whisper import WhisperModel; WhisperModel('tiny')"
```

### Reliability fixes

- **`database is locked` under concurrency.** `PRAGMA journal_mode = WAL` is the
  one statement SQLite does not apply `busy_timeout` to: with a 30-second
  timeout set it failed in 0.000s, while an ordinary `BEGIN IMMEDIATE` on the
  same connection waited 33s. All eight database modules ran it on every
  connect, so on a fresh database concurrent connections raced for an exclusive
  lock no timeout covered. It is now attempted only when the mode actually
  needs changing, and losing the race is treated as another connection doing
  the work.
- **Live session runners were never unregistered.** They were added to the
  registry when they started and removed by nothing, so the process retained
  every finished session's source, pipeline and frame buffers, and
  `running_session()` could return a runner for a session that had ended.
- **`Pipeline.stop(timeout=T)` cost up to 3T.** The timeout was applied to each
  stage thread in turn rather than as one deadline.


### A real model inside a live session, and late is not the same as wrong

The external vision worker proved a model could read a picture. It can now say
something about a *running* session. On an 8 GiB CPU-only host an
interpretation takes tens of seconds — 47.1 s p50 idle, up to 81.8 s under
load — and taking that number seriously is most of the change.

- **A late result is never discarded.** It is persisted, queryable, and citable
  against the frame it describes. What lateness costs it is the present tense:
  `current_state` may drive an action, `stale_for_action` is queryable and
  inert, `historical_evidence` is what everything becomes once the source ends.
  Almost nothing clears the ten-second window on this backend, and the
  interface says so rather than smoothing it over.
- **Backpressure is a short ranked queue, never an unbounded one.** Two frames
  deep; a waiting question outranks a scene change; the frame that loses the
  slot is recorded with its reason. Both ends are ranked — dequeuing FIFO
  pointed the model permanently at the past and made it miss the failure state
  entirely.
- Every observation carries the frame's SHA-256, sequence, capture and
  inference timestamps, latency, and the **pinned** model revision. An
  observation that cannot name the revision that produced it is not
  reproducible evidence, so the live gate refuses to run unpinned.
- The model is asked a question it can answer — one sentence of prose — and the
  schema around it is derived by code that cannot hallucinate. Measured: given
  a format example, this model copies the example's *contents*, so the prompt
  carries no sample content at all.
- Credential stripping is now checked from inside the worker rather than
  asserted from outside it.

### The workspace is a Next.js app

Next.js 15, React 19, App Router, strict TypeScript, static export. Vite and
its plugins are gone. One compilation produces both the directory export and
the single self-contained document the MCP Apps resource carries, so the two
cannot disagree. **No Node.js is required of a user.**

- The preview is frame-driven with a cursor, latest-frame-wins, monotonic, and
  labelled by what it actually is: `LIVE VIDEO`, `LIVE FRAMES`, `SNAPSHOT`,
  `REPLAY`. `LIVE VIDEO` is deliberately unclaimed here.
- Frame access is a session-scoped capability, not an origin check. The UI is
  given a session id and a token, never a path.
- Three serious colour-contrast defects found by an offline axe-core audit and
  fixed in the stylesheet.

### Fixed

- Local speech recognition was not local: a cached Whisper model still reached
  the network to resolve its revision. It now loads cache-only and says exactly
  how to fetch a missing model deliberately.
- The sdist was 81.3 MB because there was no sdist configuration and hatchling
  followed the `node_modules` junction. It is 6.0 MB.
- A vision detector that had failed to load reported itself `ready`.

### The session can hear

`AudioChunk` was a contract nothing produced. Live audio is now a real path:
its own ffmpeg process, normalized to mono 16 kHz PCM at the boundary,
assembled into overlapping utterances, transcribed, and published as citable
speech events.

- **Audio queues block where video queues drop.** A frame from four seconds
  ago has been superseded; a lost half-second of speech is a word nobody will
  say again. Anything genuinely missed becomes a `capture_gap` event, because
  a transcript with an unmarked hole invites the reader to conclude nobody
  spoke — a different claim from "we were not listening".
- **Utterances overlap by half a second.** Adjacent blocks transcribed
  independently reliably lose the word on the seam.
- Silence is gated by mean amplitude, not a VAD model: the check runs on every
  utterance, and the expensive thing it avoids is exactly the model we would
  have to load to make the decision.
- Two backends, kept distinct rather than blurred. `faster-whisper` does real
  recognition. `deterministic-fixture` tests the *transport* on machines
  without the model — it names itself in every event it produces, and its
  tests say plainly that they prove nothing about accuracy. Recognition has
  its own test, gated on the model being installed.
- `detectors.asr` always says which silence this is: no audio track, disabled
  for the session, no model installed, or a failure mid-run.

### Models load once, and a slow one no longer blinds the session

Adding ASR to a process that already loads OCR and embeddings is how the
previous end-to-end run hit `bad allocation`.

- **Loading is single-flight.** A plain dict checked before a slow constructor
  is a race, not a cache — every thread misses, every thread builds.
  `_get_engine` had exactly that shape.
- A failed model degrades only its own detector, retries on a cooldown rather
  than at the frame rate, and is announced once instead of per frame.
- Idle models are released, which is what the earlier run needed: a parent
  holding weights it had finished with while a child was refused memory.

### One clock, so audio and video can be compared

Audio and video come from independent ffmpeg processes, each counting its own
bytes. Their media clocks drift and neither knows the other exists.

- Drift is **measured**, not assumed. A stream that produced nothing gives
  `null`, because an absent stream is not a synchronisation and reporting zero
  would claim a measurement nobody made.
- A timeline that jumps backwards has **reset**, not drifted — a reconnect is
  a separate discontinuity, and unlike a forward gap it is not lost time.
- Timestamps are never rewritten. A media timestamp is what the source said;
  correcting it silently would make a citation point at something the viewer
  will not find there.
- `aligned_evidence` answers "what was on screen when they said that" by
  deterministic timestamp overlap, so the ranking can be reproduced by hand.

### Correlated events, with guesses labelled as guesses

Three parallel event logs are not understanding. Fusion joins them —
deterministically, by timestamp overlap and shared entities. No model runs.

The rule the layer exists to enforce: **an observation is what was seen, an
inference is what it might mean, and they never share a sentence.** A fused
event states its observation using only what a stream recorded, and carries
hypotheses in a separate list, each scored and attributed to the rule that
drew it. "The coupon calculation failed" is never quotable as though a camera
had recorded it.

Writing the tests found a real gap: `[object Object]` was folded into a
word-boundary alternation, and `` cannot anchor a bracket — so the most
common way a broken value reaches a screen never matched.

Entity tracks decay with staleness, because something last seen thirty seconds
ago is not evidence about now. Disappearances are marked absent rather than
deleted, so "did the total vanish?" stays answerable.

New surfaces: `watch-skill live aligned|timeline`, `aligned_evidence` and
`fused_timeline` MCP tools, `GET /v1/live/{id}/aligned` and `/fused`. 36 MCP
tools.

### Watching something while it is still happening

Watch Skill could watch a video. It could not watch an ongoing one and say
what changed as it changed — everything was read to the end and reported
afterwards.

A live session now emits events **before the source has finished producing
media**. That is the whole feature, so it is what the end-to-end test asserts:
the change must be reported while the capture process is still running. A
pipeline that ingests everything and then reports would pass every other check
while being batch processing with a different name.

- `start_live_watch`, `observe_live`, `ask_live`, `get_live_status`,
  `stop_live_watch` over MCP, with `watch-skill live start|observe|ask|status|stop`
  and `/v1/live/*` twins. `--follow` prints events as they arrive.
- Capture, fast vision, OCR, and persistence are **separate bounded stages**.
  They were one stage first, and the first OCR call — which loads models and
  takes tens of seconds — meant no scene change was reported until it had
  warmed up. The live view was blind for exactly as long as its slowest
  detector took to start.
- Analysis stages take the newest frame and **count what they discarded**;
  persistence drops nothing, because a frame that is not written cannot become
  evidence later. Every queue has a fixed bound and reports its depth.
- No model runs per frame. Scene changes are perceptual hashing; text changes
  are local OCR compared as token sets, so OCR jitter on a static screen does
  not fire an event every frame.
- A rolling buffer retains a recent window and **pins** the media three seconds
  either side of every detection — the cause of an event is usually visible
  before the event. Expired segments leave a row marked `expired`, so evidence
  that aged out says so instead of returning silence.
- Events carry a media clock and a wall clock, kept apart, plus whether each is
  an `observation` or an `inference`. Evidence is addressed by `artifact_id`;
  a test asserts public event payloads contain no filesystem paths, which is
  how the original session-started summary was caught leaking one.
- `observe_live` is cursor-addressed by sequence number, so repeating a cursor
  is idempotent and a retried call neither loses nor double-counts. A cursor
  from another session is refused rather than silently reset.
- Stopping finalises the session into an **ordinary indexed video** —
  `ask_video` and `search_videos` work on it with no reprocessing, because the
  frames and OCR already exist. Idempotent, and refused while still running.

Implemented live sources are `file_replay` (a local file paced at real time by
`ffmpeg -re` — a real live source, and what makes the proof runnable without
hardware) and `stream`. Live audio, triggers, semantic live perception, and
live browser/screen capture are **not implemented**; `docs/live.md` lists them
plainly rather than as roadmap entries dressed as features.

### Capture capabilities you can trust

`watch-skill capture-capabilities` (plus MCP and REST twins) reports what this
machine can actually record. Nothing is `available` because a code path
exists: each entry says whether it was `machine_tested`, `probed`, or
`not_tested`, and an `available` entry is never `not_tested`.

macOS screen capture is `degraded` — the AVFoundation device is there,
ScreenCaptureKit is not implemented, and the permission cannot be probed
without attempting a capture. Linux Wayland is `unavailable`: the PipeWire
portal path does not exist here, and a portal being installed would not change
that. Camera and microphone are `degraded` everywhere, because a device layer
being present is not a device being present. WebRTC has no implementation and
says so.

### A queue that survives the process that started it

A `job_id` used to die with the server: state lived in a dict, work ran in a
daemon thread, and a long transcription could not really be cancelled.

Jobs now live in their own SQLite database — deliberately not the video index,
because a heartbeat every few seconds per running job would contend with the
read path that answers questions, and losing the queue should never risk the
video memory.

- Work is claimed under a **lease**, so a worker that dies leaves a row whose
  lease stops being renewed and the next worker takes it. Proved out of
  process: a real worker is SIGKILLed mid-job, a second recovers it, and the
  artifact is written exactly once.
- Every transition is a guarded UPDATE with the expected state in the WHERE
  clause, so two racing workers produce one winner and one no-op. A database
  trigger refuses to move a terminal job back to running.
- Idempotency is a unique index rather than a read-then-write, because the two
  submissions that matter arrive at the same moment.
- `ctx.checkpoint()` reports progress and raises on a pending cancel, so a
  handler that calls it between bounded chunks is cancellable without knowing
  anything about the queue. A 20-second job stops in under one and leaves no
  output behind.
- `cancel_job` (MCP), `watch-skill jobs list|status|cancel|worker|recover`,
  and `GET/POST /v1/jobs`. `watch_video(background=true)` is now durable.
  `start_job`/`get_job` remain for callable-based callers and say plainly that
  they are in-process only.

### Semantic search degrades; retrieval does not disappear

An embedding model that was installed but could not **load** — out of memory,
a truncated cache, an unusable runtime — took every query down with it, even
though keyword search would have worked perfectly. Vector scoring is a ranking
improvement, not a precondition for finding anything, so it now falls back to
keyword-only and says so once on stderr rather than on every query.

### A video's identity is its bytes, not its path

Overwriting `demo.mp4` used to return yesterday's frames, OCR, and cached
answers, with nothing in the reply admitting it. The id was
`sha256(source_string)`, so the same path always meant the same video.

- Identity now separates four things: the **alias** you typed, the **asset**
  it has pointed at over time, an immutable **revision** keyed by content
  digest, and the cheap **fingerprint** that decides whether the digest needs
  recomputing at all. A multi-gigabyte file whose size, mtime, and inode are
  unchanged is not re-hashed; downloads are hashed once and the digest travels
  with the cache entry.
- `ask`, `get_moment`, and the answer engine refuse to answer from a source
  that has demonstrably changed (`index.stale`), and every answer now carries
  the freshness it established: `fresh`, `stale`, `refresh_required`, or
  `freshness_unknown`. The last one is a real answer — a remote source nobody
  went to the network for is *unknown*, not fresh.
- Superseded revisions are kept, not overwritten. `watch-skill freshness
  <video>` shows the chain; asking by `video_id` still reads the exact
  revision that id names.
- Identical bytes reached through two different paths are one video.
- **Every id ever printed still resolves.** A v1 row is *adopted* on re-watch —
  it keeps its id and gains a real digest — and content-derived ids map onto it
  through an alias table. Migration `v9` backfills existing rows with a
  revision marked `digest_source: legacy`, never a digest it did not compute.

### One policy, asked at every boundary

`offline_only` was a cost setting consulted by one function in the answer
ladder. A configured API key therefore meant indexing-time scene descriptions
uploaded frames whether or not you had agreed to that.

- `watch_skill.policy` gates source acquisition, frame egress, audio egress,
  transcript/OCR egress, cloud models, local models, webhooks, telemetry, and
  verification HTTP. Every boundary asks it; going around it is a security bug.
- `WATCHSKILL_OFFLINE=1` guarantees **zero** outbound calls, acquisition
  included. A remote URL returns `acquire.offline_denied` unless it is already
  cached. Proven by a test that runs the engine with every supported provider
  key populated and asserts nothing leaves.
- `offline_only` is now literal and end-to-end: no frame, audio payload, or
  transcript reaches a cloud provider at any stage.
- `WATCHSKILL_SCENE_DESCRIPTIONS` is explicit — `off`, `local`, `cloud`, or
  `auto`. `auto` resolves to local and never upgrades itself to cloud.
- `WATCHSKILL_PROVIDER_ALLOWLIST` refuses a provider before its key is read.
- The cost ledger covers indexing descriptions, answers, loop critics, library
  synthesis, extraction, and verification — not just follow-up questions — and
  keeps estimates apart from provider-reported usage.
  `WATCHSKILL_COST_CEILING_RUN_USD` bounds the whole run.
- `watch-skill plan` (MCP `execution_plan`, `GET /v1/plan`) prints the
  provider, the payload counts, the exact network actions, and the ceiling
  **before** a run sends anything.

### The critic fails closed

A recording with zero frames scored 92/100 and passed. So did an unreachable
model, an empty description, and a judge that could not be called.

- Verdicts are `pass`, `fail`, `inconclusive`, or `error`, and every critique
  carries an assurance level. `inconclusive` scores 0 — a 92 next to "could
  not tell" is exactly how the old behaviour looked from outside.
- No frames, no usable evidence, a failed describe pass, an unavailable model,
  or an unreachable fallback judge are all `inconclusive`. None of them can
  stop a loop successfully.
- A model cannot promote its own verdict: a JSON critique claiming
  `remote_attested` is pinned back to `visual_advisory`.
- The monitor reports an inconclusive critique as inconclusive rather than
  paging someone about a detection that never happened.

### Verification contracts decide; the critic advises

- A `VerificationContract` is written, **frozen**, and digested before the run
  it judges. Editing it afterwards raises `verify.contract_tampered`; a model
  may add checks — they land advisory whatever the proposal said — but cannot
  remove, relax, or mark required an existing one.
- Nine deterministic check types: `file_exists`, `file_digest`, `json_value`
  (RFC 6901 pointers), `json_schema`, `sqlite_query`, `http_request`,
  `command_exit`, `numeric_invariant`, `visual_absent`.
- `pass` requires every **required** check to pass. A check that fails, times
  out, or never runs makes the run `inconclusive`. A contract with no required
  check is `inconclusive` by construction — visual evidence is not verification.
- Checks run in an isolated child process with an allowlisted environment
  (provider keys do not reach it), bounded roots, and strict timeouts. That is
  `isolated_local`. `remote_attested` is defined but **not implemented**, and a
  contract requiring it fails loudly instead of quietly settling for less.
- Each run writes a hash-bound evidence bundle and attestation. Editing
  `evidence.json` makes it stop verifying. Unsigned by default and labelled
  `unsigned_hash_bound`; Ed25519 signing needs `watch-skill[attest]`. Nothing
  calls a hash a signature.
- Commands are argv lists, never strings, so nothing built from OCR, a
  transcript, or model output can be shell-parsed. SQL is SELECT-only,
  parameterised, and read-only at the driver. HTTP checks screen resolved
  addresses, not just hostnames.

### Four new tools, and honest wording

- MCP: `check_source`, `execution_plan`, `verify_contract`, `get_evidence`
  (27 total). CLI: `watch-skill freshness`, `plan`, `verify run|show|list|checks`.
  REST: `GET /v1/videos/{video}/freshness`, `GET /v1/plan`, `POST /v1/verify`,
  `GET /v1/verify/{run_id}`.
- "Proof" is now reserved for a result whose required deterministic checks
  passed and whose attestation verifies. Everything else says "evidence",
  "before/after comparison", or "advisory visual verdict".
- New: [docs/verification.md](docs/verification.md).

### The library tells you what it costs
- `watch-skill stats --disk` reports where the index's space went: the
  database, the stored frames, and every video ranked by what it is
  responsible for — frames and vectors counted separately, since which half
  is heavy decides what to do about it.
- The index is meant to grow; it just grew silently. `clean` offered caches,
  old loops, and orphans and never mentioned the library itself, so
  reclaiming space meant guessing a `forget` and checking. The report ends
  with the command that acts on it.
- `--top` shortens the listing without changing the totals, and `--json`
  makes it machine-readable.

### THE LOOP, as a page you can read
- `watch-skill loop viewer <loop_id>` renders one run as a self-contained
  page: every iteration in a strip, and for each one its verdict, its
  frames, and the critic's issues with severity and suggested fix.
- The comparison is the point. Between two iterations it shows what was
  **fixed**, what was **introduced**, and what is **still there** — so a fix
  that quietly broke something else cannot pass as a clean win. The
  before/after GIF proves a verdict flipped; this says why it flipped.
- Clicking an issue brings up the frame nearest the moment the critic named,
  which is the reason the recording was kept at all.
- Same conventions as the video viewer: one file, frames inlined, no network,
  readable with scripting off.

### The 0% scripts fix themselves now
- Lao, Khmer, Myanmar, and Tibetan read as **empty** with RapidOCR — that is
  the 0% row in the perception benchmark, and tesseract is the documented
  fallback. Until now the pipeline stopped there and told you to download a
  `.traineddata` by hand, the only dependency in the project handled that
  way while ffmpeg, yt-dlp, and deno all self-install.
- Language files are data, so they are fetched on demand on every platform,
  into the managed bin dir, and passed with `--tessdata-dir`. This is the
  half that is usually missing: `apt install tesseract-ocr` ships English and
  leaves those scripts in separate packages, so a machine with tesseract
  installed still read them at 0%.
- The binary itself installs via winget on Windows. Elsewhere it needs a
  package manager, so `doctor` gained an `ocr-gap-scripts` check that names
  the affected scripts and the exact command — a warning, not a failure,
  because these are a minority of videos and nothing else depends on it.

### The answer, rendered
- MCP tool results can now carry the viewer page as an inline `ui://`
  resource. A client that renders them — Goose, LibreChat, the mcp-ui
  inspectors — shows a scrubbable timeline with frames, transcript, and
  every cited piece of evidence, instead of a wall of text. Clients that do
  not simply ignore the block. `WATCHSKILL_MCP_INLINE_UI=true`.
- Off by default: it is a sizeable payload and most clients cannot use it
  yet. Text is always the first block and the UI always the last, so a
  client reading only the first still has the answer.
- Nothing in that path can cost you the answer. A missing video, a broken
  renderer, or a page over 4 MB all mean "no UI this time" rather than an
  error — losing a real result to a rendering nicety would be the wrong
  trade.
- `viewer.py` grew `render_viewer_html`, and `generate_viewer` now writes
  what it returns. One renderer, so the page a user shares and the page an
  agent shows cannot drift apart.
- The mcp-ui convention is three fields, written out here rather than
  imported: its Python package is a thin set of dataclasses last released in
  2025, and the read path of a tool response is not where to add a stale
  dependency. Skybridge was considered for the same job and set aside — it
  is a React/TypeScript full-stack framework, and adopting it would mean a
  second server or a rewritten MCP surface, against the rule that all logic
  stays in the Python engine.

### Word-level timestamps
- `watch-skill watch --word-timestamps` aligns each word through the
  local-whisper rung, and `get_moment` now names the word being spoken at
  the instant you asked about. A segment can run ten seconds, so a citation
  built from segment bounds was only ever accurate to the segment.
- Words ride on `Segment.words`, survive `offset()` (a window-transcribed
  segment and its words must not end up on different timelines), and are
  stored as JSON on the segment row — schema v8. They are always read with
  their segment and never queried across videos, so a row per word would
  multiply the index for a lookup nobody performs.
- Captions and cloud STT carry no alignment. The field is absent there
  rather than filled with segment bounds pretending to be words.

### Two roadmap entries settled with measurements, not opinions
- **sqlite-vec stays out.** The roadmap claimed the numpy batch cosine does
  10k vectors in ~120 ms; measured, it is **18.9 ms** — pessimistic by 6x —
  scaling linearly to 218 ms at 100k. sqlite-vec is also still 0.1.9 with no
  stated development status, and the roadmap's own condition was "adopt once
  it stabilizes". The real scaling problem in that table is ~2 KB per vector
  (a 100k library is a 200 MB file), so narrower storage comes first. Full
  table in [DECISIONS](docs/DECISIONS.md).
- **The MCP 2026-07-28 revision is a release candidate**, and adopting one
  ahead of `fastmcp` would mean forking the transport. Its three
  deprecations — Roots, Sampling, Logging — turn out not to touch this
  server at all: paths arrive as tool parameters, vision goes straight to a
  provider rather than borrowing the client's model, and progress goes to
  stderr. The migration when it lands is transport-level, and the two places
  that assume the handshake are noted.

### A benchmark that picks a provider for you
- `watch-skill bench providers` reads the same committed fixtures with every
  provider you hold a key for, and prints char-hit rate, latency, and cost.
  Sixteen providers is a menu; this is how you choose one.
- Cost is the provider's **own reported** token count times the dated price
  in `prices.json`. A provider that reports no usage gets a dash. A call that
  fails is reported as failed, never as 0% accuracy — those mean different
  things. A run with no configured provider prints no table at all rather
  than an empty one.
- `VisionClient.last_usage` carries the reported token usage from the most
  recent call, so cost comes from the provider rather than an estimate.
  `generate` still returns text, so nothing calling it changes.

### Three more agents
- [Amp](docs/agents/amp.md) — `amp mcp add`, or the `amp.mcpServers`
  settings key, which is namespaced differently from every other client
  here, so a copied block needs that one change.
- [JetBrains IDEs](docs/agents/jetbrains.md) — Junie's
  `.junie/mcp/mcp.json` and AI Assistant, which keep separate configuration.
- [Aider](docs/agents/aider.md), honestly: it has **no MCP client** — the
  RFC is open and the pull requests were closed unmerged — so the page
  documents the `/run` route through the CLI instead of pasting an
  `mcpServers` block that Aider would ignore.

### Requirements

Python 3.11+. A single browser session needs roughly 1.2 GB of free memory, and
the live browser plus Observer verification paths need roughly 2 GB because
they hold two browsers at once. The resource governor refuses a browser it
cannot afford and reports how much was short.


Backward compatible. No public contract changed: `WORKSPACE_SCHEMA_VERSION` and
`LIVE_SCHEMA_VERSION` are both still `1`, the MCP Apps resource still declares
`text/html;profile=mcp-app` at `ui://watch-skill/workspace` against SDK 1.7.5,
and every CLI command and MCP tool that existed in v1.2.0 still exists. The CLI
gained `capture-capabilities` and two other commands; the MCP surface gained
`watch_workspace` and `workspace_snapshot`. Nothing was removed or renamed.


## v1.2.0 — 2026-08-08

### Skills reach every agent, not just Claude Code
- The ten skills moved from `adapters/claude-skill/skills/` to a top-level
  `skills/` directory, which is where the open skills ecosystem looks. They
  now install into any of its 27+ supported agents:
  `npx skills add oxbshw/watch-skill -g`. Buried where they were, only
  Claude Code could see them — the agent-facing layer that decides *when* to
  watch video was the least distributed part of the project.
- The Claude Code plugin is rooted at the repository instead of a
  subdirectory, so one copy of each skill serves both ecosystems rather than
  a mirror that can drift. `skills.sh.json` declares the package.

### Sixteen vision providers, from six
- Added Groq, Together AI, Fireworks, DeepSeek, xAI, Mistral, Moonshot,
  Z.ai, and Qwen (DashScope) — plus `custom` for any OpenAI-compatible
  server: vLLM, LM Studio, llama.cpp, LiteLLM, Azure OpenAI, a company
  gateway. Two contributors asked for the last one before it existed.
- These are registry entries, not code. Every one of them speaks OpenAI's
  `/chat/completions`, so a single builder is generated from the table and
  adding a vendor touches no request logic.
- `--base-url` on `setup-vision`, and a `WATCHSKILL_<PROVIDER>_BASE_URL` for
  each, so one entry reaches a regional endpoint, a proxy, or a self-hosted
  server. Passing it to a provider with its own wire format is a clear error
  rather than a silently ignored flag.
- **`WATCHSKILL_GROQ_API_KEY` existed with no Groq provider behind it.** The
  setting was read, reported by `doctor`, and impossible to use.

### Three more agents
- [Zed](docs/agents/zed.md), whose key is `context_servers` rather than
  `mcpServers` — a config copied from any other client here does not work.
- [Roo Code](docs/agents/roo-code.md), with the project-scoped `.roo/mcp.json`
  a team can commit.
- [Continue](docs/agents/continue.md), which reads one file per server from
  `.continue/mcpServers/`.

### Supply chain and platform
- **PyPI uploads carry PEP 740 attestations.** Publishing moved from
  `uv publish` to the official PyPI action, which signs the distributions
  with this workflow's identity — an installer can verify a wheel was built
  here and not swapped in transit.
- **The container image is multi-arch.** `linux/arm64` alongside `amd64`, so
  Apple Silicon and ARM servers stop running ffmpeg under emulation. The
  pushed digest also gets a signed build-provenance attestation, and the
  build emits an SBOM.
- **Dependabot** watches Actions, Python dependencies, and the base image
  weekly. A compromised action is the shortest path into a pipeline that can
  publish to PyPI.
- **`AGENTS.md` at the repository root** — the cross-agent convention that
  Codex, Cursor, Copilot, and others read. For a project whose users are
  agents, not having one was an odd gap.

### Changed
- **An agent page no longer requires hand-drawn art to exist.** The test
  demanded an avatar for every page, so adding an agent was blocked on
  someone illustrating it — which contradicted the twenty-minute
  contribution path in CONTRIBUTING. A page without art belongs in the
  matrix; it joins the README gallery when the art lands. Art that *does*
  exist must still be shown, and no page may be orphaned from the matrix.

## v1.1.0 — 2026-08-08

Distribution work. v1.0 was installable only by cloning the repository,
which is the main reason people who found the project did not end up
running it. This is the first release on PyPI.

### Install
- **Published to PyPI.** `pip install watch-skill`, `pipx`, and
  `uvx --from "watch-skill[standard]" watch-skill serve` all work, so an
  agent can be pointed at the package with no checkout and no path. The
  release workflow uploads via trusted publishing (OIDC, no stored token)
  in a separate job, so a failed upload cannot take the GitHub Release
  with it.
- **New `standard` tier** — frames, retrieval, and MCP at roughly 200 MB
  against ~600 MB for `all`. OCR, local Whisper, REST, and the LOOP
  browser are opt-in. `doctor` gained a `features` check that names every
  missing tier and prints the command that installs it, so a small start
  fails loudly rather than mysteriously.
- **The installers are tested now.** `scripts/install.sh` and
  `install.ps1` carried a note saying they had only ever run on Windows.
  A new `install` workflow executes them on ubuntu, macOS, and Windows
  runners on every change and weekly, asserting the CLI runs, `doctor`
  passes, and the MCP server answers `initialize`. The note is gone
  because the claim is now checked.
- **Docker image** at `ghcr.io/oxbshw/watch-skill`, with the index on a
  volume. CI refuses to push an image that cannot answer `--version`.
- **Every agent guide** now shows the `uvx` config instead of a
  machine-specific `uv --directory /path/to/checkout` line, with the
  source route kept for contributors.

### Fixed
- **`doctor` failed outright on Linux and macOS.** The portable ffmpeg
  bootstrap was implemented for Windows only, so on the two platforms most
  contributors use, a machine without a system ffmpeg got
  `health.unsupported_platform` and the installer stopped there — while the
  skill documentation claimed the bootstrap covered "Windows/macOS/Linux".
  Static builds are now fetched per platform: BtbN tarballs on Linux
  (x86_64 and arm64), evermeet.cx on macOS. Nothing found this earlier
  because nothing ran the installer anywhere but Windows; the new install
  matrix caught it on its first real run.
- **v1.0.0 reported its version as `0.6.0`.** The release bumped every
  manifest and missed `src/watch_skill/__init__.py`, so the first thing a
  bug report quotes named the wrong release. `__version__` now derives
  from installed package metadata, and a test ties it to `pyproject.toml`.
- **Docs claimed 13 MCP tools; there are 23.** The number was stale in
  three pages at once because nothing checked it. A test now compares
  every documented count against the live tool registry.
- **Indexing a video twice deleted its own frames.** `_persist_frames`
  wiped the destination before copying into it, and it also repoints each
  frame at that destination — so the second call deleted the files it was
  about to read, and two processes indexing the same video raced on one
  directory. Both ended in a bare `FileNotFoundError` with an index row
  pointing at frames that no longer existed. Frames are now staged in a
  private directory and swapped in, so a failed pass leaves the previous
  ones untouched.
- **Redirected output was mojibake outside UTF-8 locales.** stdout was
  left on the system codepage, so on a cp1256/cp1252/cp932 machine
  `watch-skill watch ... > report.md` wrote U+FFFD in place of em dashes
  and any non-Latin script, and every agent reading stdout got the same.
  Output is pinned to UTF-8.
- **`--max-frames 0` silently analyzed one frame** instead of rejecting a
  budget that cannot be met; negatives did the same. Both now fail before
  the source is fetched.
- **Pointing `watch` at a folder said "file not found"** about a path that
  plainly exists. It now says so and names `watch-skill batch`.
- **"ollama is down — restarting it detached" printed when no ollama was
  installed**, once per call, and the suggested fix was to run a binary
  the reader did not have.

### Added
- `--version` / `-V` on the CLI, alongside the existing `version` command.
- `--detail transcript|efficient|balanced|token-burner`, matching
  claude-video's vocabulary so a migrating user's commands run unchanged.
  An explicit `--max-frames` still wins.
- [Comparison](docs/comparison.md) and
  [migration guide](docs/migrate-from-claude-video.md), including what
  Watch Skill is worse at.
- `llms.txt`, `CODEOWNERS`, a review-turnaround note in CONTRIBUTING, and
  a populated `FUNDING.yml`.
- README rework: one hero image instead of two near-identical ones, and it
  now shows what the project actually does — watch, remember with
  timestamps, verify — rather than repository and skill tracking. The LOOP
  demo moved above the fold, and the install command is the first thing
  after the description.
- SECURITY.md now states plainly that `loop_video_gen` and `loop_game`
  execute the command string you pass them, that an agent with MCP access
  can therefore run arbitrary commands through those two tools, and what
  to do if that is not acceptable in your setup.

## v1.0.0 — 2026-07-12

Video skills for every AI agent, with memory. One release, seven claims,
each shipped with a measured receipt from the reference machine (8 GB
RAM, CPU-only Windows) — the benchmark tables and demo logs quoted in
the README all come from real runs there.

### Everywhere — the skills library and the agent matrix
- **Nine-skill library** (`adapters/claude-skill/skills/`):
  `watching-videos`, `asking-with-evidence`, `the-loop`,
  `learning-from-mistakes`, `extracting-structure`, `video-memory`,
  `sharing-results`, `configuring-vision`, and `recovering-from-errors`.
  Each SKILL.md description is a trigger surface with
  real user phrasings; each body wraps the CLI only, so the set rides
  into any harness that reads skills. `/watch` remains the direct
  user-invocable entry point.
- **Provider-neutral setup**: `setup-vision` now configures Anthropic,
  OpenAI, Gemini, OpenRouter, or the optional local Ollama path. One model
  can serve both tiers, or `--cheap-model` / `--strong-model` can route
  perception and verification separately. The agent client and model
  vendor are independent choices.
- **20+ agents in the matrix** (`docs/agents/`): twelve new pages —
  GitHub Copilot CLI, Kimi Code, Qwen Code, OpenCode, Goose, OpenHands,
  Kilo Code, Qodo, Agent Zero, OpenClaw, Pi, Hermes-style — each written
  against the agent's CURRENT official docs and graded honestly
  (machine-tested / machine-configured / doc-verified). Every fenced
  config block in every page is parsed by
  `templates/agent-adapter/validate.py`, wired into the suite.
- **Add-your-agent funnel**: `templates/agent-adapter/` (walkthrough +
  skeleton + validator) — one config block, one doc page, ~20 minutes.
- **Agent visual system**: every named client guide has a logo-derived
  pixel-art avatar, the README gallery covers all supported agents, and
  tests prevent guide/gallery/assets from drifting apart.
- **Sixteen examples**: a task-oriented catalog now includes a private,
  offline workflow and self-contained viewer export alongside the original
  fourteen demonstrations.

### Remembers — the library layer (index migration v7, new tables only)
- Every watch distills **notes** — entities, claims, chapters, each with
  (video_id, timestamp) provenance — incrementally: video N never
  reprocesses the others. Works transcript+OCR-only; vision adds
  material.
- **`library_synthesize(question)`** (MCP + CLI `library ask` + REST):
  answers questions no single video holds, extractively and offline —
  per-video timestamp citations, corroboration across videos raises
  confidence, honest floor when the library does not clearly know.
  Cached with automatic invalidation when the library grows.
  **`library_overview()`**: what the library knows.
- Live receipt: a 4-clip incident story answered across all four clips
  (confidence 0.566, corroborated, repeat served from cache, ~784 tokens
  saved on the meter). `library rebuild-notes` upgrades pre-v7 indexes.

### Nearly free — the cost meter and THE COST POLICY
- **Cost meter v2**: every answer carries `cost_breakdown` (tokens by
  source: text-first / local escalation / vision call / response frames)
  and a USD estimate; lifetime split behind `watch-skill stats --cost`.
  Prices live in a dated data file (`vision/prices.json`).
- **`WATCHSKILL_COST_POLICY`**: `cheapest` (default — cheapest path that
  clears confidence wins), `quality_first`, or `offline_only` (cloud
  never sees a frame).
- **`benchmarks/cost/`**, committed from a real run: ~5,868 tokens fully
  offline vs ~18,890 computed for raw-frames-into-context on the same
  15-frame index — $0.00 measured, before the cache makes repeats free.

### High-quality vision anywhere — perception with receipts
- **OCR backend registry** (`perceive/ocr_backends.py`): rapidocr
  default; tesseract auto-routed ONLY for the scripts rapidocr 3.9.1
  genuinely lacks (Lao/Khmer/Myanmar/Tibetan — audited against its
  LangRec enum); surya opt-in, never auto-routed on small machines.
- **Multi-script-per-frame router**: each candidate script engine reads
  the full frame; regions merge by overlap, gated on the engine finding
  its own script there. On the committed mixed code+Arabic+CJK fixture:
  **98% char-hit vs 81%** for the best single engine. (The first design
  re-read cropped regions and measured WORSE than no routing — the bench
  is why it was rebuilt.)
- **`watch-skill bench perception`** + committed fixtures and results:
  char-hit, latency, peak RSS per backend — including the vision rows
  that show why a captioning model cannot replace OCR (moondream: 18%
  on Arabic, 0% on CJK; OCR: 94–100%).
- **Local vision robustness**: liveness-cached health check, ONE
  detached restart of a dead Ollama (never `ollama stop`), one settled
  retry on a 5xx from a fresh server, and a structured
  `vision.server_down` (with a fix) instead of empty strings — the
  kill-the-server scenario is a recorded live demo, both branches.
- Opt-in retrieval upgrade: `WATCHSKILL_EMBEDDING_MODEL` (bge-m3,
  multilingual-e5) seeds NEW indexes; existing indexes keep their pinned
  model. Big models want ~2 GB+ RAM — documented, not defaulted.

### Heals itself
- **`doctor --fix` repairs every failure class this project has hit**:
  dead local vision server (detached restart), corrupt cached answers
  (quarantined), truncated model files (deleted; they re-download),
  vanished frame directories (reindex hint), stale WAL, tight commit
  headroom (with a local-model recommendation for the machine), and a
  missing Playwright recording runtime (installed automatically).
- **Privacy controls now hold during escalation**: disabling OCR also
  disables dense-resample and zoom-crop OCR, so an offline or deliberately
  OCR-free run never downloads a model behind the user's back.
- **Structured-errors audit**: every raise site in `src/` carries an
  actionable `fix` — enforced forever by an AST-walking test; ten real
  error paths asserted to return executable advice. 25 sites were
  patched to get there.

### Improves itself
- **`lessons eval --report`** replays every stored lesson against the
  CURRENT pipeline — once normally, once with the lesson suppressed —
  and classifies it: still-effective (load-bearing), prunable (the
  pipeline absorbed the fix), regressed (needs a human).
  **`--prune`** retires exactly the prunable ones.
- The mechanics in one page: `docs/guides/how-it-improves-itself.md`.
  Building the live demo caught three real eval bugs (stopword terms
  passed everything; the floor text leaked question words; hallucination
  phrasing misclassified) — fixed and regression-tested.

### Useful to everyone — the packs (`docs/packs/`)
- **Browser-agent verification (the flagship)**: agents can drive real
  browsers now; a screenshot shows a moment, not a flow. The pack
  records the session and verdicts the RECORDING —
  `examples/14-browser-verification/` catches a checkout total that
  reads $NaN for 1.5 s mid-flow and looks perfect afterwards. Building
  it exposed and fixed two real defects: grayscale phash dedup collapsed
  hue-only flows to one frame (loop/monitor critiques now pin undedupable
  **flow cues**), and "never shows nan" banned an unmatchable verb
  phrase (the parser now sheds light verbs).
- **Monitoring/ops**: monitor events now deliver to
  `WATCHSKILL_WEBHOOK_URL` — HMAC-SHA256-signed, retried with backoff,
  never fatal, `events.jsonl` regardless — tested against a live local
  receiver. This is the piece n8n/Zapier builders were missing.
- QA/bug hunting, content creators, learning/research,
  meetings/lectures, agent self-verification: recipes over existing
  tools, each pointing at a runnable example with recorded output.

### Compatibility
- No breaking changes across the whole span: every v0.6 MCP tool
  name/signature unchanged (pinned by test), CLI intact, index
  migrations forward-only v5→v6→v7, `~/.watch-skill/` loses nothing.
  v0.6 users upgrade straight to v1.0.

### Foundation (built en route, first released here)

Everything below was completed and live-proven after v0.6.0 and ships
for the first time in this release.

#### One-command install (`adapters/claude-skill/`, `.claude-plugin/`)
- **Claude Code plugin marketplace**: `/plugin marketplace add oxbshw/watch-skill`
  → `/plugin install watch-skill@watch-skill` → a working `/watch`, zero
  manual venv steps. The bundled MCP config launches the on-PATH engine.
- New **`/setup-watch-skill`** command: installs the engine (uv bootstraps
  its own Python), runs the self-healing doctor, registers the MCP server in
  every detected agent (Claude Code/Desktop, Cursor, Codex, Windsurf, Gemini
  CLI — each with a config backup), then offers a vision backend.

#### Vision backends (`health/vision_setup.py`, `vision/`)
- **`watch-skill setup-vision`**: Anthropic, OpenAI, Gemini, OpenRouter,
  or **Ollama** fully offline. Cloud setup accepts an existing provider
  key and optional model names; `--verify` runs a live probe-frame describe.
- Low-RAM machines are first-class: RAM-aware model pick (moondream under
  12 GB), context window sized to fit (`WATCHSKILL_OLLAMA_NUM_CTX`),
  temperature-0 reproducible calls, keep-alive pinning, and the loop
  producers unload the local model before browser captures (a resident
  model and a recording browser cannot coexist in 8 GB).

#### THE LOOP, multiplied (`loop/`)
- The UI loop is now **proven with real vision**: broken page flagged from
  actual model reads, fix verified, before/after GIF+MP4 rendered.
- **Pluggable loop framework**: a loop type is a registry entry deciding how
  the recording is produced; `loop_start`/`loop_iterate` are unchanged.
- Three new loop types, each an MCP tool + CLI + runnable example:
  **`loop_video_gen`** (run any generator — Manim/Remotion/ffmpeg — watch
  the render, iterate until it matches the spec), **`loop_game`** (launch a
  game/sim, record gameplay, catch visual/state glitches like a NaN HUD),
  **`loop_monitor`** (bounded watch over a folder/stream; a described
  condition becomes a structured event in `events.jsonl` + callback — the
  v0.8 webhook seam).
- **Describe-then-judge critic**: small captioning models (moondream) can't
  emit the critic's JSON, but they describe frames dependably — so
  deterministic rules parsed from your criteria decide (banned terms from
  "never X" fail a frame; exemplar shapes from "(like $29.00)" pass the
  recording; digit-generalized and whitespace-tolerant, so a misread
  "ERROR 5082" still matches), with a plain PASS/FAIL judgment only where
  no rule speaks. `critique_recording` degrades automatically; capable
  models keep the full JSON critic.

#### For every agent framework (`integrations/`, `docs/agents/frameworks.md`)
- Thin native adapters — **LangChain, CrewAI, OpenAI Agents SDK, LlamaIndex,
  AutoGen** — all wrapping the same three core calls; install via extras
  (`pip install "watch-skill[langchain]"`). Vercel AI SDK via the REST
  surface; an n8n community-node spec; REST/OpenAPI as the universal
  fallback.

#### Structured extraction (`extract/`)
- **`extract_chapters`**: titled chapters from scene cuts + transcript
  pauses, minimum length scaled to duration.
- **`extract_bug_report`**: the first on-screen error — timestamp, frame,
  exact OCR text, and repro steps from the preceding narration; returns
  `found: false` instead of guessing.
- **`analyze_hook`**: the first N seconds scored on attention trigger,
  pacing, visual change, and on-screen text — each with an actionable
  critique.

#### Batch + the shareable viewer (`batch.py`, `viewer.py`)
- **`watch_batch`**: one call indexes a playlist/channel URL, a folder, or a
  list; one broken video never kills the batch; afterwards a single
  `search_videos`/`ask_video` spans the whole set.
- **`generate_viewer`**: a self-contained offline HTML page per analysis —
  timeline, inlined key frames, transcript, OCR, and every cached answer
  with the exact evidence cited. Zero network requests; share the file as-is.

#### Search that actually works across scripts (`index/textnorm.py`)
- Thai/Lao/Khmer/Myanmar/Tibetan are now segmented (search was fully broken
  for unspaced scripts); Persian/Urdu letter variants unify with Arabic;
  Arabic-Indic/Persian/Devanagari/Bengali/Thai/Lao/Tibetan/Myanmar/Khmer
  digits fold to ASCII ("٢٠٢٦" matches "2026"); Hebrew niqqud + final
  forms, Greek final sigma + tonos, German ß/umlauts, Cyrillic ё, and
  Vietnamese diacritics fold too. Forward migration v6 re-folds existing
  indexes in place — nothing is lost, nothing re-processed.

#### The engine answers in your language (`answer/localize.py`)
- The honest-floor refusal, evidence labels, and the model-answer directive
  follow the question's language (13 languages); the loop critic follows the
  pass criteria's language. Cross-lingual answers are a tested contract, not
  luck. RTL text can't mangle timestamps: they're wrapped in Unicode
  isolates.

## v0.6.0 — 2026-07-05

Three systems around one promise: frame-accurate answers you can trust, at
a fraction of the tokens.

### Self-healing answers (`answer/`)
- Every `ask_video` carries a **confidence score** from real retrieval
  signals (top-hit strength, margin over the runner-up, strength-gated
  evidence agreement) — calibrated against measured score distributions.
- **Escalation ladder**, cheapest first, stops the moment confidence clears
  the bar: dense high-res re-sampling around candidate timestamps → 2× zoom-
  crop re-OCR (recovers on-screen text the full frame mangled) → model
  verify pass, cheap tier then strong. Recovered evidence is indexed
  permanently.
- **Verify pass**: the model is shown the exact frames about to be cited and
  must return `{supported, certainty, answer}`; an eyewitness rejection
  forces the honest floor regardless of retrieval strength.
- **Honest floor**: below the floor the answer states plainly the video does
  not clearly show it, with the closest real moments. Citation timestamps
  can only come from indexed evidence (fabrications are stripped at
  composition, test-forced).
- Structured metadata on every answer: `confidence`, `verified`,
  `escalations_used`, `cached`, `budget_stopped`, evidence timestamps.

### Self-improve loop (`lessons/`) — local, never uploaded
- `report_mistake` (MCP + `watch-skill lessons add`): a wrong answer + its
  correction becomes a classified lesson (missed-ocr / wrong-timestamp /
  hallucination / language / sampling-miss) in `~/.watch-skill/lessons.db`,
  shared by every agent on the machine; where the class is mechanical the
  question is re-asked immediately to confirm the lesson works.
- Relevant lessons inject into future asks under a hard ~300-token cap.
- **Every mistake becomes a test**: `lessons export-evals` + `evals run`
  replay all past mistakes and report the pass-rate over time.
- **Adaptive profiles**: per-content-type error statistics (screencast,
  talking-head, vertical, fast-cut — auto-classified from index stats)
  become data overrides: OCR-first escalation, denser sampling, stricter
  thresholds. Inspect with `profiles show`, reset any time.

### Token economy
- **Text-first responses**: timestamps in prose, zero image tokens by
  default; frames attach only on request or in the genuinely-uncertain band.
- **Semantic answer cache** (index migration v5): repeat and near-duplicate
  questions are free and marked `cached: true`; invalidated on re-watch,
  cleared with `clean --cache-answers`.
- **Savings meter**: every answer ends with `~N tokens saved vs raw-frame
  injection`; lifetime meter via `watch-skill stats` / the `stats` MCP tool.
- Telegraphic scene descriptions (≤12 words, names/numbers kept) cut
  indexing and retrieval token weight.
- **Per-question token budget** the escalation ladder respects and reports.

### Also
- `watch-skill forget <video_id>` removes one video (rows, cached answers,
  frames dir) with a structured error on unknown ids (#3).
- REST: `POST /v1/answer` returns the structured Answer; `/v1/ask` unchanged.
- No breaking changes: every v0.5 MCP tool name/signature intact; index
  upgrades v4→v5 forward-only and losslessly (migration-tested).

## v0.5.0 — 2026-07-05

First public release.

### Core
- **Watch anything**: 1800+ sites via yt-dlp (self-updating on extractor
  breakage), direct media URLs, HLS/DASH manifests (bounded live capture),
  local files, screen/window/browser capture. Download cache with LRU cap.
  Optional self-hosted cobalt fallback (the public API now requires auth,
  so it is opt-in via `WATCHSKILL_COBALT_API_URL`).
- **Smart perception**: PySceneDetect scene boundaries + midpoints,
  perceptual-hash dedup, duration-tiered frame budgets (hard cap 100,
  ≤2 fps), focused `--start/--end` mode with dense sampling, OCR on kept
  frames (RapidOCR 3.x; per-script models auto-selected and auto-downloaded —
  Arabic, Cyrillic, Devanagari, Korean and more, benchmarked per script).
- **Transcription ladder**: platform captions (original language preferred
  over auto-translations) → local faster-whisper (RAM-aware model
  auto-select, fully offline) → opt-in cloud STT (Groq/OpenAI, chunked with
  2 s overlap). Focused watches transcribe only the requested window.
  Optional pyannote speaker diarization (`diarize` extra).
- **Persistent index**: schema-versioned SQLite, FTS5 + local ONNX
  embeddings hybrid retrieval with a **multilingual embedding model**
  (cross-lingual: ask in English over an Arabic transcript), numpy-batched
  vector scoring, Arabic-aware text normalization (hamza/ta-marbuta/
  diacritic folding). Analyze once, ask forever, search across every video
  ever watched.
- **Model-agnostic vision**: Anthropic / OpenAI / Gemini / OpenRouter /
  Ollama behind one interface; cheap + strong tiers; pre-call cost guard;
  batch-size and timeout knobs tuned for small local models.
- **THE LOOP**: capture (Playwright / gdigrab) → structured-JSON vision
  critique against natural-language pass criteria → phash-aligned diff
  (fixed/unchanged/new) → iterate until pass — with a before/after MP4+GIF
  proof artifact. The loop observes; the calling agent fixes.

### Surfaces
- MCP server (stdio + streamable HTTP): 11 tools with agent-first
  descriptions, progress notifications, `background=true` + `get_status`
  polling for long watches.
- CLI (`watch-skill ...`) including `doctor` (self-healing: ffmpeg, yt-dlp,
  deno, disk, GPU, keys) and `setup` (auto-writes MCP config into Claude
  Code/Desktop, Cursor, Codex CLI, Windsurf, Gemini CLI — with backups).
- REST API (FastAPI, OpenAPI at /openapi.json, bearer auth).
- Claude Skill (drop-in `/watch` upgrade) + AGENTS.md template.

### Structural errors everywhere
`{error, message, fix, details}` — agents act on `fix`, not prose.
