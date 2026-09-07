# Releasing

Two products live in this repository and each has its own train.

| Train | Tag | Publishes | Workflow |
| --- | --- | --- | --- |
| Watch Core | `core-v<version>` | PyPI, the Claude Skill bundle, the MCP registry entry | `.github/workflows/release.yml` |
| DeepWatch | `deepwatch-v<version>` | the twenty `@deepwatch/*` npm packages | `.github/workflows/release-deepwatch.yml` |

There is no `v*` trigger any more. There used to be, and it meant a tag
intended for one product built and published the other from whatever the tree
happened to contain at that moment.

**The two trains are not in the same position, and saying they were was
wrong.**

*DeepWatch has never published.* Nothing exists under the `@deepwatch` scope,
so `npx @deepwatch/cli` does not work and no document in this repository may
say it does. That train's first run really is a first publication. What has
been exercised is the packed artifact a publish would upload: `npm run
release:artifacts` packs all twenty, installs them into a clean project, and
runs the CLI through `npm exec`, `npx`, `pnpm` and a global install.

*Watch Skill has published before.* `watch-skill` is on PyPI and this
repository's own changelog records 1.0.0, 1.1.0, 1.2.0 and 1.3.0rc2 before the
current candidate. A `core-v*` tag is an **update to an existing package**, not
a first publication: the Trusted Publisher is already configured, the project
page already exists, and the failure modes are a version clash or a rejected
upload rather than a package that has to be created by hand. Describing it as a
first publication sent a release owner looking for a one-time credential step
that does not apply to it.

## Before a DeepWatch release

The workflow checks all of this itself and refuses rather than publishing
half a scope. Doing it locally first is how you find out in a minute instead of
after a tag exists.

```bash
npm run check && npm run release:artifacts
```

## One-time first publication

Trusted Publisher cannot create a package that does not exist yet. This is
npm's own documented prerequisite for `npm trust`  --  *"The package you're
configuring must already exist on the npm registry"*  --  and it is not an
oversight in this repository's setup. PyPI allows a publisher to be configured
for a name nobody has uploaded yet, which is why Watch Core's train has no
equivalent step; npm does not, and
[npm/cli#8544](https://github.com/npm/cli/issues/8544), the request to allow an
initial publish over OIDC, is still open. Check whether it has been resolved
before assuming this section still applies.

So the first publication of all twenty packages uses a short-lived npm
publisher credential held only by the release owner. **That one publication is
the only DeepWatch release without provenance attestation**, because provenance
is generated from a CI workload identity and a laptop does not have one. Every
release after it goes through `release-deepwatch.yml`, which publishes with
`--provenance` and no token path at all. Say so in the release notes rather
than letting somebody discover it from a missing badge.

The repository procedure is offline and dry-run by default:

```bash
# after release:artifacts, from a clean exact candidate commit
npm run first-publish:dry-run
```

It consumes only `.release-artifacts/*.tgz` plus that directory's
`packed-artifacts.json`. Before any registry write it refuses a dirty tree,
wrong SHA-256, wrong package name/version/scope/access, private package,
changed file list, changed dependency graph, `workspace:`/`file:` source
fallback, a missing package, or an order that differs from the manifest graph.
The state report is `.release-artifacts/first-publish-state.json` and always
lists `created`, `skipped`, `failed`, and `remaining` packages.

### The sealed manifest, because a version is not a fingerprint

`release:artifacts` ends with `release:seal` and `release:provenance`. Together
they answer a question the two inventories below cannot: *did these bytes come
from this source?*

A candidate once shipped artifacts packed three commits behind the accepted
head, from a dirty tree, and every gate passed — because every gate compared
`name@version`, and both byte sets wore the same version. Exactly one package
differed in content. So `gen-provenance-manifest.mjs` writes
`.release-artifacts-provenance.json`, binding the exact commit **and tree** to a
SHA-256 over every tarball, the wheel and the sdist, plus the pinned upstream
Harness, the build toolchain and the SBOM identity. It refuses to seal a dirty
tree at all, and it writes outside the directory it describes so sealing cannot
change what is being sealed. The recorded build timestamp is never compared — a
reproducible build must not depend on the clock.

`verify-provenance.mjs` then rejects a set on any of: a dirty worktree, a commit
or tree that is not the checkout's, an artifact older than the accepted source,
one `name@version` whose bytes differ from the sealed ones, installed content
that is not what was sealed, a missing artifact or digest, and a `SHA256SUMS`
that disagrees with the inventory. Every finding names a fix, because
"provenance failed" sends somebody to re-run the build and "these bytes are from
an older commit" sends them to repack.

```bash
node scripts/verify-provenance.mjs \
  --artifacts .release-artifacts \
  --manifest .release-artifacts-provenance.json \
  --expect-commit "$(git rev-parse HEAD)"
```

`--expect-commit` is the accepted head. Pass it at the release gate: a set
sealed anywhere else is stale by definition, however well-formed it is.

### Two inventories, because there are two questions

`.release-artifacts/packed-artifacts.json` describes **these** archives: the
commit they came from, and each tarball's name, SHA-256 and size. It sits
beside the tarballs, git ignores it, and every check that compares an archive
to a digest -- `verify:packed`, `verify:packed-contents`, the profile builder
and the first-publish bootstrap -- reads the inventory written by the pack
that produced the archive it is looking at.

`workspace/inventory/packed-artifacts.json` is tracked, and describes what a
pack of *this source* is expected to produce: names, versions, access, file
lists, dependency and peer sets, exports, bins and the publish order derived
from the manifest graph. Every field is read out of a manifest, so packing
rewrites it to the same bytes.

That separation is load-bearing rather than tidy. The tracked file used to
carry digests and a date, so `npm run release:artifacts` left the worktree
dirty -- and the very next command this guide gives, `first-publish`, refuses
a dirty tree. The documented path to a first publication could not be walked
*then*; `npm run verify:release-sequence` is the gate that walks it, and it has
since been walked end to end at more than one release candidate. Rerun it at
the exact commit being released — the point is that this commit's path is
clean, not that the path is untried.

### The bytes are reproducible

Two packs of one commit produce twenty identical archives. That was not true
until the pack pipeline was made to stage a canonical manifest:
`@deepwatch/dsh-bundle` declares thirteen siblings through the `workspace:`
protocol, pnpm resolved those to concrete ranges while packing, and the
rewritten `dependencies` object came out in a different key order on each run
-- so one archive's digest moved for a reason that had nothing to do with its
contents.

The pack now resolves those ranges itself, sorted by code unit, writes that
manifest over the real one for the length of one `pnpm pack`, and restores the
original bytes afterwards whatever happens. pnpm is left with nothing to
rewrite and nothing to reorder. `npm run verify:pack-reproducible` packs
twice into two temporary directories and compares all twenty digests.

Publish the archives a pack produced, from the directory that pack wrote.

The release owner may check identity and `@deepwatch` organisation access
without printing either credentials or the npm user name:

```bash
node scripts/first-publish.mjs --check-access
```

Only after reviewing the dry-run and enabling strong authentication/2FA may
the owner explicitly authorize the irreversible path:

```bash
node scripts/first-publish.mjs --publish --confirm-first-publish
```

The script's only write is `npm publish <verified-tarball> --access public
--tag <derived>`, in the exact dependency order printed by
`node scripts/publish-order.mjs`. The dist-tag is derived from the version's
shape by the same rule the workflow uses, so the bootstrap and the workflow
cannot disagree about a publication that cannot be taken back. This task must
never run that command.

### Publish the bytes the workflow packed, not the bytes your machine packs

The bootstrap and the tag each produce twenty tarballs, and `publish-plan.mjs`
compares them by integrity. Where they differ, the tag refuses that package as
*already published with DIFFERENT bytes* — correctly, and irrecoverably at that
version.

They can differ. Packing one tree on Windows and on Linux gives eighteen
identical archives and two that are not: `@deepwatch/dsh-client-evidence` and
`@deepwatch/dsh-client-settings` differ inside their bundled `lib/client.js`,
in content rather than in compression — see
[known limitations](known-limitations.md). So the bootstrap does not pack
locally at all:

1. **Push the tag.** `release-deepwatch.yml`'s `verify` job packs, seals and
   uploads `deepwatch-tarballs` on the same Linux runner every later release
   uses. Its `publish` job then fails, because no package has a Trusted
   Publisher yet. Nothing reaches the registry, and that failure is expected.
2. **Download that artifact** and check it against the manifest the job sealed:

   ```bash
   gh run download <run-id> --name deepwatch-tarballs --dir sealed
   node scripts/verify-provenance.mjs \
     --artifacts sealed --manifest sealed/provenance.json \
     --expect-commit "$(git rev-parse HEAD)"
   ```

3. **Publish those exact files**, with
   `node scripts/first-publish.mjs --artifacts sealed --publish
   --confirm-first-publish`.
4. **Configure the Trusted Publishers** (below). This needs interactive 2FA —
   `npm trust` refuses a token that bypasses it.
5. **Re-run the workflow.** It packs the same bytes, the plan says `skip`
   twenty times, nothing is uploaded and no OIDC identity is needed, and
   `github-release` completes the Release with the sealed assets.

Publishing locally and tagging afterwards is the one shape that cannot be
recovered from: two of the twenty versions would be spent on bytes the workflow
will never produce again.

Current organisation hardening is a prerequisite, not an afterthought. The
default `Developers` team currently has read/write access: add no members while
that remains true. Create a limited publisher/maintainer team, make ordinary
contributors read-only where appropriate, require strong authentication/2FA
for maintainers, and protect the GitHub `npm` environment with required
reviewers.

After the first publication, every one of the twenty packages needs a Trusted
Publisher of its own. `npm trust` does this from the terminal, which matters at
twenty packages: the equivalent web flow is **Settings → Publishing access →
GitHub Actions** repeated twenty times, and a form filled in nineteen times
correctly is a workflow that fails closed on the twentieth.

```bash
for name in $(node scripts/publish-order.mjs); do
  npm trust github "$name" \
    --file release-deepwatch.yml \
    --repo oxbshw/watch-skill \
    --env npm \
    --allow-publish --yes
done
npm trust list @deepwatch/cli
```

`npm trust list <package>` is the read-back; run it on all twenty before
trusting the result of the loop, because the failure this guards against is a
publisher that was silently not created.

Then verify the next release entirely through the OIDC workflow and restrict
the bootstrap credential so it can no longer publish. Until every package has
its publisher the workflow must fail closed: there is deliberately no
`NODE_AUTH_TOKEN` fallback, because a fallback turns a missing publisher into a
quiet unattested publish instead of a stopped release.

The `npm` Environment must also exist in repository settings with required
reviewers. That is what makes a release an approval against one exact tag
rather than a consequence of pushing.

## Dist-tags

| Version shape | Dist-tag | Why |
| --- | --- | --- |
| `0.1.0-preview.N` | `preview` | early, and not what `npm i` should give anyone |
| `0.1.0-rc.N` | `next` | a candidate, opted into deliberately |
| `0.1.0` | `latest` | the version this project stands behind |

The first stable release is `0.1.0`, so it takes `latest`.

A prerelease never takes `latest`. The workflow derives the tag from the
version and refuses a prerelease shape it has no dist-tag for, so this cannot
be got wrong by hand.

## Order

Packages publish in dependency order, computed from the manifests:

```bash
node scripts/publish-order.mjs
```

npm resolves a dependency at install time, not at publish time, so the registry
will accept `@deepwatch/cli` naming a `@deepwatch/dsh-bundle` that does not
exist yet. The version is then spent — and every install of it fails until the
missing package appears.

## When a release fails part-way

**A published npm version can never be replaced.** `npm unpublish` is available
for 72 hours on a package nothing depends on, and using it makes the version
number permanently unusable rather than free. So the recovery is always a new
version, and never a retry of the old one.

The publish step stops at the first failure and writes to the job summary
exactly which packages reached the registry and which did not. Work from that
list.

1. **Read the summary.** `Published: …` is the authoritative list. Do not infer
   it from the log.
2. **Fix the cause.** A trusted publisher that was never configured, a gate
   that failed, a network error. The `verify` job runs everything before the
   first upload, so a failure inside `publish` is nearly always a permission or
   a registry problem rather than a code one.
3. **Re-run the workflow at the same tag**, once the cause is fixed and the
   commit has not moved.

### Why re-running is safe here, and what makes it safe

Re-running used to be the thing you must not do, and the instruction was right
for the workflow as it then was: the publish loop started at the first package
and every already-published version failed its existence check.

What changed is that the loop no longer asks *whether* a version exists. It
asks whether the registry holds **the bytes this build would upload**, and it
asks the registry directly, at the moment of publishing:

```bash
node scripts/publish-plan.mjs --artifacts .release-artifacts
```

Each package gets one of three decisions.

| Decision | Meaning |
| --- | --- |
| `publish` | the registry holds nothing at this version |
| `skip` | the registry holds this version with **identical** integrity — already done |
| `refuse` | the registry holds this version with **different** bytes |

A `skip` is what makes a resume possible: a release that died at the
fourteenth package resumes at the fourteenth package, and the thirteen before
it are left exactly as they are. Nothing is ever overwritten, because npm
cannot overwrite and this never asks it to.

A single `refuse` stops the release. That state means somebody published this
version from a different build, and no amount of retrying makes the scope
consistent again — skipping it would ship a release whose halves came from
different commits, which no later gate would catch, because every gate compares
`name@version` and both byte sets wear the same version.

`refuse` is also what you get if the tarballs are not the ones the `verify`
job sealed. The plan checks each file's SHA-256 against
`packed-artifacts.json` before it asks the registry anything, and the publish
job re-verifies the whole set against `.release-artifacts-provenance.json`
before its first upload.

### When the plan refuses

Then, and only then, the recovery is a new version.

1. **Bump the version.** Every package moves to the next patch or prerelease
   number together; the workspace publishes one version across the scope, and a
   split version is a support burden nobody needs.
2. **Deprecate what is stranded**, so an installer is told rather than left
   guessing:

   ```bash
   npm deprecate @deepwatch/dsh-library@0.1.0 "incomplete release; use 0.1.1"
   ```

3. **Tag again**, with the new version, and approve the environment.

If the failure happened *before* any package published, none of this applies:
fix the cause, delete the tag, and tag again at the same version.

### Watch Core is not resumable in the same way

`core-v*` publishes one distribution to PyPI, and PyPI refuses a re-upload of a
version it already holds. **Do not re-run the job** to finish a Core release
that got past its PyPI step: the build job would rebuild and the upload would
be rejected. The `report` job says which stages succeeded and which did not,
and the two stages after PyPI — the MCP registry entry and the GitHub Release
— are each recoverable on their own from that run's sealed `release-build`
artifact.

## Watch Core

`core-v<version>` must name the version `pyproject.toml` declares; the workflow
refuses otherwise. PyPI publishing is also OIDC, through a trusted publisher on
`watch-skill`.

The order is build → seal → PyPI → MCP registry → GitHub Release, and each
arrow is a `needs:`. Two of them are worth stating plainly:

- **The MCP registry entry is published after PyPI**, so it never advertises an
  install that does not exist yet.
- **The GitHub Release is completed last.** It used to be created first, which
  meant a release existed — announced, linked, carrying assets — while the
  upload it announced had not happened and might still fail. Anything watching
  `release: published` was watching a claim: the post-publish smoke fired
  against a PyPI that still served the previous version and reported green.
  Now `release: published` fires after PyPI accepted the upload, so it is a
  signal about the registry rather than about the workflow's progress.

The build job seals the distributions into `SHA256SUMS` and
`release-manifest.json`, and every job after it verifies that seal before using
a file. Nothing is rebuilt after the build job: the wheel PyPI receives and the
wheel attached to the Release are the same bytes.
