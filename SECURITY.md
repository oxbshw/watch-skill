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
6. **One policy gates every boundary.** `watch_skill.policy.guard_egress` is
   asked before any network or provider call — source acquisition, frame
   egress, audio egress, transcript/OCR egress, cloud models, local models,
   webhooks, telemetry, verification HTTP. A feature that builds a provider
   client and goes around it is a security bug. `WATCHSKILL_OFFLINE=1`
   guarantees zero outbound calls; `tests/test_policy.py` proves it with every
   supported provider key populated.
7. **A configured key is not consent.** Indexing-time scene descriptions do
   not upload frames because an API key happens to be set. The
   `WATCHSKILL_SCENE_DESCRIPTIONS=auto` default resolves to local, never
   cloud.
8. **Telemetry is permanently closed.** The channel exists in the policy so
   that it is denied by construction and an added integration cannot slip past
   it. Watch Skill sends no usage data.

## Verification safety

`watch-skill verify` executes contract checks. Its rules are in
[docs/verification.md](docs/verification.md); the ones that matter for
security:

- Commands are **argv lists**, never strings, and never run through a shell.
  A string command is rejected at model validation, so nothing assembled from
  OCR, a transcript, a caption, or model output can be shell-parsed.
- SQL checks are SELECT-only, parameterised, and run on a handle opened
  `mode=ro`.
- Paths resolve (following symlinks) before being compared to the allowed
  roots, so a link out of the sandbox fails the same test as `../..`.
- HTTP checks require an origin allowlist *and* screen the resolved addresses,
  so an allowlisted hostname pointing at `169.254.169.254` or loopback is
  refused. Redirects are not followed.
- The verifier subprocess receives an **allowlisted** environment. Provider
  keys do not reach it. A denylist was rejected because it would leak every
  key added after it was written.
- Everything inside frames, OCR, transcripts, captions, and downloaded
  metadata is untrusted data. It is searched, never obeyed.

The local isolated verifier runs as the same OS user as the agent it judges.
That is stated as `isolated_local`, and `remote_attested` is never claimed —
see the assurance table in the verification guide.

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
- The other 25 tools do not execute user-supplied commands through a shell; a
  wrapper that drops these two leaves the rest of the surface intact.
  `verify_contract`'s `command_exit` check does run a process, but only from an
  argv list with `shell=False`, in a bounded working directory, under a
  timeout, with a sanitized environment.
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
