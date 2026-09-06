/**
 * Writing to a pipe that is already gone.
 *
 * `stop()` sends a shutdown, and it is called on exactly the paths where the
 * worker is supposed to be gone: after a crash, after an OOM kill, and after
 * this module kills a worker for ignoring a cancel. Writing to that closed pipe
 * raises EPIPE, and an EPIPE on a stream with no error listener takes the
 * supervisor down — it dies while tidying up after a worker that did what it
 * was told. A Linux runner threw exactly that out of `OcrWorker.stop` and
 * failed an otherwise green pipeline.
 *
 * The earlier attempt at a regression for this started a real worker, killed
 * it, and asserted `stop()` did not reject. That passes with the guard removed:
 * whether a write to a dead child's stdin raises depends on the platform and on
 * how fast the pipe tears down, and on Windows it simply does not raise. A test
 * that cannot fail is not a regression test.
 *
 * So the child is injected. Every state below is one a real pipe reaches — torn
 * down, ended, throwing on write, raising asynchronously, or dying between the
 * guard and the write — and being *in* that state is no longer a race. Removing
 * either half of the fix turns these red on every platform, which is recorded
 * in the handoff for this change.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { OcrWorker } from '../packages/watch/technology/lib/ocr-worker.js'
import { DEEPSEEK_OCR } from '../packages/watch/technology/lib/descriptors.js'

/** A stdin in whatever state the test needs, recording what reached it. */
function stdinStub({ destroyed = false, writableEnded = false, onWrite } = {}) {
  const listeners = []
  return {
    destroyed,
    writableEnded,
    written: [],
    listeners,
    write(chunk) {
      this.written.push(chunk)
      return onWrite === undefined ? true : onWrite.call(this, chunk)
    },
    on(event, listener) {
      if (event === 'error') listeners.push(listener)
      return this
    },
    /** Raise the way a socket does when the peer is gone. */
    raise(code = 'EPIPE') {
      const error = Object.assign(new Error(`write ${code}`), { code, errno: -32, syscall: 'write' })
      if (listeners.length === 0) throw error
      for (const listener of [...listeners]) listener(error)
      return error
    },
  }
}

/** A child process that announces itself and then does whatever it is told. */
function childStub(stdin) {
  const exits = []
  const onceExits = []
  return {
    pid: 4242,
    stdin,
    stdout: {
      setEncoding() {},
      on(event, listener) {
        if (event !== 'data') return
        // The hello, so `start()` settles. Delivered on a later turn because a
        // real pipe never answers inside the call that created it.
        setTimeout(() => {
          listener(`${JSON.stringify({
            method: 'hello',
            params: {
              protocol: 1, model: 'stub-ocr',
              revision: 'pinned-revision', device: 'cpu', vramGb: null,
            },
          })}\n`)
        }, 0)
      },
    },
    stderr: { setEncoding() {}, on() {} },
    on(event, listener) {
      if (event === 'exit') exits.push(listener)
      return this
    },
    once(event, listener) {
      if (event === 'exit') onceExits.push(listener)
      return this
    },
    kill() {
      for (const listener of [...onceExits]) listener()
      for (const listener of [...exits]) listener(0, null)
      return true
    },
    /** The child going away, as the supervisor observes it. */
    exit(code = 0, signal = null) {
      for (const listener of [...onceExits]) listener()
      for (const listener of [...exits]) listener(code, signal)
    },
  }
}

/** A started supervisor over an injected child. */
async function started(stdin) {
  const child = childStub(stdin)
  const worker = new OcrWorker({
    descriptor: {
      ...DEEPSEEK_OCR,
      id: 'ocr.stub',
      provenance: { ...DEEPSEEK_OCR.provenance, revision: 'pinned-revision' },
    },
    spawn: { command: 'unused', args: [] },
    startTimeoutMs: 2_000,
    requestTimeoutMs: 1_000,
    cancelGraceMs: 50,
    spawnProcess: () => child,
  })
  const hello = await worker.start()
  assert.equal(hello.ok, true, `the stub worker did not start: ${JSON.stringify(hello.error ?? {})}`)
  return { worker, child, stdin }
}

describe('a write to a pipe that is already gone', () => {
  test('a destroyed stdin is not written to at all', async () => {
    const stdin = stdinStub({
      destroyed: true,
      onWrite() { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    })
    const { worker } = await started(stdin)
    const before = stdin.written.length

    await assert.doesNotReject(() => worker.stop())
    assert.equal(stdin.written.length, before,
      'the guard must decline to write, not write and catch')
  })

  test('an ended stdin is not written to at all', async () => {
    const stdin = stdinStub({
      writableEnded: true,
      onWrite() { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    })
    const { worker } = await started(stdin)
    const before = stdin.written.length

    await assert.doesNotReject(() => worker.stop())
    assert.equal(stdin.written.length, before)
  })

  test('a synchronous throw from write does not escape stop', async () => {
    // The pipe looks alive and is not: the child exited between the guard and
    // the write, which is the race the runner actually hit.
    const stdin = stdinStub({
      onWrite() {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32 })
      },
    })
    const { worker } = await started(stdin)

    await assert.doesNotReject(() => worker.stop(),
      'stopping something already stopped is not a failure')
  })

  test('an asynchronous EPIPE is handled rather than left unhandled', async () => {
    const stdin = stdinStub()
    const { worker } = await started(stdin)

    assert.ok(stdin.listeners.length > 0,
      'stdin has no error listener, so an async EPIPE would take the process down')
    // Raising it must reach a listener rather than throw out of `raise`.
    assert.doesNotThrow(() => { stdin.raise('EPIPE') })
    await worker.stop()
  })

  test('the child dying between the guard and the write is survivable', async () => {
    const stdin = stdinStub()
    const { worker, child } = await started(stdin)
    stdin.onWriteHook = true
    // Exit inside the write, so the guard has already passed when it happens.
    const original = stdin.write.bind(stdin)
    stdin.write = (chunk) => {
      child.exit(3, null)
      original(chunk)
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    }

    await assert.doesNotReject(() => worker.stop())
  })
})

describe('stopping is idempotent and reports once', () => {
  test('stop can be called repeatedly', async () => {
    const stdin = stdinStub()
    const { worker } = await started(stdin)

    await assert.doesNotReject(() => worker.stop())
    await assert.doesNotReject(() => worker.stop())
    await assert.doesNotReject(() => worker.stop())
  })

  test('cleanup does not invent a second fault after a real one', async () => {
    // The worker crashed; its health already says so. A stop that then failed
    // on the pipe would overwrite that with an unrelated stream error, and the
    // diagnostics panel would name the wrong thing.
    const stdin = stdinStub({
      onWrite() { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    })
    const { worker, child } = await started(stdin)

    child.exit(3, null)
    const afterCrash = worker.status()
    await worker.stop()

    assert.deepEqual(worker.status(), afterCrash,
      'tidying up must not become a second, unrelated failure report')
  })

  test('the stderr an operator reads is unchanged by a failed shutdown write', async () => {
    const stdin = stdinStub({
      onWrite() { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    })
    const { worker } = await started(stdin)
    const before = worker.log()
    await worker.stop()
    assert.equal(worker.log(), before)
  })
})

describe('a live pipe is still written to', () => {
  test('the shutdown reaches a healthy worker', async () => {
    // The guard must not be a blanket refusal: a stop that never sends anything
    // would turn every cooperative shutdown into a kill after the grace period.
    const stdin = stdinStub()
    const { worker } = await started(stdin)

    await worker.stop()
    assert.equal(stdin.written.length, 1)
    assert.match(stdin.written[0], /"method":"shutdown"/)
  })
})
