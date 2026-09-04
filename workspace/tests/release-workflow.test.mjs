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

  test('Core classifies a prerelease from the version, not the tag', () => {
    // `core-v0.1.0` contains a hyphen, and the `*-*` arm of that case
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
    assert.match(verify, /npm view/)
    assert.match(verify, /is already published/)
    assert.ok(verify.indexOf('npm view') < verify.indexOf('upload-artifact'),
      'the existence check must run before anything is handed to the publish job')
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
    assert.match(doc, /Do not re-run the job/)
    assert.match(doc, /npm deprecate/)
    assert.match(doc, /core-v<version>/)
    assert.match(doc, /deepwatch-v<version>/)
    // And it must keep the two trains apart. This used to pin "Neither train
    // has ever run", which was wrong in the half that mattered: `watch-skill`
    // is already on PyPI, and calling its next tag a first publication sent a
    // release owner looking for a one-time credential step that does not apply.
    assert.match(doc, /DeepWatch has never published/)
    assert.match(doc, /Watch Skill has published before/)
    assert.match(doc, /update to an existing package/)
    assert.doesNotMatch(doc, /Neither train has ever run/,
      'the corrected claim was reverted to the one that misled')
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
