# Live watch: an event before the stream ends

Proves the property that makes live watching different from batch processing:
**the change is reported while the source is still playing.**

The clip is generated locally — no network, no rights questions, no fixture
binary in the repository. It shows `READY` on green for seven seconds, then
`ERROR 502` on red for seven seconds.

## Run it

```bash
python examples/18-live-watch/run.py
```

Expected output (exact timings and hash distances vary by machine and ffmpeg
build; what must hold is that the change is reported *before* the 14 s clip
finishes):

```text
generating a 14s clip...
starting a live session on it (played at real time)

    0.00s  session_started       live session started (file_replay, local-lite, 2 fps)
    0.00s  scene_change          first scene
    7.00s  scene_change          scene changed (phash distance 22)

>>> the change was reported 8.7s in, while the source still had 5.3s to play
>>> that is the whole point: a batch pipeline would report at 14s or later

asking the live session a question...
  At 7.0s into the session (3 events in scope):
  - 7.0s - scene changed (phash distance 22)
  evidence: frame_ea7ed35d2440 @ 7.00s

stopping and finalising...
  finalised as video_id vid_...
  the session is now ordinary indexed memory: ask_video / search_videos work
```

## What it demonstrates

- A local file replayed at real time is a **real** live source — the pipeline
  cannot tell it from a camera.
- Events are cursor-addressed; the script advances a cursor and never sees the
  same event twice.
- The answer cites a **media timestamp** and an `artifact_id` — never a
  filesystem path.
- Finalising turns the session into a normal indexed video without
  reprocessing the media.

## Requirements

`ffmpeg` (run `watch-skill doctor` if missing) and Pillow, which comes with
the `perceive` extra. No API key, no network.
