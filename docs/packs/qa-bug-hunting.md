# Pack: QA and bug hunting

A screen recording of a bug is worth ten paragraphs of "steps to
reproduce" — once something can actually watch it.

## The recipe

```powershell
watch-skill watch "C:\recordings\bug repro.mp4"
watch-skill extract bug-report <video_id>
```

`extract bug-report` returns, deterministically from the index:

- the timestamp where the error signal appears,
- the exact frame (attach it to the ticket),
- the on-screen error text as OCR read it,
- the narration/steps that preceded the failure,
- `found: false` — honestly — when no error signal exists.

Follow-ups are free: `watch-skill ask <video_id> "what did the user
click right before the crash?"` answers from the index with timestamps.

## Verifying the fix

The same recording's criteria become the regression check:

```powershell
watch-skill loop start "http://localhost:3000/repro-path" "the error toast never appears" --script '<same steps>'
# fix, then:
watch-skill loop iterate <loop_id>
```

On pass you get a before/after MP4 + GIF — the artifact that closes the
ticket.

## Hand-off

`watch-skill viewer <video_id>` renders one offline HTML page — frames,
transcript, OCR, and every answered question with evidence — that any
reviewer opens in a browser with nothing installed.

Live example: [`examples/10-structured-extraction/`](../../examples/10-structured-extraction/)
(the ERROR 502 clip: bug report found=true with frame + timestamp).
