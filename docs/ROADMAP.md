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
- **sqlite-vec for vector search** (`index/`): the numpy batch cosine
  handles 10k vectors in ~120 ms; past ~100k stored items a real ANN
  index pays off. sqlite-vec keeps everything in the one SQLite file;
  adopt once it stabilizes.
- **Streaming watch progress over MCP** (`surfaces/mcp/`): partial
  transcript/scene events as they land, so agents can answer before the
  watch finishes.
- **Word-level timestamps**: faster-whisper supports them; plumb through
  Segment and let `get_moment` cite exact words.
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
