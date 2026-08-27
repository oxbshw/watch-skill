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

## What is actually built

| Area | State |
|---|---|
| DSH baseline | pinned to `0.1.1-rc.2` @ `b150a551`, consumed as published packages, zero patches |
| Parity register | all 40 DSH client product packages classified, enforced by a gate |
| Bridge | JSON-RPC over stdio, with deadlines, cancellation, correlation and idempotency |
| Watch Core side | `watch-skill bridge`, with capability truth and contract digests |
| Agent tools | capabilities, list, ask, evidence, verify — plus the guidance that governs them |
| Browser half | verdict and evidence cards, registered into DSH's own tool-view slot |
| Contract drift | detected at connect time, scoped to the affected capabilities |

Not yet built: Live, Browser Operator, Library, Compare, Memory, Desktop. The
plan's phase order is deliberate and is being followed.

---

## When something is wrong

```bash
watch-skill doctor      # what the engine can and cannot do here, with fixes
```

In the Workspace, ask the agent to run `watch_capabilities`. Every failing
capability carries what is missing and the step to fix it; none of them report
a bare "setup failed".
