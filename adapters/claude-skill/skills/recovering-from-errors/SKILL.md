---
name: recovering-from-errors
version: "1.0.0"
description: A Watch Skill command failed, video download broke, ffmpeg or yt-dlp is missing, a provider returned an error, local vision stopped, or the user asks "why can't it watch this" or "repair my setup". Use this to diagnose and apply the engine's structured fix before retrying the original operation.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# Recovering from errors

Failures use stable error codes and include an actionable `fix`. Preserve that evidence;
do not replace it with a generic explanation.

## Diagnose first

```bash
watch-skill doctor --json
```

Read the failing checks and apply only their stated fixes. `doctor` can repair managed
ffmpeg and yt-dlp binaries, stale locks, corrupt caches, missing frame directories, and
known local-model health failures. Re-run it once after remediation.

## Retry the original operation once

After doctor is green, repeat the command that failed. If it returns another structured
error, report its code, message, and fix. Do not loop indefinitely, silently switch cloud
providers, enable cloud STT, or reprocess an already indexed video.

Common routes:

- acquisition or extractor failure: `watch-skill doctor --json`, then retry the watch;
- provider authentication: verify the matching `WATCHSKILL_*_API_KEY` locally;
- provider model not found: run `watch-skill setup-vision` with a valid vision model;
- low memory or local server failure: reduce the local model/context or select a cloud
  provider the user already has;
- unknown video ID: `watch-skill list`, then use the listed ID or original source.

Security and cost policy are invariants during recovery. Never upload the video file,
enable a paid provider, or raise the cost ceiling merely to make an error disappear.
