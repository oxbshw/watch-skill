# Pack: content creators

The first fifteen seconds decide whether anyone stays. Watch Skill
scores them from measurements, not vibes.

## The recipe

```powershell
watch-skill watch "my-draft-cut.mp4"
watch-skill extract hook <video_id> --seconds 15
```

Four measured axes, each with an actionable critique: attention trigger
in the opening line, speech pacing (words/second against the range that
retains), visual change rate, on-screen text presence — plus a combined
0–100 score and a verdict. The per-axis critiques are the useful part;
"weak: the opening line carries no question, promise, or stake" tells
you what to reshoot.

```powershell
watch-skill extract chapters <video_id>
```

Auto-chapters with timestamps from scene cuts + topic shifts — paste
into the description, or use them to find the section that drags.

## The review page

```powershell
watch-skill viewer <video_id> -o review.html
```

One self-contained HTML file: timeline, key frames, transcript, and
every question you asked about the cut with its evidence. Send it to a
collaborator; it opens offline in any browser.

## Comparing cuts

Index both cuts, then ask across them:

```powershell
watch-skill batch "D:\cuts"
watch-skill library ask "which cut shows the product earlier?"
```

Live example: [`examples/10-structured-extraction/`](../../examples/10-structured-extraction/)
(hook analysis with the four axes on a real run).
