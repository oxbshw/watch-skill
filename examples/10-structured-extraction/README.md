# 10 — Structured extraction (chapters, bug report, hook)

Three production-shaped extractors over the persistent index — deterministic
(model-free) by design, so the same index always yields the same output. All
three are MCP tools and CLI commands:

| Capability | MCP tool | CLI |
|---|---|---|
| Titled chapters w/ timestamps | `extract_chapters` | `watch-skill extract chapters <video>` |
| First on-screen error + frame + repro | `extract_bug_report` | `watch-skill extract bug-report <video>` |
| Score the first N seconds as a hook | `analyze_hook` | `watch-skill extract hook <video> [--seconds N]` |

## Run

```
uv run --no-sync python examples/10-structured-extraction/extraction_demo.py
```

Builds a 4-scene screen-recording-style clip (title → setup → ERROR 502 →
success), watches + indexes it for real (OCR on), then runs all three.

## Example output (real run on this machine)

```
--- extract_chapters ---
[
  {"index": 1, "start": 0.0, "end": 6.2, "title": "CACHE TUTORIAL", "title_source": "ocr"},
  {"index": 2, "start": 6.2, "end": 12.0, "title": "ERROR 502", "title_source": "ocr"}
]

--- extract_bug_report ---
{
  "found": true,
  "timestamp": 6.4,
  "frame_path": "...\\frames\\...jpg",
  "error_text": "ERROR 502",
  "signal": "error 502",
  "severity": 5,
  "summary": "Error appears at 00:06: \"ERROR 502\". ..."
}

--- analyze_hook ---
{
  "score": 49, "verdict": "weak",
  "metrics": [
    {"name": "attention_trigger", "score": 30, "detail": "No opening line to hook with."},
    {"name": "pacing", "score": 25, "detail": "No speech in the opening — the visuals must carry it alone."},
    {"name": "visual_change", "score": 85, "detail": "..."},
    {"name": "on_screen_text", "score": 75, "detail": "On-screen text present ('CACHE TUTORIAL')..."}
  ]
}

EXTRACTION DEMO: PASSED
```

(The demo clip is silent, so the hook analyzer correctly calls its opening
"weak" — the critique tells a creator exactly what is missing.)
