# Watch Workspace

An evidence-native agent workspace built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> DeepSeek Harness provides the agent runtime, workspace, model and plugin
> foundation. Watch adds perception, temporal memory, evidence and independent
> verification.

The difference from an ordinary agent workspace is one question it can answer:
**did that actually work?** — separately from whether the agent said it did.

```
Agent status:  completed
Verification:  UNVERIFIED
Reason:        no executable expectation
```

That is a normal outcome here, and it is never rendered as success.

## Getting started

Add Watch to a Harness you already run:

```bash
pip install watch-skill
```

```bash
dsh plugin --profile web add @watchskill/dsh-bundle
```

The Bridge finds the engine on `PATH` and connects on its own. Without it, the
Workspace still works and every capability honestly reports `not_tested`.

Or work on the Workspace itself:

```bash
pnpm install
```

```bash
npm run check
```

Full walkthrough in [docs/getting-started.md](docs/getting-started.md); the
design and the reasoning behind it in [docs/architecture.md](docs/architecture.md).

## Repository layout

```
upstream/            the pinned DSH baseline (script-managed, never vendored)
inventory/           generated source inventory + the parity register
docs/adr/            decisions that cannot change without a superseding ADR
packages/watch/      the Watch packages composed into every surface
scripts/             upstream sync, inventory, gates, build, install smoke
tests/               contract, transport, presentation and protocol tests
```

Watch consumes DeepSeek Harness as **published npm packages pinned to one exact
version**, not as a fork. There are currently zero upstream patches, and the
patch budget is zero. See [ADR-001](docs/adr/ADR-001-dsh-foundation.md).

## What is real today

| Area | State |
|---|---|
| DSH baseline | pinned to `0.1.1-rc.2` @ `b150a551`, consumed as published packages, zero patches |
| Source audit | 247 packages, 488 composition rows, 44 UI slots, 7 Remote services inventoried |
| Parity register | all 40 DSH client product packages classified, enforced by a gate |
| ADRs 001-008 | written and binding |
| Bridge | JSON-RPC over stdio: deadlines, cancellation, correlation, durable idempotency |
| Watch Core side | `watch-skill bridge` — 17 methods, capability truth, published contract digests |
| Agent tools | 16 tools: senses, search, live, browser operator, verification |
| Memory | event ledger, correction precedence, real forgetting, `taste.md`, Context Compiler |
| Browser operator | observe -> act -> re-observe -> verdict, with approval and receipt replay |
| Browser half | verdict and evidence cards, in DSH's own tool-view slot |
| Contract drift | detected at connect time, scoped to the affected capabilities |
| Install path | proven against a real stock DSH profile by the install smoke |
| Tests | 141 workspace + 159 Watch Core surfaces, all passing |

Not yet built: the branded Workspace shell, the Technology & Capability
Center, Compare, Desktop, and team multi-tenancy. The plan's phase order is
deliberate and is being followed.

## Requirements

- Node `^22.19.0 || >=24.0.0` (inherited from the DSH baseline)
- pnpm 10
- Watch Core (`watch-skill`) — optional; without it the Bridge runs on its mock
  backend and every capability honestly reports `not_tested`

## The gates, and what they are for

| Command | Refuses to pass when |
|---|---|
| `npm run upstream:verify` | the upstream checkout has drifted from the lock |
| `npm run inventory:check` | the generated inventory no longer matches the baseline |
| `npm run verify:parity` | a DSH capability has no recorded decision |
| `npm run verify:bundle` | a bundle row id collides with an upstream row |
| `npm run verify:client` | a browser bundle does not match the DSH loader contract |
| `npm run build` | TypeScript does not compile under `strict` |
| `npm test` | a contract, transport or presentation invariant regressed |
| `npm run smoke:install` | the bundle no longer installs into a stock DSH profile |

Two of these guard failures that nothing else would catch.

The **parity gate** exists because the plan forbids losing an inherited
capability silently. It reads the generated inventory rather than a hand-kept
list, so an upstream bump that adds a package cannot pass until somebody
decides what Watch does with it.

The **bundle gate** guards a footgun in Cordis patch overlays: a row whose id
collides with an existing one does not add anything, it *replaces* that row's
whole config. Nothing in the loader warns about it, which is how a distribution
disables an upstream capability while believing it added one.

## Attribution

**Built on DeepSeek Harness · Extended by Watch Skill**

Watch Skill is an independent project and is not affiliated with or endorsed by
DeepSeek. DeepSeek Harness is MIT licensed; its notices are preserved in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
