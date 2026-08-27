# Adversal MCP 0.1.4

Adversal told us 0.1.4 was live and asked us to test five things: timestamp
precision, frame identity, frame ordering, transcript handling, and how
naturally its output maps into Watch Skill's evidence model. This is that
evaluation — a first look at a first release, run against the real service
rather than against the release notes.

Measured results: [RESULTS.md](RESULTS.md). Raw data: [raw/](raw/).

## What it is

`adversal-cli` on PyPI — a local stdio MCP server that submits videos to
Adversal's backend asynchronously and downloads artifacts on request. Eight
tools: `authenticate`, `check_remaining_quota`, `process_video`,
`check_video_status`, `analyze`, `transcribe`, `extract_frames`,
`get_request_id`.

## Setting it up

Per [adversal.ai/documentation/mcp](https://adversal.ai/documentation/mcp).
It needs **Python 3.13 or newer**, which Watch Skill does not — install it
into its own environment rather than the project's:

```bash
uv venv --python 3.13 /tmp/adversal-venv
uv pip install --python /tmp/adversal-venv/Scripts/python.exe adversal-cli==0.1.4
```

Then point the benchmark at it:

```bash
watch-skill bench video-backend adversal \
  --adversal-cli /tmp/adversal-venv/Scripts/adversal-cli.exe \
  --adversal-python /tmp/adversal-venv/Scripts/python.exe \
  --raw benchmarks/video_backends/adversal/raw/benchmark.json \
  --write benchmarks/video_backends/adversal/RESULTS.md
```

The benchmark spawns the server itself over stdio. It deliberately does
**not** register Adversal in this repository's `.mcp.json` or in any agent's
configuration: a benchmark that rearranges the machine it runs on is a
benchmark nobody can rerun.

## Authentication

There is no API key. `authenticate` opens a browser sign-in and stores a
refresh token at `~/.adversal/auth.txt`. The benchmark never reads that file
and never prints it; sanitization runs at the moment a value is recorded, not
as a pass over the finished file.

**The published run was authenticated.** Sign-in was completed with the
`authenticate` tool, and the committed results come from a session that
reached the real backend: jobs were submitted and polled to completion,
`analyze`, `transcribe` and `extract_frames` all returned artifacts, and
provider quota was read before and after. Every path the benchmark covers
produced a measurement.

A fresh live run needs its own session — see [Running it live](#running-it-live).
Re-rendering the committed results does not.

## Pre-auth diagnostic: exact-frame extraction behavior

This was observed during the earlier pre-auth diagnostic pass, before the
session used for the published run existed. It is retained because it exposed
a useful failure-semantic edge in 0.1.4, not because it describes the state of
the benchmark — the published evaluation was authenticated and exercised the
backend paths in full.

`process_video(timestamps=[...])` — the exact-frame extraction 0.1.4 added —
is served by **ffmpeg on the local machine**, and in 0.1.4's code that
extraction happens *before* `_get_access_token()` is called. The frames are
written to disk, and only then does the tool return `AUTHENTICATION REQUIRED`.

So a call that reported failure left 52 usable JPEGs behind. A consumer
trusting the status alone discards good evidence; one trusting the files alone
ingests evidence from a call that said it failed. Watch Skill would have to
reconcile those two explicitly, and the same shape shows up again in the
long-HD stall documented in [RESULTS.md](RESULTS.md#reliability).

## Real footage

The generated fixture proves the mechanism. It does not prove the mechanism
survives long files, 60 fps, or footage that barely moves — so the run also
covers two real YouTube sources, chosen to be unlike each other:

| source | as fetched | why it is here |
|---|---|---|
| `youtu.be/DTu4yvmc0Fc` | 5:56, 1080p, 25 fps | 4K original, downscaled by the provider's own format selector — tests the rendition it actually gets |
| `youtu.be/RWp5cejTApU` | 12:39, 1080p, 60 fps | long, and a 16.7 ms frame period where an off-by-one frame is four times finer than at 25 fps |

Both were fetched with Adversal's own selector (`bv*[height<=1080]+ba/b[height<=1080]`)
so the local reference is the same rendition a URL submission would get.

```bash
yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]" --merge-output-format mp4 \
  -o "%(id)s.%(ext)s" https://youtu.be/DTu4yvmc0Fc

watch-skill bench video-backend adversal \
  --adversal-cli /tmp/adversal-venv/Scripts/adversal-cli.exe \
  --real-media ./DTu4yvmc0Fc.mp4 \
  --real-media-url https://youtu.be/DTu4yvmc0Fc \
  --real-probes 20
```

`--real-media` submits the local file, which is the rigorous measurement: the
provider and the reference see identical bytes. `--real-media-url` exercises
the acquisition path instead, letting the bundled yt-dlp fetch its own copy —
how often the returned frames still localize byte-exactly against our copy is
the interesting part, because it says whether a URL submission is
reproducible at all.

Nothing from these videos is committed. Reference frames live for the length
of one comparison and are deleted; the results carry timings, not content.

### Expect it to stall

Worth knowing before you run this: `process_video` with `timestamps` does not
reliably return on a long HD source in 0.1.4. The child `ffmpeg` finishes and
writes a correct frame, then the process sits at zero CPU and the call does
not come back — one was observed idle for twelve minutes with its output
already on disk. Both real sources stalled in the recorded run. Extraction
itself was correct every time; it is the return that goes missing.

So **always pass `--call-timeout`**. Without it the default is fifteen
minutes per call and a run against real footage will appear to hang:

```bash
watch-skill bench video-backend adversal --call-timeout 120 --real-media ./clip.mp4
```

The benchmark scores whatever frames were written before the timeout and
records the call as a transport error, which is the honest account: the
provider never reported anything. Every real-media run also executes a local
control — Watch Skill's own extractor, same file, same timestamps, same
machine — so a stall cannot be blamed on the box or the codec. See
[Reliability](RESULTS.md#reliability).

## Re-rendering without re-running

Every number in [RESULTS.md](RESULTS.md) comes from
[`raw/benchmark.json`](raw/), and the report can be rebuilt from it without
touching the provider:

```bash
watch-skill bench video-backend adversal --from-raw benchmarks/video_backends/adversal/raw/benchmark.json --write benchmarks/video_backends/adversal/RESULTS.md
```

Re-render and diff: if the committed report and the raw data disagree, one of
them is wrong.

## Artifact schemas, as observed

`read_frames_json` and `read_transcript_json` were written against the
documentation's description before any payload had been seen, and have since
been corrected against the live service. 0.1.4 returns:

| artifact | shape |
|---|---|
| `frames.json` | a JSON list of `{frame, timestamp, text}` — `timestamp` an `HH:MM:SS` clock string at whole-second resolution, `text` the OCR of that frame. An empty list is a valid answer and means the pipeline selected no frames |
| `transcript.json` | a JSON list of `{start, end, text}`, both times `HH:MM:SS` at whole-second resolution |

The first version assumed numeric seconds and would have turned every cue into
a cue with no time at all. Both readers stay tolerant of other shapes and keep
unrecognised fields in `raw`, because one observed release is not a contract.

## Running it live

Re-rendering the committed results needs nothing at all — see
[Re-rendering without re-running](#re-rendering-without-re-running). A *fresh*
run against the provider needs a session of your own:

> **Sign in to Adversal once.** Call the `authenticate` MCP tool from an agent
> connected to `adversal-cli`, finish the browser sign-in, and confirm
> `~/.adversal/auth.txt` exists.

Then run the command above with `--poll 30`, which lets submitted jobs finish
so the backend paths are exercised. Nothing else changes: the fixtures, the
probes, the scorer and the gates are identical, so the numbers come out
directly comparable to the run recorded here.

Signing in is a deliberate act with a real account and a real quota, which is
why it is left to a person rather than automated. The benchmark never reads
`~/.adversal/auth.txt`, never prints it, and never commits it; sanitization
runs at the moment a value is recorded rather than as a pass over the
finished file.

## Cost

Two different numbers, and they are easy to confuse.

**Re-rendering costs nothing.** `--from-raw` rebuilds the report from the
committed JSON and makes zero provider calls.

**A fresh live run consumes real minutes.** Obtaining the artifacts behind the
committed results cost 21 provider minutes across 4 jobs, for 19.18 minutes of
source — about 1.82 minutes of that is billing rounding up to a whole minute
per job. Repeating a submission is free: the provider deduplicates on the MD5
of the bytes, so the same file reuses its existing job, which is why the final
recorded execution added nothing to the total.

Call `check_remaining_quota` before submitting. Rate limits were deliberately
not provoked — burning quota to read an error message is not a measurement
worth taking — and the failure probes are all rejected by argument validation
before any upload, so none of them cost anything.

## Related

- [Video-backend benchmark](../README.md) — the method, the fixtures, and what makes them measurable
- [Architecture](../../../docs/architecture.md) — the evidence model this is being measured against
