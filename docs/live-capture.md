# Live capture: permission and lifecycle

What a capture session does, when it asks for anything, and what it guarantees
about releasing what it took.

## Nothing happens on load

Opening the Live page starts nothing and asks for nothing. That is not a
courtesy, it is the design: a page that asks for the camera because someone
opened a tab teaches people to click Allow without reading, and after that every
later prompt is worth nothing.

Permission is requested by exactly one thing — an explicit start. The view
renders state; it cannot originate one. `CaptureSession.start()` refuses outright
unless permission was already granted:

```
state before anything      idle
start without permission   refuses, state becomes denied
requestPermission()        true
start()                    active
```

The refusal carries its reason: *"Start needs permission, and permission is only
ever asked for by an explicit action."*

## States

```
idle ─▶ requesting_permission ─▶ starting ─▶ active ⇄ paused
                │                    │          │
                ▼                    ▼          ▼
             denied            unavailable   stopping ─▶ stopped
                                 timed_out
                                  failed              cancelled
```

Each terminal state means something different, and conflating them is how a
missing capability comes to look like a broken one:

| State | Means |
| --- | --- |
| `denied` | a person said no, or start was attempted without asking |
| `unavailable` | the source is not present on this machine |
| `timed_out` | the source accepted the start and never began |
| `failed` | the source raised an error |
| `cancelled` | stopped before it ever became active |
| `stopped` | ran, and was ended deliberately |

## Sources

Seven, each declaring the permission it would ask for:

| Source | Asks for | Can act |
| --- | --- | --- |
| Screen | screen capture, at first start | no |
| Window | screen capture, at first start | no |
| Camera | camera, at first start | no |
| Microphone | microphone, at first start | no |
| Browser Observer | no OS permission; needs the browser runtime | no |
| Browser Operator | no OS permission; needs the browser runtime | **yes** |
| Synthetic | nothing; observes only content this workspace made | no |

**Exactly one source can act on the world**, and it is a separate source from
the one that watches. A single "browser" switch would grant acting to someone
who believed they were enabling watching. Every side effect the operator causes
carries an idempotency key, so a retried command cannot press a button twice.

A test asserts the count is exactly one. Adding a second acting source is a
decision that has to be made deliberately.

## Releasing

The guarantee: **a session that stops, or is cancelled, or fails, releases its
adapter.** Not "usually" — the state machine has one teardown path and every
terminal state goes through it.

One case needed its own handling. Cancelling *during startup* ran teardown
before the adapter had allocated anything; the once-guard then blocked the
cleanup that mattered when the adapter finished starting a moment later. The
late-start path now stops the adapter directly:

```ts
if (this.finished) {
  try { await this.#adapter.stop() } catch { /* … */ }
  return false
}
```

`tests/live-capture.test.mjs` covers this, and `SyntheticSource` exposes
`emitted`, `releases` and `running` specifically so a leak can be asserted
rather than assumed.

## What a capture produces

Observations, and a receipt. The receipt counts what was seen and when it ran.

**It asserts no verdict.** A capture is evidence of what was displayed or said;
whether the thing being claimed is true is a separate question with a separate
answer, and only Watch Core answers it (ADR-002). The end-to-end check asserts
the string `VERIFIED` appears nowhere in a receipt.

## Observed content is data

Everything a capture reads — text on a page, characters recognised from a frame,
words transcribed from audio — is evidence of what was displayed. It is never an
instruction, whatever it says. `tests/security.test.mjs` runs a corpus of
hostile strings through every entry point, so a new door added later gets the
same corpus without anyone remembering to wire it up.
