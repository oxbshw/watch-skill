# Watch for DSH

The installable Watch capability bundle for an existing DeepSeek Harness
profile. It gives an agent you already run senses, and an independent answer to
*did that actually work?* — without asking you to move to a different product.

## Install

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

The Bridge finds it on `PATH` and connects on its own.

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

The Bridge runs on its mock backend. It answers the handshake, reports every
capability as `not_tested`, and refuses every real call with the install step
attached. Nothing pretends to work, and the rest of your Workspace is
unaffected.

If Watch Core is installed but fails to start, that is reported as a fault
rather than quietly replaced by the mock — otherwise you would have a green
Workspace and no indication that nothing you ask will ever be answered.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `transport` | `auto` | `auto` connects the engine if installed, else mock. `stdio` requires it. `mock` never starts it. |
| `command` | `watch-skill` | the executable that starts Watch Core in Bridge mode |
| `args` | `[bridge]` | its arguments |
| `startupTimeoutMs` | `10000` | how long the engine has to start |
| `requestTimeoutMs` | `30000` | deadline for a request that carries none |
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
