#!/usr/bin/env node
/**
 * Bring a session to the state the mode tabs need, without a paid provider.
 *
 * DSH hides the session header while a session is blank, and the mode tabs live
 * in that header. A session stops being blank once a turn has happened, so the
 * tabs need a model -- not a paid one, just one that answers on the wire.
 *
 * The steps here are all supported product behaviour: `session.create` adopts a
 * directory, `session.selectModel` picks the stub's model, `session.prompt`
 * sends a real turn through the real agent loop, and `session.list` reports
 * when the session is no longer blank. Nothing pokes at the DOM to make tabs
 * appear.
 *
 * Usage:
 *   node scripts/qa-session.mjs <base-url> <cwd> [--model watch-qa-stub]
 *
 * Prints one JSON line describing the session it prepared.
 */

const [BASE, CWD] = process.argv.slice(2)
const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'watch-qa-stub'

if (BASE === undefined || CWD === undefined) {
  process.stderr.write('usage: node scripts/qa-session.mjs <base-url> <cwd> [--model <id>]\n')
  process.exit(2)
}

let seq = 0
async function rpc(method, payload) {
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `qa-${String(Date.now())}-${String(seq++)}`,
      method,
      payload,
    }),
  })
  const body = await response.json()
  if (body?.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(body?.result ?? body).slice(0, 400)}`)
  }
  return body.result.value
}

const wait = ms => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Poll `session.list` until this session reports it is no longer blank. */
async function waitForTurn(sessionId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const listed = await rpc('session.list', {})
    last = listed.items.find(item => item.sessionId === sessionId) ?? null
    if (last !== null && last.blank === false && last.running === false) return last
    await wait(500)
  }
  throw new Error(`session stayed blank for ${String(timeoutMs)}ms: ${JSON.stringify(last).slice(0, 300)}`)
}

const created = await rpc('session.create', { cwd: CWD })
const sessionId = created.sessionId

// Pick the stub's model explicitly rather than relying on whatever the profile
// defaults to, so the turn cannot silently go somewhere else.
const models = await rpc('session.models', { sessionId })
const offered = (models.models ?? models.items ?? []).flatMap(entry => entry.models ?? [entry])
const match = offered.find(model => model.id === MODEL || model.modelId === MODEL)
if (match !== undefined) {
  await rpc('session.selectModel', {
    sessionId,
    selection: {
      provider: match.provider ?? 'deepseek-official',
      modelId: match.id ?? match.modelId,
    },
  })
}

await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: 'Say hello so this session is no longer blank.' }],
})

const settled = await waitForTurn(sessionId)

process.stdout.write(`${JSON.stringify({
  sessionId,
  blank: settled.blank,
  running: settled.running,
  cwd: settled.cwd,
  model: match?.id ?? match?.modelId ?? '(profile default)',
})}\n`)
