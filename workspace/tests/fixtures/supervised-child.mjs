#!/usr/bin/env node
/**
 * A stand-in for a supervised child — the DSH Host or Watch Core.
 *
 * Like the OCR worker stub, this is a real process rather than a mock, because
 * every behaviour the supervisor has to get right is a process behaviour:
 * exiting, ignoring a term signal, echoing an owner token it was given in its
 * environment rather than on its command line.
 *
 * Mode is the first argument:
 *
 *   ok         announce ready and stay up
 *   silent     never announce
 *   crash      announce, then exit non-zero shortly after
 *   flaky      announce, then exit non-zero immediately, every time
 *   stubborn   announce, ignore SIGTERM, and stay up until killed
 */

const mode = process.argv[2] ?? 'ok'

// The owner token arrives in the environment. If it ever arrives on the
// command line instead, the supervisor's own argv check should have refused it
// before this process existed.
const owner = process.env.WATCH_OWNER_TOKEN ?? '(none)'

if (mode === 'stubborn') {
  process.on('SIGTERM', () => {
    // Deliberately ignored, so the supervisor's grace period and forcible kill
    // are exercised rather than assumed.
  })
}

if (mode !== 'silent') {
  process.stdout.write(`watch: ready owner=${owner}\n`)
}

if (mode === 'flaky') {
  process.exit(7)
}

if (mode === 'crash') {
  setTimeout(() => { process.exit(9) }, 40)
}

// Stay alive.
setInterval(() => {}, 60_000)
