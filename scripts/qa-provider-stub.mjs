#!/usr/bin/env node
/**
 * A deterministic OpenAI-compatible endpoint, for QA only.
 *
 * The mode screenshots need a session that is not blank, and DSH only shows the
 * session header once a turn has happened. A turn needs a model. That does not
 * mean it needs a paid one: the wire contract is small and entirely
 * reproducible, so QA can serve it locally instead.
 *
 * What this is not: it is not a provider, it is not offered in the catalogue,
 * and nothing in the shipped tree references it. It lives in `scripts/`, it is
 * started by the capture harness and stopped by it, and it binds to loopback so
 * it is unreachable from anywhere else.
 *
 * What it serves:
 *
 *   GET  /v1/models             one model, so discovery succeeds
 *   POST /v1/chat/completions   a fixed reply, streamed as SSE
 *
 * Every reply is the same text. That is the point -- a screenshot of a
 * different sentence each run is not a regression signal.
 *
 * Usage:
 *   node scripts/qa-provider-stub.mjs [--port 0] [--model watch-qa-stub]
 *
 * Prints one JSON line with the bound address, then serves until killed.
 */

import { createServer } from 'node:http'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const PORT = Number(flag('port', '0'))
const MODEL = flag('model', 'watch-qa-stub')

/** The only thing this ever says. Fixed so two captures compare. */
const REPLY = 'This is the QA stub responding locally. No provider was contacted.'

/** Loopback only. Binding anywhere else would make this reachable off-machine. */
const HOST = '127.0.0.1'

function sse(response, chunks) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

/** One completion, split into a few deltas so streaming is exercised. */
function completion(id) {
  const words = REPLY.split(' ')
  const base = { id, object: 'chat.completion.chunk', created: 0, model: MODEL }
  const chunks = words.map((word, at) => ({
    ...base,
    choices: [{
      index: 0,
      delta: at === 0 ? { role: 'assistant', content: word } : { content: ` ${word}` },
      finish_reason: null,
    }],
  }))
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: words.length, total_tokens: 8 + words.length },
  })
  return chunks
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}`)
  const path = url.pathname.replace(/^\/v1/, '')

  if (request.method === 'GET' && path === '/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'watch-qa' }],
    }))
    return
  }

  if (request.method === 'POST' && path === '/chat/completions') {
    // The body is drained and discarded. A stub that varied with the prompt
    // would make two captures of the same screen differ.
    request.resume()
    request.on('end', () => {
      sse(response, completion(`qa-${String(Date.now())}`))
    })
    return
  }

  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: `no such endpoint: ${path}`, type: 'invalid_request_error' } }))
})

server.listen(PORT, HOST, () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : PORT
  process.stdout.write(`${JSON.stringify({
    ready: true,
    baseURL: `http://${HOST}:${String(port)}/v1`,
    model: MODEL,
    pid: process.pid,
  })}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(() => { process.exit(0) }) })
}
