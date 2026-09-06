/**
 * The irreversible first-publish path is held to its offline contract.
 *
 * The bootstrap exists for one npm ordering: a Trusted Publisher is configured
 * on a package, and a package that has never been published has no page to
 * configure it on. So the first upload of each of the twenty is made from a
 * machine, once, and everything after it goes through the workflow.
 *
 * That makes this the least-tested and least-reversible code in the repository,
 * which is a bad pair. What is held here is the set of mistakes that cost a
 * version each: a registry decision made on a version *string*, an error read
 * as an absence, a read-only probe reported as a permission, and a diagnostic
 * thrown away and replaced with advice that does not apply.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, describe } from 'node:test'

import { EXPECTED_ORDER, distTag, sanitize } from '../scripts/first-publish.mjs'
import { publishOrder } from '../scripts/publish-order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'scripts', 'first-publish.mjs'), 'utf8')

/**
 * The same file with its prose removed.
 *
 * The assertions below come in two kinds, and only one of them may read a
 * comment. "This behaviour is present" is fine to find anywhere. "This
 * behaviour is gone" is not: this repository documents a removed mistake by
 * quoting it, so `access: 'verified'` and the stock token sentence both still
 * appear in the file — inside the paragraphs explaining why they were taken
 * out. A rule that failed on those would be a rule against writing down what
 * went wrong.
 */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('the bootstrap order is the approved dependency order for all 20 packages', () => {
  assert.equal(EXPECTED_ORDER.length, 20)
  assert.deepEqual(publishOrder().map(entry => entry.name), [...EXPECTED_ORDER])
})

test('dry-run is the default and publishing needs two explicit flags', () => {
  assert.match(SOURCE, /process\.argv\.includes\('--publish'\)/)
  assert.match(SOURCE, /--publish also requires --confirm-first-publish/)
  assert.match(SOURCE, /if \(!publishing\)/)
  assert.ok(SOURCE.indexOf('if (!publishing)') < SOURCE.indexOf("'publish',"))
})

/** The single publish call, for the assertions that read its arguments. */
function publishCall() {
  const calls = [...SOURCE.matchAll(/npm\(\[\s*'publish',[\s\S]{0,220}?\]\)/g)]
  assert.equal(calls.length, 1, 'there must be exactly one publish command')
  return calls[0][0]
}

test('the only publish command is a public tarball publication', () => {
  assert.match(publishCall(), /'--access', 'public'/)
  assert.ok(!SOURCE.includes('shell: true'))
})

test('the dist-tag is derived from the version, never hardcoded', () => {
  // It was hardcoded to `preview`, which was right while every version was a
  // preview and silently wrong the moment one was not: a stable release
  // published under `preview` leaves `npm i @deepwatch/cli` resolving nothing,
  // because `latest` would never exist.
  assert.match(publishCall(), /'--tag', distTag\(/)
  assert.doesNotMatch(CODE, /'--tag', 'preview'/)

  assert.equal(distTag('0.1.0'), 'latest')
  assert.equal(distTag('1.4.0'), 'latest')
  assert.equal(distTag('0.1.0-preview.0'), 'preview')
  assert.equal(distTag('0.1.0-rc.1'), 'next')
  // A prerelease shape this train has no tag for is a refusal rather than a
  // guess: the release workflow makes the same call, and the two must not
  // disagree about a publication that cannot be taken back.
  assert.throws(() => distTag('0.1.0-beta.1'), /no dist-tag for/)
})

test('a partial run records created, skipped, failed and remaining packages', () => {
  for (const field of ['created', 'skipped', 'failed', 'remaining']) {
    assert.match(SOURCE, new RegExp(`${field}:`))
  }
  assert.match(SOURCE, /saveState\(statePath, state\)/)
})

describe('one registry policy, and it is not this file\'s own', () => {
  test('the decision comes from publish-plan, not from a second opinion here', () => {
    // It had its own, and the two disagreed in both directions. This script
    // ran `npm view <name>@<version> version` and branched on the exit code:
    // zero meant "skip, already exists" and non-zero meant "publish, absent".
    assert.match(SOURCE, /import \{ buildPlan \} from '\.\/publish-plan\.mjs'/)
    assert.match(SOURCE, /buildPlan\(\{ artifacts \}\)/)
  })

  test('no version-string existence check survives anywhere in the file', () => {
    // The exact shape that skipped a version published from a different
    // commit. `publish-plan.mjs` asks for `dist` and compares integrity;
    // asking for `version` can only ever answer "something is there".
    assert.doesNotMatch(CODE, /'view',[^\n]*'version'/)
    assert.doesNotMatch(CODE, /already_exists/)
  })

  test('a refusal stops the run before the first upload', () => {
    assert.match(SOURCE, /the registry plan refuses this set/)
    assert.ok(SOURCE.indexOf('planRegistry(artifacts)') < SOURCE.indexOf("'publish', join(artifacts"),
      'the plan is built before anything is published')
  })
})

describe('a read-only probe is not a permission', () => {
  test('access probes do not print an npm identity or configuration', () => {
    assert.match(SOURCE, /'whoami'/)
    assert.match(SOURCE, /'access', 'list', 'packages', '@deepwatch'/)
    assert.ok(!SOURCE.includes('process.stdout.write(identity'))
    assert.ok(!SOURCE.includes('process.stdout.write(access'))
  })

  test('a successful scope listing is never reported as verified access', () => {
    // For an empty scope, `npm access list packages @deepwatch` exits zero and
    // prints nothing -- which is exactly the state in which nothing has been
    // verified. It was recorded as `access: 'verified'`.
    assert.doesNotMatch(CODE, /access: 'verified'/)
    assert.match(SOURCE, /publishPermission: 'not_provable_before_upload'/)
  })

  test('an account outside the organisation is refused rather than attempted', () => {
    assert.match(SOURCE, /not_a_member/)
    assert.match(SOURCE, /cannot publish into the @deepwatch scope/)
  })
})

describe('npm gets to say what went wrong', () => {
  test('a failing probe reports npm\'s own output, not a stock token request', () => {
    // One sentence -- "authenticate with a short-lived, 2FA-protected
    // publisher token" -- was the answer to an expired session, a 403 from
    // the wrong account, a proxy refusing CONNECT and a registry that was
    // down. Three of those are not fixed by making a token.
    assert.match(SOURCE, /npm said:/)
    assert.match(SOURCE, /credential will not help/)
    assert.doesNotMatch(CODE, /authenticate with a short-lived, 2FA-protected publisher token/)
  })

  test('the existing authenticated session is the supported path', () => {
    assert.match(SOURCE, /npm login --registry=https:\/\/registry\.npmjs\.org\/ --auth-type=web/)
  })

  test('a failed publish prints the diagnostics it tells the operator to read', () => {
    assert.match(SOURCE, /process\.stderr\.write\(`\\nnpm refused/)
    assert.match(SOURCE, /diagnostics\(result\)/)
  })

  test('local uploads are never described as attested', () => {
    assert.match(SOURCE, /carry no registry provenance attestation/)
    assert.doesNotMatch(CODE, /--provenance/)
  })
})

describe('diagnostics are sanitized before they reach a console or a state file', () => {
  test('npm tokens, authTokens, bearer headers and URL credentials are removed', () => {
    const dirty = [
      'npm error need auth npm_abcdefghijklmnopqrstuvwxyz012345',
      '//registry.npmjs.org/:_authToken=npm_SECRETSECRETSECRET1234',
      'authorization: Bearer eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4',
      'request to https://user:hunter2@proxy.internal:8080 failed',
    ].join('\n')
    const clean = sanitize(dirty)
    assert.doesNotMatch(clean, /npm_abcdefghijklmnopqrstuvwxyz012345/)
    assert.doesNotMatch(clean, /npm_SECRETSECRETSECRET1234/)
    assert.doesNotMatch(clean, /SflKxwRJSMeKKF2QT4/)
    assert.doesNotMatch(clean, /hunter2/)
    // And it is still a diagnostic: the reason survives the redaction.
    assert.match(clean, /need auth/)
    assert.match(clean, /failed/)
  })

  test('an ordinary registry error passes through intact', () => {
    const said = 'npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/@deepwatch%2fcli'
    assert.equal(sanitize(said), said)
  })
})
