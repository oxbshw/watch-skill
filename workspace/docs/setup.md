# Setting up on a new machine

From a clean checkout to a passing gate suite. Nothing here downloads a model,
requests a device permission, starts a browser or contacts a provider.

The repository holds both halves of the product: Watch Core, the Python engine,
at the root, and this workspace under `workspace/`. Everything below runs from
`workspace/`, and none of it needs Python.

## What you need

| | |
| --- | --- |
| Node | `^22.19.0 \|\| >=24.0.0` (the range `package.json` declares) |
| pnpm | 10 (`corepack enable` gets the pinned version) |
| git | any recent version |

That is the whole list. Watch Core, Python, ffmpeg, OCR engines, ASR and the
browser runtime are optional, and each belongs to a capability you turn on
rather than to the build.

## Three commands

```bash
git clone https://github.com/oxbshw/watch-skill.git
```

```bash
cd watch-skill/workspace && node scripts/bootstrap.mjs
```

```bash
npm run check
```

`bootstrap` installs from the lockfile, checks out the pinned DeepSeek Harness
baseline, and builds. The baseline step matters and is easy to miss: it is not
vendored, several gates read it, and a fresh clone does not have it, so
`npm run check` stops on its first gate without it.

`node scripts/bootstrap.mjs --check` runs the gate suite as a fourth step.

## If something is wrong

```bash
node scripts/doctor.mjs
```

It reports what is required separately from what is optional, and exits non-zero
only when something required is missing. Optional lines name the capability they
belong to, so an absent ffmpeg reads as "video and audio sources unavailable"
rather than as a broken install.

`node scripts/doctor.mjs --json` prints the same findings as machine-readable
output.

## Running the applications

Build a local profile and serve it:

```bash
WATCH_CORE_BIN=<path to the installed watch-skill> node scripts/manual-profile.mjs
```

Watch Core is required rather than optional here: the profile refuses to build
without one instead of composing a Bridge that answers from the test-only mock.
Add `--from-artifacts` to build from the packed release candidate, which
verifies all twenty archives against their recorded digests first.

The script prints the exact command to serve what it built, including the
`DSH_HOME` and the overlay path. Seed the demo fixtures with
`node scripts/seed-manual-fixtures.mjs`; every record it writes is marked
`demo: true`.

For the Desktop application:

```bash
cd apps/desktop && pnpm exec electron .
```

Its application data, DSH home and log directory come from `app.getPath()` and
can be redirected with `WATCH_APP_DATA`, `WATCH_DSH_HOME` and `WATCH_LOG_DIR`.

## Connecting a provider

The workspace runs without one. When you want a model, see
[provider-handoff.md](provider-handoff.md) -- it covers hosted providers, local
OpenAI-compatible servers, where the key is stored, and how to remove it.

## Optional capabilities

| Capability | Needs | Without it |
| --- | --- | --- |
| Watch Core | install the candidate wheel with `watch-skill[loop]` | `auto` attempts the real stdio Bridge and reports unavailable/error; it never falls back to mock |
| OCR, ASR | Python and the engine you choose | Perception shows the engine as not installed |
| Video and audio sources | ffmpeg | those sources are not offered as startable |
| Desktop | Electron, installed by `pnpm install` | the Web application is unaffected |

None of these is downloaded for you, and none is enabled by opening a page.

## What the gate suite covers

`npm run check` runs, in dependency order: inventory freshness, DSH parity,
bundle-row collisions, Desktop security posture, verdict authority, slot
vocabulary and cardinality, portability, signing configuration, generated
artifact freshness, lint, build, the OCR benchmark check, client bundle
contracts, the SBOM, the release manifest, and the test suite.

The smoke checks are separate because they launch real processes:

```bash
npm run smoke:install
npm run smoke:upgrade
npm run smoke:boot
npm run smoke:desktop
```
