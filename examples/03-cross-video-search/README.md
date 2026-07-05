# 03 — Cross-video search

Search across every video ever indexed, in one query. Hybrid keyword (FTS5)
+ semantic (local ONNX embeddings) retrieval over transcripts, scene
descriptions, and OCR blocks. Use it when you don't know which video
contains something — then follow up with `ask` (example 01) or `get_moment`
(example 02) on a hit.

Runs fully offline against the persistent index. No cloud key, no network.

## CLI

```
uv run --no-sync watch-skill search "elephants"
```

## Python equivalent

```
uv run --no-sync python examples/03-cross-video-search/cross_video_search.py "elephants"
```

## Example output

Real run on this machine (index contained 6 videos, including an Arabic
one — titles in any script are handled):

```
matches for 'elephants':

Me at the zoo  (id 4b0f48e4f4ae6e02)
  [00:01] (segment, 0.81) All right, so here we are, in front of the elephants
  [00:07] (segment, 0.15) really really long trunks

ماهي البرمجة وكيف تتعلمها : تعلم البرمجة للمبتدئين من الصفر ١  (id d02c3e2e589f4253)
  [00:45] (ocr, 0.17) OctuCude
  [03:40] (ocr, 0.17) OctuCude
  [02:55] (ocr, 0.16) ghighi
```

The first group is a strong transcript match (score 0.81); the rest are
weak semantic tails — scores tell you which hits to trust.
