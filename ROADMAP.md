# Roadmap

The engine is deliberately agent-agnostic; everything below keeps it that
way. PRs welcome — each item links to the module you'd touch.

## Near term

- **More Loop types** (`core/agentvision/loop/`): game capture loops
  (window: + gamepad scripts), video-generation loops (prompt → generated
  clip → critique → regenerate), long-running monitor loops (watch a
  dashboard, alert on visual regression). The runner/critic/diff machinery
  is generic — a new loop type is mostly a capture recipe + criteria preset.
- **Benchmark suite** (`benchmarks/`, does not exist yet): a scored set of
  (video, question, expected-evidence) triples measuring retrieval quality
  and frame-budget efficiency across providers. This is the single highest
  -leverage contribution for quality work.
- **Diarization polish** (`core/agentvision/transcribe/diarize.py`): the
  SpeakerTurn contract + pyannote backend exist; wanted: a lighter-weight
  local backend, speaker naming from context ("the interviewer"), and
  diarized rendering in ask_video evidence.
- **Word-level timestamps**: faster-whisper supports them; plumb through
  Segment and let get_moment cite exact words.

## Medium term

- **sqlite-vec for vector search** (`core/agentvision/index/`): the numpy
  batch cosine handles 10k vectors in ~120 ms; past ~100k stored segments a
  real ANN index pays off. sqlite-vec keeps everything in the one SQLite
  file and ships Windows wheels; it's pre-1.0, so adopt once it stabilizes.
  The index meta table (v3) already pins the embedding model per index, so
  the migration is mechanical.
- **yt-dlp PO-token / impersonation extras** (`core/agentvision/acquire/`):
  some extractors increasingly require PO tokens or TLS-fingerprint
  impersonation. Investigate shipping `yt-dlp`'s bgutil PO-token provider
  and curl_cffi impersonation as an opt-in "hardened acquisition" extra, off
  by default to preserve the no-cookies privacy invariant.
- **Streaming watch progress over MCP** (`surfaces/mcp/`): progress
  notifications exist; richer streaming (partial transcript/scene events as
  they land) would let agents answer before the watch finishes.
- **Embeddings upgrade path**: swappable embedding models (bge-m3 for
  serious multilingual retrieval) behind the existing `index/embeddings.py`
  interface, with an index migration that re-embeds lazily. The meta-table
  model pinning (schema v3) is the first half of this.
- **Scene graph**: object/person persistence across scenes ("track the red
  car"), built on the existing phash alignment.
- **Remote MCP deployment recipe**: streamable HTTP + bearer auth behind a
  reverse proxy, for team-shared video memory.

## Non-goals (so PRs don't die in review)

- No cookies/login-based acquisition — the privacy invariants are the
  product.
- No always-cloud pipeline: local-first transcription and local vision
  options stay first-class.
- No agent-specific logic inside `core/` — that belongs in adapters.
