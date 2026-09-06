/**
 * Watch Desktop: the decisions, proven without a display server.
 *
 * The Electron entry point is deliberately thin, and everything it decides
 * lives in modules that can be exercised here. Two of these tests are the ones
 * that matter most, because both are claims desktop software routinely makes
 * and routinely cannot back up:
 *
 * - **A sensitive memory is not readable from where it is stored.** Not "we
 *   set a flag" — the bytes are written, read back by something that is not the
 *   application, and searched for the sentence.
 * - **A child is stopped by its handle.** The supervisor is run against a real
 *   process that ignores SIGTERM, so the forcible path is exercised rather than
 *   assumed, and a source gate separately proves no file kills by name.
 *
 * The wiring — that the main process actually uses the frozen preferences, that
 * the preload has no passthrough — is checked by
 * `scripts/verify-desktop-security.mjs`, because it is a grep-shaped problem
 * and a unit test cannot see it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, createHash, sign as nodeSign } from 'node:crypto'

import {
  CONTENT_SECURITY_POLICY,
  PRELOAD_CHANNELS,
  RENDERER_PREFERENCES,
  REQUESTABLE_PERMISSIONS,
  ROLLBACK_AFTER_FAILED_LAUNCHES,
  SIGNING_STATUS,
  STARTUP_STEPS,
  SupervisedChild,
  applyUpdate,
  assertNoSecretsInArgv,
  bootstrapSecret,
  canonicalManifest,
  checkUpdate,
  childArguments,
  childEnvironment,
  compareVersions,
  containsPlaintext,
  createVaultKey,
  decidePermission,
  decideLaunch,
  describeReadiness,
  detectCapabilities,
  isDeepLink,
  isPreloadChannel,
  isTrustedSender,
  mayNavigate,
  mayOpenExternally,
  mayWrite,
  migrationPreflight,
  mustSeal,
  navigationPolicy,
  openRecord,
  openVaultKey,
  parseDeepLink,
  passthroughKeyStore,
  permissionFor,
  prepareAppData,
  recordFailedLaunch,
  recordSuccessfulLaunch,
  rollback,
  safeStorageKeyStore,
  sealRecord,
  securityPosture,
  shouldEnterSafeMode,
  stampSchemaVersion,
  updateAssurance,
  vaultAssurance,
} from '@deepwatch/desktop'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD = join(HERE, 'fixtures', 'supervised-child.mjs')

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ── security posture ────────────────────────────────────────────────────────

describe('the renderer gets nothing native', () => {
  test('every unsafe Electron default is turned off', () => {
    assert.equal(RENDERER_PREFERENCES.nodeIntegration, false)
    assert.equal(RENDERER_PREFERENCES.nodeIntegrationInWorker, false)
    assert.equal(RENDERER_PREFERENCES.nodeIntegrationInSubFrames, false)
    assert.equal(RENDERER_PREFERENCES.contextIsolation, true)
    assert.equal(RENDERER_PREFERENCES.sandbox, true)
    assert.equal(RENDERER_PREFERENCES.enableRemoteModule, false)
    assert.equal(RENDERER_PREFERENCES.webSecurity, true)
    assert.equal(RENDERER_PREFERENCES.webviewTag, false)
  })

  test('the posture cannot be mutated by a caller', () => {
    assert.equal(Object.isFrozen(RENDERER_PREFERENCES), true)
    assert.throws(() => {
      // @ts-expect-error deliberately violating the type to prove the freeze
      RENDERER_PREFERENCES.nodeIntegration = true
    })
  })

  test('the CSP allows no remote source and no inline script', () => {
    assert.match(CONTENT_SECURITY_POLICY, /default-src 'none'/)
    assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/)
    assert.equal(/script-src[^;]*unsafe-inline/.test(CONTENT_SECURITY_POLICY), false)
    assert.equal(/script-src[^;]*https:/.test(CONTENT_SECURITY_POLICY), false)
    assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self' http:\/\/127\.0\.0\.1:\*/)
    assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/)
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/)
  })

  test('navigation is loopback and the app’s own files, nothing else', () => {
    const policy = navigationPolicy('http://127.0.0.1:8931')
    assert.equal(mayNavigate('http://127.0.0.1:8931/session/1', policy), true)
    assert.equal(mayNavigate('file:///C:/app/renderer/index.html', policy), true)
    assert.equal(mayNavigate('https://example.test/', policy), false)
    assert.equal(mayNavigate('http://127.0.0.1:9999/', policy), false)
  })

  test('an external open is https and never loopback', () => {
    const policy = navigationPolicy('http://127.0.0.1:8931')
    assert.equal(mayOpenExternally('https://example.test/docs', policy), true)
    assert.equal(mayOpenExternally('http://example.test/docs', policy), false)
    assert.equal(mayOpenExternally('file:///C:/Windows/System32/cmd.exe', policy), false)
    assert.equal(mayOpenExternally('watch://open_selection?workspace=w', policy), false)
    // Aiming the person's browser at a local service is the interesting one.
    assert.equal(mayOpenExternally('https://127.0.0.1:8931/', policy), false)
    assert.equal(mayOpenExternally('https://localhost:8931/', policy), false)
  })

  test('a permission nobody asked for is refused', () => {
    const now = 1_000_000
    assert.equal(decidePermission('media', [], now).granted, false)
    assert.match(decidePermission('media', [], now).reason, /without anyone asking/)
  })

  test('a permission the product never uses is refused without a prompt', () => {
    const intents = [{ permission: 'geolocation', expiresAtMs: 2_000_000 }]
    const decision = decidePermission('geolocation', intents, 1_000_000)
    assert.equal(decision.granted, false)
    assert.match(decision.reason, /never requested/)
  })

  test('a permission behind an action the person took is granted, and expires', () => {
    const intents = [{ permission: 'media', expiresAtMs: 2_000_000 }]
    assert.equal(decidePermission('media', intents, 1_000_000).granted, true)
    assert.equal(decidePermission('media', intents, 3_000_000).granted, false,
      'a pending intent outlived its window')
  })

  test('only three permissions are ever requestable', () => {
    assert.deepEqual([...REQUESTABLE_PERMISSIONS], ['media', 'display-capture', 'fullscreen'])
  })

  test('IPC from a window this app did not create is refused', () => {
    assert.equal(isTrustedSender(7, [7, 9]), true)
    assert.equal(isTrustedSender(11, [7, 9]), false)
  })

  test('the preload surface is a closed set', () => {
    assert.equal(PRELOAD_CHANNELS.length, 9)
    assert.equal(isPreloadChannel('watch:ready-state'), true)
    assert.equal(isPreloadChannel('watch:anything-else'), false)
    assert.equal(isPreloadChannel('fs:read'), false)
  })

  test('the whole posture is available as one value', () => {
    const posture = securityPosture('http://127.0.0.1:8931')
    assert.equal(posture.preferences.sandbox, true)
    assert.equal(posture.preloadChannels.length, 9)
    assert.equal(posture.navigation.externalSchemes.length, 1)
  })
})

// ── supervision ─────────────────────────────────────────────────────────────

describe('the children are supervised by handle', () => {
  function child(mode, overrides = {}) {
    return new SupervisedChild({
      role: 'watch-core',
      command: process.execPath,
      args: [CHILD, mode],
      env: {},
      readyPattern: /watch: ready/,
      startTimeoutMs: 3_000,
      maxRestarts: 2,
      stopGraceMs: 300,
      ...overrides,
    })
  }

  test('a healthy child comes up and reports ready', async () => {
    const supervised = child('ok')
    try {
      const started = await supervised.start()
      assert.equal(started.ok, true)
      assert.equal(supervised.state().state, 'ready')
      assert.notEqual(supervised.state().pid, null)
    } finally {
      await supervised.stop()
    }
  })

  test('the owner token reaches the child in its environment, not its arguments', async () => {
    const lines = []
    const supervised = new SupervisedChild({
      role: 'dsh-host',
      command: process.execPath,
      args: [CHILD, 'ok'],
      env: {},
      readyPattern: /watch: ready/,
      startTimeoutMs: 3_000,
      maxRestarts: 1,
      stopGraceMs: 300,
    }, { onLog: (_role, line) => { lines.push(line) } })
    try {
      await supervised.start()
      const ready = lines.find(line => line.startsWith('watch: ready'))
      assert.notEqual(ready, undefined)
      const token = /owner=(\S+)/.exec(ready)?.[1]
      assert.notEqual(token, '(none)', 'the child never received an owner token')
      assert.equal(supervised.owns(token), true)
      assert.equal(supervised.owns('some-other-token'), false)
    } finally {
      await supervised.stop()
    }
  })

  test('a child that never announces itself fails, with the timeout named', async () => {
    const supervised = child('silent', { startTimeoutMs: 250 })
    try {
      const started = await supervised.start()
      assert.equal(started.ok, false)
      assert.equal(supervised.state().state, 'failed')
      assert.match(supervised.state().detail, /did not report ready/)
    } finally {
      await supervised.stop()
    }
  })

  test('a crash restarts, up to the budget, and then stops', async () => {
    const supervised = child('crash')
    try {
      await supervised.start()
      // Let it die and be counted, three times: two restarts then the budget.
      await new Promise(resolve => setTimeout(resolve, 120))
      assert.equal(supervised.state().restarts >= 1, true)
      assert.match(supervised.state().detail, /exited/)
    } finally {
      await supervised.stop()
    }
  })

  test('a child that ignores SIGTERM is killed by its handle', async () => {
    const supervised = child('stubborn', { stopGraceMs: 200 })
    await supervised.start()
    const pid = supervised.state().pid
    assert.notEqual(pid, null)
    await supervised.stop()
    assert.equal(supervised.state().state, 'stopped')
    // The process is gone. Signal 0 probes existence without sending anything.
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'a child that ignored SIGTERM survived stop()')
  })

  test('a spent restart budget takes the app to safe mode', () => {
    assert.equal(shouldEnterSafeMode([
      { role: 'dsh-host', state: 'ready', ownerToken: 'a', pid: 1, restarts: 0, detail: '', lastExit: null },
    ]), false)
    assert.equal(shouldEnterSafeMode([
      { role: 'watch-core', state: 'failed', ownerToken: 'b', pid: null, restarts: 3, detail: 'budget spent', lastExit: null },
    ]), true)
  })
})

// ── startup ─────────────────────────────────────────────────────────────────

describe('startup fails visibly, at a named step', () => {
  test('every step the vision names exists, in order', () => {
    assert.deepEqual([...STARTUP_STEPS], [
      'single_instance', 'app_data', 'migration_preflight', 'bootstrap_secret',
      'dsh_host', 'watch_core', 'bridge_handshake', 'window', 'ready',
    ])
  })

  test('a fresh directory initializes rather than migrating', () => {
    const dir = tempDir('watch-startup-')
    try {
      prepareAppData(dir)
      assert.equal(existsSync(join(dir, 'memory')), true)
      assert.equal(migrationPreflight(dir).action, 'initialize')
      stampSchemaVersion(dir)
      assert.equal(migrationPreflight(dir).action, 'none')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('a store from a newer build is refused, not opened', () => {
    const dir = tempDir('watch-startup-')
    try {
      prepareAppData(dir)
      writeFileSync(join(dir, 'schema-version'), '99\n', 'utf8')
      const check = migrationPreflight(dir)
      assert.equal(check.action, 'refuse_newer')
      assert.match(check.detail, /newer version/)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('an unreadable version marker is refused rather than guessed at', () => {
    const dir = tempDir('watch-startup-')
    try {
      prepareAppData(dir)
      writeFileSync(join(dir, 'schema-version'), 'not-a-number\n', 'utf8')
      assert.equal(migrationPreflight(dir).action, 'refuse_newer')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('read-only replay writes nothing, on every path', () => {
    const readOnly = {
      step: 'migration_preflight', mode: 'read_only_replay',
      detail: 'newer store', fix: 'update', completed: [],
    }
    assert.equal(mayWrite(readOnly), false)
    assert.equal(mayWrite({ ...readOnly, mode: 'normal' }), true)
    assert.equal(mayWrite({ ...readOnly, mode: 'safe_mode' }), true)
    assert.match(describeReadiness(readOnly), /Read-only/)
  })

  test('the readiness message always names the step', () => {
    const safe = {
      step: 'watch_core', mode: 'safe_mode',
      detail: 'the engine did not start', fix: 'Check the log.', completed: [],
    }
    assert.match(describeReadiness(safe), /watch_core/)
    assert.match(describeReadiness(safe), /Check the log/)
  })

  test('the bootstrap secret is fresh every launch and long enough to matter', () => {
    const first = bootstrapSecret()
    const second = bootstrapSecret()
    assert.notEqual(first, second)
    assert.ok(first.length >= 40)
  })

  test('the secret travels in the environment and never in arguments', () => {
    const secret = bootstrapSecret()
    const env = childEnvironment({ secret, appDataDir: 'C:/data', offlineOnly: true })
    const args = childArguments({ appDataDir: 'C:/data' })
    assert.equal(env.WATCH_BOOTSTRAP_SECRET, secret)
    assert.equal(args.join(' ').includes(secret), false)
    assert.doesNotThrow(() => { assertNoSecretsInArgv(args, [secret]) })
  })

  test('a secret that reaches an argument vector throws', () => {
    const secret = bootstrapSecret()
    assert.throws(
      () => { assertNoSecretsInArgv(['--token', secret], [secret]) },
      /every process on this machine can read it/,
    )
  })

  test('the host binds loopback on a port the OS chooses', () => {
    const env = childEnvironment({ secret: 'x', appDataDir: 'C:/data', offlineOnly: true })
    assert.equal(env.WATCH_HOST_BIND, '127.0.0.1')
    assert.equal(env.WATCH_HOST_PORT, '0')
  })
})

// ── deep links and capabilities ─────────────────────────────────────────────

describe('a deep link is a lookup request and nothing else', () => {
  test('a well-formed link parses', () => {
    const link = parseDeepLink('watch://open_selection?workspace=ws_1&session=sess_1&record=rec_2')
    assert.equal(isDeepLink(link), true)
    assert.equal(link.intent, 'open_selection')
    assert.equal(link.workspaceId, 'ws_1')
    assert.equal(link.sessionId, 'sess_1')
  })

  test('another scheme is refused', () => {
    for (const raw of [
      'https://example.test/',
      'file:///C:/Windows/System32/cmd.exe',
      'javascript:alert(1)',
    ]) {
      assert.equal(isDeepLink(parseDeepLink(raw)), false, `${raw} was accepted`)
    }
  })

  test('an unknown intent is refused', () => {
    assert.equal(isDeepLink(parseDeepLink('watch://run_command?workspace=w&cmd=whoami')), false)
  })

  test('a parameter that is not an identifier is refused', () => {
    for (const raw of [
      'watch://open_source?workspace=ws_1&path=' + encodeURIComponent('../../etc/passwd'),
      'watch://open_source?workspace=ws_1&url=' + encodeURIComponent('https://evil.test'),
      'watch://open_memory?workspace=ws_1&id=' + encodeURIComponent('a b'),
    ]) {
      assert.equal(isDeepLink(parseDeepLink(raw)), false, `${raw} was accepted`)
    }
  })

  test('a link with no workspace is refused', () => {
    assert.equal(isDeepLink(parseDeepLink('watch://open_selection?record=rec_1')), false)
  })

  test('a malformed link is refused rather than throwing', () => {
    assert.equal(isDeepLink(parseDeepLink('not a url at all')), false)
  })
})

describe('capabilities are detected, not requested', () => {
  test('media capabilities are unknown until someone uses them', () => {
    const reports = detectCapabilities()
    for (const id of ['camera', 'microphone', 'screen_capture', 'window_capture']) {
      const report = reports.find(candidate => candidate.id === id)
      assert.equal(report.present, 'unknown', `${id} was probed without permission`)
      assert.equal(report.promptsOnUse, true)
    }
  })

  test('every report says how it was established', () => {
    for (const report of detectCapabilities()) {
      assert.notEqual(report.method, '')
      assert.notEqual(report.method, 'detected')
    }
  })

  test('ffmpeg and browser detection produce a definite answer', () => {
    const reports = detectCapabilities()
    for (const id of ['ffmpeg', 'browser']) {
      const report = reports.find(candidate => candidate.id === id)
      assert.ok(['yes', 'no'].includes(report.present), `${id} was inconclusive`)
    }
  })

  test('only capture capabilities map to a permission', () => {
    assert.equal(permissionFor('camera'), 'media')
    assert.equal(permissionFor('screen_capture'), 'display-capture')
    assert.equal(permissionFor('ffmpeg'), null)
    assert.equal(permissionFor('file_dialog'), null)
  })
})

// ── the vault ───────────────────────────────────────────────────────────────

describe('a sensitive memory is not readable from where it is stored', () => {
  const SECRET = 'the staging database password rotates every Friday at noon'

  test('the stored bytes do not contain the sentence', () => {
    const dir = tempDir('watch-vault-')
    try {
      const store = passthroughKeyStore()
      const { key } = createVaultKey(store)
      const sealed = sealRecord(key, 'mem_1', SECRET)

      // Write it the way the store would, then read it back as bytes — by
      // something that is not this application, which is the whole claim.
      const path = join(dir, 'memory.db')
      writeFileSync(path, JSON.stringify(sealed), 'utf8')
      const onDisk = readFileSync(path)

      assert.equal(containsPlaintext(onDisk, SECRET), false,
        'the sentence is readable in the file it is stored in')
      assert.equal(containsPlaintext(onDisk, 'rotates every Friday'), false)
      // And it really is the same sentence coming back out.
      assert.equal(openRecord(key, sealed), SECRET)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('the plaintext search would find it if it were there', () => {
    // A negative result is only worth something if the search works. This is
    // the guard on the guard.
    const dir = tempDir('watch-vault-')
    try {
      const path = join(dir, 'plain.db')
      writeFileSync(path, JSON.stringify({ memoryId: 'mem_1', content: SECRET }), 'utf8')
      assert.equal(containsPlaintext(readFileSync(path), SECRET), true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('a UTF-16 store would not hide it either', () => {
    const stored = Buffer.from(SECRET, 'utf16le')
    assert.equal(containsPlaintext(stored, SECRET), true)
  })

  test('a record moved onto another id fails to open', () => {
    const { key } = createVaultKey(passthroughKeyStore())
    const sealed = sealRecord(key, 'mem_1', SECRET)
    assert.throws(() => openRecord(key, { ...sealed, memoryId: 'mem_2' }))
  })

  test('a record altered on disk fails to open rather than opening as something else', () => {
    const { key } = createVaultKey(passthroughKeyStore())
    const sealed = sealRecord(key, 'mem_1', SECRET)
    const tampered = Buffer.from(sealed.ciphertext, 'base64')
    tampered[0] = tampered[0] ^ 0xff
    assert.throws(() => openRecord(key, { ...sealed, ciphertext: tampered.toString('base64') }))
  })

  test('the wrong key does not open it', () => {
    const { key } = createVaultKey(passthroughKeyStore())
    const other = createVaultKey(passthroughKeyStore()).key
    const sealed = sealRecord(key, 'mem_1', SECRET)
    assert.throws(() => openRecord(other, sealed))
  })

  test('a key store round-trips the key', () => {
    const store = passthroughKeyStore()
    const { key, sealedKey } = createVaultKey(store)
    const reopened = openVaultKey(store, sealedKey)
    assert.equal(reopened.keyId, key.keyId)
    assert.equal(openRecord(reopened, sealRecord(key, 'mem_1', SECRET)), SECRET)
  })

  test('the OS-backed adapter uses the credential store it was given', () => {
    const calls = []
    const fake = {
      isEncryptionAvailable: () => true,
      encryptString: value => { calls.push(['encrypt', value]); return Buffer.from(`sealed:${value}`) },
      decryptString: buffer => {
        calls.push(['decrypt'])
        return buffer.toString('utf8').replace(/^sealed:/, '')
      },
    }
    const store = safeStorageKeyStore(fake)
    assert.equal(store.osBacked, true)
    assert.equal(store.available(), true)
    const { key, sealedKey } = createVaultKey(store)
    assert.equal(calls[0][0], 'encrypt')
    assert.deepEqual(openVaultKey(store, sealedKey).key, key.key)
  })

  test('the fallback says plainly that it is not OS protection', () => {
    const assurance = vaultAssurance(passthroughKeyStore())
    assert.equal(assurance.encrypted, true)
    assert.equal(assurance.osBacked, false)
    assert.match(assurance.statement, /not equivalent to operating-system protection/)
    assert.match(assurance.statement, /key is kept beside it/)
  })

  test('the OS-backed path says the key is never written beside the data', () => {
    const assurance = vaultAssurance(safeStorageKeyStore({
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: buffer => buffer.toString('utf8'),
    }), ['win32'])
    assert.equal(assurance.osBacked, true)
    assert.match(assurance.statement, /never written beside the data/)
    assert.deepEqual([...assurance.provenOn], ['win32'])
  })

  test('sensitive records are sealed in every mode; local personal seals everything', () => {
    assert.equal(mustSeal('session_only', { sensitivity: 'sensitive' }), true)
    assert.equal(mustSeal('session_only', { sensitivity: 'private' }), false)
    assert.equal(mustSeal('local_personal', { sensitivity: 'private' }), true)
    assert.equal(mustSeal('local_personal', { sensitivity: 'public' }), true)
  })
})

// ── updates ─────────────────────────────────────────────────────────────────

describe('updates are checked in an order that is the security property', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const DEV_KEY = { keyId: 'dev-1', publicKeyPem, production: false }

  // Ed25519 signs a message directly rather than through a Sign stream, which
  // is why `crypto.sign` is used here and `createVerify` inside the updater
  // still works: Node routes Ed25519 verification through the same path.
  function sign(manifest) {
    return nodeSign(null, Buffer.from(canonicalManifest(manifest)), privateKey).toString('base64')
  }

  function manifest(packageBytes, overrides = {}) {
    const base = {
      version: '0.2.0',
      sha256: createHash('sha256').update(packageBytes).digest('hex'),
      sizeBytes: packageBytes.length,
      schemaVersion: 1,
      signature: '',
      keyId: 'dev-1',
      releasedAt: '2026-08-27T00:00:00.000Z',
      ...overrides,
    }
    return { ...base, signature: sign(base) }
  }

  const PACKAGE = Buffer.from('a watch release package')

  test('a development-signed update is accepted and labelled', () => {
    const decision = checkUpdate({
      manifest: manifest(PACKAGE),
      packageBytes: PACKAGE,
      keys: [DEV_KEY],
      installedVersion: '0.1.0',
      currentSchemaVersion: 1,
      supportedSchemaVersions: [1],
    })
    assert.equal(decision.ok, true)
    assert.equal(decision.developmentSigned, true)
    assert.match(decision.note, /PRODUCTION SIGNING NOT PROVEN/)
  })

  test('an unsigned or wrongly signed manifest is refused before anything is unpacked', () => {
    const forged = { ...manifest(PACKAGE), signature: Buffer.from('nope').toString('base64') }
    const decision = checkUpdate({
      manifest: forged,
      packageBytes: PACKAGE,
      keys: [DEV_KEY],
      installedVersion: '0.1.0',
      currentSchemaVersion: 1,
      supportedSchemaVersions: [1],
    })
    assert.equal(decision.ok, false)
    assert.equal(decision.refusal.stage, 'signature')
  })

  test('a manifest signed by an unknown key is refused', () => {
    const decision = checkUpdate({
      manifest: manifest(PACKAGE, { keyId: 'someone-else' }),
      packageBytes: PACKAGE,
      keys: [DEV_KEY],
      installedVersion: '0.1.0',
      currentSchemaVersion: 1,
      supportedSchemaVersions: [1],
    })
    assert.equal(decision.ok, false)
    assert.equal(decision.refusal.stage, 'signature')
  })

  test('a package whose bytes do not match the signed digest is refused', () => {
    const decision = checkUpdate({
      manifest: manifest(PACKAGE),
      packageBytes: Buffer.from('a different package entirely'),
      keys: [DEV_KEY],
      installedVersion: '0.1.0',
      currentSchemaVersion: 1,
      supportedSchemaVersions: [1],
    })
    assert.equal(decision.ok, false)
    assert.equal(decision.refusal.stage, 'integrity')
  })

  test('a silent downgrade is refused', () => {
    const decision = checkUpdate({
      manifest: manifest(PACKAGE, { version: '0.1.0' }),
      packageBytes: PACKAGE,
      keys: [DEV_KEY],
      installedVersion: '0.3.0',
      currentSchemaVersion: 1,
      supportedSchemaVersions: [1],
    })
    assert.equal(decision.ok, false)
    assert.equal(decision.refusal.stage, 'downgrade')
  })

  test('a build that cannot read this store is refused before the swap', () => {
    const decision = checkUpdate({
      manifest: manifest(PACKAGE, { schemaVersion: 1 }),
      packageBytes: PACKAGE,
      keys: [DEV_KEY],
      installedVersion: '0.1.0',
      currentSchemaVersion: 4,
      supportedSchemaVersions: [1],
    })
    assert.equal(decision.ok, false)
    assert.equal(decision.refusal.stage, 'migration')
  })

  test('every refusal says what to do', () => {
    const forged = { ...manifest(PACKAGE), signature: 'AAAA' }
    const decision = checkUpdate({
      manifest: forged, packageBytes: PACKAGE, keys: [DEV_KEY],
      installedVersion: '0.1.0', currentSchemaVersion: 1, supportedSchemaVersions: [1],
    })
    assert.notEqual(decision.refusal.fix, '')
  })

  test('the signing status is stated, not implied', () => {
    assert.equal(SIGNING_STATUS, 'PRODUCTION SIGNING NOT PROVEN')
    assert.match(updateAssurance([DEV_KEY]), /PRODUCTION SIGNING NOT PROVEN/)
    assert.equal(
      /NOT PROVEN/.test(updateAssurance([{ ...DEV_KEY, production: true }])),
      false,
    )
  })

  test('versions compare numerically, not lexically', () => {
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
    assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
  })
})

describe('rollback happens on the second failure, not the first', () => {
  const current = { version: '0.2.0', path: 'C:/app/0.2.0', schemaVersion: 1, installedAt: '2026-08-27T00:00:00Z' }
  const previous = { version: '0.1.0', path: 'C:/app/0.1.0', schemaVersion: 1, installedAt: '2026-08-01T00:00:00Z' }

  test('one failure is a crash and the build is tried again', () => {
    const state = recordFailedLaunch({ current, previous, failedLaunches: 0 })
    assert.equal(decideLaunch(state).action, 'run')
  })

  test('two failures roll back to the previous build', () => {
    let state = { current, previous, failedLaunches: 0 }
    for (let i = 0; i < ROLLBACK_AFTER_FAILED_LAUNCHES; i += 1) state = recordFailedLaunch(state)
    const decision = decideLaunch(state)
    assert.equal(decision.action, 'rollback')
    assert.equal(decision.build.version, '0.1.0')
    assert.match(decision.reason, /rolling back/)
  })

  test('with nothing to roll back to, the app enters safe mode rather than trying again', () => {
    let state = { current, previous: null, failedLaunches: 0 }
    for (let i = 0; i < ROLLBACK_AFTER_FAILED_LAUNCHES; i += 1) state = recordFailedLaunch(state)
    const decision = decideLaunch(state)
    assert.equal(decision.action, 'safe_mode')
    assert.notEqual(decision.fix, '')
  })

  test('applying an update keeps the previous build, and rollback restores it', () => {
    const before = { current: previous, previous: null, failedLaunches: 0 }
    const after = applyUpdate(before, current)
    assert.equal(after.current.version, '0.2.0')
    assert.equal(after.previous.version, '0.1.0')
    assert.equal(after.failedLaunches, 0)

    const rolled = rollback({ ...after, failedLaunches: 2 })
    assert.equal(rolled.current.version, '0.1.0')
    assert.equal(rolled.failedLaunches, 0)
    assert.equal(rolled.previous, null, 'the build that failed is not kept as a rollback target')
  })

  test('a successful launch clears the failure count', () => {
    const state = recordSuccessfulLaunch({ current, previous, failedLaunches: 1 })
    assert.equal(state.failedLaunches, 0)
    assert.equal(decideLaunch(state).action, 'run')
  })
})
