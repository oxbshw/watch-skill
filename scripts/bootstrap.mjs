#!/usr/bin/env node
/**
 * Take a fresh clone to a state where `npm run check` passes.
 *
 * Three steps, in the order a clean machine needs them, each printed with what
 * it is for so a failure is legible rather than a wall of tool output:
 *
 *   1. install dependencies from the lockfile
 *   2. check out the pinned DSH baseline, which several gates read and which
 *      a fresh clone does not have
 *   3. build, so the gates that import built output have something to import
 *
 * It stops at the first failure and says which step failed. It downloads no
 * model, requests no permission, starts no browser and contacts no provider.
 *
 * Usage:
 *   node scripts/bootstrap.mjs
 *   node scripts/bootstrap.mjs --check    also run the full gate afterwards
 */

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALSO_CHECK = process.argv.includes('--check')

const STEPS = [
  {
    name: 'dependencies',
    why: 'from the lockfile, so everyone builds the same tree',
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    shell: true,
  },
  {
    name: 'upstream baseline',
    why: 'inventory generation and parity diffing read the pinned DSH source',
    command: process.execPath,
    args: [join(ROOT, 'scripts', 'upstream-sync.mjs')],
  },
  {
    name: 'build',
    why: 'several gates import built output',
    command: process.execPath,
    args: [join(ROOT, 'scripts', 'build.mjs')],
  },
]

if (ALSO_CHECK) {
  STEPS.push({
    name: 'gates',
    why: 'the full suite, exactly as CI runs it',
    command: 'npm',
    args: ['run', 'check'],
    shell: true,
  })
}

for (const [index, step] of STEPS.entries()) {
  process.stdout.write(`\n[${String(index + 1)}/${String(STEPS.length)}] ${step.name} -- ${step.why}\n`)
  const started = Date.now()
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    // pnpm and npm are shell shims on Windows and need one. Node does not, and
    // must not get one: `shell: true` re-parses the command, and
    // `process.execPath` is "C:\\Program Files\\nodejs\\node.exe", so the
    // space splits it and the step fails with 'C:\\Program' is not recognized.
    shell: step.shell === true && process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.stderr.write(
      `\nwatch: bootstrap stopped at "${step.name}" (exit ${String(result.status ?? 'signal')}).\n`
      + 'Run `node scripts/doctor.mjs` to see whether the machine is missing something required.\n',
    )
    process.exit(1)
  }
  process.stdout.write(`      done in ${String(Math.round((Date.now() - started) / 1000))}s\n`)
}

process.stdout.write(
  '\nBootstrap complete.\n'
  + (ALSO_CHECK ? '' : '\nRun `npm run check` for the full gate suite.\n')
  + 'Run `node scripts/doctor.mjs` to see which optional capabilities this machine has.\n',
)
