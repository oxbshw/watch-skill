# Watch for DSH

The installable Watch capability bundle for an existing DeepSeek Harness
profile. It gives an agent you already run senses and an independent answer to
*did that actually work?* — without asking you to move to a different product.

## Install

```bash
dsh plugin --profile web add @watchskill/dsh-bundle
```

That is the whole installation. The package declares `dsh.bundle.patch`, so
DSH reconciles it into the profile's layer stack and applies
[`cordis.patch.yml`](cordis.patch.yml) after its own layers.

## What you get

| Tool | What it does |
|---|---|
| `watch_capabilities` | what Watch can actually do here, and what is missing |
| `watch_list_sources` | the sources Watch has indexed |
| `watch_ask_source` | ask a question about a source, answered with timestamped evidence |
| `watch_get_evidence` | resolve a citation and check whether it is still current |
| `watch_verify` | run a verification contract and return an independent verdict |

Plus a system-prompt section telling the agent that a tool returning without
error is not proof that anything worked, and that `UNVERIFIED` is an honest
answer to report rather than a failure to paper over.

## Before you connect Watch Core

Out of the box the Bridge runs on its mock backend. It answers the handshake,
reports every capability as `not_tested`, and refuses every real call with a
stated fix. Nothing pretends to work.

To connect the real engine, install Watch Core and override the transport in
your profile's `cordis.patch.yml`:

```yaml
- id: watch-core-bridge
  config:
    transport: stdio
    command: watch-skill
    args: [bridge]
    cwd: ''
    startupTimeoutMs: 10000
    requestTimeoutMs: 30000
    autoConnect: true
```

A patch replaces the targeted row's whole `config`, so restate every key you
want to keep.

If Watch Core cannot start, the profile still boots: the Workspace opens, the
Watch tools report the failure and its fix, and nothing else is affected.

## Uninstall

```bash
dsh plugin --profile web remove @watchskill/dsh-bundle
```

The rows are purely additive, so removing the bundle leaves the host profile
exactly as it was.

## Attribution

Built on DeepSeek Harness · Extended by Watch Skill. Watch Skill is an
independent project and is not affiliated with or endorsed by DeepSeek.
