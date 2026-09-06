# Historical evidence

Each file here is a record of one run at one commit. None of it describes the
current tree, and none of it is release evidence for any later candidate.

They are kept because they are the only account of what was measured at those
commits, and deleting them would leave claims elsewhere with nothing behind
them. They are kept *here*, out of the docs index, because the failure mode is
not that somebody cannot find them — it is that somebody finds one, reads a
total, and repeats it as though it were true today.

The commit is in each filename for the same reason.

| File | Measured at | What it records |
|---|---|---|
| [release-candidate-audit-02343ca.md](release-candidate-audit-02343ca.md) | `02343ca` | what was built, what was tested, what could not be, and what blocked a release |
| [validation-matrix-71300c0.md](validation-matrix-71300c0.md) | `71300c0` | every gate run individually, with exit code and wall time |

Current evidence is generated, never written by hand: the exact-head CI jobs,
`inventory/packed-artifacts.json`, `docs/screenshot-manifest.md`,
`docs/release-manifest.json` and `docs/implementation-status.md`.

`release-surface-rules.json` excludes this directory from the release-surface
scan, which is what lets these pages keep their original wording — including
counts and package numbers that are no longer right — without a gate having to
choose between failing on history and being switched off.
