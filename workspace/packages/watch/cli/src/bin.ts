#!/usr/bin/env node
/**
 * `deepwatch` — the command line for the DeepWatch workspace.
 *
 * DeepWatch is the Web and Desktop agent product built on the official
 * DeepSeek Harness packages and powered by Watch Skill for perception,
 * evidence, memory and independent verification.
 *
 * Two rules govern what may appear here.
 *
 * **Every command is backed by something real.** A subcommand that printed a
 * plan, or that would work once something else existed, is worse than no
 * subcommand: it is the product claiming a capability it does not have, in the
 * one program whose job is to tell the truth about this machine.
 *
 * **Nothing reaches a provider.** Setup and doctor make no model call, read no
 * key and upload nothing. A person connects a provider afterwards, through
 * DeepWatch's own settings, and that is a separate consent.
 *
 * @module @deepwatch/cli/bin
 */

import { parse, USAGE } from './args.js'
import { runDoctor } from './doctor.js'
import { runSetup } from './setup.js'
import { runDesktop, runWeb } from './launch.js'
import { VERSION } from './version.js'

/**
 * What a bare `deepwatch` should do.
 *
 * Not a usage dump, and not a silent state change. It reports what the machine
 * has and names the one next step, because somebody typing the product's name
 * with no argument is asking how to start it.
 */
async function guide(): Promise<number> {
  process.stdout.write(`DeepWatch ${VERSION}\n\n`)
  const code = await runDoctor(false)
  process.stdout.write('\nRun `deepwatch --help` for everything else.\n')
  return code
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const invocation = parse(argv)

  if (invocation.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (invocation.help) {
    process.stdout.write(USAGE)
    return 0
  }

  switch (invocation.command) {
    case '':
      return guide()
    case 'doctor':
      return runDoctor(invocation.json)
    case 'setup':
      return runSetup(invocation)
    case 'web':
      return runWeb(invocation)
    case 'desktop':
      return runDesktop(invocation)
    default:
      process.stderr.write(
        `deepwatch: ${invocation.command} is not a command.\n\n${USAGE}`)
      return 2
  }
}

main().then(
  code => { process.exitCode = code },
  (error: unknown) => {
    // One line, no stack. A stack in a CLI is for the person who wrote it; a
    // sentence and an exit code are for the person running it.
    process.stderr.write(`deepwatch: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
