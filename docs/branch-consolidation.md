# Branch consolidation

The stable release reduced this repository to a single branch, `main`. This
records what every other branch contained, what happened to it, and how to check
that nothing unique was thrown away.

The reason to write it down is that a deleted branch leaves no evidence of
itself. "It was merged" and "it was abandoned" look identical afterwards, and so
do "it was already applied" and "it was silently dropped". A branch list is not
a changelog, so the disposition has to be recorded somewhere that survives the
deletion.

## The rule

A branch was deleted only after its commits were accounted for in one of three
ways:

1. **Contained** — the branch has no commits the release branch does not have.
2. **Already applied** — the branch has unique commits, but the change they make
   is present in the release branch by other means, verified by comparing the
   resulting content rather than the commit.
3. **Rejected** — the branch has unique commits that were deliberately not
   taken, with the reason and the condition for revisiting.

"Nobody is using it" was not accepted as a disposition.

## What each branch contained

Ahead/behind is measured against `main` as it stood before consolidation,
`994ee7514c64a9ec4980eeabef789b5e10ea28be`. The recovery SHA is the branch's
last commit: `git checkout -b <name> <sha>` brings it back exactly — **but only
while the object is still reachable**, and a deleted branch's tip is exactly the
kind of object that stops being reachable. A SHA written in a document is a
label for something that may no longer exist; garbage collection does not read
documentation.

So a git bundle of every tip was taken before any branch was deleted, and kept
outside this repository (a bundle stored inside the repository shares the
repository's fate). It is a single file that is itself a repository:

```bash
# before deleting anything
git bundle create <backup-dir>/watch-skill-branch-tips.bundle \
  refs/heads/main refs/heads/release/final-closure \
  $(git for-each-ref --format='%(refname)' refs/remotes/origin | grep -v HEAD)
```

Verified two ways, because "the file exists" is not the claim:

```bash
git bundle verify <backup-dir>/watch-skill-branch-tips.bundle   # complete history
git clone --mirror <backup-dir>/watch-skill-branch-tips.bundle /tmp/check
git -C /tmp/check cat-file -t <sha>                             # every tip, by SHA
```

Restoring one branch from it needs no network:

```bash
git fetch <backup-dir>/watch-skill-branch-tips.bundle \
  'refs/remotes/origin/workspace-rc:refs/heads/workspace-rc'
```

The bundle is not pushed anywhere. A backup branch or tag on the remote would
put the count back above one and would be a second thing to keep true; a file is
a file.

| Branch | Last SHA | Behind / ahead of `main` | PR | Disposition |
| --- | --- | --- | --- | --- |
| `release/final-closure` | `944fa07da3b4f09c4f08f3abe836e2f06d35a8fe` | 0 / 188 | [#20](https://github.com/oxbshw/watch-skill/pull/20) | **Merged.** The stable release work. `main` fast-forwarded onto it. |
| `main` | `994ee7514c64a9ec4980eeabef789b5e10ea28be` | — | — | Kept. The only branch that survives. |
| `workspace-rc` | `3c4142efe63e55b5deff145c0a51562c8a721838` | 194 / 0 | none | **Contained.** Nothing on it that `main` did not already have. Deleted. |
| `fix/live-clip-window-honesty` | `d32281466fa45ae1657fce239136f94966b361b2` | 0 / 134 | none | **Contained.** An ancestor of the release branch; local only, never pushed. Deleted. |
| `dependabot/pip/ruff-gte-0.15-and-lt-0.17` | `c9c13777273dec322efb2481d1296ffa069ba91d` | 200 / 1 | [#13](https://github.com/oxbshw/watch-skill/pull/13) | **Already applied.** Closed, not merged. |
| `dependabot/github_actions/actions-ba6e57dd14` | `8cd6cffc5d3edb7b6b9a557e1abc1b35d75d3769` | 0 / 1 | [#21](https://github.com/oxbshw/watch-skill/pull/21) | **Already applied, and superseded.** Closed, not merged. |
| `dependabot/docker/python-3.14-slim-bookworm` | `9233506c04748328e2aac385573bc8af9bfba394` | 96 / 1 | [#12](https://github.com/oxbshw/watch-skill/pull/12) | **Rejected for this release**, with a condition. Closed. |

Two of the Dependabot branches are a long way behind `main`: they were opened
against an older tree and never rebased. That is why the disposition below
compares *resulting content* rather than merge-ability — a branch 200 commits
behind can propose a change that is already present, and a merge would be a
conflict rather than a no-op even though the change itself is redundant.

## The three that had unique commits

### ruff `>=0.15,<0.17` — already applied

The branch changes one line of `pyproject.toml`, widening the `ruff` dev
dependency from `<0.16` to `<0.17`. The release branch already carries that
exact line:

```toml
dev = ["pytest>=9.1,<10", "pytest-timeout>=2.4,<3", "ruff>=0.15,<0.17"]
```

Byte-identical to what the branch proposes, so merging it is a no-op.

### The actions group — already applied, and wider

The branch bumps thirteen action pins across six workflow files. The release
branch applies the same pins, and applies them to eight workflows: the branch
predates `release-deepwatch.yml` and `post-publish.yml`, so merging it would
have left the two release-critical workflows on the older pins it was raised to
replace.

Compare the two sets rather than the diffs — the question is what each tree ends
up pinned to, not which commit got there first:

```bash
dump() {
  for f in $(git ls-tree -r --name-only "$1" -- .github/workflows); do
    git show "$1:$f" | grep -oE 'uses: [A-Za-z0-9_./-]+@v[0-9]+' | sed 's/uses: //'
  done | sort -u
}
diff <(dump origin/dependabot/github_actions/actions-ba6e57dd14) <(dump main)
```

The sets are identical: `attest-build-provenance@v4`, `cache@v6`,
`checkout@v7`, `download-artifact@v8`, `setup-node@v7`, `upload-artifact@v7`,
`setup-uv@v7`, `build-push-action@v7`, `login-action@v4`, `metadata-action@v6`,
`setup-buildx-action@v4`, `setup-qemu-action@v4`, `pnpm/action-setup@v6`,
`action-gh-release@v2`.

### Python 3.14 in the Dockerfile — rejected, with a condition

The branch changes the container base image from `python:3.13-slim-bookworm` to
`python:3.14-slim-bookworm`. It was not taken, because this project only claims
the Python versions it executes:

- `pyproject.toml` classifiers: 3.11, 3.12, 3.13.
- The CI matrix in `ci.yml`: `["3.11", "3.12", "3.13"]`.

`requires-python` is `>=3.11` with no upper bound, so 3.14 is *permitted* — it
is not *tested*. Shipping a stable container built on an interpreter version no
job in this repository runs would be a claim without evidence, which is the
thing every other gate here exists to prevent.

**The condition for adopting it:** add 3.14 to the classifiers and to the CI
matrix, let a full run pass on it, and then move the base image. In that order.

**A consequence worth knowing.** Closing a Dependabot pull request tells
Dependabot not to offer that specific version again. So 3.14 will not come back
on its own; adopting it later is a deliberate step somebody has to take, using
the sequence above. This is the intended outcome, but it is a decision with a
memory, so it is written here rather than left in a closed pull request.

## What was deliberately not done

Dependabot was **not** disabled. Security and version updates stay on, which
means Dependabot may open new branches in this repository at any time. A branch
list that stays empty because nothing is allowed to check dependencies is not a
tidy repository; it is an unmaintained one. New Dependabot branches are expected,
and each one gets the same three-way disposition as the ones above.

Branch protection was not weakened, and no history was rewritten. `main` reached
the release head by fast-forward, so every commit reachable before consolidation
is still reachable now.

## Reproducing the audit

```bash
git fetch --all --prune
for b in $(git branch -r --format='%(refname:short)' | grep -v HEAD); do
  echo "$b: $(git rev-list --count main..$b) unique"
done
```

Any branch reporting `0` is fully contained in `main`. Any branch reporting more
needs one of the three dispositions above before it is deleted.
