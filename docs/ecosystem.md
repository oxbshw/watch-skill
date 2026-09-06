# Ecosystem

Where Watch Skill appears, sorted by what each kind of page actually is.

Three categories, and conflating them would be the dishonest part. A **tutorial
or walkthrough** somebody sat down and made is coverage. An **integration** is a
place the project plugs into something else. A **directory entry** generated
from this repository's own metadata is a mirror of what you are reading now —
useful for discovery, and not a review, an endorsement, or evidence that anybody
has adopted anything.

The root README carries a short selection from the first two. This page is the
whole collection.

Directories are maintained by their operators, so details there can lag a
release, and a page that is accurate today may describe an older version
tomorrow.

---

## Tutorials and guides

Independently written, with their own structure and worked examples rather than
a restatement of this repository's description.

| Source | What it covers | Language |
| --- | --- | --- |
| [Watch Skill 使用教程：让 Codex 看懂视频和录屏](https://www.opcchina.ai/?p=4329) | Step-by-step: wiring Watch Skill into Codex so it can read video and screen recordings. By 是非我, 2026-08-19, on OPC 中国. | Chinese |
| [Watch Skill: AI video analysis and video correction](https://en.aistacknav.com/watch-skill-ai-video-analysis-video-correction/) | Setup and operation guide with its own use cases, troubleshooting notes and checklists. | English |

## Video walkthroughs

| Source | | Language |
| --- | --- | --- |
| [Watch Skill walkthrough, part 1](https://www.bilibili.com/video/BV1XnNK6DEdr/) | Bilibili | Chinese |
| [Watch Skill walkthrough, part 2](https://www.bilibili.com/video/BV1eBKp6TEKh/) | Bilibili | Chinese |
| [Watch Skill 介绍](https://www.toutiao.com/article/7661205660444459574/) | Toutiao | Chinese |

These were supplied and reviewed by the maintainer. Bilibili returns HTTP 412 to
programmatic requests and Toutiao renders its article body client-side, so an
automated link check cannot read either — that is a property of those sites, not
a statement about the videos.

## Install and integration surfaces

Places you can reach the project from another tool.

| Surface | Install |
| --- | --- |
| [Agent Skills (skills.sh)](https://www.skills.sh/oxbshw/watch-skill/watch) | `npx skills add oxbshw/watch-skill -g` |
| [SkillsMP](https://skillsmp.com/creators/oxbshw/watch-skill) | Browse and install from the creator page |
| [PyPI](https://pypi.org/project/watch-skill/) | `pip install 'watch-skill[standard]'` |
| [MCP registry](https://registry.modelcontextprotocol.io) | `io.github.oxbshw/watch-skill`, for MCP clients that resolve from the registry |
| [GitHub Container Registry](https://github.com/oxbshw/watch-skill/pkgs/container/watch-skill) | `docker pull ghcr.io/oxbshw/watch-skill:1.4.0` |

Per-client setup for 26 agents — Claude Code, Cursor, Codex, Copilot, Gemini
CLI, Cline, Zed and the rest — is in [docs/agents/](agents/README.md).

## Directory and marketplace listings

Automated index entries. Their content is generated from this repository's
metadata, so they are a way to *find* the project and say nothing about its
quality. Being listed is not an endorsement, and none of these operators has
reviewed the project.

| Listing | |
| --- | --- |
| Agent Skills Hub | <https://agentskillshub.top/skill/oxbshw/watch-skill/> |
| Neuralbox | <https://neuralbox.tech/oxbshw-watch-skill> |
| MCP Central | <https://mcpcentral.io/servers/io.github.oxbshw/watch-skill> |
| MCP Markets | <https://mcpmarkets.com/en/mcp-servers/oxbshw-watch-skill> |
| Protodex | <https://protodex.io/servers/oxbshw-watch-skill.html> |
| Fossy | <https://fossy.dev/oxbshw/watch-skill> |
| OpenAI Suite | <https://openaisuite.com/oxbshw/watch-skill/> |
| Olud | <https://olud.ai/project/oxbshw-watch-skill.html> |
| Odel | <https://odel.app/modules/oxbshw/watch-skill> |
| F8W | <https://www.f8w.com/github/oxbshw__watch-skill/> |
| aaaa.fyi | <https://aaaa.fyi/mcp/oxbshw/watch-skill> |
| Jian AI Lab | <https://jianailab.com/en/projects/watch-skill> |

Some of these refuse automated requests, so a few could not be re-checked from
here; they are listed as supplied.

---

## Metrics

Read from the source rather than restated, because a number typed into a
document is wrong the day after it is typed. The root README carries live badges
instead.

Four different numbers get confused with each other, so they are named
separately here:

| Number | What it counts | Where it comes from |
| --- | --- | --- |
| **PyPI downloads** | `pip install watch-skill` resolutions, including CI and mirrors | the `pypi/dm` badge |
| **Skills installs** | installs recorded by skills.sh for the Agent Skills entry | the skills.sh badge |
| **npm downloads** | `@deepwatch/*` registry fetches | nothing yet — the scope is unpublished |
| **GitHub stars** | people who starred this repository | the GitHub API |

None of them is a user count, and none of them substitutes for another. An
`npx` invocation is an npm download; a Skills install is not; a mirror
re-fetching a wheel is a PyPI download and is not a person.

## Adding to this page

If you have written something, open a pull request adding a row with the URL,
one line on what it covers, and the language. Coverage goes in the first two
sections, a directory entry in the last. Nothing here is paid for, exchanged, or
solicited.
