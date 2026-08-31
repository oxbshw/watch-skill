/**
 * The DeepSeek Harness DeepWatch runs on: declared and detected.
 *
 * **This module finds a Harness. It never installs one.** Building the managed
 * runtime is `lib/provision.ts`'s job, and it is a transaction — a staging
 * directory, a verified artifact set, a validated tree, one rename. This file
 * used to install as well, straight into the final directory with a
 * `package.json` written before npm was even started, so a failure left a
 * half-built runtime exactly where the next run would find it and believe it.
 * Two places that could produce a runtime meant two definitions of what a
 * finished one was. Now there is one, and everything here answers a question
 * rather than changing anything.
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
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { probe } from './exec.js'
import { deepwatchHome } from './paths.js'
import { HARNESS_PACKAGE, HARNESS_VERSION } from '../version.js'

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
  /**
   * The Harness's own `package.json`, when it can be named.
   *
   * This is the anchor the Harness resolves profile bundles from, so it is
   * also the anchor DeepWatch has to prove its bundle is visible from. Absent
   * for a `DEEPWATCH_DSH_BIN` override, which names an executable and says
   * nothing about where its package lives.
   */
  readonly anchor?: string
}

/** The package root of a Harness entry point, i.e. `<pkg>/lib/bin.js` → `<pkg>`. */
function anchorOf(entry: string): string {
  return join(dirname(dirname(entry)), 'package.json')
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
  if (peer !== null) {
    return { command: process.execPath, prefix: [peer], source: 'peer', anchor: anchorOf(peer) }
  }

  const provisioned = provisionedEntry(env)
  return existsSync(provisioned)
    ? {
        command: process.execPath,
        prefix: [provisioned],
        source: 'provisioned',
        home: harnessDir(env),
        anchor: anchorOf(provisioned),
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

/** Why detection did not yield a usable Harness. */
export type DetectionFailure =
  | 'absent'
  | 'version-mismatch'
  | 'not-runnable'

/** What {@link ensureHarness} found. */
export interface Detected {
  readonly harness: Harness | null
  /**
   * Always false, and kept so callers read as what they are.
   *
   * This module does not install. The field exists because a caller asking
   * "was one installed just now?" should get an answer rather than have to
   * know that the question no longer applies here.
   */
  readonly installed: false
  /** Present when there is no usable Harness, saying which way. */
  readonly failure?: DetectionFailure
  /** A version and its source, or why there is none. Never a stack. */
  readonly detail: string
}

/**
 * The Harness this machine has, if it has a usable one.
 *
 * Detection only: nothing is fetched, nothing is written, and nothing is
 * removed, whatever the answer. A caller that wants a runtime built calls
 * `provisionManagedRuntime`, which asks first, stages, validates and promotes.
 * Keeping those apart is what makes this safe to call from `doctor`, from
 * `web`, and from anything else that only needs to know.
 *
 * A Harness of the wrong version is refused rather than replaced: parity, the
 * slot inventory and every composition gate were measured against one version,
 * silently running another is running a product nobody tested, and somebody
 * else's installation is not this command's to overwrite.
 */
export async function ensureHarness(options: {
  readonly env?: NodeJS.ProcessEnv
}): Promise<Detected> {
  const env = options.env ?? process.env

  const found = harness(env)
  if (found === null) {
    return {
      harness: null,
      installed: false,
      failure: 'absent',
      detail: 'no DeepSeek Harness is installed for DeepWatch',
    }
  }

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
