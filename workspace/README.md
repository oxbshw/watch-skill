# DeepWatch

DeepWatch is the Web and Desktop agent product built on the official
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) packages and
powered by [Watch Skill](../README.md) for perception, evidence, memory and
independent verification.

The difference from an ordinary agent workspace is one question it can answer:
did that actually work, separately from whether the agent said it did.

```
Agent status:  completed
Verification:  UNVERIFIED
Reason:        no executable expectation
```

That is a normal outcome here, and it is never rendered as success.

**Nothing is published.** The twenty `@deepwatch/*` packages have not been
released to npm, so there is no `npx @deepwatch/cli` and no document here may
say there is. What has been exercised is the packed artifact a publish would
upload — see [Packaging and release](#packaging-and-release).

## Contents

- [What it is built on](#what-it-is-built-on)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [The `deepwatch` command](#the-deepwatch-command)
- [The DeepSeek Harness prerequisite](#the-deepseek-harness-prerequisite)
- [Watch Skill Core, and what happens without it](#watch-skill-core-and-what-happens-without-it)
- [The application](#the-application)
- [Configuration and where things live](#configuration-and-where-things-live)
- [Providers](#providers)
- [Security posture](#security-posture)
- [Repository layout](#repository-layout)
- [The gates, and what they are for](#the-gates-and-what-they-are-for)
- [Packaging and release](#packaging-and-release)
- [Generated evidence](#generated-evidence)
- [Manual QA and screenshots](#manual-qa-and-screenshots)
- [Platform support and signing](#platform-support-and-signing)
- [What is real today](#what-is-real-today)
- [Documentation](#documentation)
- [Attribution](#attribution)

## What it is built on

DeepSeek Harness provides the agent runtime, workspace, model and plugin
foundation. DeepWatch adds perception, temporal memory, evidence and
independent verification, and composes them the way the Harness expects a
distribution to: as Cordis patch overlays over published packages.

The Harness is consumed as **published npm packages pinned to one exact
version**, never as a fork. There are zero upstream patches and the patch budget
is zero — see [ADR-001](docs/adr/ADR-001-dsh-foundation.md). The pinned baseline
is `0.1.1-rc.2` at commit `b150a551`.

## Requirements

- Node `^22.19.0 || >=24.0.0`, inherited from the Harness baseline
- pnpm 10
- DeepSeek Harness `0.1.1-rc.2` — an exact optional peer dependency, which
  `deepwatch setup` installs after asking
- Watch Skill (`pip install watch-skill`), optional; without it every Watch
  capability reports unavailable rather than pretending

## Getting started

From a clone:

```bash
cd workspace && node scripts/bootstrap.mjs
```

`bootstrap.mjs` installs dependencies and fetches the pinned Harness source that
inventory generation and parity diffing read. `npm run check` needs it and a
fresh clone does not have it, so this comes first.

Then, to run every gate:

```bash
npm run check
```

New machine? [docs/setup.md](docs/setup.md) is three commands and a doctor. The
full walkthrough is [docs/getting-started.md](docs/getting-started.md), and the
design with the reasoning behind it is
[docs/architecture.md](docs/architecture.md).

To test DeepWatch in a Harness profile before npm publication:

```bash
npm run release:artifacts
WATCH_CORE_BIN=watch-skill node scripts/manual-profile.mjs --from-artifacts
```

The script verifies and installs local tarballs. A registry-name install is not
documented until the first publication exists.

## The `deepwatch` command

`@deepwatch/cli` is the one program whose job is to tell the truth about the
machine it is on.

| Command | What it does |
| --- | --- |
| `deepwatch` | reports what this machine has and names the one next step |
| `deepwatch doctor` | what is installed, what is missing, and how to fix each |
| `deepwatch setup` | composes the DeepWatch profile; safe to re-run |
| `deepwatch web` | runs DeepWatch in a browser, bound to loopback |
| `deepwatch desktop` | runs the desktop application |

`--json` where a command has machine-readable output, `--yes` to agree to the
download `setup` describes, `--offline` to refuse the network outright, and
`--profile`, `--port` and `--workspace` for `web`.

`--workspace <dir>` names the one directory DeepWatch works in, and it is one
directory on purpose. The agent's filesystem tools, the shell, Watch
containment, the verifier, receipts and the Library all resolve a relative path
like `owner-test/totals.json` against the same root, so a file the agent writes
is a file the verifier can find. It defaults to the directory you run the
command from; a directory that does not exist is refused rather than created,
and a run that cannot establish a workspace stops with a named fix instead of
guessing one.

Two rules govern what may appear there. **Every command is backed by something
real** — a subcommand that printed a plan, or that would work once something
else existed, is the product claiming a capability it does not have. And
**nothing reaches a provider**: setup and doctor make no model call, read no key
and upload nothing.

## The DeepSeek Harness prerequisite

`@deepwatch/cli` declares `@deepseek-ai/dsh` as an **exact optional peer
dependency**. Declared, so the requirement and the supported version are visible
in the manifest, in `npm ls`, in the lockfile and to anyone reviewing what this
product needs. Optional, because somebody running `deepwatch --help` asked for a
CLI, not for four hundred packages and a set of prebuilt native binaries.

`deepwatch setup` is the one command that may fetch it, and before it does it
prints exactly what it would download:

```
  registry     https://registry.npmjs.org
  package      @deepseek-ai/dsh
  version      0.1.1-rc.2   (exact — never a range)
  into         <DeepWatch home>/harness
```

Then it asks. With no terminal to ask on it refuses unless `--yes` was passed,
and `--offline` refuses regardless. An existing Harness is reused when its
version matches and **refused rather than replaced** when it does not — somebody
else's installation is not this command's to overwrite — and every install
leaves a receipt saying what was written and how to remove it.

That closure includes prebuilt native binaries, one of them under
`Apache-2.0 AND LGPL-3.0-or-later`. DeepWatch redistributes none of them: the
user's own package manager fetches them under their publishers' terms. The
twenty-six packages whose licences fall outside this distribution's allowlist
are reviewed individually in
[`inventory/licence-review.json`](inventory/licence-review.json), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) names the LGPL component and
the decision a *bundling* installer would still have to make.

## Watch Skill Core, and what happens without it

The Watch Bridge speaks JSON-RPC over stdio to `watch-skill bridge`: seventeen
methods, with deadlines, cancellation, correlation and durable idempotency.
DeepWatch finds the engine on `PATH`, or wherever `WATCH_CORE_BIN` names.

Without it, DeepWatch still runs. Every Watch capability reports as unavailable
and no verdict is manufactured — an absent judgement is `inconclusive`, never a
pass. Contract drift between the two is detected at connect time and scoped to
the affected capabilities rather than failing the whole surface.

`WATCH_CORE_BIN` keeps its prefix on purpose: it names a *Watch Skill*
executable, not a DeepWatch setting.

## The application

Seven modes, in the Harness's own session tablist: **Chat**, **Trajectory**,
**Watch**, **Live**, **Memory**, **Library** and **Compare**.

- **Library** — a local inverted index with health reporting, generation-based
  atomic swap, and refresh without a Host restart
  ([ADR-009](docs/adr/ADR-009-local-library-index.md)).
- **Compare** — a deterministic six-disposition comparison, with verification
  kept apart from output.
- **Live** — seven sources, permission asked on explicit start only, one source
  able to act.
- **Technology Center** — seven settings sections: roles, perception, sources,
  memory, verification, diagnostics and about.

The Desktop application is an Electron shell supervising a real Host that spawns
a real Core. It is `@deepwatch/desktop`, it is private, and it ships as a signed
platform installer rather than from npm.

## Configuration and where things live

| Variable | What it moves |
| --- | --- |
| `DEEPWATCH_HOME` | everything DeepWatch writes, so an uninstall is one directory |
| `DEEPWATCH_PROFILE` | which profile to compose into (default `deepwatch`) |
| `DEEPWATCH_HOST`, `--port` | where `deepwatch web` binds (loopback by default) |
| `DEEPWATCH_WORKSPACE`, `--workspace` | the one directory tools, containment and the verifier share |
| `DEEPWATCH_DSH_BIN` | an explicit Harness, overriding detection |
| `DEEPWATCH_DESKTOP_BIN` | an installed desktop application to launch |
| `DSH_HOME` | the Harness's own variable, passed through unchanged |
| `WATCH_CORE_BIN` | the Watch Skill engine, when it is not on `PATH` |

`deepwatch web` binds loopback unless a host is named, because a workspace that
reads a person's evidence should not become reachable from their network because
a default said so.

## Providers

DeepWatch makes no provider call of its own. A person connects a provider
afterwards, through DeepWatch's own settings, and that is a separate consent
from holding a key. `inventory/providers.json` records the thirty hosted and
seven self-hosted providers the Harness baseline knows about, and
[docs/provider-handoff.md](docs/provider-handoff.md) describes where the
boundary sits.

## Security posture

- **Zero non-loopback egress**, proven at the process boundary rather than by
  stubbing `fetch`: `tests/offline-egress.test.mjs` patches every socket, TLS
  and DNS path before product code loads, and a self-test arm attempts a real
  connection to prove the instrument works.
- **Untrusted origins are refused** by the Desktop shell, checked by
  `verify:desktop` rather than asserted in prose.
- **Nothing reads a provider credential** outside the settings path that exists
  to hold one — including, specifically, the Harness provisioning code.
- **Nothing in a packed tarball may be a credential, a `.env`, a log, a QA
  profile, or a path from the machine that built it.**
  `scripts/pack-release.mjs` opens every tarball and checks, and reports a
  finding by file and rule without quoting what it found.

## Repository layout

```
upstream/            the pinned Harness baseline (script-managed, never vendored)
inventory/           generated source inventory, parity register, licence review
docs/adr/            decisions that cannot change without a superseding ADR
packages/watch/      the twenty packages composed into every surface
apps/desktop/        the Electron application and its supervised Host
scripts/             upstream sync, inventory, gates, build, pack, QA capture
tests/               contract, transport, presentation and protocol tests
```

## The gates, and what they are for

| Command | Refuses to pass when |
|---|---|
| `npm run upstream:verify` | the upstream checkout has drifted from the lock |
| `npm run verify:graph` | the first-party dependency graph has a cycle |
| `npm run verify:publishable` | a package is missing publishable metadata, or a private one could be published |
| `npm run inventory:check` | the generated inventory no longer matches the baseline |
| `npm run verify:parity` | a Harness capability has no recorded decision |
| `npm run verify:bundle` | a bundle row id collides with an upstream row |
| `npm run verify:slots` | a registration targets a slot the Harness does not render |
| `npm run verify:portability` | shipped code assumes the machine it was written on |
| `npm run verify:signing` | the signing configuration is not release-ready |
| `npm run verify:client` | a browser bundle does not match the loader contract |
| `npm run sbom` | a dependency's licence is neither allowed nor deliberately reviewed |
| `npm run build` | TypeScript does not compile under `strict` |
| `npm test` | a contract, transport or presentation invariant regressed |
| `npm run smoke:install` | the bundle no longer installs into a stock Harness profile |
| `npm run release:artifacts` | a packed tarball is wrong, or will not install and run |

`npm run check` runs the static and build gates in dependency order.

Four of these guard failures that nothing else would catch.

The **parity** gate exists because losing an inherited capability silently is
the failure mode a fork invites. It reads the generated inventory rather than a
hand-kept list, so an upstream bump that adds a package cannot pass until
somebody decides what DeepWatch does with it.

The **bundle** gate guards a footgun in Cordis patch overlays: a row whose id
collides with an existing one does not add anything, it replaces that row's
whole config. Nothing in the loader warns about it, which is how a distribution
disables an upstream capability while believing it added one.

The **slot** gate exists because `slots.register` accepts any string. Twelve
registrations once targeted slot names that did not exist, and every gate stayed
green while the interface drew nothing.

The **packed-artifact** gate is the only one that measures from outside. It
packs, installs into a project that has never seen this repository, and refuses
if anything resolves back into the source tree — which is how a `workspace:`
range, a missing generated declaration, or a `files` glob that stopped matching
gets caught before somebody's install rather than after.

## Packaging and release

Twenty packages are publishable. `@deepwatch/monorepo` and `@deepwatch/desktop`
are held back by a gate that refuses to pack them.

```bash
npm run release:artifacts
```

That packs all twenty from a canonical manifest, so two packs of one commit
produce twenty identical archives; installs them into a clean project; and
runs the CLI through `npm exec`, `npx`, `pnpm` and a global install into a
temporary prefix.

It writes two inventories, because there are two questions.
[`inventory/packed-artifacts.json`](inventory/packed-artifacts.json) is tracked
and says what a pack of this source is expected to produce — names, versions,
access, file lists, dependency sets, exports and publish order — so packing
does not dirty the worktree. `.release-artifacts/packed-artifacts.json` is
ignored, sits beside the tarballs, and carries the digests of *those* archives,
which is what every digest check reads.

Two release trains, and no shared `v*` trigger: `core-v*` publishes Watch Skill
to PyPI, `deepwatch-v*` publishes these packages to npm. Publishing uses npm
Trusted Publishing with provenance and no token fallback, behind a protected
environment a human approves. **Neither train has ever run.**
[docs/releasing.md](docs/releasing.md) has the dist-tag policy, the publish
order, and the recovery procedure for a release that stops half way.

## Generated evidence

Nothing in this list is hand-edited. Each has a generator and a `--check` mode
that fails when the committed copy has drifted.

| Artifact | What it records |
| --- | --- |
| [`docs/sbom.json`](docs/sbom.json) | every first- and third-party package, read from the lockfile rather than the disk |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | upstream licence text, the Harness closure, and the one LGPL component |
| [`docs/release-manifest.json`](docs/release-manifest.json) | protocol versions, contract families and store schema |
| [`inventory/`](inventory/) | the source inventory, parity register, provider inventory and licence review |
| [`docs/spec-closure-matrix.md`](docs/spec-closure-matrix.md) | every specification claim and the artifact that closes it |
| [`docs/implementation-status.md`](docs/implementation-status.md) | what is built, what is not, and what was measured |
| [`docs/screenshot-manifest.md`](docs/screenshot-manifest.md) | every committed screenshot, with its hash and what it shows |

## Manual QA and screenshots

[docs/manual-test-checklist.md](docs/manual-test-checklist.md) is the pass a
person runs: Web boot, Desktop boot, all seven modes, the Technology Center,
diagnostics, Library search and refresh, degraded states, and narrow and wide
layouts. The QA profile is built by `node scripts/manual-profile.mjs` into a
directory you choose — `WATCH_MANUAL_ROOT` — and the screenshots in
[`docs/screenshots/`](docs/screenshots/) are captured from a committed build,
hashed, and described in the manifest.

## Platform support and signing

[docs/platform-support.md](docs/platform-support.md) records what has actually
been run on which operating system, rather than what is expected to work.
[docs/signing.md](docs/signing.md) records what a signed release still needs.
`verify:signing` checks the configuration on every run and fails closed only
when a release is actually requested, so no workflow can quietly emit an
unsigned artifact labelled as released.

## What is real today

| Area | State |
|---|---|
| Harness baseline | pinned to `0.1.1-rc.2` @ `b150a551`, consumed as published packages, zero patches |
| Source audit | 247 packages, 488 composition rows, 44 UI slots, 7 Remote services inventoried |
| Parity register | all 40 Harness client product packages classified, enforced by a gate |
| ADRs 001–009 | written and binding |
| Bridge | JSON-RPC over stdio: deadlines, cancellation, correlation, durable idempotency |
| Reconnect | single-flight, circuit-broken, bounded backoff with `retryAfterMs` |
| Watch Core side | `watch-skill bridge` — 17 methods, capability truth, published contract digests |
| Agent tools | 17 tools: senses, search, library search, live, browser operator, verification |
| Memory | event ledger, correction precedence, real forgetting, `taste.md`, Context Compiler |
| Browser operator | observe, act, re-observe, verdict, with approval and receipt replay |
| Workspace shell | seven modes in the Harness's own session tablist |
| Technology Center | seven settings sections |
| Library | local inverted index with health reporting, refresh and rebuild |
| Compare | deterministic six-disposition comparison |
| Live | seven sources, permission on explicit start only |
| Desktop | Electron application supervising a real Host that spawns real Core |
| Packaging | 20 packages packed, installed from tarballs, and run through every runner |
| Publishing | configured, gated, and never executed |
| Tests | every workspace suite green under `npm run check` |

Not built: team multi-tenancy beyond the two-tenant isolation tests, and any
signed distribution.

## Documentation

| Guide | Use it for |
| --- | --- |
| [docs/setup.md](docs/setup.md) | a new machine, in three commands |
| [docs/getting-started.md](docs/getting-started.md) | the full walkthrough |
| [docs/install-and-upgrade.md](docs/install-and-upgrade.md) | installing both products, upgrading, and the compatibility policy |
| [docs/architecture.md](docs/architecture.md) | the design and the reasoning |
| [docs/running-the-apps.md](docs/running-the-apps.md) | Web and Desktop, day to day |
| [docs/releasing.md](docs/releasing.md) | the two trains, dist-tags and recovery |
| [docs/provider-handoff.md](docs/provider-handoff.md) | where the provider boundary sits |
| [docs/known-limitations.md](docs/known-limitations.md) | what this release does not do, and why |
| [docs/screenshots-release.md](docs/screenshots-release.md) | the release screenshots, what each shows, and what none of them show |
| [docs/platform-support.md](docs/platform-support.md) | what was run where |
| [docs/upstream-hero-extension-request.md](docs/upstream-hero-extension-request.md) | the one remaining upstream visual seam |
| [docs/signing.md](docs/signing.md) | what a signed release still needs |
| [docs/adr/](docs/adr/) | decisions that need a superseding ADR to change |
| [docs/history/](docs/history/) | records of past runs, kept out of current navigation |

## Attribution

Built on DeepSeek Harness · Powered by Watch Skill

DeepWatch and Watch Skill are independent projects and are not affiliated with
or endorsed by DeepSeek. DeepSeek Harness is MIT licensed; its notices are
preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
