# Getting started

Two ways in. Pick the first if you already run DeepSeek Harness and want Watch
inside it; pick the second if you are working on Watch itself.

---

## 1. Add Watch to a Harness you already run

```bash
# the engine that sees and proves
pip install watch-skill

# the capabilities, into the profile you use
dsh plugin --profile web add @watchskill/dsh-bundle
```

Restart the profile. The Bridge finds `watch-skill` on `PATH` and connects on
its own; nothing else needs configuring.

Ask your agent what it can see:

> what can Watch actually do on this machine?

It calls `watch_capabilities` and reports the truth — which senses are
connected, which were only probed, and what is missing with the step to fix it.
A capability that merely resolved a binary is never offered as usable.

### Prove something

The point of Watch is the second half of a task, not the first. Try:

> create `report.txt` with the build summary, then verify it exists

The agent writes the file, then calls `watch_verify` with a deterministic
check. You get a verdict card:

```
VERIFIED   Every required check passed at assurance deterministic.
  ✓ the file exists
  1 of 1 checks ran · contract sha256:9f2c1a8b40de
```

Now try one it cannot prove:

> tell me the deploy worked

```
UNVERIFIED   Nothing executable was checked, so nothing was established.
```

That is the product working, not failing. `UNVERIFIED` means no claim was
made — it is neither a pass nor a failure, and it never renders green.

### Without the engine

If `watch-skill` is not installed, the Workspace still boots and the Watch
tools still answer — with a refusal that names the install step. Every
capability reports `not_tested`. Nothing pretends to work.

If `watch-skill` *is* installed and fails to start, that is reported as a
fault rather than hidden behind the mock. A green Workspace over a dead engine
is the one outcome worth avoiding.

---

## 2. Work on Watch Workspace

```bash
pnpm install
node scripts/upstream-sync.mjs   # check out the pinned DSH baseline for audit
npm run check
```

`npm run check` is the gate:

| Step | Refuses to pass when |
|---|---|
| `inventory:check` | the generated inventory no longer matches the pinned baseline |
| `verify:parity` | a DSH capability has no recorded decision |
| `verify:bundle` | a bundle row id collides with an upstream row |
| `build` | TypeScript does not compile under `strict` |
| `verify:client` | a browser bundle does not match the DSH loader contract |
| `test` | a contract, transport or presentation invariant regressed |

### Running the tests against the real engine

The integration suite skips when Watch Core is absent, and prints why — a
silent skip in CI reads as a pass. To run it:

```bash
WATCH_CORE_COMMAND=watch-skill npm test
```

Or against a checkout rather than an installed package:

```bash
WATCH_CORE_COMMAND=python \
WATCH_CORE_ARGS="-m watch_skill.surfaces.cli.main bridge" \
npm test
```

### Proving the install path

```bash
npm run smoke:install
```

This packs the workspace packages, lets DSH initialize a throwaway profile
from its own shipped template, installs the bundle with the real `dsh plugin
add`, and asks DSH to compose the tree. It asserts both directions: the Watch
rows are present, and the upstream rows are still there.

It needs the pinned CLI beside the repository:

```bash
mkdir ../watch-smoke && cd ../watch-smoke && npm install @deepseek-ai/dsh@0.1.1-rc.2
```

---

## The tools an agent gets

| Tool | What it does |
|---|---|
| `watch_capabilities` | what Watch can do here, and what is missing |
| `watch_list_sources` / `watch_search_sources` | what is indexed; which source mentioned something |
| `watch_ask_source` | ask about a source, answered with timestamped evidence |
| `watch_moment` | what was on screen when they said that |
| `watch_get_evidence` | resolve a citation and check it is still current |
| `watch_capture_capabilities` | what this machine can actually record |
| `watch_watch_live` and friends | start, read, question, inspect and stop a live session |
| `watch_browser_observe` / `_act` / `_receipt` | act on a page and prove what happened |
| `watch_verify` | run a contract and return an independent verdict |
| `watch_remember` and friends | memory, when the Memory service is mounted |

## Turning memory on

Memory ships `off`. Durable memory about a person is not something a
deployment should acquire because nobody changed a setting.

Add this to your profile's `cordis.patch.yml`:

```yaml
- id: watch-memory
  config:
    mode: 'local_personal'
    directory: .watch/memory
    inferredThreshold: 0.8
    tokenBudget: 600
    writeProjections: true
```

The quotes on `'local_personal'` are not decoration — YAML reads a bare
`off` as the boolean false. A patch replaces the whole config, so restate
every key you want to keep.

What you get is a `taste.md` you can read and edit, a correction that takes
effect on the agent's next turn, and a Forget that removes a memory from
retrieval, from the files, and from every rebuild rather than hiding it.

## What is actually built

| Area | State |
|---|---|
| DSH baseline | pinned to `0.1.1-rc.2` @ `b150a551`, consumed as published packages, zero patches |
| Parity register | all 40 DSH client product packages classified, enforced by a gate |
| Bridge | JSON-RPC over stdio: deadlines, cancellation, correlation, durable idempotency |
| Watch Core side | `watch-skill bridge`, with capability truth and contract digests |
| Agent tools | 16, covering the senses, the browser operator and verification |
| Memory | event ledger, correction precedence, real forgetting, Context Compiler |
| Browser half | verdict and evidence cards in DSH's own tool-view slot |
| Contract drift | detected at connect time, scoped to the affected capabilities |

Not yet built: the branded Workspace shell, the Technology & Capability
Center, Compare, Desktop, and team multi-tenancy.

## When something is wrong

```bash
watch-skill doctor      # what the engine can and cannot do here, with fixes
```

In the Workspace, ask the agent to run `watch_capabilities`. Every failing
capability carries what is missing and the step to fix it; none of them report
a bare "setup failed".
