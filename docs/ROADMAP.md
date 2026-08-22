# Roadmap

## What this is converging on

Agents can act on screens now. They click, type, navigate and report back —
and the reporting is the weak part. An agent that says "done" is describing its
own intent, and the industry's answer so far has been a better-behaved agent
rather than an independent record of what happened.

Watch Skill is that record. Three layers, each useful alone and much more
useful together:

**Perception** turns any visual source into timestamped evidence — video, a
live stream, a meeting, a screen, a browser session, generated video, a game.
Scene-aware frames, on-screen text, transcripts, and the structured state of a
page, all carrying the moment they came from.

**Memory** keeps that evidence and makes it answerable later. Watch once, ask
for a year. The index is local, schema-versioned, and addressed by content
rather than by filename, so an answer cites a moment that can be checked
instead of a summary that has to be trusted.

**Verification** turns evidence into a verdict. Deterministic checks decide;
a model may describe, advise, and read the record, but it never rules. An
action with no expectation is unverified, an absent check is inconclusive, and
a page that renders success over a failed request is a failure.

The direction is to make the third layer hard to fool and the second layer
worth keeping for years. Perception is the input to both, so it improves in
service of them rather than for its own sake.

## What would make this matter more

Ordered by how much each would change what the product can honestly claim,
not by how easy it is.

**Verification that survives an adversary.** Today a contract can be fooled by
a failure that never reaches any oracle. The work is more check types
(accessibility, failed-request assertions, ingesting a test report), and
correlating them so a run is judged on the whole recording rather than its
final frame. Every one of these narrows the gap between "the checks passed"
and "it actually worked".

**Evidence somebody else can verify.** `remote_attested` is defined and
deliberately unimplemented: a hash is not a signature, and an attestation
nobody can check independently is decoration. Making a run's evidence bundle
verifiable by a third party is what turns a local verdict into something an
auditor, a customer, or a CI system can accept.

**Memory that spans sources and time.** The entity layer already tracks
attributes across a session. The direction is answers that hold across many
recordings and many days — what changed between two releases, when a
regression first appeared, which of forty sessions shows the failure —
without re-processing anything.

**Perception that keeps up with the present.** Local VLM inference costs tens
of seconds on ordinary hardware, so understanding lags the screen. Better
selection, smaller models, and the freshness semantics that already label a
late reading as historical are what keep a slow model honest instead of
misleading.

**A footprint small enough to leave installed.** Ten skills cost about 1,259
discovery tokens every session before an agent does anything. Progressive
disclosure and consolidation are how the product stays installed rather than
being removed for being expensive to have around.

## Status of the current tree

Stated plainly rather than left implicit. Anything listed as planned is a
design that is not built, not a feature that half-works.

### Available

These shipped and carry evidence. They are listed because earlier revisions of
this roadmap described them as gaps.

- **Live browser sessions** emit synchronized pixel and structured
  (DOM, console, network) evidence — [live browser](guides/live-browser.md).
- **Browser Runtime operator mode** drives a browser and verifies its own
  actions, sharing one browser subsystem with observer mode —
  [browser runtime](browser-runtime.md).
- **Live triggers and the Observer Loop** evaluate declared conditions against
  a running session — [observer loop](guides/observer-loop.md).
- **The MCP App** ships as a `ui://` resource with app-only tools —
  [the MCP App](guides/mcp-app.md).
- **Semantic live vision has a real-model result.** A local VLM produces
  observations inside a running session, persisted with provenance and readable
  from a fresh process — [VLM performance](vlm-performance.md) has the
  latency, memory, and failure modes.

### Known gaps

- **Live speech recognition needs the optional model.** Audio capture,
  chunking, timestamping and event publication run on every test. Recognition
  uses faster-whisper, an optional extra; without it a session reports
  `asr: degraded, model_unavailable` and continues visually. Real recognition
  has an opt-in gate (`WATCHSKILL_TEST_REAL_ASR=1`) measured against a locally
  synthesized fixture: **WER 0.0 over 20 reference words, 0.27x realtime,
  faster-whisper tiny int8 on CPU.** That is clean synthetic speech, an easier
  problem than a real recording — see [testing.md](testing.md).
- **Local VLM inference is slow on CPU-only hardware.** Tens of seconds per
  inference on the 8 GiB reference class. It is asynchronous evidence, never an
  interactive path, and a session without the model continues without it.
- **Some verification check types are still absent.** DOM locator, browser
  console, and live evidence assertions exist. Accessibility assertions,
  failed-request assertions, and test-report ingestion are designed and not
  built — see [verification.md](verification.md). They are missing rather than
  stubbed, because a check that always passes is worse than no check.
- **`remote_attested` is defined and not implemented**, on purpose. See
  [DECISIONS.md](DECISIONS.md).
- **Capture is not machine-tested off Windows.**
  `watch-skill capture-capabilities` reports every kind with how its answer was
  established, so nothing claims support it has not earned — macOS screen is
  `degraded` (ScreenCaptureKit unimplemented, permission unprobeable) and
  Wayland is `unavailable` (the PipeWire/portal path does not exist). Detection
  is tested in CI on every platform; hardware capture is not, because the
  runners have no camera, microphone, or desktop session. See
  [capture-capabilities.md](capture-capabilities.md).
- **The ten skills are not consolidated.** `benchmarks/skill_tokens.py`
  measures the current cost — 1,259 discovery tokens every session across ten
  skills, 5,232 body tokens total — and the four-skill progressive-disclosure
  design is not built. The overlap between `watch` / `watching-videos` /
  `asking-with-evidence` / `video-memory` is real and unaddressed. The number
  is a baseline, not a result.
- **There is no plugin entry-point SDK, TypeScript SDK, or adoption
  analytics.** Backends are internal protocols; external plugins cannot
  register.

## Named work, by theme

Nothing here carries a date. Items move when they are built and proved, and
several below record something that was tried and rejected, because that is as
useful to a contributor as a plan.

### Verification depth

- Accessibility, failed-request, and test-report check types
  ([verification.md](verification.md)). Missing rather than stubbed: a check
  that always passes is worse than no check.
- Independent attestation for `remote_attested` — see
  [DECISIONS](DECISIONS.md) for why a digest alone does not qualify.
- A retrieval-quality benchmark: scored (video, question, expected-evidence)
  triples, the missing sibling of the cost and perception benches.

### Memory and scale

- **Index size is the live scaling limit.** About 2 KB per vector means a
  100k-item library is a 200 MB file, while the scan behind it is 115 ms.
  `watch-skill stats --disk` shows where the space went so `forget` is
  informed. Open: eviction by age or access, and an opt-in smaller embedding
  model — both shrink the file without charging every query.
- ~~**Narrower vector storage**~~ — tried, measured, rejected. float16 halves
  the index (197 MB → 80 MB at 100k) with no ranking change, but widening it
  on every read takes a 100k scan from 115 ms to ~310 ms. Storage stays
  float32 and the reader accepts either width.
- **sqlite-vec** remains the intended answer because it keeps everything in
  the one SQLite file, but it is still 0.1.9 with no stated development
  status and the latency it would fix is not yet felt.
- **Scene graph**: object and person persistence across scenes, built on the
  existing phash alignment.
- **Team-shared memory**: the remote MCP recipe graduated into a documented
  deployment. The notes layer was designed for it — provenance survives
  sharing.

### Perception

- **Streaming watch progress over MCP**: partial transcript and scene events
  as they land, so an agent can answer before the watch finishes.
- **Diarization polish**: a lighter local backend, speaker naming from
  context, diarized evidence.
- **Visual diff between two recordings**: the phash alignment already pairs
  frames across videos; exposing it makes visual regression monitoring a
  first-class use rather than a recipe.
- ~~**Word-level timestamps**~~ — shipped. Captions and cloud STT carry no
  alignment, so the field is absent rather than guessed.
- ~~**Tesseract bootstrap**~~ — done as far as it can be. Language files
  download on first use for the scripts RapidOCR reads at 0%; the binary
  needs a package manager off Windows, so `doctor` prints the exact command.
- **yt-dlp hardened acquisition**: PO-token and impersonation extras, opt-in
  and off by default so the no-cookies invariant holds.

### Reach

- **More machine-tested agent rows.** Every documentation-verified row in the
  matrix is one community smoke test away from machine-tested, and the
  distinction is deliberate — see [the agent matrix](agents/README.md).
- **Framework adapters promoted**: LlamaIndex and AutoGen get live agent-run
  examples like the LangChain, CrewAI and Agents-SDK trio has.
- **Skill consolidation**: the four-skill progressive-disclosure design,
  measured against the current 1,259-token discovery cost by
  `benchmarks/skill_tokens.py`.
- **A plugin entry point.** Backends are internal protocols today, so an
  external perception or verification backend cannot register itself.

## Non-goals (so PRs don't die in review)

- No cookies/login-based acquisition — the privacy invariants are the
  product.
- No always-cloud pipeline: local-first transcription and local vision
  options stay first-class.
- No agent-specific logic inside the engine — that belongs in adapters
  and skills.
