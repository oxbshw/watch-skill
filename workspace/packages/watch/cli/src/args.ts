/**
 * One parsed `deepwatch` command line, and the usage text that describes it.
 *
 * Separate from `bin.ts` for a reason that a clean-room install found rather
 * than a review: `bin.ts` runs the CLI when it is loaded, so anything that
 * imported it to reach `parse` ran the whole program and inherited its exit
 * code. Argument handling is the part other code legitimately wants, so it
 * lives where importing it costs nothing.
 *
 * @module @deepwatch/cli/args
 */

export const USAGE = `DeepWatch — an agent workspace that sees, remembers, and can prove what happened.

  deepwatch                 what to do next, from what this machine has
  deepwatch doctor          what is installed, what is missing, and how to fix it
  deepwatch setup           build the DeepWatch runtime and compose its profile
                            (safe to re-run) asks before downloading anything
  deepwatch web             run DeepWatch in your browser
  deepwatch desktop         run the DeepWatch desktop app

Options
  --json                    machine-readable output, where a command has any
  --yes, -y                 agree to the download \`setup\` describes first
  --offline                 never reach the network; refuse instead
  --profile <name>          which profile to use (default: deepwatch)
  --artifacts <dir>         where the packed DeepWatch tarballs and their
                            packed-artifacts.json inventory are. \`setup\` needs
                            this until the packages are published; they are
                            never fetched from a registry.
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
  /**
   * Where the packed DeepWatch tarballs are.
   *
   * Explicit on purpose. The DeepWatch packages are unpublished, so setup has
   * to be told where they are rather than guessing — and a product that
   * silently fell back to a registry for an unpublished scope would be asking
   * for a 404 and calling it a network problem.
   */
  readonly artifacts: string | null
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
    artifacts: flag('--artifacts'),
    port: flag('--port'),
    yes: argv.includes('--yes') || argv.includes('-y'),
    offline: argv.includes('--offline'),
  }
}
