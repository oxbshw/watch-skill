/**
 * The DeepSeek Harness DeepWatch runs on: declared, detected, and — only with
 * consent — fetched.
 *
 * DeepWatch composes the official Harness packages; it does not fork them and
 * it does not redistribute them. `package.json` says so, as an exact optional
 * peer dependency, so the requirement and the supported version are visible in
 * the manifest, in `npm ls` and to anyone reviewing what this product needs.
 *
 * It is *optional* for one reason: somebody running `deepwatch --help` asked
 * for a CLI, not for four hundred packages and a set of prebuilt native
 * binaries. `setup` is where the Harness arrives, and it says so first.
 *
 * **The licence position, stated rather than avoided.** The Harness's own
 * closure reaches `sharp`, whose per-platform packages ship prebuilt libvips
 * binaries under `Apache-2.0 AND LGPL-3.0-or-later` — the Apache half is
 * sharp's glue, the LGPL half is libvips itself. Nothing in that closure is
 * bundled into a DeepWatch package: the user's own package manager fetches it
 * from the public registry under its publisher's terms, exactly as it would
 * for a direct `npm i @deepseek-ai/dsh`. Fetching it at setup rather than
 * declaring it would not change a single licence obligation — it would only
 * make the obligation invisible to an SBOM, a lockfile and a reviewer. That is
 * why the dependency is declared and the notice is written, and why
 * `docs/THIRD_PARTY_NOTICES` names the LGPL component and the decision a
 * *bundling* Desktop installer would still have to make.
 *
 * Resolution order: an explicit `DEEPWATCH_DSH_BIN`, a Harness already
 * resolvable beside this package, the copy setup installed, then nothing —
 * reported as nothing, never guessed at.
 *
 * @module @deepwatch/cli/lib/harness
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { probe, run } from './exec.js'
import { deepwatchHome } from './paths.js'
import { HARNESS_PACKAGE, HARNESS_REGISTRY, HARNESS_VERSION } from '../version.js'

/** How to invoke the Harness: an executable and the arguments that precede yours. */
export interface Harness {
  readonly command: string
  readonly prefix: readonly string[]
  /**
   * Where it came from.
   *
   * `peer` is one the environment already provides — installed beside this
   * package, or by the user. `provisioned` is the copy `setup` fetched into
   * DeepWatch's own home. `override` is `DEEPWATCH_DSH_BIN`.
   */
  readonly source: 'peer' | 'provisioned' | 'override'
  /** The directory the install lives in, when DeepWatch owns it. */
  readonly home?: string
}

/** Where `setup` puts a Harness it installed itself. */
export function harnessDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(deepwatchHome(env), 'harness')
}

/** The receipt `setup` writes, so an install can be reviewed and undone. */
export function receiptPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessDir(env), 'deepwatch-install-receipt.json')
}

/** A Harness resolvable from wherever this package was installed. */
function peerEntry(): string | null {
  try {
    return createRequire(import.meta.url).resolve(`${HARNESS_PACKAGE}/lib/bin.js`)
  } catch {
    return null
  }
}

/** The entry inside DeepWatch's own home, whether or not it is there. */
function provisionedEntry(env: NodeJS.ProcessEnv): string {
  return join(harnessDir(env), 'node_modules', ...HARNESS_PACKAGE.split('/'), 'lib', 'bin.js')
}

/**
 * The Harness, or null when there is not one.
 *
 * Null rather than a throw: reporting a missing prerequisite as a finding is
 * the doctor's whole job, and it cannot do that if looking for one crashes.
 */
export function harness(env: NodeJS.ProcessEnv = process.env): Harness | null {
  const override = env['DEEPWATCH_DSH_BIN']
  if (typeof override === 'string' && override !== '') {
    return { command: override, prefix: [], source: 'override' }
  }
  const peer = peerEntry()
  // Run it with the Node running us, so the Harness cannot end up on a
  // different runtime from the one this CLI declares it supports.
  if (peer !== null) return { command: process.execPath, prefix: [peer], source: 'peer' }

  const provisioned = provisionedEntry(env)
  return existsSync(provisioned)
    ? {
        command: process.execPath,
        prefix: [provisioned],
        source: 'provisioned',
        home: harnessDir(env),
      }
    : null
}

/**
 * The version a resolved Harness actually reports.
 *
 * Asked rather than read off a directory: a directory that exists is not a
 * program that runs, and a version in a manifest is not the version that
 * answers.
 */
export async function harnessVersion(found: Harness): Promise<string | null> {
  const line = await probe(found.command, [...found.prefix, '--version'])
  if (line === null) return null
  return /(\d+\.\d+\.\d+[0-9A-Za-z.\-+]*)/.exec(line)?.[1] ?? line.trim()
}

/** What `setup` would do, in the words it prints before doing it. */
export interface InstallPlan {
  readonly registry: string
  readonly package: string
  readonly version: string
  readonly destination: string
  readonly notice: string
}

/** The plan, so it can be printed and asserted without performing it. */
export function installPlan(env: NodeJS.ProcessEnv = process.env): InstallPlan {
  return {
    registry: HARNESS_REGISTRY,
    package: HARNESS_PACKAGE,
    version: HARNESS_VERSION,
    destination: harnessDir(env),
    notice: 'The Harness closure includes prebuilt native binaries, one of them '
      + 'under Apache-2.0 AND LGPL-3.0-or-later. They are fetched from the '
      + 'registry under their own publishers\' terms; DeepWatch redistributes '
      + 'none of them. See THIRD_PARTY_NOTICES.',
  }
}

/** How the plan reads on a terminal. */
export function renderPlan(plan: InstallPlan): string {
  return [
    'DeepWatch needs the DeepSeek Harness it was built against, and does not',
    'have one yet. Setup would download exactly this:',
    '',
    `  registry     ${plan.registry}`,
    `  package      ${plan.package}`,
    `  version      ${plan.version}   (exact — never a range)`,
    `  into         ${plan.destination}`,
    '',
    `  ${plan.notice}`,
    '',
  ].join('\n')
}

/** Why a provisioning attempt did not produce a Harness. */
export type ProvisionFailure =
  | 'no-consent'
  | 'offline'
  | 'install-failed'
  | 'version-mismatch'
  | 'not-runnable'

/** What `ensureHarness` found or did. */
export interface Provisioned {
  readonly harness: Harness | null
  /** True only where this call performed the install. */
  readonly installed: boolean
  /** Present when there is no Harness, saying which way it failed. */
  readonly failure?: ProvisionFailure
  /** A version, a source, or why it could not be provisioned. Never a stack. */
  readonly detail: string
}

/** How long the install may take before it is a hang rather than work. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Return a usable Harness, provisioning one only if allowed to.
 *
 * `consent` gates the network entirely: without it this reports what it would
 * have done and changes nothing. Every path is idempotent — an existing
 * Harness of the right version is reused, never reinstalled and never removed.
 */
export async function ensureHarness(options: {
  readonly env?: NodeJS.ProcessEnv
  readonly consent: boolean
  readonly offline?: boolean
}): Promise<Provisioned> {
  const env = options.env ?? process.env

  const found = harness(env)
  if (found !== null) {
    const version = await harnessVersion(found)
    if (version === null) {
      return {
        harness: null,
        installed: false,
        failure: 'not-runnable',
        detail: `a ${found.source} Harness is present and did not answer --version`,
      }
    }
    if (found.source !== 'override' && version !== HARNESS_VERSION) {
      // Refused rather than replaced. Parity, the slot inventory and every
      // composition gate were measured against one version, and silently
      // running another is running a product nobody tested. Somebody else's
      // installation is also not this command's to overwrite.
      return {
        harness: null,
        installed: false,
        failure: 'version-mismatch',
        detail: `found DeepSeek Harness ${version}, and DeepWatch was built `
          + `against ${HARNESS_VERSION}`,
      }
    }
    return { harness: found, installed: false, detail: `${version} (${found.source})` }
  }

  if (options.offline === true) {
    return {
      harness: null,
      installed: false,
      failure: 'offline',
      detail: 'no Harness is installed and offline mode forbids fetching one',
    }
  }
  if (!options.consent) {
    return {
      harness: null,
      installed: false,
      failure: 'no-consent',
      detail: 'no Harness is installed and nothing was downloaded',
    }
  }

  const dir = harnessDir(env)
  mkdirSync(dir, { recursive: true })
  // A manifest of its own, so the installer treats this directory as a project
  // rather than walking up and installing into whatever is above it — which,
  // run from inside a checkout, is somebody's repository.
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'deepwatch-harness', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  )

  const ran = await run(
    npmCommand(),
    [
      'install', '--no-audit', '--no-fund',
      // Exact, and from the registry the plan named. Never a range, never a
      // registry inherited from an ambient configuration the plan did not show.
      `--registry=${HARNESS_REGISTRY}`,
      `${HARNESS_PACKAGE}@${HARNESS_VERSION}`,
    ],
    { cwd: dir, env, timeoutMs: INSTALL_TIMEOUT_MS },
  )
  if (ran.code !== 0) {
    return {
      harness: null,
      installed: false,
      failure: 'install-failed',
      detail: ran.timedOut
        ? 'the install did not finish in time'
        : firstLine(ran.stderr === '' ? ran.stdout : ran.stderr),
    }
  }

  // Verify what landed, rather than trusting the exit code. A partial install
  // is not a ready one.
  const after = harness(env)
  if (after === null) {
    return {
      harness: null,
      installed: false,
      failure: 'install-failed',
      detail: 'the install reported success and produced no runnable Harness',
    }
  }
  const version = await harnessVersion(after)
  if (version !== HARNESS_VERSION) {
    return {
      harness: null,
      installed: true,
      failure: 'version-mismatch',
      detail: `installed ${String(version ?? 'nothing runnable')}, expected ${HARNESS_VERSION}`,
    }
  }

  writeReceipt(env, dir)
  return { harness: after, installed: true, detail: version }
}

/**
 * Record what was written, and how to remove it.
 *
 * An install with no receipt is one nobody can audit or undo. This never
 * deletes anything itself — it says where to look.
 */
function writeReceipt(env: NodeJS.ProcessEnv, dir: string): void {
  const receipt = {
    installedBy: '@deepwatch/cli',
    package: HARNESS_PACKAGE,
    version: HARNESS_VERSION,
    registry: HARNESS_REGISTRY,
    directory: dir,
    installedAt: new Date().toISOString(),
    remove: `Delete ${dir}. Nothing outside it was written.`,
  }
  writeFileSync(receiptPath(env), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

/**
 * npm, by the name this platform knows it as.
 *
 * `.cmd` on Windows because `spawn` without a shell will not find `npm`
 * otherwise, and this module does not build shell strings to work around that.
 */
function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** The first line of a child's output, for a message a person will read. */
function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'no output'
}
