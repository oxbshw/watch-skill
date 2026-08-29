#!/usr/bin/env node
/**
 * Fail when the desktop's security posture is written somewhere other than the
 * one place it is supposed to live.
 *
 * The unit tests cover the *decisions*: what `decidePermission` returns, what
 * `mayNavigate` allows. What they cannot cover is the wiring — whether the main
 * process actually passes the frozen preferences object to `new BrowserWindow`,
 * or whether somebody added a convenience passthrough to the preload at 11pm.
 * Those are grep-shaped problems, so this is a grep-shaped gate.
 *
 * Every rule here corresponds to a way Electron applications are actually
 * compromised, rather than to a checklist item:
 *
 * - a renderer with Node integration turns a line of OCR into a filesystem call;
 * - a preload with `invoke(channel, ...args)` makes every future main-process
 *   handler part of the renderer's attack surface;
 * - a supervisor that kills by process name kills somebody else's process;
 * - a secret on a command line is readable by every process on the machine.
 *
 * Usage: node scripts/verify-desktop-security.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'apps', 'desktop', 'src')

/** Read one desktop source file. */
function read(name) {
  const path = join(SOURCE, name)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

/** Every desktop source file, for the rules that apply to all of them. */
function allSources() {
  if (!existsSync(SOURCE)) return []
  return readdirSync(SOURCE)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ name, text: readFileSync(join(SOURCE, name), 'utf8') }))
}

/**
 * Strip comments, so a rule that forbids a pattern is not satisfied or tripped
 * by prose about that pattern. Several files here discuss `taskkill` precisely
 * because they must not use it.
 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function main() {
  const problems = []
  const security = read('security.ts')
  const preload = read('preload.ts')
  const mainProcess = read('main.ts')

  if (security === null || preload === null || mainProcess === null) {
    process.stderr.write('watch: apps/desktop/src is missing security.ts, preload.ts or main.ts\n')
    process.exit(1)
  }

  // ── the posture is one frozen object ──────────────────────────────────────
  for (const [property, value] of [
    ['nodeIntegration', 'false'],
    ['nodeIntegrationInWorker', 'false'],
    ['nodeIntegrationInSubFrames', 'false'],
    ['contextIsolation', 'true'],
    ['sandbox', 'true'],
    ['enableRemoteModule', 'false'],
    ['webSecurity', 'true'],
    ['allowRunningInsecureContent', 'false'],
    ['webviewTag', 'false'],
  ]) {
    const pattern = new RegExp(`${property}:\\s*${value}\\b`)
    if (!pattern.test(code(security))) {
      problems.push(`security.ts does not set ${property}: ${value}`)
    }
  }
  if (!/Object\.freeze\(\{[\s\S]*nodeIntegration/.test(code(security))) {
    problems.push('RENDERER_PREFERENCES is not frozen, so a caller can change the posture for every later window')
  }

  // ── the main process uses it, rather than its own copy ────────────────────
  if (!/\.\.\.RENDERER_PREFERENCES/.test(code(mainProcess))) {
    problems.push('main.ts creates a window without spreading RENDERER_PREFERENCES')
  }
  for (const forbidden of [
    /nodeIntegration:\s*true/,
    /contextIsolation:\s*false/,
    /sandbox:\s*false/,
    /webSecurity:\s*false/,
    /allowRunningInsecureContent:\s*true/,
  ]) {
    if (forbidden.test(code(mainProcess))) {
      problems.push(`main.ts weakens the posture: ${String(forbidden)}`)
    }
  }
  if (!/setWindowOpenHandler/.test(code(mainProcess))) {
    problems.push('main.ts does not install a window-open handler, so a page can open a window')
  }
  if (!/action:\s*'deny'/.test(code(mainProcess))) {
    problems.push('main.ts window-open handler does not deny')
  }
  if (!/will-navigate/.test(code(mainProcess))) {
    problems.push('main.ts does not intercept navigation')
  }
  if (!/setPermissionRequestHandler/.test(code(mainProcess))) {
    problems.push('main.ts does not install a permission handler, so Electron defaults apply')
  }
  if (!/isTrustedSender/.test(code(mainProcess))) {
    problems.push('main.ts does not validate IPC senders')
  }
  if (!/Content-Security-Policy/.test(code(mainProcess))) {
    problems.push('main.ts does not set a Content-Security-Policy header')
  }

  // ── the preload is a bridge, not a port ───────────────────────────────────
  // A call, not a declaration: `.invoke(` followed by anything other than a
  // string literal is a forwarded channel. The interface that declares
  // Electron's own invoke signature has no leading dot, which is what keeps
  // this rule from tripping on the type it has to describe.
  if (/\.invoke\(\s*[A-Za-z_$]/.test(code(preload))) {
    problems.push(
      'preload.ts forwards a caller-supplied channel, which makes every main-process '
      + 'handler part of the renderer surface',
    )
  }
  for (const forbidden of ['node:fs', 'node:child_process', 'node:os', 'node:path', 'node:process']) {
    if (code(preload).includes(`'${forbidden}'`)) {
      problems.push(`preload.ts imports ${forbidden}; the preload must reach nothing native`)
    }
  }
  for (const forbidden of ['shell.', 'require(', 'eval(', 'process.env']) {
    if (code(preload).includes(forbidden)) {
      problems.push(`preload.ts uses ${forbidden}`)
    }
  }
  if (!/exposeInMainWorld/.test(code(preload))) {
    problems.push('preload.ts does not use contextBridge.exposeInMainWorld')
  }

  // Every channel the preload sends must be one the security module declares.
  const declared = [...code(security).matchAll(/'(watch:[a-z-]+)'/g)].map(match => match[1])
  const used = [...code(preload).matchAll(/'(watch:[a-z-]+)'/g)].map(match => match[1])
  for (const channel of used) {
    if (!declared.includes(channel)) {
      problems.push(`preload.ts uses undeclared channel ${channel}`)
    }
  }

  // ── the shipped preload matches the typed one ─────────────────────────────
  // The sandboxed entry is hand-written CJS because a sandboxed preload can
  // require almost nothing. That is a real constraint and also a place for the
  // two to drift, so the channel sets are compared rather than trusted.
  const entryPath = join(ROOT, 'apps', 'desktop', 'preload.cjs')
  if (!existsSync(entryPath)) {
    problems.push('apps/desktop/preload.cjs is missing; the window has no preload to load')
  } else {
    const entry = readFileSync(entryPath, 'utf8')
    const entryChannels = new Set([...code(entry).matchAll(/'(watch:[a-z-]+)'/g)].map(m => m[1]))
    for (const channel of declared) {
      if (!entryChannels.has(channel)) {
        problems.push(`preload.cjs does not expose declared channel ${channel}`)
      }
    }
    for (const channel of entryChannels) {
      if (!declared.includes(channel)) {
        problems.push(`preload.cjs exposes undeclared channel ${channel}`)
      }
    }
    if (/\brequire\((?!'electron'\))/.test(code(entry))) {
      problems.push('preload.cjs requires something other than electron')
    }
  }

  // ── nobody kills by name ──────────────────────────────────────────────────
  for (const { name, text } of allSources()) {
    for (const forbidden of ['taskkill', 'pkill', 'killall', '/IM ', 'process.kill(0']) {
      if (code(text).includes(forbidden)) {
        problems.push(`${name} kills processes by name (${forbidden}); kill by handle only`)
      }
    }
    if (/spawn\([^)]*shell:\s*true/.test(code(text))) {
      problems.push(`${name} spawns with a shell`)
    }
  }

  // ── secrets stay off command lines ────────────────────────────────────────
  const startup = read('startup.ts')
  if (startup !== null) {
    if (!/assertNoSecretsInArgv/.test(code(startup))) {
      problems.push('startup.ts has no argv secret check')
    }
    const argumentsFn = /export function childArguments[\s\S]*?\n\}/.exec(code(startup))?.[0] ?? ''
    if (/secret/i.test(argumentsFn)) {
      problems.push('startup.ts childArguments() mentions a secret; arguments are world-readable')
    }
  }
  if (!/assertNoSecretsInArgv/.test(code(mainProcess))) {
    problems.push('main.ts starts children without checking the argument vector for secrets')
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} desktop security problem(s)\n`)
    process.exit(1)
  }

  process.stdout.write(
    `desktop security: ${String(declared.length)} declared channel(s), posture intact\n`,
  )
}

main()
