# Pack: meetings and lectures

Recordings of meetings are where decisions go to be forgotten. Index
them and the decisions stay queryable — across every meeting, not one.

## The recipe

```powershell
watch-skill watch "C:\meetings\2026-07-10 planning.mp4"
watch-skill extract chapters <video_id>
```

Chapters give the agenda as it actually happened, with timestamps.
Local recordings transcribe with local whisper by default — nothing
uploads, which matters for meetings more than for most footage.

The compounding part — questions that span meetings:

```powershell
watch-skill batch "C:\meetings"
watch-skill library ask "what did we decide about the pricing page?"
watch-skill library ask "who owns the cache-layer fix and since when?"
```

Per-meeting citations with timestamps come back
([standup 07-08 @ 03:12]), corroboration across meetings raises
confidence, and "the library does not clearly answer" is a real answer —
better than a confident paraphrase of something nobody said.

For "what happened around minute 40 of yesterday's call":

```powershell
watch-skill moment <video_id> 40:00 --window 30
```

## Notes

- Screen-share-heavy meetings benefit from frames + OCR (the defaults):
  slide text becomes searchable evidence.
- Diarization (who spoke) is available behind the `diarize` extra; the
  pack works without it.

Live example: the cross-meeting question pattern is exercised in
[`examples/12-library-memory/`](../../examples/12-library-memory/) —
the incident story spread over four clips is structurally the same
problem.
