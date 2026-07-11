# Use-case packs

Each pack is a recipe over existing tools — no special modes, nothing to
enable — with a runnable example and the numbers from a real run on the
reference machine (8 GB RAM, CPU-only Windows).

| Pack | The move | Live example |
|---|---|---|
| [Browser-agent verification](browser-agent-verification.md) | record the session → the Loop verdicts the FLOW, not a screenshot | `examples/14-browser-verification/` |
| [QA / bug hunting](qa-bug-hunting.md) | screen recording → fileable bug report with frame + timestamp | `examples/10-structured-extraction/` |
| [Content creators](content-creators.md) | hook score on 4 measured axes + auto-chapters + review page | `examples/10-structured-extraction/` |
| [Learning / research](learning-research.md) | playlist → one queryable library with citations | `examples/12-library-memory/` |
| [Meetings / lectures](meetings-lectures.md) | "what did we decide about X?" across every recording | `examples/12-library-memory/` |
| [Monitoring / ops](monitoring-ops.md) | bounded monitor → signed webhook events (n8n/Zapier) | `examples/08-loop-types/` |
| [Agent self-verification](agent-self-verification.md) | UI / video-gen / game loops with before/after proof | `examples/04-ui-loop/`, `examples/08-loop-types/` |

The flagship is the first one. Agents just learned to act on screens at
scale; every one of them needs an independent eye that watches the
recording and says what actually happened. That is the whole category.
