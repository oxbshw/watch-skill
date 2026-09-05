# Installing and upgrading

Two products, two package managers, two upgrade stories. This page covers both
and is honest about which parts have been exercised and which have not.

> **Registry status.** `watch-skill` is on PyPI; the newest published version is
> 1.2.0, and 1.4.0 is published by the `core-v1.4.0` release. Nothing exists
> under the `@deepwatch` scope at all — the twenty packages are published for
> the first time by `deepwatch-v0.1.0`. Until those tags run, the registry
> commands below are the commands you *will* run, and the from-a-checkout path
> is the one that works today.

---

## Watch Skill (the engine)

### Install

```bash
pip install watch-skill
# or, for an isolated tool install:
uv tool install watch-skill
```

Then check what this machine can actually do:

```bash
watch-skill doctor
```

`doctor` is not a status page. It installs what it can — ffmpeg via winget,
choco or a portable build; yt-dlp; the OCR data — and reports each remaining
gap with the command that closes it. Run it before filing anything.

### Optional capabilities

Each is optional because each costs something, and the product says which are
off rather than showing a plausible default.

| Capability | Install | Why it is not default |
| --- | --- | --- |
| Browser / THE LOOP | `pip install 'watch-skill[loop]' && playwright install chromium` | a browser engine is a large download |
| Speaker labels | `pip install 'watch-skill[diarize]'` | needs a Hugging Face token |
| Cloud vision / speech | `watch-skill setup-vision` | reaches a provider, so it is opt-in |

### Requirements

- Python 3.11, 3.12 or 3.13. Those are the versions CI runs and the classifiers
  declare; 3.14 is not in the tested matrix.
- **ffmpeg 5.1 or newer.** `doctor` warns below that and says why: the
  benchmark frame extractor passes `-fps_mode:v passthrough`, the per-stream
  option ffmpeg added in 5.1 to replace the global `-vsync` it has since
  removed. The video and audio pipelines themselves run on older builds; only
  fixture regeneration needs the floor.

### Upgrade

```bash
pip install -U watch-skill
watch-skill doctor
```

The index, evidence and verification records live in the data directory
(`~/.watch-skill`, or wherever `WATCHSKILL_DATA_DIR` points) and are not
touched by a package upgrade. The store carries a schema version and **a newer
store is refused rather than migrated silently** — so a downgrade after an
upgrade that moved the schema will say so instead of reading it wrong.

Back up the data directory before a major upgrade if the evidence in it
matters. It is a directory of SQLite files and frames; copying it is enough.

---

## DeepWatch (the workspace)

### Install

```bash
npm install -g @deepwatch/cli        # pending the deepwatch-v0.1.0 release
deepwatch setup
deepwatch web --workspace ./my-project
```

`setup` builds the runtime and composes the profile. `--workspace` names the
one directory the agent's files, the shell, containment, the verifier, receipts
and the Library all resolve against; a run that cannot establish it stops with
a named fix rather than guessing.

Requires Node ≥ 22.19 and Python ≥ 3.11 (the Bridge starts Watch Core).

### From a checkout, today

```bash
# in workspace/
pnpm install
npm run release:artifacts        # packs and verifies all twenty tarballs
node scripts/manual-profile.mjs --from-artifacts
```

Every tarball's digest is checked before the profile is served. See
[getting started](getting-started.md).

### Upgrade

```bash
npm install -g @deepwatch/cli@latest      # pending the first release
deepwatch setup                            # recompose the profile
```

**`setup` after an upgrade is not optional.** DeepWatch composes a Cordis
profile from layered patches, and an upgrade replays the whole layer stack. Two
things go wrong quietly if the stack is not recomposed:

- a row the new layer adds that the old one also had composes **twice** — two
  Bridges, two tool registrations, and a session that behaves differently
  depending on which one answered;
- a row the new layer stops declaring disappears, and a capability vanishes
  from a working installation with nothing in the output saying so.

Neither raises an error, and both are visible in the composed tree. That is
what `npm run smoke:upgrade` compares, row by row, before and after — along
with the memory ledger, the evidence ids in it and the profile's own settings,
which are written between the two installs and read back after.

### Downgrade

Not supported, and said plainly rather than promised. Package managers do not
generally offer a safe downgrade of a composed profile, and the upgrade smoke
attempts a rollback only to record where the boundary is. If you need to go
back, compose a fresh profile at the older version against a fresh data
directory.

### Compatibility policy

The `@deepwatch/*` packages are `0.1.0`. **Stable means tested, documented and
supported — not 1.0.** Semantic versioning gives `0.x` no compatibility
guarantee across minor versions: a `0.MINOR` bump may change or remove surface,
and a patch will not. Pin with a tilde range (`~0.1.0`) if you want that
enforced by your lockfile rather than by a changelog. The usual major-version
promise starts at 1.0.

Watch Skill is `1.4.0` and is on the 1.x line, where a minor release adds and a
major release is where a removal may happen. The Bridge protocol between them
carries its own version and is negotiated at handshake; a Host and an engine
that cannot agree fail closed and say so.

---

## What an upgrade does not do

There is no self-healing, no automatic task resumption, no autonomous learning
and no encryption at rest in this release. The memory store is plaintext and
the product says so where you enable it. Redaction converts named path fields;
it does not rewrite evidence, transcripts or your own messages, and it cannot
reach into a raw argument string an upstream surface renders for itself.

See [known limitations](known-limitations.md) for the full list.
