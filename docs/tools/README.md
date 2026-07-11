# MCP tool reference

All 23 tools exposed by the `watch-skill` MCP server
(`src/watch_skill/surfaces/mcp/server.py`), with parameters, defaults, and
what comes back. Every tool has a REST twin — the mapping table is at the
bottom.

Two conventions hold everywhere:

- **Errors are structured.** Failures return
  `{"error": "<code>", "message": ..., "fix": ..., "details": {...}}` —
  act on `fix` (it usually says "run doctor" or names the setting to
  change). Error codes are namespaced by stage: `acquire.*`, `perceive.*`,
  `transcribe.*`, `index.*`, `vision.*`, `loop.*`, `health.*`, `config.*`.
- **Images are capped.** Responses attach at most
  `WATCHSKILL_RESPONSE_FRAME_CAP` images (even-sampled, first + last kept);
  retrieval is designed to make more unnecessary.

Times are accepted as `SS`, `MM:SS`, or `HH:MM:SS` everywhere a timestamp
or range is a parameter.

## Watch & ask

### `watch_video`

First look at any video you have **not** analyzed yet. Downloads, extracts
scene-aware deduplicated frames, OCRs them, transcribes (captions first,
then local whisper), and indexes everything. For follow-ups call
`ask_video` — never re-watch.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `source` | str | required | Any yt-dlp-supported URL (1800+ sites), direct media URL, HLS/DASH manifest, or local file path |
| `question` | str | — | Echoed in the report header so the agent answers it from the returned evidence |
| `start` / `end` | str | — | Zoom into a section with denser sampling |
| `budget` | int | config | Frame-count cap for this call |
| `background` | bool | `false` | Return a `job_id` instantly; poll `get_status` (use for long videos or strict client timeouts) |

Returns a markdown report (metadata, frame selection, OCR, transcript)
prefixed with the `video_id`, plus key frames as images.

### `get_status`

Poll a background job started with `watch_video(background=true)`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `job_id` | str | required | From the `watch_video` background response |

Returns status/phase/progress JSON; when done it includes the `video_id`
and the exact `ask_video` call to make next. Poll every few seconds, not
in a tight loop.

### `ask_video`

Any follow-up question about a video already watched — by anyone, in any
session. The self-healing answer engine retrieves from the persistent
index, scores its own confidence, escalates when unsure (dense
re-sampling, zoom-crop re-OCR, stronger model), and says plainly when the
video does not clearly show the answer — it never guesses.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `video` | str | required | `video_id` or the original source URL/path |
| `question` | str | required | Natural language, any language |
| `max_frames` | int | `6` | Cap on attached evidence frames |
| `include_frames` | bool | engine | Force frames on/off; default attaches them only when the engine could not verify |
| `verify` | bool | config | Force the model verify pass on/off |

Returns text-first evidence with timestamps plus a metadata line
(`confidence`, `verified`, `cached`, `escalations_used`, tokens saved).

### `get_moment`

Zoom into one specific moment of an indexed video ("what happens at
2:30?"), or expand around an `ask_video` hit.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `video` | str | required | `video_id` or original source |
| `timestamp` | str | required | Center of the window |
| `window` | float | `10.0` | Seconds of context around the timestamp |

Returns dense frames + transcript + OCR within the window.

## Across the whole index

### `search_videos`

Find something across **every** video ever watched, when you don't know
which video contains it. Hybrid keyword + semantic search with proper
per-script normalization (Arabic folding, CJK segmentation).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | str | required | Keywords or a phrase, any language |

Returns videos with timestamped evidence — follow up with `ask_video` or
`get_moment` on a hit.

### `list_videos`

See what is already indexed (id, title, duration, transcript source,
analyzed date). No parameters. Check here **before** `watch_video` when
the video might have been analyzed in an earlier session.

## Learning & token economy

### `report_mistake`

A video answer turned out wrong? Report it with the correction — Watch
Skill learns from it locally (nothing uploaded): the mistake is
classified, stored as a lesson, injected into future similar questions,
and where possible the original question is re-asked immediately to
confirm the lesson works.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `video` | str | required | `video_id` or original source |
| `question` | str | required | The question that was answered wrongly |
| `wrong_answer` | str | required | What was (wrongly) said |
| `correction` | str | required | What the correct answer actually is |
| `session_id` | str | — | Group lessons under a session |

Returns the lesson (`lesson_id`, `error_class`, `content_type`,
`guidance`, `validated`) and, when re-asked, the validation outcome.

### `stats`

Lifetime token-savings meter: how many tokens text-first answers + the
semantic cache have saved vs naive raw-frame injection. No parameters.

## Capture & THE LOOP

### `capture`

Record **new** footage when none exists yet, then analyze + index it like
any other video.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | str | required | `http(s)` URL (headless browser), `screen:` (full desktop), `window:<exact title>`, or an existing video file |
| `duration` | float | `10.0` | Recording length in seconds |
| `script` | list[dict] | — | Browser steps: `goto` / `click` / `fill` / `scroll` / `wait` |

Returns the `video_id` plus the watch report. To record **and** judge
against pass criteria, use `loop_start` instead — capture alone never
critiques.

### `loop_start`

Start THE LOOP when you built or changed something visual and need to
verify it actually looks right: records the target, watches the
recording, and critiques it against your natural-language pass criteria.
The loop **observes — it never edits anything itself**; you apply the
fixes, then call `loop_iterate`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | str | required | Same forms as `capture` |
| `pass_criteria` | str | required | Natural language, e.g. "the checkout total renders a real price" |
| `script` | list[dict] | — | Same interaction script, replayed identically every iteration |
| `max_iterations` | int | `5` | Stop condition |
| `duration` | float | `8.0` | Recording length per iteration |

Returns `loop_id`, verdict, score, and structured issues with timestamps
and suggested fixes.

### `loop_iterate`

Continue the loop — call **only after** you actually changed the code/UI.
Re-captures the same target with the same script, re-critiques, and diffs
against the previous iteration (fixed / unchanged / new issues). Stops on
pass, `max_iterations`, or no-progress; on pass it renders the
before/after MP4 + GIF proof.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `loop_id` | str | required | From `loop_start` |

### `loop_status`

Inspect a loop's persisted state (status, score history per iteration,
artifact paths).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `loop_id` | str | required | From `loop_start` |

### `loop_video_gen`

Start a **video-generation loop**: run any generator command
(Manim/Remotion/ffmpeg/AI-gen), watch the video it writes, critique it
against the spec, and iterate until the render matches. You edit the
generator between iterations; `loop_iterate` re-runs and re-judges it.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `spec` | str | required | What the generated video must show |
| `generator_cmd` | str | required | Shell command that renders the video |
| `output` | str | required | The video file the command writes (stale renders are deleted first) |
| `pass_criteria` | str | spec | Overrides the spec for the critic |
| `workdir` | str | — | Working directory for the command |
| `max_iterations` | int | `5` | Stop condition |
| `timeout` | float | `600` | Generator timeout in seconds |

### `loop_game`

Start a **game/simulation loop**: optionally launch the game, record
gameplay from a canvas URL / `window:<title>` / `screen:`, and critique the
recording for visual glitches and state failures (a `NaN` score counter,
black flicker frames, missing sprites).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | str | required | Canvas game URL, `window:<title>`, or `screen:` |
| `pass_criteria` | str | required | e.g. "the SCORE counter must show a number (like SCORE: 12), never NaN" |
| `run_cmd` | str | — | Command that launches the game (terminated after recording) |
| `script` | list[dict] | — | Browser interaction steps for canvas games |
| `duration` | float | `10.0` | Recording length per iteration |
| `max_iterations` | int | `5` | Stop condition |

### `loop_monitor`

Watch a **folder of videos or a live target** until a described condition
appears, then return a structured event (also appended to `events.jsonl`
under the monitor's loop dir). Bounded by `max_checks` — it always
terminates. Folder sources consume each video once; live targets sample
`sample_seconds` every `interval`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `source` | str | required | Folder path, URL, `screen:`, or `window:<title>` |
| `condition` | str | required | Plain language, e.g. "an error screen (like ERROR 502)" |
| `interval` | float | `10.0` | Seconds between live checks |
| `max_checks` | int | `10` | Hard bound on checks |
| `sample_seconds` | float | `5.0` | Live sample length per check |

## Structured extraction

### `extract_chapters`

Segment an already-watched video into titled chapters with start/end
timestamps, from scene changes + transcript topic shifts. Deterministic —
answers straight from the index, no extra model calls.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `video` | str | required | `video_id` or original source |

### `extract_bug_report`

QA mode: pinpoint where an error appears in a watched screen recording —
timestamp, frame, exact on-screen error text (OCR), and the steps that led
up to it. Returns `found: false` when no error signal exists.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `video` | str | required | `video_id` or original source |

### `analyze_hook`

Creator mode: score the first N seconds as a hook — attention trigger in
the opening line, speech pacing, visual change rate, on-screen text — each
with an actionable critique, plus a combined 0-100 score and verdict.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `video` | str | required | `video_id` or original source |
| `seconds` | float | `15.0` | Opening window to score |

## Batch & sharing

### `watch_batch`

Watch + index a whole set in one call: a playlist/channel URL
(auto-expanded), a folder of video files, or an explicit list. Everything
lands in the same persistent index, so one `search_videos`/`ask_video`
afterwards spans the entire batch. One failing video never stops the rest.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `sources` | list[str] | required | URLs/paths, folders, or playlist URLs |
| `limit` | int | `20` | Max videos to process |

### `generate_viewer`

Render a shareable, self-contained HTML page for an analyzed video:
timeline + key frames (inlined — works offline, zero external requests),
transcript, on-screen text, and every cached answer with the exact evidence
cited. The file opens directly in any browser and can be sent to anyone.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `video` | str | required | `video_id` or original source |
| `out_path` | str | cwd | Where to write the HTML file |

## The library (cross-video memory)

Every watch distills structured notes — entities, claims, chapters, each
with (video_id, timestamp) provenance — incrementally: indexing video N
never reprocesses the others. These two tools read that layer.

### `library_synthesize`

Answer a question from the WHOLE library at once, when no single video
answers it ("what did the meetings decide about X?"). Retrieves notes
across every indexed video, drills the top matches into real indexed
evidence, and synthesizes extractively — per-video timestamp citations
on every finding, corroboration across videos raises confidence, and the
honest floor applies: a library that does not clearly know says so.
Deterministic and offline; repeats come from the library answer cache
(invalidated automatically when the library grows).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `question` | str | required | Natural language, any language |
| `k_videos` | int | `5` | How many videos to consult |

### `library_overview`

What the library knows: videos and hours indexed, note counts by kind,
the entities recurring across multiple videos, recent additions, and the
library-level savings meter. No parameters. Orient here before
`library_synthesize`, or when the user asks what has been watched.

## Health

### `doctor`

Run when **any** other tool fails with a dependency or download error, or
on first use. Checks and self-heals: installs missing ffmpeg/yt-dlp,
updates a stale yt-dlp, verifies disk space, GPU, and API keys. No
parameters. Each failing check includes a `fix` you can act on.

## REST twins

The REST API (`watch-skill api`, OpenAPI spec at `/openapi.json`) mirrors
every tool for non-MCP agents:

| MCP tool | REST endpoint |
|---|---|
| `watch_video` | `POST /v1/watch` |
| `ask_video` | `POST /v1/answer` (full Answer payload; `POST /v1/ask` is raw retrieval) |
| `get_moment` | `GET /v1/videos/{video}/moment` |
| `search_videos` | `GET /v1/search?q=` |
| `list_videos` | `GET /v1/videos` |
| `capture` | `POST /v1/capture` |
| `loop_start` | `POST /v1/loops` |
| `loop_iterate` | `POST /v1/loops/{loop_id}/iterate` |
| `loop_status` | `GET /v1/loops/{loop_id}` |
| `library_synthesize` | `POST /v1/library/synthesize` |
| `library_overview` | `GET /v1/library/overview` |
| `doctor` | `POST /v1/doctor` |

(`get_status`, `report_mistake`, and `stats` are MCP/CLI-side:
backgrounding is an MCP transport concern, and lessons/stats have CLI
surfaces — `watch-skill lessons add`, `watch-skill stats`. Some tools
have CLI twins instead of REST ones for now: `watch-skill loop
video-gen|game|monitor`, `watch-skill extract chapters|bug-report|hook`,
`watch-skill batch`, and `watch-skill viewer`. The library layer has all
three surfaces plus a CLI-only upgrade path for pre-notes indexes:
`watch-skill library ask|overview|rebuild-notes`.)

REST-only details: frames come back as filesystem paths plus optional
base64 (`inline_frames`), and when `WATCHSKILL_API_BEARER_TOKEN` is set
every request must send `Authorization: Bearer <token>` (without a token
the API refuses to bind to non-loopback hosts).

Per-call parameters here override the corresponding
[configuration](../configuration.md) setting for that one call.
