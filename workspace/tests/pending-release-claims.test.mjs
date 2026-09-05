/**
 * No page tells a visitor to install something that is not published.
 *
 * The README's first instruction was `npm install -g @deepwatch/cli`, written
 * plainly, with an npm version badge above it. Nothing exists under the
 * `@deepwatch` scope — the twenty packages are published for the first time by
 * the `deepwatch-v0.1.0` tag — so the first thing a visitor did was run a
 * command that resolves nothing, on the page that was supposed to introduce
 * the product.
 *
 * The repository already knew. `workspace/docs/getting-started.md` says the
 * packages are not published and that `npx @deepwatch/cli` must not be used,
 * and `docs/releasing.md` states it as a rule: *no document in this repository
 * may say it does*. The README disagreed with both, and nothing checked.
 *
 * So this is the check. Every registry install command naming the `@deepwatch`
 * scope has to sit under a statement that it is pending a release. Not a
 * disclaimer at the bottom of the page — within a dozen lines, where somebody
 * about to copy the command will read it.
 *
 * The rule is deliberately about *this* scope and *this* moment. When the
 * first publication happens, these markers come out, and the failure of this
 * test is the reminder to take them out.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(WORKSPACE, '..')

/**
 * How far above a command a reader is credited with looking.
 *
 * Twelve lines is a fenced block plus the paragraph over it. Further than
 * that and the note is on a different subject; nearer and a legitimate
 * callout with a blank line and a heading between it and the block fails.
 */
const NEARBY_LINES = 12

/** A command that asks a registry for a `@deepwatch` package. */
const INSTALL = /(?:npm\s+(?:install|i|exec)|npx|pnpm\s+(?:add|dlx)|yarn\s+(?:add|dlx)|bun\s+(?:add|x)|dsh\s+plugin\b[^\n]*\badd)\b[^\n]*@deepwatch\//

/** The claim that makes such a command honest today. */
const PENDING = /not on npm yet|not published yet|are not published|pending the deepwatch-v|first publication|has never published|never published/i

/** Documentation, as the release-surface gate defines it, minus its history. */
function documents() {
  const result = spawnSync('git', ['ls-files', '*.md'], { cwd: REPO, encoding: 'utf8' })
  assert.equal(result.status, 0, 'git ls-files failed')
  return result.stdout.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    // History is a record of what was true then, and rewriting it to satisfy
    // a rule about now is how a repository loses the ability to say what it
    // used to believe.
    .filter(line => !line.includes('/history/') && !line.includes('/adr/'))
    // The changelog quotes past releases by version, including the ones that
    // did exist under other names.
    .filter(line => !line.endsWith('CHANGELOG.md'))
    .filter(line => !line.endsWith('tests/pending-release-claims.test.mjs'))
}

describe('an unpublished package is never presented as installable', () => {
  test('every @deepwatch install command is marked pending, near enough to read', () => {
    const offenders = []
    for (const relative of documents()) {
      const lines = readFileSync(join(REPO, relative), 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (!INSTALL.test(line)) return
        // A line that is itself saying the command does not work. These read
        // naturally in several shapes -- "there is no `npx @deepwatch/cli`",
        // "`npx @deepwatch/cli` does not work today" -- and a rule that only
        // recognised one of them would flag the very sentences it exists to
        // require.
        if (PENDING.test(line)) return
        if (/\b(?:do not|does not|cannot|must not|there is no|never)\b/i.test(line)) return
        const context = lines.slice(Math.max(0, index - NEARBY_LINES), index + 1).join('\n')
        if (PENDING.test(context)) return
        offenders.push(`${relative}:${String(index + 1)}: ${line.trim()}`)
      })
    }
    assert.deepEqual(offenders, [],
      'these tell a visitor to install a package that does not exist yet')
  })

  test('the README says it in both halves, because it has two entry paths', () => {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    assert.match(readme, /\*\*Not on npm yet\.\*\*/)
    assert.match(readme, /deepwatch-v0\.1\.0/)
    // And the other train, which is the opposite mistake: `watch-skill` *is*
    // published, so the honest note is which version a visitor actually gets.
    assert.match(readme, /\*\*On PyPI, one version behind\.\*\*/)
    assert.match(readme, /core-v1\.4\.0/)
  })

  test('the working path today is named, not just the pending one', () => {
    // A warning with no alternative reads as "come back later", and the
    // alternative exists: the candidate builds and serves from this checkout.
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    const at = readme.indexOf('**Not on npm yet.**')
    assert.notEqual(at, -1)
    const callout = readme.slice(at, at + 600)
    assert.match(callout, /workspace\/docs\/getting-started\.md/)
  })

  test('the rule the release guide states is the rule the pages follow', () => {
    const releasing = readFileSync(join(WORKSPACE, 'docs', 'releasing.md'), 'utf8')
    assert.match(releasing, /no document in this repository may\s*\n?\s*say it does/)
    const started = readFileSync(join(WORKSPACE, 'docs', 'getting-started.md'), 'utf8')
    assert.match(started, /packages are not published yet/)
  })
})
