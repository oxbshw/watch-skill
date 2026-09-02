#!/usr/bin/env node
/**
 * Run the browser end-to-end pass: reset, serve a provider, drive, account.
 *
 * The harness in `qa-e2e.mjs` runs inside Electron and can see the screen. It
 * cannot see the wire, and the wire is where the failure that started all of
 * this actually happened — a person configured OpenRouter and their first
 * message went to DeepSeek. So this half owns the provider: it starts a
 * loopback stub, hands the harness its address, and afterwards counts what
 * arrived.
 *
 * Counting is the point. A pass that only checked the answer on screen would
 * be satisfied by an implementation that called two providers and rendered the
 * second one.
 *
 *   node scripts/qa-e2e-run.mjs --url http://127.0.0.1:8931 --home <profile>/home
 *
 * `--home` is required and is reset before the run: the add-provider catalogue
 * only offers providers that are not yet configured, so a second pass against
 * a configured profile would report "provider saved" without having saved
 * anything. Resetting is what makes the run repeatable and the report true.
 *
 * Nothing here reaches the internet. The stub binds loopback on a port the
 * operating system picks, and no code path in this file reads a provider
 * credential from the environment.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = join(HERE, '..')

const { startOpenRouterStub, STUB_API_KEY, classifyCompletion } = await import(
  pathToFileURL(join(WORKSPACE, 'scripts', 'lib', 'openrouter-stub.mjs')).href)

/** Read `--name value` pairs, because this has three and no more. */
function option(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

/**
 * The version this candidate builds.
 *
 * Read from the source of truth rather than restated: the wheel the profile
 * installs is built from this `pyproject.toml`, so what Diagnostics shows has
 * to equal it. A number typed into the harness proves only that somebody
 * remembered to update the harness.
 */
function candidateCoreVersion() {
  const pyproject = join(WORKSPACE, '..', 'pyproject.toml')
  if (!existsSync(pyproject)) return ''
  return /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(pyproject, 'utf8'))?.[1] ?? ''
}

const URL = option('url', 'http://127.0.0.1:8931')
const HOME = option('home')
const OUT = option('out', join(WORKSPACE, 'qa', 'e2e'))

if (HOME === null) {
  process.stderr.write('qa-e2e-run: --home <profile>/home is required\n')
  process.exit(2)
}

/**
 * Return the profile to "no provider configured".
 *
 * Two files hold it: the credential store, and the `providers` block in
 * settings. Removing the store and that block is the smallest reset that
 * restores the precondition — rebuilding the whole runtime takes four minutes
 * and proves nothing extra about the provider flow.
 */
function resetProviders(home) {
  const dshHome = join(home, 'dsh-home')
  const credentials = join(dshHome, '.credentials.yaml')
  if (existsSync(credentials)) {
    rmSync(credentials)
    process.stdout.write('reset: removed the credential store\n')
  }

  const settingsPath = join(dshHome, 'settings.yaml')
  if (!existsSync(settingsPath)) return

  // Keep the onboarding block, drop everything else.
  //
  // Deleting the file would be simpler and wrong: `ui-onboarding` carries the
  // profile-scoped suppression of upstream's Internal Testing Notice, and
  // losing it would resurrect a second first-run dialog — which the harness
  // then asserts is absent, so the reset would be quietly breaking the thing
  // it exists to set up.
  //
  // Removing just the `providers:` block was the first attempt and was worse
  // than either: providers are nested under a provider-plugin key, so the
  // surgery left a parent with nothing under it and a settings file the app
  // read differently. Rebuilding from the one block that must survive has no
  // such failure mode.
  const lines = readFileSync(settingsPath, 'utf8').split('\n')
  const kept = []
  let keeping = false
  for (const line of lines) {
    if (/^\S/.test(line)) keeping = /^ui-onboarding:/.test(line)
    if (keeping) kept.push(line)
  }
  writeFileSync(settingsPath, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
  process.stdout.write(
    `reset: settings reduced to ${String(kept.length)} onboarding line(s)\n`)
}

/**
 * The Electron binary the Desktop app already depends on.
 *
 * Found in the pnpm store rather than by `require('electron')`: it is a
 * transitive dependency, so it has no entry in the workspace root's
 * `node_modules` to resolve through.
 */
function electron() {
  const store = join(WORKSPACE, 'node_modules', '.pnpm')
  if (!existsSync(store)) throw new Error('qa-e2e-run: no pnpm store; run pnpm install')
  const pkg = readdirSync(store).find(entry => entry.startsWith('electron@'))
  if (pkg === undefined) throw new Error('qa-e2e-run: electron is not installed')
  const dist = join(store, pkg, 'node_modules', 'electron', 'dist')
  for (const name of ['electron.exe', 'electron']) {
    const candidate = join(dist, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`qa-e2e-run: no electron binary under ${dist}`)
}


/**
 * The one thing this pass says to the model.
 *
 * Short and unmistakable: the assertion below looks for this exact string as a
 * user message, so it has to be something no system prompt would contain on
 * its own.
 */
const PROMPT_TEXT = 'Say hello.'

/** How long the browser pass may take before it is treated as wedged. */
const BROWSER_BUDGET_MS = 15 * 60_000

/**
 * End an Electron run, including one that will not end itself.
 *
 * `child.kill()` signals the launcher. Electron's renderer and GPU processes
 * are its children, they keep the inherited stdio pipes open, and on Windows
 * they are not signalled at all — so `close` never fires and the watchdog
 * that exists to bound this run waits with it. A wedged renderer once held a
 * local pass for three hours past its fifteen-minute budget, which in CI is a
 * job that burns to its own ceiling and reports nothing.
 */
function endElectron(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

/** Run Electron without blocking the loopback stub's event loop. */
function runElectron(command, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...process.platform === 'win32' ? {} : { detached: true },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(result)
    }
    // Settled here rather than from `close`: the point of a budget is that it
    // holds even when the thing it is bounding cannot report.
    const timer = setTimeout(() => {
      endElectron(child)
      finish({
        status: 124,
        stdout,
        stderr: `${stderr}\nqa-e2e-run: the browser pass exceeded `
          + `${String(BROWSER_BUDGET_MS)}ms and was terminated`,
      })
    }, BROWSER_BUDGET_MS)
    child.once('error', error => {
      finish({ status: 1, stdout, stderr: `${stderr}\n${error.name}` })
    })
    child.once('close', code => { finish({ status: code ?? 1, stdout, stderr }) })
  })
}

/** The browser pass's named claims, by id. Empty when it never wrote one. */
function readClaims(path) {
  if (!existsSync(path)) return new Map()
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'))
    return new Map((report.claims ?? []).map(entry => [entry.id, entry]))
  } catch {
    return new Map()
  }
}

/** One RPC against the running Host, in the shape its API expects. */
async function rpc(base, method, payload) {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `e2e-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
      method,
      payload,
    }),
  })
  const body = await response.json()
  if (body?.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(body?.result ?? body).slice(0, 300)}`)
  }
  return body.result.value
}

/**
 * Send exactly one prompt, through whatever the browser bound.
 *
 * Deliberately no `session.selectModel`. The point is that assigning Chat in
 * the UI is what decides where a prompt goes — choosing the model again here
 * would prove the RPC works and say nothing about the binding, which is the
 * thing that was broken.
 *
 * `session.create` takes a `cwd`, so this needs no workspace picker.
 */
async function promptOnce(base, cwd) {
  const created = await rpc(base, 'session.create', { cwd })
  const sessionId = created.sessionId
  await rpc(base, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: PROMPT_TEXT }],
  })

  const deadline = Date.now() + 90_000
  let last = null
  while (Date.now() < deadline) {
    const listed = await rpc(base, 'session.list', {})
    last = listed.items.find(item => item.sessionId === sessionId) ?? null
    if (last !== null && last.running === false && last.blank === false) break
    await new Promise((done) => { setTimeout(done, 500) })
  }
  return { sessionId, settled: last }
}

async function main() {
  const beganAt = Date.now()
  mkdirSync(OUT, { recursive: true })
  // A report from an earlier pass is worse than none: the accounting below
  // reads it back, and a run that never wrote one would otherwise be described
  // by its predecessor's claims.
  rmSync(join(OUT, 'e2e-report.json'), { force: true })
  resetProviders(HOME)

  const stub = await startOpenRouterStub()
  process.stdout.write(`stub: ${stub.baseURL}\n`)

  let status = 1
  let promptOutcome = null
  try {
    const run = await runElectron(electron(), [join(WORKSPACE, 'scripts', 'qa-e2e.mjs')], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        WATCH_E2E_URL: URL,
        WATCH_E2E_OUT: OUT,
        WATCH_E2E_STUB: stub.baseURL,
        WATCH_E2E_STUB_402: stub.scenarioURL('402'),
        WATCH_E2E_STUB_429: stub.scenarioURL('429'),
        WATCH_E2E_STUB_TIMEOUT: stub.scenarioURL('timeout'),
        WATCH_E2E_STUB_KEY: STUB_API_KEY,
        WATCH_E2E_CORE_VERSION: candidateCoreVersion(),
      },
    })
    status = run.status ?? 1
    if (status !== 0) {
      // Otherwise a browser pass that never started is indistinguishable from
      // one that started and proved nothing: the job log showed a stub with
      // zero requests and no reason for it. Electron's own diagnostics go to
      // the streams this captured, and they are the only place the reason is.
      const tail = text => text.split('\n').slice(-40).join('\n').trim()
      process.stderr.write(`electron exited ${String(status)}\n`)
      if (run.stdout.trim() !== '') process.stderr.write(`stdout:\n${tail(run.stdout)}\n`)
      if (run.stderr.trim() !== '') process.stderr.write(`stderr:\n${tail(run.stderr)}\n`)
    }

    // One prompt, through the binding the browser just made.
    //
    // Counted rather than merely observed: a pass that checked only the answer
    // on screen would be satisfied by an implementation that called two
    // providers and rendered the second. The original failure was exactly
    // that shape — a person configured OpenRouter and their first message went
    // to DeepSeek.
    if (status === 0) {
      const cwd = mkdtempSync(join(tmpdir(), 'deepwatch-e2e-cwd-'))
      try {
        const turn = await promptOnce(URL, cwd)
        promptOutcome = {
          sessionId: turn.sessionId,
          blank: turn.settled?.blank ?? null,
          running: turn.settled?.running ?? null,
        }
        process.stdout.write(`prompt: session ${turn.sessionId} settled\n`)
      } catch (cause) {
        promptOutcome = { error: cause instanceof Error ? cause.message : String(cause) }
        process.stderr.write(`prompt: ${JSON.stringify(promptOutcome.error)}\n`)
        status = 1
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  } finally {
    // What the provider actually saw, whatever the screen said.
    //
    // Classified, and never the payload itself: these bodies carry the session
    // workspace path, which on a developer's machine contains their user name.
    // Evidence that has to be redacted before it can be shown is evidence
    // somebody will eventually forget to redact.
    const requests = stub.requests.map(entry => ({
      method: entry.method, url: entry.url,
      ...classifyCompletion(entry, PROMPT_TEXT, STUB_API_KEY),
    }))
    const completions = requests.filter(entry => entry.url.includes('/chat/completions'))
    const accounting = {
      stubUrl: stub.baseURL,
      total: requests.length,
      completions: completions.length,
      catalogueReads: requests.filter(entry => entry.url.includes('/models')).length,
      prompt: promptOutcome,
      // The stub is the only server this pass starts, so anything the product
      // sent elsewhere simply is not here. That is why the offline-egress gate
      // exists beside this and is not replaced by it.
      requests,
    }
    writeFileSync(join(OUT, 'stub-accounting.json'),
      `${JSON.stringify(accounting, null, 2)}\n`, 'utf8')
    process.stdout.write(
      `stub saw ${String(requests.length)} request(s): `
      + `${String(accounting.catalogueReads)} catalogue, `
      + `${String(completions.length)} completion(s)\n`)

    // Four claims about where a person's first message went.
    const sent = promptOutcome !== null && promptOutcome.error === undefined
    const turns = completions.filter(entry => entry.kind === 'turn')
    const fail = (message) => {
      process.stderr.write(`qa-e2e-run: ${message}\n`)
      status = status === 0 ? 1 : status
    }

    // One prompt is one turn. Zero means it went somewhere this stub is not,
    // which is the defect this whole pass exists for; two means it was sent
    // twice.
    if (turns.length !== (sent ? 1 : 0)) {
      fail(`expected ${String(sent ? 1 : 0)} turn(s), the provider saw `
        + `${String(turns.length)}`)
    }

    // Every other call is accounted for by name. The session-title call is
    // expected and allowed; anything this harness cannot name is a request
    // nobody reviewed, and that is exactly the thing worth failing on.
    const unrecognised = completions.filter(entry => entry.kind === 'unrecognised')
    if (unrecognised.length > 0) {
      fail(`${String(unrecognised.length)} unrecognised completion(s) reached the `
        + `provider: ${JSON.stringify(unrecognised.map(entry => entry.roles))}`)
    }

    // Including the auxiliary one, which must not quietly use a different
    // model than the person chose.
    const bound = turns[0]?.model ?? null
    const strays = completions.filter(entry => entry.model !== bound)
    if (bound !== null && strays.length > 0) {
      fail(`${String(strays.length)} completion(s) used a model other than the `
        + `bound ${bound}: ${JSON.stringify(strays.map(entry => entry.model))}`)
    }

    // And the credential stays in the header where it belongs.
    const leaks = requests.filter(entry => entry.leaksCredential)
    if (leaks.length > 0) {
      fail(`${String(leaks.length)} request(s) carried the credential in the body`)
    }
    const providerTests = completions.filter(entry => entry.kind === 'provider-test')

    // Everything below is read back from the browser pass rather than
    // restated. The Core connection in particular: a report that says
    // `connected` because the file says `connected` is the same class of
    // claim as the green dot, and it feeds the screenshot manifest's
    // Diagnostics verdict.
    const browser = readClaims(join(OUT, 'e2e-report.json'))
    const observed = id => browser.get(id) ?? null
    const passed = id => observed(id)?.ok === true
    const FAILURE_CLAIMS = [
      ['invalid_credential', 'invalid-credential-reported'],
      ['payment_required', 'payment-required-reported'],
      ['rate_limited', 'rate-limited-reported'],
      ['timeout', 'timeout-reported'],
      ['cancelled', 'cancelled-reported'],
    ]
    const safeReport = {
      schemaVersion: 1,
      sha: process.env['GITHUB_SHA'] ?? 'local-uncommitted',
      platform: process.platform,
      scenario: 'provider-bind-first-prompt',
      result: status === 0 ? 'passed' : 'failed',
      provider: 'openrouter-e2e',
      providerLabel: 'OpenRouter QA (local stub)',
      model: bound,
      modelLabel: bound === 'stub/echo-small' ? 'Stub Echo Small' : null,
      core: browser.size === 0
        ? 'not_observed'
        : passed('diagnostics-core-connected') ? 'connected' : 'not_connected',
      coreTransport: observed('diagnostics-transport-stdio')?.observed?.transport ?? 'not_observed',
      coreVersion: observed('diagnostics-real-version')?.observed?.shown ?? 'not_observed',
      requestClassification: {
        catalogue: accounting.catalogueReads,
        providerTest: providerTests.length,
        chatTurn: turns.length,
        sessionTitle: completions.filter(entry => entry.kind === 'session-title').length,
        unexpected: unrecognised.length,
      },
      durationMs: Date.now() - beganAt,
      errorCategories: [
        ...status === 0 ? [] : ['browser_journey_failed'],
        ...[...browser.values()].filter(entry => entry.ok === false)
          .map(entry => `claim:${entry.id}`),
      ],
      // The scenarios this pass actually exercised and saw reported honestly,
      // not the list of scenarios somebody intended to write.
      failureScenarios: FAILURE_CLAIMS
        .filter(([, id]) => passed(id)).map(([name]) => name),
    }
    writeFileSync(join(OUT, 'ci-report.json'), `${JSON.stringify(safeReport, null, 2)}\n`, 'utf8')
    await stub.stop()
  }
  process.exit(status)
}

await main()
