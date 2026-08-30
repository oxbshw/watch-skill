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
const FORBIDDEN = [
  {
    rule: 'assistant co-author',
    // Any Co-Authored-By whose name or address is a tool rather than a person.
    test: /^co-authored-by:.*(claude|anthropic|copilot|cursor|codeium|chatgpt|openai|gemini|devin|noreply@anthropic)/im,
  },
  { rule: 'generated-with line', test: /generated\s+with/i },
  { rule: 'AI-assistance note', test: /\b(ai[- ]generated|ai[- ]assisted|written\s+by\s+ai|with\s+the\s+help\s+of\s+(an\s+)?ai)\b/i },
  { rule: 'assistant named as the author', test: /^author:\s*(claude|anthropic|copilot|cursor)/im },
  { rule: 'assistant named as the committer', test: /^committer:\s*(claude|anthropic|copilot|cursor)/im },
]

/** A `Co-Authored-By` that names a person, which is allowed and kept. */
const HUMAN_COAUTHOR = /^co-authored-by:\s*[^<]+<[^>]+>\s*$/im

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    process.stderr.write(`watch: git ${args.join(' ')} failed\n${result.stderr}`)
    process.exit(1)
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
  return base === undefined ? 'HEAD~20..HEAD' : `${base}..HEAD`
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
    for (const { rule, test } of FORBIDDEN) {
      if (test.test(commit)) {
        problems.push({ sha: sha.slice(0, 8), rule, line: offending(commit, test) })
      }
    }
    // A co-author trailer that is not one of the forbidden ones is a person,
    // and counting them is how this reports that it preserved them rather than
    // stripping every trailer it saw.
    if (HUMAN_COAUTHOR.test(commit) && !FORBIDDEN[0].test.test(commit)) humanCoauthors += 1
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
      `\nwatch: ${String(problems.length)} commit(s) carry assistant attribution.\n`
      + '       A commit is authored by the person who made the change. See the\n'
      + '       Commits section of CONTRIBUTING.md.\n')
    process.exit(1)
  }

  process.stdout.write(
    `commits: ${String(commits.length)} checked over ${selected}, no assistant attribution\n`
    + `         ${String(humanCoauthors)} human co-author trailer(s) preserved\n`)
}

/** The line that tripped a rule, so a failure names something findable. */
function offending(commit, test) {
  return commit.split('\n').find(line => test.test(line))?.trim() ?? '(in the message)'
}

main()
