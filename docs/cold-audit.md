# Cold release-candidate audit

Everything below was run against a **fresh `git clone` of the release commit**,
installed from nothing, with application data in a directory that did not exist
when it started. Nothing was carried over from the development tree — no
`node_modules`, no `lib/`, no profile, no store.

That distinction is the whole point of this document. The working tree has been
built hundreds of times, and a machine that has already built something will
happily pass a check that a clean one cannot. Four defects here were invisible
until the clone existed, and every one of them would have met a new
contributor, or a CI runner, on their first attempt.

## What was run

| Step | Command | Result | Time |
| --- | --- | --- | --- |
| Clone | `git clone --local . G:/watch-rc-cold` | at `71300c0` | — |
| Install | `pnpm install --frozen-lockfile` | exit 0 | 22s |
| Upstream baseline | `node scripts/upstream-sync.mjs` | `b150a551b8d4 (0.1.1-rc.2)` | 24s |
| Gates | `npm run check` | **1190 tests, 0 failures, exit 0** | 1m45s |
| Profile | `node scripts/manual-profile.mjs` | 10 Watch rows, 4 upstream rows intact | — |
| Fixtures | `node scripts/seed-manual-fixtures.mjs` | 9 fixture files | — |
| Web | DSH web host, port 5399 | HTTP 200 | — |
| Desktop | Electron, isolated app data | ready, `mode: normal`, pid 7240 | — |
| End to end | index, search, reload, compare, capture | all checks passed | — |
| Restart both | kill and relaunch | state byte-identical | — |
| Capture while alive | `node scripts/qa-lifecycle-check.mjs` | **19/19** | 160s |

Application data lived entirely under `G:/watch-rc-appdata`, created empty:

```
G:/watch-rc-appdata/
  dsh-home/        the DSH profile, memory store, and fixtures
  desktop/         the Desktop app's own data
  desktop-logs/    its logs
  qa-profile/      the screenshot tool's isolated Electron profile
```

## What the cold clone found

Four defects, none of which could have been found any other way.

**The gate suite could not run at all.** `npm run check` stopped on the first
gate with "upstream checkout missing" — inventory generation and parity diffing
read the pinned DSH source, and a fresh clone has none. It is a documented
setup step, and the CI workflow did not run it, so CI would have failed on
every run for a reason that had nothing to do with any change.

**A gate ran before the build it reads.** `ocr:check` imports
`@watchskill/dsh-technology/descriptors` — built output — and sat four steps
ahead of `build` in the chain. Every machine that had built once passed,
because `lib/` was there from last time.

**The integrity digest could never have matched.** The release manifest
digested raw file bytes. `.gitattributes` declares LF canonical, so a clean
checkout has LF where this working tree had CRLF in several `package.json` and
`tsconfig.json` files: identical content, different bytes, different digest. A
manifest described as "what an installed build is checked against" therefore
could not match a fresh checkout of its own commit. It looked healthy
throughout, because every machine that had ever regenerated it agreed with
itself.

**The profile builder checked four rows out of ten.** It asserted
`watch-core-bridge`, `watch-tools`, `watch-client-evidence` and `watch-memory`
were composed. The bundle declares ten. The six it never checked include every
client package — brand, workspace, live, library, client-memory,
client-settings — so it would have reported a healthy profile with the entire
Watch interface missing. That is not hypothetical: it is exactly what happened
once, and why a running Workspace looked like stock DSH while every gate was
green.

All four are fixed, and the row list is now read out of the bundle rather than
typed into the checker, so it cannot drift behind it again.

## End-to-end results

Run against the cold clone's own built output, over the fixtures the running
profile was actually serving.

**Library.** 9 fixture files, 9 records indexed, health `ready`. Every fixture
path verified inside the fixture root. Searches answered: `"demo"` 9 hits,
`"verified"` 2, `"zzzznotpresent"` 0. Serialized, reloaded, and asked again —
same health, same size, same answers.

**Compare.** All six dispositions reached, each by a case constructed to
produce it:

| Claim | Left | Right | Disposition |
| --- | --- | --- | --- |
| `saved` | VERIFIED | FAILED | `contradictory` |
| `reworded` | VERIFIED, one wording | VERIFIED, another | `changed` |
| `steady` | VERIFIED | VERIFIED | `matching` |
| `never-checked` | UNVERIFIED | UNVERIFIED | `unverifiable` |
| `only-left` | present | absent | `missing_right` |
| `only-right` | absent | present | `missing_left` |

Output differences stayed out of the claim list, and two calls over the same
pair produced byte-identical results.

Worth recording, because I got both wrong before reading the code: VERIFIED
against FAILED is `contradictory` rather than `verdict_changed` — the two runs
do not merely disagree about a verdict, they assert opposite things — and two
UNVERIFIED claims are `unverifiable` rather than `matching`, because calling
two absences an agreement would be exactly the collapse this product exists to
prevent.

**Live capture.** 7 sources offered, exactly one able to act on the world
(`browser-operator`). A session starts `idle` and emits nothing. Starting
without asking **refuses** and reports `denied` — permission is only ever
requested by an explicit action. After an explicit request: `active`, 3
observations recorded, `stopped`, adapter released, and the receipt asserts no
verdict of any kind. Only Watch Core mints those.

## Restart

Both processes were killed and relaunched against the same application data.

| | Before | After |
| --- | --- | --- |
| Web | HTTP 200 | HTTP 200 |
| Desktop host | HTTP 200 | HTTP 200 |
| Served build | `5bbd2c3e529bee45` | `5bbd2c3e529bee45` |
| Persistent state | 15 files, `1d3a27d156352c2d` | 15 files, `1d3a27d156352c2d` |

Web and Desktop serve byte-identical HTML, before and after.

## Capture while the Desktop is running

19 of 19 checks passed, twice, against the restarted Desktop (pid 14536).

Both captures completed (exit 0, 80s and 79s), producing 38 shots each — the
same shots, in the same order. Across both: the Desktop kept the same pid, the
Watch Core child count held at 4, the supervised Host kept answering, and the
served build digest never changed. No capture process was left running.

This is the check that exists because it once failed: running the screenshot
tool used to take the Desktop down with it, since Electron implements its
single-instance lock inside `userData` and two processes of the same app share
that path by default.

## What this does not establish

- Only Windows. See [platform-support.md](platform-support.md).
- No signed build. No credential exists here. See [signing.md](signing.md).
- The `--local` clone shares objects with the source repository. It is a clean
  *working tree* and a clean install, not a clean network fetch.
- The DSH CLI used to serve the profile is resolved from an existing install
  rather than from the clone.
- The agent loop itself was not driven, because that needs a provider and a
  key. What was exercised is every Watch surface and engine reachable without
  one.
