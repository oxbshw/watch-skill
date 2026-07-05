# 02 — Focused moment

Ask about one specific timestamp of an already-indexed video. `get_moment`
returns dense frames + transcript + on-screen text (OCR) within a window
around the moment — the right tool when the user names a timestamp ("what
happens at 0:08?") instead of asking a broad question.

Runs fully offline (everything comes from the persistent index under
`~/.watch-skill/`). No cloud key, no network. The video must be indexed
first — run example 01, or `watch-skill list` to see what you have.

## Run

```
uv run --no-sync python examples/02-focused-moment/focused_moment.py
```

Or pick your own video and moment (video_id or original URL, seconds):

```
uv run --no-sync python examples/02-focused-moment/focused_moment.py jNQXAC9IVRw 8
```

Agents get the same thing through the MCP `get_moment` tool, which also
attaches the frame images to the response.

## Example output

Real run on this machine (video from example 01):

```
moment 00:08 +/-5s of video 4b0f48e4f4ae6e02

transcript:
  [00:01] All right, so here we are, in front of the elephants
  [00:05] the cool thing about these guys is that they have really...
  [00:07] really really long trunks
  [00:12] and that's cool
frames (open with any image viewer):
  t=00:03  C:\Users\hp\.watch-skill\frames\4b0f48e4f4ae6e02\escalation\watch-skill-esc-plabq0tp\frame_0003.jpg
  t=00:04  C:\Users\hp\.watch-skill\frames\4b0f48e4f4ae6e02\escalation\watch-skill-esc-plabq0tp\frame_0004.jpg
  t=00:05  C:\Users\hp\.watch-skill\frames\4b0f48e4f4ae6e02\frame_0001.jpg
  t=00:08  C:\Users\hp\.watch-skill\frames\4b0f48e4f4ae6e02\frame_0002.jpg
  t=00:10  C:\Users\hp\.watch-skill\frames\4b0f48e4f4ae6e02\frame_0003.jpg
```

The `escalation\...` frames were densely re-sampled by a previous `ask`
whose confidence was low — the answer engine's extra work is kept and
reused by later moment queries.
