/**
 * The Library index, held to the properties that make a derived index safe.
 *
 * The store is the source of truth and this is derived, so the interesting
 * questions are all about what happens when the two disagree: a record changes,
 * a record is deleted, a build is interrupted, the serialised form is damaged,
 * or somebody types something that is not a search term at all.
 *
 * Every case below is one of those, and each has a specific way of failing
 * quietly if it is wrong — a deleted record that still returns, a changed
 * record that returns its old text, an index that half-loads and answers
 * confidently from a truncated file.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INDEX_VERSION, LibraryIndex, MAX_LIMIT, isWithinRoots, snippetFor, tokenize,
} from '@watchskill/dsh-library'

/** A record with sensible defaults, so each test states only what it varies. */
const record = (over = {}) => ({
  recordId: 'r1',
  revisionId: 'r1@1',
  title: 'Installer walkthrough',
  kind: 'video',
  text: 'The installer reported error 0x80070643 during the update step.',
  source: 'demo://fixtures/installer',
  runId: 'run-1',
  observedAt: '2026-08-01T10:00:00.000Z',
  verdict: 'VERIFIED',
  tags: ['install', 'error'],
  evidenceIds: ['ev-1'],
  ...over,
})

/** A deterministic corpus big enough to exercise paging and ordering. */
function corpus(count) {
  return Array.from({ length: count }, (_, index) => record({
    recordId: `r${String(index)}`,
    revisionId: `r${String(index)}@1`,
    title: `Record ${String(index)}`,
    text: `shared body token unique${String(index)} number ${String(index)}`,
    runId: index % 2 === 0 ? 'run-even' : 'run-odd',
    observedAt: `2026-08-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    verdict: index % 3 === 0 ? 'VERIFIED' : 'UNVERIFIED',
    tags: [index % 2 === 0 ? 'even' : 'odd'],
  }))
}

test('tokenizing', async t => {
  await t.test('splits Latin text on word boundaries', () => {
    assert.deepEqual(tokenize('Hello, world!'), ['hello', 'world'])
  })

  await t.test('indexes every script, not only Latin', () => {
    // A `[a-z0-9]+` tokenizer silently drops every non-Latin record: they index
    // as nothing and return nothing, and it looks like an empty library rather
    // than a broken tokenizer.
    assert.deepEqual(tokenize('مرحبا بالعالم'), ['مرحبا', 'بالعالم'])
    assert.deepEqual(tokenize('Привет мир'), ['привет', 'мир'])
    assert.deepEqual(tokenize('Γειά σου'), ['γειά', 'σου'])
  })

  await t.test('emits CJK as characters and bigrams, never as a whole run', () => {
    // Keeping the run would make it a token only an exact repetition could
    // match: a document containing 安装程序报告错误 would index that whole string,
    // and a search for its first four characters would find nothing — because
    // every query term must be present, and the query's own run token would be
    // absent from the document.
    const tokens = tokenize('安装程序')
    assert.ok(tokens.includes('安'), 'characters are missing')
    assert.ok(tokens.includes('安装'), 'bigrams are missing')
    assert.ok(!tokens.includes('安装程序'), 'the whole run is still emitted')
  })

  await t.test('a CJK substring finds the document containing it', () => {
    // The regression this bigram scheme exists for.
    const index = new LibraryIndex()
    index.add(record({ recordId: 'zh', title: '报告', text: '安装程序报告错误' }))
    assert.equal(index.search({ text: '安装程序' }).total, 1)
    assert.equal(index.search({ text: '报告' }).total, 1)
  })

  await t.test('keeps diacritics rather than folding them away', () => {
    // The original text is the evidence. Folding would make a citation resolve
    // to something the source does not say.
    assert.deepEqual(tokenize('عَلَم'), ['عَلَم'])
  })

  await t.test('a query is words, never a pattern', () => {
    // There is no escaping to get wrong because there is nothing to escape
    // into: a regex, a glob or a SQL fragment tokenizes to plain words.
    assert.deepEqual(tokenize('.*'), [])
    assert.deepEqual(tokenize("'; DROP TABLE x; --"), ['drop', 'table', 'x'])
  })

  await t.test('handles empty and whitespace-only input', () => {
    assert.deepEqual(tokenize(''), [])
    assert.deepEqual(tokenize('   \n\t '), [])
  })
})

test('indexing is incremental and idempotent', async t => {
  await t.test('indexing the same record twice changes nothing', () => {
    const once = new LibraryIndex()
    once.add(record())
    const twice = new LibraryIndex()
    twice.add(record())
    twice.add(record())
    assert.equal(twice.size, 1)
    assert.equal(twice.serialize().digest, once.serialize().digest)
  })

  await t.test('re-indexing replaces the old text rather than adding to it', () => {
    // Without this a document accumulates ghosts: it keeps matching words it no
    // longer contains, and no amount of re-indexing clears them.
    const index = new LibraryIndex()
    index.add(record({ text: 'aardvark' }))
    assert.equal(index.search({ text: 'aardvark' }).total, 1)
    index.add(record({ text: 'buffalo' }))
    assert.equal(index.search({ text: 'aardvark' }).total, 0)
    assert.equal(index.search({ text: 'buffalo' }).total, 1)
  })

  await t.test('a deleted record stops matching entirely', () => {
    // A posting left behind points at an id that no longer resolves — a result
    // that cannot be opened, which is worse than no result.
    const index = new LibraryIndex()
    index.add(record())
    assert.equal(index.remove('r1'), true)
    assert.equal(index.search({ text: 'installer' }).total, 0)
    assert.equal(index.size, 0)
    assert.equal(index.health, 'empty')
  })

  await t.test('removing something absent is not an error', () => {
    assert.equal(new LibraryIndex().remove('nope'), false)
  })

  await t.test('an interrupted build reports what it finished', () => {
    const controller = new AbortController()
    const index = new LibraryIndex()
    const records = corpus(50)
    // Cancel after the first handful, the way a user navigating away would.
    let seen = 0
    const original = index.add.bind(index)
    index.add = value => {
      original(value)
      seen += 1
      if (seen === 5) controller.abort()
    }
    const done = index.addAll(records, controller.signal)
    assert.ok(done >= 5 && done < records.length)
    assert.equal(index.health, 'stale')
    assert.match(index.diagnostics.join(' '), /cancelled/)
  })

  await t.test('resuming an interrupted build simply repeats it', () => {
    // Idempotence is what makes recovery trivial: re-adding what was already
    // added costs nothing and leaves the same index.
    const index = new LibraryIndex()
    const records = corpus(20)
    index.addAll(records.slice(0, 8))
    const partial = index.size
    index.addAll(records)
    assert.equal(index.size, records.length)
    assert.ok(partial < index.size)
  })
})

test('querying', async t => {
  await t.test('every term must be present', () => {
    // OR would return a page of documents sharing one common word, which reads
    // as the search being broken.
    const index = new LibraryIndex()
    index.add(record({ recordId: 'a', text: 'alpha beta' }))
    index.add(record({ recordId: 'b', text: 'alpha gamma' }))
    assert.equal(index.search({ text: 'alpha' }).total, 2)
    assert.equal(index.search({ text: 'alpha beta' }).total, 1)
    assert.equal(index.search({ text: 'alpha delta' }).total, 0)
  })

  await t.test('an empty query lists what the filters allow', () => {
    // "Show me the library" is a real request, not a mistake.
    const index = new LibraryIndex()
    index.addAll(corpus(6))
    const all = index.search({ text: '' })
    assert.equal(all.total, 6)
    assert.match(all.notes.join(' '), /No search terms/)
  })

  await t.test('results are paginated and the total is the real total', () => {
    const index = new LibraryIndex()
    index.addAll(corpus(60))
    const page = index.search({ text: 'shared', limit: 10, offset: 20 })
    assert.equal(page.total, 60)
    assert.equal(page.results.length, 10)
    assert.equal(page.offset, 20)
  })

  await t.test('paging is stable, so page 2 means something', () => {
    const index = new LibraryIndex()
    index.addAll(corpus(40))
    const first = index.search({ text: 'shared', limit: 10, offset: 0 })
    const again = index.search({ text: 'shared', limit: 10, offset: 0 })
    assert.deepEqual(
      first.results.map(r => r.sourceId),
      again.results.map(r => r.sourceId),
    )
    const second = index.search({ text: 'shared', limit: 10, offset: 10 })
    const overlap = second.results.filter(r => first.results.some(f => f.sourceId === r.sourceId))
    assert.equal(overlap.length, 0, 'pages overlap, so results are being missed or repeated')
  })

  await t.test('a query is bounded however large a limit is asked for', () => {
    // An unbounded search over a large corpus is a denial of service you wrote
    // yourself.
    const index = new LibraryIndex()
    index.addAll(corpus(400))
    const page = index.search({ text: 'shared', limit: 100_000 })
    assert.equal(page.limit, MAX_LIMIT)
    assert.ok(page.results.length <= MAX_LIMIT)
  })

  await t.test('a cancelled query returns nothing rather than a partial page', () => {
    const index = new LibraryIndex()
    index.addAll(corpus(30))
    const controller = new AbortController()
    controller.abort()
    const page = index.search({ text: 'shared', signal: controller.signal })
    assert.equal(page.total, 0)
    assert.match(page.notes.join(' '), /cancelled/i)
  })

  await t.test('filters narrow by every supported field', () => {
    const index = new LibraryIndex()
    index.addAll(corpus(30))
    assert.ok(index.search({ text: 'shared', runIds: ['run-even'] }).total > 0)
    assert.equal(index.search({ text: 'shared', runIds: ['run-nope'] }).total, 0)
    assert.ok(index.search({ text: 'shared', verdicts: ['VERIFIED'] }).total > 0)
    assert.ok(index.search({ text: 'shared', tags: ['even'] }).total > 0)
    assert.ok(index.search({ text: 'shared', kinds: ['video'] }).total > 0)
    assert.equal(index.search({ text: 'shared', kinds: ['audio'] }).total, 0)
  })

  await t.test('a timestamp range is inclusive at both ends', () => {
    const index = new LibraryIndex()
    index.add(record({ recordId: 'early', observedAt: '2026-01-01T00:00:00.000Z' }))
    index.add(record({ recordId: 'late', observedAt: '2026-12-31T00:00:00.000Z' }))
    const window = index.search({
      text: 'installer',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
    })
    assert.equal(window.total, 1)
    assert.equal(window.results[0].sourceId, 'early')
  })

  await t.test('sorting is honoured', () => {
    const index = new LibraryIndex()
    index.addAll(corpus(12))
    const newest = index.search({ text: 'shared', sort: 'newest', limit: 3 })
    const oldest = index.search({ text: 'shared', sort: 'oldest', limit: 3 })
    assert.notDeepEqual(
      newest.results.map(r => r.sourceId),
      oldest.results.map(r => r.sourceId),
    )
  })

  await t.test('a title match outranks a body mention', () => {
    const index = new LibraryIndex()
    index.add(record({ recordId: 'body', title: 'Something else', text: 'kestrel appears here' }))
    index.add(record({ recordId: 'title', title: 'Kestrel', text: 'unrelated body' }))
    const page = index.search({ text: 'kestrel' })
    assert.equal(page.results[0].sourceId, 'title')
  })

  await t.test('mixed-language records are all findable', () => {
    const index = new LibraryIndex()
    index.add(record({ recordId: 'ar', title: 'تقرير', text: 'المثبت أبلغ عن خطأ' }))
    index.add(record({ recordId: 'zh', title: '报告', text: '安装程序报告错误' }))
    index.add(record({ recordId: 'ru', title: 'Отчёт', text: 'установщик сообщил об ошибке' }))
    assert.equal(index.search({ text: 'المثبت' }).total, 1)
    assert.equal(index.search({ text: '安装程序' }).total, 1)
    assert.equal(index.search({ text: 'установщик' }).total, 1)
  })

  await t.test('a very long record is indexed without truncating the index', () => {
    const index = new LibraryIndex()
    index.add(record({ recordId: 'long', text: `${'lorem ipsum '.repeat(20_000)}needle` }))
    assert.equal(index.search({ text: 'needle' }).total, 1)
  })

  await t.test('malformed metadata does not stop a record being found', () => {
    const index = new LibraryIndex()
    index.add(record({ recordId: 'odd', source: null, runId: null, observedAt: null, verdict: null, tags: [] }))
    assert.equal(index.search({ text: 'installer' }).total, 1)
  })
})

test('serialising and recovering', async t => {
  await t.test('a round trip preserves the index exactly', () => {
    const index = new LibraryIndex()
    index.addAll(corpus(25))
    const restored = LibraryIndex.load(JSON.parse(JSON.stringify(index.serialize())))
    assert.equal(restored.health, 'ready')
    assert.equal(restored.size, index.size)
    assert.equal(
      restored.search({ text: 'shared' }).total,
      index.search({ text: 'shared' }).total,
    )
  })

  await t.test('the digest is order-independent', () => {
    // Otherwise every rebuild would look like corruption.
    const forwards = new LibraryIndex()
    forwards.addAll(corpus(10))
    const backwards = new LibraryIndex()
    backwards.addAll([...corpus(10)].reverse())
    assert.equal(forwards.serialize().digest, backwards.serialize().digest)
  })

  await t.test('a truncated index is corrupt, not partially trusted', () => {
    // Half-loading is the failure that looks like success: queries answer, and
    // they answer wrongly.
    const index = new LibraryIndex()
    index.addAll(corpus(12))
    const damaged = JSON.parse(JSON.stringify(index.serialize()))
    damaged.documents = damaged.documents.slice(0, 4)
    const loaded = LibraryIndex.load(damaged)
    assert.equal(loaded.health, 'corrupt')
    assert.match(loaded.diagnostics.join(' '), /digest/)
  })

  await t.test('a future version is refused rather than reinterpreted', () => {
    const index = new LibraryIndex()
    index.add(record())
    const future = { ...JSON.parse(JSON.stringify(index.serialize())), version: INDEX_VERSION + 1 }
    const loaded = LibraryIndex.load(future)
    assert.equal(loaded.health, 'corrupt')
    assert.match(loaded.diagnostics.join(' '), /version/)
  })

  await t.test('garbage is corrupt, and says which way', () => {
    for (const value of [null, 42, 'not an index', {}, { version: INDEX_VERSION }]) {
      const loaded = LibraryIndex.load(value)
      assert.equal(loaded.health, 'corrupt')
      assert.ok(loaded.diagnostics.length > 0)
    }
  })

  await t.test('a corrupt index answers nothing and says so', () => {
    const loaded = LibraryIndex.load({ version: 999 })
    const page = loaded.search({ text: 'anything' })
    assert.equal(page.total, 0)
    assert.equal(page.health, 'corrupt')
    assert.match(page.notes.join(' '), /rebuilt/)
  })

  await t.test('rebuilding from the records recovers completely', () => {
    const records = corpus(15)
    const broken = LibraryIndex.load({ version: 999 })
    assert.equal(broken.health, 'corrupt')
    const rebuilt = new LibraryIndex()
    rebuilt.addAll(records)
    assert.equal(rebuilt.health, 'ready')
    assert.equal(rebuilt.size, records.length)
  })

  await t.test('a stale index still answers, and warns', () => {
    const index = new LibraryIndex()
    index.addAll(corpus(5))
    index.markStale('records changed after the last build')
    const page = index.search({ text: 'shared' })
    assert.equal(page.health, 'stale')
    assert.ok(page.total > 0)
    assert.match(page.notes.join(' '), /behind the store/)
  })

  await t.test('clearing leaves nothing behind', () => {
    const index = new LibraryIndex()
    index.addAll(corpus(9))
    index.clear()
    assert.equal(index.size, 0)
    assert.equal(index.health, 'empty')
    assert.equal(index.search({ text: 'shared' }).total, 0)
  })
})

test('indexing stays inside its roots', async t => {
  const roots = ['G:/watch-manual/dsh-home/watch-fixtures', '/var/lib/watch/evidence']

  await t.test('a path inside a root is allowed', () => {
    assert.equal(isWithinRoots('G:/watch-manual/dsh-home/watch-fixtures/a.json', roots), true)
    assert.equal(isWithinRoots('/var/lib/watch/evidence/b.json', roots), true)
  })

  await t.test('traversal is refused, not normalised away', () => {
    // Normalising an attempt to escape produces a path that works, which is the
    // wrong outcome for input that was trying to get out.
    for (const attempt of [
      'G:/watch-manual/dsh-home/watch-fixtures/../../../Windows/System32/config/SAM',
      '/var/lib/watch/evidence/../../../etc/shadow',
      'G:/watch-manual/dsh-home/watch-fixtures/%2e%2e/%2e%2e/secret',
      '..\\..\\Windows\\win.ini',
    ]) {
      assert.equal(isWithinRoots(attempt, roots), false, `${attempt} escaped`)
    }
  })

  await t.test('a path outside every root is refused', () => {
    assert.equal(isWithinRoots('C:/Users/hp/.ssh/id_rsa', roots), false)
    assert.equal(isWithinRoots('/etc/passwd', roots), false)
  })

  await t.test('a prefix that is not a directory boundary is refused', () => {
    // `/var/lib/watch/evidence-secrets` is not inside `/var/lib/watch/evidence`.
    assert.equal(isWithinRoots('/var/lib/watch/evidence-secrets/x', roots), false)
  })

  await t.test('a null byte is refused', () => {
    assert.equal(isWithinRoots('/var/lib/watch/evidence/a\0.json', roots), false)
  })

  await t.test('empty input is refused', () => {
    assert.equal(isWithinRoots('', roots), false)
  })
})

test('snippets', async t => {
  await t.test('centre on the first match', () => {
    const text = `${'a'.repeat(300)} needle ${'b'.repeat(300)}`
    const snippet = snippetFor(text, ['needle'])
    assert.ok(snippet.includes('needle'))
    assert.ok(snippet.length < text.length)
  })

  await t.test('return the text verbatim, producing no markup', () => {
    // The snippet is evidence. Altering it would make it disagree with the
    // source, and emitting markup would hand a renderer something to trust.
    const hostile = 'before <script>alert(1)</script> needle after'
    const snippet = snippetFor(hostile, ['needle'])
    assert.ok(snippet.includes('<script>'), 'the text was altered')
    assert.ok(!snippet.includes('<mark'), 'the snippet invented markup')
  })

  await t.test('survive a record with no match', () => {
    assert.equal(typeof snippetFor('some text', ['absent']), 'string')
    assert.equal(typeof snippetFor('', ['x']), 'string')
  })
})
