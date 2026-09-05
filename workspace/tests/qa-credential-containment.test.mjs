/**
 * A QA run leaves a credential store it does not own byte-identical.
 *
 * This is a regression, and the thing it regresses against actually happened:
 * a QA room was pointed at a real credentials document through
 * `dsh-credentials-local`'s `path` config so a journey could reuse a provider
 * without copying the secret. The reference worked. What nobody had thought
 * about is that `qa-e2e-run.mjs` *resets* the credential store before it
 * configures a provider, and then configures one — so a synthetic pass deleted
 * and rewrote a document that belonged to a person, adding an
 * `OPENROUTER_E2E_API_KEY` entry beside the key they use.
 *
 * The fix is not "be careful with the flag". It is that a synthetic QA run
 * refuses to start against any store outside its own room, and this test is
 * how that refusal stays true. It builds a *synthetic* owner store — the
 * shape of one, with an obviously fake value — points a throwaway room's
 * profile at it exactly as the real room did, runs the real script, and then
 * hashes the file.
 *
 * Two assertions, and the second is the one that matters:
 *
 *  1. the run fails, and says which document and which profile line aimed it
 *     there, because a refusal nobody can act on gets worked around; and
 *  2. the synthetic owner store is byte-identical afterwards — same digest,
 *     same size, same modification time.
 *
 * The test never opens a real credentials document. Its "owner store" is a
 * fixture it writes itself, in a temporary directory it deletes.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(WORKSPACE, 'scripts', 'qa-e2e-run.mjs')

const { assertTaskOwnedStore, resolveCredentialStores, isInside, locate } = await import(
  new URL('../scripts/lib/qa-credential-store.mjs', import.meta.url).href)

const { proveLoopbackRoute } = await import(
  new URL('../scripts/lib/loopback-route.mjs', import.meta.url).href)

/**
 * A credentials document in the shape the local provider writes.
 *
 * The value is nonsense on purpose and says so, so that anyone who greps a
 * leak report for it gets their answer from the string itself rather than
 * from whoever wrote this file.
 */
const SYNTHETIC_OWNER_DOCUMENT = [
  'version: 1',
  'refs:',
  '  OPENROUTER_API_KEY:',
  '    kind: api-key',
  '    value: not-a-real-key-synthetic-owner-store-fixture',
  '',
].join('\n')

/** A room whose profile points its credential store at `storePath`. */
function buildRoom(root, { storePath = null, profile = 'deepwatch' } = {}) {
  const home = join(root, 'home')
  const profileDir = join(home, 'dsh-home', 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')

  const patch = ['# room profile patch', '- id: watch-core-bridge', '  config:', '    transport: auto']
  if (storePath !== null) {
    patch.push(
      '# Resolve the provider credential by reference, without copying it.',
      '- id: credentials',
      '  config:',
      `    path: '${storePath.split('\\').join('/')}'`)
  }
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `${patch.join('\n')}\n`, 'utf8')
  return home
}

/** Digest, size and mtime — the three ways this file could have changed. */
function fingerprint(path) {
  const stat = statSync(path)
  return {
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

describe('a QA run cannot touch a credential store it does not own', () => {
  test('the synthetic owner store survives a real qa-e2e-run byte-identical', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-cred-containment-'))
    try {
      // Deliberately a sibling of the room rather than inside it: this is the
      // arrangement that failed, an existing document referenced from outside.
      const ownerHome = join(root, 'owner', 'dsh-home')
      mkdirSync(ownerHome, { recursive: true })
      const ownerStore = join(ownerHome, '.credentials.yaml')
      writeFileSync(ownerStore, SYNTHETIC_OWNER_DOCUMENT, 'utf8')
      const before = fingerprint(ownerStore)

      const home = buildRoom(join(root, 'room'), { storePath: ownerStore })

      const run = spawnSync(process.execPath, [SCRIPT, '--home', home, '--out', join(root, 'out')], {
        cwd: WORKSPACE,
        encoding: 'utf8',
        timeout: 120_000,
      })

      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      assert.notEqual(run.status, 0,
        `the run was expected to refuse, it exited 0:\n${output}`)
      assert.match(output, /credential document outside itself/,
        `the refusal did not name its reason:\n${output}`)
      assert.ok(output.includes(ownerStore),
        `the refusal did not name the document it refused:\n${output}`)
      assert.match(output, /credentials\.config\.path/,
        `the refusal did not name the profile line that aimed it there:\n${output}`)

      // The whole point. Not "was it restored" — never written.
      const after = fingerprint(ownerStore)
      assert.equal(after.sha256, before.sha256, 'the owner store contents changed')
      assert.equal(after.size, before.size, 'the owner store size changed')
      assert.equal(after.mtimeMs, before.mtimeMs, 'the owner store was rewritten')
      assert.equal(readFileSync(ownerStore, 'utf8'), SYNTHETIC_OWNER_DOCUMENT)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a room with no reference resolves to its own store and is allowed', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-cred-own-'))
    try {
      const home = buildRoom(root)
      const { store, references } = assertTaskOwnedStore({ home, env: {} })
      assert.equal(store, join(home, 'dsh-home', '.credentials.yaml'))
      assert.deepEqual(references, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a reference inside the room is fine — containment, not prohibition', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-cred-inside-'))
    try {
      const home = join(root, 'home')
      const inside = join(home, 'dsh-home', '.credentials.yaml')
      buildRoom(root, { storePath: inside })
      assert.doesNotThrow(() => assertTaskOwnedStore({ home, env: {} }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an inherited DSH_HOME is a reference like any other', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-cred-env-'))
    try {
      const home = buildRoom(root)
      const elsewhere = join(root, 'somebody-elses-dsh')
      assert.throws(
        () => assertTaskOwnedStore({ home, env: { DSH_HOME: elsewhere } }),
        /credential document outside itself/)
      assert.doesNotThrow(
        () => assertTaskOwnedStore({ home, env: { DSH_HOME: join(home, 'dsh-home') } }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a dshHome config is resolved to the document under it', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-cred-dshhome-'))
    try {
      const home = join(root, 'home')
      const profileDir = join(home, 'dsh-home', 'profiles', 'deepwatch')
      mkdirSync(profileDir, { recursive: true })
      const elsewhere = join(root, 'owner-dsh').split('\\').join('/')
      writeFileSync(join(profileDir, 'cordis.patch.yml'),
        `- id: credentials-local\n  config:\n    dshHome: '${elsewhere}'\n`, 'utf8')

      const resolved = resolveCredentialStores({ home, env: {} })
      assert.ok(resolved.references.some(entry => entry.filename.endsWith('.credentials.yaml')
        && entry.filename.toLowerCase().includes('owner-dsh')),
      `dshHome was not resolved to a document: ${JSON.stringify(resolved.references)}`)
      assert.throws(() => assertTaskOwnedStore({ home, env: {} }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('containment is by path segment, not by string prefix', () => {
    assert.equal(isInside('D:/room', 'D:/room/home/.credentials.yaml'), true)
    assert.equal(isInside('D:/room', 'D:/room'), true)
    assert.equal(isInside('D:/room', 'D:/room-2/home/.credentials.yaml'), false)
    assert.equal(isInside('D:/room', 'D:/other/.credentials.yaml'), false)
    assert.equal(isInside('D:/room', 'D:/room/../room-2/x.yaml'), false)
  })

  test('the guard runs before the harness starts anything', () => {
    // A refusal that arrives after Electron has launched and the profile has
    // been reset is not containment, it is a postmortem. The script prints the
    // stub's address as its first side effect, so its absence is the evidence
    // that nothing was started.
    const root = mkdtempSync(join(tmpdir(), 'qa-cred-order-'))
    try {
      const ownerHome = join(root, 'owner', 'dsh-home')
      mkdirSync(ownerHome, { recursive: true })
      const ownerStore = join(ownerHome, '.credentials.yaml')
      writeFileSync(ownerStore, SYNTHETIC_OWNER_DOCUMENT, 'utf8')
      const home = buildRoom(join(root, 'room'), { storePath: ownerStore })

      const run = spawnSync(process.execPath, [SCRIPT, '--home', home, '--out', join(root, 'out')], {
        cwd: WORKSPACE, encoding: 'utf8', timeout: 120_000,
      })
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      assert.doesNotMatch(output, /^stub: /m, `a provider stub was started:\n${output}`)
      assert.doesNotMatch(output, /^reset: /m, `the profile was reset:\n${output}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
describe('the other thing that writes a credential is guarded too', () => {
  // `qa-e2e-run.mjs` was not the only writer. `proveLoopbackRoute` calls
  // `credentials.set`, and every packed gate in this repository starts by
  // calling it -- so a gate pointed at a room that references somebody's
  // document would store `STUB_LOCAL_API_KEY` in it. A different name and the
  // same mechanism as the entry that started all of this.

  test('it refuses to run without being told which room it may write in', async () => {
    let called = false
    await assert.rejects(
      () => proveLoopbackRoute({
        rpc: () => { called = true; return { result: { ok: true } } },
        stub: { baseURL: 'http://127.0.0.1:1', requests: [] },
        apiKey: 'synthetic',
      }),
      /`home` is required/)
    assert.equal(called, false, 'nothing may be sent before the room is known')
  })

  test('it refuses a room that references a store outside itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'route-foreign-'))
    try {
      const ownerHome = join(root, 'owner', 'dsh-home')
      mkdirSync(ownerHome, { recursive: true })
      const ownerStore = join(ownerHome, '.credentials.yaml')
      writeFileSync(ownerStore, SYNTHETIC_OWNER_DOCUMENT, 'utf8')
      const before = fingerprint(ownerStore)
      const home = buildRoom(join(root, 'room'), { storePath: ownerStore })

      let called = false
      await assert.rejects(
        () => proveLoopbackRoute({
          rpc: () => { called = true; return { result: { ok: true } } },
          stub: { baseURL: 'http://127.0.0.1:1', requests: [] },
          apiKey: 'synthetic',
          home,
        }),
        /credential document outside itself/)
      assert.equal(called, false, 'the credential must not be sent')
      assert.deepEqual(fingerprint(ownerStore), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a room that owns its store is allowed through to the RPC', async () => {
    const root = mkdtempSync(join(tmpdir(), 'route-own-'))
    try {
      const home = buildRoom(root)
      const sent = []
      const result = await proveLoopbackRoute({
        rpc: (method) => {
          sent.push(method)
          // Fail the settings write so the function returns early rather than
          // running its six-attempt probe against a stub that is not there.
          return { result: { ok: false, error: 'stopped by the test' } }
        },
        stub: { baseURL: 'http://127.0.0.1:1', requests: [] },
        apiKey: 'synthetic',
        home,
      })
      assert.equal(result.ok, false)
      assert.deepEqual(sent, ['credentials.set', 'settings.replace'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('`--home` means two things in this repository, and both resolve', () => {
  test('a room directory that holds dsh-home', () => {
    const root = mkdtempSync(join(tmpdir(), 'locate-room-'))
    try {
      const home = buildRoom(root)
      const found = locate(home)
      assert.equal(found.room, home)
      assert.equal(found.dshHome, join(home, 'dsh-home'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a harness home that holds profiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'locate-dsh-'))
    try {
      const home = buildRoom(root)
      const dshHome = join(home, 'dsh-home')
      const found = locate(dshHome)
      assert.equal(found.dshHome, dshHome)
      assert.equal(found.room, home, 'the room is the parent, not the harness home')
      // And the store it protects is the same one either way.
      assert.equal(assertTaskOwnedStore({ home: dshHome, env: {} }).store,
        assertTaskOwnedStore({ home, env: {} }).store)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
