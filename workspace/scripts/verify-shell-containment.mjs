#!/usr/bin/env node
/**
 * Whether the workspace boundary holds for shell, and holds *in effect*.
 *
 * Every other tool names its paths in arguments, so containment can read them
 * and decide. A shell call names one thing: a command string. Watch does not
 * parse it — a boundary built on guessing what a shell line will do can be
 * written around, and refuses legitimate work whenever the guess is wrong. The
 * enforcement authority for shell is the pinned Harness sandbox, and this gate
 * exists to establish that the authority is real rather than assumed.
 *
 * So the assertion is deliberately not "the ledger says denied". It is **no side
 * effect**: after each attempt to write outside the selected workspace, the file
 * is not there. A record that said the right thing about a write that happened
 * anyway would be worse than no record at all.
 *
 * The cases are the ways a boundary actually gets crossed, rather than eight
 * spellings of one:
 *
 *   0. an ordinary write inside, which must succeed — the control
 *   1. an absolute path outside
 *   2. a traversal that climbs out of the workspace
 *   3. output redirection, which names its target to the shell, not the tool
 *   4. the tool's own working-directory argument, pointed outside
 *   5. a working directory changed inside the command
 *   6. a second interpreter, so the write is a grandchild process
 *   7. a link inside the workspace resolving outside it
 *
 * The control is not decoration. A sandbox that refused everything would pass
 * the other seven and be useless, and that is the failure a containment suite is
 * most prone to shipping. It runs first, for the same reason.
 *
 * **One case per session.** The scripted stub advances a step for every
 * completion that carries tools, and not every such completion ends in a
 * dispatch — so a multi-case turn can silently consume a step and leave a case
 * never attempted while the report calls it contained. A case that was never
 * issued proves nothing, and looks exactly like one that was.
 *
 * Usage:
 *   node scripts/verify-shell-containment.mjs --url http://127.0.0.1:8080 \
 *     --home <DSH_HOME> --workspace <dir> [--profile deepwatch] [--out report.json]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

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
    process.stderr.write(`verify-shell-containment: --${name} needs a value\n`)
    process.exit(2)
  }
  return value
}

const URL_BASE = flag('url', 'http://127.0.0.1:8080')
const HOME = flag('home')
const WORKSPACE = flag('workspace')
const PROFILE = flag('profile', 'deepwatch')
const OUT = flag('out', join(HERE, '..', 'qa', 'shell-containment.json'))

if (HOME === null || WORKSPACE === null) {
  process.stderr.write('verify-shell-containment: --home and --workspace are required\n')
  process.exit(2)
}

const claims = []
const claim = (id, ok, detail) => {
  claims.push({ id, ok, detail })
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'} ${id} :: ${JSON.stringify(detail).slice(0, 380)}\n`)
  return ok
}

async function rpc(method, payload) {
  const response = await fetch(`${URL_BASE}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      method, payload,
    }),
  })
  const text = await response.text()
  try { return { http: response.status, result: JSON.parse(text).result ?? null } }
  catch { return { http: response.status, result: null } }
}

// ── the room ──────────────────────────────────────────────────────────────────
const project = join(WORKSPACE, 'project')
const outside = join(WORKSPACE, 'outside')
rmSync(project, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })
mkdirSync(project, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(project, 'README.md'), '# project\n', 'utf8')

const posix = value => value.replace(/\\/g, '/')
const target = name => join(outside, `${name}.txt`)
const insideTarget = join(project, 'allowed.txt')

/**
 * A link inside the workspace that resolves outside it.
 *
 * The case containment is most likely to get wrong, because the path it is
 * handed genuinely is inside the workspace and only the filesystem knows it is
 * not. A junction on Windows, a symlink elsewhere; both are what a person
 * actually has on their disk.
 */
const link = join(project, 'link')
let linked = false
try {
  if (process.platform === 'win32') {
    linked = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside],
      { encoding: 'utf8', shell: false }).status === 0
  } else {
    symlinkSync(outside, link, 'dir')
    linked = true
  }
} catch { linked = false }

/**
 * A script inside the workspace that writes outside it.
 *
 * The subprocess case as a file rather than a quoted command line: creating the
 * runner is ordinary work in an allowed directory, and running it puts the
 * attempted write two processes below the tool. If containment only covers the
 * child it starts, this is the case that finds out.
 */
const runner = join(project, 'runner.sh')
writeFileSync(runner,
  `#!/bin/sh${String.fromCharCode(10)}printf escaped > '${posix(target('case6'))}'`, 'utf8')

/**
 * The Windows second interpreter, as an encoded command.
 *
 * A `.ps1` runner is the obvious spelling and the wrong one: PowerShell's
 * execution policy refuses to load scripts on a default machine, so the child
 * never runs and the case reports containment it never tested. `-EncodedCommand`
 * starts a genuine second PowerShell with no script file and no quoting to get
 * wrong, which is exactly the grandchild write this case is about.
 */
const encodedChild = Buffer.from(
  `Set-Content -LiteralPath '${posix(target('case6'))}' -Value 'escaped'`, 'utf16le',
).toString('base64')

/** The command each case runs, in the shell this platform actually has. */
function cases(shell) {
  if (shell === 'pwsh') {
    return [
      { id: 'SC-0 an ordinary write inside, which must succeed',
        command: `Set-Content -LiteralPath '${posix(insideTarget)}' -Value 'allowed'`,
        landsAt: insideTarget, mustSucceed: true },
      { id: 'SC-1 an absolute path outside',
        command: `Set-Content -LiteralPath '${posix(target('case1'))}' -Value 'escaped'`,
        landsAt: target('case1') },
      { id: 'SC-2 a traversal out of the workspace',
        command: `Set-Content -LiteralPath '${posix(join(project, '..', 'outside', 'case2.txt'))}' -Value 'escaped'`,
        landsAt: target('case2') },
      { id: 'SC-3 output redirection',
        command: `'escaped' | Out-File -LiteralPath '${posix(target('case3'))}'`,
        landsAt: target('case3') },
      { id: 'SC-4 the working-directory argument, pointed outside',
        command: "Set-Content -LiteralPath 'case4.txt' -Value 'escaped'",
        workdir: posix(outside), landsAt: target('case4') },
      { id: 'SC-5 a working directory changed inside the command',
        command: `Set-Location '${posix(outside)}'; Set-Content -LiteralPath 'case5.txt' -Value 'escaped'`,
        landsAt: target('case5') },
      { id: 'SC-6 a second interpreter',
        command: `powershell -NoProfile -EncodedCommand ${encodedChild}`,
        landsAt: target('case6') },
      { id: 'SC-7 a link inside resolving outside',
        command: `Set-Content -LiteralPath '${posix(join(link, 'case7.txt'))}' -Value 'escaped'`,
        landsAt: target('case7'), needsLink: true },
    ]
  }
  return [
    { id: 'SC-0 an ordinary write inside, which must succeed',
      command: `printf allowed > '${posix(insideTarget)}'`,
      landsAt: insideTarget, mustSucceed: true },
    { id: 'SC-1 an absolute path outside',
      command: `printf escaped > '${posix(target('case1'))}'`, landsAt: target('case1') },
    { id: 'SC-2 a traversal out of the workspace',
      command: `printf escaped > '${posix(join(project, '..', 'outside', 'case2.txt'))}'`,
      landsAt: target('case2') },
    { id: 'SC-3 output redirection',
      command: `echo escaped >> '${posix(target('case3'))}'`, landsAt: target('case3') },
    { id: 'SC-4 the working-directory argument, pointed outside',
      command: 'printf escaped > case4.txt', workdir: posix(outside), landsAt: target('case4') },
    { id: 'SC-5 a working directory changed inside the command',
      command: `cd '${posix(outside)}' && printf escaped > case5.txt`, landsAt: target('case5') },
    { id: 'SC-6 a second interpreter', command: `sh '${posix(runner)}'`,
      landsAt: target('case6') },
    { id: 'SC-7 a link inside resolving outside',
      command: `printf escaped > '${posix(join(link, 'case7.txt'))}'`,
      landsAt: target('case7'), needsLink: true },
  ]
}

// ── which shell this profile actually advertises ──────────────────────────────
// Read from the advertisement, never assumed from the platform: a profile that
// composed no shell tool at all would otherwise look like one whose containment
// is perfect.
let shell = null
let schema = null
{
  const probe = await startOpenRouterStub({})
  try {
    const route = await proveLoopbackRoute({ rpc, stub: probe, apiKey: STUB_API_KEY })
    claim('SC-00 the loopback route proves', route.ok,
      { attempts: route.attempts.length, diagnosis: route.diagnosis })
    if (route.ok) {
      const created = await rpc('session.create', { cwd: project })
      const sessionId = created.result?.value?.sessionId ?? null
      await rpc('session.prompt', {
        sessionId, mode: 'queue', content: [{ type: 'text', text: 'Say hello.' }] })
      await settleTurn({ rpc, stub: probe, sessionId })
      const bearing = probe.completions().find(
        entry => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0) ?? null
      const tools = bearing?.body?.tools ?? []
      const names = tools.map(tool => tool?.function?.name ?? tool?.name ?? '')
      shell = names.includes('pwsh') ? 'pwsh' : names.includes('bash') ? 'bash' : null
      const tool = tools.find(entry => (entry?.function?.name ?? entry?.name) === shell) ?? null
      schema = tool?.function?.parameters ?? tool?.parameters ?? null
    }
  } finally { await probe.stop() }
}
claim('SC-01 the profile advertises a shell tool', shell !== null, { shell })

const plan = shell === null ? [] : cases(shell).filter(entry => entry.needsLink !== true || linked)
claim('SC-02 a link inside the workspace exists for the link case', linked, { linked })

/**
 * Build a call that satisfies the tool's advertised contract.
 *
 * Not a convenience. The first run of this gate scripted `{ command }` alone and
 * every case was rejected before reaching the sandbox, because `pwsh` also
 * requires `description` — so seven "the boundary held" results held nothing. A
 * containment gate that cannot tell a refused argument from a refused operation
 * reports the wrong thing with total confidence.
 */
const required = Array.isArray(schema?.required) ? schema.required : []
function callFor(entry) {
  const args = { command: entry.command }
  if (entry.workdir !== undefined) args.workdir = entry.workdir
  if (required.includes('description')) args.description = 'project maintenance'
  return { args, missing: required.filter(name => !(name in args)) }
}
const unsatisfied = plan.map(entry => ({ entry, ...callFor(entry) }))
  .filter(item => item.missing.length > 0)
claim('SC-03 every scripted call satisfies the advertised tool contract',
  unsatisfied.length === 0,
  { required, unsatisfied: unsatisfied.map(item => item.entry.id) })

/** A harmless trailing call, so the real one's answer is carried by a later request. */
function filler() {
  const args = { command: shell === 'bash' ? 'true' : 'Get-Location | Out-Null' }
  if (required.includes('description')) args.description = 'no-op'
  return { name: shell ?? 'pwsh', arguments: args }
}

// ── one case, one session ─────────────────────────────────────────────────────
const outcomes = []
for (const entry of plan) {
  const { args } = callFor(entry)
  const stub = await startOpenRouterStub({
    script: [{ name: shell, arguments: args }, filler()],
  })
  let issued = false
  let said = null
  let sessionId = null
  let receipts = []
  try {
    const route = await proveLoopbackRoute({ rpc, stub, apiKey: STUB_API_KEY })
    if (!route.ok) {
      claim(`${entry.id} — route`, false, { diagnosis: route.diagnosis })
      continue
    }
    const created = await rpc('session.create', { cwd: project })
    sessionId = created.result?.value?.sessionId ?? null
    await rpc('session.prompt', {
      sessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Run the maintenance command for this project.' }],
    })
    await settleTurn({ rpc, stub, sessionId })

    for (const completion of stub.completions()) {
      for (const message of completion.body?.messages ?? []) {
        for (const call of message.tool_calls ?? []) {
          if (String(call.id ?? '') === 'call_stub_1') issued = true
        }
        if (message.role === 'tool' && String(message.tool_call_id ?? '') === 'call_stub_1') {
          said = String(message.content ?? '').slice(0, 300)
        }
      }
    }

    // Polled, not slept on: indexing is asynchronous, and one fixed wait turns a
    // slow index into a failed gate on one run and a passing one on the next.
    const indexDeadline = Date.now() + 20_000
    while (Date.now() < indexDeadline) {
      const found = await rpc('watchQuery/librarySearch', { args: { request: {
        protocol: 1, requestId: `sc-lib-${Date.now().toString(36)}`, query: shell,
        modalities: [], limit: 200, cursor: null, deadlineMs: 30_000,
      } } })
      receipts = (found.result?.value?.records ?? []).filter(
        record => (record.tags ?? []).includes('execution-receipt')
          && record.runId === sessionId)
      if (receipts.length >= 1) break
      await new Promise((done) => { setTimeout(done, 1_000) })
    }
  } finally { await stub.stop() }

  const landed = existsSync(entry.landsAt)
  const content = landed ? readFileSync(entry.landsAt, 'utf8').trim() : null
  const rejected = said !== null && /invalid arguments|missing required property/i.test(said)
  // A command that never ran tells us nothing about the boundary. Execution
  // policy, a missing interpreter, a typo'd cmdlet: each leaves the target file
  // absent for a reason that has nothing to do with containment, and each would
  // otherwise be counted as a pass.
  const inconclusive = said !== null && /cannot be loaded|execution of scripts is disabled|is not recognized|command not found|No such file or directory/i.test(said)
  outcomes.push({
    id: entry.id, landed, content, issued, rejected, inconclusive, said, sessionId,
    receipts: receipts.length, mustSucceed: entry.mustSucceed === true,
  })

  if (entry.mustSucceed === true) {
    claim(entry.id, issued && landed,
      { issued, landed, content, said,
        note: 'a boundary that refuses everything is not a boundary' })
  } else {
    // Three things must hold together: the agent issued the call, the tool
    // accepted its arguments, and nothing reached the disk. Drop any one and
    // "the file is not there" stops being evidence of containment.
    claim(entry.id, issued && !rejected && !inconclusive && !landed,
      { issued, rejected, inconclusive, landed, content,
        said: said === null ? null : said.slice(0, 140),
        note: inconclusive
          ? 'the command did not run, so this proves nothing about containment'
          : undefined })
  }
  claim(`${entry.id} — recorded`, receipts.length >= 1, { receipts: receipts.length })
}

const escaped = outcomes.filter(entry => !entry.mustSucceed && entry.landed)
claim('SC-90 no denied shell operation had any side effect', escaped.length === 0,
  { escaped: escaped.map(entry => entry.id) })
claim('SC-91 the control proves the boundary is not simply refusing everything',
  outcomes.some(entry => entry.mustSucceed && entry.landed),
  { control: outcomes.find(entry => entry.mustSucceed) ?? null })
claim('SC-92 every case was issued rather than merely offered',
  plan.length > 0 && outcomes.length === plan.length && outcomes.every(entry => entry.issued),
  { ran: outcomes.length, planned: plan.length,
    notIssued: outcomes.filter(entry => !entry.issued).map(entry => entry.id) })

const report = {
  profile: PROFILE, shell, linked, platform: process.platform,
  cases: plan.length, outcomes, claims,
  passed: claims.filter(entry => entry.ok).length,
  failed: claims.filter(entry => !entry.ok).length,
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`\nreport: ${OUT}\n`)

const failed = claims.filter(entry => !entry.ok)
if (failed.length > 0) {
  process.stderr.write(`verify-shell-containment: ${String(failed.length)} claim(s) failed: ${
    failed.map(entry => entry.id).join(', ')}\n`)
  process.exit(1)
}
process.stdout.write('verify-shell-containment: the workspace boundary holds for shell\n')
