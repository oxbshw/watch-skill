/**
 * The release workflows, read as text.
 *
 * Neither has run and neither may be run to check it: publishing is not
 * reversible, an npm version cannot be replaced, and a tag pushed to find out
 * whether a workflow works is a release. So the properties that matter are
 * asserted against the file, which is the only safe way to hold them.
 *
 * What is held here is the set of mistakes that are cheap to make and
 * impossible to undo: a trigger that fires on a push, a token fallback beside
 * a trusted publisher, `id-token: write` in a job that runs project code, a
 * prerelease taking `latest`, a publish order that leaves an unresolvable
 * version on the registry.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { publishOrder } from '../scripts/publish-order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOWS = join(ROOT, '..', '.github', 'workflows')
const DEEPWATCH = readFileSync(join(WORKFLOWS, 'release-deepwatch.yml'), 'utf8')
const CORE = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')

/** The block of a workflow belonging to one job, by indentation. */
function job(workflow, name) {
  const lines = workflow.split('\n')
  const start = lines.findIndex(line => line.startsWith(`  ${name}:`))
  assert.notEqual(start, -1, `no job named ${name}`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^ {2}\S/.test(line))
  return rest.slice(0, end === -1 ? rest.length : end).join('\n')
}

describe('the two products release on separate trains', () => {
  test('no workflow triggers on a bare v* tag any more', () => {
    for (const name of readdirSync(WORKFLOWS)) {
      const source = readFileSync(join(WORKFLOWS, name), 'utf8')
      assert.ok(!/tags:\s*\[\s*["']v\*/.test(source),
        `${name} still triggers on v*, which fires for both products`)
    }
  })

  test('Core is core-v* and DeepWatch is deepwatch-v*', () => {
    assert.match(CORE, /tags:\s*\["core-v\*"\]/)
    assert.match(DEEPWATCH, /tags:\s*\["deepwatch-v\*"\]/)
  })

  test('each train refuses a tag that does not name its own version', () => {
    assert.match(CORE, /GITHUB_REF_NAME#core-v/)
    assert.match(CORE, /does not name Core version/)
    assert.match(DEEPWATCH, /GITHUB_REF_NAME#deepwatch-v/)
    assert.match(DEEPWATCH, /does not name workspace version/)
  })

  test('Core completes its GitHub Release only after PyPI accepted the upload', () => {
    // The Release used to be created in the build job, before the upload it
    // announced. Anything watching `release: published` was therefore watching
    // a claim: the post-publish smoke fired against a PyPI that still served
    // the previous version, and reported green.
    const build = job(CORE, 'build')
    assert.ok(!build.includes('action-gh-release'),
      'the build job must not announce a release it has not published')

    const release = job(CORE, 'github-release')
    assert.match(release, /needs: \[build, pypi\]/)
    assert.match(release, /action-gh-release/)
    assert.match(release, /contents: write/)

    // And the registry entry still comes after the package it advertises.
    assert.match(job(CORE, 'mcp-registry'), /needs: pypi/)
  })

  test('Core publishes the bytes it sealed, and rebuilds nothing to do it', () => {
    const build = job(CORE, 'build')
    assert.match(build, /sha256sum/)
    assert.match(build, /release-manifest\.json/)
    assert.match(build, /name: release-build/)

    const pypi = job(CORE, 'pypi')
    assert.match(pypi, /sha256sum -c SHA256SUMS/)
    assert.ok(!pypi.includes('uv build'), 'the publish job must not rebuild')
    assert.ok(pypi.indexOf('sha256sum -c SHA256SUMS') < pypi.indexOf('pypa/gh-action-pypi-publish'),
      'the seal must be verified before the upload')

    // The skill bundle, the notes and the manifest are in the sealed set and
    // must not be handed to twine.
    assert.match(pypi, /cp sealed\/\*\.whl sealed\/\*\.tar\.gz dist\//)
  })

  test('a partial Core release is reported as the state it is', () => {
    const report = job(CORE, 'report')
    assert.match(report, /if: always\(\)/)
    assert.match(report, /This release is incomplete/)
    assert.match(report, /Nothing was published/)
    // A green check on a half-done release is worse than a red one.
    assert.match(report, /\[ "\$BUILD" = "success" \]/)
  })

  test('Core classifies a prerelease from the version, not the tag', () => {
    // `core-v0.1.2` contains a hyphen, and the `*-*` arm of that case
    // statement would have made every stable release a prerelease.
    const classify = CORE.slice(CORE.indexOf('case "$version" in'))
    assert.ok(classify.startsWith('case "$version" in'),
      'the classification still reads the tag rather than the version')
  })
})

describe('the npm release cannot happen by accident', () => {
  test('the only trigger is a tag', () => {
    const triggers = DEEPWATCH.slice(DEEPWATCH.indexOf('\non:'), DEEPWATCH.indexOf('\npermissions:'))
    assert.match(triggers, /push:/)
    assert.match(triggers, /tags:/)
    assert.ok(!triggers.includes('branches'), 'a branch push must not publish')
    assert.ok(!triggers.includes('pull_request'), 'a pull request must not publish')
    assert.ok(!triggers.includes('workflow_dispatch'),
      'a button that publishes is a button somebody presses')
    assert.ok(!triggers.includes('schedule'), 'nothing publishes on a timer')
  })

  test('publishing waits behind a protected environment', () => {
    const publish = job(DEEPWATCH, 'publish')
    assert.match(publish, /environment:\s*\n\s*name: npm/,
      'the publish job must run in the npm Environment, which requires approval')
  })

  test('the workflow is read-only except where it has to mint an identity', () => {
    assert.match(DEEPWATCH, /^permissions:\n {2}contents: read$/m,
      'the workflow default must be read-only')
    const verify = job(DEEPWATCH, 'verify')
    assert.ok(!verify.includes('id-token: write'),
      'the job that runs project code must not hold an OIDC token')
    assert.match(job(DEEPWATCH, 'publish'), /id-token: write/)
    assert.match(job(DEEPWATCH, 'publish'), /contents: read/)
  })

  test('there is no token path beside the trusted publisher', () => {
    // Comments stripped: the header explains why there is no token fallback,
    // and naming one in prose is not the same as reading one.
    const executable = DEEPWATCH.split('\n')
      .filter(line => !/^\s*#/.test(line)).join('\n')
    for (const secret of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_AUTH_TOKEN', '_authToken',
      'registry-url']) {
      assert.ok(!executable.includes(secret),
        `${secret} is a fallback, and a fallback publishes unattested when OIDC is misconfigured`)
    }
    assert.match(DEEPWATCH, /--provenance/, 'a publish with no provenance proves nothing')
  })
})

describe('what reaches the registry, and in what order', () => {
  test('a prerelease never takes latest', () => {
    const step = DEEPWATCH.slice(DEEPWATCH.indexOf('case "$version" in'))
    assert.match(step, /\*-preview\.\*\)\s*tag=preview/)
    assert.match(step, /\*-rc\.\*\)\s*tag=next/)
    // Any other prerelease shape is refused rather than guessed at.
    assert.match(step, /\*-\*\)\s*echo "::error::/)
    assert.match(step, /\*\)\s*tag=latest/)
  })

  test('every version is checked against the registry before the first upload', () => {
    const verify = job(DEEPWATCH, 'verify')
    assert.match(verify, /scripts\/publish-plan\.mjs/)
    assert.ok(verify.indexOf('publish-plan.mjs') < verify.indexOf('upload-artifact'),
      'the registry check must run before anything is handed to the publish job')
  })

  test('the publish job publishes what the verify job sealed', () => {
    // Not "a tarball with the right name". A candidate once shipped artifacts
    // packed three commits behind the accepted head and every gate passed,
    // because every gate compared `name@version` and both byte sets wore the
    // same version. The seal is content-bound and is checked before the first
    // upload, in the job that does the uploading.
    const verify = job(DEEPWATCH, 'verify')
    assert.match(verify, /npm run release:seal/)
    assert.ok(verify.indexOf('npm run pack') < verify.indexOf('npm run release:seal'),
      'the seal must describe what was packed')

    const publish = job(DEEPWATCH, 'publish')
    assert.match(publish, /verify-provenance\.mjs/)
    assert.match(publish, /--expect-commit/)
    assert.ok(!publish.includes('npm run pack'),
      'the publish job must not pack; it publishes the bytes it was given')
    assert.ok(publish.indexOf('verify-provenance.mjs') < publish.indexOf('npm publish'),
      'the manifest must be verified before the first upload')
  })

  test('a resume skips a version only when the registry holds identical bytes', () => {
    // The distinction this rests on: "already published" and "already
    // published from this build" are different questions, and only the second
    // makes a resume safe. `publish-plan.mjs` answers the second one by
    // comparing integrity, and the workflow acts on its verdict rather than
    // on the existence of a version.
    const publish = job(DEEPWATCH, 'publish')
    assert.match(publish, /scripts\/publish-plan\.mjs/,
      'the publish job must re-plan against the registry, not replay a stale plan')
    assert.match(publish, /publish-plan\.json/)
    assert.match(publish, /if \[ "\$action" = "skip" \]/)
    assert.match(publish, /already holds these exact bytes/)
    // And anything that is neither publish nor skip stops the loop.
    assert.match(publish, /if \[ "\$action" != "publish" \]/)
  })

  test('packages publish in dependency order, derived from the manifests', () => {
    assert.match(DEEPWATCH, /node scripts\/publish-order\.mjs/)
    const order = publishOrder().map(entry => entry.name)
    assert.equal(order.length, 20)
    const at = name => order.indexOf(name)
    // The bundle depends on the client halves; the CLI depends on the bundle.
    assert.ok(at('@deepwatch/dsh-client-brand') < at('@deepwatch/dsh-bundle'))
    assert.ok(at('@deepwatch/dsh-contracts') < at('@deepwatch/dsh-core-bridge'))
    assert.ok(at('@deepwatch/dsh-bundle') < at('@deepwatch/cli'))
    assert.ok(!order.includes('@deepwatch/desktop'), 'the desktop shell is never published')
    assert.ok(!order.includes('@deepwatch/monorepo'), 'the workspace root is never published')
  })

  test('a partial release is reported rather than swallowed', () => {
    const publish = job(DEEPWATCH, 'publish')
    assert.match(publish, /This release is incomplete/)
    assert.match(publish, /Published:/)
    assert.match(publish, /exit "\$status"/, 'a failed publish must fail the job')
  })

  test('the recovery procedure is written down, and says a version is spent', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'releasing.md'), 'utf8')
    assert.match(doc, /can never be replaced/)
    // "Do not re-run the job" was once the whole advice, and it was right for
    // a publish loop that started at the first package every time. It is now
    // true of exactly one train: PyPI refuses a re-upload, so a Core release
    // that got past its PyPI step cannot be finished by re-running. The npm
    // train re-plans against the registry and resumes, so telling a release
    // owner not to re-run it would send them to burn a version they still
    // have.
    assert.match(doc, /Do not re-run the job/)
    assert.match(doc, /Why re-running is safe here/)
    assert.match(doc, /Watch Core is not resumable in the same way/)
    assert.match(doc, /identical.{0,40}integrity|integrity.{0,40}identical/s)
    assert.match(doc, /npm deprecate/)
    assert.match(doc, /core-v<version>/)
    assert.match(doc, /deepwatch-v<version>/)
    // And it must keep the two trains apart. This used to pin "Neither train
    // has ever run", which was wrong in the half that mattered: `watch-skill`
    // is already on PyPI, and calling its next tag a first publication sent a
    // release owner looking for a one-time credential step that does not apply.
    //
    // This pinned "DeepWatch has never published" until the scope went live on
    // 2026-09-07. That sentence was the correct claim to hold right up to the
    // moment it became the wrong one, so the rule inverts with the fact rather
    // than being deleted: the guide must now say the train has published, and
    // must not go back to saying it has not.
    assert.match(doc, /DeepWatch published on/)
    assert.match(doc, /release after this one is an \*\*update\*\*/)
    assert.doesNotMatch(doc, /DeepWatch has never published/,
      'the guide claims an empty scope that has been published since 2026-09-07')
    assert.match(doc, /Watch Skill has published before/)
    assert.match(doc, /update to an existing package/)
    assert.doesNotMatch(doc, /Neither train has ever run/,
      'the corrected claim was reverted to the one that misled')
  })
})

describe('the sealed set survives the round trip through an artifact', () => {
  // Two defects that would each have surfaced only on a tag, in the one run
  // nobody wants to be debugging.

  test('nothing hidden is handed to upload-artifact, which drops hidden files', () => {
    // Everything this release produces is hidden -- `.release-artifacts/` and
    // `.release-artifacts-provenance.json` -- and upload-artifact has excluded
    // hidden files by default since v4.4. Uploaded by those paths the archive
    // matches nothing, and `if-no-files-found: error` then fails the job at
    // the upload rather than at the mistake.
    const verify = job(DEEPWATCH, 'verify')
    const upload = verify.slice(verify.indexOf('upload-artifact'))
    const paths = /path:\s*([^\n]*)\n((?:\s{10,}[^\n]*\n)*)/.exec(upload)
    const named = `${paths?.[1] ?? ''}\n${paths?.[2] ?? ''}`
    assert.doesNotMatch(named, /(^|\/)\.[A-Za-z]/m,
      'a path component beginning with a dot is dropped by the uploader')
    assert.match(named, /release-upload/, 'the visible staging directory is what is uploaded')

    // And the staging step must rename the manifest rather than copy it in
    // with its leading dot, which would be hidden inside a visible directory.
    assert.match(verify, /release-upload\/provenance\.json/)
    assert.match(verify, /find release-upload -name '\.\*'/,
      'the staging step proves nothing hidden reached the upload')
  })

  test('a job with no checkout does not inherit a working directory it lacks', () => {
    // `defaults.run.working-directory: workspace` is workflow-wide. `smoke`,
    // `github-release` and `report` never check out, so that directory does
    // not exist and every `run` step in them would fail on `cd`.
    for (const name of ['smoke', 'github-release', 'report']) {
      const block = job(DEEPWATCH, name)
      const checksOut = block.includes('actions/checkout')
      const hasRun = /^\s+run:/m.test(block)
      if (!hasRun) continue
      assert.equal(checksOut, false, `${name} was expected to run without a checkout`)
      assert.match(block, /defaults:\s*\n\s*run:\s*\n\s*working-directory: \./,
        `${name} runs shell steps with no checkout, so it must not inherit `
        + '`working-directory: workspace`')
    }
  })

  test('the release job reads the layout the upload actually produced', () => {
    // `download-artifact` unpacks the staged directory's *contents*, so the
    // files land directly under `sealed/` rather than under the
    // `workspace/.release-artifacts/` path the verify job knew them by.
    const release = job(DEEPWATCH, 'github-release')
    assert.doesNotMatch(release, /sealed\/workspace/,
      'the artifact does not contain a `workspace/` directory')
    assert.match(release, /body_path: sealed\/release-notes\.md/)
    assert.match(release, /sealed\/provenance\.json/)
    assert.match(release, /test "\$\(ls sealed\/\*\.tgz \| wc -l\)" -eq 20/,
      'the job counts what it received before attaching it')
  })

  test('the publish job restores the shape the manifest describes', () => {
    const publish = job(DEEPWATCH, 'publish')
    assert.match(publish, /cp "\$RUNNER_TEMP"\/sealed\/provenance\.json \.release-artifacts-provenance\.json/)
    assert.match(publish, /test "\$\(ls \.release-artifacts\/\*\.tgz \| wc -l\)" -eq 20/)
  })

  test('a downloaded artifact never lands inside the checkout', () => {
    // `path: workspace-artifacts` put twenty-five files in the working tree.
    // Nothing ignores them, so `verify-provenance.mjs` counted them and
    // refused the release with `worktree_dirty` — correctly: a dirty tree
    // cannot honestly name the source of its own artifacts. The verify job
    // never hit it because `.release-artifacts/` and its manifest are both in
    // `.gitignore`.
    const publish = job(DEEPWATCH, 'publish')
    const download = publish.slice(publish.indexOf('download-artifact'))
    const path = /path:\s*([^\n]+)/.exec(download)?.[1]?.trim() ?? ''
    assert.match(path, /runner\.temp/,
      'the download must go outside the checkout, or it dirties the tree')

    // And the step that restores it proves the tree survived. Read from the
    // steps rather than the file: the comment explaining this fix names
    // `verify-provenance.mjs`, so a text search finds the prose before the run.
    assert.match(publish, /status --porcelain=v1 --untracked-files=all/)
    const steps = publish.split('\n').filter(line => !/^\s*#/.test(line)).join('\n')
    assert.ok(steps.indexOf('--untracked-files=all') < steps.indexOf('verify-provenance.mjs'),
      'the cleanliness check comes before the gate that depends on it')
  })

  test('the publishing npm is pinned, not whatever shipped this morning', () => {
    // Installing the newest npm on release day let an unreviewed toolchain
    // into the one job that cannot be re-run. Comments stripped, because this
    // file documents removed mistakes by quoting them and a rule against the
    // quote is a rule against writing down what went wrong.
    const publish = job(DEEPWATCH, 'publish')
      .split('\n').filter(line => !/^\s*#/.test(line)).join('\n')
    assert.doesNotMatch(publish, /npm@latest/)
    assert.match(publish, /npm install --global npm@\d+\.\d+\.\d+/)
  })

  test('the header does not claim a protection GitHub is not enforcing', () => {
    // Naming an environment does not protect it: GitHub creates one on first
    // use with no rules, and this repository had no `npm` environment at all.
    assert.doesNotMatch(DEEPWATCH, /sits\s*\n?#?\s*behind a protected `npm` Environment/)
    assert.match(DEEPWATCH, /Environment gate is a repository setting/)
    // The job still declares it, because that is what makes the gate possible.
    assert.match(job(DEEPWATCH, 'publish'), /environment:\s*\n\s*name: npm/)
  })
})

describe('the release runs the gates the way CI runs them', () => {
  test('the verify job prepares `npm run check` the way the gate job does', () => {
    // Both jobs run the same `npm run check`, and that command needs two
    // things a bare checkout does not have. `upstream/deepseek-harness/` is
    // not committed, so inventory generation and parity diffing have nothing
    // to read; and without an importable Core the cross-language workspace
    // contract skips instead of running.
    //
    // workspace-ci does both. The release train did neither, and the first
    // `deepwatch-v0.1.2` tag stopped at `inventory:check` with "upstream
    // checkout missing". Nothing was published — every publishing step is
    // gated on that job — but the release could not complete either.
    const workspace = readFileSync(join(WORKFLOWS, 'workspace-ci.yml'), 'utf8')
    const gate = job(workspace, 'check')
    const verify = job(DEEPWATCH, 'verify')

    for (const [needle, why] of [
      ['scripts/upstream-sync.mjs', 'the pinned upstream the inventory gates read'],
      ['astral-sh/setup-uv', 'a Python the cross-language contract can import'],
    ]) {
      assert.ok(gate.includes(needle), `workspace-ci's gate job no longer does: ${why}`)
      assert.ok(verify.includes(needle),
        `the release verify job runs \`npm run check\` without ${why}`)
    }

    // And the preparation has to come first, or it prepares nothing. Read
    // from the steps rather than the file: the comment explaining this fix
    // names `npm run check`, and a text search finds the prose before the run.
    const steps = verify.split('\n').filter(line => !/^\s*#/.test(line)).join('\n')
    assert.ok(steps.indexOf('upstream-sync.mjs') < steps.indexOf('npm run check'),
      'the upstream is synced before the gates that read it')
  })
})

describe('the npm release ends in something a person can link to', () => {
  test('DeepWatch completes a GitHub Release, and only after npm accepted', () => {
    // This train had no release job at all. Twenty packages reached the
    // registry and the tag that published them stayed a bare tag: nothing to
    // link, and — the one that mattered — no file to download for anybody
    // installing the bundle into an existing Harness without a registry.
    const release = job(DEEPWATCH, 'github-release')
    assert.match(release, /needs: \[verify, publish\]/)
    assert.match(release, /action-gh-release/)
    assert.match(release, /contents: write/)

    // Announcement after publication, the same ordering Core had to be
    // corrected into. The verify job must not create it.
    assert.ok(!job(DEEPWATCH, 'verify').includes('action-gh-release'))
    assert.ok(!job(DEEPWATCH, 'publish').includes('action-gh-release'))
  })

  test('the assets are the sealed set, checked again on the way out', () => {
    const release = job(DEEPWATCH, 'github-release')
    assert.match(release, /sha256sum -c SHA256SUMS/)
    assert.ok(release.indexOf('sha256sum -c SHA256SUMS') < release.indexOf('action-gh-release'),
      'the digests must be checked before the assets are attached')
    assert.ok(!release.includes('npm run pack'), 'the release job must not build anything')

    // The tarballs are the DSH distribution. There is no separate archive
    // format, and inventing one by renaming a `.tgz` would be a format nothing
    // reads.
    assert.match(release, /\*\.tgz/)
    assert.match(release, /SHA256SUMS/)
    assert.match(release, /provenance\.json/)
  })

  test('a prerelease is labelled one, from the dist-tag the tag earned', () => {
    const release = job(DEEPWATCH, 'github-release')
    assert.match(release, /prerelease: \$\{\{ needs\.verify\.outputs\.dist-tag != 'latest' \}\}/)
  })

  test('the release notes describe the set that was sealed, not a remembered one', () => {
    const verify = job(DEEPWATCH, 'verify')
    assert.match(verify, /gen-release-notes\.mjs/)
    assert.ok(verify.indexOf('npm run release:seal') < verify.indexOf('gen-release-notes.mjs'),
      'the notes are written from the sealed inventory')
    assert.match(job(DEEPWATCH, 'github-release'), /body_path/)
  })

  test('the notes do not claim the bundle tarball installs on its own', async () => {
    // They did, and the claim was tested against a stock Harness profile:
    // `dsh plugin add ./deepwatch-dsh-bundle-0.1.1.tgz` sends pnpm to
    // registry.npmjs.org for the thirteen siblings the bundle names as
    // ordinary dependencies, and fails there. An asset advertised as the
    // offline route has to install offline.
    const { notes } = await import('../scripts/gen-release-notes.mjs')
    const inventory = {
      packages: [
        { name: '@deepwatch/dsh-bundle', version: '0.1.2', bytes: 10_000,
          file: 'deepwatch-dsh-bundle-0.1.1.tgz', sha256: 'a'.repeat(64) },
        { name: '@deepwatch/cli', version: '0.1.2', bytes: 70_000,
          file: 'deepwatch-cli-0.1.1.tgz', sha256: 'b'.repeat(64) },
      ],
    }
    const page = notes(inventory, { source: {}, harness: {}, toolchain: {} })
    assert.doesNotMatch(page, /offline install can use the file directly/)

    // Nor does supplying all fourteen make it one. That was the first
    // correction, and it was also wrong: `dsh plugin add` shells out to pnpm,
    // which resolves the bundle's `^0.1.2` sibling ranges from the registry
    // whether or not the tarballs are on the command line. Tested against a
    // stock Harness profile; it reaches npmjs.org either way.
    assert.doesNotMatch(page, /takes fourteen of them, not one/)
    assert.match(page, /Offline, the entry point is `deepwatch setup`/)
    assert.match(page, /deepwatch setup --artifacts/,
      'the path that does work without a registry is the one named')
  })

  test('a partial npm release is reported as the state it is', () => {
    const report = job(DEEPWATCH, 'report')
    assert.match(report, /if: always\(\)/)
    assert.match(report, /This release is incomplete/)
    assert.match(report, /\[ "\$PUBLISH" = "success" \]/)
  })
})

describe('one repository, two trains, and no crossed wires', () => {
  test('the published smoke ignores a release from the other train', () => {
    // `release: published` carries no tag filter, and this workflow stripped
    // `core-v` from whatever tag arrived. A `deepwatch-v0.1.2` release
    // therefore asked PyPI for `watch-skill` version `deepwatch-v0.1.2`,
    // sixty times over ten minutes, and failed — a red check on a release that
    // had done nothing wrong.
    const post = readFileSync(join(WORKFLOWS, 'post-publish.yml'), 'utf8')
    assert.match(post, /case "\$tag" in\s*\n\s*core-v\*\)/)
    assert.match(post, /is not a Watch Core release/)
    assert.match(post, /skip=true/)
    assert.match(post, /if: needs\.version\.outputs\.skip != 'true'/)
  })

  test('the step whose outputs the jobs read actually has that id', () => {
    // `outputs: spec: ${{ steps.pick.outputs.spec }}` with no `id: pick` on the
    // step resolves to an empty string, silently. The workflow has never run,
    // so nothing had ever noticed.
    const post = readFileSync(join(WORKFLOWS, 'post-publish.yml'), 'utf8')
    for (const output of [...post.matchAll(/\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs/g)]) {
      assert.match(post, new RegExp(`id: ${output[1]}\\b`),
        `post-publish.yml reads steps.${output[1]}.outputs but has no step with that id`)
    }
  })
})

test('the required workspace result includes the real browser journey', () => {
  const workflow = readFileSync(join(WORKFLOWS, 'workspace-ci.yml'), 'utf8')
  const browser = job(workflow, 'browser-e2e')
  assert.match(browser, /qa-e2e-run\.mjs/)
  assert.match(browser, /openrouter-compatible loopback provider|qa\/e2e/)
  assert.match(browser, /ci-report\.json/)
  assert.ok(!browser.includes('stub-accounting.json'))
  const required = job(workflow, 'workspace-required')
  assert.match(required, /browser-e2e/)
})

describe('the published smoke retries a flake and never a finding', () => {
  // A published smoke is the one check that runs against something nobody can
  // take back, so it has to be believable in both directions. Retrying
  // everything makes a broken publish look slow instead of broken; retrying
  // nothing makes a replica that is thirty seconds behind look like a broken
  // publish. Each smoke retries the fetch and asserts the version outside the
  // loop, and each names the failures it will not retry.
  const POST = readFileSync(join(WORKFLOWS, 'post-publish.yml'), 'utf8')
  const SMOKES = [
    ['release-deepwatch.yml', DEEPWATCH, 'npx-err.log',
      ['EINTEGRITY', 'ENEEDAUTH', 'E401', 'E403']],
    ['post-publish.yml', POST, 'uvx-err.log',
      ['hash mismatch', 'Failed to build', 'No solution found']],
  ]

  for (const [name, workflow, log, fatal] of SMOKES) {
    test(`${name} bounds its retries and backs off`, () => {
      assert.ok(/attempt=0\s*\n\s*delay=5/.test(workflow),
        `${name} does not start a bounded retry`)
      assert.ok(/delay=\$\(\(\s*delay \* 2/.test(workflow),
        `${name} retries without backing off`)
      assert.ok(/-ge 4 \]/.test(workflow) || /-ge "\$\{deadline\}" \]/.test(workflow),
        `${name} has no ceiling on its retries`)
    })

    test(`${name} keeps a failure a retry cannot fix visible`, () => {
      for (const marker of fatal) {
        assert.ok(workflow.includes(marker),
          `${name} would retry ${marker}, which says the same thing every time`)
      }
      assert.ok(workflow.includes('a reason a retry cannot fix'),
        `${name} does not distinguish the two kinds of failure`)
    })

    test(`${name} reports what actually went wrong`, () => {
      // `stderr` discarded is how a CI failure takes three runs to characterise.
      assert.ok(workflow.includes(`2>${log}`),
        `${name} does not capture the error stream`)
      assert.ok(workflow.includes(`cat ${log}`),
        `${name} captures the error stream and never prints it`)
      assert.ok(workflow.includes(`tail -n 20 ${log}`),
        `${name} says nothing between attempts`)
    })

    test(`${name} asserts the version outside the retry loop`, () => {
      // A package that installs and reports the wrong version is a finding.
      // Retrying it would eventually report the same wrong version, slower.
      const afterLoop = workflow.split('done\n').slice(1).join('done\n')
      assert.ok(/test "\$\{?reported\}?" = "\$\{?(version|requested|VERSION)\}?"/.test(afterLoop),
        `${name} asserts the version somewhere a retry could paper over`)
    })
  }

  test('the npm smoke waits for the closure, not just the entry point', () => {
    // `deepwatch-v0.1.2` went red here. The gate waited for
    // `@deepwatch/cli@0.1.2`, which answered on the first check; npx then
    // resolved its dependencies and `@deepwatch/dsh-bundle@^0.1.2` was not
    // visible to that replica. Every package had in fact been published, and
    // an independent read minutes later found all twenty.
    const smoke = job(DEEPWATCH, 'smoke')
    assert.ok(smoke.includes('@deepwatch/'),
      'the readiness walk does not know the scope it is waiting for')
    assert.ok(smoke.includes('dependencies'),
      'the readiness walk does not follow dependencies')
    assert.ok(smoke.includes("method: 'HEAD'"),
      'a packument listing a tarball it cannot serve would pass')
    assert.ok(smoke.includes('DEADLINE_MS'), 'the wait is unbounded')
  })

  test('an ETARGET is judged rather than retried or refused wholesale', () => {
    // One error covers a replica that is behind and a dependency range that is
    // simply wrong. Only the first is worth waiting out, and the second has to
    // stay red -- so the package the error names is asked about directly.
    const smoke = job(DEEPWATCH, 'smoke')
    assert.ok(smoke.includes('*ETARGET*)'), 'ETARGET is not handled at all')
    assert.ok(smoke.includes('is not on the registry at all'),
      'a wrong dependency range would be retried until the deadline')
    assert.ok(smoke.includes('outside this scope; the range is wrong'),
      "an ETARGET for somebody else's package would be treated as ours")
    assert.ok(smoke.includes('a replica is behind'),
      'a genuine propagation delay is not named as one')
  })

  test('the npm smoke resolves from a cache it owns', () => {
    const smoke = job(DEEPWATCH, 'smoke')
    assert.ok(smoke.includes('npm_config_cache='),
      'the cache is inherited rather than isolated')
    assert.ok(smoke.includes('rm -rf "${npm_config_cache}"'),
      'a warm cache would answer for the registry')
  })

  test('the npm smoke starts the CLI, not only resolves it', () => {
    // Printing a version proves resolution. It does not prove the thing runs.
    const smoke = job(DEEPWATCH, 'smoke')
    assert.ok(smoke.includes('doctor --json'), 'nothing in the smoke starts the CLI')
    assert.ok(smoke.includes('findings'),
      'the startup check asserts nothing about what came back')
  })
})
