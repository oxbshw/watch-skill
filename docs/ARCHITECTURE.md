# Architecture

```
              ┌────────────────────────────────────────────────┐
 any agent ──►│  surfaces/  (thin; never contain logic)        │
              │   mcp_server (stdio+HTTP) · cli · api (REST)   │
              └───────────────┬────────────────────────────────┘
                              ▼
              ┌────────────────────────────────────────────────┐
              │  core/watch_skill  (all logic lives here)      │
              │                                                │
              │  acquire ──► perceive ──► transcribe ──► index │
              │     │            │             │           ▲   │
              │  health       vision ◄─────────┴───────────┘   │
              │  (doctor)     (cheap/strong tiers)             │
              │                     ▲                          │
              │        loop: capture → critic → diff → runner  │
              └────────────────────────────────────────────────┘
```

Rule #1: `core/` never imports `surfaces/`. Surfaces render; core computes.

## Module map

| Module | Job | Key entry points |
|--------|-----|------------------|
| `acquire/` | any source → local file; self-healing fallback chain (yt-dlp → self-update → cobalt → direct ffmpeg); LRU cache | `acquire()`, `fetch_captions_only()` |
| `perceive/` | scenes → budgeted frame selection → phash dedup → OCR (per-script models) | `perceive()` → `PerceptionResult` |
| `transcribe/` | captions (original language first) → local whisper (windowed) → opt-in cloud; diarization contract | `get_transcript()` |
| `index/` | schema-versioned SQLite; FTS5 (Arabic-normalized) + local embeddings; hybrid retrieval | `index_watch_result()`, `ask_video()`, `search_videos()`, `get_moment()` |
| `answer/` | self-healing asks: confidence scoring → escalation ladder → verify pass → honest floor; semantic answer cache; savings meter | `answer_question()` → `Answer` |
| `lessons/` | local self-improve store: mistake reports → classified lessons → prompt injection, evals, adaptive profiles | `report_mistake()`, `relevant_guidance()`, `run_evals()` |
| `vision/` | one `prompt+images→text` primitive across Anthropic/OpenAI/Gemini/OpenRouter/Ollama; tiers; cost guard | `get_vision(tier)` |
| `loop/` | capture (Playwright/gdigrab) → JSON critic → phash diff → iteration runner → proof artifact | `loop_start()`, `loop_iterate()` |
| `health/` | doctor (self-healing deps), managed binaries, agent config writer | `run_doctor()`, `detect_agents()` |
| `jobs.py` | thread-backed background jobs for long operations | `start_job()`, `get_job()` |
| `watch.py` | the front door: acquire → perceive → transcribe with progress callbacks | `watch()` |

Errors are structured everywhere: raise `WatchSkillError` subclasses with a
stable `code`, human `message`, and actionable `fix`.

## The accuracy/economy tension (and how the ladder reconciles it)

System truth: accuracy wants to spend tokens (look again, look closer, ask
a stronger model) and the token economy wants to save them (text-first,
cache, tight descriptions). Both live in `answer/engine.py`, reconciled by
ordering and a hard ceiling:

1. **Free first.** Retrieval + confidence scoring cost no model tokens.
   A confident answer ships as pure text — the cheapest possible response.
2. **Compute before tokens.** The first escalation steps (dense high-res
   re-sampling, zoom-crop re-OCR) burn only local CPU; whatever they recover
   is indexed permanently, so the spend amortizes across every future ask.
3. **Tokens only on genuine uncertainty.** The model verify pass runs
   cheap-tier first, strong-tier only when confidence is still low — and the
   model must *confirm against the exact frames*, not free-associate.
4. **A hard ceiling on top.** `answer_token_budget` caps the whole ladder;
   when the cap vetoes a step the answer says so (`budget_stopped`) instead
   of silently degrading.
5. **Refusal is cheaper than fabrication.** The honest floor costs almost
   nothing and preserves the only budget that never refills: trust.

## How to add a vision provider (in ~20 lines)

1. `vision/registry.py` — add a `ProviderSpec` (endpoint, key setting name,
   price) to `PROVIDERS`, plus any model prices to `MODEL_PRICES`.
2. `config.py` — add the `<name>_api_key: SecretStr | None` field.
3. `vision/client.py` — if the wire format is OpenAI-compatible, reuse
   `_openai_request` like OpenRouter does (3 lines); otherwise write a
   `_<name>_request` / `_<name>_extract` pair and register it in `_BUILDERS`.
4. Add a wire-format test in `tests/test_vision.py` (mock `httpx.post`,
   assert URL/headers/body — see `test_openrouter_wire_format`).

Done — both tiers, the cost guard, the critic, and scene descriptions can
now use it via config alone.

## How to add a new Loop type

A loop type is: a **capture recipe** + a **criteria preset** + (optionally)
a custom differ.

1. Capture: add a `capture_<kind>()` to `loop/capture.py` returning a
   `CaptureResult`, and teach the `capture()` dispatcher its target prefix
   (e.g. `game:`, `gen:`).
2. Criteria: nothing to code — pass criteria are natural language. Ship a
   preset prompt in your surface/docs if the domain needs one.
3. Diff: `loop/diff.py` aligns same-script recordings by phash. If your
   domain needs a different alignment (e.g. semantic scene matching), add a
   strategy function and select it from `runner._run_iteration`.
4. The runner, persistence, stop conditions, and proof artifacts are
   inherited for free.

## Data on disk

```
~/.watch-skill/
├── bin/          managed binaries (ffmpeg fallback, yt-dlp, deno)
├── cache/        downloads keyed by source hash (LRU, size-capped)
├── frames/       indexed videos' kept frames (persist across sessions)
├── index.db      SQLite: videos, segments, scenes, ocr_blocks, embeddings, fts
├── loops/<id>/   every loop iteration: video, frames, critique, diff, proof
├── models/ocr/   per-script OCR recognition models
└── health.jsonl  incident log (breakages, self-heals, bootstraps)
```
