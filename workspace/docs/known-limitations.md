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

## A receipt does not carry the verdict Core returned for it

**This is a defect, found by running the release against a real provider, and it
is not fixed in 0.1.0.** It is written here rather than left to be discovered,
because the gap is between two things the product otherwise keeps carefully
apart, and a reader could reasonably assume the join works.

What is true: Watch Core runs the contract and returns a real verdict, and the
record it writes is complete. A clean room built from this release's sealed
artifacts produced three verification records — two `pass` and one `fail` — each
with its checks and their statuses, each independently re-readable with
`watch-skill verify show`.

What is not: **no execution receipt in the Library carries that verdict.** Every
row reads `verdict: null`, including the successful write whose own attestation
Core answered `pass`. The consequence is visible in Compare: two verification
records selected side by side are reported as *"only on one side"* and each row
reads `unchecked`, because neither carries a verdict to compare. The comparison
itself is computed correctly — it is comparing records that have no verdict on
them.

The verdict is not lost. It is on disk in the verification record, it is in
`watch-skill verify show`, and the tool result the agent received carried it.
What is missing is the join that puts it back onto the receipt, so the
Library's VERIFIED/FAILED filter matches nothing and Compare has no verdict to
rank or diff.

Until it is fixed: read a verdict from the verification record or from
`watch-skill verify list`, not from a Library row's verdict column, and do not
read Compare's verification table as a statement about Core's outcomes.

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

No self-healing, no automatic task resumption, and no autonomous learning. A
cancelled call stays cancelled, a failed one stays failed, and nothing retries a
task on its own. Where those appear in planning documents they are future
direction, not shipped behaviour.
