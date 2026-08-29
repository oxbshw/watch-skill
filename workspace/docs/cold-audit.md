# Cold audit

A cold audit runs the product from a fresh clone of the release commit, with
application data in a directory that did not exist beforehand. Nothing is
carried over: no `node_modules`, no `lib/`, no profile, no store.

The reason for the procedure is that a machine which has already built something
will pass checks a clean one cannot. Four defects listed below were invisible
until a clone existed, and each would have met a new contributor or a CI runner
on their first attempt.

## Procedure

```bash
git clone --local . <clean-dir>
cd <clean-dir>
pnpm install --frozen-lockfile
node scripts/upstream-sync.mjs
npm run check
```

Then, against an application-data directory created empty:

```bash
WATCH_MANUAL_HOME=<appdata>/dsh-home node scripts/manual-profile.mjs
WATCH_MANUAL_HOME=<appdata>/dsh-home node scripts/seed-manual-fixtures.mjs
```

Serve the profile, start Desktop with `WATCH_APP_DATA`, `WATCH_DSH_HOME` and
`WATCH_LOG_DIR` pointed inside the same directory, and then:

- create a session and send one turn, so the mode tabs mount
- open all seven modes
- exercise Live capture, Library search and Compare
- restart both applications and confirm the persistent state digest is unchanged
- run `scripts/qa-lifecycle-check.mjs`, which captures twice against the live
  Desktop and asserts it was not disturbed
- run the screenshot capture and regenerate the manifest

## What must hold

The source worktree and the clean clone must report the same test inventory. A
difference means one of them is running something the other is not, and that is
a finding rather than a footnote.

Web and Desktop must serve byte-identical HTML. The persistent state digest must
be unchanged across a restart of both. No capture process may be left running,
and the Desktop pid must be the same before and after each capture.

## What earlier cold audits found

The gate suite could not run at all. `npm run check` stopped on the first gate
with "upstream checkout missing", because inventory generation and parity
diffing read the pinned DSH source and a fresh clone has none. It is a
documented setup step that the CI workflow did not perform, so CI would have
failed every run for a reason unrelated to any change.

A gate ran before the build it reads. `ocr:check` imports
`@watchskill/dsh-technology/descriptors`, which is built output, and sat four
steps ahead of `build` in the chain. Any machine that had built once passed.

The integrity digest could never have matched. The release manifest digested raw
file bytes, and `.gitattributes` declares LF canonical, so a clean checkout has
LF where a working tree may hold CRLF: identical content, different bytes,
different digest. A manifest described as what an installed build is checked
against could not match a fresh checkout of its own commit. Digests are now
taken over content normalised to LF.

The profile builder checked four rows out of ten. It asserted
`watch-core-bridge`, `watch-tools`, `watch-client-evidence` and `watch-memory`
were composed, while the bundle declares ten. The six unchecked rows included
every client package, so the builder would have reported a healthy profile with
the entire Watch interface missing. That is not hypothetical; it is what
happened once, and why a running Workspace looked like stock DSH with every gate
green. The row list is now read from the bundle.

## What a cold audit does not establish

Only the platform it runs on. A `--local` clone shares objects with the source
repository, so it is a clean working tree and a clean install rather than a
clean network fetch. The DSH CLI used to serve the profile is resolved from an
existing install rather than from the clone.

The most recent run's numbers are in [validation-matrix.md](validation-matrix.md).
