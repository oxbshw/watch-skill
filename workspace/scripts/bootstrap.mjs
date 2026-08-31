#!/usr/bin/env node
/**
 * Take a fresh clone to a state where `npm run check` passes.
 *
 * Three steps, in the order a clean machine needs them, each printed with what
 * it is for so a failure is legible rather than a wall of tool output:
 *
 *   1. install dependencies from the lockfile, using the pinned pnpm
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
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALSO_CHECK = process.argv.includes('--check')

/**
 * The package manager this repository pins, run through Corepack.
 *
 * Bare `pnpm` resolves to whatever is on PATH. A machine with pnpm 11
 * installed globally therefore bootstrapped this repository with pnpm 11 --
 * which writes `allowBuilds` into pnpm-workspace.yaml and leaves a tracked
 * file modified by a command that is supposed to change nothing. Corepack is
 * shipped with Node, so naming the exact version here needs no extra install
 * and cannot be satisfied by the wrong one.
 *
 * The spec is validated rather than trusted: it is interpolated into a shell
 * command below, and a manifest is a file like any other.
 */
function pinnedPackageManager() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const spec = manifest.packageManager
  if (typeof spec !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/.test(spec)) {
    process.stderr.write(
      `watch: package.json "packageManager" must pin an exact pnpm version, got ${String(spec)}.
`,
    )
    process.exit(1)
  }
  return spec
}

const PNPM = pinnedPackageManager()

const STEPS = [
  {
    name: 'dependencies',
    why: 'from the lockfile, so everyone builds the same tree',
    command: `corepack ${PNPM} install --frozen-lockfile`,
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
    command: 'npm run check',
    shell: true,
  })
}

for (const [index, step] of STEPS.entries()) {
  process.stdout.write(`\n[${String(index + 1)}/${String(STEPS.length)}] ${step.name} -- ${step.why}\n`)
  const started = Date.now()
  const result = spawnSync(step.command, step.args ?? [], {
    cwd: ROOT,
    stdio: 'inherit',
    // The one shell in this repository, and the only place one is defensible.
    // Everything else resolves a tool's Node entry point and runs it directly
    // -- see `scripts/lib/process.mjs` -- but that module imports the built
    // CLI, and bootstrap is the script that runs *before* anything is built.
    // Its two shell steps are fixed command strings this file writes itself,
    // with no value from anywhere else in them. Node steps pass an argv array
    // and must not get a shell: it re-parses the command, and
    // `process.execPath` contains a space on Windows, so the path splits and
    // the step fails with 'C:\Program' is not recognized.
    shell: step.shell === true,
    // A fresh machine has not used Corepack before. Without this it stops on
    // an interactive "do you want to download pnpm?" prompt, which turns an
    // unattended bootstrap into a hang with nothing on screen explaining it.
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
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
