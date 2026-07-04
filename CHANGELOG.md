# Changelog

## v1.0.0 — 2026-07-04

First public release.

### Core
- **Watch anything**: 1800+ sites via yt-dlp (self-updating on extractor
  breakage), direct media URLs, HLS/DASH manifests (bounded live capture),
  local files, screen/window/browser capture. Download cache with LRU cap.
- **Smart perception**: PySceneDetect scene boundaries + midpoints,
  perceptual-hash dedup, duration-tiered frame budgets (hard cap 100,
  ≤2 fps), focused `--start/--end` mode with dense sampling, OCR on kept
  frames (RapidOCR; per-script models auto-selected — Arabic verified live).
- **Transcription ladder**: platform captions (original language preferred
  over auto-translations) → local faster-whisper (RAM-aware model
  auto-select, fully offline) → opt-in cloud STT (Groq/OpenAI, chunked with
  2 s overlap). Focused watches transcribe only the requested window.
  Optional pyannote speaker diarization (`diarize` extra).
- **Persistent index**: schema-versioned SQLite, FTS5 + local ONNX
  embeddings hybrid retrieval, Arabic-aware text normalization (hamza/
  ta-marbuta/diacritic folding). Analyze once, ask forever, search across
  every video ever watched.
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
- CLI (`agentvision ...`) including `doctor` (self-healing: ffmpeg, yt-dlp,
  deno, disk, GPU, keys) and `setup` (auto-writes MCP config into Claude
  Code/Desktop, Cursor, Codex CLI, Windsurf, Gemini CLI — with backups).
- REST API (FastAPI, OpenAPI at /openapi.json, bearer auth).
- Claude Skill (drop-in `/watch` upgrade) + AGENTS.md template.

### Structural errors everywhere
`{error, message, fix, details}` — agents act on `fix`, not prose.
