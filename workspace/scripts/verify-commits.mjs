#!/usr/bin/env node
/**
 * No tool signs a commit in this repository.
 *
 * Whatever helped write a change, the commit is from the person who made it.
 * A `Co-Authored-By` naming an assistant, a "Generated with" line, or a note
 * about AI assistance in a message is a claim about authorship that is not
 * true, and it is the kind of thing that accumulates quietly until a history
 * is full of it.
 *
 * **This reads metadata, and only metadata.** Author, committer, subject, body
 * and trailers. It never looks at repository content, because the content
 * legitimately discusses Claude Code — it is a supported integration with its
 * own skills, commands and documentation page — and a gate that could not tell
 * a product fact from an authorship claim would be unusable here.
 *
 * A real human co-author keeps their trailer. The rule is about tools.
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
 * What may not appear in commit metadata.
 *
 * Each pattern names one way the claim shows up, rather than one big
 * alternation, so a failure says which rule was broken.
 */
export const FORBIDDEN = [
  {
    rule: 'non-human co-author',
    // Any Co-Authored-By whose name or address is a tool rather than a person.
    test: /^co-authored-by:.*(claude|anthropic|copilot|cursor|codeium|chatgpt|openai|gemini|devin|noreply@)/im,
  },
  // Literal, and anywhere in the message. Not "named as the author" and not
  // "inside a trailer": a subject or body that mentions one of these at all
  // fails, including a message explaining this very rule. The exact wording
  // belongs in CONTRIBUTING.md and AGENTS.md, which is where a person reads it.
  { rule: 'vendor name', test: /claude/i },
  { rule: 'vendor name', test: /anthropic/i },
  // `\b` so an ordinary "regenerated with the new script" is left alone: the
  // boundary fails inside a longer word, and only the standalone phrase trips.
  { rule: 'generation notice', test: /\bgenerated\s+with\b/i },
  { rule: 'assistance note', test: /\bai[-\s]generated\b/i },
  { rule: 'assistance note', test: /\bai[-\s]assisted\b/i },
  { rule: 'assistance note', test: /\bwritten\s+by\s+ai\b/i },
  { rule: 'assistance note', test: /\bwith\s+the\s+help\s+of\s+(an\s+)?ai\b/i },
]

/** A `Co-Authored-By` that names a person, which is allowed and kept. */
export const HUMAN_COAUTHOR = /^co-authored-by:\s*[^<]+<[^>]+>\s*$/im

/**
 * Every rule one commit's metadata breaks, and whether a person co-authored it.
 *
 * Separated from the command so it can be exercised against messages nobody
 * has to commit first. A gate this strict is worth showing rejecting things,
 * and writing a prohibited trailer into real history to prove it would be an
 * odd way to keep a history clean.
 *
 * @param text - author, committer, subject, body and trailers of one commit.
 */
export function inspectCommit(text) {
  const broken = []
  for (const { rule, test } of FORBIDDEN) {
    if (!test.test(text)) continue
    if (broken.some(found => found.rule === rule)) continue
    broken.push({ rule, line: offending(text, test) })
  }
  return {
    problems: broken,
    // A co-author trailer that is not one of the forbidden ones is a person,
    // and counting them is how this reports that it preserved them rather than
    // stripping every trailer it saw.
    humanCoauthor: HUMAN_COAUTHOR.test(text) && !FORBIDDEN[0].test.test(text),
  }
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
    if (found.humanCoauthor) humanCoauthors += 1
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
      + '       A commit is authored by the person who made the change, and its\n'
      + '       message says what changed rather than what helped. See the\n'
      + '       Commits section of CONTRIBUTING.md.\n')
    process.exit(1)
  }

  process.stdout.write(
    `commits: ${String(commits.length)} checked over ${selected}, metadata policy clean\n`
    + `         ${String(humanCoauthors)} human co-author trailer(s) preserved\n`)
}

/** The line that tripped a rule, so a failure names something findable. */
function offending(commit, test) {
  return commit.split('\n').find(line => test.test(line))?.trim() ?? '(in the message)'
}

// Only when run, so importing the rules for a test does not audit a repository
// as a side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) main()
