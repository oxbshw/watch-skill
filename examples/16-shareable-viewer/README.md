# 16 — Export a shareable viewer

The viewer packages an indexed video's timeline, frames, transcript, OCR, cached answers,
and cited evidence into one HTML file. Images and styles are embedded, so the report works
offline and can be sent without running Watch Skill on the receiving machine.

## Run

Index a video first, then pass its ID or original source:

```bash
uv run --no-sync watch-skill list
uv run --no-sync python examples/16-shareable-viewer/export_viewer.py <video_id> report.html
```

If no video argument is supplied, the script exports the most recently indexed video. The
output path defaults to `watch-skill-report.html`.

CLI equivalent:

```bash
watch-skill viewer <video_id> --out report.html
```

Open the resulting file in any modern browser. It makes no external requests. Cached
answers appear only if the video has already been queried with `watch-skill ask` or the
answer tool.
