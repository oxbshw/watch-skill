#!/usr/bin/env node
/**
 * Launch the real Electron runtime once, and report what it did.
 *
 * Separate from `npm run check` on purpose. A launch needs a desktop session,
 * and a gate that fails on a headless CI machine is a gate people disable. This
 * is run deliberately, and its result is recorded in the implementation ledger
 * with the machine it ran on — which is the only honest way to claim that a
 * desktop application starts.
 *
 * Usage: node scripts/desktop-smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Anchored at the desktop app, because that is where electron is a
// dependency. Resolving from the repository root would report a correctly
// installed Electron as missing.
const require = createRequire(join(ROOT, 'apps', 'desktop', 'package.json'))

function main() {
  let electronPath
  try {
    electronPath = require('electron')
  } catch {
    process.stdout.write('desktop smoke: electron is not installed — NOT MACHINE TESTED\n')
    process.exit(0)
  }
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    process.stdout.write('desktop smoke: the electron binary is not present — NOT MACHINE TESTED\n')
    process.exit(0)
  }

  const result = spawnSync(electronPath, [join(ROOT, 'apps', 'desktop', 'smoke-main.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
  })

  const line = `${result.stdout ?? ''}`
    .split(/\r?\n/)
    .find(candidate => candidate.startsWith('WATCH_SMOKE '))

  if (line === undefined) {
    process.stderr.write('desktop smoke: the app produced no result line\n')
    process.stderr.write(`${result.stdout ?? ''}\n${result.stderr ?? ''}\n`)
    process.exit(1)
  }

  const report = JSON.parse(line.slice('WATCH_SMOKE '.length))
  if (!report.ok) {
    process.stderr.write(`desktop smoke: FAILED — ${JSON.stringify(report, null, 2)}\n`)
    process.exit(1)
  }

  process.stdout.write(
    `desktop smoke: launched Electron ${report.electron} (Chromium ${report.chrome})\n`
    + `  window.watch exposes ${String(report.probe.operations.length)} operation(s)\n`
    + '  window.require, window.process and window.module are all absent\n'
    + `  renderer reached step: ${String(report.probe.readyStep)}\n`,
  )
}

main()
