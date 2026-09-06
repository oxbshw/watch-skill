# Known limitations

What this release does not do, stated before somebody discovers it. Everything
here was found by running the product against a real provider, and each entry
says what the boundary actually is rather than what it might look like.

## Watch records what was declared, not what a shell might do

A tool call is classified from its **declared arguments**. `write`, `read` and
`edit` name a `file_path`; `pwsh` names a `workdir`; all of those are read, and a
path outside the workspace is refused before the call runs.

A shell **command string** is not parsed. Quoting, expansion, redirection and
command substitution decide where bytes land at runtime, so treating the string
as a path would produce confident wrong answers in both directions — a refusal
for a command that touches nothing, and a pass for one that writes anywhere.

The consequence is visible and deliberate: a `pwsh` call that declares no
`workdir` is recorded `scope: not_applicable`, even when the command it ran
wrote a file inside the workspace. That is truthful about what the call
*declared*. Enforcement for command content belongs to the pinned Harness
sandbox, which is the authority for it.

## The Harness's generic tool row shows the argument the agent supplied

Watch registers views for its own tools. Every other tool renders in DeepSeek
Harness's generic row, which displays the arguments the model actually sent — so
when an agent chooses to pass an **absolute** `file_path`, the conversation shows
that absolute path.

Watch's own records do not: receipts, Library rows and verification summaries all
carry workspace-relative paths. This release composes the official upstream
Harness through plugins and overlays and does not fork it, so the generic row is
upstream's to change.

## Watch's own tools classify as `effect: unknown`

The side-effect table is keyed by upstream tool name and fails closed: a name it
does not list is `unknown`, never `harmless`. Watch's own `watch_*` tools are not
in that table, so their receipts read `effect: unknown`. The direction is safe
and the label is imprecise.

## Compare is session-scoped

Compare shows two records **from the conversation you are in**, brought in by
selecting Watch tool rows. A fresh session has nothing to compare and says so
rather than reaching across sessions for a pair that was never asked for.

## Execution receipts survive a restart; a few other things do not

The Library holds two kinds of thing and they have different lifetimes, which
is worth knowing before you rely on either.

**Indexed sources persist.** A video, its frames, its transcript and its
evidence are Watch Core's, they are on disk in the data directory, and a
`Refresh` re-reads them. Stopping and restarting DeepWatch does not lose them.

**Execution receipts now persist too, and did not before.** The receipt for
each tool call — what ran, what it touched, whether it was allowed and how it
ended — is indexed live as the call settles *and* appended to a journal under
the profile (`.watch/receipts/receipts.jsonl`). A restart restores them through
the same path a live receipt takes, so the rows look no different afterwards.

Measured, in the acceptance room for this release: a session filed nine
receipts, three of them verifications carrying Core's verdicts; the Host was
stopped, a write was interrupted mid-line to leave a torn tail, and the Host
was started again. All nine came back openable, each still carrying the verdict
it was given, and the torn fragment was reported and removed rather than
silently joined onto the next record:

```
watch-tools: removed 60 byte(s) of incomplete tail from .watch\receipts\receipts.jsonl
             — a write was interrupted. Earlier records were kept.
```

What still does not survive:

- **the ledger's join window.** A verdict is attached to a receipt while both
  are in memory. An attestation that arrives for a call from a previous run has
  nothing live to join to, so a verification whose receipt was written before a
  restart and whose verdict arrives after it stays unjoined.
- **anything past the horizon.** The journal and the in-memory ledger each keep
  the newest 500 receipts per profile. A long session evicts its own beginning.
- **a store that cannot be written.** If the journal directory is unwritable
  the work still runs and is still indexed for the session — and the Host says
  so on stderr, once per reason, rather than appearing to save.

The durable record of a *verification* remains the verification record itself,
in `verifications/` under the data directory, readable with `watch-skill verify
show` and `watch-skill verify list`. That is Core's own copy and it is
independent of the Host entirely.

## Two stores are called "library", and they are not the same one

The Library **mode**, and the `watch_library_search` tool, read the Host's
index: execution receipts from this profile plus any evidence records under the
`libraryRoots` the profile configures. The shipped `deepwatch` profile
configures none, so before an agent has run anything the Library is honestly
`empty`.

What Watch Core indexed — your videos, their frames, their transcripts — lives
in Core, and the way to it is `watch_search_sources`, which reaches
`watch.library.search` over the Bridge. Indexing a video does not make it
appear in the Library mode, and that is the design rather than a fault; but the
shared word is a real trap and this is the sentence that disarms it.

## The first search of a session used to hang, and now does not

Worth writing down because the wrong explanation held for a while and it was a
plausible one.

A semantic search loads an embedding model. The Bridge answers requests on a
bounded worker pool, and the stack (fastembed, then numpy's and onnxruntime's
native extensions) was imported lazily at its call sites — so the first import
landed inside a worker thread, where loading the numpy C extension deadlocks
and never returns. Measured with a fifteen-minute client deadline against
1.4.0: the first `watch.library.search` in a fresh Core did not answer at all;
a second, issued afterwards in the same process, answered in 51 seconds; a
third in 1.2. Everything that does not embed stayed instant the whole time, so
the engine looked healthy while `watch_search_sources` — the tool an agent
reaches for to find which source mentioned something — hung the first time it
was used.

Core now imports that stack at startup, on the thread that owns the server.
The same measurement on an equally fresh process: 677ms, 507ms, 506ms. The
MCP server has done this since the deadlock was first found there; the Bridge
had not, and one of two servers having the call is the whole of the defect.

What remains: warming is best-effort. On a box where fastembed is missing or
cannot load, search degrades to keyword-only and says so on stderr, and the
first read after each connection keeps a larger deadline in case it is the one
paying for the import.

## Perception is optional, and unconfigured by default

Visual perception, speech to text, audio understanding, diarization and
embeddings each need a provider and model assigned to that role. None falls back
to the chat model, and Diagnostics reports each as `Not configured` until one is
assigned. Assign only a model that actually serves the modality.

The browser capability needs its own dependency:

```sh
pip install 'watch-skill[loop]' && playwright install chromium
```

Installed, it moves from `unavailable` to `probed` — the engine has what it
needs, and the capability is confirmed usable at first use rather than asserted
in advance.

Perception **sources** — screen, window, camera, microphone — are local and
permission-gated, and are requested at first use rather than on page load.

## Memory is off, and plaintext when on

Memory is not enabled by default. The store is plaintext and says so; it is
created owner-only where the operating system enforces file modes. There is no
encryption in this release, and nothing here should be read as providing it.

## DeepWatch is not published; Watch Skill is

Watch Skill 1.4.0 is on PyPI, in the MCP registry, and on
`ghcr.io/oxbshw/watch-skill`. The twenty `@deepwatch/*` packages are not on any
registry: they are prepared as verified tarballs, `npx @deepwatch/cli` does not
work, and there are no npm download figures to quote.

The reason is specific rather than a delay. `release-deepwatch.yml` publishes
over OIDC with no token path at all, and npm requires a package to exist before
a Trusted Publisher can be configured for it — so the *first* publication of
each of the twenty has to be made by the release owner with a short-lived
credential, through `scripts/first-publish.mjs`. Every publication after that
one goes through the workflow.

Until then `deepwatch setup --artifacts <dir>` is the supported path and it is
the one both acceptance passes use. `doctor` reports the composition it was
built to compose and says outright that no registry can confirm it.

## There is no desktop application to download

This is the one deliverable that the product names and does not have, so it is
stated plainly rather than left as an absence somebody has to notice.

`@deepwatch/desktop` is `private` and is not published. What *does* work is the
shell itself: `npm run smoke:desktop` launches the real Electron runtime, and
its context isolation holds. That is a build check on a machine with a desktop
session. It is not a distribution, and the two have been confused before.

Nothing here produces an installer. The `build` block in
`apps/desktop/package.json` is electron-builder configuration — `appId`,
`productName`, per-platform icons — for a builder that is **not a dependency of
this workspace and that no script invokes**. Reading that block as a packaging
pipeline is the mistake it invites: there is no packaging script, no signing
identity, no notarisation step, and no CI job that would run one.

`deepwatch desktop` used to say the app came "from a platform installer" and to
get it "from the project releases". No release has ever carried a desktop
asset, so that sentence sent people looking for a file nobody makes. It now
says this release distributes no desktop application, names `deepwatch web` as
the supported way to run the same workspace, and keeps `DEEPWATCH_DESKTOP_BIN`
for anyone who has built the shell themselves.

**What finishing it would take**, so the size of the gap is legible: a
packaging script, a code-signing certificate for Windows, an Apple Developer
identity and notarisation for macOS, per-platform CI runners, and a release job
that attaches the outputs. None of that is present, and none of it can be
improvised at release time.

## The first-run headline is upstream's

"Into the Unknown" on the workspace hero comes from the pinned Harness and has no
supported extension point. DeepWatch-owned surfaces use the product's own
language; that one line is upstream's until the extension request lands.

## Not in this release

No automatic task resumption, no autonomous learning, and no encryption at
rest. A cancelled call stays cancelled, a failed one stays failed, and nothing
retries a task on its own. Where those appear in planning documents they are
future direction, not shipped behaviour.

One thing here does repair itself, and saying "no self-healing" without that
qualifier was wrong: `watch-skill doctor` fetches and fixes **dependencies** —
it downloads `yt-dlp` and self-updates a stale copy, bootstraps a JS runtime,
installs OCR language data, and installs `ffmpeg` where a package manager
allows it. It reports every repair it made. Nothing else in either product
takes an action nobody asked for.
