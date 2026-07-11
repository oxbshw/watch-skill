# Configuration

Every knob in Watch Skill, in one place. There are three layers:

1. **Environment variables / `.env`** — every field of the typed settings
   object (`src/watch_skill/config.py`) is settable as an environment
   variable with the `WATCHSKILL_` prefix, or as a line in a `.env` file in
   the directory the process starts from.
2. **CLI flags** — per-invocation overrides on `watch-skill` subcommands.
3. **Defaults** — sensible for an 8 GB-RAM machine with no GPU and no API
   keys.

**Precedence (highest wins):** CLI flag > process environment > `.env` in
the current working directory > default.

Example — three ways to set the extracted frame width to 1024 px:

```bash
watch-skill watch video.mp4 --resolution 1024        # this run only
WATCHSKILL_FRAME_WIDTH=1024 watch-skill watch video.mp4
echo "WATCHSKILL_FRAME_WIDTH=1024" >> .env           # every run from this directory
```

Secrets (`SecretStr` fields) are never logged and never appear in error
payloads.

## Environment variables

### Storage

| Variable | Type | Default | Effect |
|---|---|---|---|
| `WATCHSKILL_DATA_DIR` | path | `~/.watch-skill` | Root for the cache, index, frames, loops, lessons, health log, and managed binaries. A pre-rename `~/.agentvision/` dir is migrated here automatically once (only when this is left at its default). |
| `WATCHSKILL_BIN_DIR` | path | `<data_dir>/bin` | Where managed portable binaries (ffmpeg, yt-dlp, deno) are bootstrapped. Binaries here are preferred over PATH so a self-healing update controls what actually runs. |
| `WATCHSKILL_CACHE_MAX_BYTES` | int | `21474836480` (20 GiB) | Download-cache size cap; least-recently-used entries are evicted beyond it. |

Derived paths (not directly settable — they follow `data_dir`):
`<data_dir>/cache` (downloads), `<data_dir>/index.db` (SQLite index),
`<data_dir>/frames` (kept frames), `<data_dir>/loops` (loop iterations),
`<data_dir>/lessons.db` (lessons store), `<data_dir>/evals` (exported eval
cases), `<data_dir>/health.jsonl` (incident log),
`<data_dir>/models/ocr` (per-script OCR models).

### Perception

| Variable | Type | Default | Effect |
|---|---|---|---|
| `WATCHSKILL_FRAME_WIDTH` | int | `512` | Extracted frame width in pixels. Higher = sharper OCR, more tokens per frame if sent to a vision model. |
| `WATCHSKILL_FRAME_CAP` | int | `100` | Hard cap on frames per analysis, regardless of duration. |
| `WATCHSKILL_MAX_FPS` | float | `2.0` | Universal sampling-rate ceiling; even focused mode never samples denser than this. |
| `WATCHSKILL_PHASH_DISTANCE` | int | `6` | Max Hamming distance between perceptual hashes for two frames to count as near-duplicates (and be deduplicated). Lower = keep more similar frames. |
| `WATCHSKILL_OCR_ENABLED` | bool | `true` | Run OCR on kept frames. Per-script recognition models (Arabic, Cyrillic, Korean, …) auto-download on first use. |

### Transcription

| Variable | Type | Default | Effect |
|---|---|---|---|
| `WATCHSKILL_SUBTITLE_LANGS` | str | `en.*` | yt-dlp `--sub-langs` pattern for platform captions. The video's original-language track is fetched and preferred over auto-translations regardless of this pattern. |
| `WATCHSKILL_LOCAL_WHISPER_ENABLED` | bool | `true` | Use local faster-whisper as the fallback when a video has no captions. |
| `WATCHSKILL_WHISPER_MODEL` | str | `auto` | faster-whisper model size (`tiny` … `large-v3`). `auto` picks by available RAM/VRAM. |
| `WATCHSKILL_CLOUD_STT_ENABLED` | bool | `false` | **Opt-in** cloud speech-to-text. Only extracted mono-16kHz audio may be sent, never the video file (enforced by tests). |
| `WATCHSKILL_DIARIZATION_ENABLED` | bool | `false` | Label transcript segments by speaker. Needs the `diarize` extra (pyannote, torch) plus a Hugging Face token. |
| `WATCHSKILL_HUGGINGFACE_TOKEN` | secret | unset | Hugging Face token for the gated pyannote diarization models. Accept the model terms on hf.co first. |

### API keys and vision providers

All keys are optional. With none set, Watch Skill runs local-only: captions,
local Whisper, local OCR, local embeddings. Vision-dependent features (scene
descriptions, the answer verify pass, THE LOOP's critic) need at least one
provider — cloud or a local Ollama.

| Variable | Type | Default | Effect |
|---|---|---|---|
| `WATCHSKILL_ANTHROPIC_API_KEY` | secret | unset | Anthropic API key (vision tiers). |
| `WATCHSKILL_OPENAI_API_KEY` | secret | unset | OpenAI API key (vision tiers; also a cloud-STT backend). |
| `WATCHSKILL_GEMINI_API_KEY` | secret | unset | Google Gemini API key (vision tiers). |
| `WATCHSKILL_GROQ_API_KEY` | secret | unset | Groq API key (preferred cloud-STT backend when cloud STT is opted in). |
| `WATCHSKILL_OPENROUTER_API_KEY` | secret | unset | OpenRouter API key — one key routes to many vision models, including `:free` variants. |
| `WATCHSKILL_OLLAMA_BASE_URL` | str | `http://127.0.0.1:11434` | Base URL of a local (or remote) Ollama server. Keyless. |
| `WATCHSKILL_VISION_CHEAP_PROVIDER` | str | `anthropic` | Provider for bulk work: scene descriptions, first verify pass. One of `anthropic`, `openai`, `gemini`, `openrouter`, `ollama`. |
| `WATCHSKILL_VISION_CHEAP_MODEL` | str | `claude-haiku-4-5-20251001` | Model for the cheap tier. |
| `WATCHSKILL_VISION_STRONG_PROVIDER` | str | `anthropic` | Provider for final answers, low-confidence verification, and the loop critic. |
| `WATCHSKILL_VISION_STRONG_MODEL` | str | `claude-sonnet-5` | Model for the strong tier. |
| `WATCHSKILL_COST_CEILING_USD` | float | `1.0` | Pre-call cost guard: a single cloud vision call whose estimated cost exceeds this raises `vision.cost_ceiling` instead of running. |
| `WATCHSKILL_COST_POLICY` | str | `cheapest` | Which model tiers a verify pass may touch: `cheapest` (cheapest path that clears confidence), `quality_first` (straight to the strong tier), `offline_only` (keyless/local providers only — cloud never sees a frame). See [cost.md](cost.md). |
| `WATCHSKILL_OCR_BACKEND` | str | `auto` | `auto` = RapidOCR, with tesseract auto-routed ONLY for scripts RapidOCR cannot read (Lao/Khmer/Myanmar/Tibetan). Force `rapidocr`/`tesseract`/`surya` to override; surya is opt-in only — its models want more RAM than an 8 GB box has. |
| `WATCHSKILL_EMBEDDING_MODEL` | str | unset | Opt-in retrieval upgrade for NEW indexes: any fastembed model, e.g. `BAAI/bge-m3` or `intfloat/multilingual-e5-large`. Existing indexes keep the model pinned in their meta (vectors from two models never mix). The big models cost ~2 GB+ RAM at query time — skip this on 8 GB machines. |
| `WATCHSKILL_VISION_BATCH_SIZE` | int | `8` | Frames per `describe_frames` call. Use 2–4 for small local models — large image batches overflow their context. |
| `WATCHSKILL_VISION_TIMEOUT_SECONDS` | float | `180.0` | HTTP timeout for cloud vision calls. |
| `WATCHSKILL_VISION_LOCAL_TIMEOUT_SECONDS` | float | `900.0` | Timeout for local (Ollama) vision calls — CPU model loads can take minutes. |
| `WATCHSKILL_CRITIC_FRAME_CAP` | int | `10` | Max frames sent to the loop critic in one call. Use 4 for local models. |

### Self-healing answers

| Variable | Type | Default | Effect |
|---|---|---|---|
| `WATCHSKILL_ANSWER_CONFIDENCE_FLOOR` | float | `0.35` | Below this after the full escalation ladder, the answer states plainly that the video does not clearly show it (the honest floor). |
| `WATCHSKILL_ANSWER_CONFIDENCE_TARGET` | float | `0.6` | Escalation stops as soon as confidence clears this bar. |
| `WATCHSKILL_ANSWER_VERIFY_ENABLED` | bool | `true` | When a vision provider is configured, show the model the exact frames it is about to cite and require confirmation before answering. Degrades gracefully (model-free answers) when no provider is reachable. |
| `WATCHSKILL_ANSWER_TOKEN_BUDGET` | int | `8000` | Per-question token ceiling; the escalation ladder stops (and the answer says `budget_stopped`) rather than exceed it. |
| `WATCHSKILL_ANSWER_RESAMPLE_WIDTH` | float | `8.0` | Window in seconds around a candidate timestamp for the dense re-sampling escalation step. |
| `WATCHSKILL_ANSWER_RESAMPLE_RESOLUTION` | int | `1024` | Frame width in px for escalation re-sampling — higher than the indexing default so zoom crops have pixels to work with. |
| `WATCHSKILL_ANSWER_CACHE_ENABLED` | bool | `true` | Semantic answer cache, per video. Repeat questions return the cached answer at zero model cost. |
| `WATCHSKILL_ANSWER_CACHE_SIMILARITY` | float | `0.92` | Cosine similarity above which a cached question counts as a repeat. |
| `WATCHSKILL_LESSONS_ENABLED` | bool | `true` | Local lessons store: learn from reported mistakes and inject relevant guidance into future asks. Never uploaded anywhere. |
| `WATCHSKILL_LESSONS_INJECTION_TOKEN_CAP` | int | `300` | Max prompt tokens the injected "learned corrections" section may consume. |
| `WATCHSKILL_LESSONS_MAX_COUNT` | int | `500` | Global cap on stored lessons; least-recently-used are pruned. |

### Surfaces

| Variable | Type | Default | Effect |
|---|---|---|---|
| `WATCHSKILL_RESPONSE_FRAME_CAP` | int | `12` | Max image blocks per MCP or REST response (frames beyond the cap are evenly sampled, first and last kept). |
| `WATCHSKILL_API_BEARER_TOKEN` | secret | unset | Bearer token for the REST API. Unset = local only: the API refuses to bind to a non-loopback host without it (`config.public_bind_no_token`). |

### Read outside the settings object

| Variable | Type | Default | Effect |
|---|---|---|---|
| `WATCHSKILL_COBALT_API_URL` | str | unset | URL of a **self-hosted** cobalt instance to use as an acquisition fallback between yt-dlp and direct ffmpeg. The public api.cobalt.tools requires auth and is never used; without this variable the cobalt step is skipped entirely. Read from the process environment only (not `.env`). |
| `WATCHSKILL_HOME` | path | `~/watch-skill` | **Installer-only** (`scripts/install.sh`): where the macOS/Linux one-liner clones the repo. Not read by the engine. |

Boolean variables accept the usual pydantic forms: `1/0`, `true/false`,
`yes/no` (case-insensitive).

## CLI flags

Global shape: `watch-skill [COMMAND] [ARGS] [OPTIONS]`. Progress goes to
stderr and results to stdout, so output pipes cleanly. Verified against
`uv run watch-skill <command> --help` for every command below.

### `watch-skill watch SOURCE [QUESTION]`

Watch a video: acquire → scenes → frames → OCR → transcript → report.
`SOURCE` is a URL (any of yt-dlp's 1800+ sites), a direct media URL, an
HLS/DASH manifest, or a local path. `QUESTION` is optional and echoed into
the output for the calling agent.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--start` | time (`SS`, `MM:SS`, `HH:MM:SS`) | none | Range start; with `--end`, switches to the denser focused-mode frame budget. |
| `--end` | time | none | Range end. |
| `--max-frames` | int | config `frame_cap` (100) | Override the frame cap for this run. |
| `--resolution` | int | config `frame_width` (512) | Frame width in px. |
| `--timestamps` | comma-separated times | none | Pin frames at exact absolute times, in addition to scene sampling. |
| `--transcript-only` | flag | off | Skip frame extraction entirely; captions-first fast path. |
| `--no-ocr` | flag | off | Skip the OCR pass. |
| `--no-whisper` | flag | off | Disable the local Whisper fallback (captions only). |
| `--cloud-stt` | flag | off | Opt in to cloud STT for extracted audio, this run only. |
| `--whisper-model` | str | config `whisper_model` (`auto`) | faster-whisper size (`tiny` … `large-v3`). |
| `--diarize` | flag | off | Label transcript by speaker (needs the `diarize` extra + HF token). |
| `--duration` | float | none | Bound live-stream capture to N seconds. |
| `--out-dir` | path | temp dir | Working directory for intermediate files. |
| `--no-cache` | flag | off | Bypass the download cache. |
| `--index/--no-index` | flag | `--index` | Persist the result to the searchable index (enables `ask`/`search` later). |

### `watch-skill ask VIDEO QUESTION`

Ask an already-indexed video a question (self-healing answer engine).
`VIDEO` is a video_id or the original source URL/path.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--max-frames` | int | `6` | Max evidence frame paths listed. |
| `--frames` | flag | off | Always list evidence frame paths (default: only when the engine is uncertain). |
| `--no-verify` | flag | off | Skip the model verify pass. |
| `--no-cache` | flag | off | Bypass the semantic answer cache. |

### `watch-skill serve`

Run the MCP server.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--http` | flag | off | Streamable HTTP transport instead of stdio (endpoint `/mcp`). |
| `--host` | str | `127.0.0.1` | Bind host (HTTP mode). |
| `--port` | int | `8747` | Bind port (HTTP mode). |

### `watch-skill api`

Run the REST API (FastAPI; OpenAPI spec at `/openapi.json`).

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--host` | str | `127.0.0.1` | Bind host. Non-loopback binds require `WATCHSKILL_API_BEARER_TOKEN`. |
| `--port` | int | `8748` | Bind port. |

### `watch-skill doctor`

Check (and self-heal) dependencies: ffmpeg, yt-dlp, deno, disk, GPU, API keys.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--fix/--no-fix` | flag | `--fix` | Auto-remediate fixable issues (install ffmpeg/yt-dlp/deno, self-update stale yt-dlp). |
| `--json` | flag | off | Emit machine-readable JSON to stdout. Exit code 1 when any check fails. |

### `watch-skill forget VIDEO`

Remove one video from the index: its rows, cached answers, and frames
directory. `VIDEO` is a video_id or the original source. No flags.

### `watch-skill stats`

Print lifetime answer count and estimated tokens saved vs raw-frame
injection. No flags.

### `watch-skill list`

List indexed videos (`id  duration  title`). No flags.

### `watch-skill search QUERY`

Hybrid keyword + semantic search across every indexed video; prints
timestamped hits grouped by video. No flags.

### `watch-skill capture TARGET`

Record a URL session (headless browser), the screen (`screen:`), a window
(`window:<exact title>`), or adopt an existing video file.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--duration` | float | `10.0` | Recording length in seconds. |
| `--script` | JSON string | none | Interaction script: a JSON list of steps (`goto`/`click`/`fill`/`scroll`/`wait`) executed in the browser session. |
| `--out-dir` | path | temp dir | Where the recording lands. |

### `watch-skill loop start TARGET PASS_CRITERIA`

Capture + critique the first loop iteration; prints `loop_id` and
structured issues. Requires a vision provider (the critic is a model call).

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--script` | JSON string | none | Same interaction-script format as `capture`. |
| `--max-iterations` | int | `5` | Stop condition. |
| `--duration` | float | `8.0` | Recording length per iteration in seconds. |

### `watch-skill loop iterate LOOP_ID`

Re-capture + re-critique after you applied fixes; diffs against the previous
iteration. No flags.

### `watch-skill loop status LOOP_ID`

Show a loop's persisted state and score history. No flags.

### `watch-skill setup`

Detect installed AI agents (Claude Code, Claude Desktop, Cursor, Codex CLI,
Windsurf, Gemini CLI, …) and write the MCP config into each one, backing up
any existing file first.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--yes`, `-y` | flag | off | Configure all detected agents without prompting. |
| `--only` | str | all detected | Comma list of agent keys to restrict to (e.g. `cursor,codex`). |

### `watch-skill clean`

Reclaim disk: bounded cache, bounded loop archives, orphaned frames.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--cache` | flag | off | Evict the download cache down to its size cap. |
| `--all-cache` | flag | off | Empty the download cache entirely. |
| `--loops` | flag | off | Keep only the most recent loops. |
| `--keep-loops` | int | `10` | How many recent loops `--loops` keeps. |
| `--orphans` | flag | off | Remove frame dirs for videos no longer in the index. |
| `--cache-answers` | flag | off | Clear the semantic answer cache. |
| `--all` | flag | off | Shorthand for `--cache --loops --orphans`. |
| `--dry-run` | flag | off | Report what would be freed; delete nothing. |

### `watch-skill lessons add VIDEO QUESTION WRONG CORRECTION`

Report a wrong answer + its correction; the system classifies it, stores a
lesson, and (for mechanical error classes) immediately re-asks the question
to validate that the lesson works.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--session` | str | none | Session id to group the lesson under (bulk-removable later). |
| `--no-reask` | flag | off | Skip the immediate re-ask validation. |

### `watch-skill lessons list`

List stored lessons, newest first (`[✓]` marks validated ones).

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--session` | str | none | Filter to one session. |
| `--limit` | int | `20` | Max rows. |

### `watch-skill lessons rm [IDS]...`

Remove lessons by id, or a whole session.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--session` | str | none | Remove every lesson in this session. |

### `watch-skill lessons export-evals`

Convert every lesson into a replayable eval case under `<data_dir>/evals`.
No flags.

### `watch-skill evals run`

Replay the lesson-derived eval suite against the current system and print
the pass rate. No flags.

### `watch-skill profiles show`

Show the active adaptive per-content-type profiles (data aggregated from
lesson statistics, not code). No flags.

### `watch-skill profiles reset`

Drop all adaptive profiles (the lessons themselves stay). No flags.

### `watch-skill version`

Print the Watch Skill version. No flags.

## MCP tool parameters

The MCP tools accept per-call parameters (`budget`, `max_frames`,
`include_frames`, `verify`, `window`, …) that override the same settings for
one call. They are documented per tool in [tools/README.md](tools/README.md).
