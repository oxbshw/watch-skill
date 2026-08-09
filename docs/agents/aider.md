# Watch Skill in Aider

<img src="../assets/agents/aider.webp" alt="Aider avatar as a terminal printing frames on a receipt roll" width="360">

**Status: documentation-verified ☑ — via the CLI, not MCP.**

Aider has no MCP client. The RFC is open and the exploratory pull requests
were closed unmerged, so as of v0.86.x there is nothing to paste an
`mcpServers` block into. Anyone offering you one for Aider is describing a
third-party bridge, not Aider.

That is fine here, because the MCP server is a wrapper around a CLI that
Aider can already run.

## Install

```bash
uv tool install "watch-skill[standard]"   # or: pipx install "watch-skill[standard]"
watch-skill doctor
```

`watch-skill` needs to be on PATH, since Aider will shell out to it.

## Use it

Inside an Aider session, `/run` executes a command and offers its output to
the model as context:

```text
/run watch-skill watch "https://youtu.be/..." --detail balanced
```

Aider asks whether to add the output to the chat — say yes, and the report,
its timestamps, and the frame paths become part of the conversation.

Follow-ups do not re-process anything:

```text
/run watch-skill ask <video_id> "when does the checkout total go wrong?"
/run watch-skill search "pricing decision"
```

## A recording of a bug

The case Aider is good at — you have a screen recording of a failure and
want the fix in the same session:

```text
/run watch-skill extract bug-report <video_id>
```

That prints a fileable report with the exact frame and timestamp, which
Aider can then act on against the source.

## Notes

- Add `--transcript-only` when you want the words and not the frames; it
  skips the visual pass and is much faster.
- Output is markdown on stdout and progress on stderr, so `/run` picks up
  the report without the noise.
- If Aider ships an MCP client, this page becomes the fallback rather than
  the route — the same `watch-skill serve` every other client here uses will
  apply.
