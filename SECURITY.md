# Security Policy

## Privacy invariants (the contract this project is built on)

These are hard rules, enforced by tests (`tests/test_privacy.py`). A change
that violates any of them is a security bug, not a feature:

1. **The video file itself never leaves the machine.** No exception. Only
   extracted mono-16 kHz audio may be sent to a cloud STT API — and only
   when the user explicitly opted in (`AGENTVISION_CLOUD_STT_ENABLED` /
   `--cloud-stt`). The default transcription fallback is local whisper.
2. **No cookies, no logins.** Acquisition only ever requests public data;
   AgentVision never reads browser profiles or session state.
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
[oxbshw/agentvision](https://github.com/oxbshw/agentvision/security/advisories/new)
(Security → Report a vulnerability), or contact the maintainer (@oxbshw).
Please include reproduction steps. You can expect an initial response within
a week. Please do not open public issues for exploitable problems before a
fix ships.

## Scope notes for researchers

- `agentvision serve --http` and `agentvision api` are designed for
  localhost/trusted-network use. Hardening them for hostile networks
  (rate limiting, TLS) is deliberately out of scope for 0.x.
- yt-dlp and ffmpeg parse untrusted media; we ship self-updating yt-dlp and
  treat "stale yt-dlp" as a health defect, but sandboxing those parsers is
  the platform's job, not ours.
