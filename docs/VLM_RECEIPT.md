# Real local VLM — model receipt

The first real vision-model run in this project. Three previous seasons
recorded it as environmentally blocked; a dedicated workspace on a drive with
room, plus a CPU-only build, unblocked it.

Paths are recorded as **logical cache roles**, never machine paths. The
workspace root is operator-chosen and passed through environment variables to
child processes only — nothing global was modified, and nothing in this
repository hard-codes a drive.

## Model

| | |
| --- | --- |
| Identifier | `HuggingFaceTB/SmolVLM2-256M-Video-Instruct` |
| Revision (pinned) | `067788b187b95ebe7b2e040b3e4299e342e5b8fd` |
| License | Apache-2.0 |
| Download | 983.10 MiB, 12 files |
| Largest file | `model.safetensors` — 978.47 MiB |
| Other required files | `tokenizer.json` 3.38, `vocab.json` 0.76, `merges.txt` 0.44, plus config/preprocessor/chat-template JSON |
| Download time | 213.4 s |

The 500 M variant was **not** downloaded. Only one model exists in the cache.

## Runtime

| | |
| --- | --- |
| Interpreter | dedicated environment, separate from the Watch Skill base env |
| torch | `2.9.1+cpu` (CPU index — no CUDA wheels pulled) |
| torchvision | `0.24.1+cpu` |
| transformers | `4.57.1` |
| Device | CPU |
| dtype | `float32` |
| Threads | 2 (of 4 logical) |
| Backend | `AutoModelForImageTextToText`, `do_sample=False` |

`float32` is chosen deliberately. This CPU has no AVX-512, so bfloat16 falls
back to an emulated path; and there is no CUDA at all. The safe dtype is the
one that is always correct rather than the one that is sometimes faster.

Two threads, not four: the default grabs every logical core, which starves the
capture pipeline the model is supposed to be observing — it would be
interpreting a session it had itself made stutter.

## Measurements

| Metric | Value |
| --- | --- |
| Worker spawn + model load (cold process) | **8.4 s** |
| Model load alone (warm process) | 0.8 s |
| Warm-up inference | 45.1 s |
| Inference p50 | **47.1 s** |
| Inference range (3 calls @ 32 tokens, 384 px) | 43.4 / 47.1 / 50.1 s |
| Free RAM before load | 2524 MiB |
| Free RAM during inference | 1211–1487 MiB |
| Peak working set (inferred) | ≈ 1.0–1.3 GiB |
| Structured-output success | 3/3 |
| Failures | 0 |
| Calls per minute | ≈ 1.3 |

## Resolution changes what it understands

At `max_edge=512` the model read the screen correctly:

> A webpage with a red button that says "Order Status Failed" and a blue
> button that says "Submitder".

At `max_edge=384` on the same image it lost the status entirely:

> A screen with a red and blue button labeled "Submitter" and a blue button
> labeled "Submitter".

That is worth recording rather than tuning away. Downscaling is the cheapest
latency lever available, and it is also the one that silently costs
comprehension — the smaller input did not fail, it produced a confident wrong
answer. **512 px is the floor for reading on-screen text with this model.**

## Three things measured while wiring the model into a live session

### An unpinned revision is a network call

The cache holds `blobs/` and `snapshots/` and **no `refs/` directory**, because
it was populated by explicit revision. Without `revision=` the library has to
resolve the `main` ref, finds nothing local to resolve it from, and reaches for
the network — which offline mode then refuses. The error it returns talks about
connectivity, which sends everyone looking in the wrong place.

| revision | result |
| --- | --- |
| `""` (unpinned) | fails: "couldn't connect to huggingface.co" |
| `067788b1…` (pinned) | loads offline in **0.69 s** |

Pinning is therefore not merely good practice here, it is the difference
between working and not. It is also what makes an observation reproducible: a
reading that cannot name the revision that produced it is not evidence.

### The model copies the example you give it

Asked for JSON with `{"scene": "a login page", "confidence": 0.5}` shown as a
*format* sample, it replied:

```json
{"scene": "a login page", "confidence": 0.5}
```

about a checkout screen. Valid JSON, entirely invented. The production prompt
therefore contains no sample content at all, and the schema around the model's
prose is derived by deterministic code rather than filled in by the model.

### Font size decides whether the fixture is readable

The model sees a 512 px downscale. Pillow's bare `ImageDraw.text` uses an
~11 px bitmap font, which lands at roughly five pixels:

| drawing | model's reading |
| --- | --- |
| default bitmap font, 1024 px canvas | "A screenshot of a webpage with a red and blue button." |
| scalable font at 76 px, 960 px canvas | "A red screen with the words \"ORDER FAILED\" and \"Total: NaN\" in white." |

The second is verbatim. The first missed a full-width red banner entirely.

### Latency under a loaded machine

The 47.1 s p50 in the table above was measured on an otherwise idle machine.
With a test suite running alongside it, the same calls took **48.9–81.8 s**.
Nothing about the model changed; the CPU it was sharing did. Both numbers are
reported rather than averaged, because the second is what a real session on a
working laptop actually experiences.

## Four things that only showed up in a live session

The standalone worker measurements above are all correct and all optimistic.
Putting the same model inside a running session surfaced four failures that a
single-frame benchmark cannot produce.

### An unpinned revision reaches for the network

`WATCHSKILL_VLM_REVISION` was treated as a nicety. It is load-bearing. This
cache was populated by explicit revision, so it contains `blobs/` and
`snapshots/` and **no `refs/` directory** — there is no `main` → commit
mapping to resolve locally. Without a pinned revision the library therefore
tries to resolve `main` over the network, offline mode refuses, and the error
returned talks about connectivity:

> We couldn't connect to 'https://huggingface.co' to load the files, and
> couldn't find them in the cached files.

which sends the reader looking at their firewall rather than at their config.
Measured side by side: unpinned fails, pinned loads in **0.69 s**. The error
now names the real cause, and the live gate refuses to run unpinned — an
observation that cannot state the revision that produced it is not
reproducible evidence.

### "ready" was reported by a detector that could never answer

When the load failed, the session reported `semantic: {"status": "ready"}`
with the load error tucked into a `warm_error` field nobody reads, while every
frame quietly became a degraded observation. Readiness now means a reading is
actually possible.

### Decode length, not image size, was the latency that mattered

The worker defaulted to 64 new tokens; the 47.1 s measurement above was taken
at 32. In a live session the model shares four threads with capture and OCR,
and at 64 tokens **not one inference completed inside a 130-second source** —
the very thing the gate exists to demonstrate. Reduced to 32, which is more
than the ~20 tokens a one-sentence answer needs. Unlike `max_edge`, this costs
no comprehension: it stops the model writing more than was asked for.

### The fixture has to outlast an inference

A 20-second clip is shorter than one interpretation on this backend. A model
asked about its first frame would answer after the video ended, and nothing
could be shown about a *running* source. The live fixture is 150 s, with each
segment longer than a single inference so a reading can be attributed to the
state it was taken from.

### The text has to survive the downscale

Pillow's bare `ImageDraw.text` uses an ~11 px bitmap font. At 512 px input
that lands around five pixels and is unreadable: a generated frame with a
large red "ORDER STATUS FAILED" banner came back as *"A screenshot of a
webpage with a red and blue button."* Drawn instead with a scalable font at
76 px, the same model read it exactly:

> A red screen with the words "ORDER FAILED" and "Total: NaN" in white.

## Honest assessment

This is a **real model producing real observations**, not a stand-in. It is
not production-quality on this hardware:

- ~47 s per keyframe means it cannot follow raw capture at 2–3 fps. It can
  follow *selected keyframes* at roughly one per minute, which is what the
  keyframe selector already exists to produce.
- Output quality at 256 M is loose. It reads large text, gets colours and
  rough layout, and invents plausible words for small text ("Submitder",
  "Submitter" for "Submit order").
- No ground-truth precision/recall/F1 was computed — that needs the labelled
  fixture run, which has not been executed yet.

## Architecture

The model runs in an interpreter the operator nominates via
`WATCHSKILL_VLM_PYTHON`. Torch is over half a gigabyte and platform-specific;
making it a Watch Skill dependency would tax every install for a feature most
sessions never use, and would put a library famous for its memory appetite
inside the process doing real-time capture.

Controls implemented in `watch_skill.live.vlm_worker`:

- interpreter path validated before execution (exists, is a file, looks like Python)
- protocol version checked on connect (mismatch refuses rather than guesses)
- request ≤ 8 MiB, response ≤ 4 MiB, model text ≤ 8000 chars
- load deadline 300 s, inference deadline 180 s, enforced by killing the process tree
- single-flight: one inference at a time, the lock *is* the backpressure
- failure cooldown 120 s, so a model that fails is not retried at frame rate
- idle release after 600 s
- `HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` forced on — a live session can
  never be the thing that starts a download
- provider-credential environment variables stripped from the child: a
  subprocess that cannot see a key cannot leak one

The worker is launched as a **file**, not `-m watch_skill.vision.worker_main`.
A module launch imports the parent package first, and `watch_skill.vision`
pulls in httpx — which the model environment has no reason to carry. The
worker's premise is that it imports nothing from Watch Skill, and `-m` quietly
broke that.

## Workspace footprint

| Category | Size |
| --- | --- |
| Model environment (torch + torchvision + transformers) | 617.1 MiB |
| Model cache | 983.1 MiB |
| Build/package temp | 589.2 MiB |
| **Total** | **2189.4 MiB** |

Repository drive free space is unchanged at 0.94 GiB — nothing was installed
on it. Unrelated content on the workspace drive was not inspected or modified.
