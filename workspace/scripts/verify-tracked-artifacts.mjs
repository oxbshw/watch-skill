#!/usr/bin/env node
/**
 * Build outputs do not belong in the repository.
 *
 * This gate exists because seventeen packed tarballs were tracked under
 * `workspace/dist-artifacts/` for most of a release cycle. They were nobody's
 * decision — a pack run wrote them into the tree and a `git add .` took them
 * along — and by the time anyone looked they had become a liability rather
 * than a convenience:
 *
 * - they carried the pre-rename `@watchskill/*` scope, so the repository
 *   shipped packages under a name the product no longer publishes;
 * - their embedded source maps carried the absolute paths of the machine that
 *   built them, which is a disclosure nobody consented to;
 * - and they were stale, so anyone who installed from them got the build from
 *   whenever they were last committed rather than the one in front of them.
 *
 * Every one of those is invisible in a diff: a `.tgz` shows as "binary file
 * changed", and none of what is inside it is reviewable. That is the argument
 * for a gate rather than a rule in a document.
 *
 * Usage:
 *   node scripts/verify-tracked-artifacts.mjs
 *   node scripts/verify-tracked-artifacts.mjs --json
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const JSON_OUT = process.argv.includes('--json')

/** The npm scope this product publishes under, and the one it left behind. */
const CURRENT_SCOPE = '@deepwatch/'
const STALE_SCOPE = '@watchskill/'

/**
 * Absolute paths from a build machine, as they appear inside a bundle.
 *
 * Deliberately generic about the drive. Naming the specific ones that leaked
 * would make this gate pass on the next machine to leak one, which is the
 * opposite of what it is for.
 *
 * The separator is `{1,2}` rather than exactly one because the highest-value
 * target is a *source map*, and a source map is JSON: its separators are
 * escaped, so a real leak reads `G:\\watch-workspace\\src` on disk. Matching
 * only a single separator caught the hand-written prose and missed the
 * generated file, which is exactly backwards — nobody reviews a `.map`.
 *
 * The negative lookbehind keeps a URL out of it: `https://x` has a colon and
 * a slash where a drive path does, and only the single-character drive letter
 * tells them apart.
 */
const MACHINE_PATH =
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}(?:Users|watch-workspace|home|src|repo|build|work)[\\/]{1,2}/

/** Text files worth reading for a leaked path. A bundle is not one of them. */
const READABLE = /\.(m?[jt]sx?|json|map|md|html|css|yml|yaml)$/

/** Files a build writes, which a commit should therefore never contain. */
const GENERATED = [
  { rule: 'packed tarball', test: /\.tgz$/ },
  { rule: 'generated artifact directory', test: /(^|\/)dist-artifacts\// },
  { rule: 'build output', test: /(^|\/)(lib|dist|out)\/.*\.(js|d\.ts)$/ },
]

/**
 * Files allowed to break one named rule, and why.
 *
 * Exact path, exact rule, one reason each. Deliberately not a glob and not a
 * directory: a rule silenced across `tests/` would have hidden every real
 * leak a test fixture ever picked up, and the whole value of this gate is that
 * it fires on the file nobody was thinking about. Adding an entry here should
 * feel like more work than fixing the file, because usually it is.
 */
const EXEMPT = [
  {
    path: 'workspace/scripts/verify-tracked-artifacts.mjs',
    rule: 'stale package scope',
    why: 'this gate names the scope it forbids',
  },
  {
    path: 'workspace/scripts/verify-tracked-artifacts.mjs',
    rule: 'build-machine path',
    why: 'this gate names the path shape it forbids',
  },
  {
    path: 'workspace/scripts/verify-publishable.mjs',
    rule: 'stale package scope',
    why: 'the publishable gate refuses the old scope by name',
  },
  {
    path: 'workspace/scripts/verify-packed-contents.mjs',
    rule: 'build-machine path',
    why: 'a comment explaining which path shape that gate matches',
  },
  {
    path: 'workspace/tests/tracked-artifacts.test.mjs',
    rule: 'stale package scope',
    why: 'the counterfactual that proves this gate fires',
  },
  {
    path: 'workspace/tests/tracked-artifacts.test.mjs',
    rule: 'build-machine path',
    why: 'the counterfactual that proves this gate fires',
  },
  {
    path: 'workspace/tests/library-index.test.mjs',
    rule: 'build-machine path',
    why: 'a synthetic hostile-input path (`C:/Users/someone/...`), never a real one',
  },
  {
    path: 'workspace/tests/path-privacy.test.mjs',
    rule: 'build-machine path',
    why: 'synthetic roots the redaction tests redact; the user is `someone`',
  },
  {
    path: 'workspace/tests/process-boundary.test.mjs',
    rule: 'build-machine path',
    why: 'a synthetic profile path asserted never to reach a provider',
  },
]

/** Whether one file is excused from one rule, by exact match on both. */
function exempt(relative, rule) {
  return EXEMPT.some(entry => entry.path === relative && entry.rule === rule)
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) {
    process.stderr.write(`watch: git ${args.join(' ')} failed\n${result.stderr}\n`)
    process.exit(1)
  }
  return result.stdout
}

/** Every path git is tracking, repository-relative with forward slashes. */
function trackedFiles() {
  return git(['ls-files']).split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * Read one tracked file, or null when it is not text worth reading.
 *
 * Size-capped: a large fixture is not where a build path hides, and reading
 * every one of them turns a fast gate into a slow one nobody runs locally.
 */
function textOf(relative) {
  if (!READABLE.test(relative)) return null
  const absolute = join(ROOT, relative)
  try {
    if (statSync(absolute).size > 4 * 1024 * 1024) return null
    return readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

function main() {
  const problems = []
  const tracked = trackedFiles()

  for (const relative of tracked) {
    for (const { rule, test } of GENERATED) {
      if (test.test(relative)) problems.push({ rule, path: relative, detail: 'tracked build output' })
    }
  }

  for (const relative of tracked) {
    const text = textOf(relative)
    if (text === null) continue

    if (text.includes(STALE_SCOPE) && !exempt(relative, 'stale package scope')) {
      problems.push({
        rule: 'stale package scope',
        path: relative,
        detail: `${STALE_SCOPE} was renamed to ${CURRENT_SCOPE}`,
      })
    }
    const machine = MACHINE_PATH.exec(text)
    if (machine !== null && !exempt(relative, 'build-machine path')) {
      problems.push({
        rule: 'build-machine path',
        path: relative,
        // The matched prefix only — never the rest of the path, which is the
        // disclosive half and the reason this gate exists.
        detail: `an absolute path rooted at ${machine[0]}`,
      })
    }
  }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({
      ok: problems.length === 0, tracked: tracked.length, problems,
    }, null, 2)}\n`)
    process.exit(problems.length === 0 ? 0 : 1)
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(` FAIL  ${problem.rule}\n        ${problem.path}\n        ${problem.detail}\n`)
    }
    process.stderr.write(
      `\nwatch: ${String(problems.length)} tracked file(s) should not be in the repository.\n`
      + '       Artifacts are generated into the ignored release directory and\n'
      + '       recorded in the release manifest. See workspace/.gitignore.\n')
    process.exit(1)
  }

  process.stdout.write(
    `artifacts: ${String(tracked.length)} tracked files, no build output, `
    + 'no stale scope, no machine paths\n')
}

main()
