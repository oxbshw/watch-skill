# Migrating from claude-video

[claude-video](https://github.com/bradautomates/claude-video) gives Claude a
`/watch` command. Watch Skill keeps that command working the same way and adds
a persistent index, so the second question about a video does not re-download
and re-transcribe it.

Your existing commands should run unchanged. If one does not, that is a bug
worth [reporting](https://github.com/oxbshw/watch-skill/issues).

## Install

```text
/plugin marketplace add oxbshw/watch-skill
/plugin install watch-skill@watch-skill
/watch-skill:setup-watch-skill
```

Outside Claude Code:

```bash
uvx --from "watch-skill[standard]" watch-skill setup
```

You can keep both installed while you try this one. They do not share state,
and nothing here reads or writes claude-video's files.

## Commands

The invocation shape is identical.

```text
/watch https://youtu.be/dQw4w9WgXcQ what happens at the 30 second mark?
/watch ~/Movies/screen-recording.mp4 when does the UI break?
```

## Options

| claude-video | Watch Skill | Note |
|---|---|---|
| `--detail transcript` | `--detail transcript` | skips frames, captions only |
| `--detail efficient` | `--detail efficient` | 12-frame budget |
| `--detail balanced` | `--detail balanced` | 32-frame budget, the default feel |
| `--detail token-burner` | `--detail token-burner` | 96-frame budget |
| `--start` / `--end` | `--start` / `--end` | same time formats |
| `--max-frames` | `--max-frames` | wins over `--detail` |
| `--resolution` | `--resolution` | frame width in px |
| `--no-whisper` | `--no-whisper` | captions only |
| `--no-dedup` | not needed | dedup is perceptual and keeps distinct frames; there is no case where turning it off improves the answer |
| `--whisper groq` | `--cloud-stt` | opt-in; local Whisper is the default and needs no key |
| `--whisper openai` | `--cloud-stt` | same |

## Configuration

claude-video reads `~/.config/watch/.env`. Watch Skill reads its own settings
with a `WATCHSKILL_` prefix and stores data under `~/.watch-skill/`. Nothing is
migrated automatically, because the two tools disagree about what a key is for.

| claude-video | Watch Skill |
|---|---|
| `GROQ_API_KEY` | `WATCHSKILL_GROQ_API_KEY` |
| `OPENAI_API_KEY` | `WATCHSKILL_OPENAI_API_KEY` |
| `WATCH_DETAIL` | `--detail`, or set a frame budget in config |

You may not need any of them. Transcription falls back to local
faster-whisper, and OCR, indexing, and search never call out. A key is only
needed for visual question answering, and a local Ollama model covers that too.
See [Configuration](configuration.md).

## What changes

**Data outlives the run.** claude-video works in a temporary directory that is
discarded. Watch Skill writes to an index under `~/.watch-skill/`, so:

```bash
watch-skill ask <video_id> "when does the demo first fail?"
watch-skill search "pricing decision"
```

Follow-ups are a lookup, not a re-run. This is the main reason to switch and
also the main thing to be aware of: videos you watch accumulate on disk.
`watch-skill clean` and `watch-skill forget <video_id>` are the controls.

**Answers cite their evidence.** Timestamps, a confidence value, and the
frames and transcript lines behind the claim. Useful when the answer becomes a
bug report.

**Frames are chosen, not sampled.** Scene detection plus perceptual dedup
spends the budget on distinct moments, so a talking-head video does not
consume 40 near-identical frames.

**There is more than `/watch`.** Cross-video questions
(`watch-skill library ask`), structured extraction, a shareable offline HTML
report, and THE LOOP for verifying an agent's own browser work. None of it is
required to keep using `/watch` exactly as before.

## Things that are genuinely worse

Being straight about the trade:

- **Bigger install.** ~200 MB for the standard tier against a small script.
  `--extra all` adds OCR, local Whisper, and a browser and lands near 600 MB.
- **Slower first run** on a given video, because it builds an index. Every
  later question on that video is much faster.
- **More surface to learn** if all you ever wanted was one command.
- **Fewer users.** claude-video has had far more people hit its edge cases.

## Uninstalling claude-video

Only after you are satisfied, and entirely optional:

```text
/plugin uninstall watch@claude-video
```

Its config lives at `~/.config/watch/` if you want it gone as well. Check what
is there before deleting anything.
