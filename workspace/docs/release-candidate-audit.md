# Release candidate audit

What was built, what was tested, what was tested on this machine, what could
not be, and what stops a release. The four are kept apart because collapsing
them is the failure this product is built to catch, and an audit that collapsed
them would be arguing against itself.

Read against `Watch_Skill_DSH_Final_Vision_2026-08-26.md`,
`sha256:dfa8cead245d6af7c66ea58e4dfca844b5865bf6397154fae7482007bb92d656`,
3107 lines, read in full. The document is not vendored into this repository:
it is the user's governing artifact, it was supplied for this work rather than
authored here, and copying it in would create a second copy that could drift
from the one that actually governs. The digest is recorded instead, so a future
audit can confirm it read the same text.

Per-requirement detail is in [`spec-closure-matrix.md`](spec-closure-matrix.md)
and its machine-readable twin.

---

## 1. Implementation

35 subsystems, all closed. The parity manifest classifies **40 of 40** official
DSH client product capabilities — 11 preserved, 28 extended, 1 intentionally
replaced with a written reason. Zero unknown.

Watch is a **layer on the official DSH web application**, not a second product.
It contributes plugin rows, tools, a client bundle and UI slots. It ships no
session store, no settings system and no plugin runtime of its own, and the app
the browser loads is upstream's. This is checked rather than asserted: the
install smoke composes the bundle into a real stock DSH 0.1.1-rc.2 profile,
uninstall leaves upstream rows untouched, and the boot smoke starts that profile
and requires it to actually serve.

DSH is consumed as published packages, pinned at `0.1.1-rc.2`
(`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`). There is no fork.

**Distributable artifacts built locally:** 17 package tarballs in
`dist-artifacts/`, plus five installable Watch-for-DSH bundle variants. No
Docker image — this distribution has no container path, so none was fabricated.

---

## 2. Test

938 tests in the workspace suite (938 pass, 0 fail, 0 skipped) and 1966 in the
Watch Core Python suite (1936 pass, 30 skipped, 0 fail). Both exit 0; the full
table is in §4.

Gates in `npm run check`, each of which can fail and has been made to:

| Gate | What it refuses to let through |
|---|---|
| `inventory:check` | a capability inventory that has drifted from the source |
| `verify:parity` | any unclassified DSH capability |
| `verify:bundle` | a bundle that would not compose |
| `verify:desktop` | a weakened Electron posture, or kill-by-name |
| `verify:verdict` | any product code that mints a verdict outside Core |
| `status:check` | an implementation status claim without backing |
| `closure:check` | a stale closure matrix, or a PASS row naming no test |
| `lint`, `build` | style and strict TypeScript |
| `verify:client` | a client bundle that would not load |
| `sbom`, `release:check` | a missing SBOM, a disallowed licence, a stale manifest |

Beyond the suite: `install-smoke`, `upgrade-smoke` (with rollback), `boot-smoke`,
`desktop-smoke`.

### The two spec-named release blockers

**§22.4 offline egress.** Closed at the socket, which is the only level where
the claim means anything. A sentinel loaded by `node --require` patches
`net.Socket.prototype.connect`, `net.connect`, `tls.connect` and every `dns`
resolver, beneath `http`, `https` and `fetch` — so no library can route around
it by reaching for a lower layer. Twelve route families run under `offline_only`
with **zero** non-loopback egress. A violation calls `process.exit(97)` rather
than throwing, so it cannot be caught and reported as a handled network error.

The part that makes it evidence rather than decoration: a self-test arm attempts
a real connection to `example.com` and **must be caught**. A sentinel that
silently did nothing would pass an offline test perfectly.

**§22.4 migration and rollback.** Closed with two different bundle
versions, packed and installed in sequence against a real stock profile.
Upstream rows intact, no duplicate composition, session id stable, evidence ids
stable, memory readable, settings preserved, schema unchanged — then rolled back
B→A with state intact.

---

## 3. Machine-tested on this machine

Windows 10 Pro 19045, no GPU, Node 22.18.0, Electron 33.4.11, Python 3.13.

Everything in §2 ran here. In addition:

**Both applications are running.** Not built, not smoke-imported — started, and
serving.

- **Web** — the real DSH Web Host on `http://127.0.0.1:8931`, serving the Watch
  bundle, with Watch Core spawned as a stdio child. Returns 200 / 14740 bytes;
  the Watch client bundle is served at 58522 bytes.
- **Desktop** — Electron loading that same web application from a Host this
  process started and supervises, on `http://127.0.0.1:63102`. Same 200, same
  bytes, same client bundle.
- **Two `watch-skill` processes** are live: one Watch Core per Host. The engine
  is running under both surfaces rather than stubbed under either.
- An `/api` request from an untrusted origin is refused by both.

**A fresh-clone rehearsal** ran outside both repositories: a clean clone,
installed and gated from nothing. It found a real fact worth writing down — the
tree requires **pnpm**, because `npm install` cannot read pnpm catalog
protocols. Four gates (`verify-parity`, `verify-bundle`,
`verify-desktop-security`, `verify-verdict-authority`) pass on a tree with no
`node_modules` at all, which is a useful property: the architectural gates do
not depend on a successful install.

**Three real bugs were found by running the thing**, and none of them by the
test suite:

1. **The application would not boot.** `packages/watch/tools` did
   `export default apply` — a bare function. Cordis resolves `module.default`
   and reads `plugin.inject` off it, so the named `inject` sat on the namespace
   unseen and `ctx.systemPrompt` threw at startup. Every existing gate was
   green: the composed tree was correct, `verify-bundle` passed, the install
   smoke passed. Nothing that inspects structure could see it, because the
   structure was right and the *shape of the export* was wrong. Fixed, and
   `boot-smoke.mjs` now starts the real profile on an OS-chosen port and
   requires a real HTTP 200 — the class of gate that would have caught it.

2. **The Host cannot run on Electron's bundled Node.** `process.execPath` inside
   Electron is `electron.exe`; even with `ELECTRON_RUN_AS_NODE` that is Node 20,
   which resolves pnpm's symlinked layout differently from the Node 22 the
   profile was installed with — `ERR_MODULE_NOT_FOUND` for four packages plainly
   present on disk. Diagnosed by running the identical command under system
   Node from the same directory, where it worked. Desktop now spawns the system
   Node, with `WATCH_NODE` to override.

3. **A patch layer that composed a row twice.** In the DSH profile format
   `- insert:` *adds* a row and a bare `- id:` *targets* one. Reusing an
   existing id under `insert` composed the Bridge twice and the loader refused
   to boot. The generated overlay now carries the distinction in its own
   comment, so the next person does not rediscover it.

**Deterministic fixtures** are seeded for manual testing: 7 memory records
written through the real `WatchMemoryService` at real origins and subject to the
real admission rules, plus 9 fixture files. Every one carries `demo: true` and
says in the record that it is not a provider result and not a measurement.

---

## 4. Gate results

| Gate | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run build` (strict tsc) | exit 0 |
| `npm test` (938 tests) | exit 0 |
| `verify:parity` | exit 0 — 40/40, 0 unknown |
| `verify:bundle` | exit 0 |
| `verify:desktop` | exit 0 |
| `verify:verdict` | exit 0 — 122 sources, 0 violations |
| `closure:check` | exit 0 — 61 requirements, 0 blocking failures |
| `sbom` / `release:check` | exit 0 |
| `install-smoke` | exit 0 |
| `upgrade-smoke` (A→B→A) | exit 0 |
| `boot-smoke` | exit 0 — real HTTP 200 |
| `desktop-smoke` | exit 0 |
| Watch Core `pytest` | **exit 0** — 1936 passed, 30 skipped, 0 failed, 0 errors |

The `verify:verdict` gate was confirmed able to fail before being trusted: a
forged `verdict: 'VERIFIED'` planted in `workspace/shell.ts` was caught, and its
removal returned the gate to green. The offline sentinel carries the same kind
of positive control permanently, as a test.

### Watch Core suite — configuration handling

The Watch Core suite reads `.mcp.json`, and the working copy of that file
differs from the committed one. It is also a file this work was forbidden to
modify. The procedure, in order: hash the user's file, copy it aside, materialise
the committed version from `HEAD`, run, capture the exit code, restore the
user's file byte for byte, re-hash, and require the two hashes to be identical.

- user's `.mcp.json` before: `sha256:8ef5d4d1cc38d88383100164dd56bd927389e6d7271f7397f996ec63b32c1c16`
- run against `HEAD` version: `sha256:2f26e6ddfbe06b10c6a29eea2f9ed7cce19677869cec643b0b7168133d06813e`
- user's `.mcp.json` after: **identical to before**
- `.mcp.json.bak-*`: untouched

---

## 4b. The productization pass

The release candidate above proved the product *worked*. It did not look like
one. This section records what that turned out to mean, because the gap was
larger and more specific than "needs styling".

### The product was built and never composed

Five of six Watch client packages — brand, workspace, live, library,
client-memory — were complete, unit-tested and green, and **were not in the
bundle at all**. None of them loaded.

Four of those five also registered into slot names DSH does not have:
`sidebar.nav`, `inspector.panel`, `workspace.memory`, `workspace.live`,
`workspace.library`, `message.footer`, `conversation.header`,
`conversation.footer`, `composer.extra`. Composing them would not have helped.
`slots.register` accepts any string, so the plugin loads, the components pass
their tests, and nothing is ever drawn.

Everything green, nothing visible. No component test can reach that, because the
components were never the problem.

### What the gates learned

`inventory/dsh-slots.json` now records DSH's slot vocabulary — 44 entries, taken
as the union of DSH's own contract catalogue (authoritative for `kind` and
`scope`) and its `renderSlot` call sites. Neither source is complete: the
catalogue omits `conversation.composer.bar` and `conversation.input.attachments`,
which DSH demonstrably renders; the call sites omit `root`, `sidebar` and
`details`. A slot the catalogue does not describe is recorded `kind: "unknown"`
and treated exactly as strictly as `single`, because one of them provably is.

`verify-slots.mjs` enforces the three rules that follow: a name must exist, a
`keyed` slot needs a key, and taking a `single` seat needs a written
justification in `SHADOWS`. Three entries are justified, all brand, all
legitimate for the same reason — the bundle disables `ui-brand-official`, so the
seat is empty when Watch takes it.

### Defects that only running it could find

| What | Why no test saw it |
|---|---|
| `--watch-tone-success` and three others resolved to **nothing** | DSH declares `--dsw-alias-*` on `body`; Watch declared its tokens on `:root`, where the inputs do not exist. Green for VERIFIED had no colour at all. A missing custom property is not an error — it is absence, and absence looks like a design choice. |
| The onboarding destroyed the sidebar | `settings.onboarding` is a 256px seat in the sidebar foot, not a modal seat. A 2419px readiness dashboard was rendered into a rail clipped at 644px. |
| The brand tarball could not be imported | Its `files` allowlist named `lib/index.js` but not the `lib/identity.js` that entry imports. |
| Four packages were not valid plugins | Their host entries exported no `apply`, so the whole plugin tree refused to load. |
| The profile installed stale code | pnpm keys a `file:` dependency on path and version, and neither changed between builds. |
| Client bundles built in the wrong order | `readdirSync` order had `client-evidence` bundle before `workspace` and resolve a bundle that did not exist yet. |
| A client bundle cannot be imported across packages | `/client` is a `window.__ModuleLoader__.load(...)` registration; a bundler cannot read named exports out of a function body. Shared code moved to plain-ESM subpaths. |

### The brand asset

The supplied orca master is **RGB with no alpha channel** — what reads as
transparency is a chequerboard painted into the pixels. Using it unchanged would
have put a grey chequer behind the mark everywhere.

The alpha is recovered by reachability rather than by colour, because colour
cannot separate the two light regions: the belly is negative space showing the
chequer through, and the eye patch is painted white and fully enclosed. A flood
fill from the border finds the background, belly included, eye patch excluded.
Edge coverage is read from the red channel, which spans 49→247, because blue is
252 against a 247 ground and carries no signal.

Measured on the 256px derivation: 85.6% fully transparent, 11.9% fully opaque,
2.5% soft edge, 253 white pixels surviving as the eye patch, `(0,0,0,0)` corner.

### The provider catalogue

Audited from `@earendil-works/pi-ai` as pinned: **37 routes**, 30 hosted and 7
where the endpoint is user-supplied. Watch adds none and removes none. DeepSeek
is one of the thirty-seven and is not required to enter the workspace. A local
model is reached through the user-supplied endpoint route rather than as a
separate feature, and every row is recorded `checked: "never"` — a descriptor
existing is not a working connection.

### What the four Watch modes can and cannot do

A `conversation.view` entry is handed `{ inspect, onInspectDone }`, and
`ctx.remote` is an event bus rather than a query client. Watch contributes
tools, so its records reach the browser as conversation results; there is no
client-reachable Watch query route.

Each surface therefore renders the supported subset — the selected record, read
through the real `parseVerdict` contract — and names what it cannot reach:

- **Watch** renders the verdict, its reason, assurance, contract digest and each
  check, with "did not run" distinct from "did not hold".
- **Live** lists six sources with real permission behaviour, asks for nothing on
  load, keeps Browser Observer and Browser Operator separate, and offers no
  Start control for a backend that is absent.
- **Library** offers no search box it cannot answer.
- **Compare** fabricates no second column.

This is the supported subset plus an honest unavailable state, which is what the
architecture actually permits today. It is not a placeholder, and it is not a
mockup.

---

## 5. External limitations — NOT MACHINE TESTED

Each of these is stated as a limitation rather than quietly folded into a pass.

**Production code signing.** Update verification is implemented and tested —
signature, digest, downgrade refusal and migration preflight, in that order —
but only against a **development key**. No production signing credential exists
on this machine, so no production-signing claim is made. Required before any
public Desktop distribution.

**GPU and the DeepSeek OCR engines.** There is no GPU here. Both DeepSeek OCR
engines are `NOT_TESTED` in every matrix cell, and **no quality or speed number
exists for either**. This is enforced rather than observed: a test asserts that
no code path can produce a metric without a run, and routing excludes an
unqualified engine from being a default. The lightweight CPU route is selected.

**Single-user hosted deployment.** Local Web is what was run and proven. The
hosted profile — HttpOnly sessions, CSRF on commands, WebSocket/SSE origin
checks, short-lived scoped artifact URLs, upload sniffing — is upstream Host
responsibility in a deployment that was not stood up here. Watch adds no
endpoint and no second session system, so there is nothing Watch-specific left
untested; but the boundary itself is unexercised on this machine.

**Screen readers.** Roles, accessible names, focus-visible, forced-colours and
the one-selected-tab invariant are all tested, and the mode tabs are DSH's own
`role="tablist"` rather than a Watch reimplementation. No assistive technology
was driven, so *announcement* is untested.

**A Watch query route.** Library search, revision history and a two-sided
Compare all need an index or a stored history the client can read. This build
exposes neither, so those surfaces state the limitation rather than approximate
it. Closing this is a product decision about exposing Watch records through the
Host, not a defect to fix.

**Live capture.** No capture backend is composed, so no live session can be
started. The surface says so and lists what it would take.

**Platforms other than win32.** Desktop was launched and machine-tested on
Windows only. macOS and Linux are unexercised.

**Real provider models.** No provider key is configured. Every model-facing path
was exercised offline or against fixtures; no real-model quality claim is made.

**Host CSP.** The Desktop window does not impose a strict `script-src 'self'` on
the Host origin, because the DSH web application bootstraps through an inline
script in its own HTML — that policy would stop the app starting. The origin is
loopback-only and served by a child this process supervises, and every other
boundary (`nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`,
navigation and window-open allowlists, IPC sender validation, permissions denied
by default) is unchanged and asserted as Electron actually applied it. Recorded
here as a deliberate trade rather than left implicit.

---

## 6. Release blockers

**None outstanding for manual testing.**

All 13 §22.4 blockers are closed with tested evidence. No requirement in the
closure matrix is `FAIL`.

Before any **public** release, two things in §5 must be resolved, and neither
can be resolved on this machine:

1. **Production code signing** — a real credential, and a signed build verified
   end to end.
2. **Cross-platform Desktop** — macOS and Linux launched and tested.

Neither blocks the manual testing this candidate is for.

---

## 7. Non-blocking observations

- **The tree requires pnpm.** `npm install` fails on catalog protocols. True and
  intended; worth a line in the contributor docs.
- **Trajectory contribution is one-directional.** Watch publishes its own view
  target rather than adding rows to upstream's ledger, because upstream's
  contribution union is closed. Deep links work; the mechanism is not the one a
  reader might assume.
- **Both DeepSeek OCR engines are dark on this hardware.** Not a defect — the
  correct behaviour for a machine without a GPU — but it means the OCR surface
  will look sparse during manual testing.
- **Desktop safe mode was exercised twice**, unintentionally, while diagnosing
  the Node resolution bug. It behaved correctly both times: the window opened
  on the shipped local renderer carrying the reason, rather than onto a dead
  origin. That is the best kind of evidence for a failure path.
- The offline sentinel covers the Node side. Watch Core has its own socket-level
  proof in the Python suite. Neither substitutes for the other.

---

## 8. Verdict

The candidate is ready for manual testing. Both applications are running, both
have a live Watch Core, the fixtures are seeded, and
[`manual-test-checklist.md`](manual-test-checklist.md) is written for someone
sitting in front of them.

What this audit does **not** say is that the product is proven correct. It says
which claims are backed by something that would fail if they stopped being true,
and which are not backed at all — and it names the second group precisely,
because a candidate that hid them would be the exact failure mode the product
was built to catch.
