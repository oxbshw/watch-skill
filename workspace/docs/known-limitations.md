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

## The first search of a session is slow

A semantic search loads an embedding model into the Core process on first use.
Measured against 1.4.0 on a fast laptop: the first `watch.library.search` in a
freshly started Core took longer than 30 seconds, and the next one in the same
process answered in 4.4. The first read after each connection is given a much
larger deadline for exactly this reason, so it completes rather than failing —
but it is slow, it is slow again after Core restarts, and there is no
pre-warming in this release.

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

## Nothing is published

The twenty `@deepwatch/*` packages are prepared as verified tarballs and are not
on any registry. `npx @deepwatch/cli` does not work today and there are no npm
download figures to quote. `doctor` reports the composition it was built to
compose and does not claim a registry can confirm it.

The desktop application is `private` and is not published by this release. The
Electron shell starts and its context isolation holds — `npm run smoke:desktop`
reports that — but there is no installer distributed here.

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
