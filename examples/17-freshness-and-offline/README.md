# 17 — Freshness, offline egress, and inconclusive verdicts

Three guarantees that are easier to believe once you have watched them run.
No network, no API calls, no keys required — the script generates its own
clips with ffmpeg and works in a throwaway data dir.

```bash
uv run --no-sync python examples/17-freshness-and-offline/freshness_and_offline.py
```

## 1. An overwritten video is a new revision, not a stale answer

The script indexes a red clip as `demo.mp4`, then overwrites that path with a
different (blue, longer) clip and asks again.

```text
indexed the red clip      -> video_id 72c53bf54f27d61f
freshness                 -> fresh

same path, different bytes-> stale  (the source has changed since it was indexed)
asking by path            -> refused: index.stale
                             fix: re-watch it to index the current content, or
                                  ask by video_id (72c53bf54f27d61f) to read
                                  the revision that was indexed

re-watched                -> video_id 7a7a11f0e60b79d3
a new id?                 -> True

both revisions are kept:
  7a7a11f0e60b79d3  current     rev_e8482915614ae344
  72c53bf54f27d61f  superseded  rev_be8118d32c9ea476
```

The old analysis is superseded, not destroyed: `72c53bf54f27d61f` still
answers questions about the red clip, because that id names one immutable
revision. What changed is that the *path* no longer resolves to it.

## 2. Offline means offline, even with keys set

The script sets `WATCHSKILL_OFFLINE=1` **and** five provider API keys, then
watches and indexes a clip with scene descriptions switched on — the path
that used to upload every frame whenever any key existed.

```text
keys configured           -> 5
offline policy            -> True
outbound POSTs            -> 0
planned network actions   -> ['none']
a remote URL offline      -> acquire.offline_denied
```

A configured key is not consent. `watch-skill plan` reports the same thing
before a run rather than after:

```bash
watch-skill plan --frames 24
```

## 3. Nothing to look at is `inconclusive`, never a pass

A critic handed a recording with zero frames used to return `pass` with a
score of 92.

```text
verdict                   -> inconclusive
score                     -> 0   (not 92)
assurance                 -> visual_advisory
can it stop a loop?       -> False
  not established: the recording produced zero frames
```

`inconclusive` cannot stop a loop successfully and cannot satisfy a
verification contract. See [Verification](../../docs/verification.md) for the
full verdict and assurance model.

## Related

- [15 — Private offline workflow](../15-private-offline-workflow/) — the
  local-only pipeline this builds on
- [14 — Browser verification](../14-browser-verification/) — THE LOOP catching
  a transient visual bug
