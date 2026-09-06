/**
 * A tracked script may not import a file the repository does not carry.
 *
 * This exists because it happened. `scripts/doctor.mjs` was changed to import
 * `./lib/node-range.mjs`, the commit went out, and the module did not: a bare
 * `lib/` in .gitignore -- written for the per-package build output -- also
 * matched `scripts/lib/`, so `git add` skipped it with a hint that
 * scrolled past. Everything passed locally, because locally the file was
 * there. The first clean clone got
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../lib/node-range.mjs'
 *
 * from the one script whose whole job is to tell a new machine what is wrong
 * with it.
 *
 * Nothing caught it, because every check ran against a working tree rather
 * than against what was committed. This asks git what it is actually carrying.
 * It is cheap, and the failure it prevents lands on someone else's machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const tracked = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(line => line !== '')

/**
 * Relative specifiers only -- a bare specifier is a dependency, not a file here.
 *
 * `[^'";]*?` rather than `[^'"\n]*?`: a multi-line `export { a, b } from '...'`
 * is the same statement as a single-line one, and only reading the single-line
 * form is how `scripts/lib/process.mjs` passed this test for the wrong reason.
 */
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[^'";]*?from\s*['"](\.[^'"]+)['"]/g
const BARE_IMPORT = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g

/**
 * Build output a script may legitimately import: the shipped CLI's own modules.
 *
 * Two scripts do this on purpose. `scripts/lib/process.mjs` and
 * `scripts/lib/install.mjs` re-export the product's process and install
 * boundaries so the release tooling cannot grow a second, differently-correct
 * copy of either -- which is the drift that let a Windows defect ship. The
 * files they name are build output, so a clean clone genuinely does not carry
 * them, and that is acceptable only because each script checks for the built
 * file first and fails with a message naming `npm run build`, rather than with
 * a module-resolution error from three frames deeper.
 */
const BUILD_OUTPUT = /^packages[\\/]watch[\\/][^\\/]+[\\/]lib[\\/]/

test('every relative import in a tracked script resolves to a tracked file', async () => {
  const scripts = tracked(['ls-files', 'scripts'])
    .filter(path => path.endsWith('.mjs') || path.endsWith('.js'))
  assert.ok(scripts.length > 0, 'no tracked scripts found -- the query is wrong')

  const trackedSet = new Set(tracked(['ls-files']).map(path => path.split('/').join(sep)))
  const broken = []

  for (const script of scripts) {
    const absolute = join(ROOT, script)
    const source = await readFile(absolute, 'utf8')
    for (const pattern of [RELATIVE_IMPORT, BARE_IMPORT]) {
      for (const [, specifier] of source.matchAll(pattern)) {
        const target = resolve(dirname(absolute), specifier)
        const path = relative(ROOT, target)
        if (trackedSet.has(path)) continue
        if (BUILD_OUTPUT.test(path)) {
          // Allowed, but only where the script says what a clean clone must do
          // first. Without that, this is exactly the failure the file above
          // describes, wearing a different hat.
          if (!source.includes('npm run build')) {
            broken.push(
              `${script} imports the build output ${path} without telling a clean `
              + 'clone to run `npm run build` first')
          }
          continue
        }
        broken.push(
          `${script} imports "${specifier}" -> ${path}`
          + (existsSync(target)
            ? ' (present on disk, NOT tracked -- check .gitignore)'
            : ' (missing entirely)'))
      }
    }
  }

  assert.deepEqual(broken, [],
    `a clean clone would fail on these:\n  ${broken.join('\n  ')}`)
})

test('the ignore rule that caused it stays anchored', () => {
  // `git check-ignore -q` exits 0 when the path IS ignored and 1 when it is
  // not, so "not ignored" is the non-zero case and has to be read as success.
  let ignored
  try {
    execFileSync('git', ['check-ignore', '-q', 'scripts/lib'], { cwd: ROOT, stdio: 'ignore' })
    ignored = true
  } catch {
    ignored = false
  }
  assert.equal(ignored, false,
    'scripts/lib is ignored again -- source under scripts/ would silently '
    + 'miss the next commit, which is how this suite came to exist')
})
