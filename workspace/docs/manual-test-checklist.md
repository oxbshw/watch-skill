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
| **Desktop** | already open as a window; if you closed it, run `npx electron .` in `workspace/apps/desktop` |
| **Demo data home** | `<manual root>/dsh-home` |
| **Fixtures** | `<manual root>/dsh-home/watch-fixtures` |
| **Logs** | `<manual root>/logs` |

`<manual root>` is the platform's own state directory plus `watch-manual` —
`%LOCALAPPDATA%\watch-manual` on Windows, `~/Library/Application
Support/watch-manual` on macOS, `$XDG_STATE_HOME/watch-manual` (or
`~/.local/state/watch-manual`) elsewhere. `WATCH_MANUAL_ROOT` moves all of it
at once, and whoever handed this over will have said if they set it. These
paths used to name one maintainer's drive, which meant the scripts worked and
the instructions did not.

Everything seeded is marked `demo: true` and prefixed `DEMO:`. If you see a
record that looks real and is not marked, **that is a bug** — it means something
minted data outside the seeding path.

Both apps run **offline-only**. There is no provider key configured. A model
reply is not expected; a *refusal to reach the network* is.

---

## A. It opens, and it is DeepWatch

**A1 — Web loads, branded.** Open http://127.0.0.1:8931.
*Expect:* the browser tab reads **DeepWatch** with the orca as its icon.
The sidebar header shows the orca beside the words "DeepWatch", and the
sidebar footer carries "Built on DeepSeek Harness · Powered by Watch Skill"
above the independence disclosure.
*Bug if:* the tab or the sidebar says "DeepSeek Harness"; the orca is stretched,
clipped, pixelated, or sitting on a grey chequerboard; the attribution or the
disclosure is missing.

**A1b — The mark is the supplied artwork.** Look closely at the orca.
*Expect:* white eye patch, white belly as negative space, clean transparent
edges at any size.
*Bug if:* the belly is filled, the eye patch is missing at sidebar size, or a
grey chequer shows behind it — that would mean the alpha recovery regressed.

**A2 — Upstream still works.** Find the stock DSH surfaces: Sessions, Settings,
General, Models, Plugins, Agent presets, Trajectory.
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

The tabs are **Chat · Trajectory · Watch · Live · Memory · Library · Compare**,
rendered in the session header. Chat is DSH's own conversation and Trajectory is
DSH's own trajectory; Watch adds the other five.

They appear only inside a session that has content — DSH hides header chrome
while a session is blank, which is correct behaviour and not a missing tab.

**B0 — The tabs are real tabs.** Focus one and use the arrow keys.
*Expect:* `role="tablist"`, arrow keys move between tabs, the selected one is
marked, and the selection survives a reload.
*Bug if:* they are plain buttons, keyboard navigation does nothing, or the
selection resets on reload.

**B1 — Every mode opens onto something.** Visit each in turn.
*Expect:* each renders a titled surface with a sentence saying what it shows.
Where it has nothing to show it says what would populate it and what to do next.
*Bug if:* a tab opens onto blank space. **An empty body is the specific defect
this checklist exists to catch** — a tab onto nothing reads as a broken feature
rather than an absent one.

**B2 — Empty and unavailable are different words.** Compare Watch (nothing
selected) with Live (no capture backend).
*Expect:* Watch says nothing is *selected* and how to select something. Live
says starting a session is *not available in this build*, and lists what it
would take. These are deliberately different states.
*Bug if:* the two read the same, or either offers a control that fails when
pressed.

**B3 — Live asks for nothing.** Open Live and watch for prompts.
*Expect:* no permission dialog. Six sources listed — Screen, Window, Camera,
Microphone, Browser Observer, Browser Operator — each saying when it *would*
ask.
*Bug if:* any OS permission is requested by opening the tab. Report immediately.

**B4 — Observer and Operator are separate.** Read those two rows.
*Expect:* two distinct capabilities. Observing records what a page showed;
operating acts on it and returns a receipt.
*Bug if:* they are merged into one "browser" control — that would grant the
power to act while a person believed they were enabling the power to watch.

**B5 — Watch reflects the selection.** In Chat, click a Watch tool row, then
open Watch.
*Expect:* the verdict as a word and a colour, its reason, the assurance level,
the contract digest, and each check as held / did not hold / did not run.
*Bug if:* it still shows the empty state, shows a different record, or renders a
check that did not run as a failure.

**B6 — Library is answered by the host, and says so.** Open Library.
*Expect:* the lead says search runs on *this workspace's own host*, the status
line reads "Index ready. Answered by this workspace's own host.", and the
seeded records are listed with a count. Verification and Sort are disabled: the
host answers by query and modality and has no parameter for either.
*Bug if:* the surface lists nothing while the fixtures are present; or it says
it is searching locally; or Verification and Sort are enabled and changing them
changes nothing. A filter that silently does nothing is worse than one that is
plainly unavailable.

**B6b — Refresh finds a record added while the app was running.** With
DeepWatch open, copy any file from `<manual root>/dsh-home/watch-fixtures` to a
new name in the same directory. Search again first, then press **Refresh
library**.
*Expect:* the plain search does **not** find it — a search answers from what the
host holds and never re-reads the corpus on its own. Refresh shows "Refreshing…"
while it runs, then a line naming the new record count and generation, and the
results include the new file without restarting anything.
*Bug if:* the ordinary search picks it up (a search with a hidden side effect);
or Refresh reports success and the count does not move; or the control stays
"Refreshing…" after the answer arrived; or the app has to be restarted.

**B6c — A refresh that fails leaves a working Library.** Rename the fixtures
directory away, press **Refresh library**, then put it back.
*Expect:* a red line saying the refresh failed and that the previous index is
still searchable — and it is: the records from before are still listed and still
searchable.
*Bug if:* the Library empties, the surface reports success, or the failure
message names a filesystem path.

**B7 — A record names itself, not a place on disk.** Read the identifier under
each Library row.
*Expect:* an identifier — letters, digits, dots, dashes, underscores — such as
`demo_src_installer` or a sixteen-character content id, and a readable title.
*Bug if:* any row shows a filesystem path. **Report immediately.** The read
plane's rule is that a record never carries a location, and a path in the
browser is that rule broken in the direction that leaks the host's layout.

---

## C. Evidence and the verdict — the core claim

This is the section that matters most. Fixtures for it are in
`<manual root>/dsh-home/watch-fixtures`.

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

**I3 — Every Watch section is present.** Open Settings.
*Expect:* DSH's own General, Models, Plugins and Agent presets at the top, then
Role Bindings, Perception Engines, Sources & Devices, Memory & Retrieval,
Verification, Diagnostics and About.
*Bug if:* a DSH section is missing or has moved below the Watch ones — Watch is
only allowed to add, and only below.

**I4 — The provider catalogue is not narrowed.** Open Role Bindings and read the
Providers card.
*Expect:* 37 routes — 30 hosted and 7 where you supply the endpoint — naming
OpenAI, Anthropic, Google, Amazon Bedrock, Mistral, Groq, OpenRouter and
DeepSeek among them, and stating that a local model (Ollama, vLLM, LM Studio,
llama.cpp) is a base URL you supply rather than a separate feature.
*Bug if:* the count is small, DeepSeek is presented as required, or no
user-supplied endpoint route is offered. **A narrowed catalogue is a serious
regression** — the whole point is that Watch adds to DSH without taking away.

**I5 — Nothing claims to work.** Read the states in Role Bindings.
*Expect:* every role "Not bound", every provider "Never" checked, every engine
"Not tested", no accuracy or speed figure anywhere.
*Bug if:* anything reads as ready, tested or measured. No check has run on this
machine, so any such claim is fabricated. Report immediately.

**I6 — Opening Settings runs nothing.** Watch the network and any prompts while
you click through all seven sections.
*Expect:* no provider is contacted, no capability is probed, no permission is
requested. Checks happen when you press a Test button, not when a page opens.
*Bug if:* opening a section triggers a probe or a request.

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
`<manual root>/dsh-home` and relaunch).
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

**K6 — Desktop identity.** Look at the window title bar, the taskbar and
Alt-Tab.
*Expect:* "DeepWatch" in all three, with the orca as the window icon.
*Bug if:* any of them says "DeepSeek Harness" or shows Electron's default icon.
A brief flash of the wrong title during startup is also a bug — the title is
held against the page deliberately.

**K7 — Desktop is the same build as Web.** Compare a Watch surface in both.
*Expect:* identical. Desktop loads the same web application from a Host it
supervises.
*Bug if:* they differ in any way. That means one of them is serving a stale
build, which is the failure that made an earlier round of testing meaningless.

**K5 — Clean shutdown.** Close the window.
*Expect:* the Host child exits with it. Check Task Manager: no orphan `node` or
`watch-skill` process left behind.
*Bug if:* a child survives the parent.

---

## The seven modes need one turn

DSH hides the session header while a session is blank, and the mode tabs live in
that header. Send one message and they appear. That is upstream behaviour, not a
Watch defect.

With a provider configured, any message will do. Without one, the QA capture
uses `scripts/qa-provider-stub.mjs`, a deterministic loopback endpoint that
answers on the wire so a turn can complete; see
[provider-handoff.md](provider-handoff.md) for connecting a real provider
instead.

Sections A, C, D, I, J and K are reachable with no session at all.

---

## What to report

For anything you find, the useful report is: **which check**, **what you did**,
**what you saw**, **what you expected**. Attach the relevant file from
`<manual root>/logs` if the app was involved in the failure.

Three findings should be reported immediately rather than batched, because each
one is a release blocker on its own:

1. **C3** — the UI leading with a page's false success claim.
2. **C5** — any way to mint VERIFIED from outside Watch Core.
3. **I1 / I5** — any quality number, or any capability claiming to be ready,
   tested or measured when nothing has run on this machine.
4. **B3** — any OS permission requested by opening a tab rather than by a
   deliberate action.
5. **I4** — a provider catalogue narrowed below what DSH ships.
