# Roadmap

The thesis behind v1.0: every AI agent — coding agents, browser agents,
framework agents — needs to watch video. Its own UI. A bug recording. A
tutorial. The browser session it just drove. Agents can act on screens
at scale now, and an agent that acts on screens needs an independent eye
that watches the recording and verifies the outcome. watch-skill aims to
be that layer for all of them: installed everywhere, remembering
everything it watches, at a measured near-zero cost, with the best
perception the machine at hand allows, healing and improving itself, and
packaged for real work.

v1.0 shipped all seven of those claims with receipts (see the README's
benchmark tables and the examples' recorded runs). Everything below
builds on them without breaking the contracts: engine agent-agnostic,
MCP tool names stable, forward migrations only.

## Known gaps in the current tree

Stated plainly rather than left implicit. Each of these is a design that is
not built yet, not a feature that half-works.

- **Live speech recognition needs the optional model.** Audio capture,
  chunking, timestamping and event publication run on every test. Recognition
  uses faster-whisper, an optional extra; without it a session reports
  `asr: degraded, model_unavailable` and continues visually. Real recognition
  now has an opt-in gate (`WATCHSKILL_TEST_REAL_ASR=1`) measured against a
  locally synthesized fixture: **WER 0.0 over 20 reference words, 0.27x
  realtime, faster-whisper tiny int8 on CPU.** That is clean synthetic speech,
  an easier problem than a real recording — see [testing.md](testing.md).
- **Semantic live vision has no real-model result.** The selector, schema
  validation, circuit breaker, staleness guard and advisory labelling are
  tested with a deterministic backend. `watch-skill models bootstrap-vlm` will
  fetch SmolVLM2-500M-Video-Instruct on a machine that can hold it; this one
  cannot — 3.5 GiB free disk against 8 required, 1.6 GiB available RAM against
  3, and neither torch nor transformers installed. No VLM has been run here,
  so "the agent understands what it sees" is **not** a claim this build has
  earned.
- **The live browser source is not built.** Recorded browser capture works
  (`capture`, `loop_start`); a live browser session emitting synchronized
  pixel and structured (DOM/console/network) evidence does not exist yet.
- **Live triggers and the Observer Loop are not built.** No deterministic or
  semantic trigger evaluation exists, so nothing watches a live session for a
  declared condition.
- **Live capture is file-replay and stream only.** Browser, screen, window and
  camera work for *recorded* capture (`capture`, `loop_start`) and are not
  wired as live sources. `capture-capabilities` reports this per kind rather
  than leaving it to be discovered at the failure.
- **The MCP UI is a self-contained HTML viewer, not an MCP App.** The official
  MCP Apps extension (`ui://` resources, app-only tools, interactive live
  player) is not implemented.
- **The ten skills are not consolidated.** `benchmarks/skill_tokens.py`
  measures the current cost — 1,259 discovery tokens every session across ten
  skills, 5,232 body tokens total — and the four-skill progressive-disclosure
  design is not built. The number is a baseline, not a result.
- **There is no plugin entry-point SDK, TypeScript SDK, or adoption
  analytics.** Backends are internal protocols; external plugins cannot
  register.
- **Capture is still not machine-tested off Windows.**
  `watch-skill capture-capabilities` now reports every kind with how its
  answer was established, so nothing claims support it has not earned — macOS
  screen is `degraded` (ScreenCaptureKit unimplemented, permission unprobeable)
  and Wayland is `unavailable` (the PipeWire/portal path does not exist here).
  Detection is tested in CI on every platform; actual hardware capture is not,
  because the runners have no camera, microphone, or desktop session. See
  [capture-capabilities.md](capture-capabilities.md).
- **Verification check types stop where they can be deterministic.** DOM
  locator, accessibility, browser-console and failed-request assertions, and
  test-report ingestion are designed but absent — see
  [verification.md](verification.md). They are missing rather than stubbed,
  because a check that always passes is worse than no check.
- **`remote_attested` is defined and not implemented**, on purpose. See
  [DECISIONS.md](DECISIONS.md).
- **Skill token footprint is measured, not yet reduced.** Ten skills,
  23,581 bytes, ~1,140 metadata tokens at discovery and ~4,717 body tokens if
  every skill loads. No progressive disclosure is in use. The overlap between
  `watch` / `watching-videos` / `asking-with-evidence` / `video-memory` is
  real and unaddressed.

## v1.1 candidates

- **Team-shared video memory**: the remote MCP recipe (streamable HTTP +
  bearer auth) graduated into a documented deployment — one library,
  many agents, `library_synthesize` across a team's footage. The notes
  layer (schema v7) was designed with this in mind: provenance survives
  sharing.
- **More machine-tested agent rows**: every doc-verified ☑ row in the
  matrix is one community smoke test away from ✅ — the good-first-issue
  batch exists for exactly this.
- **Comparison / A-B mode** (`extract/hook.py`): two cuts of a video →
  which hook wins, building directly on `analyze_hook`.
- **Visual diff between two videos** (`loop/diff.py`): the phash
  alignment engine already pairs frames across recordings; expose it as
  a first-class tool for visual regression monitoring.
- **Tesseract fallback machine-proven**: the Lao/Khmer/Myanmar/Tibetan
  route ships tested against fixtures; a live read on a machine with
  tesseract installed upgrades the bench table.
- **Framework adapters promoted**: LlamaIndex and AutoGen get live
  agent-run examples like the LangChain/CrewAI/Agents-SDK trio has.

## Medium term

- **Scene graph**: object/person persistence across scenes ("track the
  red car"), built on the existing phash alignment.
- ~~**Bootstrap tesseract like every other binary**~~ — done, as far as it
  can be. Language files now download themselves on first use for the
  scripts RapidOCR reads at 0% (Lao, Khmer, Myanmar, Tibetan), which is the
  half that is usually missing — `apt install tesseract-ocr` ships English
  and leaves those in separate packages. The binary is installed via winget
  on Windows; elsewhere it needs a package manager, so `doctor` warns with
  the exact command instead of failing. The engine was never the gap:
  RapidOCR reads clean text at confidence 1.00, and Surya stays opt-in
  because it needs more RAM than the 8 GB reference machine.
- ~~**Narrower vector storage**~~ — tried, measured, rejected. float16
  halves the index (197 MB → 80 MB at 100k) with no change to ranking, but
  widening it back on every read takes the scan from 115 ms to ~310 ms per
  100k, and no decode strategy avoids that. Storage stays float32; the
  reader accepts either width, so an index written during the experiment
  still works. Table in [DECISIONS](DECISIONS.md).
- **Index size is the remaining scaling limit** (`index/`): ~2 KB per vector
  means a 100k-item library is a 200 MB file, while the scan behind it is
  only 115 ms. `watch-skill stats --disk` now shows where that space went
  and ranks videos by what they cost, so `forget` is an informed decision
  rather than a guess. Still open: automatic eviction by age or access, and
  an opt-in smaller embedding model — both reduce the file without charging
  every query, which is what ruled out narrower vectors.
- **sqlite-vec for vector search**: still 0.1.9 with no stated development
  status, and the numbers above say the latency it would fix is not yet
  felt. It keeps everything in the one SQLite file, which is why it remains
  the intended answer — see [DECISIONS](DECISIONS.md) for the full table and
  the condition to revisit.
- **Streaming watch progress over MCP** (`surfaces/mcp/`): partial
  transcript/scene events as they land, so agents can answer before the
  watch finishes.
- ~~**Word-level timestamps**~~ — shipped. `--word-timestamps` aligns each
  word through the local-whisper rung; `get_moment` names the word being
  spoken at the instant asked about. Captions and cloud STT carry no
  alignment, so the field is absent rather than guessed.
- **Diarization polish** (`transcribe/diarize.py`): lighter local
  backend, speaker naming from context, diarized evidence.
- **yt-dlp PO-token / impersonation extras** (`acquire/`): opt-in
  "hardened acquisition", off by default to preserve the no-cookies
  invariant.
- **Retrieval-quality benchmark**: scored (video, question,
  expected-evidence) triples measuring retrieval and frame-budget
  efficiency across providers — the missing sibling of the cost and
  perception benches.

## Non-goals (so PRs don't die in review)

- No cookies/login-based acquisition — the privacy invariants are the
  product.
- No always-cloud pipeline: local-first transcription and local vision
  options stay first-class.
- No agent-specific logic inside the engine — that belongs in adapters
  and skills.
