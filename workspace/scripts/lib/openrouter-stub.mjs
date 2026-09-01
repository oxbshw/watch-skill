/**
 * An OpenRouter-compatible provider that is not OpenRouter.
 *
 * The end-to-end claim this release has to support is "a person adds a
 * provider, chooses a model, assigns it to Chat, and the first prompt goes
 * exactly there and nowhere else". Proving it needs a provider. Using a real
 * one would mean a real key, a real charge, and a test whose result depends on
 * somebody else's uptime — and it would mean this repository's test suite could
 * send a person's prompt to a third party, which is the opposite of what the
 * product promises.
 *
 * So this is a provider the tests own. It speaks the OpenAI-compatible shape
 * OpenRouter speaks, answers deterministically, and records every request so
 * an assertion can be made about *what was sent* rather than only about what
 * came back — which is where the interesting failures are: a prompt carrying an
 * absolute workspace path, a request to a route nobody bound, a second call
 * nobody asked for.
 *
 * **It cannot become a real provider by accident.** It binds `127.0.0.1` and
 * nothing else, it is handed a port of 0 so the operating system picks one, and
 * its base URL is the only endpoint anything under test is pointed at. There is
 * no hostname in this file, no fallback to a public API, and no code path that
 * reads a credential from the environment.
 *
 * **Its credential is fake and is checked.** A request without the exact bearer
 * token gets a 401 in the provider's own shape, because "unauthorized" is one
 * of the states the product has to render correctly and a stub that accepted
 * anything could not produce it.
 *
 * @module scripts/lib/openrouter-stub
 */

import { createServer } from 'node:http'

/**
 * The credential the stub accepts.
 *
 * Obviously fake, deliberately. A test fixture that looked like a real key
 * would eventually be grepped for by somebody auditing a leak, and the answer
 * "that one is fine" is not one anybody should have to give twice.
 */
export const STUB_API_KEY = 'sk-stub-not-a-real-key-0000'

/** The models this provider advertises. Two, so choosing is a real choice. */
export const STUB_MODELS = [
  { id: 'stub/echo-small', name: 'Stub Echo Small', context_length: 8192 },
  { id: 'stub/echo-large', name: 'Stub Echo Large', context_length: 32768 },
]

/** The sentence every completion returns, so an assertion can look for it. */
export const STUB_REPLY = 'The stub provider answered.'

/** Read a whole request body. */
async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** Answer with JSON, in the shape an OpenAI-compatible client expects. */
function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
  })
  response.end(payload)
}

/**
 * One recorded request.
 *
 * `authorized` rather than the token: the recorder must be safe to print in a
 * failing assertion, and a fixture that echoed its own credential would teach
 * the next person that echoing a credential is fine.
 */
function record(method, url, headers, body) {
  let parsed = null
  try {
    parsed = body === '' ? null : JSON.parse(body)
  } catch {
    parsed = null
  }
  return {
    method,
    url,
    /** Whether the caller presented the exact expected token. */
    authorized: headers.authorization === `Bearer ${STUB_API_KEY}`,
    /** The parsed request, for assertions about what was actually sent. */
    body: parsed,
    /** The raw body, for assertions about what a payload must not contain. */
    raw: body,
    at: Date.now(),
  }
}

/**
 * The completion response, in the non-streaming shape.
 *
 * Deterministic to the byte. A stub that varied its answer would make every
 * assertion about rendering a flaky one.
 */
function completion(model) {
  return {
    id: 'chatcmpl-stub-1',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: STUB_REPLY },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }
}

/** The same answer as server-sent events, for a client that asked to stream. */
function streamChunks(model) {
  const frame = data => `data: ${JSON.stringify(data)}\n\n`
  const base = { id: 'chatcmpl-stub-1', object: 'chat.completion.chunk', created: 0, model }
  return [
    frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
    frame({ ...base, choices: [{ index: 0, delta: { content: STUB_REPLY }, finish_reason: null }] }),
    frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ].join('')
}

/**
 * What a completion request *was*, rather than merely that one happened.
 *
 * One prompt does not produce one request, and a test that asserted it did
 * would have been wrong about this product. A turn goes out carrying the
 * agent's whole toolset; the Host then makes a second, toolless call whose
 * system prompt asks for a session title. Both are legitimate, and the
 * difference between them is structural — the toolset — not a matter of
 * reading English out of a system prompt.
 *
 * The classification matters because the interesting failure is an
 * *unrecognised* extra call. "Two requests arrived" is compatible with a
 * silent retry, a second provider, or a background feature nobody reviewed
 * sending the same text somewhere else. Naming each one turns that from a
 * number into a claim.
 *
 * @param entry - one recorded request, as the stub stores it.
 * @param promptText - the exact text the caller sent, so a turn can be
 *   recognised by the message it carries rather than by its size.
 * @param credential - the token that must never appear in a body.
 */
export function classifyCompletion(entry, promptText, credential) {
  const body = entry.body ?? {}
  const messages = Array.isArray(body.messages) ? body.messages : []
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0
  const asText = message => (typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content ?? ''))

  const carriesPromptVerbatim = messages.some(
    message => message.role === 'user' && asText(message).trim() === promptText)
  const titled = messages.some(
    message => message.role === 'system'
      && /concise title/i.test(asText(message)))

  let kind = 'unrecognised'
  if (toolCount > 0 && carriesPromptVerbatim) kind = 'turn'
  else if (toolCount === 0 && titled) kind = 'session-title'

  const whole = entry.raw ?? ''
  return {
    kind,
    model: typeof body.model === 'string' ? body.model : null,
    authorized: entry.authorized,
    streamed: body.stream === true,
    toolCount,
    roles: messages.map(message => message.role),
    bytes: whole.length,
    /**
     * Whether the payload contains a Windows or POSIX absolute path.
     *
     * Recorded, not forbidden. A coding agent is told where it is working, so
     * its session workspace and the harness checkout reach the model by
     * design — asserting their absence would fail against correct behaviour.
     * What this flag is for is that the fact stays visible: the Bridge goes to
     * real trouble to keep a machine's paths out of what it emits, and the
     * Host's model context does not, so the two must not be described as if
     * they had the same disclosure.
     */
    mentionsAbsolutePath: /(?:^|[^A-Za-z])[A-Za-z]:[\\/]|\/(?:home|Users)\//.test(whole),
    /** The credential travels in a header. Finding it in a body is a defect. */
    leaksCredential: whole.includes(credential),
  }
}

/**
 * Start the stub provider.
 *
 * @param options.failWith - answer every completion with this status instead,
 *   so the product's unauthorized / rate-limited / unreachable cards can be
 *   exercised against a real HTTP response rather than a mocked one.
 * @param options.models - override the advertised catalogue, so "the model you
 *   chose is gone" is reachable without editing this file.
 * @returns the base URL, the recorded requests, and a way to stop it.
 */
export async function startOpenRouterStub({ failWith = null, models = STUB_MODELS } = {}) {
  const requests = []

  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const entry = record(request.method ?? 'GET', request.url ?? '/', request.headers, body)
      requests.push(entry)

      // Every path this provider answers is under a `/v1` prefix, with or
      // without OpenRouter's `/api` in front. Matching on the tail rather than
      // the whole path means a client that spells the base URL either way is
      // still talking to the same provider.
      const path = (request.url ?? '/').replace(/^\/api/, '').split('?')[0]

      if (path === '/v1/models') {
        // The catalogue is readable without a credential, which is what makes
        // "discover models before you have finished configuring" possible.
        json(response, 200, { data: models })
        return
      }

      if (path === '/v1/chat/completions') {
        if (!entry.authorized) {
          json(response, 401, {
            error: { message: 'No auth credentials found', code: 401, type: 'authentication_error' },
          })
          return
        }
        if (failWith !== null) {
          json(response, failWith, {
            error: { message: `stub refused with ${String(failWith)}`, code: failWith },
          })
          return
        }
        const model = typeof entry.body?.model === 'string' ? entry.body.model : 'stub/echo-small'
        if (entry.body?.stream === true) {
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          response.end(streamChunks(model))
          return
        }
        json(response, 200, completion(model))
        return
      }

      json(response, 404, { error: { message: `no stub route for ${path}`, code: 404 } })
    })()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    // Loopback only, and a port the operating system chooses. Neither is
    // configurable: a stub that could be told to bind an interface is a stub
    // that can be told to bind the wrong one.
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    /** What a provider profile's `baseURL` is set to. */
    baseURL: `http://127.0.0.1:${String(port)}/api/v1`,
    port,
    /** Every request the stub received, in order. */
    requests,
    /** Completion requests only, which is what "did it route?" asks about. */
    completions: () => requests.filter(entry => entry.url.includes('/chat/completions')),
    async stop() {
      await new Promise(resolve => { server.close(() => { resolve(undefined) }) })
    },
  }
}
