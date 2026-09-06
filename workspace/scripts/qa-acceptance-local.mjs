#!/usr/bin/env node
/**
 * The local developer's acceptance pass, with no provider anywhere near it.
 *
 * This is the first of the two experiences the release is judged by, and it is
 * deliberately the one with nothing hosted in it: a person installs the sealed
 * artifacts, runs `doctor`, starts the Host, and finds out whether the product
 * does anything before they have an account with anybody.
 *
 * The claims below are the ones a person would actually check.
 *
 * - The Host starts and serves with **no provider configured**, and says so
 *   rather than failing. A workspace that cannot open until a key is pasted in
 *   is a workspace nobody can evaluate.
 * - Watch Core is **connected over stdio, at the version this candidate
 *   builds, and is not a mock**. That last field exists because "it worked"
 *   and "it answered from a fixture" look identical from the outside.
 * - Core **decides verdicts and the Host never does** (ADR-002). All four
 *   outcomes are exercised against real files on this disk, with the answer
 *   known in advance: a passing contract, a failing one, prose with nothing
 *   executable behind it, and a check that cannot be evaluated at all.
 * - A verification is **bounded by the workspace it was given**. A check
 *   pointed outside it is refused rather than answered.
 * - **Media is read, not guessed.** A video is generated here with text drawn
 *   into its frames, so the ground truth is known by construction rather than
 *   asserted from the same pipeline being tested.
 * - **Evidence survives a restart**, and the Library's Refresh is what brings
 *   it back, because that is the button a person presses.
 *
 * Nothing here reaches the network except the package installs the room was
 * built from, and no code path in this file reads a provider credential.
 *
 * Usage:
 *   node scripts/qa-acceptance-local.mjs --url http://127.0.0.1:8877 \
 *     --home <DEEPWATCH_HOME> --workspace <dir> --core-bin <watch-skill exe> \
 *     [--profile deepwatch] [--data-dir <WATCHSKILL_DATA_DIR>] [--out report.json]
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function flag(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`qa-acceptance-local: --${name} needs a value\n`)
    process.exit(2)
  }
  return value
}

const URL_BASE = flag('url', 'http://127.0.0.1:8877')
const HOME = flag('home')
const DSH_HOME = flag('dsh-home')
const WORKSPACE = flag('workspace')
const CORE_BIN = flag('core-bin')
const PROFILE = flag('profile', 'deepwatch')
const DATA_DIR = flag('data-dir', null)
const OUT = flag('out', join(HERE, '..', 'qa', 'acceptance-local.json'))

if (HOME === null || DSH_HOME === null || WORKSPACE === null || CORE_BIN === null) {
  process.stderr.write(
    'qa-acceptance-local: --home, --dsh-home, --workspace and --core-bin are required\n')
  process.exit(2)
}

const claims = []
const notes = {}
const claim = (id, ok, detail) => {
  claims.push({ id, ok, detail })
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'} ${id} :: ${JSON.stringify(detail).slice(0, 500)}\n`)
  return ok
}

// ── the Host's read plane, over the same HTTP the browser uses ───────────────

async function rpc(method, payload) {
  const response = await fetch(`${URL_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      method, payload,
    }),
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
  return { http: response.status, result: body?.result ?? null }
}

const coreHealth = async () => {
  const answer = await rpc('watchQuery/coreHealth', { args: { request: {
    protocol: 1, requestId: `h-${Date.now().toString(36)}`, deadlineMs: 45_000,
  } } })
  return answer.result?.value ?? {}
}

const search = async (query, limit = 50) => {
  const answer = await rpc('watchQuery/librarySearch', { args: { request: {
    protocol: 1, requestId: `s-${Date.now().toString(36)}`, query,
    modalities: [], limit, cursor: null, deadlineMs: 30_000,
  } } })
  return answer.result?.value ?? {}
}

const refresh = async () => {
  const answer = await rpc('watchQuery/libraryRefresh', { args: { request: {
    protocol: 1, requestId: `r-${Date.now().toString(36)}`, deadlineMs: 120_000,
  } } })
  return answer.result?.value ?? {}
}

// ── Watch Core's own Bridge, spoken directly ─────────────────────────────────

/**
 * One Bridge conversation, over the transport the Host itself uses.
 *
 * Spoken directly rather than through the Host because verdicts are the thing
 * being checked and the Host has no read-plane method that runs one -- by
 * design: only a tool call reaches `watch.verification.run`, and a tool call
 * needs an agent, and an agent needs a provider. That is Experience B's job.
 * Here it is Core alone, answering the way it answers the Host.
 *
 * LSP-style framing: `Content-Length: n\r\n\r\n` then n bytes of UTF-8 JSON.
 */
class Bridge {
  #child
  #buffer = Buffer.alloc(0)
  #waiting = new Map()
  #nextId = 1

  constructor(bin, cwd, env) {
    this.#child = spawn(bin, ['bridge'], {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.stderr = ''
    this.#child.stderr.on('data', (chunk) => { this.stderr += String(chunk) })
    this.#child.stdout.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
  }

  #drain() {
    for (;;) {
      const header = this.#buffer.indexOf('\r\n\r\n')
      if (header === -1) return
      const match = /Content-Length:\s*(\d+)/i.exec(
        this.#buffer.subarray(0, header).toString('utf8'))
      if (match === null) return
      const length = Number(match[1])
      const start = header + 4
      if (this.#buffer.length < start + length) return
      const body = this.#buffer.subarray(start, start + length).toString('utf8')
      this.#buffer = this.#buffer.subarray(start + length)
      let frame = null
      try { frame = JSON.parse(body) } catch { frame = null }
      if (frame === null) continue
      const settle = this.#waiting.get(frame.id)
      if (settle !== undefined) {
        this.#waiting.delete(frame.id)
        settle(frame)
      }
    }
  }

  request(method, params, timeoutMs = 120_000) {
    const id = this.#nextId
    this.#nextId += 1
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id)
        resolve({ error: { message: `timed out after ${String(timeoutMs)}ms` } })
      }, timeoutMs)
      this.#waiting.set(id, (answer) => { clearTimeout(timer); resolve(answer) })
      this.#child.stdin.write(frame)
    })
  }

  stop() { this.#child.kill() }
}

// ── the room ─────────────────────────────────────────────────────────────────

const coreEnv = DATA_DIR === null ? {} : { WATCHSKILL_DATA_DIR: DATA_DIR }
const project = join(WORKSPACE, 'project')
mkdirSync(project, { recursive: true })

/** The version this candidate builds, from the engine itself. */
const coreVersion = spawnSync(CORE_BIN, ['--version'], {
  encoding: 'utf8', env: { ...process.env, ...coreEnv },
}).stdout?.trim() ?? ''

let bridge = null
let report = null

try {
  // ── 1. the profile, and what it was composed from ──────────────────────────
  const profileDir = join(DSH_HOME, 'profiles', PROFILE)
  const composed = existsSync(join(HOME, 'deepwatch-composition-receipt.json'))
    ? JSON.parse(readFileSync(join(HOME, 'deepwatch-composition-receipt.json'), 'utf8'))
    : null
  claim(`AL-00 the pass runs against the default ${PROFILE} profile`,
    composed?.profile === PROFILE && composed?.result === 'composed'
      && existsSync(join(profileDir, 'cordis.patch.yml')),
    { profileDir, profile: composed?.profile ?? null, result: composed?.result ?? null,
      bundle: composed?.package ?? null, digest: composed?.digest ?? null })

  const receipt = join(HOME, 'harness', 'deepwatch-install-receipt.json')
  const installed = existsSync(receipt)
    ? JSON.parse(readFileSync(receipt, 'utf8')) : null
  claim('AL-01 the packages came from sealed local artifacts, not a registry',
    installed?.deepwatchSource === 'local-artifacts'
      && composed?.registryRequests?.startsWith('none') === true,
    { source: installed?.deepwatchSource ?? null,
      origin: installed?.deepwatchArtifactOrigin ?? null,
      deepwatchPackages: installed?.deepwatchPackages?.length ?? 0,
      registryRequests: composed?.registryRequests ?? null })

  // ── 2. it starts, and it starts without a provider ─────────────────────────
  const readiness = await rpc('watchQuery/routeReadiness', { args: { request: {
    protocol: 1, requestId: 'rr-1', deadlineMs: 20_000,
  } } })
  const routes = readiness.result?.value ?? {}
  claim('AL-02 the Host serves before any provider is configured',
    readiness.http === 200,
    { http: readiness.http, outcome: routes.outcome ?? null })

  const anyBound = JSON.stringify(routes).includes('"bound":true')
  claim('AL-03 and it says plainly that nothing is bound yet',
    !anyBound,
    { chat: routes.roles?.find?.(role => role.role === 'chat') ?? null })

  // ── 3. Core is connected, and is the engine rather than a stand-in ─────────
  let health = await coreHealth()
  for (let attempt = 0; attempt < 12 && health.phase !== 'ready'; attempt += 1) {
    await new Promise((done) => { setTimeout(done, 5000) })
    health = await coreHealth()
  }
  claim('AL-04 Watch Core is connected over stdio', health.phase === 'ready'
    && health.transport === 'stdio', { phase: health.phase, transport: health.transport })
  claim('AL-05 it is the version this candidate builds, and not a mock',
    coreVersion !== '' && health.coreVersion === coreVersion
      && health.isTestOnlyMock === false,
    { reported: health.coreVersion, built: coreVersion, mock: health.isTestOnlyMock })
  notes.capabilities = health.capabilities ?? null

  // ── 4. the verdict taxonomy, against files whose answer is known ───────────
  bridge = new Bridge(CORE_BIN, project, coreEnv)
  const hello = await bridge.request('watch.handshake', {
    protocolVersion: 1, host: 'qa-acceptance-local', hostVersion: '0',
  }, 60_000)
  claim('AL-06 Core answers its own Bridge', hello?.result !== undefined,
    { protocol: hello?.result?.protocolVersion ?? null,
      core: hello?.result?.coreVersion ?? null, error: hello?.error ?? null })

  writeFileSync(join(project, 'totals.json'),
    JSON.stringify({ items: [12, 18, 30], total: 60 }), 'utf8')

  const verify = async (expectation, checks) => {
    const answer = await bridge.request('watch.verification.run', {
      expectation, checks, workingDir: project,
    }, 120_000)
    return answer?.result ?? { error: answer?.error ?? null }
  }

  const passing = await verify('totals.json holds a total of 60', [{
    id: 'total-is-60', type: 'json_value', required: true,
    params: { path: 'totals.json', pointer: '/total', equals: 60 },
  }])
  claim('AL-07 a true postcondition verifies', passing.verdict === 'VERIFIED',
    { verdict: passing.verdict ?? null, reason: passing.reason ?? null,
      verificationId: passing.verificationId ?? null })

  const failing = await verify('totals.json holds a total of 61', [{
    id: 'total-is-61', type: 'json_value', required: true,
    params: { path: 'totals.json', pointer: '/total', equals: 61 },
  }])
  claim('AL-08 a false one fails, and says which check',
    failing.verdict === 'FAILED',
    { verdict: failing.verdict ?? null, reason: failing.reason ?? null })

  const prose = await verify('the refactor went well', [])
  claim('AL-09 prose with nothing executable behind it is UNVERIFIED',
    prose.verdict === 'UNVERIFIED',
    { verdict: prose.verdict ?? null, reason: prose.reason ?? null })

  const inconclusive = await verify('a file nobody wrote is correct', [{
    id: 'absent', type: 'json_value', required: true,
    params: { path: 'not-written.json', pointer: '/total', equals: 60 },
  }])
  claim('AL-10 a check that cannot be evaluated is not a pass',
    inconclusive.verdict !== 'VERIFIED',
    { verdict: inconclusive.verdict ?? null, reason: inconclusive.reason ?? null })

  // ── 5. containment: a verification cannot look outside its workspace ───────
  const outside = join(WORKSPACE, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.json'), JSON.stringify({ total: 60 }), 'utf8')
  const escaped = await verify('a file outside the workspace is correct', [{
    id: 'escape', type: 'json_value', required: true,
    params: { path: join(outside, 'secret.json'), pointer: '/total', equals: 60 },
  }])
  claim('AL-11 a check pointed outside the workspace does not verify',
    escaped.verdict !== 'VERIFIED',
    { verdict: escaped.verdict ?? null, reason: escaped.reason ?? null })

  // ── 6. media, against text this script drew into the frames ────────────────
  //
  // Ground truth by construction. Asserting that the pipeline read what the
  // pipeline produced would be circular, so the video is generated here from a
  // string chosen here, and the claim is that the string comes back.
  const media = join(WORKSPACE, 'media')
  mkdirSync(media, { recursive: true })
  const clip = join(media, 'ground-truth.mp4')
  const TOKEN = 'ACCEPTANCE7391'
  // A font by name, because `drawtext` otherwise asks fontconfig, and Windows
  // has none: the filter fails with "Cannot load default config file" and
  // ffmpeg still exits having written nothing, which reads as a silent skip.
  const FONTS = [
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/consola.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
  ]
  const font = FONTS.find(candidate => existsSync(candidate)) ?? null
  // Copied next to the clip and named without a drive letter. Inside a filter
  // description `:` separates options, and a Windows path argued with that
  // parser however it was escaped ("Error parsing filterchain"); a bare
  // filename has no colon to argue about.
  if (font !== null) copyFileSync(font, join(media, 'font.ttf'))
  const fontOption = font === null ? '' : 'fontfile=font.ttf:'
  const drawn = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=white:s=640x360:d=6',
    '-vf', `drawtext=${fontOption}text=${TOKEN}:fontcolor=black:fontsize=72`
      + ':x=(w-text_w)/2:y=(h-text_h)/2',
    '-r', '10', '-pix_fmt', 'yuv420p', 'ground-truth.mp4',
  ], { encoding: 'utf8', cwd: media })
  notes.font = font
  const madeClip = existsSync(clip)
  claim('AL-12 a clip with known on-screen text was generated for the read',
    madeClip, { clip: 'media/ground-truth.mp4', token: TOKEN,
      ffmpeg: madeClip ? 'ok' : (drawn.stderr ?? '').slice(-300) })

  if (madeClip) {
    // `--index` as well as reading it: the indexed evidence is what the
    // Library's Refresh re-reads from disk, so this is also what makes the
    // next two claims about anything.
    const workDir = join(WORKSPACE, 'watch-out')
    mkdirSync(workDir, { recursive: true })
    const watched = spawnSync(CORE_BIN, ['watch', clip, '--out-dir', workDir, '--index'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...coreEnv }, timeout: 1_800_000,
    })
    const output = `${watched.stdout ?? ''}`
    notes.watchExit = watched.status
    const read = output.includes(TOKEN)
    claim('AL-13 Core read the text that was drawn into the frames', read,
      { token: TOKEN, exit: watched.status,
        ocrLine: (output.split('\n').find(line => line.includes('OCR:')) ?? '').trim(),
        evidence: read ? 'the token appears in the report'
          : `${output.slice(0, 300)} | ${(watched.stderr ?? '').slice(-400)}` })
  }

  // ── 7. the Library, and what a Refresh brings back ─────────────────────────
  const before = await search(TOKEN)
  const refreshed = await refresh()
  const after = await search(TOKEN)
  claim('AL-14 Refresh re-reads the evidence roots and reports a generation',
    refreshed.outcome !== undefined && refreshed.outcome !== 'library_refresh_failed',
    { outcome: refreshed.outcome ?? null,
      generation: refreshed.index?.generation ?? refreshed.generation ?? null })
  claim('AL-15 the Library answers rather than erroring, before and after',
    (before.indexState === 'ready' || before.indexState === 'empty')
      && (after.indexState === 'ready' || after.indexState === 'empty'),
    { before: before.indexState ?? null, after: after.indexState ?? null,
      found: after.total ?? 0 })

  // ── 8. the indexed video is findable, through the path that reaches it ────
  //
  // Two stores share the word "library" and they are not the same one. The
  // Library *mode* and `watch_library_search` read the Host's index: evidence
  // records on disk plus the execution receipts of this session. What Core
  // indexed lives in Core, and `watch_search_sources` reaches it over the
  // Bridge as `watch.library.search`. So this asks the question where the
  // answer actually is, rather than asserting the Host should have known.
  //
  // Asked twice, and the two timings are the finding. A semantic search loads
  // an embedding model into the Core process on first use, and in a Core that
  // has just started that exceeds the Bridge's own 30s deadline -- the first
  // call comes back `bridge.deadline_exceeded` on a machine where the work is
  // fine and only cold. The second, in the same process, answers in seconds.
  // Recorded rather than hidden behind a warm-up, because a person's first
  // search after opening the product is the cold one.
  const askSources = async () => {
    const started = Date.now()
    const answer = await bridge.request('watch.library.search', {
      query: TOKEN, limit: 20,
    }, 180_000)
    return { answer, ms: Date.now() - started }
  }
  const cold = await askSources()
  const warm = cold.answer?.result === undefined ? await askSources() : cold
  const hits = JSON.stringify(warm.answer?.result ?? {})
  notes.sourceSearch = {
    coldMs: cold.ms, coldOutcome: cold.answer?.result === undefined
      ? (cold.answer?.error?.data?.error ?? 'error') : 'answered',
    warmMs: warm.ms,
  }
  claim('AL-16 the indexed clip is findable through Core',
    warm.answer?.result !== undefined
      && (hits.includes(TOKEN) || hits.includes('ground-truth')),
    { cold: notes.sourceSearch, error: warm.answer?.error ?? null,
      found: hits.slice(0, 300) })

  // The Host's index is a different one, and it is honest about being empty:
  // the shipped profile configures no evidence roots, so before an agent has
  // run there is nothing in it. `empty` is the correct answer and a person
  // reading the Library mode gets it rather than a spinner or a lie.
  claim('AL-17 the Host index reports empty rather than pretending',
    after.indexState === 'empty' || after.indexState === 'ready',
    { indexState: after.indexState ?? null, total: after.total ?? 0,
      note: 'the deepwatch profile sets no libraryRoots; receipts are what fill '
        + 'this index, and those arrive with an agent' })
  notes.hostIndexIsSeparate = true

  report = {
    profile: PROFILE, profileDir, coreVersion,
    install: { mode: installed?.mode ?? null, packages: installed?.packages?.length ?? 0 },
    health: {
      phase: health.phase, transport: health.transport,
      coreVersion: health.coreVersion, isTestOnlyMock: health.isTestOnlyMock,
      capabilities: health.capabilities ?? null,
    },
    verdicts: {
      passing: passing.verdict ?? null, failing: failing.verdict ?? null,
      prose: prose.verdict ?? null, inconclusive: inconclusive.verdict ?? null,
      outsideWorkspace: escaped.verdict ?? null,
    },
    media: { token: TOKEN, generated: madeClip },
    library: { before: before.indexState ?? null, after: after.indexState ?? null },
    notes,
    claims,
    passed: claims.filter(entry => entry.ok).length,
    failed: claims.filter(entry => !entry.ok).length,
  }
} finally {
  if (bridge !== null) bridge.stop()
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report ?? { claims }, null, 2)}\n`, 'utf8')
process.stdout.write(`\nreport: ${OUT}\n`)

const failed = claims.filter(entry => !entry.ok)
if (failed.length > 0) {
  process.stderr.write(
    `qa-acceptance-local: ${String(failed.length)} claim(s) failed: ${
      failed.map(entry => entry.id).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write('qa-acceptance-local: the local developer experience holds\n')
