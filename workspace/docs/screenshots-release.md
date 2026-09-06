# Release screenshots

Captured from clean rooms built only from sealed artifacts, with a provider
bound and a real Watch Core running over stdio. Every surface here is the
product doing the thing the caption says: nothing is seeded, no fixture stands
in for a record, and no result was edited.

**Which build.** Not all of these came from the same one, and saying "this
release" of all of them would not be true. Shots `01`–`08`, `10` and `11` were
taken from the `1.4.0` / `0.1.0` candidate on 2026-09-05. Shot `09` was retaken
on 2026-09-06, from the build this release ships, for the reason below. The
version panel in `04-health-and-versions.png` reads the versions that were
running when the shutter fell, and those did not change between the two.

**How they were made.** `deepwatch setup --artifacts <dir>` composed the room
from the twenty sealed tarballs; Watch Core was installed from the sealed wheel;
the provider credential was resolved by reference through
`dsh-credentials-local`'s own `path` config, so no plaintext secret was copied
anywhere. A provider-backed journey then created a file, read it back, verified
it, and was refused a write outside the workspace. These are photographs of that
run.

**One of these used to show a defect, and no longer does.**
`09-compare-two-records.png` was a photograph of a real failure: no execution
receipt carried the verdict Core had returned for it, so Compare showed two
rows reading `unchecked`. Keeping that shot was right while the defect was
open. It is closed — the ledger opens the Bridge's envelope, and a verification
the agent asked for is attested from its own result — so the shot has been
retaken from a build where it works, by
[`scripts/qa-compare-shot.mjs`](../scripts/qa-compare-shot.mjs), which refuses
to capture at all if the comparison still reads `unchecked`. Its sidecar
`09-compare-two-records.json` records the two records photographed and the
text the surface rendered, so the caption can be checked rather than trusted.

**What is deliberately absent.** No API key, token or credential appears on any
screen — the Models page masks the field and the Role Bindings page shows only
that a credential is *referenced*. No absolute host path appears either: the
product renders workspace-relative paths (`owner-test/totals.json`), which is
the redaction contract working rather than a crop.

The files are in [`docs/screenshots/release/`](screenshots/release/), captured at
1440×900 with a 2× device pixel ratio and resampled to 1920px wide.

| Shot | What it shows | Alt text |
| --- | --- | --- |
| `01-workspace-first-run.png` | First run, before any session: the orca mark, the four verbs, an honest readiness count and two ways forward. | DeepWatch first-run screen with the orca mark, the headline "See what happened. Prove what worked.", and an installation status showing two capabilities ready and ten needing setup. |
| `02-provider-ready.png` | Role Bindings with a real provider bound. Chat is Ready on OpenRouter; every perception role says Not configured rather than borrowing Chat's model. | DeepWatch Role Bindings settings. Chat is marked Ready with provider OpenRouter and model deepseek/deepseek-v4-pro. Visual perception, speech to text and audio understanding each read "Not configured". No credential is displayed. |
| `03-capability-readiness.png` | The readiness matrix. Ready, Degraded, Not tested, Unavailable and Not configured are five different answers, and each blocker names its own fix. | DeepWatch Diagnostics showing capability readiness: Watch Core Ready, Memory Degraded, Verification Not tested, Browser Unavailable with the pip command that would install it, Chat Ready, and the perception roles Not configured. |
| `04-health-and-versions.png` | Versions and health: the Harness baseline, Watch Core, the Bridge protocol range, the store schema, and the transport actually in use. | DeepWatch Diagnostics health panel listing DeepWatch 0.1.0, DeepSeek Harness 0.1.1-rc.2, Watch Core 1.4.0, Bridge protocol 1, Watch Core connected over stdio, and media upload consent not given. |
| `05-ordinary-task.png` | An ordinary request with no mention of Watch. The agent writes the file, reads it back, and answers 60 — and every path it touched is workspace-relative. | A DeepWatch session where the agent was asked to create owner-test/totals.json and report the sum. Write, Read and Pwsh tool rows each name owner-test/totals.json, and the answer states the file was created exactly as asked and the sum is 60. |
| `06-independent-verification.png` | Verification through the product's own tool: a contract Core ran, with each check's status and the contract digest. | A DeepWatch session showing a VERIFIED result card from watch_verify: two of two checks passed, one confirming owner-test/totals.json exists and one confirming /total equals 60, with the contract's sha256 digest. |
| `07-containment-refusal.png` | A request aimed outside the workspace, refused before it touched anything. | A DeepWatch session where the agent was asked to modify a file outside the workspace; the attempt is recorded as refused and the file was never changed. |
| `08-library-receipts.png` | The Library: every receipt this workspace recorded, searchable on the local host with no service and no model. | The DeepWatch Evidence Library, showing that search runs on the workspace's own host and offering filters by media type and verification state. |
| `09-compare-two-records.png` | Compare, with two of the verifications this run's agent asked for selected side by side — one that failed and the repair that passed. Each row names the verdict **Watch Core** returned: `watch_verify — FAILED` on the left, `watch_verify — VERIFIED` on the right. They are two different executions, so the tally counts them as *only on one side* rather than as a changed verdict; that is the comparison being literal, and the panel says so itself. Retaken 2026-09-06 at 82% zoom, because the whole comparison is taller than a 1080p window with the composer fixed to the bottom of it. | The DeepWatch Compare surface with two watch_verify records selected. The verification table reads matching 0, claim changed 0, verdict changed 0, only on one side 2, contradictory 0, unverifiable 0. Below it, one entry reads Right: watch_verify — VERIFIED and another reads Left: watch_verify — FAILED. |
| `10-perception-sources.png` | Perception sources: all local, none requested, each with the permission it would ask for at first use. | DeepWatch perception sources listing files, video, browser, screen, window, camera and microphone, each marked Local and Not requested, with the permission each would ask for. |
| `11-memory-off-by-default.png` | Memory, off until somebody turns it on. | The DeepWatch memory settings page showing memory is not enabled by default. |

## What these screenshots do not show

- **Compare with records, if the shot reads "no records to compare yet".** Compare
  is session-scoped and populated by selecting Watch tool rows in a conversation;
  a fresh session has nothing to compare, and the surface says so rather than
  inventing a pair.
- **Any perception capability doing perception.** Visual, speech and audio roles
  are unconfigured in this room, and the matrix says so. Configuring one needs a
  provider and model that actually serve that modality — see
  [provider-handoff.md](provider-handoff.md).
- **The desktop application.** `@deepwatch/desktop` is private and is not
  published by this release. The Electron shell starts and its context isolation
  holds — `npm run smoke:desktop` reports that — but there is no installer here
  to photograph.
