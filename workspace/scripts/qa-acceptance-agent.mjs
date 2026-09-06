#!/usr/bin/env node
/**
 * The agent's acceptance pass: real work, real receipts, real verdicts.
 *
 * The second of the two experiences. Experience A proves the product runs and
 * that Core decides verdicts; this one proves the part that is easy to claim
 * and hard to demonstrate — that an agent doing ordinary work leaves a record
 * a person can open afterwards, and that Core's answer is *in* that record.
 *
 * The provider is a loopback stub this repository owns, disclosed as such. It
 * is not a hosted provider and this pass makes no claim about one: the point
 * under test is the Host, the ledger, the Bridge and the Library, all of which
 * behave identically whichever model is answering. Every tool call below is
 * dispatched by the real DSH tool runner through the real `deepwatch` profile.
 *
 * What it establishes, in order:
 *
 *   1. an ordinary write lands on disk and is recorded without being asked
 *   2. `watch_verify` reaches Core, and **the verdict reaches the receipt** —
 *      the defect this release exists to close was that every receipt read
 *      `verdict: null` while Core had answered
 *   3. the verified row is reachable through the Library's own transport and
 *      addressable through `libraryGet`, which is the data Compare renders
 *   4. a real failure, a repair, and a second pass: the row moves
 *      FAILED -> VERIFIED and both verdicts are Core's, with distinct ids
 *   5. a write outside the workspace is refused and recorded as refused
 *   6. observe -> act -> verify over media the agent did not produce
 *   7. the Host is restarted and the evidence is still there
 *   8. the journal is torn mid-write and the earlier receipts survive it
 *
 * Usage:
 *   node scripts/qa-acceptance-agent.mjs --url http://127.0.0.1:8877 \
 *     --home <DSH_HOME> --workspace <dir> --core-bin <exe> \
 *     --restart-cmd-file <file with the argv to restart the Host> [--out report.json]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { startOpenRouterStub, STUB_API_KEY } = await import(
  pathToFileURL(join(HERE, 'lib', 'openrouter-stub.mjs')).href)
const { proveLoopbackRoute, settleTurn } = await import(
  pathToFileURL(join(HERE, 'lib', 'loopback-route.mjs')).href)

function flag(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`qa-acceptance-agent: --${name} needs a value\n`)
    process.exit(2)
  }
  return value
}

const URL_BASE = flag('url', 'http://127.0.0.1:8877')
const HOME = flag('home')
const WORKSPACE = flag('workspace')
const CORE_BIN = flag('core-bin')
const PROFILE = flag('profile', 'deepwatch')
/**
 * Which half of the pass this invocation is.
 *
 * `work` does the work and records which sessions did it. `after-restart` is
 * run against a Host that has been stopped and started since, and asks the
 * only question that matters about durable evidence: is it still there. The
 * two cannot be one program — a process cannot restart the server it is
 * talking to and still be the thing that proves the restart happened.
 */
const PHASE = flag('phase', 'work')
/** Where the profile journals its receipts, for the fault-injection half. */
const RECEIPTS = flag('receipts', null)
/** The room's Python, used only to serve the rights-clear browser fixture. */
const PYTHON = flag('python', null)
/** On-screen text in a clip Core indexed earlier, so the read has ground truth. */
const MEDIA_TOKEN = flag('media-token', 'ACCEPTANCE7391')
const OUT = flag('out', join(HERE, '..', 'qa', 'acceptance-agent.json'))

if (HOME === null || WORKSPACE === null || CORE_BIN === null) {
  process.stderr.write(
    'qa-acceptance-agent: --home, --workspace and --core-bin are required\n')
  process.exit(2)
}

const claims = []
const notes = {}
const claim = (id, ok, detail) => {
  claims.push({ id, ok, detail })
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'} ${id} :: ${JSON.stringify(detail).slice(0, 480)}\n`)
  return ok
}

async function rpc(method, payload) {
  const response = await fetch(`${URL_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      method, payload,
    }),
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
  return { http: response.status, result: body?.result ?? null }
}

const search = async (query, limit = 100) => {
  const answer = await rpc('watchQuery/librarySearch', { args: { request: {
    protocol: 1, requestId: `s-${Date.now().toString(36)}`, query,
    modalities: [], limit, cursor: null, deadlineMs: 30_000,
  } } })
  return answer.result?.value ?? {}
}

const get = async (recordId) => {
  const answer = await rpc('watchQuery/libraryGet', { args: { request: {
    protocol: 1, requestId: `g-${Date.now().toString(36)}`, recordId, deadlineMs: 30_000,
  } } })
  return answer.result?.value ?? {}
}

/** Every receipt this session filed, newest revision per record. */
const receiptsFor = async (sessionId, query = 'write') => {
  const found = await search(query)
  return (found.records ?? []).filter(record =>
    (record.tags ?? []).includes('execution-receipt') && record.runId === sessionId)
}

const settleFor = (ms) => new Promise((done) => { setTimeout(done, ms) })

// ── the second invocation ────────────────────────────────────────────────────

if (PHASE === 'after-restart') {
  // Everything below this block did the work. This asks the only question
  // that makes evidence durable: after the Host was stopped and started, and
  // after a write was interrupted mid-line, is it still there and still
  // openable.
  const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
  if (previous === null || typeof previous.sessionId !== 'string') {
    process.stderr.write(
      `qa-acceptance-agent: --phase after-restart needs the report from the work `
      + `phase at ${OUT}\n`)
    process.exit(2)
  }

  const before = (previous.receipts ?? []).filter(record => record.recordId !== undefined)
  const restored = []
  for (const record of before) {
    const answer = await get(record.recordId)
    restored.push({
      recordId: record.recordId,
      wanted: record.verdict ?? null,
      outcome: answer.outcome ?? null,
      verdict: answer.record?.verdict ?? null,
    })
  }

  const found = restored.filter(entry => entry.outcome === 'record')
  claim('AG-26 every receipt from before the restart is still openable',
    before.length > 0 && found.length === before.length,
    { before: before.length, found: found.length,
      missing: restored.filter(entry => entry.outcome !== 'record')
        .map(entry => entry.recordId) })

  claim('AG-27 and each one still carries the verdict it was given',
    restored.every(entry => entry.verdict === entry.wanted),
    { mismatched: restored.filter(entry => entry.verdict !== entry.wanted) })

  const searched = await search('VERIFIED')
  claim('AG-28 the restored rows are searchable, not merely addressable',
    (searched.records ?? []).some(record => record.runId === previous.sessionId
      && record.verdict === 'VERIFIED'),
    { total: searched.total ?? 0, indexState: searched.indexState ?? null })

  // The journal is what brought them back, so it has to be readable still —
  // and, after a torn write, repaired rather than abandoned.
  if (RECEIPTS !== null) {
    const journal = join(RECEIPTS, 'receipts.jsonl')
    const text = existsSync(journal) ? readFileSync(journal, 'utf8') : ''
    const lines = text.split('\n').filter(line => line.trim() !== '')
    let damaged = 0
    for (const line of lines) { try { JSON.parse(line) } catch { damaged += 1 } }
    claim('AG-29 the journal was repaired, not abandoned',
      text.endsWith('\n') && damaged === 0,
      { lines: lines.length, damaged, endsCleanly: text.endsWith('\n') })
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(join(dirname(OUT), 'acceptance-agent-after-restart.json'),
    `${JSON.stringify({ phase: PHASE, sessionId: previous.sessionId, restored, claims,
      passed: claims.filter(entry => entry.ok).length,
      failed: claims.filter(entry => !entry.ok).length }, null, 2)}\n`, 'utf8')

  const stillFailing = claims.filter(entry => !entry.ok)
  if (stillFailing.length > 0) {
    process.stderr.write(
      `qa-acceptance-agent: ${String(stillFailing.length)} claim(s) failed after the `
      + `restart: ${stillFailing.map(entry => entry.id).join(', ')}\n`)
    process.exit(1)
  }
  process.stdout.write('qa-acceptance-agent: the evidence survived the restart\n')
  process.exit(0)
}

// ── the workspace the agent works in ─────────────────────────────────────────

// The session opens on `work`, so `owner-test/totals.json` is the relative
// path the agent is asked for. `outside` is a sibling of the session's root
// rather than a directory inside it: a containment claim about a path the
// workspace legitimately contains proves nothing.
const work = join(WORKSPACE, 'work')
const repo = join(work, 'owner-test')
const outside = join(WORKSPACE, 'outside')
mkdirSync(repo, { recursive: true })
mkdirSync(outside, { recursive: true })

/**
 * The deliberately broken local app Core ships for exactly this.
 *
 * Rights-clear and written in this repository: recording a real website would
 * make the acceptance depend on somebody else's uptime and somebody else's
 * copyright. Started here and stopped in `finally`; `file://` is refused by
 * the live surface whatever anybody asks, so a served page is the only way in.
 */
async function startFixtureApp() {
  if (PYTHON === null) return null
  const child = spawn(PYTHON, ['-c',
    'from watch_skill.live.fixture_app import FixtureApp\n'
    + 'import time\n'
    + 'app = FixtureApp().start()\n'
    + 'print(app.base_url, flush=True)\n'
    + 'time.sleep(1800)\n'],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(null) }, 30_000)
    let seen = ''
    child.stdout.on('data', (chunk) => {
      seen += String(chunk)
      const line = /https?:\/\/[^\s]+/.exec(seen)
      if (line !== null) { clearTimeout(timer); resolve(line[0]) }
    })
  })
  return url === null ? null : { child, url }
}

const fixture = await startFixtureApp()

const TOTALS = '{"items":[12,18,30],"total":60}'
const WRONG = '{"items":[12,18,28],"total":58}'
const totalsPath = join(repo, 'totals.json')
const escapePath = join(outside, 'escape.json')

const seenPath = join(repo, 'seen.json')
const SEEN = `{"token":"${MEDIA_TOKEN}"}`
const SEEN_CHECKS = [{
  id: 'wrote-what-it-saw', type: 'json_value', required: true,
  description: 'the file records the text the search actually returned',
  params: { path: 'owner-test/seen.json', pointer: '/token', equals: MEDIA_TOKEN },
}]

/** The contract the agent asks Core to evaluate. Stated once, asked three times. */
const CHECKS = [{
  id: 'total-is-60', type: 'json_value', required: true,
  description: 'the total equals the sum of the items',
  params: { path: 'owner-test/totals.json', pointer: '/total', equals: 60 },
}]

const stub = await startOpenRouterStub({
  script: [
    // Turn 1 — do the work, then prove it.
    { name: 'write', arguments: { file_path: totalsPath, content: TOTALS } },
    { name: 'watch_verify', arguments: {
      expectation: 'owner-test/totals.json holds a total of 60', checks: CHECKS } },
    // Turn 2 — break it, find out, repair it, prove it again.
    { name: 'write', arguments: { file_path: totalsPath, content: WRONG } },
    { name: 'watch_verify', arguments: {
      expectation: 'owner-test/totals.json holds a total of 60', checks: CHECKS } },
    { name: 'write', arguments: { file_path: totalsPath, content: TOTALS } },
    { name: 'watch_verify', arguments: {
      expectation: 'owner-test/totals.json holds a total of 60', checks: CHECKS } },
    // The same tool, the same shape, outside the workspace.
    { name: 'write', arguments: { file_path: escapePath, content: TOTALS } },
    // Media: observe what Core indexed, act on it, prove the act.
    { name: 'watch_search_sources', arguments: { query: MEDIA_TOKEN } },
    { name: 'write', arguments: { file_path: seenPath, content: SEEN } },
    { name: 'watch_verify', arguments: {
      expectation: 'owner-test/seen.json records the text the search returned',
      checks: SEEN_CHECKS } },
  ],
})
process.stdout.write(`stub: ${stub.baseURL}\n`)

let report = null
let browserStub = null

/** Run one prompt to completion and return the session it ran in. */
async function turn(sessionId, text) {
  await rpc('session.prompt', {
    sessionId, mode: 'queue', content: [{ type: 'text', text }],
  })
  const settled = await settleTurn({ rpc, stub, sessionId })
  await settleFor(2500)
  return settled
}

try {
  // ── 0. the room, and a proved route into the stub ──────────────────────────
  const profileDir = join(HOME, 'profiles', PROFILE)
  const manifest = existsSync(join(profileDir, 'package.json'))
    ? JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    : null
  claim(`AG-00 the journey runs against the default ${PROFILE} profile`,
    (manifest?.dsh?.profile?.bundles ?? []).includes('@deepwatch/dsh-bundle'),
    { profileDir, bundles: manifest?.dsh?.profile?.bundles ?? [] })

  const route = await proveLoopbackRoute({ rpc, stub, apiKey: STUB_API_KEY, home: HOME })
  claim('AG-01 the loopback route proves', route.ok,
    { attempts: route.attempts.length, diagnosis: route.diagnosis })
  if (!route.ok) throw new Error(`route: ${String(route.diagnosis)}`)

  const created = await rpc('session.create', { cwd: work })
  const sessionId = created.result?.value?.sessionId ?? null
  claim('AG-02 a session opens on the workspace', sessionId !== null, { sessionId })

  // ── 1. the first turn: write, prove, break, find out, repair, contain ─────
  //
  // Two prompts rather than one, and rather than the three a first attempt
  // used. The stub advances its script per model round, not per prompt, so a
  // short script runs entirely inside the first turn — which is what made an
  // early three-prompt version assert about "phases" that had all already
  // happened. A fourteen-step script does not: the turn stops before the end
  // of it, so the work is split where a person would split it anyway.
  const ran = await turn(sessionId,
    'Create owner-test/totals.json containing {"items":[12,18,30],"total":60} and '
    + 'verify the total is 60. Then set the total to 58, verify it again, put it '
    + 'back to 60 and verify once more. Write the same JSON to '
    + '../outside/escape.json as well.')
  claim('AG-03 the turn ran and settled', ran.settled, ran)

  const offered = stub.completions()
    .map(entry => (entry.body?.tools ?? []).map(tool => tool.function?.name ?? tool.name))
    .find(names => names.length > 0) ?? []
  notes.toolsOffered = offered.length
  notes.watchTools = offered.filter(name => String(name).startsWith('watch_'))
  notes.allTools = offered
  claim('AG-04 the profile offered the agent its Watch tools',
    notes.watchTools.length >= 10,
    { total: offered.length, watch: notes.watchTools.length })

  const onDisk = existsSync(totalsPath) ? readFileSync(totalsPath, 'utf8') : null
  claim('AG-05 the file the agent was asked for is on disk, repaired to 60',
    onDisk === TOTALS, { path: 'owner-test/totals.json', content: onDisk })

  const writes = await receiptsFor(sessionId, 'write')
  claim('AG-06 the writes were recorded without anybody asking for a record',
    writes.length >= 3,
    { receipts: writes.length, tags: writes.map(record => record.tags) })

  // ── 2. the claim this release turns on ────────────────────────────────────
  //
  // `watch_verify` completed, Core answered, and until this round every
  // receipt for it read `verdict: null` — the Host asked the Bridge for a
  // verdict through a structural interface that described a shape nothing
  // returns, so the answer was inside an envelope nobody opened.
  const proofs = await receiptsFor(sessionId, 'watch_verify')
  const verdicts = proofs
    .map(record => record.verdict)
    .filter(verdict => typeof verdict === 'string')
  notes.verdictsSeen = verdicts
  claim('AG-07 every verification the agent ran carries Core’s verdict',
    proofs.length >= 3 && verdicts.length === proofs.length,
    { receipts: proofs.length, verdicts })

  claim('AG-08 the verdicts are the ones the work deserved',
    verdicts.filter(v => v === 'VERIFIED').length >= 2
      && verdicts.filter(v => v === 'FAILED').length === 1
      && verdicts.every(v => ['VERIFIED', 'FAILED'].includes(v)),
    { verdicts, note: 'a true postcondition, then a false one, then a repair' })

  const evidence = new Set(proofs.flatMap(record => record.evidenceIds ?? []))
  claim('AG-09 each receipt points at the record Core actually wrote',
    evidence.size === proofs.length
      && [...evidence].every(id => String(id).startsWith('ver_')),
    { evidenceIds: [...evidence], receipts: proofs.length })

  // ── 3. the transport a surface reads, and the row Compare renders ─────────
  const failedRow = proofs.find(record => record.verdict === 'FAILED') ?? null
  const passedRow = proofs.find(record => record.verdict === 'VERIFIED') ?? null
  const openedFail = failedRow === null ? {} : await get(failedRow.recordId)
  const openedPass = passedRow === null ? {} : await get(passedRow.recordId)
  claim('AG-10 a receipt can be opened, not only listed',
    openedFail.outcome === 'record' && openedPass.outcome === 'record',
    { failed: openedFail.outcome ?? null, passed: openedPass.outcome ?? null,
      recordIds: [failedRow?.recordId ?? null, passedRow?.recordId ?? null] })

  claim('AG-11 and it opens carrying the verdict, which is what Compare reads',
    openedFail.record?.verdict === 'FAILED' && openedPass.record?.verdict === 'VERIFIED',
    { failed: openedFail.record?.verdict ?? null, passed: openedPass.record?.verdict ?? null })

  claim('AG-12 the two answers are different revisions, not one row rewritten',
    openedFail.record?.revisionId !== openedPass.record?.revisionId,
    { failed: openedFail.record?.revisionId ?? null,
      passed: openedPass.record?.revisionId ?? null })

  const searchable = await search('VERIFIED')
  claim('AG-13 a person typing VERIFIED finds this session’s passes',
    (searchable.records ?? []).some(record => record.runId === sessionId
      && record.verdict === 'VERIFIED'),
    { total: searchable.total ?? 0, indexState: searchable.indexState ?? null })

  // ── 4. containment, through the same tool and the same shape ──────────────
  const outsideRow = writes.find(record =>
    (record.tags ?? []).includes('scope:outside_workspace')) ?? null
  const state = (outsideRow?.tags ?? []).find(tag => tag.startsWith('state:')) ?? null
  claim('AG-14 the write outside the workspace never reached the filesystem',
    !existsSync(escapePath), { onDisk: existsSync(escapePath) })
  claim('AG-15 and it is recorded as outside, and not as done',
    outsideRow !== null && state !== 'state:completed',
    { tags: outsideRow?.tags ?? null, state })
  claim('AG-16 the ledger disagrees with the filesystem nowhere',
    onDisk === TOTALS && !existsSync(escapePath)
      && writes.some(record => (record.tags ?? []).includes('scope:inside')
        && (record.tags ?? []).includes('state:completed')),
    { inside: onDisk === TOTALS, outside: existsSync(escapePath) })

  // ── 5. what the provider actually saw ─────────────────────────────────────
  const leaks = stub.requests.filter(entry => entry.leaksCredential === true)
  claim('AG-17 the credential never travelled in a body', leaks.length === 0,
    { leaks: leaks.length, requests: stub.requests.length })

  const filed = JSON.stringify([...writes, ...proofs])
  claim('AG-18 no receipt carries an absolute path from this machine',
    !filed.includes(work) && !filed.includes(work.replace(/\\/g, '/'))
      && !filed.includes(WORKSPACE) && !filed.includes(WORKSPACE.replace(/\\/g, '/')),
    { leaked: filed.includes(work) || filed.includes(WORKSPACE) })

  // ── 6. a second turn: read what was indexed, act on it, and watch a page ──
  const secondTurn = await turn(sessionId,
    `Find which indexed source mentions ${MEDIA_TOKEN}, write what you found `
    + 'into owner-test/seen.json and verify you wrote it.')
  claim('AG-18a the second turn ran and settled', secondTurn.settled, secondTurn)

  // ── 7. media: what Core indexed, read back through the agent's own tool ───
  //
  // The clip was generated by ffmpeg with this token drawn into its frames and
  // indexed by Core before this pass ran, so the answer is known by
  // construction rather than asserted from the pipeline being tested. The
  // observation is checked where the agent actually received it: in the tool
  // result the Host sent back to the model.
  //
  // Read from the last completion, which carries the whole history, and paired
  // call-to-result by id. Reading every completion instead counts the same
  // result once per round and pairs nothing, which is how a first attempt
  // reported 78 results and could not say what any of them answered.
  const history = (() => {
    const rounds = stub.completions()
    const last = rounds[rounds.length - 1]
    return Array.isArray(last?.body?.messages) ? last.body.messages : []
  })()
  const textOf = (content) => (typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : '')
  /** What each tool call was answered with, by tool name. */
  const answers = new Map()
  const calledAs = new Map()
  for (const message of history) {
    for (const call of message?.tool_calls ?? []) {
      calledAs.set(call.id, call.function?.name ?? 'unknown')
    }
    if (message?.role === 'tool') {
      const name = calledAs.get(message.tool_call_id) ?? 'unknown'
      const list = answers.get(name) ?? []
      list.push(textOf(message.content))
      answers.set(name, list)
    }
  }
  const toolResults = [...answers.values()].flat()
  notes.rounds = stub.completions().length
  notes.emitted = stub.emitted().map(step => step.name)
  notes.toolsCalled = Object.fromEntries(
    [...answers].map(([name, list]) => [name, list.length]))
  notes.toolResultsSeen = toolResults.length
  const searched = answers.get('watch_search_sources') ?? []
  claim('AG-19 the agent’s source search returned the text in the clip',
    searched.some(text => text.includes(MEDIA_TOKEN)),
    { token: MEDIA_TOKEN, calls: searched.length,
      answer: (searched[0] ?? '(the tool was never called)').slice(0, 300) })

  const seenOnDisk = existsSync(seenPath) ? readFileSync(seenPath, 'utf8') : null
  claim('AG-20 it acted on what it saw, and the act was verified',
    seenOnDisk === SEEN
      && (await receiptsFor(sessionId, 'watch_verify')).filter(
        record => record.verdict === 'VERIFIED').length >= 3,
    { wrote: seenOnDisk,
      passes: (await receiptsFor(sessionId, 'watch_verify'))
        .filter(record => record.verdict === 'VERIFIED').length })

  // ── 8. browser: watch a page, read it, and act on it ──────────────────────
  //
  // Its own session, which is both realistic and necessary. The stub hands out
  // one scripted call per model round, and a round is not guaranteed to be the
  // agent's own turn — appended to the end of a fourteen-step script, two of
  // the four browser steps were handed to a round that discarded them, and
  // neither a receipt nor a refusal exists for either. That is the scripted
  // provider's limit, not a product refusal, and the way around it is to give
  // the task a session of its own the way a person would.
  if (fixture !== null) {
    // A provider of its own, so this script starts at step one.
    //
    // The stub hands out one scripted call per model round, and not every
    // round belongs to the turn under test. Appended to the end of a
    // fourteen-step script these four steps were handed out but two of them
    // never became calls — no receipt, no refusal, nothing anywhere. The
    // isolated sequence dispatches every time, so the loss is the scripted
    // provider's, not the product's; a second stub removes the coupling
    // instead of leaving an unexplained gap in the evidence.
    browserStub = await startOpenRouterStub({
      script: [
        { name: 'watch_watch_live', arguments: {
          target: fixture.url, kind: 'browser', allow_local: true } },
        { name: 'watch_browser_observe', arguments: { session_id: '$previous.session_id' } },
        { name: 'watch_browser_act', arguments: {
          session_id: '$previous.session_id', kind: 'navigate',
          intent: 'reload the order desk and check the heading is still there',
          url: fixture.url, expect_text_present: 'Order' } },
        { name: 'watch_stop_live', arguments: { session_id: '$previous.session_id' } },
      ],
    })
    const browserRoute = await proveLoopbackRoute({
      rpc, stub: browserStub, apiKey: STUB_API_KEY, home: HOME })
    claim('AG-20b the browser phase has a proved route of its own',
      browserRoute.ok, { diagnosis: browserRoute.diagnosis })

    const browserSession = await rpc('session.create', { cwd: work })
    const browserId = browserSession.result?.value?.sessionId ?? null
    const browserTurn = browserId === null ? { settled: false }
      : await (async () => {
        await rpc('session.prompt', { sessionId: browserId, mode: 'queue',
          content: [{ type: 'text', text:
            'Watch the order desk page, read what it says, and reload it.' }] })
        const done = await settleTurn({ rpc, stub: browserStub, sessionId: browserId })
        await settleFor(2500)
        return done
      })()
    claim('AG-20c the browser turn ran and settled',
      browserTurn.settled, { sessionId: browserId, ...browserTurn })

    const browserRounds = browserStub.completions()
    const lastBrowser = browserRounds[browserRounds.length - 1]
    const browserHistory = Array.isArray(lastBrowser?.body?.messages)
      ? lastBrowser.body.messages : []
    const named = new Map()
    for (const message of browserHistory) {
      for (const call of message?.tool_calls ?? []) {
        named.set(call.id, call.function?.name ?? 'unknown')
      }
      if (message?.role === 'tool') {
        const name = named.get(message.tool_call_id) ?? 'unknown'
        const list = answers.get(name) ?? []
        list.push(textOf(message.content))
        answers.set(name, list)
      }
    }
    notes.browserEmitted = browserStub.emitted().map(step => step.name)
    notes.browserToolsCalled = Object.fromEntries(
      [...answers].map(([name, list]) => [name, list.length]))

    const watched = answers.get('watch_watch_live') ?? []
    const observations = answers.get('watch_browser_observe') ?? []
    claim('AG-20a a live browser session started on the fixture app',
      watched.some(text => text.includes('running') && text.includes('browser')),
      { url: fixture.url, calls: watched.length,
        answer: (watched[0] ?? '(the tool was never called)').slice(0, 240) })
    claim('AG-21 the agent read the running page, not a description of it',
      observations.some(text => text.includes('Order Desk')
        && text.includes('evidenceId')),
      { url: fixture.url, calls: observations.length,
        answer: (observations[0] ?? '(the tool was never called)').slice(0, 300) })

    // Acting on a page is approval-gated by design. In a run with nobody to
    // ask, the correct outcome is a refusal that says so -- and a refusal is
    // recorded as a refusal rather than as an act that did nothing.
    const acts = await receiptsFor(sessionId, 'watch_browser_act')
    const actResults = answers.get('watch_browser_act') ?? []
    notes.browserAct = (actResults[0] ?? '').slice(0, 400)
    claim('AG-22 acting on the page was answered, by Core or by the gate',
      actResults.length >= 1,
      { receipts: acts.length, tags: acts.map(record => record.tags),
        answer: notes.browserAct === '' ? '(the tool was never called)' : notes.browserAct })
  }

  // ── 9. delegation, and a turn a person can stop ───────────────────────────
  //
  // Two properties, both of which failed in the evaluation that prompted this
  // profile. A delegated child inherits no route from a parent that resolves
  // one per request, so three subagents died on their first step with "has no
  // provider/model" — `watch-delegation` fills `agent/request` so parent and
  // child are routed by one rule. And a turn nobody can stop is what made that
  // run cost nine minutes and 2.97M tokens of context.
  const delegationStub = await startOpenRouterStub({
    script: [{ name: 'subagent', arguments: {
      description: 'count the items',
      prompt: 'Read owner-test/totals.json and say how many items it lists.',
      run_in_background: false,
    } }],
  })
  let delegation = { ok: false, diagnosis: 'not attempted' }
  try {
    delegation = await proveLoopbackRoute({
      rpc, stub: delegationStub, apiKey: STUB_API_KEY, home: HOME })
    claim('AG-30 the delegation phase has a proved route of its own',
      delegation.ok, { diagnosis: delegation.diagnosis })

    const parent = await rpc('session.create', { cwd: work })
    const parentId = parent.result?.value?.sessionId ?? null
    await rpc('session.prompt', { sessionId: parentId, mode: 'queue',
      content: [{ type: 'text', text: 'Delegate counting the items to a subagent.' }] })
    const settledParent = await settleTurn({
      rpc, stub: delegationStub, sessionId: parentId, timeoutMs: 240_000 })
    await settleFor(2000)

    const rounds = delegationStub.completions()
    const last = rounds[rounds.length - 1]
    const messages = Array.isArray(last?.body?.messages) ? last.body.messages : []
    const named = new Map()
    let childAnswer = null
    for (const message of messages) {
      for (const call of message?.tool_calls ?? []) {
        named.set(call.id, call.function?.name ?? 'unknown')
      }
      if (message?.role === 'tool' && named.get(message.tool_call_id) === 'subagent') {
        childAnswer = typeof message.content === 'string' ? message.content
          : Array.isArray(message.content)
            ? message.content.map(part => part?.text ?? '').join('') : ''
      }
    }
    notes.delegation = {
      settled: settledParent.settled, rounds: rounds.length,
      answer: (childAnswer ?? '').slice(0, 300),
    }
    claim('AG-31 a delegated child inherits a route and runs',
      childAnswer !== null
        && !/no provider|no model|has no route/i.test(childAnswer),
      { answer: (childAnswer ?? '(the subagent tool returned nothing)').slice(0, 300) })

    // A child costs model rounds of its own, which is how a delegation that
    // never started is told apart from one that did.
    claim('AG-32 the child spent rounds of its own, so it really ran',
      rounds.length >= 3, { rounds: rounds.length })
  } finally {
    await delegationStub.stop()
  }

  // Cancellation, from the surface a person actually has.
  const cancelStub = await startOpenRouterStub({
    script: [{ name: 'watch_watch_live', arguments: {
      target: fixture === null ? 'http://127.0.0.1:1' : fixture.url,
      kind: 'browser', allow_local: true } }],
  })
  try {
    const cancelRoute = await proveLoopbackRoute({
      rpc, stub: cancelStub, apiKey: STUB_API_KEY, home: HOME })
    const cancelSession = await rpc('session.create', { cwd: work })
    const cancelId = cancelSession.result?.value?.sessionId ?? null
    await rpc('session.prompt', { sessionId: cancelId, mode: 'queue',
      content: [{ type: 'text', text: 'Watch the order desk page.' }] })
    // Long enough that a turn is genuinely in flight, short enough that it is
    // still in flight: starting a browser takes seconds.
    await settleFor(1500)
    const cancelled = await rpc('session.cancel', { sessionId: cancelId })
    claim('AG-33 a running turn can be stopped from outside it',
      cancelRoute.ok && cancelled.result?.value?.accepted === true,
      { accepted: cancelled.result?.value?.accepted ?? null,
        route: cancelRoute.ok })

    let stillRunning = true
    for (let attempt = 0; attempt < 40 && stillRunning; attempt += 1) {
      await settleFor(500)
      const listed = await rpc('session.list', {})
      const row = (listed.result?.value?.items ?? [])
        .find(item => item.sessionId === cancelId) ?? null
      stillRunning = row?.running === true
    }
    claim('AG-34 and it actually stops, rather than being asked to',
      !stillRunning, { stillRunning })
  } finally {
    await cancelStub.stop()
  }

  // ── 9. what the journal holds, and what a torn write costs ────────────────
  //
  // Checked on disk as well as through the Library, because "the process still
  // remembers" and "a person who restarts finds it" are different claims and
  // only the second one is durability. The restart itself is the second phase
  // of this pass; what is asserted here is that the record exists to survive.
  if (RECEIPTS !== null) {
    const journal = join(RECEIPTS, 'receipts.jsonl')
    const lines = existsSync(journal)
      ? readFileSync(journal, 'utf8').split('\n').filter(line => line.trim() !== '')
      : []
    const mine = lines.filter(line => line.includes(sessionId))
    claim('AG-23 every receipt this session filed is on disk',
      mine.length >= writes.length + proofs.length,
      { journal: 'receipts.jsonl', linesForThisSession: mine.length,
        indexed: writes.length + proofs.length, total: lines.length })

    const verdictsOnDisk = mine
      .map(line => { try { return JSON.parse(line).verdict } catch { return null } })
      .filter(verdict => typeof verdict === 'string')
    claim('AG-24 and the verdicts went to disk with them',
      verdictsOnDisk.includes('VERIFIED') && verdictsOnDisk.includes('FAILED'),
      { verdicts: [...new Set(verdictsOnDisk)] })

    claim('AG-25 the journal ends with a complete line',
      lines.length === 0
        || readFileSync(journal, 'utf8').endsWith('\n'),
      { note: 'an unterminated tail is what a killed process leaves, and the '
        + 'next append would join onto it' })

    notes.journal = { path: 'receipts.jsonl', lines: lines.length, session: mine.length }
  }

  report = {
    profile: PROFILE,
    stubURL: stub.baseURL,
    sessionId,
    totals: { path: 'owner-test/totals.json', content: onDisk },
    verdicts: notes.verdictsSeen ?? [],
    evidenceIds: [...evidence],
    receipts: [...writes, ...proofs].map(record => ({
      recordId: record.recordId, title: record.title,
      verdict: record.verdict, tags: record.tags })),
    notes,
    claims,
    passed: claims.filter(entry => entry.ok).length,
    failed: claims.filter(entry => !entry.ok).length,
  }
} finally {
  await stub.stop()
  if (browserStub !== null) await browserStub.stop()
  if (fixture !== null) fixture.child.kill()
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report ?? { claims, notes }, null, 2)}\n`, 'utf8')
process.stdout.write(`\nreport: ${OUT}\n`)

const failed = claims.filter(entry => !entry.ok)
if (failed.length > 0) {
  process.stderr.write(
    `qa-acceptance-agent: ${String(failed.length)} claim(s) failed: ${
      failed.map(entry => entry.id).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write('qa-acceptance-agent: the agent experience holds\n')
