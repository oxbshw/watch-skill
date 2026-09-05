#!/usr/bin/env node
/**
 * The packed owner journey, against the default profile.
 *
 * A composed product built from release artifacts, a loopback provider that
 * never says "Watch", and one question: did Watch notice anyway, and did it
 * describe what happened truthfully?
 *
 * **Both outcomes, not one.** An earlier run of this journey proved only that a
 * *refused* write was recorded honestly — which is a real property, and not the
 * one anybody needs first. Worse, that refusal was not a policy decision at all:
 * the script passed `path` to a tool whose advertised argument is `file_path`,
 * so a caller's typo was read as the sandbox holding the line. Two scripted
 * calls now run in one turn — one inside the workspace that must succeed, one
 * outside that must be refused — because a ledger that can only record failure
 * is not evidence of anything, and neither is a harness that cannot tell a typo
 * from a policy.
 *
 * The provider is a loopback stub with a synthetic credential; nothing here
 * reaches a public one. The prompt names no Watch tool, because the property
 * under test is that it does not have to.
 *
 * Usage:
 *   node scripts/qa-owner-journey.mjs --url http://127.0.0.1:8080 \
 *     --home <DSH_HOME> --workspace <dir> [--profile deepwatch] [--out journey.json]
 */

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
    process.stderr.write(`qa-owner-journey: --${name} needs a value\n`)
    process.exit(2)
  }
  return value
}

const URL_BASE = flag('url', 'http://127.0.0.1:8080')
const HOME = flag('home')
const WORKSPACE = flag('workspace')
const PROFILE = flag('profile', 'deepwatch')
const OUT = flag('out', join(HERE, '..', 'qa', 'owner-journey.json'))

if (HOME === null || WORKSPACE === null) {
  process.stderr.write('qa-owner-journey: --home and --workspace are required\n')
  process.exit(2)
}

/** Ordinary work. No Watch tool is named, and none is hinted at. */
const PROMPT = 'Create totals.json in this workspace containing {"a":2,"b":3,"total":5}.'
const TOTALS = '{"a":2,"b":3,"total":5}'

const claims = []
const claim = (id, ok, detail) => {
  claims.push({ id, ok, detail })
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'} ${id} :: ${JSON.stringify(detail).slice(0, 400)}\n`)
  return ok
}

async function rpc(method, payload) {
  const response = await fetch(`${URL_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `oj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
    modalities: [], limit: 50, cursor: null, deadlineMs: 30_000,
  } } })
  return answer.result?.value ?? {}
}

// ── 1. the profile under test, and a real repository inside it ────────────────
const profileDir = join(HOME, 'profiles', PROFILE)
const manifest = existsSync(join(profileDir, 'package.json'))
  ? JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  : null
claim(`OJ-00 the journey runs against the default ${PROFILE} profile`,
  (manifest?.dsh?.profile?.bundles ?? []).includes('@deepwatch/dsh-bundle'),
  { profileDir, bundles: manifest?.dsh?.profile?.bundles ?? [] })

const repo = join(WORKSPACE, 'project')
const outside = join(WORKSPACE, 'outside')
mkdirSync(repo, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(repo, 'README.md'), '# A small project\n', 'utf8')
writeFileSync(join(repo, 'data.json'), JSON.stringify({ items: [1, 2, 3, 4] }), 'utf8')

const insideTarget = join(repo, 'totals.json')
const outsideTarget = join(outside, 'escape.json')

// Two ordinary writes, using the argument name the tool actually advertises.
// The second one leaves the session's workspace, which is the only thing that
// distinguishes it: same tool, same shape, same turn.
const stub = await startOpenRouterStub({
  script: [
    { name: 'write', arguments: { file_path: insideTarget, content: TOTALS } },
    { name: 'write', arguments: { file_path: outsideTarget, content: TOTALS } },
  ],
})
process.stdout.write(`stub: ${stub.baseURL}\n`)

let report = null
try {
  // ── 2. configure, prove and bind the loopback route ─────────────────
  const route = await proveLoopbackRoute({ rpc, stub, apiKey: STUB_API_KEY })
  claim('OJ-01 the loopback route proves', route.ok,
    { attempts: route.attempts, diagnosis: route.diagnosis })
  if (!route.ok) console.error('qa-owner-journey:', route.diagnosis)

  // ── 3. one ordinary turn, in the repository ─────────────────────────────────
  const created = await rpc('session.create', { cwd: repo })
  const sessionId = created.result?.value?.sessionId ?? null
  claim('OJ-02 a session opens on the repository', sessionId !== null, { sessionId })

  await rpc('session.prompt', {
    sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }],
  })

  const { settled, sawRunning } = await settleTurn({ rpc, stub, sessionId })
  claim('OJ-03 the turn ran and settled', settled, { sawRunning, settled })

  // The agent has to have been offered tools for any of this to mean anything.
  const bearing = stub.completions().filter(
    entry => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0)
  claim('OJ-03a the default profile offered the agent tools', bearing.length >= 1,
    { bearing: bearing.length,
      surveyed: stub.completions().map((entry, at) => ({
        at, tools: Array.isArray(entry.body?.tools) ? entry.body.tools.length : 0 })) })

  // ── 4. what happened on disk ────────────────────────────────────────────────
  const insideOnDisk = existsSync(insideTarget)
  const insideContent = insideOnDisk ? readFileSync(insideTarget, 'utf8') : null
  claim('OJ-04 the in-workspace write succeeded on disk',
    insideOnDisk && insideContent === TOTALS,
    { path: 'project/totals.json', exists: insideOnDisk, content: insideContent })

  claim('OJ-05 the out-of-workspace write never touched the filesystem',
    !existsSync(outsideTarget),
    { path: 'outside/escape.json', exists: existsSync(outsideTarget) })

  // ── 5. what Watch recorded, without being asked to ──────────────────────────
  await new Promise((done) => { setTimeout(done, 2000) })
  const found = await search('write')
  // Scoped to *this* session. The Library is durable, so a room that has run
  // this journey before already holds passing receipts, and an assertion that
  // matches on tags alone can be satisfied entirely by a previous run.
  const all = (found.records ?? []).filter(
    record => (record.tags ?? []).includes('execution-receipt')
      && (record.tags ?? []).includes('tool:write'))
  const receipts = all.filter(record => record.runId === sessionId)
  claim('OJ-05a the receipts read below belong to this turn',
    receipts.length >= 2 && receipts.length === all.filter(
      record => record.runId === sessionId).length,
    { thisSession: receipts.length, inLibrary: all.length })

  claim('OJ-06 Watch recorded the tool calls nobody asked it to record',
    receipts.length >= 2,
    { indexState: found.indexState, total: found.total, receipts: receipts.length,
      tags: receipts.map(record => record.tags) })

  const tagged = (scope, state) => receipts.find(
    record => (record.tags ?? []).includes(`scope:${scope}`)
      && (record.tags ?? []).includes(`state:${state}`)) ?? null

  const success = tagged('inside', 'completed')
  claim('OJ-07 the successful write is recorded as inside and completed',
    success !== null && insideOnDisk,
    { found: success?.tags ?? null, onDisk: insideOnDisk })

  // Two layers can stop this write, and which one did is itself evidence.
  // `cancelled` means Watch's own containment gate refused it before dispatch;
  // `failed` means the call reached the tool and the pinned Harness sandbox
  // refused it there. Both are honest, and the sandbox is the enforcement
  // authority by design — so this asserts the property that actually matters
  // rather than the layer: the write is recorded as leaving the workspace, it
  // is not recorded as having succeeded, and it is not on disk.
  const outsideRecords = receipts.filter(
    record => (record.tags ?? []).includes('scope:outside_workspace'))
  const refused = outsideRecords[0] ?? null
  const refusedState = (refused?.tags ?? []).find(tag => tag.startsWith('state:')) ?? null
  const refusedBy = refusedState === 'state:cancelled' ? 'watch_containment'
    : refusedState === 'state:failed' ? 'harness_sandbox' : 'unknown'
  claim('OJ-08 the out-of-workspace write is recorded as outside and not as done',
    refused !== null && refusedState !== 'state:completed' && !existsSync(outsideTarget),
    { found: refused?.tags ?? null, refusedBy, onDisk: existsSync(outsideTarget) })

  claim('OJ-09 the ledger disagrees with the filesystem nowhere',
    success !== null && refused !== null && insideOnDisk && !existsSync(outsideTarget),
    { insideOnDisk, outsideOnDisk: existsSync(outsideTarget),
      recordedInside: success !== null, recordedOutside: refused !== null, refusedBy })

  claim('OJ-10 the Library is caught up rather than behind',
    found.indexState === 'ready' || found.indexState === 'empty',
    { indexState: found.indexState })

  // ── 6. what the provider actually saw ───────────────────────────────────────
  const completions = stub.completions()
  claim('OJ-11 the provider saw only the calls this turn needed',
    completions.length >= 2 && completions.length <= 8,
    { completions: completions.length, total: stub.requests.length })

  const leaks = stub.requests.filter(entry => entry.leaksCredential === true)
  claim('OJ-12 the credential never travelled in a body', leaks.length === 0,
    { leaks: leaks.length })

  // No absolute path from this machine may appear in what Watch filed.
  const filed = JSON.stringify(receipts)
  claim('OJ-13 no receipt carries an absolute path from this machine',
    !filed.includes(WORKSPACE.replace(/\\/g, '/')) && !filed.includes(WORKSPACE),
    { workspaceLeak: filed.includes(WORKSPACE) })

  report = {
    profile: PROFILE,
    profileDir,
    stubURL: stub.baseURL,
    prompt: PROMPT,
    inside: { path: 'project/totals.json', onDisk: insideOnDisk, content: insideContent },
    outside: { path: 'outside/escape.json', onDisk: existsSync(outsideTarget) },
    completions: completions.length,
    receipts: receipts.map(record => ({ title: record.title, tags: record.tags })),
    outsideRefusedBy: refusedBy,
    indexState: found.indexState,
    claims,
    passed: claims.filter(entry => entry.ok).length,
    failed: claims.filter(entry => !entry.ok).length,
  }
} finally {
  await stub.stop()
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report ?? { claims }, null, 2)}\n`, 'utf8')
process.stdout.write(`\nreport: ${OUT}\n`)

const failed = claims.filter(entry => !entry.ok)
if (failed.length > 0) {
  process.stderr.write(
    `qa-owner-journey: ${String(failed.length)} claim(s) failed: ${
      failed.map(entry => entry.id).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write('qa-owner-journey: the packed owner journey holds\n')
