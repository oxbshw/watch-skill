# Changelog

## v1.0.0 — 2026-07-12

Video skills for every AI agent, with memory. One release, seven claims,
each shipped with a measured receipt from the reference machine (8 GB
RAM, CPU-only Windows) — the benchmark tables and demo logs quoted in
the README all come from real runs there.

### Everywhere — the skills library and the agent matrix
- **Seven-skill library** (`adapters/claude-skill/skills/`):
  `watching-videos`, `asking-with-evidence`, `the-loop`,
  `learning-from-mistakes`, `extracting-structure`, `video-memory`,
  `sharing-results`. Each SKILL.md description is a trigger surface with
  real user phrasings; each body wraps the CLI only, so the set rides
  into any harness that reads skills. Loaded from a local plugin install,
  the whole library costs ~805 always-on tokens (measured via
  `claude plugin details`). `/watch` and `/setup-watch-skill` unchanged.
- **20+ agents in the matrix** (`docs/agents/`): twelve new pages —
  GitHub Copilot CLI, Kimi Code, Qwen Code, OpenCode, Goose, OpenHands,
  Kilo Code, Qodo, Agent Zero, OpenClaw, Pi, Hermes-style — each written
  against the agent's CURRENT official docs and graded honestly
  (machine-tested / machine-configured / doc-verified). Every fenced
  config block in every page is parsed by
  `templates/agent-adapter/validate.py`, wired into the suite.
- **Add-your-agent funnel**: `templates/agent-adapter/` (walkthrough +
  skeleton + validator) — one config block, one doc page, ~20 minutes.

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
  headroom (with a local-model recommendation for the machine).
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
- **`watch-skill setup-vision`**: Gemini (free tier, the recommended
  zero-cost default; `WATCHSKILL_GEMINI_API_KEY`) or **Ollama** fully
  offline. `--verify` runs a live probe-frame describe.
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
