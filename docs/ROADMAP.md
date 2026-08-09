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
