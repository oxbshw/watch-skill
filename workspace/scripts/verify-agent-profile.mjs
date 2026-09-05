#!/usr/bin/env node
/**
 * The default profile must be able to act, and the tool contract must be what
 * callers assume it is.
 *
 * Two failures motivate this gate, and both were mine rather than the
 * product's — which is the point. A profile that composes correctly and a
 * harness that drives it correctly are separate claims, and an evaluation that
 * cannot tell them apart reports the wrong defect.
 *
 * The first: a turn sends more than one completion, and only one of them is the
 * agent's. A provider test sends `max_tokens: 1`; a session-title request
 * carries no tools at all. Reading the *first* completion and reporting
 * `tools=0` reads a real request and draws a false conclusion — the default
 * `deepwatch` profile was reported as advertising no agent tools when it
 * advertises the same 47 as every other profile. So this scans every
 * completion, selects the ones that actually carry tools, and fails when none
 * does — never when the first one does not.
 *
 * The second: `write` takes `file_path`. A harness that scripts `path` gets a
 * refusal that looks exactly like a filesystem policy denial, and "the sandbox
 * refused the write" is a much more interesting wrong answer than "the caller
 * misspelled an argument". So the advertised schema is pinned here, in the same
 * place the advertisement is read, rather than assumed at every call site.
 *
 * Nothing here reaches a public provider. The route is a loopback stub with a
 * synthetic credential, started and stopped by this script.
 *
 * Usage:
 *   node scripts/verify-agent-profile.mjs --url http://127.0.0.1:8080 \
 *     --home <DSH_HOME> [--profile deepwatch] [--out qa/agent-profile.json]
 *
 * The caller boots the Host; this gate asserts on what that Host advertises.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { startOpenRouterStub, STUB_API_KEY } = await import(
  pathToFileURL(join(HERE, 'lib', 'openrouter-stub.mjs')).href)
const { proveLoopbackRoute, settleTurn } = await import(
  pathToFileURL(join(HERE, 'lib', 'loopback-route.mjs')).href)

/**
 * Read one `--flag value` pair.
 *
 * Deliberately not a general parser: every caller of this gate is a script in
 * this repository or a person following the usage line above, and a permissive
 * parser is how `--profile` silently becomes the default when it is misspelled.
 */
function flag(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`verify-agent-profile: --${name} needs a value\n`)
    process.exit(2)
  }
  return value
}

const URL_BASE = flag('url', 'http://127.0.0.1:8080')
const HOME = flag('home')
const PROFILE = flag('profile', 'deepwatch')
const OUT = flag('out', join(HERE, '..', 'qa', 'agent-profile.json'))

if (HOME === null) {
  process.stderr.write('verify-agent-profile: --home <DSH_HOME> is required\n')
  process.exit(2)
}

/**
 * What "a real agent profile" means, named rather than counted.
 *
 * A count is the wrong assertion: 47 is what this candidate happens to compose,
 * and a gate that pins the number fails on every upstream release that adds a
 * tool while passing a composition that dropped `write` and gained two others.
 * These are the capabilities the product's own documentation promises, so
 * losing any one of them is a release-blocking regression rather than drift.
 */
const REQUIRED_TOOLS = [
  // Act on a workspace at all.
  'read', 'write', 'edit', 'glob', 'grep',
  // Delegate, which is the surface `watch-delegation` routes and budgets.
  'subagent', 'subagent_fork', 'list_agents',
  // Watch's own capabilities, which are the reason this product exists.
  'watch_capabilities', 'watch_verify', 'watch_library_search', 'watch_get_evidence',
]

/** Below this, `watch_*` has been partially composed, which is worse than absent. */
const MINIMUM_WATCH_TOOLS = 8

/**
 * The advertised argument names this repository's harnesses depend on.
 *
 * `write` is here because getting it wrong cost an evaluation cycle and
 * produced a confident, wrong finding about filesystem policy.
 */
const REQUIRED_SCHEMA = {
  write: ['file_path', 'content'],
  read: ['file_path'],
}


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
      rpcId: `vap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload,
    }),
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
  return { http: response.status, result: body?.result ?? null }
}

// ── 1. the profile under test is the one named ────────────────────────────────
//
// Asserted from the profile's own manifest rather than from a flag, so a run
// that boots `web` and is *told* it booted `deepwatch` fails here rather than
// passing on someone else's composition.
const profileDir = join(HOME, 'profiles', PROFILE)
const manifestPath = join(profileDir, 'package.json')
let manifest = null
if (existsSync(manifestPath)) {
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { manifest = null }
}
const bundles = manifest?.dsh?.profile?.bundles ?? []
claim(`AP-01 the ${PROFILE} profile exists and composes the DeepWatch bundle`,
  manifest !== null && bundles.includes('@deepwatch/dsh-bundle'),
  { profileDir, bundles })

// A composed product with a real Core behind it, so a Host serving a stripped
// profile cannot pass the rest of this gate by answering RPCs.
const health = await rpc('watchQuery/coreHealth', { args: { request: {
  protocol: 1, requestId: 'vap-health', deadlineMs: 20_000,
} } })
claim('AP-02 the Host has a real Watch Core behind it',
  health.result?.value !== null && health.result?.value !== undefined,
  { health: health.result?.value ?? health.result?.error ?? null })

const stub = await startOpenRouterStub({})
process.stdout.write(`stub: ${stub.baseURL}\n`)

let report = null
try {
  // ── 2. a loopback route, proved and bound ─────────────────────────
  const route = await proveLoopbackRoute({ rpc, stub, apiKey: STUB_API_KEY })
  claim('AP-03 the loopback route proves', route.ok,
    { attempts: route.attempts, diagnosis: route.diagnosis })
  if (!route.ok) console.error('verify-agent-profile:', route.diagnosis)

  // ── 3. one ordinary turn ────────────────────────────────────────────────────
  const created = await rpc('session.create', { cwd: profileDir })
  const sessionId = created.result?.value?.sessionId ?? null
  claim('AP-04 a session opens', sessionId !== null, { sessionId })

  await rpc('session.prompt', {
    sessionId, mode: 'queue', content: [{ type: 'text', text: 'List the files here.' }],
  })

  const { settled, sawRunning } = await settleTurn({ rpc, stub, sessionId })
  claim('AP-05 the turn ran and settled', settled, { sawRunning, settled })

  // ── 4. what the agent was actually offered ──────────────────────────────────
  //
  // Every completion, not the first one. `bearing` is the set that carries
  // tools; a turn that sent three completions and offered tools on none of them
  // is the failure this gate exists to catch.
  const completions = stub.completions()
  const bearing = completions.filter(
    entry => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0)

  const surveyed = completions.map((entry, at) => ({
    at,
    tools: Array.isArray(entry.body?.tools) ? entry.body.tools.length : 0,
    roles: (entry.body?.messages ?? []).map(message => message.role).join(','),
  }))

  const usable = claim(
    `AP-06 the default ${PROFILE} profile offers the agent tools`,
    bearing.length >= 1,
    { completions: completions.length, bearing: bearing.length, surveyed })

  const advertised = bearing.length === 0
    ? []
    : bearing[0].body.tools.map(tool => tool?.function?.name ?? tool?.name ?? '<unnamed>')
  const names = new Set(advertised)

  const missing = REQUIRED_TOOLS.filter(name => !names.has(name))
  claim('AP-07 every capability the product promises is advertised',
    usable && missing.length === 0,
    { advertised: advertised.length, missing })

  const watchTools = advertised.filter(name => name.startsWith('watch_'))
  claim('AP-08 the Watch capability surface is composed whole',
    watchTools.length >= MINIMUM_WATCH_TOOLS,
    { watchTools: watchTools.length, minimum: MINIMUM_WATCH_TOOLS, names: watchTools })

  // ── 5. the contract callers depend on ───────────────────────────────────────
  const schemaFaults = []
  for (const [toolName, required] of Object.entries(REQUIRED_SCHEMA)) {
    const tool = bearing.length === 0
      ? null
      : bearing[0].body.tools.find(
        entry => (entry?.function?.name ?? entry?.name) === toolName) ?? null
    const properties = tool?.function?.parameters?.properties
      ?? tool?.parameters?.properties ?? {}
    for (const key of required) {
      if (!(key in properties)) {
        schemaFaults.push({ tool: toolName, missing: key, has: Object.keys(properties) })
      }
    }
  }
  claim('AP-09 the advertised argument names are the ones callers use',
    usable && schemaFaults.length === 0, { schemaFaults })

  // Every advertised schema, recorded. A gate that only checks the two names it
  // was told about cannot tell an owner what the product actually offers, and
  // the argument names are the contract every harness in this repository binds
  // to.
  const schemas = bearing.length === 0 ? {} : Object.fromEntries(
    bearing[0].body.tools.map(tool => [
      tool?.function?.name ?? tool?.name ?? '<unnamed>',
      Object.keys(tool?.function?.parameters?.properties
        ?? tool?.parameters?.properties ?? {}),
    ]))

  report = {
    schemas,
    profile: PROFILE,
    profileDir,
    bundles,
    completions: completions.length,
    bearingCompletions: bearing.length,
    surveyed,
    advertised,
    watchTools,
    missing,
    schemaFaults,
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
    `verify-agent-profile: ${String(failed.length)} claim(s) failed: ${
      failed.map(entry => entry.id).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write('verify-agent-profile: the default profile is a real agent profile\n')
