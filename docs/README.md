# Watch Skill documentation

This directory contains setup guides, operating references, design notes, and workflow
recipes. If this is your first visit, start with [Getting started](getting-started.md) and
then connect your client through the [agent matrix](agents/README.md).

## Choose by task

| I want to… | Read |
|---|---|
| Install and index a first video | [Getting started](getting-started.md) |
| Connect an AI coding agent | [Agent compatibility](agents/README.md) |
| Look up a tool or endpoint | [MCP tool reference](tools/README.md) |
| Configure storage, models, or privacy | [Configuration](configuration.md) |
| Fix an installation or runtime issue | [Troubleshooting](troubleshooting.md) |
| Understand cost and routing | [Cost policy](cost.md) |
| Decide whether an agent run actually succeeded | [Verification](verification.md) |
| Compare against other options | [Comparison](comparison.md) |
| Move over from claude-video | [Migration guide](migrate-from-claude-video.md) |
| Build capture–critique–verify workflows | [THE LOOP](guides/the-loop.md) |
| Apply Watch Skill to a job | [Use-case packs](packs/README.md) |
| Extend or review the engine | [Architecture](architecture.md) and [decisions](DECISIONS.md) |
| Find contribution opportunities | [Roadmap](ROADMAP.md) and [contributing guide](../CONTRIBUTING.md) |

## Guides

- [YouTube analysis](guides/youtube-analysis.md) — captions, visual evidence, focused
  windows, and follow-up questions.
- [Arabic in, Arabic out](guides/arabic-in-arabic-out.md) — script-aware OCR and
  cross-language retrieval.
- [Live browser](guides/live-browser.md) — pixels and structured page evidence at once,
  navigation policy, redaction, and what a page is never allowed to say.
- [The Observer Loop](guides/observer-loop.md) — declare success first, correct under
  explicit approval, and let a separate process decide whether it worked.
- [THE LOOP](guides/the-loop.md) — capture, criteria, iteration, and proof artifacts.
- [Lessons and savings](guides/lessons-and-savings.md) — corrections, evaluation, caching,
  and token accounting.
- [How self-improvement works](guides/how-it-improves-itself.md) — the complete local
  lesson lifecycle without anthropomorphic claims.

## Use-case packs

Packs combine existing tools into repeatable workflows. They do not add a second API.

- [Browser-agent verification](packs/browser-agent-verification.md)
- [Agent self-verification](packs/agent-self-verification.md)
- [QA and bug hunting](packs/qa-bug-hunting.md)
- [Learning and research](packs/learning-research.md)
- [Meetings and lectures](packs/meetings-lectures.md)
- [Content creators](packs/content-creators.md)
- [Monitoring and operations](packs/monitoring-ops.md)

Runnable counterparts live in the [example catalog](../examples/README.md).

## Reference and design

- [MCP tools](tools/README.md) documents all 23 public tools and their REST/CLI twins.
- [Configuration](configuration.md) is the source of truth for `WATCHSKILL_*` settings.
- [Testing tiers](testing.md) — what the offline suite proves, and what only a real model can
- [Live watching](live.md) — watch something as it happens: sources, bounded pipelines, cursors, finalisation
- [Capture capabilities](capture-capabilities.md) — what this machine can actually record, and how each answer was established
- [Architecture](architecture.md) describes boundaries, data flow, and extension points.
- [Engineering decisions](DECISIONS.md) records the trade-offs behind those boundaries.
- [Product completion ledger](SEASON_PRODUCT_COMPLETION.md) — what each slice built, what proved it, and what is still blocked.
- [Benchmarks](../benchmarks/) contains methods, fixtures, and committed results.

## Documentation standards

Commands should run from the repository root unless a guide says otherwise. Integration
statuses must use the definitions in the [agent matrix](agents/README.md). Measured claims
need a dated benchmark or reproducible example, and configuration blocks must parse under
`templates/agent-adapter/validate.py`.
