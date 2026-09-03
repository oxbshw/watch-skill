/**
 * The engine's startup backstop must outlast a first cold start.
 *
 * This is not a preference about latency. The backstop exists to notice an
 * engine that cannot answer *at all*, and at ten seconds it could not tell
 * that apart from an engine starting for the first time.
 *
 * Observed on a clean Windows machine, in the offline acceptance run: a fresh
 * `deepwatch setup` created the Core virtualenv, the first `watch-skill
 * bridge` paid for a cold Python import of thousands of files a security
 * scanner had never seen, and the handshake missed the ten-second deadline.
 * The product then reported exactly what it had measured — Watch Core
 * `failed`, blocker `core_timeout`, contract `Unverified`, last handshake
 * `Never` — the reconnect breaker opened, and the session never recovered.
 * The same profile connected in under three seconds on its next start, and
 * the packed Bridge integration passed 24/24 against that very binary.
 *
 * So the installation was healthy and the product called it dead. A generous
 * backstop costs nothing when the engine is well, because the handshake
 * resolves the moment it lands; it is paid only when the engine is genuinely
 * gone, which is already a degraded case.
 *
 * Every composed profile is checked, not just the default one: the variants
 * are what a `--profile browser` or `--profile memory` install actually gets,
 * and one left behind at ten seconds is one product still calling a healthy
 * first run a failure.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'packages', 'watch', 'bundle')

/**
 * The floor, with the measurement behind it.
 *
 * A first cold start was observed past ten seconds and the second start of the
 * same profile was under three. The floor is set well above the failure rather
 * than just above it, because the machine that suffers this is by definition
 * the slow one.
 */
const MINIMUM_STARTUP_MS = 30_000

/** Every composed patch a profile can be built from. */
function patches() {
  const found = [{
    name: 'cordis.patch.yml',
    text: readFileSync(join(BUNDLE, 'cordis.patch.yml'), 'utf8'),
  }]
  const variants = join(BUNDLE, 'variants')
  for (const name of readdirSync(variants)) {
    if (!name.endsWith('.yml')) continue
    found.push({ name: `variants/${name}`, text: readFileSync(join(variants, name), 'utf8') })
  }
  return found
}

/** Declared values only — a commented example is documentation, not config. */
function declaredStartups(text) {
  return [...text.matchAll(/^\s*startupTimeoutMs:\s*(\d+)/gm)].map(m => Number(m[1]))
}

describe('a first cold start is not reported as a dead engine', () => {
  const all = patches()

  test('the sweep found the patches it is about', () => {
    // A glob that matched nothing would pass every assertion below.
    assert.ok(all.length >= 4, `only ${String(all.length)} patch files found`)
    assert.ok(all.some(p => p.name === 'cordis.patch.yml'))
    assert.ok(all.some(p => p.name.startsWith('variants/')))
  })

  for (const patch of patches()) {
    test(`${patch.name} gives the engine room to start`, () => {
      const declared = declaredStartups(patch.text)
      assert.ok(declared.length > 0, `${patch.name} declares no startupTimeoutMs`)
      for (const value of declared) {
        assert.ok(value >= MINIMUM_STARTUP_MS,
          `${patch.name} allows ${String(value)}ms, which a first cold start on a `
          + 'clean Windows machine has already exceeded; the engine was healthy '
          + 'and the product reported core_timeout');
      }
    })
  }

  test('the commented example does not teach the value that failed', () => {
    // The block comment above the live config is what a reader copies when
    // they write their own patch, so it must not hand them the ten seconds
    // this test exists to prevent.
    const text = readFileSync(join(BUNDLE, 'cordis.patch.yml'), 'utf8')
    const commented = [...text.matchAll(/^\s*#\s*startupTimeoutMs:\s*(\d+)/gm)]
      .map(m => Number(m[1]))
    for (const value of commented) {
      assert.ok(value >= MINIMUM_STARTUP_MS,
        `the example in cordis.patch.yml still shows ${String(value)}ms`)
    }
  })

  test('the schema default is what an omitted key inherits, and it is generous', () => {
    // The core-bin override deliberately omits the timeouts so the bundle's
    // value governs. A Loader patch replaces the row's whole config, so what
    // actually applies is the service schema default — which therefore has to
    // be the same generous budget, or omitting the key would quietly restore
    // the ten seconds this file exists to prevent.
    const service = readFileSync(
      join(ROOT, 'packages', 'watch', 'core-bridge', 'src', 'index.ts'), 'utf8')
    const declared = /startupTimeoutMs:\s*s\.number\(\)[^\n]*?default\((\d[\d_]*)\)/
      .exec(service)?.[1]
    assert.ok(declared !== undefined, 'the service schema declares no startup default')
    const value = Number(declared.replace(/_/g, ''))
    assert.ok(value >= MINIMUM_STARTUP_MS,
      `the schema default is ${String(value)}ms, so a config that omits the key `
      + 'inherits a budget a first cold start has already exceeded')
  })

  test('the documented default matches what is composed', () => {
    const readme = readFileSync(join(BUNDLE, 'README.md'), 'utf8')
    const row = /\|\s*`startupTimeoutMs`\s*\|\s*`(\d+)`/.exec(readme)
    assert.ok(row !== null, 'the bundle README does not document startupTimeoutMs')
    const documented = Number(row[1])
    assert.ok(documented >= MINIMUM_STARTUP_MS,
      `the README still documents ${String(documented)}ms`)

    const composed = declaredStartups(
      readFileSync(join(BUNDLE, 'cordis.patch.yml'), 'utf8'))
    assert.equal(documented, composed[0],
      'the README and the composed patch disagree about the startup backstop')
  })
})
