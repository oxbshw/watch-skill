# Contributing to Watch Skill

Thanks for helping agents see. This document is short on ceremony and long on
the rules that actually keep the codebase healthy.

## How review works

Every pull request gets a review request automatically through
[CODEOWNERS](.github/CODEOWNERS). The aim is a first response within a week —
not necessarily a merge, but a human reply saying what happens next. If a PR
of yours has gone quiet past that, a nudge in the thread is welcome and not
considered rude.

CI needs a maintainer to approve the run on a first-time contributor's PR, so
a pending "action required" status means the queue, not a rejection.

## Add your agent

The single most useful contribution right now: get your agent into
[the matrix](docs/agents/README.md). It takes about 20 minutes — one
config block, one doc page, one validation run — and there is a full
walkthrough plus skeletons in
[`templates/agent-integration/`](templates/agent-integration/README.md). No
engine code involved; you don't need to understand the pipeline. If you
actually run the 3-step smoke test in your agent, paste the transcript
in the PR and your row gets the machine-tested grade.

## Setup

```powershell
git clone <repo> watch-skill && cd watch-skill
uv sync --extra all           # or: pip install -e ".[all]" in a venv
uv run watch-skill doctor      # bootstraps ffmpeg + yt-dlp
uv run pytest -q               # must be green before you start
```

### Which Python, and why the dev venv pins the oldest one

Watch Skill supports **3.11, 3.12 and 3.13**. `requires-python` says
`>=3.11`, the classifiers list all three, and CI runs every one of them on
Linux and Windows.

`.python-version` says `3.11`, and that is deliberate: it is the
**compatibility floor**, not a preference and not the newest thing that works.
Developing on the oldest supported interpreter is what makes a 3.12-only
syntax or standard-library call fail on the machine that wrote it, in seconds,
rather than in a matrix job twenty minutes later — and a floor nobody develops
on is a floor that quietly rises. It also happens to be where onnxruntime and
CTranslate2 publish wheels first, which is a convenience rather than the
reason.

Change it only as part of deliberately raising the minimum supported version:
`requires-python`, the classifiers, the CI matrix and this paragraph move
together, and `tests/test_python_version_policy.py` fails until they agree.

## Architecture rules (non-negotiable)

1. **`core/` never imports `surfaces/`.** All logic lives in
   `src/watch_skill/`; surfaces (MCP, CLI, REST) are thin wrappers. If a
   feature needs surface-specific rendering, put the data in core and the
   rendering in the surface.
2. **Errors are structured.** Raise `WatchSkillError` subclasses with a
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

A commit message describes the product change and the reason for it. Nothing
else belongs in one.

**Authorship is a person.** Every commit is authored by the human accountable
for the change, and real human co-authors keep their `Co-Authored-By`
trailers. Trailers naming something that is not a person do not belong in the
history, and neither do generated-by notices: the trailer field is how this
project records who is answerable for a change, and an entry that names no one
answerable makes it mean less.

`npm run verify:commits` enforces that, and it reads commit *metadata* only.
It does not read prose, and product documentation about supported integrations
is outside its scope.

Shared history is not rewritten without the maintainer asking for it.

## Adding a vision provider

The registry is data, not code: add an entry to
`src/watch_skill/vision/registry.py` (endpoint, key setting, cost table) and
a request/extract builder pair in `vision/client.py` only if the wire format
is genuinely new. Update `tests/test_vision.py`.

## Adding an acquisition source

Extend the fallback chain in `src/watch_skill/acquire/resolver.py`. Each
step must log why the previous one failed, and known-breakage patterns belong
in `health/doctor.py` so self-healing covers them.

## Releasing

1. Bump `version` in `pyproject.toml` and `**` manifests.
2. `uv build` and check the wheel installs into a clean venv.
3. Tag `vX.Y.Z`.
