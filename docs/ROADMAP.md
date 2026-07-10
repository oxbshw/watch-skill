# Roadmap

The engine is deliberately agent-agnostic; everything below keeps it that
way. PRs welcome — each item links to the module you'd touch.

## v0.8 (planned)

- **Embedding upgrade to bge-m3 / multilingual-e5** (`src/watch_skill/index/`):
  opt-in and mechanical — the index meta table (schema v3) already pins the
  embedding model per index. Paired with the **full language-coverage
  benchmark** (`watch-skill bench languages`): per-language OCR char-hit,
  WER, search recall, and cross-lingual retrieval — published as the README
  centerpiece, proof over claims.
- **Multi-script-per-frame OCR** (`src/watch_skill/perceive/ocr.py`): a
  script router over `ocr_frame` so one frame mixing scripts (code + Arabic
  UI, subtitles over CJK slides) reads correctly.
- **Webhook/event system** (`src/watch_skill/loop/monitor.py`): generalize
  the Monitor Loop's emissions (today: `events.jsonl` + the `on_event`
  callback seam) into deliverable webhooks — this unlocks n8n/Zapier
  builders and the n8n trigger node speced in `docs/agents/frameworks.md`.
- **Comparison / A-B mode** (`src/watch_skill/extract/hook.py`): two versions
  of a video → which hook wins, building directly on `analyze_hook`.
- **Visual diff between two videos** (`src/watch_skill/loop/diff.py`): "what
  changed vs the old version?" — the phash alignment engine already pairs
  frames across recordings; expose it as a first-class tool for visual
  regression monitoring.
- **Framework adapters promoted to machine-tested**: LlamaIndex and AutoGen
  adapters (unit-tested in v0.7) get live agent-run examples like the
  LangChain/CrewAI/Agents-SDK trio already has.

## Medium term

- **sqlite-vec for vector search** (`src/watch_skill/index/`): the numpy
  batch cosine handles 10k vectors in ~120 ms; past ~100k stored segments a
  real ANN index pays off. sqlite-vec keeps everything in the one SQLite
  file and ships Windows wheels; it's pre-1.0, so adopt once it stabilizes.
- **yt-dlp PO-token / impersonation extras** (`src/watch_skill/acquire/`):
  some extractors increasingly require PO tokens or TLS-fingerprint
  impersonation. Investigate shipping `yt-dlp`'s bgutil PO-token provider
  and curl_cffi impersonation as an opt-in "hardened acquisition" extra, off
  by default to preserve the no-cookies privacy invariant.
- **Streaming watch progress over MCP** (`surfaces/mcp/`): progress
  notifications exist; richer streaming (partial transcript/scene events as
  they land) would let agents answer before the watch finishes.
- **Scene graph**: object/person persistence across scenes ("track the red
  car"), built on the existing phash alignment.
- **Diarization polish** (`src/watch_skill/transcribe/diarize.py`): lighter
  local backend, speaker naming from context, diarized ask_video evidence.
- **Word-level timestamps**: faster-whisper supports them; plumb through
  Segment and let get_moment cite exact words.
- **Remote MCP deployment recipe**: streamable HTTP + bearer auth behind a
  reverse proxy, for team-shared video memory.
- **Benchmark suite** (`benchmarks/`): scored (video, question,
  expected-evidence) triples measuring retrieval quality and frame-budget
  efficiency across providers.

## Delivered in v0.7 (was "near term")

- Pluggable loop framework + video-gen, game/sim, and monitor loop types.
- Framework adapters (LangChain, CrewAI, OpenAI Agents SDK, LlamaIndex,
  AutoGen) + REST fallback docs.
- Structured extraction (chapters, bug report, hook analysis), batch mode,
  and the shareable offline viewer.

## Non-goals (so PRs don't die in review)

- No cookies/login-based acquisition — the privacy invariants are the
  product.
- No always-cloud pipeline: local-first transcription and local vision
  options stay first-class.
- No agent-specific logic inside the engine — that belongs in adapters.
