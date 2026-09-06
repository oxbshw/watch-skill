# @deepwatch/dsh-bundle

DeepWatch's capabilities, installable into a DeepSeek Harness profile you
already run. It gives that agent senses, and an independent answer to *did that
actually work?* — without asking you to move to a different product.

The full application is [DeepWatch](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme);
this package is the part of it that composes into somebody else's Harness.

## Install

> **Not on npm yet.** Nothing exists under the `@deepwatch` scope. This package
> and its thirteen siblings are published for the first time by the
> `deepwatch-v0.1.0` release; until then the command below resolves nothing.
> To try it from a checkout, build the candidate tarballs and compose a profile
> against them — [getting started](../../../docs/getting-started.md).

```bash
dsh plugin --profile web add @deepwatch/dsh-bundle
```

That is the whole installation. The package declares `dsh.bundle.patch`, so DSH
reconciles it into the profile's layer stack and applies
[`cordis.patch.yml`](cordis.patch.yml) after its own layers.

For the full experience, install the engine too:

```bash
pip install watch-skill
```

`watch-skill` is on PyPI and installs today; the newest published version is
1.2.0, and the 1.4.0 this bundle is built against is published by the
`core-v1.4.0` release. The Bridge finds the executable on `PATH` and connects
on its own.

## Stability

`0.1.0` — a stable release. Stable means tested, documented and supported —
not 1.0. This is a pre-1.0 line, and semantic versioning gives `0.x` no
compatibility guarantee across minor versions: **a `0.MINOR` bump may change or
remove surface, and a patch will not.** Depend on it with a tilde range
(`~0.1.0`) if you want that difference enforced by your lockfile rather than by
a changelog. The usual major-version promise starts at 1.0.

## What you get

| Tool | What it does |
|---|---|
| `watch_capabilities` | what Watch can actually do here, and what is missing |
| `watch_list_sources` | the sources Watch has indexed |
| `watch_ask_source` | ask a question about a source, answered with timestamped evidence |
| `watch_get_evidence` | resolve a citation and check whether it is still current |
| `watch_verify` | run a verification contract and return an independent verdict |

Plus a browser half that renders verification results as themselves —
`UNVERIFIED` looks like `UNVERIFIED`, and green is reserved for `VERIFIED` —
and a system-prompt section telling the agent that a tool returning without
error is not proof that anything worked.

## Without Watch Core installed

Watch reports itself unavailable. `auto` does not substitute a mock: the
Bridge says `core_missing`, every Watch capability reads **Unavailable**, and
the install step is attached to each of them. Nothing pretends to work, and the
rest of your Workspace is unaffected.

If Watch Core is installed but fails to start, that is reported as a fault too,
with its own fix. Neither case is ever answered from the mock — a Bridge that
did that would give you a green Workspace and no indication that nothing you
ask will ever be answered.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `transport` | `auto` | `auto` connects the engine, and reports it unavailable when it is absent or broken — it never selects the mock. `stdio` is the same transport named explicitly. `mock` is the test-only in-process backend and must be asked for by name. |
| `command` | `watch-skill` | the executable that starts Watch Core in Bridge mode |
| `args` | `[bridge]` | its arguments |
| `startupTimeoutMs` | `45000` | how long the engine has to start. Generous on purpose: a first spawn against a freshly created virtualenv pays for a cold import that a 10s backstop reported as a dead engine. |
| `requestTimeoutMs` | `30000` | deadline for a request that carries none |
| `dataDir` | *(empty)* | where this profile's engine keeps its Library, Memory, receipts and indexes. Empty leaves the engine its own `~/.watch-skill`, which two profiles on one machine would then share. `deepwatch setup` composes a directory inside the profile instead. It is a *default*: an exported `WATCHSKILL_DATA_DIR` still wins, and nothing is migrated into it. |
| `autoConnect` | `true` | connect during activation rather than on first use |

A deployment that requires the engine should pin `transport: stdio`, which
never falls back and so fails loudly when it is missing. A patch replaces the
targeted row's whole `config`, so restate every key you want to keep.

## Uninstall

```bash
dsh plugin --profile web remove @deepwatch/dsh-bundle
```

The rows are purely additive, so removing the bundle leaves the host profile
exactly as it was.

## Attribution

Built on DeepSeek Harness · Powered by Watch Skill. DeepWatch and Watch Skill are
independent projects and are not affiliated with or endorsed by DeepSeek.
