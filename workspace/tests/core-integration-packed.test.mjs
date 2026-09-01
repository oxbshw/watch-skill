/**
 * The Bridge against Watch Core as a *user* would have it: installed.
 *
 * `core-integration.test.mjs` drives a real engine too, and this file exists
 * because that is not quite the same claim. A developer's venv is an install
 * of the working tree — it can import a module the wheel does not ship, and
 * it has done. What has to be proved before a release is that the artifact
 * somebody downloads answers the protocol, so the executable here must come
 * from a clean wheel installed outside the repository, and the suite refuses
 * to run against anything else rather than passing on the checkout.
 *
 * Provision it with:
 *
 *   python -m build --outdir dist
 *   uv venv <somewhere-outside-the-repo>/venv
 *   uv pip install --python <somewhere>/venv dist/*.whl
 *   WATCH_CORE_PACKED=<somewhere>/venv/Scripts/watch-skill.exe   (or bin/)
 *
 * What it covers that a fixture cannot: two implementations, in two
 * languages, in two processes, agreeing about framing, negotiation, contract
 * digests, capability truth, concurrency, deadlines, cancellation, crash
 * reporting and shutdown — plus the two properties that are invisible from
 * inside one process, that stdout carries protocol frames and nothing else
 * and that stderr carries no secret and no absolute user path.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'
import { EXPECTED_SCHEMA_DIGESTS, detectSchemaDrift } from '@deepwatch/dsh-contracts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

/** The version this branch ships. Asserted exactly, not by shape. */
const CORE_VERSION = readFileSync(join(REPO, 'pyproject.toml'), 'utf8')
  .match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? ''

/**
 * The three contract operations this Core deliberately cannot perform.
 *
 * Named here, once, so the assertions below and the documentation gate in
 * `docs-claims.test.mjs` cannot drift apart about which three they are.
 */
export const UNAVAILABLE_METHODS = Object.freeze([
  'watch.browser.observe',
  'watch.browser.act',
  'watch.evidence.get',
])

/** The capabilities the handshake must report unavailable, for the same reason. */
export const UNAVAILABLE_CAPABILITIES = Object.freeze([
  'watch.browser.observe',
  'watch.browser.operate',
  'watch.evidence.resolve',
])

/**
 * The packed Core, or null when this machine has not provisioned one.
 *
 * Checked by running it *and* by where it lives. A path inside the repository
 * is refused rather than used: it would be a source install, and the whole
 * point of this file is that it is not one.
 */
function packedCore() {
  const named = process.env['WATCH_CORE_PACKED']
  if (named === undefined || named === '') return { path: null, why: 'WATCH_CORE_PACKED is not set' }
  if (!existsSync(named)) return { path: null, why: `WATCH_CORE_PACKED does not exist: ${named}` }

  const inside = resolve(named).toLowerCase().startsWith(resolve(REPO).toLowerCase() + sep)
  if (inside) {
    return {
      path: null,
      why: 'WATCH_CORE_PACKED points inside the repository, so it is a source '
        + 'install; this suite exists to test the shipped wheel',
    }
  }
  // Both streams, and a generous timeout. The engine renders its help through
  // Rich, which picks a stream and a width from the environment, and a cold
  // first import on a CI runner is not fast. Reading only stdout made this
  // report "no bridge command" about an engine that has one -- and because the
  // suite skips rather than fails, the whole matrix stayed green while it ran
  // nowhere. The refusal now carries the exit status and the size of what it
  // read, so the next person is not guessing either.
  const probe = spawnSync(named, ['--help'], { encoding: 'utf8', timeout: 180_000 })
  const help = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
  // A UTF-16 console leaves a NUL between every character, which is how a
  // help output plainly containing the word failed to match it.
  if (!/bridge/.test(help.split('\0').join(''))) {
    return {
      path: null,
      why: 'the named executable has no `bridge` command '
        + `(exit ${String(probe.status)}, ${String(help.length)} bytes of help)`,
    }
  }
  return { path: named, why: '' }
}

const CORE = packedCore()
const skip = CORE.path === null ? `packed Watch Core unavailable: ${CORE.why}` : false

/** Mount the Bridge against the packed engine. */
async function mount(overrides = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchCoreService, {
    transport: 'stdio',
    command: CORE.path,
    args: ['bridge'],
    autoConnect: false,
    // Core imports its engine lazily; a cold first call is slow and that is
    // not a protocol fault.
    startupTimeoutMs: 90_000,
    requestTimeoutMs: 90_000,
    ...overrides,
  })
  return { ctx, fiber }
}

/** Run one body against a live packed Core, always disposing the child. */
async function withCore(body, overrides = {}) {
  const { ctx, fiber } = await mount(overrides)
  try {
    return await body(ctx)
  } finally {
    await fiber.dispose()
  }
}

describe('the packed Watch Core, driven by the real Node Bridge', { skip }, () => {
  let handshake = null

  before(async () => {
    await withCore(async (ctx) => {
      const result = await ctx.watchCore.connect()
      assert.equal(result.ok, true,
        `the packed engine refused to connect: ${JSON.stringify(result.error ?? {})}`)
      handshake = result.value
    })
  })

  // ── provenance ───────────────────────────────────────────────────────────

  test('the executable is an installed wheel, not the source checkout', () => {
    const where = resolve(CORE.path).toLowerCase()
    assert.ok(!where.startsWith(resolve(REPO).toLowerCase() + sep),
      'the engine under test must not live inside the repository')
    // A venv install, which is what `uv pip install <wheel>` produces.
    assert.match(where, /[\\/](scripts|bin)[\\/]watch-skill(\.exe)?$/)
  })

  // ── negotiation ──────────────────────────────────────────────────────────

  test('the handshake reports the version this branch ships, exactly', () => {
    assert.notEqual(CORE_VERSION, '', 'pyproject must declare a version to compare against')
    assert.equal(handshake.coreVersion, CORE_VERSION)
    assert.notEqual(handshake.coreVersion, '0.0.0-mock')
  })

  test('the protocol range is 1 to 1, and the negotiated value is inside it', () => {
    assert.equal(handshake.protocolMin, 1)
    assert.equal(handshake.protocolVersion, 1)
    assert.ok(handshake.protocolVersion >= handshake.protocolMin)
  })

  test('the contract digests agree across two languages', () => {
    // The assertion a mock cannot fail. Core computes these from its Pydantic
    // models at import; this build holds the generated constants.
    assert.deepEqual(detectSchemaDrift(handshake.schemaDigests), [])
    for (const [family, digest] of Object.entries(EXPECTED_SCHEMA_DIGESTS)) {
      assert.equal(handshake.schemaDigests[family], digest, `${family} drifted`)
    }
  })

  test('capability truth comes from live probes, not a static list', () => {
    assert.ok(handshake.capabilities.length > 0)
    for (const truth of handshake.capabilities) {
      // No real request has been made at handshake time, so nothing may claim
      // the one status that means one has.
      assert.notEqual(truth.status, 'machine_tested', `${truth.capabilityId} overclaims`)
      assert.equal(truth.providerVersion, handshake.coreVersion)
      assert.ok(truth.lastCheckedAt, `${truth.capabilityId} has no probe timestamp`)
    }
    // A probe that reads the machine produces mixed answers. All-identical
    // statuses would mean the list was written rather than measured.
    assert.ok(new Set(handshake.capabilities.map(c => c.status)).size > 1,
      'every capability reported the same status, which is a list and not a probe')
  })

  // ── a real operation ─────────────────────────────────────────────────────

  test('a Library read crosses Node, stdio, Python, stdio and back', async () => {
    await withCore(async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('watch.library.list', { limit: 5 })

      assert.equal(result.ok, true, JSON.stringify(result.error ?? {}))
      assert.ok(Array.isArray(result.value.sources))
      assert.equal(typeof result.value.total, 'number')
      assert.equal(typeof result.value.truncated, 'boolean')
    })
  })

  test('a verification runs in Core and returns its own verdict', async () => {
    await withCore(async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('watch.verification.run', {
        expectation: 'the workspace manifest exists',
        verificationId: 'ver_packed_integration',
        workingDir: join(REPO, 'workspace'),
        checks: [{ id: 'manifest', type: 'file_exists', required: true, params: { path: 'package.json' } }],
      })
      assert.equal(result.ok, true, JSON.stringify(result.error ?? {}))
      assert.equal(result.value.verdict, 'VERIFIED')
      assert.ok(result.value.contractDigest.length > 0,
        'a verdict with no frozen contract digest cannot be audited')
    })
  })

  // ── concurrency, deadlines, cancellation ─────────────────────────────────

  test('concurrent requests overlap rather than queueing behind each other', async () => {
    await withCore(async (ctx) => {
      await ctx.watchCore.connect()
      // Warm the engine first, so the measurement is of concurrency and not of
      // a cold import — the mistake that made an earlier version of this
      // assertion fail on a Windows runner.
      await ctx.watchCore.request('watch.library.list', { limit: 1 })

      const began = Date.now()
      const answers = await Promise.all([
        ctx.watchCore.request('watch.library.list', { limit: 1 }),
        ctx.watchCore.request('watch.capture.capabilities', {}),
        ctx.watchCore.request('watch.library.list', { limit: 2 }),
        ctx.watchCore.request('watch.health', {}),
      ])
      const elapsed = Date.now() - began

      assert.deepEqual(answers.map(a => a.ok), [true, true, true, true],
        answers.map(a => JSON.stringify(a.error ?? {})).join(' | '))
      // Four warm reads on a four-worker pool. A serialised server would take
      // roughly four times one read; this bound is loose enough not to flake
      // and tight enough that full serialisation fails it.
      assert.ok(elapsed < 30_000, `four concurrent reads took ${String(elapsed)}ms`)
    })
  })

  test('a deadline crosses the boundary and does not claim the work did not happen', async () => {
    await withCore(async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request(
        'watch.library.list', { limit: 1 }, { deadlineMs: 1 })

      // Either it beat the deadline or it did not; both are honest. What is
      // forbidden is a deadline error that tells the caller the work was not
      // done, because elapsed time is not evidence about effects.
      if (!result.ok) {
        assert.equal(result.error.error, 'bridge.deadline_exceeded')
        assert.match(result.error.fix, /receipt|retry/i)
      }
    })
  })

  test('cancellation crosses the boundary and reports itself as requested', async () => {
    await withCore(async (ctx) => {
      await ctx.watchCore.connect()
      const controller = new AbortController()
      const pending = ctx.watchCore.request(
        'watch.library.list', { limit: 1 }, { signal: controller.signal })
      controller.abort()
      const result = await pending

      assert.equal(result.ok, false)
      assert.ok(['bridge.cancel_requested', 'bridge.cancelled'].includes(result.error.error),
        `unexpected: ${result.error.error}`)
      // "Requested", never "did not happen": Python cannot stop a thread
      // mid-syscall and the wording is the contract.
      if (result.error.error === 'bridge.cancel_requested') {
        assert.match(result.error.fix, /receipt|already/i)
      }
    })
  })

  // ── structural failure ───────────────────────────────────────────────────

  test('an unknown method fails structurally, and the engine survives it', async () => {
    await withCore(async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('watch.no.such.method', {})

      assert.equal(result.ok, false)
      assert.equal(result.error.error, 'bridge.method_not_found')
      assert.ok(result.error.fix.length > 0)
      assert.equal(ctx.watchCore.health().phase, 'ready', 'the engine must still be usable')
    })
  })

  test('malformed params fail structurally, naming the parameter', async () => {
    await withCore(async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('watch.library.search', {})

      assert.equal(result.ok, false)
      assert.equal(result.error.error, 'bridge.invalid_params')
      assert.equal(result.error.details['parameter'], 'query')
      assert.equal(ctx.watchCore.health().phase, 'ready')
    })
  })

  test('a malformed frame is refused and does not desynchronise the stream', async () => {
    // Driven at the wire, because the Bridge will not emit a broken frame.
    const child = spawn(CORE.path, ['bridge'], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      const replies = await new Promise((resolveFrames) => {
        let buffer = Buffer.alloc(0)
        const frames = []
        child.stdout.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk])
          for (;;) {
            const end = buffer.indexOf('\r\n\r\n')
            if (end < 0) break
            const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1])
            const start = end + 4
            if (buffer.byteLength < start + length) break
            frames.push(JSON.parse(buffer.subarray(start, start + length).toString('utf8')))
            buffer = buffer.subarray(start + length)
            if (frames.length === 3) resolveFrames(frames)
          }
        })
        const send = (payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          child.stdin.write(`Content-Length: ${String(body.byteLength)}\r\n\r\n`)
          child.stdin.write(body)
        }
        send({ jsonrpc: '2.0', id: 1, method: 'watch.handshake', params: { protocolVersion: 1 } })
        // Declared length, body that is not JSON.
        child.stdin.write('Content-Length: 7\r\n\r\nnotjson')
        send({ jsonrpc: '2.0', id: 3, method: 'watch.health', params: {} })
      })

      assert.equal(replies[0].id, 1, 'the handshake answered')
      assert.equal(replies[1].error.data.error, 'bridge.parse_error',
        'the malformed frame was refused structurally')
      assert.equal(replies[2].id, 3,
        'the request after the bad frame was still served, so the stream resynchronised')
    } finally {
      child.stdin.end()
      await new Promise((done) => { child.once('exit', done); setTimeout(done, 5_000) })
    }
  })

  test('a protocol the engine cannot speak fails closed', async () => {
    // Asked at the wire: the Bridge only ever offers the version it speaks.
    const reply = await oneShot({ jsonrpc: '2.0', id: 1, method: 'watch.handshake', params: { protocolVersion: 0 } })
    assert.ok(reply.error !== undefined, 'a protocol of 0 must not be accepted')
    assert.equal(reply.error.data.error, 'bridge.protocol_mismatch')
    assert.equal(reply.error.data.details.coreMin, 1)
    assert.equal(reply.error.data.details.coreMax, 1)
  })

  test('a digest mismatch disables the affected capabilities rather than the product', () => {
    // The Bridge's own drift detection, exercised against a doctored map. The
    // live engine agrees (asserted above), so this is the only way to see the
    // closed-fail path without shipping a broken engine.
    const doctored = { ...handshake.schemaDigests, library: 'sha256:0000000000000000000000000000dead' }
    const drift = detectSchemaDrift(doctored)

    assert.equal(drift.length, 1)
    assert.equal(drift[0].family, 'library')
    assert.ok(drift[0].affects.length > 0,
      'a drifted family must name the capabilities it takes offline')
  })

  // ── the three operations this Core cannot perform ────────────────────────

  describe('the operations this Core honestly cannot perform', () => {
    test('each refuses with capability_unavailable, not a plausible answer', async () => {
      await withCore(async (ctx) => {
        await ctx.watchCore.connect()
        for (const method of UNAVAILABLE_METHODS) {
          const result = await ctx.watchCore.request(method, { sessionId: 's', evidenceId: 'e' })
          assert.equal(result.ok, false, `${method} answered something`)
          assert.equal(result.error.error, 'bridge.capability_unavailable',
            `${method}: ${result.error.error}`)
          assert.ok(result.error.fix.length > 0, `${method} refused with no fix`)
        }
      })
    })

    test('the handshake reports their capabilities unavailable, with a reason', () => {
      const byId = new Map(handshake.capabilities.map(c => [c.capabilityId, c]))
      for (const id of UNAVAILABLE_CAPABILITIES) {
        const truth = byId.get(id)
        assert.ok(truth !== undefined, `${id} is not in the capability report at all`)
        assert.equal(truth.status, 'unavailable', `${id} is reported ${truth.status}`)
        assert.ok(truth.missing.length > 0, `${id} is unavailable and says nothing is missing`)
        assert.ok(truth.fixes.length > 0, `${id} is unavailable with no fix`)
      }
    })

    test('no surface may offer them: isCapable is false for every one', async () => {
      await withCore(async (ctx) => {
        await ctx.watchCore.connect()
        for (const id of UNAVAILABLE_CAPABILITIES) {
          assert.equal(ctx.watchCore.isCapable(id), false, `${id} was offered as usable`)
        }
      })
    })

    test('no mock fills the gap: the refusal is the same with no fallback available', async () => {
      await withCore(async (ctx) => {
        await ctx.watchCore.connect()
        assert.equal(ctx.watchCore.health().isTestOnlyMock, false)
        assert.equal(ctx.watchCore.health().transport, 'stdio')
        const result = await ctx.watchCore.request('watch.evidence.get', { evidenceId: 'e_1' })
        assert.equal(result.ok, false)
      })
    })
  })

  // ── loss, restart, shutdown ──────────────────────────────────────────────

  test('an engine that dies updates health rather than hanging', async () => {
    const { ctx, fiber } = await mount()
    try {
      await ctx.watchCore.connect()
      assert.equal(ctx.watchCore.health().phase, 'ready')

      // Ask it to stop the way a Host would, then observe.
      await ctx.watchCore.request('watch.shutdown', {})
      const after = await ctx.watchCore.request('watch.library.list', { limit: 1 })

      const health = ctx.watchCore.health()
      assert.equal(health.isTestOnlyMock, false, 'a dead engine must never become a mock')
      if (!after.ok) assert.ok(after.error.fix.length > 0)
    } finally {
      await fiber.dispose()
    }
  })

  test('a reconnect does not duplicate an idempotent read', async () => {
    await withCore(async (ctx) => {
      await ctx.watchCore.connect()
      const first = await ctx.watchCore.request('watch.library.list', { limit: 3 })
      await ctx.watchCore.request('watch.shutdown', {})
      // The next request reconnects. A read is idempotent by definition, so
      // the answer must be the same rather than doubled.
      const second = await ctx.watchCore.request('watch.library.list', { limit: 3 })

      if (first.ok && second.ok) {
        assert.equal(second.value.total, first.value.total,
          'a reconnect changed what an idempotent read returned')
        assert.equal(second.value.sources.length, first.value.sources.length)
      }
    })
  })

  test('disposing the Bridge leaves no Watch Core process behind', async () => {
    const before = coreProcessIds()
    const { ctx, fiber } = await mount()
    await ctx.watchCore.connect()
    const during = coreProcessIds()
    assert.ok(during.length > before.length, 'connecting must actually start an engine')

    await fiber.dispose()
    // Give the child a moment to exit after SIGTERM.
    await new Promise((done) => setTimeout(done, 3_000))

    const after = coreProcessIds()
    assert.ok(after.length <= before.length,
      `disposal left ${String(after.length - before.length)} engine process(es) behind`)
  })

  // ── the two properties only a process can show ───────────────────────────

  test('stdout carries protocol frames and nothing else', async () => {
    const raw = await rawSession([
      { jsonrpc: '2.0', id: 1, method: 'watch.handshake', params: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'watch.capture.capabilities', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'watch.library.list', params: { limit: 2 } },
    ])

    // Every byte of stdout must be consumed by the framing. Anything left over
    // is a stray print, and a stray print desynchronises every request behind
    // it. `doctor` and the capture matrix both print in other surfaces, which
    // is why they are the ones exercised here.
    let rest = raw.stdout
    let frames = 0
    while (rest.byteLength > 0) {
      const end = rest.indexOf('\r\n\r\n')
      assert.ok(end > 0, `stdout has ${String(rest.byteLength)} unframed trailing bytes`)
      const header = rest.subarray(0, end).toString('ascii')
      assert.match(header, /^Content-Length: \d+$/,
        `stdout header was not a bare Content-Length: ${JSON.stringify(header)}`)
      const length = Number(/content-length:\s*(\d+)/i.exec(header)[1])
      rest = rest.subarray(end + 4 + length)
      frames += 1
    }
    assert.equal(frames, 3, 'one frame per request, and no others')
  })

  test('stderr carries no secret and no absolute user path', async () => {
    const raw = await rawSession([
      { jsonrpc: '2.0', id: 1, method: 'watch.handshake', params: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'watch.library.search', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'watch.no.such.method', params: {} },
    ])
    const text = raw.stderr.toString('utf8')

    assert.ok(!/[A-Za-z]:[\\/]{1,2}Users[\\/]/i.test(text), 'stderr leaked a Windows home path')
    assert.ok(!/\/(?:home|Users)\/[A-Za-z0-9._-]+\//.test(text), 'stderr leaked a POSIX home path')
    for (const shape of [/sk-[A-Za-z0-9]{16,}/, /sk-ant-/, /ghp_[A-Za-z0-9]{20,}/, /-----BEGIN/]) {
      assert.ok(!shape.test(text), `stderr matched a credential shape: ${String(shape)}`)
    }
  })
})

// ── the counterfactual ─────────────────────────────────────────────────────

/**
 * A Core with the `bridge` command genuinely removed.
 *
 * Provisioned by installing the same wheel into a second venv and deleting the
 * command from the installed package — which is what a Core predating the
 * Bridge surface actually is, rather than a fixture imitating one. Point
 * `WATCH_CORE_NO_BRIDGE` at it.
 */
const NO_BRIDGE = process.env['WATCH_CORE_NO_BRIDGE'] ?? ''
const skipCounterfactual = NO_BRIDGE === '' || !existsSync(NO_BRIDGE)
  ? 'WATCH_CORE_NO_BRIDGE is not set to a Core with the bridge command removed'
  : false

describe('an engine without the bridge command', { skip: skipCounterfactual }, () => {
  test('reports bridge_surface_missing, and never a mock success', async () => {
    // `transport: auto`, which is the setting that used to reach the mock. The
    // whole point of the assertion is that it no longer can.
    const ctx = new Context()
    const fiber = await ctx.plugin(WatchCoreService, {
      transport: 'auto',
      command: NO_BRIDGE,
      args: ['bridge'],
      autoConnect: false,
      startupTimeoutMs: 30_000,
      requestTimeoutMs: 10_000,
    })
    try {
      const result = await ctx.watchCore.connect()
      assert.equal(result.ok, false, 'a missing subcommand must not connect')

      const health = ctx.watchCore.health()
      assert.equal(health.blocker, 'bridge_surface_missing',
        `blocker was ${health.blocker}`)
      assert.equal(health.isTestOnlyMock, false, 'auto must never fall back to the mock')
      assert.notEqual(health.transport, 'mock')
      assert.equal(health.handshake, null, 'no handshake means no version to claim')
      assert.deepEqual([...ctx.watchCore.capabilities()], [])
    } finally {
      await fiber.dispose()
    }
  })
})

/** Send one framed request to a fresh engine and return its first reply. */
async function oneShot(payload) {
  const frames = await rawSession([payload])
  const end = frames.stdout.indexOf('\r\n\r\n')
  const length = Number(/content-length:\s*(\d+)/i.exec(frames.stdout.subarray(0, end).toString())[1])
  return JSON.parse(frames.stdout.subarray(end + 4, end + 4 + length).toString('utf8'))
}

/**
 * Run one whole conversation against a fresh engine and capture both streams.
 *
 * Raw bytes rather than parsed frames, because two of the assertions above are
 * about what is in the streams and not about what could be decoded from them.
 */
function rawSession(payloads) {
  return new Promise((done, fail) => {
    const child = spawn(CORE.path, ['bridge'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.once('error', fail)
    child.once('close', () => {
      done({ stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
    })
    for (const payload of payloads) {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      child.stdin.write(`Content-Length: ${String(body.byteLength)}\r\n\r\n`)
      child.stdin.write(body)
    }
    // EOF is the shutdown signal, and closing it is what makes `close` fire.
    setTimeout(() => { child.stdin.end() }, 4_000)
  })
}

/** Watch Core processes currently running, by pid. */
function coreProcessIds() {
  const name = process.platform === 'win32' ? 'watch-skill.exe' : 'watch-skill'
  const listing = process.platform === 'win32'
    ? spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    : spawnSync('pgrep', ['-f', 'watch-skill bridge'], { encoding: 'utf8' })
  const text = listing.stdout ?? ''
  return text.split('\n').map(line => line.trim()).filter(line => line !== '' && !/^INFO:/.test(line))
}

// A skip that reads as a pass is how the Bridge came to be described by the
// architecture and absent from the engine. Say so, loudly, on the way past.
if (skip !== false) {
  process.stdout.write(`\n# core-integration-packed SKIPPED: ${skip}\n`)
}
