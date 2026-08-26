# Video-backend benchmark

Watch Skill has no external video backend, and this benchmark exists to
decide whether it should have one — not to prepare for it. The question is
narrow and answerable: **can a provider's output be ingested into Watch
Skill's evidence model without inventing anything?**

```bash
uv run --no-sync python benchmarks/video_backends/make_fixtures.py
watch-skill bench video-backend adversal --write benchmarks/video_backends/adversal/RESULTS.md
```

Results live per vendor: [adversal/](adversal/).

## What makes this measurable

A frame is easy to grade against a stopwatch and hard to grade against the
truth. So the fixtures are generated rather than recorded, and every visual
event is a flat colour band — identity is read out of pixels, not out of a
filename, a timestamp or an OCR pass. A provider that returns the right
*time* attached to the wrong *picture* fails here, which is the whole point:
that failure survives every check that only reads metadata.

Three identity channels, deliberately kept apart:

| channel | role |
|---|---|
| colour band | the measurement. Flat, sampled over ~50k pixels, survives JPEG and rescaling |
| perceptual hash | an independent second opinion. The cards carry a per-event block pattern so pHash has real structure to read — without it every card hashes alike and the cross-check silently stops being one |
| printed label | a third opinion that never decides. OCR is the channel a provider is most likely to have altered, so a result resting on it would measure their OCR rather than their frames |

## Resolution, and refusing to overstate it

Identifying a frame as a two-second event places it inside a two-second
interval. That is not a millisecond measurement, and no arithmetic makes it
one.

So the fixture carries a **frame ladder**: twenty-five consecutive frames,
each its own colour, at 50 fps. A frame taken from that half-second is
attributed to exactly one frame and its true time is known to 20 ms. Those
probes are where the timing numbers come from. Everywhere else the scorer
reports a bound, and the threshold table has three columns — provably
within, provably outside, and unresolved — because counting an unresolved
probe either way would be a guess wearing a percentage sign.

The ladder earns its keep. It is the only part of the fixture that can see a
one-frame extraction offset; against wide events, an extractor that is
consistently one frame late looks perfect.

## What the fixtures contain

`visual_events.mp4` — 20.4 s, 50 fps, 1020 frames

- hard cuts at exactly known times, all on frame boundaries
- unique per-event visual identity
- a four-cut burst at 200 ms each
- a near-duplicate pair 12 colour levels apart — invisible to a human and to
  a perceptual hash, which is exactly the frame a deduplicating pipeline
  collapses
- a 200 ms event
- one card that reappears fifteen seconds later, so "which occurrence" is a
  real question
- events pinned to the first and last frames
- the 25-frame ladder

`speech_events.mp4` — 15.2 s, locally synthesized speech

- silence, then speech
- cue intervals chosen by the generator rather than transcribed by a human
- one closely spaced pair (150 ms apart)
- a video track that changes in lockstep with the utterances, so visual and
  spoken evidence can be checked against each other

Synthesized speech is an easier recognition problem than a real recording,
and any word error rate measured here has to be reported as such.

## Real footage, where nobody authored a truth

A generated fixture proves the mechanism; it does not prove the mechanism
survives 4K source material, 60 fps, long files, or shots that barely move.
So the benchmark also runs against real video — and there the instrument has
to change, because no event ids exist and "the timestamp looks about right"
measures nothing.

Ground truth is derived from the file instead. For each probe the window of
frames around it is decoded **by presentation time**, and the image the
provider returned is located inside that window. The question is not "is this
the right picture" — nobody drew one — but *which frame of this file came
back, and how far is it from the time we asked for*.

Two properties keep the answer honest:

- **Exact when it can be.** Reference frames are decoded with the same JPEG
  settings the extractor uses, so the right frame usually comes back
  byte-identical. That is a certainty, not an inference.
- **Ambiguous when it must be.** A still shot has many indistinguishable
  frames and no comparison separates them. Those probes report an interval
  and an `ambiguous` flag, and are excluded from the timing statistics rather
  than resolved to whichever frame scored best.

```bash
watch-skill bench video-backend adversal \
  --real-media /path/to/clip.mp4 \
  --real-probes 20
```

Half the probes land exactly on the frame grid and half deliberately between
frames — a probe set of round numbers only answers the easy question.

**No real media, frames or stills are committed or kept.** Reference frames
exist for the length of one comparison and are deleted; only timings survive.
Sources are named by URL so a run is reproducible, and nothing derived from
their content beyond a timestamp leaves the measurement.

## Ground truth is verified, not asserted

`make_fixtures.py` refuses to write a manifest it has not proven. Before
`manifest.json` is written it decodes every occurrence back out of the
encoded video **by frame index** and checks the colour band against what it
drew, and it checks that no two cards share a perceptual hash.

Addressing frames by index rather than by seeking to a time is load-bearing.
`ffmpeg -ss T -i file -frames:v 1` — the idiom a fast extractor uses — returns
the first frame at or after `T`, not the frame being displayed at `T`. That
is a property worth measuring in a provider and a disqualifying one in the
check that establishes what the fixture contains.

The MP4s are **not committed**. They regenerate deterministically in about
ten seconds, which is cheaper than carrying them in every clone.
`manifest.json` is committed and records their digests, so a stale fixture
cannot be scored as a fresh one — the runner refuses to proceed on a
mismatch.

## Absence is never success

Every outcome carries an explicit status, and the scorer reads the status
before it reads the payload. A backend that returned nothing can therefore
never be graded as a backend that returned nothing *wrong*. Paths that could
not be exercised are listed by name in the report's *What was not measured*
section; none of them appears as a zero, a pass or an estimate.

The same rule governs cost. Four separate columns — measured,
provider-reported, documented pricing, inferred — because they are four
different kinds of claim, and a vendor's published price is not a
measurement.

## Transport independence

The scorer, the ground truth and the report never see a transport. They take
frames, cues and call records, which is what lets one scorer grade a stdio
MCP server today and a REST API later without the numbers stopping being
comparable.

The adapter seam lives under `src/watch_skill/bench/video_backends/adapters/`
and is benchmark-only. It is not a plugin framework and must not become one:
whether Watch Skill should have an external backend at all is the question
being asked, and answering it must not require shipping the architecture
first.

## Layout

| path | what it is |
|---|---|
| `make_fixtures.py` | generates the media and the proven ground truth |
| `fixtures/manifest.json` | the ground truth (committed) |
| `fixtures/*.mp4` | generated media (not committed) |
| `adversal/` | one vendor's methodology, results and raw data |
| `src/watch_skill/bench/video_backends/scoring.py` | every number the report prints |
| `src/watch_skill/bench/video_backends/verdict.py` | the qualification gates |

## Related

- [Perception benchmark](../perception/README.md) — OCR backends against committed frames
- [Vision provider benchmark](../providers/README.md) — the same "identical inputs, published table" method for vision providers
- [Testing](../../docs/testing.md) — which tier is allowed to claim what
