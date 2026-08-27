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

## Repository layout

```
upstream/            the pinned DSH baseline (script-managed, never vendored)
inventory/           generated source inventory + the parity register
docs/adr/            decisions that cannot change without a superseding ADR
packages/watch/      the Watch packages composed into every surface
scripts/             upstream sync, inventory generation, parity gate
tests/               contract, transport and protocol tests
```

Watch consumes DeepSeek Harness as **published npm packages pinned to one exact
version**, not as a fork. There are currently zero upstream patches, and the
patch budget is zero. See [ADR-001](docs/adr/ADR-001-dsh-foundation.md).

## What is real today

| Area | State |
|---|---|
| DSH baseline pinned and audited | `0.1.1-rc.2` @ `b150a551` — 247 packages, 44 UI slots, 7 Remote services inventoried |
| Parity register | all 40 DSH client product packages classified, enforced by a gate that fails on anything new |
| ADRs 001–008 | written and binding |
| `@watchskill/dsh-contracts` | Bridge wire contracts, verdict taxonomy, evidence and receipt shapes |
| `@watchskill/dsh-core-bridge` | Host Cordis service: stdio JSON-RPC to Watch Core, plus a mock backend |
| Tests | 29 passing, including the real wire protocol against a child process |

Not yet built: the browser halves, the profile bundle, the Workspace shell,
Memory, Desktop. The plan's phase order is deliberate and is being followed.

## Requirements

- Node `^22.19.0 || >=24.0.0` (inherited from the DSH baseline)
- pnpm 10
- Watch Core (`watch-skill`) — optional; without it the Bridge runs on the mock
  backend and every capability honestly reports `not_tested`

## Getting started

```bash
pnpm install
node scripts/upstream-sync.mjs   # check out the pinned DSH baseline for audit
npm run check                    # inventory + parity + build + tests
```

`npm run check` is the gate. It regenerates nothing silently: if the inventory
or the parity register is stale, it fails and says which file to regenerate.

## The gates, and what they are for

| Command | Refuses to pass when |
|---|---|
| `npm run upstream:verify` | the upstream checkout has drifted from the lock |
| `npm run inventory:check` | the generated inventory no longer matches the baseline |
| `npm run verify:parity` | a DSH capability has no recorded decision |
| `npm run build` | TypeScript does not compile under `strict` |
| `npm test` | a contract or transport invariant regressed |

The parity gate exists because the plan forbids losing an inherited capability
silently. It reads the generated inventory rather than a hand-kept list, so an
upstream bump that adds a package cannot pass until somebody decides what Watch
does with it.

## Attribution

**Built on DeepSeek Harness · Extended by Watch Skill**

Watch Skill is an independent project and is not affiliated with or endorsed by
DeepSeek. DeepSeek Harness is MIT licensed; its notices are preserved in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
