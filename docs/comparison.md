# How Watch Skill compares

Honest comparison against the other ways to give an agent video. Numbers were
checked on 2026-08-08 and will drift; the linked repositories are the source
of truth.

If you only want the short version: Watch Skill is heavier to install than a
single-purpose script and much younger than the big screen-recording projects.
What it gives you in exchange is a persistent index, evidence you can audit,
and a verification loop. If you need "transcribe this one video" and nothing
else, a smaller tool is a reasonable choice.

## The options

| | Watch Skill | [claude-video](https://github.com/bradautomates/claude-video) | [mcp-video-analyzer](https://github.com/guimatheus92/mcp-video-analyzer) | [screenpipe](https://github.com/screenpipe/screenpipe) | Upload to a frontier model |
|---|---|---|---|---|---|
| Stars | 267 | 14,528 | 42 | 20,816 | — |
| Last release | v1.2.0, 2026-08-08 | v0.2.0, 2026-06-29 | active | active | — |
| Last commit | 2026-08-09 | 2026-06-30 | 2026-08-04 | 2026-08-08 | — |
| Open PRs | 1 | 71 | — | — | — |
| Frames + OCR + transcript | yes | yes | yes | screen only | varies |
| Persistent index across sessions | yes | no | no | yes (screen) | no |
| Ask again without reprocessing | yes | no | no | yes | no |
| Timestamped evidence per answer | yes | no | no | partial | no |
| Cross-video synthesis | yes | no | no | no | no |
| Verify an agent's own work | THE LOOP | no | no | no | no |
| Corrections persist as lessons | yes | no | no | no | no |
| Runs fully offline | yes | partial | partial | yes | no |
| Surfaces | skills, MCP, CLI, REST, Python | Claude skill | MCP | MCP, app | API |
| Install size | ~200 MB standard / ~600 MB all | small | small | app | none |

## Against claude-video

This is the closest comparison, so it deserves detail. claude-video does the
same core job — download a video, pull frames, transcribe, hand it to Claude —
and it earned 14.5k stars in three months by being genuinely easy to start.

Where the two differ:

**It forgets. Watch Skill remembers.** claude-video processes a video and
hands the result to the model. Ask a second question tomorrow and it downloads
and transcribes again. Watch Skill writes to a persistent index, so follow-ups
are a lookup. On a 40-minute video that is the difference between seconds and
minutes, every time.

**Evidence.** Watch Skill answers carry timestamps, a confidence value, and
the frames and transcript lines they came from. You can check the answer
against the video. That matters when the answer feeds a bug report.

**Verification.** THE LOOP records an agent's browser or desktop session,
checks it against plain-language criteria, and produces before/after proof
after a fix. No other tool in the table does this.

**Maintenance.** As of 2026-08-08 claude-video has 71 open pull requests and
its last commit was 2026-06-30. It is one person's project and that person
appears to be busy. Several of those open PRs fix problems Watch Skill does
not have:

| Open there | Here |
|---|---|
| [#112](https://github.com/bradautomates/claude-video/pull/112) add offline whisper | local faster-whisper is the default fallback |
| [#116](https://github.com/bradautomates/claude-video/pull/116) non-English videos yield no transcript | original-language captions are preferred over auto-translations ([`acquire/ytdlp.py`](../src/watch_skill/acquire/ytdlp.py)) |
| [#113](https://github.com/bradautomates/claude-video/pull/113)–[#115](https://github.com/bradautomates/claude-video/pull/115) caption language and PO-token failures | a caption ladder with a documented fallback order |
| [#107](https://github.com/bradautomates/claude-video/issues/107)–[#110](https://github.com/bradautomates/claude-video/issues/110) Windows encoding and permission errors | Windows is a first-class CI target |
| [#117](https://github.com/bradautomates/claude-video/issues/117), [#122](https://github.com/bradautomates/claude-video/issues/122) ffmpeg 8+ removed `-vsync` | `-vsync` is not used anywhere in the pipeline, so the removal is a no-op here |

None of this is a criticism of its author. A project that gets popular faster
than one person can maintain it is a normal outcome, and the code was good
enough to earn those stars.

**Where claude-video is better:** it is far smaller and starts faster. If your
need is "summarize this YouTube link" and you will never ask a second
question, the extra machinery here is overhead you do not need.

Coming from it? See [Migrating from claude-video](migrate-from-claude-video.md).

## Against screenpipe

Different category, often confused. screenpipe records your screen
continuously and makes the history searchable. Watch Skill takes a video you
point it at — a URL, a file, a stream, or a capture it makes on purpose — and
builds auditable evidence from it.

Use screenpipe if you want an always-on record of your own machine. Use Watch
Skill if you want an agent to watch a specific thing and prove what it saw.
They coexist; screenpipe is not an MCP video-understanding tool and Watch
Skill is not a 24/7 recorder.

## Against uploading to a frontier model

Frontier models are very good at watching video and getting better. For a
one-off question about a short clip, uploading is often the right answer.

The gaps that remain:

- **Cost at repetition.** Every question re-sends the video. Watch Skill
  processes once and answers from the index.
- **No provenance.** You get an answer, not the frame it came from.
- **Length.** Long recordings hit context limits. Scene-aware extraction
  spends a frame budget on distinct moments instead.
- **Privacy.** Some footage cannot leave the machine. An Ollama configuration
  keeps the whole pipeline local.
- **Non-English.** Script-aware OCR routing and original-language captions are
  work that general models still do unevenly.

Watch Skill uses frontier models for visual Q&A. The point is not to replace
them but to stop paying for the same video twice.

## Where Watch Skill is weakest

- **Install weight.** ~200 MB standard, ~600 MB with OCR, Whisper, and the
  browser. Smaller tools exist and are honestly smaller.
- **Young.** v1.0 shipped 2026-07-12. Fewer users have hit the edge cases.
- **Vision still costs money** unless you run Ollama locally.
- **One maintainer** right now. The same risk the table calls out elsewhere
  applies here; [CONTRIBUTING.md](../CONTRIBUTING.md) is the honest answer.
