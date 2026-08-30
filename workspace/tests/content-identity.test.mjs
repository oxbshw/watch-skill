/**
 * Identity follows bytes.
 *
 * The Library used to identify a record by its file's path — first the path
 * itself, then a digest of it. Both are the defect
 * `src/watch_skill/identity.py` exists to end: a video's id was once
 * `sha256(source_string)`, so overwriting `demo.mp4` returned yesterday's
 * frames, OCR and cached answers for today's file with nothing in the reply
 * admitting it.
 *
 * Every assertion below fails against a path-derived identity. Moving
 * byte-identical content changes its path and must not change its id; changing
 * the bytes under one path does not change the path and must change both id and
 * revision. A path digest gets each of those exactly backwards.
 *
 * The last test is the one that keeps this honest over time: it runs Watch
 * Core's own Python and asserts the TypeScript mirror produces the same ids for
 * the same digest. There is one identity algorithm in this product, and this is
 * what makes that a fact rather than an intention.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  collectRecords, contentDigest, recordFromFile,
} from '../packages/watch/tools/lib/library-search.js'
import {
  contentIdFor, isContentDigest, revisionIdFor,
} from '../packages/watch/contracts/lib/identity.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')

/** The identifier grammar `@watchskill/dsh-contracts/query` enforces. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** One record's bytes. Anonymous: it names no id of its own. */
const anonymous = (text) => JSON.stringify({ kind: 'document', text })

describe('a record identifies its content, not its location', () => {
  test('identical bytes at two different paths are one record', () => {
    const bytes = anonymous('the deploy was not verified')
    const here = recordFromFile('/evidence/store/a/05-unverified.json', bytes)
    const there = recordFromFile('D:/somewhere/else/renamed.json', bytes)

    assert.equal(here.recordId, there.recordId,
      'moving byte-identical content must not mint a second record')
    assert.equal(here.revisionId, there.revisionId,
      'and it is the same revision, because it is the same bytes')
  })

  test('different bytes at the same path are two records', () => {
    const path = '/evidence/store/05-unverified.json'
    const before = recordFromFile(path, anonymous('the deploy was not verified'))
    const after = recordFromFile(path, anonymous('the deploy was verified'))

    assert.notEqual(before.recordId, after.recordId,
      'overwriting the file must not leave the previous record standing')
    assert.notEqual(before.revisionId, after.revisionId,
      'a new revision is the fact a surface renders as "this changed"')
  })

  test('two different contents do not share an identity', () => {
    const ids = new Set()
    for (let n = 0; n < 512; n += 1) ids.add(recordFromFile('/x.json', anonymous(`n-${n}`)).recordId)
    assert.equal(ids.size, 512, 'a collision inside 512 records is not a digest')
  })

  test('the identity is deterministic across processes', () => {
    // Not "across two calls in this process": a value derived from a module
    // counter or a start time would pass that and fail the moment the host
    // restarts, which is exactly when a person notices their Library changed.
    const bytes = anonymous('the kettle boiled')
    const here = recordFromFile('/evidence/a.json', bytes).recordId
    const module = pathToFileURL(join(ROOT, 'packages/watch/tools/lib/library-search.js')).href
    const elsewhere = execFileSync(process.execPath, [
      '--input-type=module', '-e',
      `import { recordFromFile } from ${JSON.stringify(module)}\n`
      + `process.stdout.write(recordFromFile('/other/path.json', ${JSON.stringify(bytes)}).recordId)`,
    ], { encoding: 'utf8' })
    assert.equal(elsewhere, here)
  })

  test('an explicit id stays authoritative and unchanged', () => {
    // Content identity is the *fallback*. A record that names itself keeps its
    // name, or every id anybody has quoted stops resolving.
    const named = recordFromFile('/evidence/a.json',
      JSON.stringify({ evidenceId: 'demo_src_installer', kind: 'video', text: 'x' }))
    const moved = recordFromFile('/elsewhere/b.json',
      JSON.stringify({ evidenceId: 'demo_src_installer', kind: 'video', text: 'x' }))
    assert.equal(named.recordId, 'demo_src_installer')
    assert.equal(moved.recordId, 'demo_src_installer')
  })

  test('an explicit id that is not an identifier goes through the documented path', () => {
    // `recordFromFile` does not validate: it reports what the file says, and
    // `parseLibraryGetRequest` is the one place the grammar is enforced. A
    // record whose file names a path as its id is therefore a record a search
    // can surface and `libraryGet` refuses — which is the documented behaviour
    // for a caller-supplied identifier, not something to paper over here.
    const hostile = recordFromFile('/evidence/a.json',
      JSON.stringify({ evidenceId: '../../etc/passwd', kind: 'document', text: 'x' }))
    assert.equal(hostile.recordId, '../../etc/passwd',
      'the reader reports; the validator refuses')
    assert.doesNotMatch(hostile.recordId, IDENTIFIER)
  })

  test('a derived id is an identifier the read plane will accept', () => {
    const derived = recordFromFile('/evidence/a.json', anonymous('x'))
    assert.match(derived.recordId, IDENTIFIER)
    assert.doesNotMatch(derived.recordId, /[/\\:]/)
    assert.match(derived.revisionId, IDENTIFIER)
  })

  test('nothing serialized to a client carries a path', () => {
    const record = recordFromFile(
      'D:/watch-manual/dsh-home/watch-fixtures/05-unverified.json',
      anonymous('the deploy was not verified'),
    )
    const serialized = JSON.stringify(record)
    // No part of where the host keeps its evidence, anywhere in the record.
    for (const fragment of ['D:/', 'D:\\', 'watch-manual', 'dsh-home', 'watch-fixtures']) {
      assert.equal(serialized.includes(fragment), false,
        `the record carries ${JSON.stringify(fragment)}`)
    }
    // And no separator at all in the fields that identify or label it. The
    // body text is exempt: a record may legitimately quote a path it observed,
    // and censoring evidence would be a worse defect than the one being fixed.
    for (const field of ['recordId', 'revisionId', 'title']) {
      assert.doesNotMatch(String(record[field]), /[/\\:]/,
        `${field} carries a path separator`)
    }
    // The filename, minus its extension, is allowed — it is a name a person
    // can recognise and it names no directory.
    assert.equal(record.title, '05-unverified')
  })

  test('the digest is over bytes, not over a decoded string', () => {
    const text = '{"kind":"document","text":"caf\u00e9"}'
    const bytes = Buffer.from(text, 'utf8')
    assert.equal(contentDigest(bytes), contentDigest(text))
    // A byte-order mark is a different file, and says so.
    assert.notEqual(contentDigest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])),
      contentDigest(bytes))
  })
})

describe('the identity algorithm is Watch Core’s', () => {
  const venv = process.platform === 'win32'
    ? join(REPO, '.venv', 'Scripts', 'python.exe')
    : join(REPO, '.venv', 'bin', 'python')

  test('the TypeScript mirror and the Python agree, digest for digest', { skip: existsSync(venv) ? false : 'no Watch Core venv on this machine' }, () => {
    const digests = [
      '0'.repeat(64),
      'f'.repeat(64),
      contentDigest(anonymous('the kettle boiled')),
      contentDigest(Buffer.from([0, 1, 2, 3])),
    ]
    for (const digest of digests) assert.equal(isContentDigest(digest), true)

    const script = [
      'import json, sys',
      'from watch_skill.identity import revision_id_for, video_id_for_digest',
      'digests = json.loads(sys.argv[1])',
      'print(json.dumps([[revision_id_for(d), video_id_for_digest(d)] for d in digests]))',
    ].join('\n')

    const raw = execFileSync(venv, ['-c', script, JSON.stringify(digests)], {
      encoding: 'utf8',
      cwd: REPO,
      env: { ...process.env, PYTHONPATH: join(REPO, 'src') },
    })
    const fromCore = JSON.parse(raw)

    const sha256hex = (material) =>
      createHash('sha256').update(material, 'utf8').digest('hex')
    const mirrored = digests.map(digest => [
      revisionIdFor(digest, sha256hex),
      contentIdFor(digest, sha256hex),
    ])

    assert.deepEqual(mirrored, fromCore,
      'the Workspace and Watch Core must mint the same id for the same bytes')
  })
})

// ── and it holds when the bytes come off a real disk ────────────────────────

describe('reading a real directory', () => {
  test('two copies of one file are one record, and the skip list names no path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wci-'))
    try {
      const bytes = anonymous('read from a real directory')
      writeFileSync(join(dir, 'one.json'), bytes)
      writeFileSync(join(dir, 'two.json'), bytes)
      writeFileSync(join(dir, 'broken.json'), '{ not json')

      const collected = collectRecords([dir.split(sep).join('/')])
      const ids = new Set(collected.records.map(record => record.recordId))
      assert.equal(ids.size, 1,
        'the same bytes under two names are one record, however they were read')
      assert.equal(collected.records.length, 2,
        'both files are still read; it is their identity that coincides')

      assert.deepEqual([...collected.skipped], ['broken.json: not a readable record'])
      for (const skipped of collected.skipped) {
        assert.doesNotMatch(skipped, /[/\\]/,
          'a skip reason names the file, never where the host keeps it')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a root that does not exist is reported without naming it', () => {
    const collected = collectRecords(['D:/no/such/library/root'])
    assert.deepEqual([...collected.records], [])
    assert.deepEqual([...collected.skipped], ['a configured library root does not exist'])
  })
})
