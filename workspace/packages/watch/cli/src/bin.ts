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

import { runDoctor } from './doctor.js'
import { runSetup } from './setup.js'
import { runDesktop, runWeb } from './launch.js'
import { VERSION } from './version.js'

const USAGE = `DeepWatch — an agent workspace that sees, remembers, and can prove what happened.

  deepwatch                 what to do next, from what this machine has
  deepwatch doctor          what is installed, what is missing, and how to fix it
  deepwatch setup           compose the DeepWatch profile (safe to re-run)
                            asks before downloading anything
  deepwatch web             run DeepWatch in your browser
  deepwatch desktop         run the DeepWatch desktop app

Options
  --json                    machine-readable output, where a command has any
  --yes, -y                 agree to the download \`setup\` describes first
  --offline                 never reach the network; refuse instead
  --profile <name>          which profile to use (default: deepwatch)
  --port <n>                port for \`web\` (default: an OS-chosen one)
  --version, -v
  --help, -h

DeepWatch is built on DeepSeek Harness and powered by Watch Skill. It is an
independent project and is not affiliated with or endorsed by DeepSeek.
`

/** One parsed command line. Deliberately small: no options framework. */
export interface Invocation {
  readonly command: string
  readonly json: boolean
  readonly help: boolean
  readonly version: boolean
  readonly profile: string | null
  readonly port: string | null
  /** Consent for the one command that may touch the network. */
  readonly yes: boolean
  /** Refuse the network outright, whatever else is asked. */
  readonly offline: boolean
}

/**
 * Parse argv.
 *
 * Exported because argument handling is exactly the kind of thing that is
 * asserted rather than eyeballed, and a test should not have to spawn a
 * process to reach it.
 */
export function parse(argv: readonly string[]): Invocation {
  const flag = (name: string): string | null => {
    const at = argv.indexOf(name)
    return at >= 0 && at + 1 < argv.length ? (argv[at + 1] ?? null) : null
  }
  const positional = argv.find(entry => !entry.startsWith('-')) ?? ''
  return {
    command: positional,
    json: argv.includes('--json'),
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
    profile: flag('--profile'),
    port: flag('--port'),
    yes: argv.includes('--yes') || argv.includes('-y'),
    offline: argv.includes('--offline'),
  }
}

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
