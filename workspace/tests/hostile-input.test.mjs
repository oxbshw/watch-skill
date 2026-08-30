/**
 * Malformed input, from every direction it can arrive.
 *
 * `security.test.mjs` covers hostile *instructions* — text that tries to talk
 * the agent into something. This file covers hostile and merely broken *data*:
 * a path that escapes its root, a record missing a field its type promises, an
 * engine that declares a gigabyte frame and sends nine bytes, a URL that reads
 * as one host and opens another.
 *
 * Every assertion here corresponds to a defect that was real. Each was found by
 * running the code rather than reading it, and each failed before its fix in
 * the way its comment describes. That distinction matters: a test written from
 * the source tends to assert what the source already does.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'
import { LibraryIndex, isWithinRoots } from '@deepwatch/dsh-library/index-store'
import { isContractUnverified } from '@deepwatch/dsh-contracts'
import { mayOpenExternally, navigationPolicy } from '@deepwatch/desktop'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOSTILE = join(HERE, 'fixtures', 'hostile-core.mjs')

/** Every shipped TypeScript source, so a rule can be held over the whole tree. */
function shipped(dir = join(HERE, '..', 'packages'), found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) shipped(path, found)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

/** Drive one request against a Core misbehaving in a named way. */
async function againstHostileCore(mode, body, spawnLog = '') {
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchCoreService, {
    transport: 'stdio',
    command: process.execPath,
    args: spawnLog === '' ? [HOSTILE, mode] : [HOSTILE, mode, spawnLog],
    autoConnect: false,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 1_500,
  })
  try {
    return await body(ctx)
  } finally {
    await fiber.dispose()
  }
}

describe('a path that tries to leave its root', () => {
  const ROOTS = ['/data/library', 'C:/data/library']

  test('a literal traversal is refused', () => {
    assert.equal(isWithinRoots('/data/library/../../etc/passwd', ROOTS), false)
    assert.equal(isWithinRoots('/data/library/sub/./../../../etc/shadow', ROOTS), false)
  })

  test('an encoded traversal is refused, at every depth of encoding', () => {
    assert.equal(isWithinRoots('/data/library/%2e%2e/secret', ROOTS), false)
    assert.equal(isWithinRoots('/data/library/%2E%2E/secret', ROOTS), false)
    assert.equal(isWithinRoots('/data/library/%252e%252e/secret', ROOTS), false)
  })

  test('literal dots joined by an encoded separator are refused', () => {
    // The one that got through. The guard looked for encoded *dots* and for
    // literal `..` segments, and `..%2f` is neither: the dots are literal and
    // the slash is encoded, so nothing matched and it read as a filename. It
    // becomes `../etc` the moment anything downstream decodes it.
    assert.equal(isWithinRoots('/data/library/..%2fetc', ROOTS), false)
    assert.equal(isWithinRoots('/data/library/..%5cetc', ROOTS), false)
  })

  test('a null byte and a sibling-prefix root are refused', () => {
    assert.equal(isWithinRoots('/data/library/a\u0000.json', ROOTS), false)
    // `/data/library-evil` starts with the root as a string and is not under it.
    assert.equal(isWithinRoots('/data/library-evil/x.json', ROOTS), false)
  })

  test('a percent sign that is not an escape is still a filename', () => {
    // `decodeURIComponent` throws on `100%.json`, which would have refused a
    // legitimate file as hostile. Only well-formed `%XX` pairs are decoded.
    assert.equal(isWithinRoots('/data/library/100%.json', ROOTS), true)
    assert.equal(isWithinRoots('/data/library/ok.json', ROOTS), true)
  })
})

describe('a record that does not match its own type', () => {
  test('a record missing fields is indexed, not thrown on', () => {
    // These records are built by walking tool output. The type says every
    // field is present; the value crossed a JSON boundary and is whatever the
    // tool actually returned. A record with no `tags` used to throw "not
    // iterable" from inside the indexer, turning one malformed record into a
    // failed index for everything else too.
    const index = new LibraryIndex()
    assert.doesNotThrow(() => { index.add({ recordId: 'a', kind: 'note', text: 'alpha' }) })
    assert.equal(index.size, 1)
    assert.equal(index.search({ text: 'alpha' }).results.length, 1)
  })

  test('a record with no id is dropped rather than indexed under ""', () => {
    const index = new LibraryIndex()
    index.add({ text: 'orphan' })
    assert.equal(index.size, 0)
  })

  test('a record id that names a prototype key pollutes nothing', () => {
    const index = new LibraryIndex()
    index.add({ recordId: '__proto__', kind: 'note', text: 'polluted' })
    index.add({ recordId: 'constructor', kind: 'note', text: 'polluted' })
    assert.equal({}.polluted, undefined)
    assert.equal(index.size, 2)
  })

  test('an oversized record is indexed without stalling', () => {
    const index = new LibraryIndex()
    const huge = 'lorem ipsum dolor '.repeat(300_000) // ~5.4 MB
    const started = Date.now()
    index.add({ recordId: 'huge', kind: 'note', text: huge })
    const elapsed = Date.now() - started
    assert.equal(index.size, 1)
    assert.ok(elapsed < 10_000, `indexing 5.4MB took ${String(elapsed)}ms`)
    assert.equal(index.search({ text: 'lorem' }).results.length, 1)
  })

  test('re-adding an id replaces it rather than doubling it', () => {
    const index = new LibraryIndex()
    index.add({ recordId: 'a', kind: 'note', text: 'alpha' })
    index.add({ recordId: 'a', kind: 'note', text: 'gamma' })
    assert.equal(index.size, 1)
    assert.equal(index.search({ text: 'alpha' }).results.length, 0, 'a stale posting survived')
    assert.equal(index.search({ text: 'gamma' }).results.length, 1)
  })
})

describe('a stored index that has been damaged', () => {
  test('every kind of damage reports corrupt, and says why', () => {
    const damaged = [
      ['not an object', null],
      ['a string', 'nope'],
      ['a version this build cannot read', { version: 99, documents: [], postings: {}, digest: 'x' }],
      ['missing postings', { version: 1, documents: [] }],
      ['a tampered digest', { version: 1, documents: [{ recordId: 'a' }], postings: {}, digest: 'wrong' }],
      ['a document that is not an object', { version: 1, documents: [42], postings: {}, digest: 'x' }],
    ]
    for (const [what, value] of damaged) {
      const index = LibraryIndex.load(value)
      assert.equal(index.health, 'corrupt', `${what} was not reported as corrupt`)
      assert.ok(index.diagnostics.length > 0, `${what} was reported with no reason`)
    }
  })

  test('a corrupt index is rebuildable, not fatal', () => {
    const index = LibraryIndex.load({ version: 1, documents: [], postings: {}, digest: 'wrong' })
    assert.equal(index.health, 'corrupt')
    index.add({ recordId: 'a', kind: 'note', text: 'rebuilt' })
    assert.equal(index.health, 'ready')
    assert.equal(index.search({ text: 'rebuilt' }).results.length, 1)
  })

  test('an undamaged index round-trips', () => {
    const original = new LibraryIndex()
    original.add({ recordId: 'a', kind: 'note', text: 'gamma delta' })
    const loaded = LibraryIndex.load(JSON.parse(JSON.stringify(original.serialize())))
    assert.equal(loaded.health, 'ready')
    assert.equal(loaded.search({ text: 'gamma' }).results.length, 1)
  })
})

describe('an engine that does not speak the protocol', () => {
  test('a handshake missing its digests degrades instead of throwing', async () => {
    // `Object.keys(undefined)` threw a TypeError straight out of `connect()`,
    // which is the one path that must always produce a structured answer. The
    // "published no digests" case was already handled — for an empty map, not
    // for an absent one.
    assert.equal(isContractUnverified(undefined), true)
    assert.equal(isContractUnverified(null), true)
    assert.equal(isContractUnverified({}), true)
    assert.equal(isContractUnverified({ evidence: 'abc' }), false)

    await againstHostileCore('none', async (ctx) => {
      const connected = await ctx.watchCore.connect()
      assert.equal(connected.ok, true, 'a Core omitting schemaDigests must still connect')
      const reply = await ctx.watchCore.request('anything', {})
      assert.equal(reply.ok, true)
    })
  })

  test('a body that is not JSON is named, not waited out', async () => {
    // This reported `bridge.deadline_exceeded` after the full request timeout,
    // because `fail()` notified its listeners and left every in-flight request
    // to expire. "Slow" sends someone to look at load and networking; the truth
    // is that the two sides cannot talk, and waiting will never fix it.
    await againstHostileCore('garbage', async (ctx) => {
      await ctx.watchCore.connect()
      const started = Date.now()
      const reply = await ctx.watchCore.request('fixture.echo', {})
      assert.equal(reply.ok, false)
      assert.equal(reply.error.error, 'bridge.protocol_violation')
      assert.ok(Date.now() - started < 1_000, 'the caller waited out a deadline for a known failure')
    })
  })

  test('a frame with no Content-Length is named, not waited out', async () => {
    await againstHostileCore('no-header', async (ctx) => {
      await ctx.watchCore.connect()
      const reply = await ctx.watchCore.request('fixture.echo', {})
      assert.equal(reply.ok, false)
      assert.equal(reply.error.error, 'bridge.protocol_violation')
    })
  })

  test('an absurd Content-Length is refused rather than awaited forever', async () => {
    // A declared gigabyte with nine bytes behind it parked the reader for good.
    // It correctly waited for a body that never came, every request behind it
    // expired, and nothing ever said why. No further byte can make a frame that
    // size legitimate, so waiting only hides the reason.
    await againstHostileCore('huge-frame', async (ctx) => {
      await ctx.watchCore.connect()
      const started = Date.now()
      const reply = await ctx.watchCore.request('fixture.echo', {})
      assert.equal(reply.ok, false)
      assert.equal(reply.error.error, 'bridge.protocol_violation')
      assert.ok(Date.now() - started < 1_000)
    })
  })

  test('a later request gets the reason, not another deadline', async () => {
    // A frame stream cannot be resynchronized by guessing where the next frame
    // begins, so a later request must come back with the same reason rather
    // than spending a second deadline rediscovering it.
    //
    // The bound is stated against the request timeout rather than as a small
    // fixed number: what is asserted is that the caller is answered rather than
    // left to time out.
    //
    // The answer now comes from the reconnect breaker. A protocol violation is
    // non-retryable, so the circuit opens on the first one and the second
    // request is refused with `bridge.unavailable` and a retry time instead of
    // being sent to an engine that cannot read it.
    const REQUEST_TIMEOUT_MS = 1_500
    await againstHostileCore('garbage', async (ctx) => {
      await ctx.watchCore.connect()
      const first = await ctx.watchCore.request('fixture.echo', {})
      assert.equal(first.error.error, 'bridge.protocol_violation')

      const started = Date.now()
      const again = await ctx.watchCore.request('fixture.echo', {})
      const elapsed = Date.now() - started
      assert.equal(again.error.error, 'bridge.unavailable')
      assert.ok(again.error.details.retryAfterMs > 0)
      assert.ok(elapsed < REQUEST_TIMEOUT_MS,
        `the second request took ${String(elapsed)}ms, which is its full deadline`)
    })
  })

  test('a duplicate reply is ignored and the transport survives', async () => {
    await againstHostileCore('duplicate', async (ctx) => {
      await ctx.watchCore.connect()
      const reply = await ctx.watchCore.request('fixture.echo', {})
      assert.equal(reply.ok, true)
      assert.equal(reply.value.which, 'first', 'the second reply overwrote the first')
      const after = await ctx.watchCore.request('fixture.echo', {})
      assert.equal(after.ok, true, 'a duplicate reply left the transport unusable')
    })
  })

  test('a reply to an id nobody sent is dropped', async () => {
    await againstHostileCore('unknown-id', async (ctx) => {
      await ctx.watchCore.connect()
      const reply = await ctx.watchCore.request('fixture.echo', {})
      assert.equal(reply.ok, true)
      assert.equal(reply.value.which, 'real')
    })
  })

  test('an engine that fails on contact leaves no process behind', async () => {
    // The worst of the defects here, and one only a running system shows.
    //
    // A request made while the Bridge is not ready reconnects, and reconnecting
    // replaced `this.transport` without disposing what was there. Against an
    // engine that fails on contact, every request therefore started another
    // Watch Core and abandoned it — five requests, five live orphans, with the
    // teardown effect only ever holding the newest. It stayed hidden while a
    // failure took a full deadline to surface; making failures immediate is
    // what made it fire on every call.
    //
    // Reconnecting per request is the existing policy and is not what this
    // asserts. What must hold is that none of those attempts outlives the
    // Bridge: every pid the fixture recorded is gone once the fiber is
    // disposed.
    const log = join(mkdtempSync(join(tmpdir(), 'watch-spawn-')), 'spawns.txt')
    writeFileSync(log, '')
    await againstHostileCore('garbage', async (ctx) => {
      await ctx.watchCore.connect()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await ctx.watchCore.request('fixture.echo', {})
      }
    }, log)

    const pids = readFileSync(log, 'utf8').split('\n').filter(line => line !== '').map(Number)
    assert.ok(pids.length >= 1, 'the fixture never started')
    const alive = pids.filter((pid) => {
      // Signal 0 tests for existence without delivering anything.
      try { process.kill(pid, 0); return true } catch { return false }
    })
    assert.deepEqual(alive, [], `${String(alive.length)} of ${String(pids.length)} Watch Core process(es) outlived the Bridge`)
  })

  test('an event flood does not lose the reply behind it', async () => {
    await againstHostileCore('event-flood', async (ctx) => {
      await ctx.watchCore.connect()
      const reply = await ctx.watchCore.request('fixture.echo', {})
      assert.equal(reply.ok, true)
      assert.equal(reply.value.flooded, 200)
    })
  })
})

describe('a URL that is not what it looks like', () => {
  const policy = navigationPolicy('http://127.0.0.1:5173')

  test('only https opens externally', () => {
    assert.equal(mayOpenExternally('https://example.com/docs', policy), true)
    for (const url of [
      'javascript:alert(1)',
      'jAvAsCrIpT:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///C:/Windows/System32/cmd.exe',
      'vbscript:msgbox(1)',
      'about:blank',
      'ms-msdt:/id',
      'http://example.com/docs',
    ]) assert.equal(mayOpenExternally(url, policy), false, `${url} was allowed`)
  })

  test('loopback is refused, so the app cannot be talked into opening itself', () => {
    for (const url of [
      'http://localhost:5173/steal',
      'http://127.0.0.1:5173/steal',
      'http://[::1]:5173/steal',
    ]) assert.equal(mayOpenExternally(url, policy), false, `${url} was allowed`)
  })

  test('a URL carrying credentials is refused', () => {
    // `https://example.com@evil.com` reads left-to-right as example.com and
    // resolves to the host `evil.com` with `example.com` as the username — the
    // oldest look-alike there is, and precisely the gap between what was
    // displayed and what happened that this product exists to close.
    assert.equal(new URL('https://example.com@evil.com').hostname, 'evil.com')
    assert.equal(mayOpenExternally('https://example.com@evil.com', policy), false)
    // And credentials leak to whoever is really on the other end.
    assert.equal(mayOpenExternally('https://user:pass@example.com/', policy), false)
  })

  test('a hostname that merely contains an address is not loopback', () => {
    // Refusing this would be the mirror-image bug: a real external host
    // blocked because its name happens to have an address inside it.
    assert.equal(mayOpenExternally('https://127.0.0.1.evil.com/', policy), true)
  })
})

describe('markup in a record has nowhere to render', () => {
  test('nothing in the shipped tree writes HTML from a value', () => {
    // The strongest available guarantee against a record that contains HTML is
    // that no surface would render it. Held over the whole tree rather than
    // over the files this test happens to name, so a new one cannot be added
    // quietly.
    const offenders = []
    for (const file of shipped()) {
      const source = readFileSync(file, 'utf8')
      if (/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/.test(source)) {
        offenders.push(file.slice(file.indexOf('packages')))
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('a record full of markup indexes and searches as text', () => {
    const index = new LibraryIndex()
    index.add({
      recordId: 'x',
      kind: 'note',
      text: '<script>alert(1)</script> <img src=x onerror=alert(1)>',
    })
    const found = index.search({ text: 'script' })
    assert.equal(found.results.length, 1)
    // It comes back as data — an id, and the matched text carried verbatim.
    // Nothing along the way reassembles those tokens into markup.
    assert.equal(found.results[0].sourceId, 'x')
    assert.equal(found.results[0].hits[0].text, '<script>alert(1)</script> <img src=x onerror=alert(1)>')
  })
})
