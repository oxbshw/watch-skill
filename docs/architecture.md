# Architecture

One engine, three thin surfaces. All logic lives in `src/watch_skill`; the
MCP server, the CLI, and the REST API are wrappers that render the same
results and never diverge.

```
              ┌────────────────────────────────────────────────┐
 any agent ──►│  surfaces/  (thin; never contain logic)        │
              │   mcp (stdio + streamable HTTP) · cli · api    │
              └───────────────┬────────────────────────────────┘
                              ▼
              ┌────────────────────────────────────────────────┐
              │  src/watch_skill  (all logic lives here)       │
              │                                                │
              │  acquire ──► perceive ──► transcribe ──► index │
              │     │            │             │           ▲ │ │
              │  health       vision ◄─────────┴───────────┘ │ │
              │  (doctor)     (cheap/strong tiers)           ▼ │
              │                     ▲        answer ◄── lessons│
              │                     │      (confidence ·       │
              │        loop: capture → critic   escalation ·   │
              │              → diff → runner    honest floor)  │
              └────────────────────────────────────────────────┘
```

Rule #1: core never imports `surfaces/`. Surfaces render; core computes.

## Pipeline stages

A `watch` is four stages, run by `watch.py` (the front door) with progress
callbacks:

1. **acquire** — any source to a local file. The self-healing fallback
   chain: yt-dlp → detect extractor breakage, self-update yt-dlp, retry →
   self-hosted cobalt (only when `WATCHSKILL_COBALT_API_URL` is set) →
   direct ffmpeg pull. Network downloads land in a content-addressed LRU
   cache (`<data_dir>/cache`, size-capped) and are reused. Live HLS/DASH
   streams are captured for a bounded duration. Privacy invariants are hard
   rules with tests: no cookies, no logins, the video file never leaves the
   machine.
2. **perceive** — scene detection (PySceneDetect) → duration-tiered frame
   budget (512 px frames, ≤2 fps, hard cap 100; denser "focused mode" when
   the caller names a `start`/`end` window) → perceptual-hash dedup so the
   budget is spent on *distinct* content → OCR on kept frames (RapidOCR,
   ONNX). Per-script recognition models (Arabic, Cyrillic, Korean,
   Devanagari, …) are auto-selected from the video's language and
   auto-downloaded once into `<data_dir>/models/ocr/`.
3. **transcribe** — a ladder, cheapest and most faithful first: platform
   captions (the *original-language* track preferred over auto-translations)
   → local faster-whisper (RAM-aware model choice, fully offline) → cloud
   STT, which is opt-in and only ever receives extracted mono-16kHz audio.
   Each rung's failure is reported to stderr and the next rung tried; if all
   fail the transcript is empty with `source: "none"` and frames-only
   analysis proceeds.
4. **index** — everything lands in a schema-versioned SQLite database
   (`<data_dir>/index.db`): videos, transcript segments, scenes/frames, OCR
   blocks, embeddings, and an FTS5 table. Retrieval is hybrid: BM25 keyword
   search over a normalization-folded shadow column (Arabic hamza/diacritic
   folding, CJK character segmentation) fused with cosine similarity over
   local multilingual ONNX embeddings (384-dim MiniLM-class, numpy-batched —
   122 ms over 10k vectors). The index meta pins the embedding model per
   index so queries always embed with the model that wrote the vectors.

Opportunistically, **vision** describes scenes at index time when a provider
is configured — a failure there degrades to no-descriptions and never sinks
a watch.

## The three surfaces

| Surface | Entry point | Transport | Notes |
|---|---|---|---|
| MCP | `watch-skill serve` | stdio (default) or streamable HTTP (`--http`, port 8747, endpoint `/mcp`) | 13 tools ([reference](tools/README.md)); responses are text + real image blocks capped at `response_frame_cap`. Structured errors serialize as `{error, message, fix, details}`. |
| CLI | `watch-skill <command>` | terminal | Progress to stderr, results to stdout — pipes cleanly. `--json` flags where output is machine-consumed. |
| REST | `watch-skill api` | HTTP (port 8748) | Every MCP tool has a REST twin; OpenAPI at `/openapi.json`. Engine error codes map to HTTP statuses by prefix (`acquire.*`/`vision.*`/`transcribe.*` → 502, `perceive.*`/`loop.*` → 422, `index.*` and `*.not_found` → 404, `config.*` → 400) with the structured body preserved in `detail`. Refuses non-loopback binds without `WATCHSKILL_API_BEARER_TOKEN`. |

Errors are structured everywhere: `WatchSkillError` subclasses carry a
stable `code`, a human `message`, and an actionable `fix` an agent can act
on without parsing prose.

## The self-healing answer loop

`answer/engine.py` is where a question about an indexed video becomes an
answer that is *never silently unverified and never invented*:

1. **Retrieve.** Hybrid search returns the top evidence (transcript
   segments, OCR blocks, scene descriptions) for this video.
2. **Score confidence** from real retrieval signals, calibrated against
   measured distributions (see [DECISIONS.md](DECISIONS.md), v0.6): top-hit
   strength, the *margin* over the runner-up (the strongest signal —
   temporally distant same-kind hits compete, cross-kind hits at the same
   moment corroborate), evidence agreement, and lexical anchoring — the
   fraction of the question's content terms present in the evidence. A
   question with zero lexical grounding is capped below the floor: no
   grounding, no confidence, unless a model verify pass later confirms.
3. **Escalate** while confidence is below the target (default 0.6),
   cheapest first: dense high-resolution re-sampling around candidate
   timestamps, then 2× zoom-crop re-OCR of text regions. Both are
   model-free (local CPU only), and whatever they recover is written back
   into the index permanently — the spend amortizes across every future
   ask. Adaptive profiles learned from past mistakes can reorder the steps
   (e.g. screencasts with missed-OCR history try OCR recovery first).
4. **Verify.** When a vision provider is configured, the model is shown the
   *exact frames about to be cited* and must return a structured
   supported/certainty verdict — cheap tier first, strong tier only while
   confidence stays low. An eyewitness rejection ("I looked, it is not
   there") overrides retrieval strength. Relevant lessons from past reported
   mistakes are injected into the prompt (capped at
   `lessons_injection_token_cap`). No provider reachable? The answer
   degrades gracefully to model-free, and says so on stderr.
5. **Honest floor.** Below the confidence floor (default 0.35), with no
   evidence, or after a model rejection, the answer states plainly that the
   video does not clearly show it — listing the closest real moments and
   pointing at `get_moment` — instead of guessing.

Citation timestamps can only come from indexed evidence: model prose is
sanitized against the evidence list, so a fabricated timestamp cannot
survive composition (test-enforced).

## Accuracy vs token economy — how the ladder reconciles them

The system truth: accuracy wants to spend tokens (look again, look closer,
ask a stronger model); the token economy wants to save them (text-first
answers, caching, tight budgets). Both live in the same engine, reconciled
by *ordering* and a *hard ceiling*:

1. **Free first.** Retrieval + confidence scoring cost zero model tokens. A
   confident answer ships as pure text with timestamps — near-zero image
   tokens.
2. **Compute before tokens.** The first escalation rungs burn only local
   CPU, and their recoveries are indexed permanently.
3. **Tokens only on genuine uncertainty.** The verify pass runs cheap-tier
   first, strong-tier only if still unsure — and it must confirm against
   the exact frames, not free-associate.
4. **A hard ceiling on top.** `answer_token_budget` (default 8000) caps the
   whole ladder per question. When the cap vetoes a step, the answer is
   flagged `budget_stopped` instead of silently degrading.
5. **Repeats are free.** A semantic answer cache returns previous answers
   for questions within `answer_cache_similarity` (0.92 cosine) at zero
   model cost, marked `cached: true`. A lifetime savings meter
   (`watch-skill stats`, MCP `stats`) tracks estimated tokens saved vs
   naively injecting every indexed frame per question.
6. **Refusal is cheaper than fabrication.** The honest floor costs almost
   nothing and preserves the only budget that never refills: trust.

The result is *calibrated* cheapness: answers are cheap because the system
knows when it is sure, and it spends — bounded, cheapest-first — exactly
when it is not.

## The lessons loop (self-improvement as data)

`report_mistake` (MCP tool, `watch-skill lessons add`, REST) turns a wrong
answer + correction into a classified lesson in `<data_dir>/lessons.db` —
local, never uploaded. Classification is transparent heuristics
(missed-ocr, wrong-timestamp, hallucination, language, sampling-miss) over
the report's own wording. Where the fix is mechanical, the original
question is immediately re-asked with the lesson injected and marked
*validated* when the correction's terms now surface. Lessons aggregate into
adaptive per-content-type profiles (data, not code) that tune the answer
engine — confidence bumps, resample width/resolution, escalation order —
and every lesson exports as a replayable eval case (`watch-skill evals
run`) so the pass rate over time measures whether the system actually
learns.

## THE LOOP (self-verification)

`loop/` closes the loop for agents that produce visual output: **capture**
(Playwright browser session with optional interaction script, screen or
window via ffmpeg gdigrab, or adopt an existing file) → **watch** the
recording → **critic** (strong vision tier, structured JSON verdict with
per-issue timestamps, severities, and suggested fixes against
natural-language pass criteria) → the *agent* applies fixes in code →
**iterate**: re-capture the same target with the same script, re-critique,
and phash-align frames to diff fixed/unchanged/new issues. Stop conditions:
pass, `max_iterations`, or two iterations without score progress. On pass
with ≥2 iterations it renders a before/after MP4+GIF proof artifact. Every
iteration persists under `<data_dir>/loops/<loop_id>/`.

The runner is a **pluggable framework** (`loop/framework.py`): a
loop type is a registry entry deciding only how the recording for an
iteration is produced. Built-ins: `ui` (the original), `video-gen` (run a
generator command, adopt the video it writes), and `game` (optionally launch
a process, record its window/canvas). `loop/monitor.py` adds the
differently-shaped **monitor loop**: a bounded watch over a folder or live
target that emits a structured event (`events.jsonl` + `on_event` callback —
the v0.8 webhook seam) when a described condition appears.

The critic itself degrades gracefully (`loop/critic.py`): capable models get
the strict-JSON critique; small captioning models (a low-RAM box running
moondream) automatically fall back to **describe-then-judge** — the model
describes each frame, deterministic rules parsed from the criteria decide
("never X" terms fail a frame; "(like $29.00)" exemplar shapes pass the
recording; digit-generalized, whitespace-tolerant, negation-aware), and a
plain PASS/FAIL text judgment covers only what no rule can express.

## Module map

| Module | Job | Key entry points |
|--------|-----|------------------|
| `acquire/` | any source → local file; self-healing fallback chain; LRU cache | `acquire()`, `fetch_captions_only()` |
| `perceive/` | scenes → budgeted frame selection → phash dedup → OCR: backend registry (rapidocr default, tesseract for its reading gap, surya opt-in) + per-region multi-script router | `perceive()`, `ocr_frame()`, `ocr_frame_multiscript()` |
| `transcribe/` | captions (original language first) → local whisper → opt-in cloud; diarization contract | `get_transcript()` |
| `index/` | schema-versioned SQLite (v7); FTS5 (normalization-folded) + local embeddings (opt-in model upgrade, pinned per index); hybrid retrieval | `index_watch_result()`, `search_videos()`, `get_moment()` |
| `library/` | notes layer: per-video distillation (entities/claims/chapters w/ provenance, incremental) → cross-video synthesis with citations, honest floor, stamped cache | `distill_notes()`, `library_synthesize()`, `library_overview()` |
| `answer/` | self-healing asks: confidence → escalation ladder → verify (per THE COST POLICY) → honest floor; semantic answer cache; cost meter v2 (spend by source + $) | `answer_question()` → `Answer` |
| `lessons/` | mistake reports → classified lessons → prompt injection, adaptive profiles; eval replay + classification (still-effective/prunable/regressed) + prune | `report_mistake()`, `relevant_guidance()`, `eval_report()`, `prune_lessons()` |
| `vision/` | one `prompt+images→text` primitive across Anthropic/OpenAI/Gemini/OpenRouter/Ollama; cheap/strong tiers; pre-call cost guard (dated prices.json); local-server health: liveness cache, detached restart, structured `vision.server_down` | `get_vision(tier)`, `ensure_ollama()` |
| `loop/` | pluggable loop framework: producers (ui/video-gen/game) → critic (JSON or describe-then-judge) → phash diff → runner → proof artifact; bounded monitor loop w/ events.jsonl + signed webhooks | `loop_start()`, `loop_iterate()`, `loop_monitor()`, `deliver_event()` |
| `bench/` | benchmarks with receipts: perception char-hit/latency/RSS over committed fixtures | `bench_perception()` |
| `health/` | doctor --fix (deps, browser recording, memory headroom, index integrity, model files, local vision), managed binaries, agent config writer, provider-neutral vision setup | `run_doctor()`, `detect_agents()`, `configure_cloud()`, `configure_ollama()` |
| `integrations/` | thin framework adapters (LangChain/CrewAI/Agents SDK/LlamaIndex/AutoGen) over three shared core calls | `get_watch_tools()` per module |
| `extract/` | deterministic structured extraction over the index: chapters, bug reports, hook analysis | `extract_chapters()`, `extract_bug_report()`, `analyze_hook()` |
| `batch.py` | playlist/folder/list → one indexed, cross-searchable memory; per-source resilience | `watch_batch()` |
| `viewer.py` | one self-contained offline HTML page per analysis (frames inlined, evidence cited) | `generate_viewer()` |
| `jobs.py` | thread-backed background jobs for long operations (MCP `background=true`) | `start_job()`, `get_job()` |
| `watch.py` | the front door: acquire → perceive → transcribe with progress callbacks | `watch()` |
| `config.py` | one typed settings object; `WATCHSKILL_*` env / `.env` / defaults | `get_settings()` |

The agent-facing layer above all of this is `adapters/claude-skill/skills/`
— ten portable `SKILL.md` trigger surfaces (`watch` plus nine task skills) that
wrap the CLI only, so they ride into any harness that reads skills; the
engine never knows which agent is calling.

## How to add a vision provider (in ~20 lines)

1. `vision/registry.py` — add a `ProviderSpec` (endpoint, key setting name,
   price) to `PROVIDERS`, plus any model prices to `vision/prices.json`
   (a dated data file — move its `as_of` with every edit).
2. `config.py` — add the `<name>_api_key: SecretStr | None` field.
3. `vision/client.py` — if the wire format is OpenAI-compatible, reuse
   `_openai_request` like OpenRouter does (3 lines); otherwise write a
   `_<name>_request` / `_<name>_extract` pair and register it in `_BUILDERS`.
4. Add a wire-format test in `tests/test_vision.py` (mock `httpx.post`,
   assert URL/headers/body — see `test_openrouter_wire_format`).

Done — both tiers, the cost guard, the critic, and scene descriptions can
now use it via config alone.

## How to add a new Loop type

A loop type is a **producer** — one function deciding how the recording for
an iteration is made. Everything else is inherited.

1. Producer: write `def _produce_<kind>(state, iter_dir) -> CaptureResult`
   in `loop/framework.py` (see `_produce_video_gen` for a ~40-line example)
   and register it: `register_loop_type(LoopType("<kind>", _produce_<kind>,
   "one-line description"))`. Per-type parameters travel in `state.extra`.
2. Starter: add a `loop_<kind>(...)` wrapper in `loop/runner.py` that builds
   the `LoopState` (loop_type + extra) and calls `_start()` — then expose it
   as an MCP tool/CLI command.
3. Criteria: nothing to code — pass criteria are natural language, and the
   describe-then-judge rules (`never X`, `(like Y)` exemplars) come free.
4. The runner, `loop_iterate`, persistence, stop conditions, diffing, and
   proof artifacts all work unchanged for the new type.

## Data on disk

```
~/.watch-skill/
├── bin/          managed binaries (ffmpeg fallback, yt-dlp, deno)
├── cache/        downloads keyed by source hash (LRU, size-capped)
├── frames/       indexed videos' kept frames (persist across sessions)
│   └── <id>/escalation/   high-res frames recovered by the answer ladder
├── index.db      SQLite: videos, segments, scenes, ocr_blocks, embeddings,
│                 fts, answers (semantic answer cache), notes + notes_fts
│                 (the library layer), library_answers (synthesis cache)
├── lessons.db    lessons and adaptive profiles
├── evals/        replayable eval cases exported from lessons
├── loops/<id>/   every loop iteration: video, frames, critique, diff, proof
│   └── monitor_<id>/events.jsonl   structured monitor events (webhook twin)
├── models/ocr/   per-script OCR recognition models
└── health.jsonl  incident log (breakages, self-heals, bootstraps)
```
