# Example catalog

The examples are small, runnable programs built against Watch Skill's public interfaces.
They are numbered by learning path, not release order.

## Before you run them

From the repository root:

```bash
uv sync --extra all
uv run watch-skill doctor
```

Commands below assume `uv run --no-sync`. If Watch Skill is already installed in your
active environment, invoke `python` and `watch-skill` directly instead.

## Recommended path

| # | Example | Main requirement | What you should learn |
|---:|---|---|---|
| 01 | [Watch and ask](01-watch-and-ask/) | Network for the sample URL | Index one video and answer from cited evidence. |
| 02 | [Focused moment](02-focused-moment/) | Example 01 or another indexed video | Resample a narrow time window at higher density. |
| 03 | [Cross-video search](03-cross-video-search/) | Two or more indexed videos | Find relevant moments across the library. |
| 04 | [UI loop](04-ui-loop/) | Playwright and a vision provider | Capture, critique, fix, and verify a local page. |
| 05 | [Multilingual Arabic](05-multilingual-arabic/) | OCR extras | Preserve the source language through OCR, search, and answers. |
| 06 | [Agent integration](06-agent-integration/) | MCP or REST extra | Expose the same engine to an external agent. |
| 07 | [Lessons and stats](07-lessons-and-stats/) | An indexed video | Store a correction and inspect its cost/token effect. |
| 08 | [Loop types](08-loop-types/) | Vision provider; capture support varies | Apply the loop to generated video, games, and monitors. |
| 09 | [Framework adapters](09-framework-adapters/) | The selected framework extra | Hand native tools to LangChain, CrewAI, or Agents SDK. |
| 10 | [Structured extraction](10-structured-extraction/) | An indexed clip | Produce chapters, a bug report, and hook analysis. |
| 11 | [Batch mode](11-batch-mode/) | Pillow and ffmpeg | Index a folder and query it as one collection. |
| 12 | [Library memory](12-library-memory/) | Pillow and ffmpeg | Synthesize an answer whose evidence spans multiple clips. |
| 13 | [Self-improvement](13-self-improvement/) | Local lessons enabled | Evaluate lessons and retire guidance the pipeline outgrew. |
| 14 | [Browser verification](14-browser-verification/) | Playwright and a vision provider | Catch a transient flow bug that a final screenshot cannot show. |
| 15 | [Private offline workflow](15-private-offline-workflow/) | OCR extra and ffmpeg | Run acquisition, OCR, indexing, and answers with cloud use disabled. |
| 16 | [Shareable viewer](16-shareable-viewer/) | Any indexed video | Export one self-contained HTML report. |

## Useful commands

```bash
watch-skill list
watch-skill clean --dry-run
watch-skill stats --cost
```

Most examples write only to the configured Watch Skill data directory. Examples that make
temporary clips identify their workspace in the output and remove it when the process
exits. The shareable-viewer example writes the requested HTML file intentionally.

## Contributing an example

Keep each example focused on one outcome. Include a `README.md`, a runnable entry point,
the exact command, prerequisites, and representative output. Network-backed examples
should provide a local or generated alternative when that is practical.
