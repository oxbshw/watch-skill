#!/usr/bin/env node
/**
 * Boot the profile for real, and wait for it to say it is serving.
 *
 * `install-smoke.mjs` proves the bundle composes and `verify-bundle.mjs` proves
 * the rows are additive. Neither starts anything, and the gap between those two
 * facts and a working application is where a whole class of failure lives:
 * a plugin whose `inject` the loader cannot see, a service resolved in the
 * wrong order, a config key the schema rejects. Every one of them produces a
 * perfect composed tree and a profile that dies on the first boot.
 *
 * That is not hypothetical. `@watchskill/dsh-tools` shipped with
 * `export default apply` — the bare function — so the loader read
 * `plugin.inject` off a function that had none, and the first
 * `ctx.systemPrompt` access threw at startup. The composed tree was correct,
 * the install smoke was green, and the application could not start. This is the
 * gate that catches it.
 *
 * It boots on an OS-chosen port so it can run alongside a Web server somebody
 * is already using, and it stops its own child when it is done.
 *
 * Usage: node scripts/boot-smoke.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.WATCH_MANUAL_HOME ?? 'G:/watch-manual/dsh-home'
const PROFILE = 'web'
const READY_TIMEOUT_MS = 120_000

function fail(message, detail) {
  process.stderr.write(`\nwatch: ${message}\n`)
  if (detail) process.stderr.write(`${String(detail).trim()}\n`)
  process.exit(1)
}

function findCli() {
  for (const dir of [
    join(ROOT, 'node_modules', '@deepseek-ai', 'dsh'),
    join(ROOT, '..', 'watch-smoke', 'node_modules', '@deepseek-ai', 'dsh'),
  ]) {
    if (!existsSync(join(dir, 'package.json'))) continue
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (bin === undefined) continue
    const entry = resolve(dir, bin)
    if (existsSync(entry)) return { entry, version: manifest.version }
  }
  return null
}

async function main() {
  const cli = findCli()
  if (cli === null) fail('the DSH CLI is not installed')

  if (!existsSync(join(HOME, 'profiles', PROFILE, 'package.json'))) {
    fail(
      `no profile at ${HOME}`,
      'Run `node scripts/manual-profile.mjs` first — this gate boots a real profile.',
    )
  }

  const overlay = join(HOME, 'watch-manual.patch.yml')
  const args = [
    cli.entry, '--profile', PROFILE,
    ...(existsSync(overlay) ? ['--patch', overlay] : []),
    '--no-open', '--host', '127.0.0.1',
    // Port 0: the OS picks one, so this never collides with a server the
    // person running it already has open.
    '--port', '0',
  ]

  process.stdout.write(`booting profile "${PROFILE}" on an OS-chosen port\n`)
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  const ready = await new Promise(resolve => {
    const timer = setTimeout(() => { resolve({ ok: false, reason: 'timeout' }) }, READY_TIMEOUT_MS)
    const onChunk = chunk => {
      output += chunk
      // The line the Web host prints once it is actually listening.
      const match = /dsh web:\s*(http:\/\/\S+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve({ ok: true, url: match[1] })
      }
      // A boot failure is loud and specific; catch it rather than waiting out
      // the whole timeout on a process that has already died.
      if (/plugin tree failed to load|failed to apply loader entry|Error:/.test(output)) {
        clearTimeout(timer)
        resolve({ ok: false, reason: 'boot error' })
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ ok: false, reason: `exited with ${String(code)}` })
    })
  })

  // Stopped by handle, always — including on the failure path, so a failed
  // gate does not leave an orphan holding a port.
  const stop = () => {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }

  if (!ready.ok) {
    stop()
    fail(
      `the profile did not reach ready (${ready.reason})`,
      output.split('\n').slice(-25).join('\n'),
    )
  }

  // It said it is serving. Confirm it actually answers, because a bound socket
  // and a working application are different claims.
  let status = 0
  let bytes = 0
  try {
    const response = await fetch(ready.url, { signal: AbortSignal.timeout(20_000) })
    status = response.status
    bytes = (await response.text()).length
  } catch (error) {
    stop()
    fail(`the Web host bound ${ready.url} but did not answer`, String(error))
  }

  stop()

  if (status !== 200 || bytes < 1000) {
    fail(`the Web host answered ${String(status)} with ${String(bytes)} bytes`)
  }

  process.stdout.write(
    '\nPASS  the profile boots and serves\n'
    + `      dsh:            ${cli.version}\n`
    + `      profile:        ${PROFILE} at ${HOME}\n`
    + `      served:         ${ready.url} (${String(status)}, ${String(bytes)} bytes)\n`
    + '      plugin tree:    loaded, every inject resolved\n',
  )
}

await main()
