<!-- mcp-name: io.github.oxbshw/watch-skill -->
<div align="center">

<img src="workspace/docs/screenshots/release/01-workspace-first-run.png" alt="The DeepWatch first-run screen: the orca mark, the headline “See what happened. Prove what worked.”, and an installation status counting which capabilities are ready and which still need setup." width="88%">

# DeepWatch · powered by Watch Skill

**Your agent can act. This is how you find out what it actually did.**

DeepWatch is a local-first agent workspace that watches every tool call, keeps
timestamped evidence, and proves outcomes with deterministic checks instead of
the agent's own summary. Watch Skill is the engine underneath it — perception,
evidence and verification for *any* agent, through MCP, a CLI or a REST API.

[![CI](https://github.com/oxbshw/watch-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/oxbshw/watch-skill/actions/workflows/ci.yml)
[![Workspace](https://github.com/oxbshw/watch-skill/actions/workflows/workspace-ci.yml/badge.svg)](https://github.com/oxbshw/watch-skill/actions/workflows/workspace-ci.yml)
[![Install](https://github.com/oxbshw/watch-skill/actions/workflows/install.yml/badge.svg)](https://github.com/oxbshw/watch-skill/actions/workflows/install.yml)
<br>
[![PyPI](https://img.shields.io/pypi/v/watch-skill?label=watch-skill)](https://pypi.org/project/watch-skill/)
[![npm](https://img.shields.io/npm/v/%40deepwatch%2Fcli?label=%40deepwatch%2Fcli)](https://www.npmjs.com/package/@deepwatch/cli)
[![Downloads](https://img.shields.io/pypi/dm/watch-skill?label=pypi%20downloads)](https://pypi.org/project/watch-skill/)
[![Python](https://img.shields.io/pypi/pyversions/watch-skill)](https://pypi.org/project/watch-skill/)
[![License](https://img.shields.io/github/license/oxbshw/watch-skill)](LICENSE)

</div>

---

## Two ways in

|  | You want | Start here |
| --- | --- | --- |
| 🐋 | **The whole workspace.** A browser agent workspace with evidence, verification and containment built in. | [Run DeepWatch](#run-deepwatch) |
| 🔌 | **Just the engine.** Give the agent you already use eyes, memory and a way to check its own work. | [Add Watch Skill](#add-watch-skill-to-an-agent-you-already-use) |

Both are the same evidence engine. DeepWatch is what it looks like when the
whole product is built around it.

---

## Run DeepWatch

DeepWatch composes the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
through plugins and overlays. It is not a fork, and it does not pick your model.

```bash
npm install -g @deepwatch/cli
deepwatch setup                       # builds the runtime and composes the profile
deepwatch web --workspace ./my-project
```

`--workspace` names the one directory the agent's files, the shell, containment,
the verifier, receipts and the Library all resolve against. A run that cannot
establish it stops with a named fix rather than guessing.

**Connect a model.** Nothing reaches a provider until you say so. Open
**Settings → Models**, add any hosted route or an OpenAI-compatible local server
(Ollama, vLLM, LM Studio, llama.cpp — a base URL you supply), then bind it in
**Role Bindings** and press **Run provider test**. That one bounded request is
what turns a binding Ready; saving a key never does.

```bash
deepwatch doctor        # what is installed, what is missing, and how to fix each
```

Requires Node ≥ 22.19 and Python ≥ 3.11. Windows, macOS and Linux.

## Add Watch Skill to an agent you already use

```bash
pip install watch-skill            # or: uv tool install watch-skill
watch-skill doctor                 # checks ffmpeg, yt-dlp and friends
watch-skill watch <video-url-or-file>
watch-skill ask <id> "what changed at 3:12?"
```

Wire it into any MCP client:

```bash
watch-skill serve                  # stdio MCP server
```

Or install the skills into 25+ agents at once:

```bash
npx skills add oxbshw/watch-skill -g
```

Full walkthrough: [docs/getting-started.md](docs/getting-started.md).

---

## What it looks like

<div align="center">
<img src="workspace/docs/screenshots/release/05-ordinary-task.png" alt="The DeepWatch workspace: an agent session showing Write, Read and Pwsh tool rows, each naming a workspace-relative path, and an answer confirming the file contents and the calculated total" width="90%">
</div>

An ordinary request. The agent wrote a file, read it back and answered — and
every path on screen is workspace-relative, because a record that carries your
home directory is a record you cannot share.

Every image on this page is a photograph of this release, taken in a clean room
built only from its sealed artifacts, with a real provider bound and Watch Core
running over stdio. Nothing is seeded, mocked or retouched. What each one shows
and what it deliberately does not:
[release screenshots](workspace/docs/screenshots-release.md).

<table>
<tr>
<td width="50%"><img src="workspace/docs/screenshots/release/06-independent-verification.png" alt="A watch_verify result card reading VERIFIED, with two of two checks passed and the contract's sha256 digest" width="100%"></td>
<td width="50%"><img src="workspace/docs/screenshots/release/08-library-receipts.png" alt="The DeepWatch evidence Library, showing that search runs on the workspace's own host with filters for media type and verification state" width="100%"></td>
</tr>
<tr>
<td align="center"><b>Independent verification.</b> A contract Core ran, not a claim the model made.</td>
<td align="center"><b>The Library.</b> Every receipt, searchable locally. No service, no model.</td>
</tr>
<tr>
<td width="50%"><img src="workspace/docs/screenshots/release/07-containment-refusal.png" alt="A DeepWatch session where a write aimed outside the workspace is recorded as refused and the file was never changed" width="100%"></td>
<td width="50%"><img src="workspace/docs/screenshots/release/03-capability-readiness.png" alt="DeepWatch Diagnostics capability readiness, distinguishing Ready, Degraded, Not tested, Unavailable and Not configured, each with its own named fix" width="100%"></td>
</tr>
<tr>
<td align="center"><b>Containment.</b> Refused before the side effect, and recorded as refused.</td>
<td align="center"><b>Honest readiness.</b> Five different answers, never one optimistic one.</td>
</tr>
</table>

More, with what each one shows: [workspace/docs/screenshots-release.md](workspace/docs/screenshots-release.md).

---

## What DeepWatch adds

| | |
| --- | --- |
| **Automatic observation** | Every tool call is recorded without the model choosing to record it. A capability that depends on the model remembering it exists is a suggestion. |
| **Canonical receipts** | One execution, one receipt. A denial is permanent; a terminal state is final; progress only moves forward. |
| **Independent verification** | `watch_verify` runs a contract of deterministic checks and returns a verdict Core owns. `UNVERIFIED` is a real answer, not a failure. |
| **Workspace containment** | One canonical root shared by the agent's tools, the shell, the verifier, receipts and the Library. Outside it is refused before the side effect. |
| **The Library** | Local search over every receipt and every piece of evidence. Nothing leaves the machine. |
| **Compare** | Two records side by side, computed rather than reasoned about. |
| **Provider freedom** | 37 hosted routes plus any OpenAI-compatible endpoint you run. DeepSeek is one option and is never selected for you. |
| **Redaction by contract** | Records carry workspace-relative paths. Absolute host paths do not reach the Library, an export, or model context. |

## What Watch Skill provides

| | |
| --- | --- |
| **Video understanding** | Acquire → scenes → frames → OCR → transcript → index, with every answer citing a timestamp. |
| **Audio and speech** | Transcription with timings a citation can point at. |
| **Screen and browser** | A supervised browser that acts and returns a receipt. |
| **Evidence** | Durable, timestamped, addressable — and separable from any claim made about it. |
| **Verification** | 14 deterministic check types, run in an isolated child process. |
| **Memory** | Durable, correctable, scoped, with provenance on every record. Off by default. |
| **Surfaces** | MCP, CLI, REST, and the Bridge that DeepWatch speaks. |

### Three tool counts, three different questions

Numbers that are easy to conflate, so they are stated separately:

| Count | What it is |
| --- | --- |
| **39** | Watch Skill's standalone **MCP tools** — what any MCP client gets from `watch-skill serve`. |
| **22** | DeepWatch's **`watch_*` agent tools** — the Watch capabilities added to an agent inside the workspace. |
| **47** | The **whole tool set** a DeepWatch agent is offered — upstream Harness tools plus those 22. |

---

## Observe → understand → act → verify

```mermaid
flowchart LR
  O["**Observe**<br/>video · audio · screen<br/>browser · tool calls"]
  U["**Understand**<br/>scenes · transcript<br/>OCR · index"]
  A["**Act**<br/>the agent works<br/>inside one workspace"]
  V["**Verify**<br/>deterministic checks<br/>Core owns the verdict"]
  E[("Evidence<br/>timestamped · local")]

  O --> U --> A --> V
  O -.-> E
  U -.-> E
  A -.-> E
  V -.-> E
  V -->|"UNVERIFIED<br/>needs more evidence"| O
```

The loop closes on evidence, not on the agent's opinion. A critique is not a
verdict; only a contract evaluated against evidence moves a record off
`UNVERIFIED`.

## Architecture

```mermaid
flowchart TB
  subgraph Clients["Any agent"]
    MCP["MCP clients<br/>Claude · Codex · Cursor · 25+"]
    CLI["CLI · REST"]
  end
  subgraph DW["DeepWatch workspace"]
    H["DeepSeek Harness<br/><i>upstream, not forked</i>"]
    P["@deepwatch/* plugins<br/>20 packages"]
  end
  subgraph WS["Watch Skill engine"]
    B["Bridge<br/>(stdio)"]
    C["Core<br/>perception · evidence · verification"]
  end
  MCP --> C
  CLI --> C
  H <--> P
  P --> B --> C
  C --- S[("Local evidence store")]
```

Details: [docs/architecture.md](docs/architecture.md) ·
[workspace/docs/architecture.md](workspace/docs/architecture.md).

---

## Your models, your machine

- **No provider is required to start.** Perception, verification, the Library and
  the browser all work with no model configured at all.
- **Local models are a base URL**, not a separate feature — Ollama, vLLM,
  LM Studio and llama.cpp are OpenAI-compatible endpoints you supply.
- **A capability is assigned per role.** Chat, visual perception, speech and
  embeddings are bound separately; a role with nothing assigned says so and never
  borrows another role's model.
- **A credential is referenced, never held twice.** Keys live in the Harness's own
  store; Watch keeps no second one and never sees a key.

## Security, privacy and containment

- **Local-first.** Indexing, search, memory and verification run on your machine.
- **Offline-only is a setting, and it is separate from holding a key.** A provider
  credential is not permission to upload a frame, a transcript or a capture; media
  egress needs its own consent, and no agent can change either from inside a session.
- **Permissions at first use.** Screen, window, camera and microphone are requested
  when a capability is first used, never on page load.
- **Containment before the side effect.** A path outside the workspace is refused,
  and the refusal is what gets recorded.
- **Redaction is structured.** Named path fields are converted; evidence, transcripts
  and your own messages are never rewritten.

Full boundaries: [SECURITY.md](SECURITY.md) ·
[workspace/docs/known-limitations.md](workspace/docs/known-limitations.md).

## Honest readiness

Not everything is on by default, and the product says which is which rather than
showing a plausible default.

| Capability | State out of the box | To enable |
| --- | --- | --- |
| Watch Core, verification, containment, Library | **Ready** | nothing |
| Chat | **Ready once bound** | add a provider, bind the role, run the provider test |
| Video, OCR, transcript indexing | **Ready** | `ffmpeg` (`watch-skill doctor` installs it) |
| Browser / THE LOOP | **Optional** | `pip install 'watch-skill[loop]' && playwright install chromium` |
| Visual perception, speech, audio, embeddings | **Not configured** | bind a model that actually serves that modality |
| Memory | **Off** | enable it in Settings; the store is plaintext and says so |
| Desktop app | **Not distributed in this release** | run the Web workspace |

There is no self-healing, no automatic task resumption, no autonomous learning
and no encryption in this release.

---

## Works with your agent

Watch Skill installs into 25+ agents — Claude Code, Codex, Cursor, Copilot,
Gemini CLI, Cline, Windsurf, Zed, JetBrains, Aider, Goose, OpenHands and more —
as skills, as an MCP server, or both.

```bash
npx skills add oxbshw/watch-skill -g
```

Per-client setup and verification status: **[docs/agents/](docs/agents/README.md)**.

### Why skills *and* MCP

MCP gives an agent the tools. Skills give it the judgement about when to reach
for them — which is the difference between a capability being present and it
being used. The agent matrix above splits its clients along exactly that line:
[MCP clients](docs/agents/README.md#mcp-clients) and
[plugin and skill-native agents](docs/agents/README.md#plugin-and-skill-native-agents).

## Proof, not adjectives

Measured on the same files with the same scorer, against a leading
video-understanding API:

| | Watch Skill | Baseline |
| --- | --- | --- |
| Written-analysis groundedness | **89.7%** | 27.9% |
| Citations per 100 words | **13.23** | 0.12 |
| Frame delivery on real footage | **96.9%** | 31.2% |
| Cue starts within half a second | **100%** | 25% |

Method, fixtures and the full seven axes:
**[benchmarks/video_backends/](benchmarks/video_backends/README.md)** ·
[cost policy](docs/cost.md) · [VLM performance](docs/vlm-performance.md) ·
[release proof](docs/release-proof.md).

---

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, first watch, first agent connection |
| [Tool reference](docs/tools/README.md) | All 39 MCP tools and their REST/CLI counterparts |
| [Configuration](docs/configuration.md) | Storage, privacy, models, limits, environment |
| [Verification](docs/verification.md) | Contracts, check types, assurance levels, attestations |
| [Agent matrix](docs/agents/README.md) | Per-client setup and verification status |
| [Use-case packs](docs/packs/README.md) | Research, meetings, QA, content, operations |
| [THE LOOP](docs/guides/the-loop.md) | Capture, critique, iteration, proof artifacts |
| [Troubleshooting](docs/troubleshooting.md) | Dependency repair and common runtime errors |
| [Comparison](docs/comparison.md) | Honest trade-offs against the alternatives |
| [Ecosystem](docs/ecosystem.md) | Where this project appears, and which of it is coverage |
| **DeepWatch** | [workspace README](workspace/README.md) · [setup](workspace/docs/setup.md) · [releasing](workspace/docs/releasing.md) · [known limitations](workspace/docs/known-limitations.md) |

### Twenty runnable examples

Each one is a directory you can run, with its prerequisites and expected output
written down next to it.

| | |
| --- | --- |
| Learn the core | [01 Watch and ask](examples/01-watch-and-ask) · [02 Focused moment](examples/02-focused-moment) · [03 Cross-video search](examples/03-cross-video-search) |
| Build with agents | [06 MCP and REST](examples/06-agent-integration) · [09 Framework adapters](examples/09-framework-adapters) · [15 Private offline workflow](examples/15-private-offline-workflow) |
| Understand and organise | [05 Multilingual Arabic](examples/05-multilingual-arabic) · [10 Structured extraction](examples/10-structured-extraction) · [11 Batch mode](examples/11-batch-mode) · [12 Library memory](examples/12-library-memory) |
| Verify and improve | [04 UI loop](examples/04-ui-loop) · [07 Lessons and stats](examples/07-lessons-and-stats) · [08 Loop types](examples/08-loop-types) · [13 Self-improvement](examples/13-self-improvement) · [14 Browser verification](examples/14-browser-verification) · [17 Freshness and offline](examples/17-freshness-and-offline) · [20 Observer loop](examples/20-observer-loop) |
| Watch live | [18 Live watch](examples/18-live-watch) · [19 Live browser](examples/19-live-browser) |
| Share results | [16 Export a self-contained viewer](examples/16-shareable-viewer) |

The catalogue lists all 20 examples with their prerequisites and expected
output: **[examples/](examples/README.md)**.

## Written by other people

Independent guides, with their own examples:

- [Watch Skill 使用教程：让 Codex 看懂视频和录屏](https://www.opcchina.ai/?p=4329) —
  wiring Watch Skill into Codex, step by step (Chinese)
- [Watch Skill: AI video analysis and video correction](https://en.aistacknav.com/watch-skill-ai-video-analysis-video-correction/) —
  setup, operation and troubleshooting

Watch Skill is also indexed by a number of directories and registries. Those
entries are generated from this repository's metadata, so they are a way to find
the project rather than a review of it — the full list is in
[docs/ecosystem.md](docs/ecosystem.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for the gate suite and the standards a change is held to. Security reports:
[SECURITY.md](SECURITY.md).

---

<div align="center">

**Watch Skill** `1.4.0` · **DeepWatch** `0.1.0` · Released under the
[MIT License](LICENSE) · Built by [oxbshw](https://github.com/oxbshw)

DeepWatch is built on DeepSeek Harness and powered by Watch Skill. It is an
independent project and is not affiliated with or endorsed by DeepSeek.

</div>
