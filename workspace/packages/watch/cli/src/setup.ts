/**
 * Compose the DeepWatch profile, without destroying anything already there.
 *
 * A DeepSeek Harness profile is a directory of installed layers. DeepWatch adds
 * one: `@deepwatch/dsh-bundle`, which is a patch overlay rather than a tree, so
 * every upstream row stays exactly as it was and removing the bundle leaves the
 * host profile untouched.
 *
 * Three properties this holds, each because the alternative is destructive.
 *
 * **Idempotent.** Running it twice is running it once. The second run
 * re-composes the same layer over the same profile and reports what it found
 * rather than reinstalling anything.
 *
 * **Never a silent overwrite.** A profile that exists and was not made by
 * DeepWatch is refused, with the name of the profile and the flag that would
 * use a different one. Somebody's configured Harness profile is not this
 * command's to reorganise.
 *
 * **Backups are reported, never removed.** Where the Harness writes one, the
 * path is printed. A cleanup step that quietly deletes what it replaced is how
 * an "idempotent" setup loses a week of somebody's configuration.
 *
 * @module @deepwatch/cli/setup
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Invocation } from './bin.js'
import { ensureHarness } from './lib/harness.js'
import { run } from './lib/exec.js'
import { deepwatchHome, dshHome, profileName } from './lib/paths.js'

/** How long a profile install may take before it is a hang rather than work. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** What a profile directory says about who made it. */
function composedByDeepWatch(manifestPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: readonly string[] } }
    }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    return bundles.includes('@deepwatch/dsh-bundle')
      || Object.keys(manifest.dependencies ?? {}).some(name => name.startsWith('@deepwatch/'))
  } catch {
    return false
  }
}

/** `deepwatch setup`. */
export async function runSetup(invocation: Invocation): Promise<number> {
  const env = { ...process.env }
  if (invocation.profile !== null) env['DEEPWATCH_PROFILE'] = invocation.profile

  const home = dshHome(env)
  const profile = profileName(env)
  const manifest = join(home, 'profiles', profile, 'package.json')

  if (existsSync(manifest) && !composedByDeepWatch(manifest)) {
    process.stderr.write(
      `deepwatch: the profile "${profile}" already exists and was not composed by DeepWatch.\n`
      + '           Nothing has been changed. Use `--profile <name>` to compose a different\n'
      + '           one, or remove that profile yourself if you meant to replace it.\n')
    return 2
  }

  const already = existsSync(manifest)
  mkdirSync(home, { recursive: true })
  process.stdout.write(already
    ? `Re-composing the DeepWatch profile "${profile}".\n`
    : `Composing the DeepWatch profile "${profile}".\n`)

  // The Harness, installed once into DeepWatch's own home. See the note in
  // `lib/harness.ts` for why it is not a dependency of this package.
  const provisioned = await ensureHarness(env)
  if (provisioned.installed) {
    process.stdout.write(`  installed DeepSeek Harness ${provisioned.detail}\n`)
  }
  const dsh = provisioned.harness
  if (dsh === null) {
    process.stderr.write(
      'deepwatch: the DeepSeek Harness could not be installed.\n'
      + `           ${provisioned.detail}\n`
      + '           DeepWatch needs it to compose a profile. Check the network, or\n'
      + '           set DEEPWATCH_DSH_BIN to a Harness you already have.\n')
    return 1
  }
  const withHome = { ...env, DSH_HOME: home }

  const initialised = await run(
    dsh.command, [...dsh.prefix, 'plugin', '--profile', profile, 'install'],
    { env: withHome, timeoutMs: INSTALL_TIMEOUT_MS })
  if (initialised.code !== 0) {
    process.stderr.write(
      'deepwatch: the Harness could not initialise the profile.\n'
      + `           ${firstLine(initialised.stderr === '' ? initialised.stdout : initialised.stderr)}\n`
      + '           Run `deepwatch doctor` to see what is missing.\n')
    return 1
  }

  const added = await run(
    dsh.command, [...dsh.prefix, 'plugin', '--profile', profile, 'add', '@deepwatch/dsh-bundle'],
    { env: withHome, timeoutMs: INSTALL_TIMEOUT_MS })
  if (added.code !== 0) {
    process.stderr.write(
      'deepwatch: the DeepWatch bundle could not be installed into the profile.\n'
      + `           ${firstLine(added.stderr === '' ? added.stdout : added.stderr)}\n`)
    return 1
  }

  for (const line of added.stdout.split('\n')) {
    // The Harness prints where it put a backup. Passing that through is the
    // whole of this command's obligation about it.
    if (/backup/i.test(line)) process.stdout.write(`  ${line.trim()}\n`)
  }

  process.stdout.write(
    `\nDeepWatch is composed.\n`
    + `  profile: ${profile}\n`
    + `  home:    ${deepwatchHome(env)}\n\n`
    + 'Run `deepwatch web` to open it, or `deepwatch doctor` to see what else\n'
    + 'this machine has. No provider is configured and none is required to start.\n')
  return 0
}

/** The first line of a child's output, for a message a person will read. */
function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'no output'
}
