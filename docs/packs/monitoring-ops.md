# Pack: monitoring and ops

Point a bounded monitor at a stream, a screen, or a folder that
recordings land in; describe the condition in plain language; get a
structured event the moment it appears — in a file, and on a webhook
your automation stack can consume.

## The recipe

```powershell
watch-skill loop monitor "screen:" "an error screen (like ERROR 502)" --interval 10 --max-checks 30
watch-skill loop monitor "D:\camera drops" "a person at the door" --max-checks 50
```

- Bounded by design: `--max-checks` means a monitor always terminates.
- Folder mode consumes each new video once, oldest first; live targets
  sample `--sample-seconds` every `--interval`.
- Every detection appends to `events.jsonl` under the monitor's
  directory — that file is the source of truth.

## Webhook delivery (for n8n/Zapier builders)

```powershell
$env:WATCHSKILL_WEBHOOK_URL = "https://your-n8n/webhook/watch-skill"
$env:WATCHSKILL_WEBHOOK_SECRET = "shared-secret"   # optional but do it
```

With the URL set, every event also POSTs as JSON:

```
POST <url>
Content-Type: application/json
X-WatchSkill-Event: monitor.detection
X-WatchSkill-Signature: sha256=<HMAC-SHA256 of the exact body bytes>
```

```json
{
  "monitor_id": "0edbdce4bdb9",
  "check": 2,
  "source": "screen:",
  "condition": "an error screen (like ERROR 502)",
  "detections": [
    {"timestamp": 0.46, "severity": "critical", "description": "ERROR 502 visible on the page"}
  ],
  "at": "2026-07-11T12:00:00+00:00"
}
```

Delivery is at-least-once: 3 attempts with 1 s / 3 s backoff, then it
gives up loudly on stderr — a dead receiver never kills the watch, and
`events.jsonl` has the event regardless. Verify authenticity on your
side by recomputing the HMAC over the raw body with the shared secret
(tests in `tests/loop/test_webhook.py` show the exact recipe).

## Live example

[`examples/08-loop-types/`](../../examples/08-loop-types/) runs a folder
monitor that stays silent on a healthy clip and fires a critical event
on an error clip — the same run this pack's numbers come from.
