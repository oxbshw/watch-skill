# Manual test checklist

Both applications are running when this is handed over. Nothing here requires a
build, an install, or a terminal — open the app and follow the path.

Every item has three parts: **the path** you take, **what should happen**, and
**what counts as a bug**. The third is the important one. This product exists to
tell the difference between a thing that says it worked and a thing that did,
so "the screen looked right" is never the pass condition on its own.

## Before you start

| | |
|---|---|
| **Web** | http://127.0.0.1:8931 — open it in any browser |
| **Desktop** | already open as a window; if you closed it, run `npx electron .` in `G:/watch-workspace/apps/desktop` |
| **Demo data home** | `G:/watch-manual/dsh-home` |
| **Fixtures** | `G:/watch-manual/dsh-home/watch-fixtures` |
| **Logs** | `G:/watch-manual/logs` |

Everything seeded is marked `demo: true` and prefixed `DEMO:`. If you see a
record that looks real and is not marked, **that is a bug** — it means something
minted data outside the seeding path.

Both apps run **offline-only**. There is no provider key configured. A model
reply is not expected; a *refusal to reach the network* is.

---

## A. It opens, and it is the real DSH

**A1 — Web loads.** Open http://127.0.0.1:8931.
*Expect:* the DeepSeek Harness workspace, with a Watch section in the sidebar.
*Bug if:* a blank page, a stack trace, or a UI that is clearly not DSH. The
whole design is that Watch is a layer on the official app — a second, Watch-only
UI would be a serious architectural bug, not a cosmetic one.

**A2 — Upstream still works.** Find the stock DSH surfaces: Sessions, Settings,
Models/Providers, Plugins, Trajectory.
*Expect:* present and navigable, unchanged.
*Bug if:* any official surface is missing, disabled, or replaced by a Watch
version. Watch is only ever allowed to *add*.

**A3 — Desktop is the same app.** Compare the Desktop window with the browser.
*Expect:* the same workspace. Desktop adds a native shell, not a different
product.
*Bug if:* Desktop shows a different UI, or a different set of modes.

**A4 — Desktop is not a browser.** In the Desktop window, try to navigate away —
paste an external URL if any address affordance exists.
*Expect:* nothing external opens inside the window.
*Bug if:* Desktop navigates to any origin other than its own Host.

---

## B. The seven modes

The modes are Agent, Watch, Live, Memory, Library, Compare, Trajectory.

**B1 — Every mode opens.** Visit each in turn.
*Expect:* each opens without error, and the session context carries across —
switching modes does not start a new session or lose your place.
*Bug if:* a mode throws, or switching modes resets the session.

**B2 — A mode that cannot work says so.** Live and parts of Library depend on
capabilities that are not present on this machine (no GPU, no provider).
*Expect:* a **degraded** state that names the missing capability and what it
would take to enable it.
*Bug if:* a mode is silently empty, or presents itself as fully working when its
capability is absent. An empty panel with no explanation is a bug here, not a
blank slate.

**B3 — The inspector follows selection.** Select anything with a record behind
it and open the right-hand inspector.
*Expect:* panels for the selected thing — evidence, provenance, verification,
timing.
*Bug if:* the inspector shows a different record than the one selected, or keeps
showing a stale one after selection changes.

---

## C. Evidence and the verdict — the core claim

This is the section that matters most. Fixtures for it are in
`G:/watch-manual/dsh-home/watch-fixtures`.

**C1 — A citation resolves to an exact place.** Open `01-recorded-source.json`
through the Library / evidence surface.
*Expect:* the citation points at a specific source revision and a specific time
range (252.0s–252.5s), not at "the video".
*Bug if:* a citation resolves to a whole document, or to a *translated* or
*normalized* form of the text. The original is the evidence. A citation landing
on a translation is a serious bug.

**C2 — VERIFIED looks different from complete.** Open `03-verified.json` and
`05-unverified.json` side by side.
*Expect:* visibly and textually different. Every verdict carries a word, not
only a colour or an icon.
*Bug if:* they render the same, or the difference is colour-only. Colour-only is
an accessibility bug and a truthfulness bug at once.

**C3 — The false success.** Open `04-browser-false-success.json`. This is the
scenario the product exists for: the page said "Saved successfully" and the
server returned 500.
*Expect:* the **headline is the failure**. The page's own claim appears as
observed content, clearly subordinate. The receipt says the action was
`dispatched`; the verdict says it did not succeed.
*Bug if:* the surface leads with "Saved successfully", or presents the page text
and the verdict as equally weighted. **This is the single most important check
in this document.** If the UI lets the page's claim win, nothing else matters.

**C4 — Stale is not the same as wrong.** Open `07-library-stale.json`.
*Expect:* marked stale, with *when* it was last confirmed.
*Bug if:* stale content is shown as current, or stale is presented as a failure.

**C5 — Nothing outside Core mints a verdict.** Look for any UI affordance that
would let you, a plugin, or the agent set a verification result by hand.
*Expect:* there is none. Verdicts arrive from Watch Core.
*Bug if:* you find any way to declare something VERIFIED from the UI. Report
this immediately; it is a release blocker by definition.

---

## D. Memory

Seven records were seeded through the real memory service, at real origins.

**D1 — Every injected memory shows its papers.** Open Memory mode.
*Expect:* each card carries id, kind, scope, origin, confidence, status,
provenance and when it was last confirmed.
*Bug if:* any card is missing origin, scope or status. A memory without
provenance is not allowed to be injected.

**D2 — "Why remembered?"** Open the inclusion trace for a compiled context.
*Expect:* a reason per included item — why *this* item, for *this* turn.
*Bug if:* the trace is absent, or gives the same generic reason for everything.

**D3 — Correction beats inference.** There is a seeded `inferred` record:
"DEMO: seems to prefer very short replies", left uncorrected on purpose.
Correct it — say you prefer detailed replies.
*Expect:* the next compiled context uses your correction. The inferred record is
superseded, visibly, not deleted silently.
*Bug if:* the inference survives the correction, or the correction takes more
than one turn to take effect.

**D4 — Forget is complete.** There is a record seeded for exactly this:
"DEMO: forget me — this record exists so Forget can be tested end to end".
Forget it. Then look for it in: Memory mode, search, `taste.md`, and an export.
*Expect:* gone from **all four**.
*Bug if:* it survives anywhere — especially in an export or a projection file.
Gone from the list but present in the export is the bug this check exists for.

**D5 — Memory modes actually differ.** In Settings, switch memory between Off,
Session-only and Local Personal.
*Expect:* observably different behaviour — Off injects nothing, Session-only
does not survive a reload, Local Personal does.
*Bug if:* the modes only differ by label.

**D6 — Restart survival.** Reload the Web page. Then close and reopen Desktop.
*Expect:* Local Personal memory is still there; Session-only is not.
*Bug if:* memory that should persist is lost, or memory that should not persist
survives.

---

## E. Arabic and RTL

**E1 — The seeded Arabic record.** Find the record beginning "DEMO: اكتب
الملخصات بالعربية المصرية".
*Expect:* renders right-to-left, correctly shaped, with the Latin words inside it
still readable and in the right order.
*Bug if:* reversed characters, disconnected letter forms, or Latin runs
scrambled inside the Arabic.

**E2 — Layout mirrors, content does not.** Switch the interface to Arabic.
*Expect:* the whole layout mirrors — sidebar, inspector, timeline. Code, file
paths, ids and timestamps stay left-to-right.
*Bug if:* an id or a path is mirrored, or the layout mirrors only partly and
leaves an element stranded on the wrong side.

**E3 — Multilingual round trip.** Open `12-multilingual.json`.
*Expect:* each script's text is byte-identical to what went in.
*Bug if:* any text comes back changed — a stripped diacritic, a normalized
character, a dropped mark. The original must survive exactly.

---

## F. Timeline and deep links

**F1 — Three densities.** Open the bottom timeline and cycle its density.
*Expect:* three levels; the same events, in different detail. Nothing appears
at one density that does not exist at another.
*Bug if:* an event only exists at one density, or the selection is lost when
density changes.

**F2 — A deep link survives everything.** Copy a deep link to a selected record.
Open it in a **new private window** (no client state at all).
*Expect:* the same record, the same selection, the same mode.
*Bug if:* it lands on a default view, or needs prior state to resolve. The point
of the link is that it works for someone who has never opened the app.

**F3 — The same link works in Desktop.** Open that link in the Desktop app.
*Expect:* the same record.
*Bug if:* the link is rejected or resolves differently.

---

## G. Compare

**G1 — Before and after.** Open `08-compare-before-after.json`.
*Expect:* two states, with the difference explicit and each side citing its own
evidence.
*Bug if:* the comparison asserts a change without evidence on both sides.

**G2 — No verdict from the diff.** Look at how the comparison is labelled.
*Expect:* it describes a difference. It does not mint a verification.
*Bug if:* the compare view produces a VERIFIED/FAILED verdict of its own.

---

## H. Live

**H1 — Live degrades honestly.** Open Live mode and `06-live-session.json`.
*Expect:* if a live capability is absent, Live says which and why. Any session
shown is labelled as a fixture.
*Bug if:* Live presents a fixture as a running session.

---

## I. Technology Center

**I1 — Local engines and their real status.** Open the Technology Center.
*Expect:* engines listed with a status that distinguishes *implemented* from
*probed* from *machine-tested*. On this machine there is no GPU, so both
DeepSeek OCR engines should read as **not tested**, with **no quality number**.
*Bug if:* any engine shows an accuracy, a speed, or a quality score. There has
been no run on this hardware, so any number is fabricated. Report it.

**I2 — CPU fallback is the default.** Check which OCR route is selected.
*Expect:* the lightweight CPU route. An unqualified engine is never a default.
*Bug if:* a DeepSeek engine is selected by default here.

---

## J. Offline and consent

**J1 — Offline is real.** With no provider configured, ask the agent something.
*Expect:* a clear refusal naming offline mode. Not a hang, not a timeout, not a
generic error.
*Bug if:* it appears to try, or produces a reply that could only come from a
remote model.

**J2 — A key is not consent.** In Settings, look at media upload.
*Expect:* offline-only and media-upload consent are **two separate settings**.
Configuring a provider key must not turn media upload on.
*Bug if:* one switch controls both, or setting a key enables upload.

**J3 — The agent cannot flip either.** Ask the agent to enable network access or
media upload.
*Expect:* refusal. These are user-only settings.
*Bug if:* the agent changes either, or claims it did.

---

## K. Desktop-specific

**K1 — Safe mode.** Stop the Desktop app's Host (or rename
`G:/watch-manual/dsh-home` and relaunch).
*Expect:* the window opens in **safe mode**, naming the reason. It does not open
onto nothing, and it does not open onto a dead origin.
*Bug if:* a blank window, a crash, or an error dialog with no path forward.
Restore the directory name afterwards.

**K2 — Diagnostics.** Find the diagnostics/health surface.
*Expect:* Host state, Core handshake, capability detection, versions.
*Bug if:* it reports healthy while something is visibly broken.

**K3 — Permissions are denied by default.** Trigger anything that would want
camera, microphone, screen capture or the filesystem.
*Expect:* denied unless you grant it explicitly, each time, for that purpose.
*Bug if:* any native permission is granted without you being asked.

**K4 — File dialog.** Open a file through the app's own dialog.
*Expect:* the OS dialog; the file arrives as content, and any text in it is
treated as observed content — never as an instruction.
*Bug if:* the app acts on instructions found inside a file you opened.

**K5 — Clean shutdown.** Close the window.
*Expect:* the Host child exits with it. Check Task Manager: no orphan `node` or
`watch-skill` process left behind.
*Bug if:* a child survives the parent.

---

## What to report

For anything you find, the useful report is: **which check**, **what you did**,
**what you saw**, **what you expected**. Attach the relevant file from
`G:/watch-manual/logs` if the app was involved in the failure.

Three findings should be reported immediately rather than batched, because each
one is a release blocker on its own:

1. **C3** — the UI leading with a page's false success claim.
2. **C5** — any way to mint VERIFIED from outside Watch Core.
3. **I1** — any quality number attached to an engine that has not run here.
