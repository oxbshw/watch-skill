/**
 * No page tells a visitor to install something that is not published, and no
 * page tells a visitor something is unpublished once it is.
 *
 * The README's first instruction was `npm install -g @deepwatch/cli`, written
 * plainly, with an npm version badge above it. Nothing existed under the
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
 * So this is the check — and it has two halves, because a release train has
 * two ways to lie about a registry and this file was written knowing only one
 * of them.
 *
 * **Before publication**, every registry install command naming the
 * `@deepwatch` scope has to sit under a statement that it is pending. Not a
 * disclaimer at the bottom of the page — within a dozen lines, where somebody
 * about to copy the command will read it.
 *
 * **After publication**, the same markers become the lie. A page still saying
 * "not on npm yet" about a scope that is live sends a reader to a checkout
 * build they do not need, and it is exactly the kind of sentence nobody
 * re-reads. So the rule inverts on one switch: `deepwatch.registryStatus` in
 * the workspace manifest, which is also what `gen-package-docs.mjs` reads.
 *
 * The same mistake has a second shape, and Watch Skill made it. `watch-skill`
 * *is* published, so its honest note was never "pending" but "which version
 * you actually get" — and the moment `core-v1.4.0` reached PyPI, three pages
 * went on saying the newest release was 1.2.0. A currency claim about a
 * registry is a fact with an expiry date, and the last test here is what
 * notices when one expires.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(WORKSPACE, '..')

/** The one switch. `unpublished` while the scope is empty, `published` after. */
const REGISTRY_STATUS
  = JSON.parse(readFileSync(join(WORKSPACE, 'package.json'), 'utf8'))
    .deepwatch?.registryStatus ?? 'published'

/** The Core version this repository declares, which is what PyPI should hold. */
function declaredCoreVersion() {
  const text = readFileSync(join(REPO, 'pyproject.toml'), 'utf8')
  const match = /^version\s*=\s*"([^"]+)"/m.exec(text)
  assert.notEqual(match, null, 'pyproject.toml declares no version')
  return match[1]
}

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

/**
 * The claim that makes such a command honest before publication.
 *
 * Phrased loosely on purpose. The first version of this list enumerated the
 * exact sentences the README used, and then failed on
 * `npm install -g @deepwatch/cli@latest      # pending the first release` --
 * a line that says the thing this rule exists to require, in words the rule
 * had not been told about. A guard against dishonest documentation should not
 * also be a style guide for how to be honest.
 */
const PENDING = /not on npm yet|not published yet|are not published|pending[^\n]{0,40}release|first publication|has never published|never published|does not exist yet|nothing exists under/i

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

/** A line that is itself saying the command does not work. */
function disclaims(line) {
  if (PENDING.test(line)) return true
  return /\b(?:do not|does not|cannot|must not|there is no|never)\b/i.test(line)
}

describe('an unpublished package is never presented as installable', {
  skip: REGISTRY_STATUS === 'published'
    ? 'the @deepwatch scope is published; the inverse rule applies'
    : false,
}, () => {
  test('every @deepwatch install command is marked pending, near enough to read', () => {
    const offenders = []
    for (const relative of documents()) {
      const lines = readFileSync(join(REPO, relative), 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (!INSTALL.test(line)) return
        // These read naturally in several shapes -- "there is no
        // `npx @deepwatch/cli`", "`npx @deepwatch/cli` does not work today" --
        // and a rule that only recognised one of them would flag the very
        // sentences it exists to require.
        if (disclaims(line)) return
        const context = lines.slice(Math.max(0, index - NEARBY_LINES), index + 1).join('\n')
        if (PENDING.test(context)) return
        offenders.push(`${relative}:${String(index + 1)}: ${line.trim()}`)
      })
    }
    assert.deepEqual(offenders, [],
      'these tell a visitor to install a package that does not exist yet')
  })

  test('the README says it where the npm entry path is', () => {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    assert.match(readme, /\*\*Not on npm yet\.\*\*/)
    assert.match(readme, /deepwatch-v0\.1\.0/)
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

describe('a published package is never presented as pending', {
  skip: REGISTRY_STATUS === 'unpublished'
    ? 'the @deepwatch scope is still empty; the pending rule applies'
    : false,
}, () => {
  test('no page still says the @deepwatch scope holds nothing', () => {
    const offenders = []
    for (const relative of documents()) {
      const lines = readFileSync(join(REPO, relative), 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (!/@deepwatch|DeepWatch/.test(line)) return
        if (!PENDING.test(line)) return
        offenders.push(`${relative}:${String(index + 1)}: ${line.trim()}`)
      })
    }
    assert.deepEqual(offenders, [],
      'the scope is published; these still tell a reader it is not')
  })

  test('the README shows the install command with no pending caveat over it', () => {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    assert.match(readme, /npm install -g @deepwatch\/cli/)
    assert.doesNotMatch(readme, /\*\*Not on npm yet\.\*\*/)
  })
})

describe('a currency claim about a registry has an expiry date', () => {
  /**
   * Sentences that say what a registry holds *now*.
   *
   * Not every version number in a document is a claim about the present. A
   * changelog entry, a compatibility range and an upgrade example all name
   * old versions legitimately. What expires is the shape "the newest
   * published version is X" -- so that shape is what is matched, and a line
   * that marks itself as a past observation ("on 2026-09-05 it was") is left
   * alone.
   */
  const CURRENCY = /\b(?:newest|latest|current)\b[^.\n]{0,60}\b(?:publish|release|on PyPI)/i
  const HISTORICAL = /\bon 20\d\d-\d\d-\d\d\b|\bat the time\b|\bused to\b|\bwas\b/i
  const SEMVER = /\b(\d+)\.(\d+)\.(\d+)(rc|a|b|\.dev)?\d*\b/g

  function older(version, than) {
    const left = version.split('.').map(Number)
    const right = than.split('.').map(Number)
    for (let at = 0; at < 3; at += 1) {
      if (left[at] !== right[at]) return left[at] < right[at]
    }
    return false
  }

  test('no page says PyPI holds a Watch Skill older than the one declared here', () => {
    const declared = declaredCoreVersion()
    const offenders = []
    for (const relative of documents()) {
      const text = readFileSync(join(REPO, relative), 'utf8')
      // Sentences, not lines: these claims wrap, and half of one reads as
      // neither a currency claim nor a version.
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        if (!CURRENCY.test(sentence)) continue
        if (HISTORICAL.test(sentence)) continue
        if (!/watch-skill|PyPI/i.test(sentence)) continue
        for (const match of sentence.matchAll(SEMVER)) {
          // A prerelease is never the answer to "what does `pip install` give
          // you", so naming one is not a currency claim about the stable line.
          if (match[4] !== undefined) continue
          const found = `${match[1]}.${match[2]}.${match[3]}`
          if (older(found, declared)) {
            offenders.push(`${relative}: names ${found} where ${declared} is published`)
          }
        }
      }
    }
    assert.deepEqual(offenders, [],
      `PyPI holds watch-skill ${declared}; these pages still name an older release as current`)
  })
})
