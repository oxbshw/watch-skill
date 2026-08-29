#!/usr/bin/env node
/**
 * Check out the pinned DeepSeek Harness baseline for source audit.
 *
 * This checkout is never vendored and never built. Watch consumes DSH as
 * published npm packages pinned to the same version; the source tree exists so
 * inventory generation, parity diffing, and upstream-bump reports read the
 * real code instead of a description of it.
 *
 * Usage:
 *   node scripts/upstream-sync.mjs           check out the pinned commit
 *   node scripts/upstream-sync.mjs --verify  fail if the checkout has drifted
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'upstream', 'deepseek-harness')

/** Parse the flat scalar fields this script needs out of the lock file. */
function readLock() {
  const text = readFileSync(join(ROOT, 'upstream', 'deepseek-harness.lock'), 'utf8')
  const field = (key) => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
    if (!match) throw new Error(`watch: upstream lock is missing '${key}'`)
    return match[1].trim().replace(/^["']|["']$/g, '')
  }
  return { repository: field('repository'), commit: field('commit'), version: field('version') }
}

/** Run git in the checkout, returning trimmed stdout. */
function git(args, cwd = TARGET) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function main() {
  const verify = process.argv.includes('--verify')
  const lock = readLock()

  if (existsSync(join(TARGET, '.git'))) {
    const head = git(['rev-parse', 'HEAD'])
    if (head === lock.commit) {
      process.stdout.write(`upstream: already at ${lock.commit.slice(0, 12)} (${lock.version})\n`)
      return
    }
    if (verify) {
      process.stderr.write(
        `watch: upstream checkout is at ${head.slice(0, 12)}, lock pins ${lock.commit.slice(0, 12)}\n`,
      )
      process.exit(1)
    }
    process.stdout.write(`upstream: moving ${head.slice(0, 12)} -> ${lock.commit.slice(0, 12)}\n`)
  } else if (verify) {
    process.stderr.write('watch: upstream checkout missing; run `node scripts/upstream-sync.mjs`\n')
    process.exit(1)
  } else {
    rmSync(TARGET, { recursive: true, force: true })
    mkdirSync(TARGET, { recursive: true })
    git(['init', '-q'])
    git(['remote', 'add', 'origin', lock.repository])
  }

  // A depth-1 fetch of the exact object: the audit needs the tree at one
  // commit, never the history, and a shallow fetch keeps the checkout small.
  git(['fetch', '--depth', '1', 'origin', lock.commit])
  git(['checkout', '-q', 'FETCH_HEAD'])

  const head = git(['rev-parse', 'HEAD'])
  if (head !== lock.commit) {
    process.stderr.write(`watch: checkout landed on ${head}, expected ${lock.commit}\n`)
    process.exit(1)
  }
  process.stdout.write(`upstream: checked out ${lock.commit.slice(0, 12)} (${lock.version})\n`)
}

main()
