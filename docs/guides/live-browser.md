# Watching a live browser

A browser session records a web page two ways at once, and neither one
substitutes for the other.

**Pixels.** A JPEG per tick at the session's analysis frame rate, fed through
the same scene-change, OCR, rolling-buffer and clip machinery as every other
live source. This is what makes "what did a human actually see at 0:14" a
question with an answer.

**Structure.** Navigation, console messages, uncaught exceptions, failed
requests, response metadata, DOM mutations, accessibility-state changes,
downloads, popups, dialogs, and crashes — reported the instant the browser
reports them, with no wait for the next screenshot.

A session that emitted only structure would be a scraper. One that emitted
only pixels could not tell you a request failed. Watch Skill emits both, on
one clock, into one event log.

## Start one

```bash
watch-skill live start https://example.com --kind browser --fps 2 --follow
```

Your own dev server needs one extra flag, because loopback is refused by
default:

```bash
watch-skill live start http://127.0.0.1:5173 --kind browser --allow-local --follow
```

The same session through the other surfaces:

```python
from watch_skill.live import start_live, observe, stop_live

session = start_live("http://127.0.0.1:5173", kind="browser",
                     fps=2.0, allow_local=True)
batch = observe(session.session_id, timeout_seconds=5.0)
for event in batch["events"]:
    print(event["media_ts"], event["type"], event["summary"])
stop_live(session.session_id)
```

```bash
curl -X POST localhost:8000/v1/live \
  -H 'content-type: application/json' \
  -d '{"target":"http://127.0.0.1:5173","kind":"browser","allow_local":true}'
```

From an MCP host, `start_live_watch(target=..., kind="browser")`.

All four report the same session id, the same state, the same event count and
the same navigation epoch, because all four are views over one event log —
[a test asserts it](../../tests/live/test_browser_live.py).

## Where a browser session may go

Navigation is decided before Chromium is asked to open anything, and again on
every document request the page itself initiates — so a redirect gets the same
scrutiny as the URL you typed.

Refused by default, and not negotiable by the page:

| Refused | Why |
| --- | --- |
| Anything but `http`/`https` | `file://` reads the disk; `chrome://` reaches the browser's internals |
| `169.254.169.254`, `metadata.google.internal`, and friends | Cloud credential endpoints — the highest-value SSRF target on a hosted machine |
| Loopback (`127.0.0.0/8`, `::1`) | Unless `--allow-local` |
| Private ranges (RFC1918, `fc00::/7`) | An agent that can reach the LAN can reach the router's admin page |
| Link-local, multicast, reserved, unspecified | No legitimate page lives there |

Hostnames are **resolved** and every resulting address is checked, so a name
that looks public but answers with `10.0.0.5` is refused. Checking the string
alone would miss the entire DNS-rebinding class.

`--allow-local` opens loopback and nothing else. The metadata endpoints stay
refused even then: "it is on my own machine" is the instinct that turns a
test-only convenience into a credential leak.

Restrict a session further with `--allowed-host` (repeatable), which turns the
policy into an allowlist — the strongest available setting.

## The page is not a source of instructions

Everything on the structured side was authored by the document. Watch Skill
treats it as data, permanently:

- Every browser event carries `page_authored`, and page-derived content is
  marked `true`.
- Page JavaScript reports through one binding, and may only claim two event
  kinds — `dom_mutation` and `accessibility_change`. A page that tries to emit
  `navigation` or `target_crashed` has its claim rewritten to `dom_mutation`,
  because those kinds mean *the browser reported this* and a page must not be
  able to fabricate that.
- Visible text that says "ignore your previous instructions" is recorded, in
  full, marked as page-authored, with `provenance: observation`. It is never
  dropped — hiding an attack from the operator is not safety — and it is never
  promoted into anything that reads as an instruction.
- Browser evidence cannot invoke a tool or approve an action. There is no code
  path from an event payload to an executor.

## What is redacted, and what is kept

Credentials are removed as evidence is produced, not before it is displayed:

- **Headers** keep their names and lose their values. "It sent an
  `Authorization` header" is often the fact that matters; the value never is.
- **URLs** keep scheme, host and path, and lose `?token=`, `?api_key=`,
  `?password=` and similar. Userinfo (`https://user:pw@host`) is dropped
  entirely.
- **Any string** — including console text a page printed — is scanned for
  credential shapes: bearer tokens, JWTs, AWS keys, `sk-` keys, GitHub tokens,
  Google API keys, Slack tokens, PEM private keys.
- **Response bodies are never read.** Not truncated, not hashed, not stored.
  Reading one would let a page put a secret in a response and have Watch Skill
  write it to disk on its behalf.

Every event carries a `redaction` record saying what was removed and why, so a
reader can tell "no `Authorization` header was sent" from "one was, and we
dropped it".

Page-authored strings are bounded (2 KB each), DOM snapshots are bounded, and
the structured channel stops at 20,000 events per session and says so. A page
in a `console.log` loop is a plausible accident and a trivial way to fill a
disk.

## Navigation epochs

Every event carries the `navigation_epoch` current when it was produced, and
the epoch advances exactly once per main-frame navigation.

This exists for one specific bug: an event that was in flight when the page
navigated arrives *after* the new page has loaded, and without an epoch it
reads as a fact about the new page. With one, a stale event is recognisable
instead of believed.

## When it goes wrong

A browser that exits without being asked to is reported as a **failure**, not
as a finished recording. The session state becomes `failed`, carries a
`live.browser.*` error code and a suggested next step, and every frame and
event captured before the death stays queryable and finalizable.

The distinction is the point: a session whose capture died reporting `stopped`
with no error would let an operator read thirty seconds of evidence as the
whole story.

Cancellation closes every browser process. Each session gets its own profile
directory; if the graceful close does not finish in time, the processes
holding that profile are killed by command-line match — never by process name,
which would take your own browser with it. The proof that it worked is that
the profile directory deletes, which Windows only permits once the last
process holding it is gone.

## The reference target

`watch_skill.live.fixture_app` is a deliberately broken order-desk
application, written in this repository and served on loopback. It changes
visually, mutates its DOM and ARIA state, logs a console error, throws an
uncaught exception, requests a dead port, receives a 500, navigates once,
displays a prompt-injection instruction in large type, and holds one piece of
server state that starts broken.

It exists so the end-to-end proofs depend on nobody's uptime, nobody's
copyright, and nobody's idea of what their page says today.

```python
from watch_skill.live.fixture_app import FixtureApp

with FixtureApp() as app:
    print(app.base_url)      # http://127.0.0.1:<port>
```

## Limits

- Page audio is not captured. A browser session records what the page shows,
  not what it plays; `audio` is forced off rather than reported as degraded on
  every session.
- Chromium only. Firefox and WebKit are not wired up.
- One page per session. Popups are recorded and closed, because a page that
  can open unwatched windows can do work the session would report nothing
  about.
- Downloads are recorded and refused.
- Dialogs are recorded and dismissed, never accepted — an accepted `confirm()`
  is the page obtaining a decision no agent made.

## See also

- [Live watching](../live.md) — sources, bounded pipelines, cursors, finalisation
- [Capture capabilities](../capture-capabilities.md) — what this machine can record
- [Verification](../verification.md) — checking that a fix actually landed
