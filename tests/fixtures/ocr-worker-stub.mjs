#!/usr/bin/env node
/**
 * A stand-in for an OCR worker, so the supervisor can be tested without a GPU.
 *
 * This is not a model and does not pretend to be one. It speaks the worker
 * protocol and can be told to behave like a worker in each of the states that
 * matter: healthy, silent at startup, announcing the wrong revision, speaking
 * the wrong protocol, hanging, crashing, and being killed for memory.
 *
 * The point is that every one of those is a *process* behaviour. Simulating
 * them with a mock object inside the test process would prove the supervisor's
 * bookkeeping and nothing about isolation — and isolation is the entire reason
 * this component exists.
 *
 * Mode is the first argument:
 *
 *   ok               announce and answer
 *   silent           never announce
 *   wrong-revision   announce a different revision
 *   wrong-protocol   announce a protocol this build does not speak
 *   hang             announce, then never answer a recognize
 *   crash            announce, then exit non-zero on the first recognize
 *   oom              announce, then exit 137 — how a shell reports the OOM killer
 *   noisy            print non-JSON to stdout before announcing, then behave as ok
 *   uncancellable    announce, ignore recognize and cancel entirely
 */

const mode = process.argv[2] ?? 'ok'
const revision = process.argv[3] ?? 'pinned-revision'

/** Write one protocol message. */
function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

if (mode === 'noisy') {
  // A real inference library printing a progress bar to stdout. The supervisor
  // has to survive this rather than treating it as a malformed reply.
  process.stdout.write('Loading checkpoint shards:   0%|          | 0/4\n')
}

if (mode !== 'silent') {
  emit({
    method: 'hello',
    params: {
      protocol: mode === 'wrong-protocol' ? 99 : 1,
      model: 'stub-ocr',
      revision: mode === 'wrong-revision' ? 'some-other-revision' : revision,
      device: 'cpu',
      vramGb: null,
    },
  })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') handle(JSON.parse(line))
    index = buffer.indexOf('\n')
  }
})

/** Cancels that arrived, so a cooperative cancel can be answered. */
const cancelled = new Set()

function handle(request) {
  if (request.method === 'shutdown') {
    process.exit(0)
  }
  if (request.method === 'cancel') {
    if (mode === 'uncancellable') return
    cancelled.add(request.id)
    emit({ id: request.id, ok: false, error: { code: 'cancelled', message: 'Cancelled.' } })
    return
  }
  if (request.method !== 'recognize') return

  if (mode === 'crash') process.exit(3)
  if (mode === 'oom') {
    // Windows has no signals, so a literal SIGKILL is not portable. 137 is how
    // a shell reports SIGKILL, and it is what the supervisor recognises — so
    // the same stub exercises the same branch on every platform.
    process.exit(137)
  }
  if (mode === 'hang' || mode === 'uncancellable') return

  emit({
    id: request.id,
    ok: true,
    value: {
      text: String(request.params.expect ?? 'stub text'),
      regions: [],
      latencyMs: 1,
    },
  })
}

// Keep the process alive on stdin even when nothing is being sent.
process.stdin.resume()
