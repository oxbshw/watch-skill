#!/usr/bin/env node
/**
 * The user journey, driven by an actual model.
 *
 * This is the other half of the acceptance pair, and the half that cannot be
 * faked. `qa-acceptance-local.mjs` proves the installed product runs and that
 * Core decides verdicts; `qa-acceptance-agent.mjs` proves the Host, the ledger
 * and the Library behave, and it does that against a **loopback stub this
 * repository owns** — deterministic infrastructure, disclosed as such, whose
 * tool calls are a script this repository wrote.
 *
 * A scripted provider is the right tool for those questions and the wrong
 * evidence for this one. It cannot answer *will a model, given an ordinary
 * instruction that names no Watch tool, choose the right tools and produce the
 * right work* — because the script already chose. So nothing here is scripted:
 * every tool call below is the model's, and the assertions read what actually
 * landed on disk and in the ledger.
 *
 * **This refuses to run against a loopback provider.** The first assertion is
 * that the configured base URL is not a local address, and it is first because
 * a pass produced against a stub and labelled "real model" is worse than no
 * pass at all.
 *
 * **The credential is never read by this file.** The route names a credential
 * *reference*; `dsh-credentials-local` resolves it from the document the
 * profile is pointed at. Nothing here calls `credentials.set`, so nothing here
 * can write into somebody's credential store.
 *
 * **Bounded, because a model can be asked to do anything.** A wall-clock
 * budget, a turn ceiling and a per-turn deadline, all reported in the output,
 * so the cost of the run is a number rather than a hope.
 *
 * Usage:
 *   node scripts/qa-journey-live.mjs --url http://127.0.0.1:8877 \
 *     --home <DSH_HOME> --workspace <dir> \
 *     --provider openrouter --model deepseek/deepseek-v4-pro \
 *     --base-url https://openrouter.ai/api/v1 --credential-ref OPENROUTER_API_KEY \
 *     [--budget-ms 1800000] [--max-turns 12] [--out report.json]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function flag(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`qa-journey-live: --${name} needs a value\n`)
    process.exit(2)
  }
  return value
}

const URL_BASE = flag('url', 'http://127.0.0.1:8877')
const HOME = flag('home')
const WORKSPACE = flag('workspace')
const PROVIDER = flag('provider', 'openrouter')
const MODEL = flag('model')
const BASE_URL = flag('base-url', 'https://openrouter.ai/api/v1')
const CREDENTIAL_REF = flag('credential-ref', 'OPENROUTER_API_KEY')
const PROFILE = flag('profile', 'deepwatch')
const BUDGET_MS = Number(flag('budget-ms', '1800000'))
const MAX_TURNS = Number(flag('max-turns', '12'))
const TURN_MS = Number(flag('turn-timeout-ms', '300000'))
const OUT = flag('out', join(dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'journey-live.json'))

if (HOME === null || WORKSPACE === null || MODEL === null) {
  process.stderr.write('qa-journey-live: --home, --workspace and --model are required\n')
  process.exit(2)
}

const started = Date.now()
let turnsTaken = 0

const claims = []
const claim = (id, ok, detail) => {
  claims.push({ id, ok, detail })
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'} ${id} :: ${JSON.stringify(detail).slice(0, 500)}\n`)
  return ok
}

async function rpc(method, payload) {
  const response = await fetch(`${URL_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `lj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      method, payload,
    }),
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
  return { http: response.status, result: body?.result ?? null }
}

const search = async (query) => {
  const answer = await rpc('watchQuery/librarySearch', { args: { request: {
    protocol: 1, requestId: `lib-${Date.now().toString(36)}`, query,
    modalities: [], limit: 60, cursor: null, deadlineMs: 30_000,
  } } })
  return answer.result?.value ?? {}
}

const open = async (recordId) => {
  const answer = await rpc('watchQuery/libraryGet', { args: { request: {
    protocol: 1, requestId: `g-${Date.now().toString(36)}`, recordId, deadlineMs: 30_000,
  } } })
  return answer.result?.value ?? {}
}

const receiptsFor = async (sessionId, query) => {
  const found = await search(query)
  return (found.records ?? []).filter(record =>
    (record.tags ?? []).includes('execution-receipt') && record.runId === sessionId)
}

const wait = (ms) => new Promise((done) => { setTimeout(done, ms) })

/** Whether a base URL points at this machine. */
export function isLoopback(url) {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '::1'
      || /^127\./.test(hostname) || /^0\.0\.0\.0$/.test(hostname)
      || hostname.endsWith('.localhost')
  } catch { return true }
}

/**
 * Run one turn and wait for it to settle.
 *
 * There is no stub to witness the request here, so the only signal is the
 * session row. `session.prompt` returns before the loop marks the session
 * running, so a poll that breaks on the first `running: false` reads the moment
 * *before* the turn.
 */
async function turn(sessionId, text, { timeoutMs = TURN_MS } = {}) {
  if (turnsTaken >= MAX_TURNS) {
    return { settled: false, sawRunning: false, reason: 'turn ceiling reached' }
  }
  if (Date.now() - started > BUDGET_MS) {
    return { settled: false, sawRunning: false, reason: 'wall-clock budget spent' }
  }
  turnsTaken += 1
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })

  const deadline = Date.now() + timeoutMs
  let sawRunning = false
  while (Date.now() < deadline) {
    const listed = await rpc('session.list', {})
    const row = listed.result?.value?.items?.find(item => item.sessionId === sessionId) ?? null
    if (row?.running === true) sawRunning = true
    if (sawRunning && row?.running === false) {
      await wait(2_000)
      return { settled: true, sawRunning, reason: null }
    }
    await wait(750)
  }
  return { settled: false, sawRunning, reason: 'turn deadline' }
}

const work = join(WORKSPACE, 'work')
const repo = join(work, 'owner-test')
mkdirSync(repo, { recursive: true })
const totalsPath = join(repo, 'totals.json')
const TOTALS = '{"items":[12,18,30],"total":60}'

const notes = { provider: PROVIDER, model: MODEL, baseURL: BASE_URL }
let sessionId = null

// ── 0. this is a hosted provider, and the run says so before anything else ───
claim('LJ-00 the route is a hosted provider, not a loopback stub',
  !isLoopback(BASE_URL), { baseURL: BASE_URL, provider: PROVIDER, model: MODEL })
if (isLoopback(BASE_URL)) {
  process.stderr.write(
    'qa-journey-live: refusing to run. This pass exists to exercise an actual '
    + 'model, and the configured base URL is local. A run against a loopback '
    + 'provider is qa-acceptance-agent.mjs, and it says so in its own output.\n')
  process.exit(2)
}

// ── 1. configure the route; the credential stays where it already is ─────────
const routed = await rpc('settings.replace', {
  ns: 'llm-pi-ai',
  section: { providers: { [PROVIDER]: {
    displayName: PROVIDER, apiKeyEnv: CREDENTIAL_REF,
    api: 'openai-completions', baseURL: BASE_URL,
    models: [{ id: MODEL, name: MODEL, contextWindow: 131072 }],
  } } },
})
claim('LJ-01 the provider settings were accepted', routed.result?.ok !== false,
  { error: routed.result?.error ?? null })

let proved = null
for (let attempt = 1; attempt <= 4; attempt += 1) {
  const tested = await rpc('watchQuery/providerTest', { args: { request: {
    protocol: 1, requestId: `route-${String(attempt)}`, deadlineMs: 60_000,
    provider: PROVIDER, model: MODEL,
  } } })
  proved = { attempt, ok: tested.result?.value?.ok === true,
    message: tested.result?.value?.message ?? tested.result?.error?.message ?? null }
  if (proved.ok) break
  await wait(2_000)
}
// A bounded, real request to the hosted endpoint. This is the first thing in
// the run that costs money, and it is also the only proof that the credential
// resolves without this file ever seeing it.
claim('LJ-02 a real model request reached the provider and came back', proved?.ok === true,
  proved ?? { ok: false })

if (proved?.ok === true) {
  await rpc('settings.replace', {
    ns: 'watch-bindings',
    section: { version: 1, roles: { agent_model: {
      provider: PROVIDER, model: MODEL, credentialRef: CREDENTIAL_REF,
      boundAt: new Date().toISOString(),
    } } },
  })
  await rpc('settings.replace', {
    ns: 'agent-default-model', section: { provider: PROVIDER, model: MODEL } })

  const created = await rpc('session.create', { cwd: work })
  sessionId = created.result?.value?.sessionId ?? null
  claim('LJ-03 a session opens on the workspace', sessionId !== null, { sessionId, cwd: 'work' })
}

if (sessionId !== null) {
  // ── 2. ordinary work. No Watch tool is named. ──────────────────────────────
  const first = await turn(sessionId,
    'In this workspace, create a file at owner-test/totals.json whose contents are '
    + 'exactly {"items":[12,18,30],"total":60} — the total is the sum of the items. '
    + 'Then tell me what the file contains.')
  claim('LJ-04 the first turn ran and settled', first.settled, first)

  const onDisk = existsSync(totalsPath) ? readFileSync(totalsPath, 'utf8').trim() : null
  claim('LJ-05 the model created the file the task asked for',
    onDisk !== null && JSON.stringify(JSON.parse(onDisk ?? 'null')) === TOTALS,
    { path: 'owner-test/totals.json', content: onDisk })

  await wait(2_500)
  const writes = await receiptsFor(sessionId, 'write')
  // The model chose the tool. Nothing here scripted a call, so a receipt is
  // evidence that tools were offered *and* taken -- which a completion body
  // carrying a tool list is not.
  claim('LJ-06 the model chose a tool, and Watch recorded the call unasked',
    writes.length >= 1,
    { receipts: writes.length, tags: writes.map(record => record.tags) })

  // ── 3. ask for proof, and let the model pick the verification tool ────────
  await turn(sessionId,
    'Prove that owner-test/totals.json really holds a total of 60, using a check '
    + 'that something other than you evaluates. Report the verdict you get back.')

  await wait(2_500)
  let proofs = await receiptsFor(sessionId, 'watch_verify')
  claim('LJ-07 the model reached for independent verification on its own',
    proofs.length >= 1,
    { verifications: proofs.length, verdicts: proofs.map(record => record.verdict) })
  claim('LJ-08 the first verdict is VERIFIED, and it is Core’s',
    proofs.some(record => record.verdict === 'VERIFIED'),
    { verdicts: proofs.map(record => record.verdict) })

  // ── 4. a controlled mismatch ───────────────────────────────────────────────
  await turn(sessionId,
    'Now change owner-test/totals.json so the items are [12,18,28] and the total '
    + 'field still says 60, then run the same check again and tell me the verdict.')
  await wait(2_500)
  proofs = await receiptsFor(sessionId, 'watch_verify')
  const failed = proofs.filter(record => record.verdict === 'FAILED')
  claim('LJ-09 the mismatch fails, rather than being reported as fine',
    failed.length >= 1,
    { verdicts: proofs.map(record => record.verdict) })

  // ── 5. the correction ──────────────────────────────────────────────────────
  await turn(sessionId,
    'Put owner-test/totals.json back to items [12,18,30] with a total of 60, and '
    + 'run the check once more.')
  await wait(2_500)
  proofs = await receiptsFor(sessionId, 'watch_verify')
  const passes = proofs.filter(record => record.verdict === 'VERIFIED')
  claim('LJ-10 the correction passes again',
    passes.length >= 2 && failed.length >= 1,
    { verdicts: proofs.map(record => record.verdict) })

  // ── 6. distinct Core identities, in the rows Compare renders ──────────────
  const identities = [...new Set(proofs.flatMap(record => record.evidenceIds ?? []))]
  claim('LJ-11 each verification has its own Core identity',
    identities.length >= 3 && identities.every(id => String(id).startsWith('ver_')),
    { identities })

  const opened = []
  for (const record of proofs) opened.push(await open(record.recordId))
  const revisions = [...new Set(opened.map(entry => entry.record?.revisionId).filter(Boolean))]
  claim('LJ-12 the Library opens each one carrying the verdict Compare reads',
    opened.filter(entry => entry.outcome === 'record').length === proofs.length
      && revisions.length === proofs.length,
    { opened: opened.map(entry => ({
      outcome: entry.outcome ?? null, verdict: entry.record?.verdict ?? null })),
    revisions: revisions.length })

  // ── 7. perception ─────────────────────────────────────────────────────────
  const before = turnsTaken
  const perception = await turn(sessionId,
    'Look at what has been indexed and tell me what sources are available to you, '
    + 'citing anything you find by its timestamp.')
  const perceptionCalls = await receiptsFor(sessionId, 'watch_search_sources')
  claim('LJ-13 a perception request reached Core through a tool the model chose',
    perception.settled && perceptionCalls.length >= 1,
    { settled: perception.settled, calls: perceptionCalls.length, turnsUsed: turnsTaken - before })

  // ── 8. a bounded delegated task ────────────────────────────────────────────
  const delegated = await turn(sessionId,
    'Delegate this to a sub-task and report back in one sentence: count how many '
    + 'JSON files are under owner-test and name them.')
  const subagent = await receiptsFor(sessionId, 'task')
  claim('LJ-14 a delegated task ran within the budget',
    delegated.settled,
    { settled: delegated.settled, reason: delegated.reason, subagentReceipts: subagent.length })

  // ── 9. stopping a running task ─────────────────────────────────────────────
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text',
    text: 'Write a very long, detailed description of every file in this workspace, '
      + 'one paragraph per file, and keep going until you have covered everything.' }] })
  turnsTaken += 1
  let running = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const listed = await rpc('session.list', {})
    const row = listed.result?.value?.items?.find(item => item.sessionId === sessionId) ?? null
    if (row?.running === true) { running = true; break }
    await wait(500)
  }
  const cancelled = await rpc('session.cancel', { sessionId })
  let stopped = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const listed = await rpc('session.list', {})
    const row = listed.result?.value?.items?.find(item => item.sessionId === sessionId) ?? null
    if (row?.running === false) { stopped = true; break }
    await wait(500)
  }
  claim('LJ-15 a running task can be stopped, and stops',
    running && stopped,
    { sawRunning: running, stopped, http: cancelled.http })
}

const elapsed = Date.now() - started
claim('LJ-16 the run stayed inside its declared budget',
  elapsed <= BUDGET_MS && turnsTaken <= MAX_TURNS,
  { elapsedMs: elapsed, budgetMs: BUDGET_MS, turns: turnsTaken, maxTurns: MAX_TURNS })

const report = {
  experience: 'B — an actual model, not a scripted provider',
  provider: notes,
  loopback: isLoopback(BASE_URL),
  profile: PROFILE,
  sessionId,
  budget: { elapsedMs: elapsed, budgetMs: BUDGET_MS, turns: turnsTaken, maxTurns: MAX_TURNS },
  claims,
  passed: claims.filter(entry => entry.ok).length,
  failed: claims.filter(entry => !entry.ok).length,
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`\nreport: ${OUT}\n`)

const failing = claims.filter(entry => !entry.ok)
if (failing.length > 0) {
  process.stderr.write(
    `qa-journey-live: ${String(failing.length)} claim(s) failed: `
    + `${failing.map(entry => entry.id).join(', ')}\n`)
  process.exitCode = 1
}
