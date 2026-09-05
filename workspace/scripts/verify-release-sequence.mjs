#!/usr/bin/env node
/**
 * Walk the release guide's own commands, and check the worktree between them.
 *
 * `releasing.md` gives two commands in order: pack and verify the artifacts,
 * then run the first-publish bootstrap. For a release that sequence could not
 * be walked. `pack-release.mjs` wrote digests, a date and an output directory
 * into the *tracked* `inventory/packed-artifacts.json`, so packing dirtied the
 * worktree — and `first-publish` refuses a dirty tree, because publishing from
 * one means publishing something that is not the commit anybody reviewed.
 *
 *     npm run release:artifacts
 *     npm run first-publish:dry-run
 *     first-publish: the worktree is dirty
 *
 * Every gate passed. `check` never packs, and the jobs that pack never look at
 * `git status` afterwards, so nothing in CI ever put those two facts in the
 * same place. This gate is that place: it runs the documented commands in the
 * documented order and asserts a clean worktree before, between and after.
 *
 * It deliberately re-runs the real commands rather than asserting something
 * about the scripts. The defect was not in what a script contained; it was in
 * what happened when two of them ran one after the other.
 *
 * Usage:
 *   node scripts/verify-release-sequence.mjs
 *   node scripts/verify-release-sequence.mjs --json
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')
const JSON_OUT = process.argv.includes('--json')

const steps = []
const problems = []

/** Everything git would report, including files it is not yet tracking. */
function worktree() {
  const status = spawnSync(
    'git', ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: REPO, encoding: 'utf8' })
  if (status.status !== 0) {
    return { clean: null, entries: [], why: status.stderr.trim() || 'git status failed' }
  }
  const entries = status.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return { clean: entries.length === 0, entries, why: null }
}

/**
 * Assert cleanliness, naming what dirtied it.
 *
 * The paths matter more than the count. "the worktree is dirty" was the
 * message the release owner already had, and it is the one that did not say
 * which command to look at or which file to fix.
 */
function requireClean(when) {
  const state = worktree()
  steps.push({ step: `worktree ${when}`, ok: state.clean === true, paths: state.entries })
  if (state.clean === true) return true
  if (state.clean === null) {
    problems.push(`could not read the worktree ${when}: ${state.why}`)
    return false
  }
  problems.push(
    `the worktree is dirty ${when}:\n    ${state.entries.join('\n    ')}\n`
    + '    A release command must not write a tracked file. Per-run facts belong '
    + 'in the inventory beside the tarballs.')
  return false
}

function npm(script) {
  const started = Date.now()
  const ran = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', script],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const ok = ran.status === 0
  steps.push({ step: `npm run ${script}`, ok, seconds })
  if (!ok) {
    const output = (ran.stderr || ran.stdout || '').split(/\r?\n/).slice(-25).join('\n    ')
    problems.push(`npm run ${script} exited ${String(ran.status)}:\n    ${output}`)
  }
  return ok
}

function main() {
  // The order is the guide's order, and the checks between them are the point.
  if (requireClean('before packing')
    && npm('release:artifacts')
    && requireClean('after packing')
    && npm('first-publish:dry-run')) {
    requireClean('after the first-publish dry run')
  }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({
      ok: problems.length === 0, steps, problems,
    }, null, 2)}\n`)
    return problems.length === 0 ? 0 : 1
  }

  process.stdout.write('\nrelease sequence\n\n')
  for (const step of steps) {
    const detail = step.seconds === undefined ? '' : `  ${step.seconds}s`
    process.stdout.write(`  ${step.ok ? 'ok  ' : 'FAIL'}${detail.padStart(9)}  ${step.step}\n`)
  }
  if (problems.length > 0) {
    process.stderr.write('\n')
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    process.stderr.write(
      '\nrelease-sequence: the documented path to a first publication does not walk\n')
    return 1
  }
  process.stdout.write(
    '\nPack, verify and the first-publish dry run run in order and leave the tree clean.\n')
  return 0
}

process.exit(main())
