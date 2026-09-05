#!/usr/bin/env node
/**
 * Every commit in this repository is answerable to a person.
 *
 * That is the whole policy, and it is about accountability rather than about
 * tools. A `Co-Authored-By` trailer is how this project records who is
 * answerable for a change; a trailer naming something that cannot answer for
 * anything makes the field mean less, and that meaning is the only reason the
 * field is there.
 *
 * What this gate checks:
 *
 * - the subject is a conventional commit, so history stays readable;
 * - the author is a person, with a name and a routable address;
 * - `Co-Authored-By` trailers name people, and are otherwise left alone;
 * - no generated-by notice is appended as a trailer.
 *
 * What it deliberately does not check. It does not read prose, and it names
 * no vendor. An earlier version refused any commit message mentioning
 * particular assistants anywhere — subject, body or trailer — which made it
 * impossible to describe the product's own supported integrations in a
 * commit, and read as a rule about concealing how work was done rather than
 * about who is accountable for it. Neither was intended and both were the
 * effect, so the rules below are about the shape of authorship metadata and
 * nothing else.
 *
 * **This reads metadata, and only metadata.** Author, committer, subject,
 * body and trailers. It never looks at repository content.
 *
 * Usage:
 *   node scripts/verify-commits.mjs                 the branch against origin/main
 *   node scripts/verify-commits.mjs <range>         an explicit git range
 *   node scripts/verify-commits.mjs --json
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const JSON_OUT = process.argv.includes('--json')

/**
 * Conventional-commit subject: `type(scope)!: summary`.
 *
 * `release` is in the set alongside the usual eleven, because this repository
 * has two release trains and the commits that promote versions, seal artifacts
 * and finish a release path are a distinct kind of change. They were being
 * written as `release:` already and refused here, which left the branch red
 * for a reason that had nothing to do with accountability -- the thing this
 * gate is actually for. `chore:` would have passed and would have said less.
 */
export const CONVENTIONAL =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|release|revert|style|test)(\([^)]+\))?!?: .+/

/** A `Co-Authored-By` trailer line, captured so its parts can be judged. */
const COAUTHOR_LINE = /^co-authored-by:[ \t]*(.*)$/gim

/** `Name <address>`, which is the only shape a co-author trailer may take. */
const NAMED_ADDRESS = /^([^<]+?)\s*<([^>@\s]+@[^>@\s]+)>$/

/**
 * Addresses that route to nobody.
 *
 * A no-reply address is the distinguishing mark of an automated committer,
 * and testing for it is the vendor-neutral way to say so: it does not matter
 * which service minted the address, only that no person receives mail there
 * and so no person is being credited.
 */
const UNROUTABLE = /^(no-?reply|do-?not-?reply)(\+[^@]*)?@/i

/** Names that announce themselves as automation. */
const BOT_NAME = /(\[bot\]|^bot$|\bbot\s*$)/i

/**
 * A generated-by notice, as a trailer only.
 *
 * Anchored to a trailer line on purpose. "Regenerated with the pinned
 * baseline" is an ordinary sentence about an ordinary release chore, and a
 * rule that matched it anywhere in a body fired every time the inventories
 * were refreshed.
 */
const GENERATED_TRAILER = /^(generated|co-generated|created)[-\s]?(with|by):/im

/**
 * Parse the `Co-Authored-By` trailers out of one commit's metadata.
 *
 * @param text - the full metadata blob for one commit.
 * @returns one entry per trailer, with whether it names a person.
 */
export function coauthors(text) {
  const found = []
  for (const match of text.matchAll(COAUTHOR_LINE)) {
    const value = (match[1] ?? '').trim()
    const parts = NAMED_ADDRESS.exec(value)
    if (parts === null) {
      found.push({ value, human: false, why: 'not in `Name <address>` form' })
      continue
    }
    const [, name, address] = parts
    if (UNROUTABLE.test(address)) {
      found.push({ value, human: false, why: 'the address routes to nobody' })
      continue
    }
    if (BOT_NAME.test(name.trim())) {
      found.push({ value, human: false, why: 'the name declares itself automation' })
      continue
    }
    found.push({ value, human: true, why: null })
  }
  return found
}

/**
 * Every rule one commit's metadata breaks, and how many people co-authored it.
 *
 * Separated from the command so it can be exercised against messages nobody
 * has to commit first. A gate is worth showing refusing things, and writing a
 * prohibited trailer into real history to prove it would be an odd way to keep
 * a history clean.
 *
 * @param text - author, committer, subject, body and trailers of one commit.
 */
export function inspectCommit(text) {
  const lines = text.split('\n')
  // Layout, fixed by the --format in main(): sha, author, committer, Author:,
  // Committer:, then the message. The subject is the first message line.
  const author = (lines[1] ?? '').trim()
  const subject = (lines[5] ?? '').trim()
  const problems = []

  if (!CONVENTIONAL.test(subject)) {
    problems.push({
      rule: 'conventional subject',
      line: subject === '' ? '(empty subject)' : subject,
    })
  }

  const authorParts = NAMED_ADDRESS.exec(author)
  if (authorParts === null
    || UNROUTABLE.test(authorParts[2])
    || BOT_NAME.test(authorParts[1].trim())) {
    problems.push({ rule: 'human author', line: author === '' ? '(no author)' : author })
  }

  const trailers = coauthors(text)
  const nonHuman = trailers.find(entry => !entry.human)
  if (nonHuman !== undefined) {
    problems.push({
      rule: 'non-human co-author',
      line: `Co-Authored-By: ${nonHuman.value} — ${nonHuman.why}`,
    })
  }

  if (GENERATED_TRAILER.test(text)) {
    problems.push({
      rule: 'generation notice',
      line: lines.find(line => GENERATED_TRAILER.test(line))?.trim() ?? '(in the message)',
    })
  }

  return { problems, humanCoauthors: trailers.filter(entry => entry.human).length }
}

/**
 * Stop, saying which history could not be read.
 *
 * "I could not see the commits" is not "the commits are clean", and in
 * `--json` mode a caller is owed JSON either way — printing to stderr and
 * exiting left a reader parsing an empty string, which is how this failure
 * first showed up: as a syntax error, in four jobs, describing nothing.
 */
function unreadable(detail) {
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: detail }, null, 2)}\n`)
  } else {
    process.stderr.write(
      `watch: ${detail}\n`
      + '       This gate needs the branch history. A shallow checkout does not\n'
      + '       have it; fetch with depth 0, or name an explicit range.\n')
  }
  process.exit(1)
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    unreadable(`git ${args.join(' ')} failed: ${result.stderr.trim().split('\n')[0] ?? ''}`)
  }
  return result.stdout
}

/**
 * Which commits to check.
 *
 * The branch's own commits by default — everything not already on `main` —
 * because a gate that checked all of history would fail on whatever is already
 * there and could never be made green by the change in front of it.
 */
function range() {
  const explicit = process.argv.slice(2).find(entry => !entry.startsWith('--'))
  if (explicit !== undefined) return explicit
  const base = ['origin/main', 'main'].find(candidate => {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd: ROOT })
    return result.status === 0
  })
  if (base !== undefined) return `${base}..HEAD`
  // No base to compare against. `HEAD~20..HEAD` was the old fallback and it is
  // worse than refusing: on a shallow checkout it fails anyway, and on a
  // shallow-but-deep-enough one it would silently audit an arbitrary twenty
  // commits and report them clean.
  return unreadable('neither origin/main nor main is present in this checkout')
}

function main() {
  const selected = range()
  // A record separator no commit message will contain.
  const SEP = '@@deepwatch-commit@@'
  const raw = git([
    'log', selected, '--no-merges',
    `--format=${SEP}%H%n%an <%ae>%n%cn <%ce>%nAuthor: %an%nCommitter: %cn%n%B`,
  ])

  const commits = raw.split(SEP).map(entry => entry.trim()).filter(entry => entry !== '')
  const problems = []
  let humanCoauthors = 0

  for (const commit of commits) {
    const sha = commit.split('\n')[0] ?? ''
    const found = inspectCommit(commit)
    for (const problem of found.problems) problems.push({ sha: sha.slice(0, 8), ...problem })
    humanCoauthors += found.humanCoauthors
  }

  const summary = { range: selected, commits: commits.length, humanCoauthors, problems }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, ...summary }, null, 2)}\n`)
    process.exit(problems.length === 0 ? 0 : 1)
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(` FAIL  ${problem.sha}  ${problem.rule}\n        ${problem.line}\n`)
    }
    process.stderr.write(
      `\nwatch: ${String(problems.length)} commit(s) break the metadata policy.\n`
      + '       A commit uses a conventional subject, is authored by the person\n'
      + '       accountable for the change, and credits only people as\n'
      + '       co-authors. See the Commits section of CONTRIBUTING.md.\n')
    process.exit(1)
  }

  process.stdout.write(
    `commits: ${String(commits.length)} checked over ${selected}, metadata policy clean\n`
    + `         ${String(humanCoauthors)} human co-author trailer(s) preserved\n`)
}

// Only when run, so importing the rules for a test does not audit a repository
// as a side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) main()
