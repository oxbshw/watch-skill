# Architecture & dependency decisions

A running log of non-obvious choices, especially Windows-driven dependency
swaps. Newest entries at the bottom of each section.

## Layout

- **Monorepo with `core/` never importing `surfaces/`.** Enforced by review
  and a unit test (import-graph check planned). Surfaces are thin wrappers.
- **Hatchling multi-package wheel**: `core/agentvision` and `surfaces` both
  ship in the `agentvision` distribution. One install gives the SDK, the CLI,
  the MCP server, and the REST app.

## Environment

- **Python 3.11 pinned for the dev venv** (`.python-version`). The machine's
  default Python is 3.14, but the heavy native deps (onnxruntime for
  RapidOCR, CTranslate2 for faster-whisper, torch for sentence-transformers)
  publish wheels for 3.11/3.12 first. `requires-python = ">=3.11"` stays
  permissive; the venv stays conservative.
- **uv** for env + lockfile (available on this machine; pip+venv documented
  as fallback in README).

## Self-managed binaries

- **Managed bin dir defaults to `~/.agentvision/bin`, not the repo `bin/`.**
  The package must bootstrap itself when installed from PyPI too, where there
  is no repo checkout. A repo-local `bin/` (gitignored) is still honored when
  present — set `AGENTVISION_BIN_DIR` or drop binaries there manually.
  Lookup order: managed bin dir first, then PATH — so a self-healing update
  controls the binary actually used even when a stale system copy exists.
- **yt-dlp**: bootstrapped as the standalone `yt-dlp.exe` from GitHub
  releases (not pip) so `yt-dlp -U` self-update works without touching the
  Python environment.
- **ffmpeg**: winget (`Gyan.FFmpeg`) → choco → portable
  `ffmpeg-release-essentials` zip from gyan.dev extracted into the managed
  bin dir. All three paths are implemented; the zip path guarantees a clean
  machine with only Python still works.

## Windows-friendly dependency swaps

- **OCR: RapidOCR (onnxruntime) instead of Tesseract/pytesseract.** Tesseract
  needs a system installer on Windows; RapidOCR is a pure `pip install` with
  bundled ONNX models.
- **OpenCV: `opencv-python-headless`** — PySceneDetect needs cv2; headless
  avoids GUI DLL baggage on servers/CI.
- **Whisper: faster-whisper (CTranslate2)** — prebuilt Windows wheels, no
  Rust/C++ toolchain needed, CPU-friendly with int8.
- **Embeddings: fastembed (ONNX) instead of sentence-transformers.** The
  plan called for sentence-transformers, but it drags in torch (~2 GB
  installed); this machine has <7 GB free disk total across drives, so the
  install would fail outright. fastembed serves the same MiniLM-class models
  (`sentence-transformers/all-MiniLM-L6-v2`) through onnxruntime, which the
  OCR stack already installs. Same vectors, ~50 MB instead of ~2 GB.

## Reference-inherited defaults (see docs/REFERENCE_ANALYSIS.md)

- Frame width 512 px, hard cap 100 frames, 2 fps max, duration-tiered
  budgets, focused-mode denser tiers.
- Captions → local whisper → cloud (opt-in) transcription ladder.
- Privacy invariants as hard rules with tests: the video file never leaves
  the machine; no cookies/logins; only extracted mono-16kHz audio may go to a
  cloud STT API, and only when the user explicitly enabled cloud STT.

## Milestone 4

- **REST error mapping is prefix-based.** `acquire.*`/`vision.*`/`transcribe.*`
  → 502 (upstream), `perceive.*`/`loop.*` → 422, `index.*`/`*.not_found` → 404,
  `config.*` → 400. The structured `{error, message, fix, details}` body is
  preserved verbatim in `detail` so REST agents get the same actionable
  errors as MCP agents.
- **The REST API refuses non-loopback binds without a bearer token**
  (`config.public_bind_no_token`). Safe-by-default beats convenient-by-default
  for a server that can read local files.
- **`diarize` extra is NOT part of `all`.** pyannote pulls torch (~2 GB) and
  needs a gated Hugging Face model; forcing that on every `[all]` install
  would wreck the "clean machine, only Python" bootstrap story. Diarization
  degrades loudly-but-gracefully: transcript comes back unlabeled with a
  structured hint on stderr. The speaker-assignment logic is a pure function
  over a `SpeakerTurn` contract, so it is fully tested without torch.
- **Claude Skill adapter is instructions-only.** Unlike the reference (which
  bundles scripts), our SKILL.md shells into the installed `agentvision` CLI —
  one engine, no drift between skill and core. The trade-off (the package must
  be installed) is handled by the skill's Step 0 (`pip install agentvision`).
- **Demo GIF is committed** (`docs/assets/loop_before_after.gif`, ~140 KB) —
  it is our own generated artifact from the M3 acceptance demo, and the README
  needs it to communicate THE LOOP in three seconds.

## Phase 1 — live golden-path findings (v1.0 hardening)

- **OpenRouter added as a first-class provider.** OpenAI-compatible wire
  format with attribution headers; `:free` model variants get a 0.0 price in
  the cost guard. Chosen because one key routes to every major vision model.
- **Original-language captions beat auto-translations.** Live bug: an Arabic
  video yielded ENGLISH auto-translated captions because the default
  `sub-langs en.*` matched the translation track. Fix: read `language` from
  the info.json, fetch the original track when missing, and prefer it in
  subtitle picking. The "transcript" a user gets is now what is actually
  said, not a machine translation of it.
- **Arabic FTS was byte-exact.** unicode61 gives no Arabic folding: hamza
  variants, alef maqsura, ta marbuta, and diacritics all broke matching.
  Fix: `text_norm` shadow column (migration v2) + the same folding applied
  to queries. Display text is never modified.
- **Arabic OCR needs a script-specific model.** The bundled RapidOCR ch/en
  models produce garbage on Arabic. Fix: managed per-script rec models
  (downloaded once into `<data_dir>/models/ocr/`), auto-selected from the
  video's detected language. Verified live on real Arabic frames
  ("ماهي البرمجة" @ 0.97 confidence).
- **Local vision needs its own timeout + tiny batches.** Ollama CPU model
  loads take minutes (8 GB RAM machine): separate
  `vision_local_timeout_seconds` (900s) and `vision_batch_size` (2-4 for
  small local models; 24-image prompts overflow their context).
- **Scene descriptions must never sink a watch.** A crash inside the
  opportunistic describe step aborted the pipeline after all the heavy work;
  it now catches everything, logs, and degrades to no-descriptions.
- **On 8 GB RAM, vision and whisper must run sequentially.** Loading
  qwen2.5vl:3b (~3.4 GB) while faster-whisper holds memory fails outright.
  The golden-path script runs stages strictly in order for this reason.

## 2026-07-05 — pre-launch dependency & tool audit

Full stack review before the v0.5.0 launch. Everything on current stable
unless noted; ranges in pyproject are now `>=tested,<next-major`.

- **rapidocr 1.4 (as `rapidocr-onnxruntime`) → 3.9 (renamed `rapidocr`).**
  MAJOR migration: results moved from `[box, text, score]` rows to an output
  object (`boxes/txts/scores`), and 3.x ships per-script recognition models
  with auto-download — which replaced our hand-managed Hugging Face Arabic
  model entirely. Model routing was picked by a rendered-ground-truth
  benchmark on this machine (9 scripts, char-hit rate):
  - default PP-OCRv6 `multi` model: en/zh/ja/fr/es all 100% — Latin accents
    included, so no routing needed for those.
  - Arabic: PP-OCRv4 rec + multilingual det = 100% (the v5 rec returns
    visually-reversed text; v4 wins). Needs `python-bidi` (added to the ocr
    extra).
  - Korean: PP-OCRv5 rec + multilingual det = 100% (default det missed half
    the line). Russian/East-Slavic: PP-OCRv5 `eslav` = 100%.
  - Devanagari: PP-OCRv5 rec = 71% on the bench render — best available;
    revisit when RapidOCR ships a v6 Devanagari model.
  Models now download into `<data_dir>/models/ocr/` (default would be inside
  site-packages, which a reinstall wipes).
- **pyannote.audio 3.1 → 4.0 (diarize extra).** Adapted to the breaking
  rename `use_auth_token=` → `token=` and moved to the recommended
  `speaker-diarization-community-1` pipeline. Covered by a fake-module
  regression test (no torch in CI).
- **numpy held at `>=2.4,<3` instead of forcing 2.5.** numpy 2.5 dropped
  Python 3.11; we keep 3.11 support (installer bootstraps 3.11+), so 3.11
  users resolve 2.4.x and 3.12+ users get 2.5.x. 2.4 is exactly one minor
  behind — inside our freshness budget. Revisit when we drop 3.11.
- **uvicorn 0.49 → 0.50, ffmpeg 8.1 → 8.1.2 (winget), Playwright browsers
  refreshed.** yt-dlp self-updated to 2026.07.04 (doctor), deno 2.9.1 —
  both already latest.
- **ruff pinned in the dev group (`>=0.15,<0.16`)** so local lint matches CI
  instead of floating with `uvx`.

### Best-tool audit (evaluated 2026-07-05, per capability)

| Capability | Tool | Verdict | Evidence |
|---|---|---|---|
| Download/extraction | yt-dlp | **kept** | Release cadence healthy (2026.07.04, released the day before this audit); doctor's self-update healed a 26-day-old binary during the audit run. No credible successor. |
| Acquire fallback | cobalt | **demoted to opt-in** | Live check 2026-07-05: anonymous POST to api.cobalt.tools returns `error.api.auth.jwt.missing` — the public API now requires auth. The chain skips cobalt unless `AGENTVISION_COBALT_API_URL` points at a self-hosted instance (regression-tested), saving a doomed network round-trip before the ffmpeg fallback. |
| Local STT | faster-whisper | **kept** (1.2.1, current) | This machine has no NVIDIA GPU (doctor), so CT2 int8 CPU is the sweet spot. distil-whisper large-v3 is English-only — incompatible with the multilingual launch story. Parakeet/canary want NeMo/GPU. whisper.cpp would add binary management for no measured CPU win over CT2. |
| Scene detection | PySceneDetect | **kept** (0.7, current) | ffmpeg `scdet` alone lacks adaptive content detection and midpoint sampling (we'd rebuild both); TransNetV2 drags torch (~2 GB) into a stack that deliberately has none. |
| OCR | RapidOCR | **kept + major upgrade** (1.4 → 3.9) | 9-script rendered benchmark above. PaddleOCR 3.x needs paddlepaddle (heavy, historically fragile wheels on Windows) to run the same PP-OCR models rapidocr serves via onnxruntime; EasyOCR needs torch. |
| Vector search | manual cosine → **numpy batch** | **replaced (in-place)** | Measured on this machine: pure-Python cosine over 10k×384 vectors = 5.46 s; one numpy matrix product = 122 ms (45×). numpy already ships with the index extra; pure-Python loop kept as fallback. sqlite-vec (0.1.9, win wheel exists) deferred to the roadmap — pre-1.0, adds a loadable-extension moving part, and 122 ms at 10k vectors doesn't justify it yet. |
| Embeddings | all-MiniLM-L6-v2 → **paraphrase-multilingual-MiniLM-L12-v2** | **replaced** | A/B on 8-language retrieval cases + cross-lingual: the old default failed Arabic→Arabic retrieval outright (relevant segment ranked below distractors); the multilingual model scores ar→ar 0.55 and **en→ar 0.58** vs ~0.0 for distractors. Same 384 dims (drop-in for the store), faster on this machine (22 vs 7 texts/s), +130 MB download. bge-m3/e5-large rejected: 1024+ dims and >2 GB — wrong size for the 8 GB-RAM target machine. Index meta now pins the embedding model per index (migration v3) so queries always embed with the model that wrote the vectors. |
| MCP server | FastMCP | **kept** (3.4.2, current) | Actively maintained, current major, and built on the official `mcp` SDK (1.28.1) — we get protocol currency from the SDK plus the ergonomics (progress notifications, streamable HTTP) we already use. Dropping to the raw SDK is boilerplate with no capability gain. |
| Frame dedup | phash (imagehash) | **kept** (4.3.2, current) | pdqhash now has Windows wheels (0.2.8), but our dedup is coarse scene-frame near-duplicate filtering, test-gated and working; no labeled dataset exists to demonstrate a pdq win, so a swap fails the "measurable axis" bar. videohash is unmaintained (last release 2022). |

### Launch benchmark (2026-07-05, dev machine: Windows 10, 8 GB RAM, no GPU)

- **Cold CLI start** (`agentvision version`): 1.2–1.3 s.
- **Full watch, 10 s local sample** (defaults: scenes + frames + OCR + local
  whisper): 32.9 s warm. First-ever run additionally downloads the whisper
  model and OCR models (one-time).
- **`ask` (CLI one-shot)**: 5.8 s end-to-end — ~1.3 s CLI start + ~3.2 s
  loading the multilingual embedding model + retrieval itself. The MCP/REST
  servers keep the model resident, so agent follow-ups don't pay the load.
- Full offline suite on the upgraded stack: 202 passed (see CI for the
  cross-platform matrix).
