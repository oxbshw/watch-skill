/**
 * Two runs of one workflow may not cancel each other, and a release gate may
 * not cancel at all.
 *
 * The concurrency group was `${{ github.workflow }}-${{ github.ref }}` with
 * `cancel-in-progress: true`. For a branch push and a `workflow_dispatch` on
 * that same branch `github.ref` is identical, so both landed in one group and
 * the later run killed the earlier. On 2026-09-03 a dispatch created at
 * 11:48:51 cancelled the push run created at 11:48:33 for commit `e34c6c6`:
 * eight release-critical jobs went to `cancelled` in flight, and
 * `workspace-required` failed on dependencies that never finished. The
 * pull-request run for the same commit passed, because its ref is
 * `refs/pull/N/merge` and it was never in that group.
 *
 * Nothing was wrong with the code under test. The evidence was destroyed by
 * the thing collecting it, which is the worst kind of green-and-red to hand
 * somebody at a release gate.
 *
 * These rules are cheap to state and were expensive to learn:
 *
 *   - the concurrency group separates event kinds, so push, pull_request and
 *     workflow_dispatch cannot collide;
 *   - automatic cancellation is off for a release branch, on which a
 *     half-finished matrix is not evidence and a queued one costs only time;
 *   - one canonical required execution per commit, so a single required
 *     context cannot carry two conclusions for one SHA;
 *   - no job in the ordinary check list is written so that it can only skip.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKFLOWS = join(ROOT, '.github', 'workflows')

/** Every workflow, as text. Parsing YAML would hide the expressions. */
function workflows() {
  return readdirSync(WORKFLOWS)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => ({ name, text: readFileSync(join(WORKFLOWS, name), 'utf8') }))
}

/**
 * The lines under a key, by indentation, comments and all.
 *
 * These files put explanations between a key and its value, so a regex that
 * expects them adjacent reports a policy violation that is really a parsing
 * mistake. Indentation is the only thing YAML actually promises here.
 */
function block(text, key, indent = 0) {
  const lines = text.split('\n')
  const opener = `${' '.repeat(indent)}${key}:`
  const start = lines.findIndex(line => line.startsWith(opener))
  if (start < 0) return ''
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') { body.push(line); continue }
    const depth = line.length - line.trimStart().length
    if (depth <= indent) break
    body.push(line)
  }
  return body.join('\n')
}

/** The workflows that gate a release and therefore must not be cancelled. */
const GATES = ['workspace-ci.yml', 'ci.yml', 'install.yml']

describe('a run may not cancel another run of a different kind', () => {
  const all = workflows()

  test('the sweep found the workflows it is about', () => {
    assert.ok(all.length >= 4, `only ${String(all.length)} workflows found`)
    for (const gate of GATES) {
      assert.ok(all.some(w => w.name === gate), `${gate} is missing`)
    }
  })

  for (const gate of GATES) {
    test(`${gate} keeps the event kinds in separate concurrency groups`, () => {
      const { text } = all.find(w => w.name === gate)
      const group = block(block(text, 'concurrency'), 'group', 2)
        || (/^\s*group:\s*(.+)$/m.exec(block(text, 'concurrency'))?.[1] ?? '')
      assert.ok(group.includes('github.event_name'),
        `${gate} groups by ref alone, so a dispatch and a push on one branch `
        + 'share a group and the later one cancels the earlier');
      assert.ok(group.includes('github.ref'),
        `${gate} does not separate refs, so two branches would collide`)
    })

    test(`${gate} never auto-cancels on a release branch`, () => {
      const { text } = all.find(w => w.name === gate)
      const concurrency = block(text, 'concurrency')
      const marker = concurrency.indexOf('cancel-in-progress:')
      const value = marker < 0 ? '' : concurrency.slice(marker)
      assert.ok(!/^\s*true\s*$/.test(value),
        `${gate} cancels unconditionally; a started release job must be `
        + 'allowed to finish');
      assert.ok(value.includes("refs/heads/release/"),
        `${gate} does not exempt release branches from cancellation`)
      assert.ok(value.includes('github.head_ref'),
        `${gate} exempts a release push but not a release pull request, whose `
        + 'ref is refs/pull/N/merge')
    })
  }
})

describe('one canonical required execution per commit', () => {
  const all = workflows()

  for (const gate of GATES) {
    test(`${gate} does not run a second full suite for a branch push`, () => {
      // Two runs emitting one required context for one SHA is a check nobody
      // can read: `workspace-required` was simultaneously failed (push,
      // cancelled) and successful (pull request) for e34c6c6.
      const { text } = all.find(w => w.name === gate)
      const push = block(block(text, 'on'), 'push', 2)
      assert.ok(push.includes('branches:'),
        `${gate} pushes on every branch, duplicating the pull-request run`)
      assert.ok(!push.includes("'**'") && !push.includes('"**"'),
        `${gate} still triggers on every branch push`)
    })
  }
})

describe('the aggregate keeps failing when it should', () => {
  const text = readFileSync(join(WORKFLOWS, 'workspace-ci.yml'), 'utf8')

  test('workspace-required still fails on a cancelled dependency', () => {
    // The aggregate is what noticed the cancellation. Fixing the cause must
    // not soften the detector.
    assert.match(text, /failure\|cancelled/,
      'the aggregate no longer treats a cancelled dependency as a failure')
  })

  test('workspace-required still fails on an unexpected skip', () => {
    assert.match(text, /no Workspace job may be skipped/)
  })

  test('nothing was given a licence to pass regardless', () => {
    for (const { name, text: body } of workflows()) {
      assert.ok(!/continue-on-error:\s*true/.test(body),
        `${name} lets a job fail without failing`)
      assert.ok(!/^\s*if:\s*false\s*$/m.test(body),
        `${name} contains a job switched off rather than removed`)
    }
  })
})

describe('the ordinary check list contains no permanently skipped job', () => {
  test('no pre-publication job is gated on schedule or dispatch alone', () => {
    // `uvx from PyPI` sat in the pull-request list behind
    // `if: schedule || workflow_dispatch`, so it could only ever be skipped:
    // there is nothing on PyPI for a candidate to resolve to. A check that is
    // always grey teaches a reader to ignore grey.
    const offenders = []
    for (const { name, text } of workflows()) {
      if (name === 'post-publish.yml' || name.startsWith('release')) continue
      const pattern =
        /if:\s*github\.event_name\s*==\s*'schedule'\s*\|\|\s*github\.event_name\s*==\s*'workflow_dispatch'/
      if (pattern.test(text)) offenders.push(name)
    }
    assert.deepEqual(offenders, [],
      'these carry a job that can only skip on a pull request:\n  '
      + offenders.join('\n  '))
  })

  test('the published smoke lives where it can actually run', () => {
    const post = readFileSync(join(WORKFLOWS, 'post-publish.yml'), 'utf8')
    assert.match(post, /release:\s*\n\s*types:\s*\[published\]/,
      'the published smoke does not trigger on a publication')
    assert.match(post, /uvx --from "\$spec" watch-skill --version/)
    assert.ok(!/uv publish|twine upload|npm publish/.test(post),
      'the post-publication workflow publishes something')
  })

  test('the candidate smoke replaced it, and asserts the artifact', () => {
    const install = readFileSync(join(WORKFLOWS, 'install.yml'), 'utf8')
    assert.match(install, /uvx-candidate:/)
    assert.match(install, /uv build --wheel/)
    // The four claims the candidate smoke owes: version, bridge, doctor, and
    // that the thing answering is the artifact rather than the checkout.
    assert.match(install, /watch-skill --version/)
    assert.match(install, /watch-skill bridge --help/)
    assert.match(install, /grep -qi "doctor"/)
    assert.match(install, /resolved from the source checkout/)
  })
})
