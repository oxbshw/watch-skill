#!/usr/bin/env node
/**
 * The capture must not disturb the application it is photographing.
 *
 * This exists because it did. Running the screenshot tool took the normal
 * Desktop down with it — Electron implements its single-instance lock as a
 * socket and lock file inside `userData`, and two processes of the same app
 * share that path by default. A second Electron starting up disturbed the
 * first one's singleton, and quitting released state the first still needed.
 *
 * A unit test cannot see that. It is a property of two real operating-system
 * processes, so the check runs two real processes and watches what happens to
 * the first while the second lives and dies.
 *
 * Nine assertions, in the order a person would make them:
 *
 *   1. Desktop is up; record its pid, its Watch Core child, its host and the
 *      digest of what that host serves.
 *   2. Run the capture to completion.
 *   3. The Desktop pid is the same process, not a replacement with the same
 *      name.
 *   4. Its Watch Core child is still there.
 *   5. Its host still answers.
 *   6. The digest is unchanged — same build, not a reload of something else.
 *   7. Run the capture a second time; it must be idempotent.
 *   8. Everything above still holds.
 *   9. No capture process is left behind.
 *
 * Usage: node scripts/qa-lifecycle-check.mjs
 *
 * Expects a Desktop already running. It starts nothing and stops nothing,
 * because a check that restarts the subject cannot observe survival.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOG = process.env.WATCH_DESKTOP_LOG ?? 'G:/watch-manual/logs/desktop-main.log'
const OUT = process.env.WATCH_QA_OUT ?? 'G:/watch-manual/qa/lifecycle'

const failures = []
const notes = []

function check(ok, claim, detail = '') {
  const line = `${ok ? 'ok  ' : 'FAIL'}  ${claim}${detail === '' ? '' : `  — ${detail}`}`
  notes.push(line)
  if (!ok) failures.push(claim)
  process.stdout.write(`  ${line}\n`)
}

/** Every live pid for an image name, via the platform's own tooling. */
function pidsOf(image) {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `@(Get-Process ${image} -EA SilentlyContinue).Id -join ','`],
      { encoding: 'utf8' },
    )
    return (result.stdout ?? '').trim().split(',').filter(part => part !== '').map(Number)
  }
  const result = spawnSync('pgrep', ['-f', image], { encoding: 'utf8' })
  return (result.stdout ?? '').trim().split('\n').filter(part => part !== '').map(Number)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** The most recent readiness line the Desktop wrote. */
function desktopState() {
  if (!existsSync(LOG)) return null
  const lines = readFileSync(LOG, 'utf8').split('\n').filter(l => l.includes('WATCH_DESKTOP_READY'))
  const last = lines.at(-1)
  if (last === undefined) return null
  try {
    return JSON.parse(last.slice(last.indexOf('{')))
  } catch {
    return null
  }
}

async function digestOf(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    const body = Buffer.from(await response.arrayBuffer())
    return {
      status: response.status,
      bytes: body.length,
      digest: createHash('sha256').update(body).digest('hex').slice(0, 16),
    }
  } catch (error) {
    return { status: 0, bytes: 0, digest: '', error: String(error) }
  }
}

function electronBinary() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith('electron@')) continue
    const candidate = join(store, entry, 'node_modules', 'electron', 'dist', 'electron.exe')
    if (existsSync(candidate)) return candidate
    const unix = join(store, entry, 'node_modules', 'electron', 'dist', 'electron')
    if (existsSync(unix)) return unix
  }
  return null
}

function runCapture(url, out, label) {
  const binary = electronBinary()
  if (binary === null) {
    check(false, 'the Electron binary is resolvable')
    return { code: -1 }
  }
  const started = Date.now()
  const result = spawnSync(binary, [join(ROOT, 'scripts', 'qa-screenshots.mjs')], {
    env: {
      ...process.env,
      WATCH_QA_URL: url,
      WATCH_QA_OUT: out,
      // Its own profile, well away from the Desktop's.
      WATCH_QA_PROFILE: join(out, `profile-${label}`),
    },
    stdio: 'ignore',
    timeout: 600_000,
  })
  return { code: result.status ?? -1, ms: Date.now() - started }
}

async function main() {
  process.stdout.write('qa lifecycle: does capture leave the running Desktop alone?\n\n')

  // ── 1. the subject, before ────────────────────────────────────────────────
  const before = desktopState()
  if (before === null) {
    process.stderr.write('watch: no WATCH_DESKTOP_READY line found. Start Desktop first.\n')
    process.exit(1)
  }
  const desktopPid = before.pid
  const hostUrl = before.hostUrl
  check(alive(desktopPid), 'Desktop is running', `pid ${String(desktopPid)}`)
  check(before.mode === 'normal', 'Desktop is in normal mode, not safe mode', before.mode)

  const coresBefore = pidsOf('watch-skill')
  check(coresBefore.length > 0, 'a Watch Core is running', `${String(coresBefore.length)} process(es)`)

  const servedBefore = await digestOf(hostUrl)
  check(servedBefore.status === 200, 'the supervised Host answers', `${String(servedBefore.status)} ${String(servedBefore.bytes)} bytes`)

  const captureBefore = pidsOf('electron').filter(pid => pid !== desktopPid)

  // ── 2 & 3. capture, twice ─────────────────────────────────────────────────
  for (const pass of ['first', 'second']) {
    const run = runCapture(hostUrl, join(OUT, pass), pass)
    check(run.code === 0, `the capture completes (${pass} run)`, `exit ${String(run.code)} in ${String(run.ms ?? 0)}ms`)

    check(alive(desktopPid), `Desktop survives the ${pass} capture`, `pid ${String(desktopPid)}`)

    const coresNow = pidsOf('watch-skill')
    check(
      coresNow.length >= coresBefore.length,
      `the Watch Core child survives the ${pass} capture`,
      `${String(coresBefore.length)} → ${String(coresNow.length)}`,
    )

    const servedNow = await digestOf(hostUrl)
    check(servedNow.status === 200, `the Host still answers after the ${pass} capture`)
    check(
      servedNow.digest === servedBefore.digest && servedNow.digest !== '',
      `the served build is unchanged after the ${pass} capture`,
      `${servedBefore.digest} → ${servedNow.digest}`,
    )

    const state = desktopState()
    check(
      state?.pid === desktopPid && state.hostUrl === hostUrl,
      `Desktop did not restart during the ${pass} capture`,
      `pid ${String(state?.pid)} host ${String(state?.hostUrl)}`,
    )
  }

  // ── idempotence ───────────────────────────────────────────────────────────
  const first = existsSync(join(OUT, 'first', 'index.json'))
    ? JSON.parse(readFileSync(join(OUT, 'first', 'index.json'), 'utf8'))
    : []
  const second = existsSync(join(OUT, 'second', 'index.json'))
    ? JSON.parse(readFileSync(join(OUT, 'second', 'index.json'), 'utf8'))
    : []
  check(
    first.length > 0 && first.length === second.length,
    'two runs produce the same shot list',
    `${String(first.length)} vs ${String(second.length)}`,
  )
  check(
    first.map(shot => shot.name).join() === second.map(shot => shot.name).join(),
    'the shots are the same, in the same order',
  )

  // ── 9. nothing left behind ────────────────────────────────────────────────
  const captureAfter = pidsOf('electron').filter(pid => pid !== desktopPid)
  check(
    captureAfter.length <= captureBefore.length,
    'no capture process is left running',
    `${String(captureBefore.length)} → ${String(captureAfter.length)} non-Desktop electron`,
  )

  process.stdout.write(`\n${String(notes.length - failures.length)}/${String(notes.length)} checks passed\n`)
  if (failures.length > 0) {
    process.stderr.write(`\nwatch: ${String(failures.length)} lifecycle failure(s)\n`)
    for (const failure of failures) process.stderr.write(`  ${failure}\n`)
    process.exit(1)
  }
}

await main()
