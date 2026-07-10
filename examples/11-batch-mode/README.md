# 11 — Batch / playlist mode

Watch + index a whole set in one call — a playlist/channel URL (auto-expanded
via yt-dlp flat extraction), a folder of video files, or an explicit list.
Everything lands in the same persistent index, so ONE question afterwards
spans the entire batch. Tools that forget each video can't do this.

| Surface | Invocation |
|---|---|
| MCP | `watch_batch(sources=[...], limit=20)` |
| CLI | `watch-skill batch <folder-or-playlist-or-urls...> [--limit N]` |
| Python | `from watch_skill.batch import watch_batch` |

One failing video never stops the rest — the report lists per-source status.

## Run

```
uv run --no-sync python examples/11-batch-mode/batch_demo.py
```

## Example output (real run on this machine)

```
batch: 4/4 indexed
  0e63b6ca4f9d3f21  [00:03]  intro_python.mp4
  57caff59a0e4c6b8  [00:03]  docker_talk.mp4
  9f0090b0973c9b6e  [00:03]  bug_repro.mp4
  6d0e6b1cd25980b7  [00:03]  release_notes.mp4
all indexed videos share one searchable memory — search_videos("...") spans them; ask_video works on each.

cross-video question: which video shows "ERROR 502"?
  -> bug_repro.mp4  [ocr @ 0.64s]  ERROR 502
BATCH DEMO: PASSED (cross-video question answered)
```
