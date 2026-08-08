# Security Policy

## Privacy invariants (the contract this project is built on)

These are hard rules, enforced by tests (`tests/test_privacy.py`). A change
that violates any of them is a security bug, not a feature:

1. **The video file itself never leaves the machine.** No exception. Only
   extracted mono-16 kHz audio may be sent to a cloud STT API — and only
   when the user explicitly opted in (`WATCHSKILL_CLOUD_STT_ENABLED` /
   `--cloud-stt`). The default transcription fallback is local whisper.
2. **No cookies, no logins.** Acquisition only ever requests public data;
   Watch Skill never reads browser profiles or session state.
3. **Frames sent to a configured vision provider are the user's choice.**
   The provider (including fully local Ollama) is explicit configuration;
   nothing defaults to a cloud call without a key the user set. Every cloud
   call passes a cost guard first.
4. **Keys are never logged, echoed, or persisted outside `.env`/env vars.**
   `SecretStr` end to end; the doctor reports *which* providers are
   configured, never values.
5. **The REST API refuses to bind non-loopback addresses without a bearer
   token.**

## Reporting a vulnerability

Open a GitHub security advisory on
[oxbshw/watch-skill](https://github.com/oxbshw/watch-skill/security/advisories/new)
(Security → Report a vulnerability), or contact the maintainer (@oxbshw).
Please include reproduction steps. You can expect an initial response within
a week. Please do not open public issues for exploitable problems before a
fix ships.

## Two MCP tools run commands you give them

`loop_video_gen(generator_cmd=...)` and `loop_game(run_cmd=...)` execute the
command string through a shell, by design: the point is to re-run your
renderer or launch your game between iterations, and that needs pipes,
redirects, and shell quoting.

The consequence is worth stating plainly. An agent connected to Watch Skill
over MCP can run arbitrary commands through these two tools, with the
privileges of the user running the server. They are as powerful as any shell
tool in the same agent, and no more sandboxed.

If that is not acceptable in your setup:

- Do not expose the MCP server to an agent you would not give a terminal.
- The other 21 tools do not execute user-supplied commands; a wrapper that
  drops these two leaves the rest of the surface intact.
- Treat `generator_cmd` and `run_cmd` reaching the server from untrusted
  content — a web page, a document, a video's own metadata — as the
  injection path that matters. Watch Skill cannot tell an agent's intent
  from an attacker's.

This is a documented property, not a vulnerability report. A way to reach a
shell through any of the *other* tools would be a real finding.

## Scope notes for researchers

- `watch-skill serve --http` and `watch-skill api` are designed for
  localhost/trusted-network use. Hardening them for hostile networks
  (rate limiting, TLS) is deliberately out of scope.
- yt-dlp and ffmpeg parse untrusted media; we ship self-updating yt-dlp and
  treat "stale yt-dlp" as a health defect, but sandboxing those parsers is
  the platform's job, not ours.
