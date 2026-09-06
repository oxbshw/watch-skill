/**
 * What this machine can actually do, and what it cannot.
 *
 * The rule this follows is the one the whole product is built on: a capability
 * that has not been exercised is not reported as working. Four states, kept
 * apart because a person acts differently on each —
 *
 *   `missing`     not installed, and here is how to install it
 *   `installed`   present, and it answered when asked its version
 *   `reachable`   present and it responded to a real request
 *   `unknown`     could not be checked from here, and why
 *
 * "Installed" is deliberately not "works". Node being on PATH says nothing
 * about whether the Harness will start; Watch Skill answering `--version` says
 * nothing about whether its Bridge will connect. Only a check that made the
 * call may say `reachable`.
 *
 * Nothing here reaches a provider, uploads anything, or reads a key. A doctor
 * that phoned home would be the least trustworthy program in the product.
 *
 * @module @deepwatch/cli/doctor
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { probe, run } from './lib/exec.js'
import { harness, harnessDir, harnessVersion } from './lib/harness.js'
import { describeProvenance, renderProvenance } from './provenance.js'
import type { Provenance } from './provenance.js'
import { HARNESS_PACKAGE, HARNESS_VERSION } from './version.js'
import { deepwatchHome, dshHome, profileName, watchCoreBin } from './lib/paths.js'

/** How much is known about one thing this product needs. */
export type Availability = 'missing' | 'installed' | 'reachable' | 'unknown'

/** One line of the report. */
export interface Finding {
  readonly name: string
  readonly state: Availability
  /** What was observed. Never a secret, never a full path to a user's home. */
  readonly detail: string
  /** What to do about it, when there is something to do. */
  readonly fix: string
  /** Whether DeepWatch can run at all without this. */
  readonly required: boolean
}

/** The whole report. */
export interface DoctorReport {
  readonly ok: boolean
  readonly findings: readonly Finding[]
  /**
   * What is installed, in terms comparable with what was released.
   *
   * Present whether or not the doctor is otherwise happy: "which build is
   * this?" is exactly the question a broken install raises.
   */
  readonly provenance: Provenance
}

const NODE_FLOOR = 22

/** Node, and whether it is one this product supports. */
function nodeFinding(): Finding {
  const major = Number(process.versions.node.split('.')[0] ?? '0')
  const supported = major >= NODE_FLOOR
  return {
    name: 'Node.js',
    state: supported ? 'reachable' : 'installed',
    detail: `v${process.versions.node}`,
    fix: supported ? '' : `DeepWatch needs Node ${String(NODE_FLOOR)} or newer. Install an LTS release.`,
    required: true,
  }
}

/**
 * Watch Skill, the engine.
 *
 * `installed` when it answers `--version`. It is not promoted to `reachable`
 * here: reaching it means a Bridge handshake, which is a running profile's
 * business and not a doctor's.
 */
async function watchSkillFinding(env: NodeJS.ProcessEnv): Promise<Finding> {
  const explicit = watchCoreBin(env)
  const version = await probe(explicit ?? 'watch-skill', ['--version'])
  if (version === null) {
    return {
      name: 'Watch Skill',
      state: 'missing',
      detail: explicit === null
        ? 'not on PATH'
        : 'WATCH_CORE_BIN names something that did not answer',
      fix: 'pip install watch-skill — or set WATCH_CORE_BIN to its executable. '
        + 'DeepWatch runs without it and reports every Watch capability as unavailable.',
      required: false,
    }
  }
  return { name: 'Watch Skill', state: 'installed', detail: version, fix: '', required: false }
}

/**
 * The Harness DeepWatch composes its profile with.
 *
 * `setup` installs it, so "missing" here is the normal state of a machine that
 * has not been set up, and the fix names the command that does it. It is
 * "reachable" only after it answered `--version`, because a directory that
 * exists is not a program that runs.
 */
async function harnessFinding(env: NodeJS.ProcessEnv): Promise<Finding> {
  const found = harness(env)
  if (found === null) {
    return {
      name: 'DeepSeek Harness',
      state: 'missing',
      detail: 'not installed',
      fix: `Run \`deepwatch setup\`. It describes the download first and asks: `
        + `${HARNESS_PACKAGE}@${HARNESS_VERSION}, an exact version, into the `
        + 'DeepWatch home. It is an optional peer dependency, so nothing was '
        + 'fetched by installing this CLI.',
      required: true,
    }
  }
  const version = await harnessVersion(found)
  if (version === null) {
    return {
      name: 'DeepSeek Harness',
      state: 'installed',
      detail: `resolved (${found.source}) but did not answer --version`,
      fix: 'The Harness is present and did not run. Check that this Node can '
        + 'execute it, then run `deepwatch doctor` again.',
      required: true,
    }
  }
  if (found.source !== 'override' && version !== HARNESS_VERSION) {
    // Not "reachable". It runs, and it is not the one this build was measured
    // against, which is a different fact and the one a person has to act on.
    return {
      name: 'DeepSeek Harness',
      state: 'installed',
      detail: `${version} (${found.source}), built against ${HARNESS_VERSION}`,
      fix: `DeepWatch is only tested against ${HARNESS_VERSION}. Point `
        + 'DEEPWATCH_DSH_BIN at that version, or give this install its own '
        + 'DEEPWATCH_HOME.',
      required: true,
    }
  }
  return {
    name: 'DeepSeek Harness',
    state: 'reachable',
    detail: `${version} (${found.source})`,
    fix: '',
    required: true,
  }
}

/** Whether a profile has been composed, and whether it names DeepWatch. */
function profileFinding(env: NodeJS.ProcessEnv): Finding {
  const manifest = join(dshHome(env), 'profiles', profileName(env), 'package.json')
  if (!existsSync(manifest)) {
    return {
      name: 'DeepWatch profile',
      state: 'missing',
      detail: `no profile named ${profileName(env)}`,
      fix: 'Run `deepwatch setup`.',
      required: true,
    }
  }
  return {
    name: 'DeepWatch profile',
    state: 'installed',
    detail: `${profileName(env)} composed`,
    fix: '',
    required: true,
  }
}

/**
 * Everything, measured.
 *
 * Runs the probes concurrently because they are independent and each carries
 * its own deadline; a doctor that takes as long as the sum of its checks is one
 * people stop running.
 */
export async function doctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const [watchSkill, harness] = await Promise.all([
    watchSkillFinding(env),
    harnessFinding(env),
  ])
  const findings = [nodeFinding(), harness, profileFinding(env), watchSkill]
  return {
    // A required thing that is present but unusable is not ok either: a
    // Harness of the wrong version runs and composes a product nobody tested.
    ok: findings.every(finding =>
      !finding.required || (finding.state !== 'missing' && finding.fix === '')),
    findings,
    provenance: describeProvenance(join(harnessDir(env), 'node_modules')),
  }
}

/** The report as a person reads it. */
export function renderDoctor(report: DoctorReport, home: string): string {
  const mark = (state: Availability): string =>
    state === 'missing' ? 'MISSING ' : state === 'unknown' ? 'UNKNOWN ' : 'ok      '
  const lines = [
    'DeepWatch — what this machine can do',
    '',
    ...report.findings.map(finding =>
      `  ${mark(finding.state)}${finding.name.padEnd(20)} ${finding.detail}`),
    '',
    `  home: ${home}`,
    '',
  ]
  const fixes = report.findings.filter(finding => finding.fix !== '')
  if (fixes.length > 0) {
    lines.push('What to do:', '')
    for (const finding of fixes) lines.push(`  ${finding.name}: ${finding.fix}`, '')
  }
  lines.push('Provenance:', '',
    ...renderProvenance(report.provenance).map(line => `  ${line}`), '')
  lines.push(report.ok
    ? 'DeepWatch can start. Run `deepwatch web`.'
    : 'DeepWatch cannot start yet. See above.')
  return `${lines.join('\n')}\n`
}

/** `deepwatch doctor`. */
export async function runDoctor(json: boolean): Promise<number> {
  const report = await doctor()
  process.stdout.write(json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderDoctor(report, deepwatchHome()))
  return report.ok ? 0 : 1
}

/** Re-exported so `run` and `probe` are one import for the other commands. */
export { run }
