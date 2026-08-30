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

Then, once per package and once only, a Trusted Publisher has to exist on npm:
**Settings → Publishing access → GitHub Actions**, for repository
`oxbshw/watch-skill` and workflow `release-deepwatch.yml`. Until that is
configured for a package, publishing it fails — which is the intended
behaviour. There is deliberately no `NODE_AUTH_TOKEN` fallback in the workflow,
because a fallback turns a misconfigured trusted publisher into a silent,
unattested publish.

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
