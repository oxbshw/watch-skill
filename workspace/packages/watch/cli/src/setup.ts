/**
 * Compose the DeepWatch profile, without destroying anything already there and
 * without fetching anything nobody agreed to.
 *
 * A DeepSeek Harness profile is a directory of installed layers. DeepWatch adds
 * one: `@deepwatch/dsh-bundle`, a patch overlay rather than a tree, so every
 * upstream row stays as it was and removing the bundle leaves the host profile
 * untouched.
 *
 * Four properties, each because the alternative is destructive or dishonest.
 *
 * **Nothing is downloaded without consent.** The Harness is an optional peer
 * dependency; where the environment does not already provide one, setup prints
 * exactly what it would fetch — registry, package, exact version, destination,
 * licence note — and stops. Interactive runs are asked; non-interactive runs
 * need `--yes`. `--offline` refuses outright.
 *
 * **Never a silent overwrite.** A profile that exists and was not composed by
 * DeepWatch is left byte-identical, and the person is told which flag composes
 * a different one.
 *
 * **Idempotent.** Running it twice is running it once: an existing Harness of
 * the supported version is reused, and the same layer is re-composed rather
 * than reinstalled.
 *
 * **Backups are reported, never removed.** Where the Harness writes one, the
 * path is printed.
 *
 * @module @deepwatch/cli/setup
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import type { Invocation } from './bin.js'
import { ensureHarness, installPlan, receiptPath, renderPlan } from './lib/harness.js'
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

/**
 * Ask, where there is somebody to ask.
 *
 * A non-interactive run has nobody at the keyboard, so it is not prompted and
 * not assumed to agree — it needs `--yes`, which is a decision somebody made
 * when they wrote the command.
 */
async function agreed(invocation: Invocation): Promise<boolean> {
  if (invocation.yes) return true
  if (!process.stdin.isTTY) return false

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('Download it now? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
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

  // The Harness first, because there is nothing to compose without one — and
  // because this is the step that might touch the network.
  const dry = await ensureHarness({ env, consent: false, offline: invocation.offline })
  let provisioned = dry

  if (dry.harness === null && dry.failure === 'no-consent') {
    process.stdout.write(renderPlan(installPlan(env)))
    if (!await agreed(invocation)) {
      process.stderr.write(
        'deepwatch: nothing was downloaded and nothing was changed.\n'
        + '           Re-run with --yes to accept, or install\n'
        + `           ${installPlan(env).package}@${installPlan(env).version} yourself and\n`
        + '           set DEEPWATCH_DSH_BIN to it.\n')
      return 2
    }
    provisioned = await ensureHarness({ env, consent: true, offline: invocation.offline })
  }

  const dsh = provisioned.harness
  if (dsh === null) {
    process.stderr.write(refusal(provisioned.failure, provisioned.detail, env))
    return provisioned.failure === 'version-mismatch' ? 2 : 1
  }
  if (provisioned.installed) {
    process.stdout.write(
      `  installed DeepSeek Harness ${provisioned.detail}\n`
      + `  receipt: ${receiptPath(env)}\n`)
  }

  const already = existsSync(manifest)
  mkdirSync(home, { recursive: true })
  process.stdout.write(already
    ? `Re-composing the DeepWatch profile "${profile}".\n`
    : `Composing the DeepWatch profile "${profile}".\n`)

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
    '\nDeepWatch is composed.\n'
    + `  profile: ${profile}\n`
    + `  home:    ${deepwatchHome(env)}\n\n`
    + 'Run `deepwatch web` to open it, or `deepwatch doctor` to see what else\n'
    + 'this machine has. No provider is configured and none is required to start.\n')
  return 0
}

/** Why setup stopped, in words naming the way out. */
function refusal(
  failure: string | undefined, detail: string, env: NodeJS.ProcessEnv,
): string {
  const plan = installPlan(env)
  switch (failure) {
    case 'offline':
      return 'deepwatch: --offline was given and no DeepSeek Harness is installed.\n'
        + `           Install ${plan.package}@${plan.version} yourself and set\n`
        + '           DEEPWATCH_DSH_BIN to it, or re-run without --offline.\n'
    case 'version-mismatch':
      return `deepwatch: ${detail}.\n`
        + '           Nothing has been changed. DeepWatch is only tested against the\n'
        + '           version above; set DEEPWATCH_DSH_BIN to point at that one, or\n'
        + '           use a DEEPWATCH_HOME of its own for this install.\n'
    case 'not-runnable':
      return `deepwatch: ${detail}.\n`
        + '           Check that this Node can execute it, then run `deepwatch doctor`.\n'
    default:
      return `deepwatch: the DeepSeek Harness could not be installed.\n           ${detail}\n`
        + '           Nothing was left half-installed; re-run to try again.\n'
  }
}

/** The first line of a child's output, for a message a person will read. */
function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'no output'
}
