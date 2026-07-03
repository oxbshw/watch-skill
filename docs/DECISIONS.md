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
