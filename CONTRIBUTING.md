# Contributing to AgentVision

Thanks for helping agents see. This document is short on ceremony and long on
the rules that actually keep the codebase healthy.

## Setup

```powershell
git clone <repo> agentvision && cd agentvision
uv sync --extra all           # or: pip install -e ".[all]" in a venv
uv run agentvision doctor      # bootstraps ffmpeg + yt-dlp
uv run pytest -q               # must be green before you start
```

Python 3.11+. The dev venv pins 3.11 (`.python-version`) because the native
deps (onnxruntime, CTranslate2) publish wheels there first.

## Architecture rules (non-negotiable)

1. **`core/` never imports `surfaces/`.** All logic lives in
   `core/agentvision/`; surfaces (MCP, CLI, REST) are thin wrappers. If a
   feature needs surface-specific rendering, put the data in core and the
   rendering in the surface.
2. **Errors are structured.** Raise `AgentVisionError` subclasses with a
   stable `code`, a human `message`, and a `fix` an agent can act on. Never
   let a bare exception cross a surface boundary.
3. **Privacy invariants hold.** The video file never leaves the machine; only
   extracted mono audio may reach a cloud STT API and only behind the opt-in
   flag; no cookies/logins. `tests/test_privacy.py` enforces this — extend it
   when you touch acquisition or transcription.
4. **Windows is a first-class target.** Use `pathlib` everywhere; assume
   paths contain spaces (the test suite runs inside directories with spaces
   on purpose). If a dependency won't install cleanly on Windows, find an
   alternative and log the swap in `docs/DECISIONS.md` — don't silently
   degrade a feature.
5. **Every public function has type hints and a docstring; no function over
   ~60 lines.**

## Tests

- Every module gets unit tests; integration tests synthesize clips with
  ffmpeg `lavfi` — **no copyrighted media, no network** in the suite.
- Heavy optional deps (whisper models, pyannote, cloud keys) must never be
  required for the suite to pass: gate with `pytest.importorskip` or design
  the code so pure logic is testable without the backend (see
  `transcribe/diarize.py` for the pattern).
- Run `uv run pytest -q -m "not network"` and `uvx ruff check .` before
  every commit — both are CI merge gates. Tests that genuinely need the
  network get `@pytest.mark.network` (excluded from the gate, run by the
  manual integration workflow).

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
`chore:`). Commit at working increments. Never commit `bin/`, caches, `.env`,
or index databases (`.gitignore` already covers these — keep it that way).

## Adding a vision provider

The registry is data, not code: add an entry to
`core/agentvision/vision/registry.py` (endpoint, key setting, cost table) and
a request/extract builder pair in `vision/client.py` only if the wire format
is genuinely new. Update `tests/test_vision.py`.

## Adding an acquisition source

Extend the fallback chain in `core/agentvision/acquire/resolver.py`. Each
step must log why the previous one failed, and known-breakage patterns belong
in `health/doctor.py` so self-healing covers them.

## Releasing

1. Bump `version` in `pyproject.toml` and `adapters/claude-skill/**` manifests.
2. `uv build` and check the wheel installs into a clean venv.
3. Tag `vX.Y.Z`.
