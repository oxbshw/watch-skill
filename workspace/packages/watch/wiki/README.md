# @deepwatch/dsh-wiki

Deterministic workspace wiki projections over the memory ledger

Part of **DeepWatch** — the Web and Desktop agent product built on the
official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
packages and powered by [Watch Skill](https://github.com/oxbshw/watch-skill) for perception, evidence,
memory and independent verification.

## Exports

- `@deepwatch/dsh-wiki`

## Install

> **Not on npm yet.** Nothing exists under the `@deepwatch` scope. This
> package is published for the first time by the `deepwatch-v0.1.0`
> release; until then the command below resolves nothing, and
> [the workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme) has the path
> that works from a checkout.

```sh
npm install @deepwatch/dsh-wiki
```

Rarely on its own. [`@deepwatch/dsh-bundle`](https://github.com/oxbshw/watch-skill/tree/main/workspace/packages/watch/bundle#readme)
composes this package with the rest of DeepWatch and is what a profile
normally depends on; installing this one directly is for embedding a
single piece in a composition you control.

## Requirements

- Node `^22.19.0 || >=24.0.0`

## Stability

`0.1.0` — a stable release.

Stable means tested, documented and supported — not 1.0. This is a
pre-1.0 line, and semantic versioning gives `0.x` no compatibility
guarantee across minor versions: **a `0.MINOR` bump may change or remove
surface, and a patch will not.** Depend on it with a tilde range
(`~0.1.0`) if you want that difference enforced by your lockfile
rather than by a changelog. The usual major-version promise starts at 1.0.

## Side effects

Importing a module from this package evaluates no side effects, so a
bundler may drop what a build does not use. Mounting it in a host is a
separate matter: what it then reads or writes is governed by the
workspace boundary and the host's permissions, not by this flag.

## Where this fits

These packages are composed together; installing one on its own is rarely
what you want. The whole picture, the gates it has to pass, and how to run
DeepWatch is in the
[workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme).

## Attribution

Built on DeepSeek Harness · Powered by Watch Skill

DeepWatch and Watch Skill are independent projects and are not affiliated
with or endorsed by DeepSeek. MIT licensed; third-party notices are in
[THIRD_PARTY_NOTICES.md](https://github.com/oxbshw/watch-skill/blob/main/workspace/THIRD_PARTY_NOTICES.md).
