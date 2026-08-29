# ADR-010: One repository, two release trains

- Status: Accepted
- Date: 2026-08-29
- Supersedes: [ADR-003](ADR-003-repository-split.md)

## Context

ADR-003 put Watch Core and the Watch Workspace in separate repositories so that
two release trains moving at different speeds would not be coupled, and so that
Python consumers would not install hundreds of Node packages. Both goals were
right. The split was not the only way to reach them, and it charged for them in
a currency the ADR did not price.

Watch Core owns the contracts. The Workspace generates TypeScript from Core's
JSON Schema and validates at the Node boundary, and the schema digest travels
in the Bridge handshake so a mismatch is negotiated rather than discovered at
runtime. That mechanism works. What it cannot do is make a contract change
atomic: a change to a contract and the change to its consumer were two pull
requests in two repositories, green independently, and no CI run anywhere
executed the pair together. The handshake turns a mismatch into a clean
failure, which is much better than a crash, and a clean failure is still a
failure that reached a user.

The same seam ran through the rest of the work. `verify:parity` compares the
distribution against a pinned upstream baseline, the Bridge protocol range and
store schema version are asserted from Core's source, and the release manifest
digests both halves. Every one of those had to reach across a repository
boundary to state something true, and each did it by pinning a version of the
other side -- so the pin, not the code, was what got tested.

## Decision

One repository, `oxbshw/watch-skill`, containing both products, with their
release trains kept separate by packaging and tagging rather than by distance.

| Product | Location | Version | Tag namespace | Publishes to |
|---|---|---|---|---|
| Watch Core | repository root | `pyproject.toml` | `v*` | PyPI, MCP Registry, GHCR |
| Watch Workspace | `workspace/` | `workspace/package.json` | `workspace-v*` | nothing; private |

Core's wheel packages `src/watch_skill` and nothing else, so a Python consumer
still installs no Node. The Workspace stays `"private": true`, so no part of it
reaches npm by accident.

The tag namespaces must not overlap, and this is the sharpest edge in the
arrangement. `.github/workflows/release.yml` triggers on `tags: ["v*"]` and
publishes Core to PyPI. A Workspace release tagged `v0.1.0` would therefore
publish Watch Core, built from whatever the root happened to contain. The
`workspace-v*` prefix is what keeps that from being possible, and it is a
convention rather than a mechanism until the release workflow refuses a tag
whose version does not match `pyproject.toml`.

## Consequences

- A contract and its consumer change in one commit, and one CI run proves the
  pair. This is the whole of the benefit and it is worth the rest.
- CI must decide what to run from the paths a change touches, or every
  Workspace typo costs a full Python matrix across three versions and two
  operating systems. Path filters alone are not sufficient: a required check
  that is skipped never reports, and a branch protected on a check that never
  reports can never merge. The required contexts are therefore aggregators
  that always run and that fail if anything they gather failed or was
  cancelled.
- A tool that walks the repository now walks both halves. `tests/test_cli_docs.py`
  collected Markdown with `rglob` and filtered afterwards; the filter was never
  reached, because the walk entered `workspace/node_modules` first and Windows
  refused the depth. Anything that traverses from the root has to prune.
- The upstream checkout under `workspace/upstream/deepseek-harness/` remains
  script-managed and git-ignored, used only for audit and inventory generation.
- Both directions of independence are still tested: the Python engine runs
  headless with no Node present, and DSH boots with no Watch present.

## What would force a revisit

A Workspace release cadence that genuinely diverges from Core's -- weekly
against quarterly, say -- or a Core consumer base that begins cloning the
repository rather than installing the wheel. Neither is true now. Repository
size is not on this list: the Workspace is source and a lockfile, and the
upstream baseline it audits against is not committed.
