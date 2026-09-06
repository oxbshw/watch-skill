/**
 * What the end-to-end pass is allowed to conclude from two HTTP requests.
 *
 * The browser pass asserts that one prompt produces exactly one turn and no
 * unrecognised call. That assertion is only worth its line if it can fail, and
 * on a green run nothing demonstrates that it can — the classifier could
 * return `'turn'` for everything and the pass would still be green, while
 * quietly having stopped checking anything at all.
 *
 * So the cases live here, where a wrong answer is visible without a browser, a
 * profile, or a fifteen-minute Electron run.
 *
 * @module tests/stub-classification
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyCompletion, STUB_API_KEY } from '../scripts/lib/openrouter-stub.mjs'

const PROMPT = 'Say hello.'

/** One recorded request, in the shape the stub stores. */
function entry(body, { authorized = true } = {}) {
  const raw = JSON.stringify(body)
  return { method: 'POST', url: '/api/v1/chat/completions', authorized, body, raw }
}

/** A turn: the agent's toolset, and the person's message carried verbatim. */
function turn({ tools = 47, text = PROMPT, system = 'You are an AI agent.' } = {}) {
  return entry({
    model: 'ai21/jamba-large-1.7',
    stream: true,
    tools: Array.from({ length: tools }, (_, at) => ({ name: `tool_${String(at)}` })),
    messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
  })
}

/** The Host's second, toolless call, which asks the model to name the session. */
function title() {
  return entry({
    model: 'ai21/jamba-large-1.7',
    stream: true,
    tools: [],
    messages: [
      { role: 'system', content: 'Create a concise title for an AI coding-assistant session.' },
      { role: 'user', content: `Generate the session title from this JSON array of human messages:\n[{"seq":7,"text":"${PROMPT}"}]` },
    ],
  })
}

test('the prompt-carrying call with a toolset is a turn', () => {
  const seen = classifyCompletion(turn(), PROMPT, STUB_API_KEY)
  assert.equal(seen.kind, 'turn')
  assert.equal(seen.toolCount, 47)
  assert.equal(seen.model, 'ai21/jamba-large-1.7')
  assert.equal(seen.streamed, true)
})

test('the toolless title call is named, not merely tolerated', () => {
  assert.equal(classifyCompletion(title(), PROMPT, STUB_API_KEY).kind, 'session-title')
})

test('the bounded provider probe is named in both OpenAI token-field shapes', () => {
  for (const tokenField of ['max_tokens', 'max_completion_tokens']) {
    const probe = entry({
      model: 'stub/echo-small', stream: true, [tokenField]: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
    })
    assert.equal(classifyCompletion(probe, PROMPT, STUB_API_KEY).kind, 'provider-test')
  }
})

test('the title call is not mistaken for a second turn', () => {
  // It quotes the prompt inside its JSON argument, so a classifier that looked
  // for the text anywhere in the payload would count two turns and the browser
  // pass would fail every run for the wrong reason.
  const seen = classifyCompletion(title(), PROMPT, STUB_API_KEY)
  assert.notEqual(seen.kind, 'turn')
})

test('a call this harness cannot name is unrecognised', () => {
  // The case the assertion exists for: something sent the same conversation
  // somewhere nobody reviewed. It has no toolset and is not asking for a
  // title, so it must not fall into either bucket by default.
  const stray = entry({
    model: 'ai21/jamba-large-1.7',
    tools: [],
    messages: [
      { role: 'system', content: 'Summarise this conversation for analytics.' },
      { role: 'user', content: PROMPT },
    ],
  })
  assert.equal(classifyCompletion(stray, PROMPT, STUB_API_KEY).kind, 'unrecognised')
})

test('a turn that does not carry the prompt verbatim is unrecognised', () => {
  // A retry that paraphrased, or a second agent's own request, still has the
  // toolset. Requiring the exact text is what separates "the message the
  // person typed went out once" from "some request with tools happened".
  const other = turn({ text: 'Say hello, but differently.' })
  assert.equal(classifyCompletion(other, PROMPT, STUB_API_KEY).kind, 'unrecognised')
})

test('a credential in the body is reported, wherever it appears', () => {
  const leaky = turn({ system: `You are an AI agent. Key: ${STUB_API_KEY}` })
  assert.equal(classifyCompletion(leaky, PROMPT, STUB_API_KEY).leaksCredential, true)
  assert.equal(classifyCompletion(turn(), PROMPT, STUB_API_KEY).leaksCredential, false)
})

test('absolute paths are detected, and URLs are not paths', () => {
  const windows = turn({ system: 'Checkout at D:\\watch-handoff\\home\\harness\\.' })
  assert.equal(classifyCompletion(windows, PROMPT, STUB_API_KEY).mentionsAbsolutePath, true)

  const posix = turn({ system: 'Workspace is /home/example/project.' })
  assert.equal(classifyCompletion(posix, PROMPT, STUB_API_KEY).mentionsAbsolutePath, true)

  // `https://` ends in `s:/`, which a naive drive-letter pattern matches. The
  // flag would then be true for every request and would mean nothing.
  const url = turn({ system: 'The provider is at https://openrouter.ai/api/v1.' })
  assert.equal(classifyCompletion(url, PROMPT, STUB_API_KEY).mentionsAbsolutePath, false)
})

test('an unauthorized request is still classified, and still marked', () => {
  // The 401 path has to stay legible: a rejected call is evidence about what
  // was attempted, so it must not be dropped from the accounting.
  const seen = classifyCompletion(turn(), PROMPT, STUB_API_KEY)
  const rejected = classifyCompletion({ ...turn(), authorized: false }, PROMPT, STUB_API_KEY)
  assert.equal(seen.authorized, true)
  assert.equal(rejected.authorized, false)
  assert.equal(rejected.kind, 'turn')
})
