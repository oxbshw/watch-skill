/**
 * Configure, prove and bind a loopback provider route, or say exactly why not.
 *
 * Every packed gate in this repository starts the same way: point the Host at a
 * stub, prove the route, bind it, take a turn. When that setup half-succeeds the
 * failure surfaces much later and in the wrong place — a gate once reported
 * "the default profile offers no agent tools" because the provider settings had
 * not taken and the turn never reached the stub at all. The tools were fine.
 *
 * Two things prevent that, and both are here rather than copied into each gate:
 *
 *   - **The stub is the witness.** `providerTest` returning false is ambiguous;
 *     the same false covers "the Host never applied the settings" and "the
 *     route was applied and failed". The stub knows which: it either saw a
 *     request or it did not. Reporting that distinction is the difference
 *     between an actionable failure and a mystery.
 *   - **Applying settings is not instantaneous.** The proof is retried on a
 *     bounded schedule instead of raced once, and every attempt is recorded, so
 *     a flaky route is visible as a flaky route rather than as a pass.
 */

const PROVIDER = 'stub-local'
const MODEL = 'stub/echo-small'
const CREDENTIAL_REF = 'STUB_LOCAL_API_KEY'

/** How many times the route is proved before the gate gives up, and how far apart. */
const ATTEMPTS = 6
const SPACING_MS = 1_500

export const ROUTE = { provider: PROVIDER, model: MODEL, credentialRef: CREDENTIAL_REF }

/**
 * Point the Host at `stub`, prove the route, and bind it for agent turns.
 *
 * Returns `{ ok, attempts, diagnosis }`. `diagnosis` is written for somebody
 * reading a failed CI job, and names the next thing to look at rather than
 * restating that something went wrong.
 */
export async function proveLoopbackRoute({ rpc, stub, apiKey }) {
  const attempts = []

  const stored = await rpc('credentials.set', { ref: CREDENTIAL_REF, value: apiKey })
  const routed = await rpc('settings.replace', {
    ns: 'llm-pi-ai',
    section: { providers: { [PROVIDER]: {
      displayName: 'Loopback stub', apiKeyEnv: CREDENTIAL_REF,
      api: 'openai-completions', baseURL: stub.baseURL,
      models: [{ id: MODEL, name: 'Stub Echo Small', contextWindow: 8192 }],
    } } },
  })

  if (stored.result?.ok === false || routed.result?.ok === false) {
    return {
      ok: false,
      attempts,
      diagnosis: 'the Host rejected the provider settings themselves, so nothing '
        + 'downstream is meaningful. Check `credentials.set` and `settings.replace` '
        + `errors: ${JSON.stringify({
          credentials: stored.result?.error ?? null, providers: routed.result?.error ?? null })}`,
    }
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const before = stub.requests.length
    const tested = await rpc('watchQuery/providerTest', { args: { request: {
      protocol: 1, requestId: `route-${String(attempt)}`, deadlineMs: 20_000,
      provider: PROVIDER, model: MODEL,
    } } })
    const ok = tested.result?.value?.ok === true
    const reached = stub.requests.length > before
    attempts.push({
      attempt, ok, reachedStub: reached,
      message: tested.result?.value?.message ?? tested.result?.error?.message ?? null,
    })
    if (ok) break
    if (attempt < ATTEMPTS) await new Promise((done) => { setTimeout(done, SPACING_MS) })
  }

  const proved = attempts[attempts.length - 1]?.ok === true
  if (!proved) {
    const everReached = attempts.some(entry => entry.reachedStub)
    return {
      ok: false,
      attempts,
      diagnosis: everReached
        ? 'the Host reached the loopback stub and the route still failed, so the '
          + 'fault is in the request or the stub\'s answer, not in the settings. '
          + `Last message: ${String(attempts[attempts.length - 1]?.message ?? 'none')}`
        : 'the Host never contacted the loopback stub, so the provider settings '
          + 'did not take effect. A previous run\'s provider may still be bound; '
          + 'check that `settings.replace` for `llm-pi-ai` is applied before '
          + '`providerTest` runs, and that no earlier stub URL is cached.',
    }
  }

  // Bound only after the route is proved, so a binding never points at a route
  // nobody has shown to work.
  await rpc('settings.replace', {
    ns: 'watch-bindings',
    section: { version: 1, roles: { agent_model: {
      provider: PROVIDER, model: MODEL, credentialRef: CREDENTIAL_REF,
      boundAt: new Date().toISOString(),
    } } },
  })
  await rpc('settings.replace', {
    ns: 'agent-default-model', section: { provider: PROVIDER, model: MODEL } })

  return { ok: true, attempts, diagnosis: null }
}

/**
 * Wait for a turn to run and finish.
 *
 * `session.prompt` returns before the loop marks the session running, so a poll
 * that breaks on the first `running: false` reads the moment *before* the turn
 * and reports a settled session that never started. Wait for the transition.
 */
export async function settleTurn({ rpc, stub, sessionId, timeoutMs = 180_000 }) {
  const deadline = Date.now() + timeoutMs
  let sawRunning = false
  while (Date.now() < deadline) {
    const listed = await rpc('session.list', {})
    const row = listed.result?.value?.items?.find(item => item.sessionId === sessionId) ?? null
    if (row !== null && row.running === true) sawRunning = true
    if (!sawRunning && stub.completions().length > 0) sawRunning = true
    if (sawRunning && row !== null && row.running === false) {
      // The final completion can still be in flight when the row flips, and
      // these gates read request bodies rather than the reply.
      await new Promise((done) => { setTimeout(done, 2_000) })
      return { settled: true, sawRunning }
    }
    await new Promise((done) => { setTimeout(done, 500) })
  }
  return { settled: false, sawRunning }
}
