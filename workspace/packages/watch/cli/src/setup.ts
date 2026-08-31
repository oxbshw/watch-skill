/**
 * Compose the DeepWatch profile, without destroying anything already there and
 * without fetching anything nobody agreed to.
 *
 * Setup builds two things. The **managed runtime** is a directory under the
 * DeepWatch home holding the pinned DeepSeek Harness, the exact required peers
 * generated from the audited closure, and the DeepWatch packages — all of it
 * self-contained, so once setup finishes nothing it depends on can be moved or
 * deleted. The **profile** is a Harness profile with one extra layer composed
 * into it: `@deepwatch/dsh-bundle`, a patch overlay rather than a tree, so
 * every upstream row stays as it was and removing the bundle leaves the host
 * profile untouched.
 *
 * Six properties, each because the alternative is destructive or dishonest.
 *
 * **Nothing is downloaded without consent.** Where the environment does not
 * already provide a runtime, setup prints exactly what it would fetch —
 * registry, package, exact version, how many generated peers, how many local
 * DeepWatch packages, destination, and which of those steps touch the network
 * — and stops. Interactive runs are asked; non-interactive runs need `--yes`.
 * `--offline` refuses outright, and it is checked before anything else, so the
 * refusal a person gets is the one they asked about.
 *
 * **The DeepWatch packages are never fetched from a registry.** Nothing under
 * that scope is published. Before publication they come from verified local
 * tarballs whose directory is named explicitly, and the mode is recorded in
 * the receipt rather than inferred. There is no silent fallback: a missing
 * `--artifacts` is a refusal, not a registry request for a scope that would
 * answer 404 and be reported as a network problem.
 *
 * **Nothing is half-installed.** The runtime is assembled in a staging
 * directory and promoted with one rename after every check passes. A failure
 * leaves an existing runtime untouched and leaves no partial one where there
 * was none, and where a failed attempt is kept its real path is printed — the
 * previous version claimed nothing was left behind while leaving a directory
 * and a manifest, which is the kind of message that stops people looking in
 * the one place that would have told them what happened.
 *
 * **Never a silent overwrite.** A profile that exists and was not composed by
 * DeepWatch is left byte-identical, and the person is told which flag composes
 * a different one.
 *
 * **Idempotent.** Running it twice is running it once: a healthy runtime of
 * the supported version is reused, and the same layer is re-composed rather
 * than duplicated.
 *
 * @module @deepwatch/cli/setup
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import type { Invocation } from './args.js'
import { harness, harnessDir, harnessVersion } from './lib/harness.js'
import { resolveBundle } from './lib/bundle.js'
import { composeProfile } from './lib/compose.js'
import { managedPlan, provisionManagedRuntime, readArtifacts } from './lib/provision.js'
import type { ManagedPackage, ManagedPlan, SourceMode } from './lib/provision.js'
import { deepwatchHome, dshHome, profileName } from './lib/paths.js'
import { BUNDLE_PACKAGE, BUNDLE_VERSION, HARNESS_VERSION } from './version.js'

/** How long a profile operation may take before it is a hang rather than work. */
const PROFILE_TIMEOUT_MS = 10 * 60 * 1000

/** What a profile directory says about who made it. */
function composedByDeepWatch(manifestPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: readonly string[] } }
    }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    return bundles.includes(BUNDLE_PACKAGE)
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
    const answer = await rl.question('Build it now? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** How the plan reads on a terminal, before anything is fetched or written. */
export function renderManagedPlan(plan: ManagedPlan): string {
  const local = plan.mode === 'local-artifacts'
  return `${[
    'DeepWatch needs the runtime it was built against, and does not have one',
    'yet. Setup would build exactly this:',
    '',
    `  registry     ${plan.registry}`,
    `  package      ${plan.harness.package}`,
    `  version      ${plan.harness.version}   (exact — never a range)`,
    `  peers        ${String(plan.peers)} required peer packages at exact versions,`,
    '               generated from the audited closure, not hand-listed',
    `  deepwatch    ${String(plan.deepwatch.length)} local packages at ${BUNDLE_VERSION}, `
      + `from ${local ? 'verified local artifacts' : 'the registry'}`,
    `  source       ${plan.artifacts ?? plan.registry}`,
    `  into         ${plan.destination}`,
    `  manifest     ${plan.manifestDigest}`,
    '',
    '  Network:     one npm install of the exact Harness version above and its',
    '               generated peer set, from that registry, into that directory.',
    `  Local:       ${String(plan.deepwatch.length)} verified tarballs are copied into the`,
    '               runtime and installed from those copies, so the runtime does',
    '               not depend on where they came from afterwards.',
    '  The DeepWatch packages are not published, and are never requested from a registry.',
    '',
    '  The Harness closure includes prebuilt native binaries, one of them under',
    '  Apache-2.0 AND LGPL-3.0-or-later. They are fetched from the registry under',
    "  their own publishers' terms; DeepWatch redistributes none of them. See",
    '  THIRD_PARTY_NOTICES.',
    '',
  ].join('\n')}\n`
}

/** Where the DeepWatch packages may come from, decided explicitly. */
function chooseSource(
  invocation: Invocation, env: NodeJS.ProcessEnv,
): { mode: SourceMode, artifacts: string | null } {
  const named = invocation.artifacts ?? env['DEEPWATCH_ARTIFACTS'] ?? null
  return named !== null && named !== ''
    ? { mode: 'local-artifacts', artifacts: named }
    : { mode: 'registry', artifacts: null }
}

/** `deepwatch setup`. */
export async function runSetup(invocation: Invocation): Promise<number> {
  const env = { ...process.env }
  if (invocation.profile !== null) env['DEEPWATCH_PROFILE'] = invocation.profile

  const home = dshHome(env)
  const profile = profileName(env)
  const manifest = join(home, 'profiles', profile, 'package.json')
  const destination = harnessDir(env)

  if (existsSync(manifest) && !composedByDeepWatch(manifest)) {
    process.stderr.write(
      `deepwatch: the profile "${profile}" already exists and was not composed by DeepWatch.\n`
      + '           Nothing has been changed. Use `--profile <name>` to compose a different\n'
      + '           one, or remove that profile yourself if you meant to replace it.\n')
    return 2
  }

  // An existing runtime is reused rather than rebuilt, and a wrong one is
  // refused rather than replaced: somebody else's installation is not this
  // command's to overwrite.
  const existing = harness(env)
  let dsh = existing
  if (existing !== null) {
    const version = await harnessVersion(existing)
    if (version === null) {
      process.stderr.write(
        `deepwatch: a ${existing.source} Harness is present and did not answer --version.\n`
        + '           Nothing has been changed. Check that this Node can run it.\n')
      return 1
    }
    if (existing.source !== 'override' && version !== HARNESS_VERSION) {
      process.stderr.write(
        `deepwatch: found DeepSeek Harness ${version}, and DeepWatch was built against `
        + `${HARNESS_VERSION}.\n`
        + '           Nothing has been changed. Set DEEPWATCH_DSH_BIN to that version,\n'
        + '           or give this install a DEEPWATCH_HOME of its own.\n')
      return 2
    }
    process.stdout.write(`Using the DeepSeek Harness already here (${version}, ${existing.source}).\n`)
  } else {
    // Offline first. Somebody who passed `--offline` asked about the network,
    // and answering with a complaint about `--artifacts` sends them to fix the
    // wrong thing.
    if (invocation.offline) {
      process.stderr.write(
        'deepwatch: --offline was given and there is no managed runtime yet.\n'
        + `           Building one needs ${HARNESS_VERSION} of the Harness from the\n`
        + '           registry. Nothing has been changed.\n')
      return 2
    }

    const source = chooseSource(invocation, env)
    let packages: readonly ManagedPackage[] = []
    if (source.mode === 'local-artifacts') {
      const read = readArtifacts(source.artifacts as string)
      if ('failure' in read) {
        process.stderr.write(
          `deepwatch: ${read.detail}.\n`
          + '           Nothing has been changed. --artifacts must name the directory\n'
          + '           holding the packed DeepWatch tarballs and their\n'
          + '           packed-artifacts.json inventory.\n')
        return 2
      }
      packages = read.packages
    } else {
      process.stderr.write(
        'deepwatch: no DeepWatch artifact directory was given, and the DeepWatch\n'
        + '           packages are not published, so there is nowhere to get them.\n'
        + '           Nothing has been changed. Pass --artifacts <dir> naming the\n'
        + '           packed tarballs and their packed-artifacts.json inventory.\n')
      return 2
    }

    const plan = managedPlan(destination, source.mode, source.artifacts, packages)
    process.stdout.write(renderManagedPlan(plan))
    if (!await agreed(invocation)) {
      process.stderr.write(
        'deepwatch: nothing was downloaded and nothing was changed.\n'
        + '           Re-run with --yes to accept.\n')
      return 2
    }

    const report = await provisionManagedRuntime({
      home: deepwatchHome(env),
      destination,
      mode: source.mode,
      artifacts: source.artifacts,
      packages,
      env,
      onStep: message => { process.stdout.write(`${message}\n`) },
    })
    if (report.outcome !== 'installed') {
      process.stderr.write(
        `deepwatch: setup stopped in the ${report.phase ?? 'setup'} phase — `
        + `${report.detail}.\n`
        + `           ${report.fix}\n`
        + (report.cleanup === '' ? '' : `           ${report.cleanup}\n`))
      return report.outcome === 'locked' ? 2 : 1
    }

    process.stdout.write(
      `  built the managed runtime in ${String(Math.round((report.elapsedMs ?? 0) / 1000))}s\n`
      + `  ${String(report.installedPackages ?? 0)} packages, `
      + `${String(report.requiredPeers ?? 0)} required peers supplied, 0 missing\n`
      + `  receipt: ${String(report.receipt)}\n`)

    dsh = harness(env)
    if (dsh === null) {
      process.stderr.write(
        'deepwatch: the runtime was built and cannot be resolved.\n'
        + `           It is at ${destination}. Run \`deepwatch doctor\` to see why.\n`)
      return 1
    }
  }

  if (dsh === null) {
    process.stderr.write('deepwatch: no DeepSeek Harness could be resolved.\n')
    return 1
  }
  if (dsh.anchor === undefined) {
    process.stderr.write(
      'deepwatch: DEEPWATCH_DSH_BIN names an executable, so the DeepWatch bundle\n'
      + '           cannot be resolved from it. Unset it and run setup again to\n'
      + '           build a managed runtime.\n')
    return 2
  }

  // Proved before the profile is touched. A setup that initialises a profile
  // and only then discovers it has nothing to compose has changed the machine
  // to reach a failure it could have reported first.
  const lookup = resolveBundle(dsh.anchor, dsh.home ?? destination)
  const bundle = lookup.bundle
  if (bundle === null) {
    process.stderr.write(
      `deepwatch: ${lookup.detail}.\n`
      + '           Nothing has been changed.\n'
      + `           ${lookup.fix}\n`)
    return 2
  }

  const already = existsSync(manifest)
  mkdirSync(home, { recursive: true })
  process.stdout.write(already
    ? `Re-composing the DeepWatch profile "${profile}".\n`
    : `Composing the DeepWatch profile "${profile}".\n`)

  const managedRoot = dsh.home ?? destination
  const composition = await composeProfile({
    dshEntry: dsh.prefix[0] ?? dsh.command,
    managedRoot,
    dshHome: home,
    profile,
    env,
    timeoutMs: PROFILE_TIMEOUT_MS,
    // Asked rather than assumed. A manifest that names a layer is not a tree
    // that imports one, and `--dump-config` cannot tell the two apart: it
    // resolves configuration without loading a plugin or binding a port. The
    // only check that fails when the profile is genuinely unusable is opening
    // it, so setup opens it.
    bootProbe: true,
    onStep: message => { process.stdout.write(`${message}\n`) },
  })
  if (composition.outcome !== 'composed' && composition.outcome !== 'already-composed') {
    process.stderr.write(
      `deepwatch: ${composition.detail}.\n`
      + `           ${composition.fix}\n`)
    return 1
  }

  writeFileSync(
    compositionReceiptPath(env),
    `${JSON.stringify({
      composedBy: '@deepwatch/cli',
      package: bundle.name,
      version: bundle.version,
      digest: bundle.digest,
      patch: bundle.patch,
      profile,
      bundles: composition.bundles,
      result: composition.outcome,
      // Deliberately not the bundle's directory: a receipt is reviewed and
      // sometimes pasted, and a maintainer's absolute path is not this
      // product's to publish.
      resolvedFrom: 'the managed DeepWatch runtime',
      registryRequests: 'none — every DeepWatch package came from the runtime\'s own '
        + 'verified copies',
      // Recorded as a fact about this machine, not as a URL to keep: the probe
      // asked the operating system for a port and stopped the server again.
      boot: composition.servedFrom === undefined
        ? 'not probed'
        : 'the composed profile served a page on a loopback port and was stopped',
      composedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  )

  process.stdout.write(
    '\nDeepWatch is composed.\n'
    + `  profile: ${profile}\n`
    + `  bundle:  ${bundle.name}@${bundle.version} (${composition.outcome})\n`
    + `  digest:  ${bundle.digest}\n`
    + `  home:    ${deepwatchHome(env)}\n\n`
    + 'Run `deepwatch web` to open it, or `deepwatch doctor` to see what else\n'
    + 'this machine has. No provider is configured and none is required to start.\n')
  return 0
}

/** Where the record of what was composed, and from what, is kept. */
export function compositionReceiptPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(deepwatchHome(env), 'deepwatch-composition-receipt.json')
}
