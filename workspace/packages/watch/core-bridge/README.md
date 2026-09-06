# @deepwatch/dsh-core-bridge

Host plugin: the typed Bridge between DeepSeek Harness and Watch Core

Part of **DeepWatch** — the agent workspace built on the official
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
and powered by [Watch Skill](https://github.com/oxbshw/watch-skill) for perception, evidence, memory and
independent verification.

> **Host plugin — runs beside the agent in the DSH process.**
> Composed by the bundle. Install it directly only to speak to Watch Core from a host of your own.

## Exports

- `@deepwatch/dsh-core-bridge`

## Peers

Provided by the host rather than installed here:

- `@deepseek-ai/cordis@4.0.2`
- `@deepseek-ai/schemastery@^3.18.1`

## Install

> **Not on npm yet.** Nothing exists under the `@deepwatch` scope. This
> package is published for the first time by the `deepwatch-v0.1.0`
> release; until then the command below resolves nothing, and
> [the workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme) has the path
> that works from a checkout.

```sh
npm install @deepwatch/dsh-core-bridge
```

Rarely on its own. [`@deepwatch/dsh-bundle`](https://github.com/oxbshw/watch-skill/tree/main/workspace/packages/watch/bundle#readme)
composes this package with the rest of DeepWatch and is what a profile
normally depends on; installing this one directly is for embedding a
single piece in a composition you control.

## Configuration

Supplied by the host when it mounts this plugin.

| Option | Type | |
| --- | --- | --- |
| `transport` | `'auto' | 'stdio' | 'mock'` | How to reach Watch Core. |
| `command` | `string` | Executable that starts Watch Core in Bridge mode. |
| `args` | `string[]` |  |
| `cwd` | `string` | Working directory for the child. |
| `startupTimeoutMs` | `number` |  |
| `requestTimeoutMs` | `number` | Deadline applied to a request that does not carry its own. |
| `dataDir` | `string` | Profile-scoped data directory for the engine. |
| `autoConnect` | `boolean` | Connect during plugin activation rather than on first use. |
| `failuresBeforeOpen` | `number` | Consecutive connection failures before the Bridge stops trying. |
| `initialCooldownMs` | `number` | First cooldown after the circuit opens. |
| `maxCooldownMs` | `number` | Ceiling for the cooldown, so backoff cannot grow without bound. |

## Requirements

- Node `^22.19.0 || >=24.0.0`
- The peers above, supplied by the host composition

`watch-skill` reachable on `PATH`, or an explicit `command`. Without one the Bridge reports `core_missing` and leaves the workspace usable with Watch features disabled — it does not fall back to a mock.

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

The only thing that talks to Watch Core. Every other package reaches Core through it, which is what makes Core the sole source of a verdict.

The twenty packages and how they compose:
[the package map](https://github.com/oxbshw/watch-skill/blob/main/workspace/docs/packages.md).
Running DeepWatch, and the gates a change has to pass:
[the workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme).

## Attribution

Built on DeepSeek Harness · Powered by Watch Skill

DeepWatch and Watch Skill are independent projects and are not affiliated
with or endorsed by DeepSeek. MIT licensed; third-party notices are in
[THIRD_PARTY_NOTICES.md](https://github.com/oxbshw/watch-skill/blob/main/workspace/THIRD_PARTY_NOTICES.md).
