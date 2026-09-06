# @deepwatch/dsh-library

Library — sources, revisions, index state, search, facets and collections

Part of **DeepWatch** — the agent workspace built on the official
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
and powered by [Watch Skill](https://github.com/oxbshw/watch-skill) for perception, evidence, memory and
independent verification.

> **Host plugin — runs beside the agent in the DSH process.**
> Composed by the bundle.

## Exports

- `@deepwatch/dsh-library`
- `@deepwatch/dsh-library/client`
- `@deepwatch/dsh-library/components`
- `@deepwatch/dsh-library/index-store`
- `@deepwatch/dsh-library/library-mode`
- `@deepwatch/dsh-library/read-plane`
- `@deepwatch/dsh-library/search-view`

## Peers

Provided by the host rather than installed here:

- `@deepseek-ai/cordis@4.0.2`
- `@deepseek-ai/dsh-typert-protocol@0.1.1-rc.2`
- `react@^18.2.0`

## Install

> **Not on npm yet.** Nothing exists under the `@deepwatch` scope. This
> package is published for the first time by the `deepwatch-v0.1.0`
> release; until then the command below resolves nothing, and
> [the workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme) has the path
> that works from a checkout.

```sh
npm install @deepwatch/dsh-library
```

Rarely on its own. [`@deepwatch/dsh-bundle`](https://github.com/oxbshw/watch-skill/tree/main/workspace/packages/watch/bundle#readme)
composes this package with the rest of DeepWatch and is what a profile
normally depends on; installing this one directly is for embedding a
single piece in a composition you control.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- The peers above, supplied by the host composition

A Bridge connected to Core, and `libraryRoots` naming the directories the index may read — empty by default, so a deployment that has not said where its evidence lives gets a tool reporting nothing to search rather than one guessing.

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

The catalogue behind the Library screen: sources, revisions, index state, search, facets and collections.

The twenty packages and how they compose:
[the package map](https://github.com/oxbshw/watch-skill/blob/main/workspace/docs/packages.md).
Running DeepWatch, and the gates a change has to pass:
[the workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme).

## Attribution

Built on DeepSeek Harness · Powered by Watch Skill

DeepWatch and Watch Skill are independent projects and are not affiliated
with or endorsed by DeepSeek. MIT licensed; third-party notices are in
[THIRD_PARTY_NOTICES.md](https://github.com/oxbshw/watch-skill/blob/main/workspace/THIRD_PARTY_NOTICES.md).
