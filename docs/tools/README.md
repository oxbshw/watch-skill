# MCP tool reference

All 34 tools exposed by the `watch-skill` MCP server
(`src/watch_skill/surfaces/mcp/server.py`), with parameters, defaults, and
what comes back. Every tool has a REST twin — the mapping table is at the
bottom.

Two conventions hold everywhere:

- **Errors are structured.** Failures return
  `{"error": "<code>", "message": ..., "fix": ..., "details": {...}}` —
  act on `fix` (it usually says "run doctor" or names the setting to
  change). Error codes are namespaced by stage: `acquire.*`, `perceive.*`,
  `transcribe.*`, `index.*`, `vision.*`, `loop.*`, `health.*`, `config.*`,
  `policy.*`, `verify.*`.
- **Stored evidence is freshness-checked.** `ask_video`, `get_moment` and the
  answer engine refuse to answer from a source that has demonstrably changed
  (`index.stale`), because the alternative is a confident answer about a video
  that is no longer there. Pass a `video_id` to read a specific revision on
  purpose, or re-watch to index the current one.
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

## Live watching

Watching something **as it happens** — a stream, or a local file replayed at
real time. Events are produced while the source is still playing, not after it
ends. No model runs per frame: scene changes and on-screen text changes are
detected locally, and a question selects a handful of already-captured frames
when interpretation is actually needed.

### `start_live_watch`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | str | required | File path (replayed live) or stream URL |
| `kind` | str | `file_replay` | `file_replay` or `stream`. Anything else reports honestly that this build/machine cannot record it |
| `profile` | str | `local-lite` | `local-lite`, `local-realtime`, or `forensic` (keeps everything, drops nothing) |
| `fps` | float | `2.0` | **Analysis** frame rate — capture keeps up regardless |
| `buffer_seconds` | float | `120.0` | Rolling retention window; evidence around an event is pinned and exempt |

Returns a `session_id`. Check `capture_capabilities` first for anything
other than a file or stream.

### `observe_live`

Cursor-addressed event deltas. Pass the previous `next_cursor` to get only
new events — **repeating a cursor returns the same events**, so a retried
call never loses or double-counts anything.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | str | required | From `start_live_watch` |
| `cursor` | str | `""` | The previous `next_cursor`; omit to start at the beginning |
| `limit` | int | `50` | Batch size cap |
| `wait_seconds` | float | `0.0` | Long-poll instead of returning an empty batch |
| `types` | list[str] | — | Filter by event type |

Event types include `scene_change`, `visible_text_change`, `speech`,
`motion`, `ui_state_change`, `anomaly`, `capture_gap`, and
`provider_degraded`. Every event carries a media timestamp, a wall
timestamp, a confidence, and whether it is an `observation` or an
`inference`. Evidence is referenced by `artifact_id` — never a filesystem
path.

### `ask_live`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | str | required | |
| `question` | str | required | Natural language |
| `scope` | str | `recent` | `now`, `recent` (last `seconds`), or `session` |
| `seconds` | float | `30.0` | Window for `recent` |

Answers cite the media timestamps they came from. When nothing observed
supports an answer, it says so rather than inventing one.

### `get_live_status`

State, frames captured vs analyzed, **dropped frames**, queue depths, and
buffer size. Omit `session_id` to list every live session on this machine.
Dropped frames are counted and reported, never hidden — a live view that
silently skips is a live view you cannot trust.

### `stop_live_watch`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | str | required | |
| `finalize` | bool | `true` | Turn the pinned evidence into an ordinary indexed video |

After finalising, `ask_video` and `search_videos` work on the session with
**no reprocessing of the media** — the frames and OCR were already produced
while it ran.

### `capture_capabilities`

What this machine can actually record, and how each answer was established:
`machine_tested`, `probed`, or `not_tested`. Nothing is reported
`available` on the strength of a code path existing. Unavailable entries
carry a `repair` string or an explicit limitation.

## Health

### `doctor`

Run when **any** other tool fails with a dependency or download error, or
on first use. Checks and self-heals: installs missing ffmpeg/yt-dlp,
updates a stale yt-dlp, verifies disk space, GPU, and API keys. No
parameters. Each failing check includes a `fix` you can act on.

## Freshness, policy & verification

### `check_source`

Whether an indexed video still matches what its source holds **now**, plus
every revision recorded for it. Call it before treating an older analysis as
current — a local path can be overwritten between sessions.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `video` | str | required | `video_id` or the original source URL/path |

Returns `{state, video_id, revision_id, superseded, reason, revisions[]}`.
`state` is one of `fresh`, `stale`, `refresh_required`, `freshness_unknown`.
Anything but `fresh` means re-watch before answering, or answer about a
specific `video_id` and say which revision you are describing.

### `execution_plan`

What a run *would* send, and what it could cost, before it sends anything.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `frames` | int | `0` | Frames the run would carry |
| `tier` | str | `strong` | `cheap` or `strong` |

Returns the provider, model, payload counts, the exact network actions, the
estimated maximum spend (labelled `estimated`), and the full effective policy:
offline mode, each egress channel, the provider allowlist, and both ceilings.
Answers "will this upload my video?" without running anything.

### `verify_contract`

Decide whether an agent run succeeded, using deterministic checks rather than
an opinion about a screenshot.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `title` | str | required | What this contract is about |
| `checks` | list[dict] | required | `{id, type, required, params}` — see [Verification](../verification.md) |
| `working_dir` | str | `.` | Bounds every path a check may touch |
| `allowed_origins` | list[str] | `[]` | Origins an `http_request` check may reach |

The contract is frozen and digested before it runs, so it cannot be widened
afterwards. `pass` requires **every** required check to pass; a check that
fails, times out, or never runs makes the run `inconclusive`, never a pass. A
contract with no required check is `inconclusive` by construction — visual
evidence alone is not verification.

Returns the verdict, the assurance level, the contract digest, what was not
established, and a `run_id`.

### `get_evidence`

Read a verification run's evidence bundle and attestation back. The
attestation is re-checked against the bundle on the way out, so an edited
evidence file raises `verify.attestation_tampered` instead of being reported
as a verified pass.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `run_id` | str | required | From `verify_contract` |

## REST twins

The REST API (`watch-skill api`, OpenAPI spec at `/openapi.json`) mirrors
every tool for non-MCP agents:

| MCP tool | REST endpoint |
|---|---|
| `watch_video` | `POST /v1/watch` |
| `check_source` | `GET /v1/videos/{video}/freshness` |
| `execution_plan` | `GET /v1/plan` |
| `verify_contract` | `POST /v1/verify` |
| `get_evidence` | `GET /v1/verify/{run_id}` |
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
