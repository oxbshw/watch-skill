# Releasing

Two products live in this repository and each has its own train.

| Train | Tag | Publishes | Workflow |
| --- | --- | --- | --- |
| Watch Core | `core-v<version>` | PyPI, the Claude Skill bundle, the MCP registry entry | `.github/workflows/release.yml` |
| DeepWatch | `deepwatch-v<version>` | the twenty `@deepwatch/*` npm packages | `.github/workflows/release-deepwatch.yml` |

There is no `v*` trigger any more. There used to be, and it meant a tag
intended for one product built and published the other from whatever the tree
happened to contain at that moment.

**Neither train has ever run.** Nothing is published under the `@deepwatch`
scope, so `npx @deepwatch/cli` does not work and no document in this repository
may say it does. What has been exercised is the packed artifact a publish would
upload: `npm run release:artifacts` packs all twenty, installs them into a
clean project, and runs the CLI through `npm exec`, `npx`, `pnpm` and a global
install.

## Before a DeepWatch release

The workflow checks all of this itself and refuses rather than publishing
half a scope. Doing it locally first is how you find out in a minute instead of
after a tag exists.

```bash
npm run check && npm run release:artifacts
```

## One-time first publication

Trusted Publisher cannot create a package that does not exist yet. The first
publication of all twenty packages therefore uses a short-lived npm publisher
credential held only by the release owner. The repository procedure is
offline and dry-run by default:

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

### A digest belongs to one pack

Packing twice from the same commit does not produce the same bytes.
`@deepwatch/dsh-bundle` declares its siblings through the `workspace:`
protocol, pnpm resolves those to concrete ranges while packing, and the
rewritten `dependencies` object comes out in a different key order each time
-- so that one archive's size and SHA-256 move, and the totals with them. The
dependency *set* is identical; only its order is not.

What follows from that, exactly. `packed-artifacts.json` is the record of the
pack that produced the archives beside it, not a claim about what a later pack
would produce, and `workspace/inventory/packed-artifacts.json` in the
repository is a snapshot of one such pack rather than a digest anybody can
reproduce from the source. Every check that compares an archive to a digest --
`verify:packed`, `verify:packed-contents`, the profile builder and the
first-publish bootstrap -- reads the inventory written *by the same pack*, so
each is a real check and none of them depends on cross-run reproducibility.

Publish the archives a pack produced, from the directory that pack wrote. Do
not pack again between verifying and publishing.

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
--tag preview`, in the exact dependency order printed by
`node scripts/publish-order.mjs`. This task must never run that command.

Current organisation hardening is a prerequisite, not an afterthought. The
default `Developers` team currently has read/write access: add no members while
that remains true. Create a limited publisher/maintainer team, make ordinary
contributors read-only where appropriate, require strong authentication/2FA
for maintainers, and protect the GitHub `npm` environment with required
reviewers.

After the first publication, configure a Trusted Publisher separately on all
twenty package pages: **Settings → Publishing access → GitHub Actions**, with
repository `oxbshw/watch-skill`, workflow `release-deepwatch.yml`, and
environment `npm`. Verify the next preview entirely through that OIDC workflow,
then disable token publishing or restrict the bootstrap token so it cannot
publish. Until every package has the publisher, the workflow must fail closed.
There is deliberately no `NODE_AUTH_TOKEN` fallback.

The `npm` Environment must also exist in repository settings with required
reviewers. That is what makes a release an approval against one exact tag
rather than a consequence of pushing.

## Dist-tags

| Version | Dist-tag | Why |
| --- | --- | --- |
| `0.1.0-preview.0` | `preview` | early, and not what `npm i` should give anyone |
| `0.1.0-rc.1` | `next` | a candidate, opted into deliberately |
| `0.1.0` | `latest` | the version this project stands behind |

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
2. **Do not re-run the job.** Every published version will fail its existence
   check, and the ones that are not published will publish under a tag whose
   other half is already public — which is the state you are trying to leave.
3. **Fix the cause.** A trusted publisher that was never configured, a gate
   that failed, a network error. The `verify` job runs everything before the
   first upload, so a failure inside `publish` is nearly always a permission or
   a registry problem rather than a code one.
4. **Bump the version.** Every package moves to the next patch or prerelease
   number together; the workspace publishes one version across the scope, and a
   split version is a support burden nobody needs.
5. **Deprecate what is stranded**, so an installer is told rather than left
   guessing:

   ```bash
   npm deprecate @deepwatch/dsh-library@0.1.0-preview.0 "incomplete release; use 0.1.0-preview.1"
   ```

6. **Tag again**, with the new version, and approve the environment.

If the failure happened *before* any package published, none of this applies:
fix the cause, delete the tag, and tag again at the same version.

## Watch Core

`core-v<version>` must name the version `pyproject.toml` declares; the workflow
refuses otherwise. PyPI publishing is also OIDC, through a trusted publisher on
`watch-skill`, and the MCP registry entry is published last so it never
advertises an install that does not exist yet.
