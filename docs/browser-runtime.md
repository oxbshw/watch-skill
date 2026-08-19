# Browser Runtime

Watch Skill has one browser subsystem with two modes.

| Mode | Question it answers |
| --- | --- |
| **Observer** | Somebody else did the work. Did it succeed? |
| **Operator** | Watch Skill does the work, and proves its own result. |

They share the page, the navigation policy, the resource lease, the per-session
profile, the navigation epochs and the evidence log. Only the question differs.
There is deliberately no second browser stack: two stacks would mean two lease
accountings, two policies and two sets of evidence that could disagree about
what happened.

## The invariant

> Dispatching an action is not the same as proving its effect.

Playwright returning from `click()` proves a click was delivered to an element.
It proves nothing about the application. So the shape of every step is:

```
observe → resolve → dispatch → observe → verify → receipt
```

Dispatch sits in the middle, not at the end. The two observations bracket the
action, their difference is the *effect*, and the verdict is that effect
compared against an expectation written down beforehand.

An action with no expectation is `UNVERIFIED`, never `SUCCEEDED`. "The agent
said it worked" is the failure this subsystem exists to catch, and the runtime
is not exempt from it.

## Layers

```
                    trusted
  goal ──────────────────────────────► plan (person, script, or model)
                                          │
  ┌───────────────────────────────────────▼──────────────────────────────┐
  │ deterministic runtime                                                │
  │   target resolution · dispatch · retries · timeouts · idempotency    │
  │   resource leases · session lifecycle · evidence · policy            │
  └───────────────────────────────────────┬──────────────────────────────┘
                                          │
                                    ┌─────▼─────┐
                                    │  browser  │
                                    └─────┬─────┘
                                          │
                    untrusted             ▼
             page text · DOM · OCR · console · network
                                          │
                                          ▼
                                     observation
                                          │
                                          ▼
                                      evidence
                                          │
                                          ▼
                              reasoning (model, optional)
```

A model may choose *which* action to take and may read the resulting evidence.
It never decides whether an action worked, and nothing it reads can change the
policy, the plan or the permitted action set.

## Target resolution

Tried in this order, and the order is the design:

| Strategy | Confidence | Survives |
| --- | --- | --- |
| element ref | 0.99 | the current page |
| role + accessible name | 0.95 | restyle, re-render, class churn |
| label | 0.93 | restyle, re-render |
| test id | 0.92 | restyle |
| placeholder | 0.85 | restyle |
| selector | 0.80 | some refactors |
| text | 0.70 | copy changes break it |
| visual | 0.55 | layout changes break it |
| coordinates | 0.40 | almost nothing |

Confidence is fixed per strategy. It is a statement about how durable the
*method* is, not a guess about a particular element, which is what makes the
number comparable across pages and runs.

Two rules:

- **Ambiguity is refused.** Several matches with no explicit index returns
  `found=False` with the count and samples, rather than acting on the first.
- **Irreversible actions need a strong match.** A `DESTRUCTIVE` action resolved
  below 0.75 is refused outright. A coordinate match is fine for scrolling and
  unacceptable for a button labelled "Delete account".

## Side effects and retries

Every action has a risk class, and it decides whether the runtime may repeat
the action on its own:

| Class | Repeat? | Examples |
| --- | --- | --- |
| `READ_ONLY` | yes | hover, scroll, wait |
| `REVERSIBLE` | yes | navigate, fill, select, check |
| `SIDE_EFFECTING` | **no** | click, press, upload — the default for a click |
| `DESTRUCTIVE` | **never** | anything irreversible |

A click defaults to `SIDE_EFFECTING`. Guessing lower would be the most
expensive wrong default in the subsystem: "it failed, so try again" is correct
for a search box and catastrophic for a payment button.

## Recovery

Failures are classified, not described, because recovery is a lookup:

| Failure | Deterministic response |
| --- | --- |
| `STALE_TARGET` | settle, re-observe, re-resolve |
| `TARGET_NOT_FOUND` | settle and retry — usually a race with a render |
| `TARGET_OBSCURED` | dismiss the overlay, retry |
| `DIALOG_BLOCKING` | dismiss the dialog |
| `NEW_TAB_CREATED` | switch to the tab the action opened |
| `NAVIGATION_TIMEOUT` | settle and retry |
| `VERIFICATION_FAILED` | settle and re-check |

Bounded at three attempts. `POLICY_REFUSED`, `TARGET_AMBIGUOUS`,
`FORM_VALIDATION_FAILED` and resource refusals are never retried — repeating
them cannot help. Whether a retry is permitted at all is decided by the risk
class *before* recovery is consulted.

Every recovery is recorded on the receipt that follows it, so a step that
succeeded on the second attempt cannot be mistaken for one that simply worked.

## Verification signals

An `Expectation` may require any combination of:

- the URL changing, or explicitly *not* changing
- URL or title content
- text present or absent
- a selector present or absent
- an element enabled or checked
- an input holding a specific value — proves a fill actually landed
- no console errors
- `network_ok` — every request correlated with the step returned under 400

`network_ok` is the one that catches a silent failure. Requests are correlated
by time window rather than by initiator, because Playwright will not say which
click caused which request and pretending otherwise would be a fiction in the
receipt. Query strings are stripped: a URL is evidence, a URL carrying a
session token is a leak.

## Untrusted input

Everything observed — page text, DOM, titles, link labels, OCR, console output,
model readings — is untrusted data. It is preserved verbatim as evidence,
because hiding an injection attempt loses the record of it, and it is fenced as
page-authored wherever it reaches a model context.

The structural defences matter more than the labelling:

- Actions are a **closed enum**. There is no field a page could populate that
  names a tool, a command or a shell.
- Uploads take an explicit file list from the caller. A page cannot ask for one.
- Script execution is not part of the public action surface.
- Verdicts come from deterministic oracles, never from a model.

## Observation

A snapshot is bounded — at most 60 interactive elements and 2000 characters of
text, with truncation reported rather than silent. Elements are named the way
the resolver looks them up (role and accessible name) so that a plan reading a
snapshot can address what it saw. The raw page stays in the browser; flooding a
context with every DOM node is how a browser agent spends its budget on markup
instead of on the task.

`delta()` produces the difference between two observations, which is what a
model should usually see: "Submit became enabled and the validation error went
away" rather than the whole page again.

## Perception tiers

Vision is a fallback, not the default mechanism.

| Tier | Cost | Used for |
| --- | --- | --- |
| 0 | negligible | structured browser state — role, name, value, enabled |
| 1 | low | OCR on a captured frame |
| 2 | medium | a targeted screenshot region |
| 3 | ~89 s on this hardware | local VLM inference |

Measured local VLM latency is roughly 89 seconds per inference on the reference
machine, which is why tier 3 must never sit in the path of an ordinary click.
Nothing in the operator loop calls it; it enriches evidence asynchronously
through the existing live-session semantic path, where a late result is
classified by freshness rather than blocking an action.

## Benchmark

```bash
python -m watch_skill.operate.benchmark --out build/benchmark
```

Nine tasks against a bundled local fixture site, each carrying a ground-truth
predicate read from the site's **server state** rather than from anything the
browser reported. The page can say whatever it likes; the server knows what
happened.

The headline metric is **false-success rate** — tasks where the runtime claimed
the goal was met and the server disagrees. Task success rate on its own counts
a confident wrong answer as a win, which is precisely the behaviour worth
measuring against.

Tasks that are *supposed* to fail — an ambiguous "Delete account", a save whose
request 500s — are scored correct when they are refused.
