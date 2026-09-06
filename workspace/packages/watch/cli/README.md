# @deepwatch/cli

DeepWatch — set up and run the agent workspace built on DeepSeek Harness and powered by Watch Skill

Part of **DeepWatch** — the agent workspace built on the official
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
and powered by [Watch Skill](https://github.com/oxbshw/watch-skill) for perception, evidence, memory and
independent verification.

> **Installed on purpose.**
> Anyone who wants the whole DeepWatch workspace and does not already run a DeepSeek Harness. This is the package behind the `deepwatch` command.

## Exports

- `@deepwatch/cli`

## Peers

Provided by the host rather than installed here:

- `@deepseek-ai/dsh@0.1.1-rc.2` — optional

## Install

> **Not on npm yet.** Nothing exists under the `@deepwatch` scope. This
> package is published for the first time by the `deepwatch-v0.1.0`
> release; until then the command below resolves nothing, and
> [the workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme) has the path
> that works from a checkout.

```sh
npm install @deepwatch/cli
```

## Example

Set up once, then serve a workspace:

```sh
npm install -g @deepwatch/cli
deepwatch doctor              # what is installed, what is missing
deepwatch setup               # build the runtime, compose the profile
deepwatch web --workspace ./my-project
```

## Requirements

- Node `^22.19.0 || >=24.0.0`
- The peers above, supplied by the host composition

Node ≥ 22.19. Python 3.11–3.13 with `watch-skill` installed for the perception and verification half; `deepwatch doctor` reports what is missing and `deepwatch setup` offers to fetch what it can.

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

It composes `@deepwatch/dsh-bundle` into a DeepSeek Harness profile, manages the runtime that profile needs, and serves it. Everything it installs is one of the other nineteen packages.

The twenty packages and how they compose:
[the package map](https://github.com/oxbshw/watch-skill/blob/main/workspace/docs/packages.md).
Running DeepWatch, and the gates a change has to pass:
[the workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme).

## Attribution

Built on DeepSeek Harness · Powered by Watch Skill

DeepWatch and Watch Skill are independent projects and are not affiliated
with or endorsed by DeepSeek. MIT licensed; third-party notices are in
[THIRD_PARTY_NOTICES.md](https://github.com/oxbshw/watch-skill/blob/main/workspace/THIRD_PARTY_NOTICES.md).
