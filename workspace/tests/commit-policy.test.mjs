/**
 * The commit metadata policy, shown refusing things.
 *
 * A gate nobody has watched refuse anything is a gate nobody knows the shape
 * of. These are counterfactuals: each one is a message that must fail, written
 * here rather than committed, because proving a history gate works by putting
 * a prohibited trailer into the history would be a strange way to keep one
 * clean.
 *
 * The policy is about accountability, not about tools. A commit has a
 * conventional subject, an author who is a person, and co-author trailers that
 * name people. The gate names no vendor and reads no prose — the tests at the
 * bottom of this file are what keep it that way, because the previous version
 * did both, and the effect was a rule that could not be squared with
 * documenting the product's own supported integrations.
 *
 * Nothing here reads a repository's history. Every other job takes a shallow
 * checkout deliberately, so an assertion about the branch would fail for want
 * of `origin/main` rather than for anything about a commit. The branch itself
 * is audited by the `commit-metadata` job, which fetches the history it needs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONVENTIONAL, coauthors, inspectCommit } from '../scripts/verify-commits.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')

/** One commit's metadata, in the shape and order the gate reads it. */
function commit({ author = 'Sayed Allam <person@example.com>', subject, body = '' }) {
  return [
    'e3b0c44298fc1c149afbf4c8996fb924',
    author,
    author,
    `Author: ${author.split(' <')[0]}`,
    `Committer: ${author.split(' <')[0]}`,
    subject,
    '',
    body,
  ].join('\n')
}

/** The rules one message breaks, by name. */
function rulesBroken(text) {
  return inspectCommit(text).problems.map(problem => problem.rule)
}

describe('metadata that must be refused', () => {
  test('a subject that is not a conventional commit', () => {
    assert.deepEqual(
      rulesBroken(commit({ subject: 'made some changes to the parser' })),
      ['conventional subject'])
  })

  test('an empty subject', () => {
    assert.ok(rulesBroken(commit({ subject: '' })).includes('conventional subject'))
  })

  test('a co-author trailer whose address routes to nobody', () => {
    const broken = rulesBroken(commit({
      subject: 'feat(library): add the facet index',
      body: 'Co-Authored-By: Some Helper <noreply@example.com>',
    }))
    assert.ok(broken.includes('non-human co-author'),
      'a no-reply address credits nobody, so it is not a co-author')
  })

  test('a co-author trailer whose name declares itself automation', () => {
    const broken = rulesBroken(commit({
      subject: 'chore(deps): bump the pinned baseline',
      body: 'Co-Authored-By: dependabot[bot] <support@example.com>',
    }))
    assert.ok(broken.includes('non-human co-author'))
  })

  test('a co-author trailer that is not an address at all', () => {
    const broken = rulesBroken(commit({
      subject: 'fix(index): reuse the prepared statement',
      body: 'Co-Authored-By: someone',
    }))
    assert.ok(broken.includes('non-human co-author'))
  })

  test('an author who is not a person', () => {
    assert.ok(rulesBroken(commit({
      author: 'release[bot] <no-reply@example.com>',
      subject: 'chore(release): publish the preview',
    })).includes('human author'))
  })

  test('a generated-by trailer', () => {
    assert.ok(rulesBroken(commit({
      subject: 'chore(inventory): refresh the catalogue',
      body: 'Generated with: some-tool v2',
    })).includes('generation notice'))
  })
})

describe('metadata that must be left alone', () => {
  test('a real person keeps their co-author trailer', () => {
    const found = inspectCommit(commit({
      subject: 'feat(memory): add the correction ledger',
      body: 'Co-Authored-By: Ada Lovelace <ada@example.com>',
    }))
    assert.deepEqual(found.problems, [], 'a human co-author is not a violation')
    assert.equal(found.humanCoauthors, 1, 'and is counted as preserved')
  })

  test('several human co-authors are all preserved', () => {
    const found = inspectCommit(commit({
      subject: 'feat(verify): add the attestation chain',
      body: 'Co-Authored-By: Ada Lovelace <ada@example.com>\n'
        + 'Co-Authored-By: Grace Hopper <grace@example.com>',
    }))
    assert.deepEqual(found.problems, [])
    assert.equal(found.humanCoauthors, 2)
  })

  test('an ordinary message about ordinary work', () => {
    const found = inspectCommit(commit({
      subject: 'fix(live): report a dropped frame instead of counting it twice',
      body: 'The cursor advanced before the event was written, so a reader that\n'
        + 'resumed from it skipped the frame the drop referred to.',
    }))
    assert.deepEqual(found.problems, [])
  })

  test('a regenerated artifact is not a generated-by trailer', () => {
    // The trailer anchor is what keeps this from matching, and this is the
    // sentence that would otherwise be caught every release.
    const found = inspectCommit(commit({
      subject: 'chore(inventory): refresh the slot catalogue',
      body: 'Regenerated with the pinned baseline after the upstream bump.',
    }))
    assert.deepEqual(found.problems, [])
  })

  test('a message may describe the integrations this product supports', () => {
    // The case the previous policy could not express. Naming a supported
    // integration in a commit is a product fact, and refusing it made the rule
    // read as one about concealment rather than about accountability.
    for (const subject of [
      'docs(agents): document the Claude Code integration',
      'fix(providers): retry an Anthropic 529 once',
      'feat(adapters): add the Cursor rules file',
      'feat(providers): route OpenRouter through the shared client',
    ]) {
      assert.deepEqual(rulesBroken(commit({ subject })), [], `refused: ${subject}`)
    }
  })

  test('the word cursor, in the sense this codebase uses it constantly', () => {
    const found = inspectCommit(commit({
      subject: 'feat(live): make the event stream cursor-addressed',
      body: 'A cursor is idempotent: resuming from one returns the same page.',
    }))
    assert.deepEqual(found.problems, [])
  })
})

describe('what the gate is allowed to read', () => {
  test('it reads commit metadata and never repository content', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'verify-commits.mjs'), 'utf8')
    // Everything it asks git for is a metadata placeholder. A `git grep`, a
    // `git show`, or a diff would make documentation about a supported
    // integration fail a commit that never mentioned it.
    assert.match(source, /--format=/)
    for (const reader of ['git grep', "'show'", "'diff'"]) {
      assert.ok(!source.includes(reader), `the gate must not use ${reader}`)
    }
  })

  test('the policy names no vendor', () => {
    // The load-bearing assertion of this whole file. A rule that names
    // particular assistants is a rule about who helped rather than about who
    // is accountable, and it cannot be stated publicly without reading as an
    // instruction to conceal.
    const source = readFileSync(join(ROOT, 'scripts', 'verify-commits.mjs'), 'utf8')
    const rules = source.slice(source.indexOf('export const CONVENTIONAL')).toLowerCase()
    for (const vendor of ['claude', 'anthropic', 'copilot', 'codeium', 'chatgpt', 'openai', 'gemini']) {
      assert.ok(!rules.includes(vendor), `the rules must not name ${vendor}`)
    }
  })

  test('the written policy does not require hiding how work was done', () => {
    for (const name of ['AGENTS.md', 'CONTRIBUTING.md']) {
      const text = readFileSync(join(REPO, name), 'utf8').toLowerCase()
      for (const phrase of [
        'no assistant attribution',
        'as the repository owner',
        'mention of ai assistance',
      ]) {
        assert.ok(!text.includes(phrase), `${name} still says "${phrase}"`)
      }
    }
  })

  test('the documentation still states the policy somewhere', () => {
    const docs = readdirSync(REPO).filter(name => name === 'AGENTS.md' || name === 'CONTRIBUTING.md')
    assert.equal(docs.length, 2, 'the policy has to be written down')
    for (const name of docs) {
      const text = readFileSync(join(REPO, name), 'utf8')
      assert.match(text, /co-authored-by/i, `${name} must state the co-author rule`)
    }
  })

  test('the conventional-subject pattern accepts the types this repo uses', () => {
    for (const subject of [
      'feat: add a thing', 'fix(bridge): stop a thing', 'chore(release)!: drop a thing',
      'docs: explain a thing', 'test(live): prove a thing', 'refactor(index): move a thing',
    ]) {
      assert.ok(CONVENTIONAL.test(subject), `rejected: ${subject}`)
    }
    for (const subject of ['add a thing', 'feat add a thing', 'nope: add a thing']) {
      assert.ok(!CONVENTIONAL.test(subject), `accepted: ${subject}`)
    }
  })

  test('coauthors reports why a trailer was refused', () => {
    const [entry] = coauthors('Co-Authored-By: Helper <no-reply@example.com>')
    assert.equal(entry.human, false)
    assert.match(entry.why, /routes to nobody/)
  })
})
