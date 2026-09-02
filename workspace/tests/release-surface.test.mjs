/**
 * The release-surface gate, and proof that it fails.
 *
 * A scanner with no positive control is a scanner nobody has checked. This one
 * is especially easy to get wrong in the direction of silence: a bad glob
 * matches nothing, an over-eager exemption swallows a whole directory, and
 * either way the gate reports success over an empty set. Two of the rules here
 * exist because exactly that happened to a different check in this repository
 * — it read the single-line form of a statement only, and passed for a year
 * for the wrong reason.
 *
 * So: every rule is fired at text that must trip it, the surface list is
 * checked for actually matching files, and the exemptions are held to being
 * one file and one rule with a reason.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')
const CONFIG = JSON.parse(readFileSync(join(REPO, 'release-surface-rules.json'), 'utf8'))

/** Text that each rule must catch, and text it must leave alone. */
const CONTROLS = {
  'unresolved-template-token': {
    catches: 'Watch Skill in {{AGENT_NAME}}',
    allows: 'Use `${version}` in the shell, or <version> in prose.',
  },
  'unfinished-marker': {
    catches: 'TODO: write the rest of this page',
    allows: 'The todos list is stored in memory.',
  },
  'unfinished-claim': {
    catches: 'Desktop support is coming soon.',
    allows: 'Desktop is supported on Windows, macOS and Linux.',
  },
  'stale-npm-scope': {
    catches: 'npm install @watchskill/cli',
    allows: 'npm install @deepwatch/cli',
  },
  'phantom-repository': {
    catches: 'Clone watch-workspace and run pnpm install.',
    allows: 'Clone watch-skill and run pnpm install in workspace/.',
  },
  'personal-path': {
    catches: 'uv --directory C:\\Users\\sam\\watch-skill run watch-skill serve',
    allows: 'uv --directory <watch-skill-checkout> run watch-skill serve',
  },
  'maintainer-drive': {
    catches: 'The fixtures live in G:/watch-manual.',
    allows: 'The fixtures live in the directory WATCH_MANUAL_ROOT names.',
  },
  'unfilled-path-metavariable': {
    catches: 'pi --skills-dir C:\\path\\to\\watch-skill\\skills',
    allows: 'pi --skills-dir <watch-skill-checkout>/skills',
  },
  'obsolete-package-count': {
    catches: 'The distribution is 17 packages.',
    allows: 'The distribution is 20 packages.',
  },
  'hardcoded-readiness': {
    catches: '4 of 12 capabilities are ready.',
    allows: 'Readiness is read from the running installation.',
  },
  'temporary-machine-state': {
    catches: 'Both apps are running now, so open the browser.',
    allows: 'Start both apps, then open the browser.',
  },
}

const rules = new Map(CONFIG.rules.map(rule => [rule.id, rule]))

describe('every rule catches what it is for', () => {
  test('the control table covers every rule, and only real rules', () => {
    // A rule added without a control is a rule nobody has fired.
    assert.deepEqual(
      Object.keys(CONTROLS).sort(),
      CONFIG.rules.map(rule => rule.id).sort(),
    )
  })

  for (const [id, control] of Object.entries(CONTROLS)) {
    test(`${id} fires, and does not fire on the corrected text`, () => {
      const rule = rules.get(id)
      assert.ok(rule !== undefined, `${id} is not in the rules table`)
      const pattern = new RegExp(rule.pattern)
      assert.ok(pattern.test(control.catches),
        `${id} does not catch: ${control.catches}`)
      assert.equal(pattern.test(control.allows), false,
        `${id} fires on text that is correct: ${control.allows}`)
    })
  }
})

describe('the gate fails on a file that breaks a rule', () => {
  test('a planted document is reported, with its file, line and rule', () => {
    // The end-to-end control: not "does the regex match" but "does the gate
    // notice a file". A glob that matches nothing would pass every test above.
    const room = mkdtempSync(join(tmpdir(), 'deepwatch-surface-'))
    try {
      const planted = join(REPO, 'docs', 'release-surface-control.md')
      writeFileSync(planted,
        '# Control\n\nThis page is 17 packages and coming soon.\n', 'utf8')
      let output
      let status = 0
      try {
        output = execFileSync(
          process.execPath, [join(ROOT, 'scripts', 'verify-release-surface.mjs'), '--json'],
          { cwd: ROOT, encoding: 'utf8' })
      } catch (error) {
        status = error.status
        output = error.stdout
      } finally {
        rmSync(planted, { force: true })
      }

      assert.equal(status, 1, 'the gate passed with a planted document in place')
      const result = JSON.parse(output)
      assert.equal(result.ok, false)
      const found = result.findings.filter(
        finding => finding.file === 'docs/release-surface-control.md')
      assert.deepEqual(found.map(finding => finding.rule).sort(),
        ['obsolete-package-count', 'unfinished-claim'])
      assert.ok(found.every(finding => finding.line === 3), 'the line number is wrong')
    } finally {
      rmSync(room, { recursive: true, force: true })
    }
  })

  test('and passes on the tree as it stands', () => {
    const output = execFileSync(
      process.execPath, [join(ROOT, 'scripts', 'verify-release-surface.mjs'), '--json'],
      { cwd: ROOT, encoding: 'utf8' })
    const result = JSON.parse(output)
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2))
    assert.ok(result.scanned.documents > 100, 'the surface list matched almost nothing')
    assert.ok(result.scanned.descriptions >= 20)
  })
})

describe('the exemptions stay narrow', () => {
  test('each names one exact file, one rule, and a reason', () => {
    for (const exemption of CONFIG.exemptions) {
      assert.equal(typeof exemption.file, 'string')
      assert.equal(typeof exemption.rule, 'string')
      assert.ok(typeof exemption.why === 'string' && exemption.why.length > 20,
        `${exemption.file} is exempt from ${exemption.rule} for no stated reason`)
      assert.ok(rules.has(exemption.rule), `${exemption.rule} is not a rule`)
      assert.equal(exemption.file.includes('*'), false,
        'an exemption may not be a glob; that is how a directory gets excused')
    }
  })

  test('no exemption is for a file that does not exist', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 })
        .split('\n').map(line => line.trim()).filter(line => line !== ''))
    for (const exemption of CONFIG.exemptions) {
      assert.ok(tracked.has(exemption.file),
        `${exemption.file} is exempt and not in the repository`)
    }
  })

  test('the excluded surfaces are history and generated evidence, by name', () => {
    for (const glob of CONFIG.surfaces.exclude) {
      assert.ok(
        glob.includes('history') || glob.includes('adr') || glob.endsWith('.json'),
        `${glob} excludes something that is not history or a generated artifact`)
    }
  })
})
