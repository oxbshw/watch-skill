/**
 * The commit metadata policy, shown rejecting things.
 *
 * A gate nobody has watched refuse anything is a gate nobody knows the shape
 * of. These are counterfactuals: each one is a message that must fail, written
 * here rather than committed, because proving a history gate works by putting
 * a prohibited trailer into the history would be a strange way to keep one
 * clean.
 *
 * The rule is stricter than "no false authorship claim", and deliberately so.
 * A mention anywhere in a subject, a body or a trailer fails — including in a
 * sentence that is perfectly true about the product, and including in a
 * message explaining the rule itself. That last case is not hypothetical: the
 * commit that introduced this policy described it by naming what it forbids,
 * and so broke it.
 *
 * The other half matters as much. This reads commit metadata and nothing else.
 * Repository files describe the agent integrations this project supports, at
 * length, and none of that is the gate's business.
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

import { FORBIDDEN, inspectCommit } from '../scripts/verify-commits.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')

/** One commit's metadata, in the shape the gate reads it. */
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
  test('a subject naming a tool vendor', () => {
    const broken = rulesBroken(commit({
      subject: 'chore(docs): document the Claude Code integration',
    }))
    assert.deepEqual(broken, ['vendor name'])
  })

  test('a body naming one inside an otherwise legitimate product sentence', () => {
    // True, useful, and still not allowed here: the sentence belongs in the
    // documentation, which is where somebody looks for it.
    const broken = rulesBroken(commit({
      subject: 'feat(mcp): add the tool listing endpoint',
      body: 'This repository documents Claude Code as a supported integration,\n'
        + 'with its own skills, commands and agent page.',
    }))
    assert.deepEqual(broken, ['vendor name'])
  })

  test('the other vendor name, wherever it appears', () => {
    assert.deepEqual(
      rulesBroken(commit({ subject: 'fix(api): retry an Anthropic 529 once' })),
      ['vendor name'])
    assert.deepEqual(
      rulesBroken(commit({ subject: 'ok', body: 'see anthropic.com for the limits' })),
      ['vendor name'])
  })

  test('a co-author trailer that is a tool rather than a person', () => {
    const broken = rulesBroken(commit({
      subject: 'feat(library): add the facet index',
      body: 'Co-Authored-By: Some Assistant <noreply@example.com>',
    }))
    assert.ok(broken.includes('non-human co-author'),
      'a trailer whose address is a no-reply robot is not a co-author')
  })

  test('a generation notice', () => {
    assert.deepEqual(
      rulesBroken(commit({ subject: 'ok', body: 'Generated with some tool v2' })),
      ['generation notice'])
  })

  test('assistance wording, hyphenated or spaced', () => {
    for (const wording of [
      'This patch was AI-generated from the failing test.',
      'AI generated, then reviewed by hand.',
      'An AI-assisted refactor of the parser.',
      'ai assisted cleanup',
      'The migration was written by AI and checked here.',
      'Done with the help of an AI.',
    ]) {
      assert.deepEqual(rulesBroken(commit({ subject: 'ok', body: wording })),
        ['assistance note'], `not refused: ${wording}`)
    }
  })

  test('case never matters', () => {
    for (const subject of ['CLAUDE', 'claude', 'ClAuDe', 'ANTHROPIC']) {
      assert.notDeepEqual(rulesBroken(commit({ subject })), [],
        `${subject} passed, and it must not`)
    }
  })
})

describe('metadata that must be left alone', () => {
  test('a real person keeps their co-author trailer', () => {
    const text = commit({
      subject: 'feat(memory): add the correction ledger',
      body: 'Co-Authored-By: Ada Lovelace <ada@example.com>',
    })
    const found = inspectCommit(text)
    assert.deepEqual(found.problems, [], 'a human co-author is not a violation')
    assert.equal(found.humanCoauthor, true, 'and is counted as preserved')
  })

  test('an ordinary message about ordinary work', () => {
    const found = inspectCommit(commit({
      subject: 'fix(live): report a dropped frame instead of counting it twice',
      body: 'The cursor advanced before the event was written, so a reader that\n'
        + 'resumed from it skipped the frame the drop referred to.',
    }))
    assert.deepEqual(found.problems, [])
  })

  test('a regenerated artifact is not a generation notice', () => {
    // `\b` before "generated" is what keeps this from matching, and this is
    // the sentence that would otherwise be caught every release.
    const found = inspectCommit(commit({
      subject: 'chore(inventory): refresh the slot catalogue',
      body: 'Regenerated with the pinned baseline after the upstream bump.',
    }))
    assert.deepEqual(found.problems, [])
  })

  test('the word cursor, in the sense this codebase uses it constantly', () => {
    const found = inspectCommit(commit({
      subject: 'feat(live): make the event stream cursor-addressed',
      body: 'A cursor is idempotent: resuming from one returns the same page.',
    }))
    assert.deepEqual(found.problems, [],
      'a pagination cursor is not a tool vendor, and five commits say so')
  })
})

describe('what the gate is allowed to read', () => {
  test('it reads commit metadata and never repository content', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'verify-commits.mjs'), 'utf8')
    // Everything it asks git for is a metadata placeholder. A `git grep`, a
    // `git show`, or a diff would make documentation about a supported
    // integration fail a commit that never mentioned it.
    assert.match(source, /--format=/)
    for (const reader of ['git grep', "'show'", "'diff'", 'readFileSync']) {
      assert.ok(!source.includes(reader), `the gate must not use ${reader}`)
    }
  })

  test('the documentation is free to describe the integrations it supports', () => {
    // The counterpart to every test above: these files say the words on
    // purpose, and no commit is refused because of them.
    const docs = readdirSync(REPO).filter(name => name === 'AGENTS.md' || name === 'CONTRIBUTING.md')
    assert.ok(docs.length > 0, 'the policy has to be written down somewhere')
    for (const name of docs) {
      const text = readFileSync(join(REPO, name), 'utf8')
      assert.ok(text.length > 0, `${name} is empty`)
    }
  })

  test('every rule is a real regular expression with a name', () => {
    assert.ok(FORBIDDEN.length >= 6, 'the policy names more than a couple of things')
    for (const { rule, test: pattern } of FORBIDDEN) {
      assert.equal(typeof rule, 'string')
      assert.notEqual(rule, '')
      assert.ok(pattern instanceof RegExp)
      assert.ok(pattern.flags.includes('i'), `${rule} must be case-insensitive`)
    }
  })
})
