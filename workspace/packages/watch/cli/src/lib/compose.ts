/**
 * Turning a managed runtime into a profile a person can open, and proving it
 * before saying so.
 *
 * Composing is four things, and leaving any of them out produces a profile
 * that passes every static check and serves nothing. Each was found by a
 * profile that did exactly that.
 *
 * **The DeepWatch packages have to be installed *into the profile*.** The
 * Harness resolves a bundle *entry* from its own installation, which is why
 * `@deepwatch/dsh-bundle` in the layer list resolves at all. But the loader
 * entries that bundle declares — `@deepwatch/dsh-memory`, `dsh-library`, and
 * the rest — are imported from the profile directory, and the Harness heals
 * `profiles/node_modules` from its *own* dependency closure, which does not
 * include anything under `@deepwatch`. So the runtime installing them is
 * necessary and is not sufficient: `dsh plugin add` puts them where the loader
 * will look. The first profile built without this composed cleanly, dumped its
 * config cleanly, and died on `ERR_MODULE_NOT_FOUND` for `@deepwatch/dsh-memory`.
 *
 * **That install must not reach a registry.** Nothing under `@deepwatch` is
 * published, so pnpm is told where every one of those packages is — from the
 * runtime's own verified copies under `.artifacts/`, which are permanent and
 * DeepWatch's own. The overrides go in the profile's `pnpm-workspace.yaml`,
 * not in `package.json`: pnpm 11 stopped reading `pnpm.overrides` from a
 * manifest and says so in a warning that is easy to miss, and a profile that
 * relied on the old home resolved nineteen packages straight to a 404.
 *
 * **The profile needs an application layer.** The Harness seeds a new
 * profile's bundle list from its *name*: a profile called `web` gets
 * `@deepseek-ai/dsh-web-app`, and a profile called anything else gets only
 * `@deepseek-ai/dsh-base`. DeepWatch composes a profile of its own rather than
 * editing somebody's `web`, so it has to add that layer itself. Without it the
 * profile boots, prints nothing, listens on no port, and exits zero.
 *
 * **And then it has to be opened.** `--dump-config` resolves a tree; it does
 * not import a plugin, bind a port or serve a page. Every failure above
 * survived it. So composition ends by starting the profile, waiting for the
 * Harness to say which URL it is on, asking that URL for a page, and stopping
 * it again.
 *
 * @module @deepwatch/cli/lib/compose
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { run, startAndWaitFor } from './exec.js'
import { ARTIFACT_DIR } from './provision.js'
import {
  BUNDLE_PACKAGE, UPSTREAM_NOTICE_FIELD, UPSTREAM_NOTICE_NAMESPACE, UPSTREAM_NOTICE_VERSION,
} from '../version.js'

/** The Harness's own layers, in the order a web profile needs them. */
const BASE_LAYER = '@deepseek-ai/dsh-base'
const WEB_LAYER = '@deepseek-ai/dsh-web-app'

/** Where the local-artifact overrides are written, and how they are found again. */
const OVERRIDE_MARK = '# deepwatch: local artifact overrides — written by `deepwatch setup`'
const OVERRIDE_END = '# deepwatch: end of local artifact overrides'

/** How composition ended. */
export type CompositionOutcome =
  | 'composed'
  | 'already-composed'
  | 'initialise-failed'
  | 'install-failed'
  | 'unreadable-profile'
  | 'config-failed'
  | 'boot-failed'

/** What composing did, and what a person needs to know about it. */
export interface CompositionReport {
  readonly outcome: CompositionOutcome
  readonly detail: string
  readonly fix: string
  /** The layer list as it now stands. */
  readonly bundles?: readonly string[]
  /** The URL the profile served during the boot probe, when one ran. */
  readonly servedFrom?: string
  /** Whether the layer list already held the bundle before this ran. */
  readonly changed?: boolean
  /** What was done about upstream's internal-testing notice, for the receipt. */
  readonly upstreamNotice?: 'already-answered' | 'marked-handled'
  /** The Watch Core executable the Bridge was pointed at, when one was named. */
  readonly watchCoreBin?: string
}

/** What to compose, and where. */
export interface ComposeOptions {
  /** The managed Harness's `lib/bin.js`. */
  readonly dshEntry: string
  /** The promoted (or staged) managed runtime root, which owns `.artifacts/`. */
  readonly managedRoot: string
  /** `DSH_HOME`, which is where profiles live. */
  readonly dshHome: string
  readonly profile: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  /**
   * Start the composed profile and require it to serve a page.
   *
   * The only check here that fails when the profile is genuinely unusable.
   * Off only where something else has already done it.
   */
  readonly bootProbe: boolean
  /**
   * The Watch Core executable, when `WATCH_CORE_BIN` names one.
   *
   * Absent means the Bridge keeps the bundle's `auto` transport and looks for
   * `watch-skill` on `PATH`, which is the right default for a machine where
   * nobody has said where the engine is.
   */
  readonly watchCoreBin?: string | null
  readonly onStep?: (message: string) => void
}

/** The profile manifest, in the parts composition touches. */
interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  [key: string]: unknown
}

/**
 * Mark upstream's internal-testing notice handled, for this profile only.
 *
 * The Harness shows a developer notice on first run and records the
 * acknowledgement in its own durable settings document. DeepWatch has its own
 * onboarding, and a person meeting both got two modals in a row — the first
 * about the DSH plugin ecosystem, which is not what they installed.
 *
 * This writes the same field the Continue button writes, in the *managed*
 * profile's Harness home. Three properties make that safe:
 *
 *   - it is scoped to `<DeepWatch home>/dsh-home`, so a stock DSH profile
 *     elsewhere on the machine still shows the notice, which is upstream's to
 *     show about upstream's product;
 *   - it only ever *adds* a section that is absent. An existing
 *     `ui-onboarding` block is left exactly as it is, so a person who has
 *     already answered — or who edited the file — is not overwritten;
 *   - it never rewrites the rest of the document. The settings file is the
 *     Harness's, it carries other sections, and a setup step is not entitled
 *     to reformat somebody's configuration.
 *
 * @returns what was done, for the composition receipt.
 */
export function acknowledgeUpstreamNotice(
  dshHome: string,
): 'already-answered' | 'marked-handled' {
  const path = join(dshHome, 'settings.yaml')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  // A top-level YAML key, at column zero. Matching loosely here would find the
  // word inside a comment or a nested value and skip a profile that needs it.
  if (new RegExp(`^${UPSTREAM_NOTICE_NAMESPACE}:`, 'm').test(before)) {
    return 'already-answered'
  }
  mkdirSync(dshHome, { recursive: true })
  const section = [
    `${UPSTREAM_NOTICE_NAMESPACE}:`,
    // Quoted: the version is a date-like string and an unquoted 2026-08-13.1
    // is not a value a YAML reader is obliged to hand back as text.
    `  ${UPSTREAM_NOTICE_FIELD}: '${UPSTREAM_NOTICE_VERSION}'`,
    '',
  ].join('\n')
  writeFileSync(path, before === '' ? section : `${before.replace(/\n*$/, '\n')}${section}`, 'utf8')
  return 'marked-handled'
}

/** Where the Core-binary override is written, and how it is found again. */
const CORE_BIN_MARK = '# deepwatch: Watch Core binary — written by `deepwatch setup`'
const CORE_BIN_END = '# deepwatch: end of Watch Core binary override'

/**
 * Point the Bridge at the Watch Core executable a person actually named.
 *
 * `WATCH_CORE_BIN` was accepted, documented, and reported on by `doctor` --
 * and completely ignored by the thing that spawns the engine. The bundle
 * composes the Bridge with `command: watch-skill`, so a machine where the
 * engine is real but not on `PATH` got `spawn watch-skill ENOENT`, the Bridge
 * fell back to its mock, and every capability reported `not_tested` while
 * `doctor` said the binary was fine. A variable that is honoured in the report
 * and not in the runtime is worse than one that does not exist.
 *
 * The override goes in the *profile's own* patch layer, which is upstream's
 * documented place for per-profile changes and is applied after every bundle
 * layer. Written between markers so a second run replaces the block rather
 * than appending one, and so anything a person put in that file by hand
 * survives.
 *
 * **`stdio`, not `auto`.** `auto` falls back to the mock when the command is
 * missing, which is right when nobody has said where the engine is. Somebody
 * who sets `WATCH_CORE_BIN` has said exactly that, so a failure to start it is
 * a fault to report rather than a fallback to accept -- the same reasoning the
 * bundle already gives for pinning `stdio` in a deployment that requires the
 * engine.
 *
 * Every key of the row's config is restated, because a Loader patch replaces
 * the targeted row's whole `config` and an overlay that named only `command`
 * would silently drop the timeouts with it.
 *
 * @param profileDir - the composed profile's directory.
 * @param coreBin - the executable `WATCH_CORE_BIN` names.
 * @returns the path as written, for the receipt.
 */
export function writeCoreBinOverride(profileDir: string, coreBin: string): string {
  const path = join(profileDir, 'cordis.patch.yml')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const start = before.indexOf(CORE_BIN_MARK)
  const kept = start < 0
    ? before
    : before.slice(0, start) + before.slice(before.indexOf(CORE_BIN_END) + CORE_BIN_END.length)
  // The file the Harness writes for a new profile is the empty flow sequence
  // `[]`, and `[]` followed by block entries is not a document any YAML reader
  // will accept. Dropping it is what lets the first override be written at all.
  const body = kept.split(/\r?\n/)
    .filter(line => line.trim() !== '[]')
    .join('\n')
  // Forward slashes: a YAML scalar keeps its backslashes, and a Windows path
  // that survives quoting still has to survive being read back as a command.
  const command = coreBin.replace(/\\/g, '/')

  writeFileSync(path, [
    body.trimEnd(),
    '',
    CORE_BIN_MARK,
    '#',
    '# `WATCH_CORE_BIN` named this executable. `stdio` rather than `auto`: a',
    '# person who says where the engine is has said it is there, so failing to',
    '# start it is a fault to report rather than a mock to fall back to.',
    '- id: watch-core-bridge',
    '  config:',
    '    transport: stdio',
    `    command: '${command}'`,
    '    args: [bridge]',
    "    cwd: ''",
    '    startupTimeoutMs: 10000',
    '    requestTimeoutMs: 30000',
    '    autoConnect: true',
    CORE_BIN_END,
    '',
  ].join('\n'), 'utf8')
  return command
}

/** The DeepWatch tarballs the runtime keeps for itself. */
export function keptArtifacts(managedRoot: string): string[] {
  const dir = join(managedRoot, ARTIFACT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.tgz')).sort()
    .map(name => join(dir, name))
}

/** The package a packed tarball holds, by the name `pnpm pack` gives the file. */
function packageNameOf(file: string): string | null {
  const base = file.split(/[\\/]/).pop() ?? ''
  const match = /^deepwatch-(.+)-\d[^-]*(?:-[^-]+)*\.tgz$/.exec(base)
  return match === null ? null : `@deepwatch/${match[1]}`
}

/**
 * Point pnpm at the runtime's own copies, in the file pnpm still reads.
 *
 * Rewritten in place between two markers, so a second run replaces the block
 * rather than appending a second one, and anything else in the file — the
 * Harness's own `nodeLinker` and `autoInstallPeers` settings — is left exactly
 * as it was.
 */
export function writeArtifactOverrides(profileDir: string, tarballs: readonly string[]): number {
  const path = join(profileDir, 'pnpm-workspace.yaml')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : 'packages:\n  - .\n'
  const start = before.indexOf(OVERRIDE_MARK)
  const kept = start < 0
    ? before
    : before.slice(0, start) + before.slice(before.indexOf(OVERRIDE_END) + OVERRIDE_END.length)

  const rows: string[] = []
  for (const tarball of tarballs) {
    const name = packageNameOf(tarball)
    if (name === null) continue
    // Forward slashes: a YAML scalar carrying a Windows path is read back with
    // its separators intact, and pnpm treats a `file:` specifier as a URL-ish
    // path where a backslash is not one.
    rows.push(`  '${name}': 'file:${tarball.replace(/\\/g, '/')}'`)
  }
  rows.sort()

  writeFileSync(path, [
    kept.trimEnd(),
    '',
    OVERRIDE_MARK,
    '#',
    '# Every DeepWatch package, resolved to the copy inside the managed runtime.',
    '# Nothing under @deepwatch is published; without these, pnpm asks the public',
    '# registry for a scope that does not exist and reports nineteen 404s.',
    'overrides:',
    ...rows,
    OVERRIDE_END,
    '',
  ].join('\n'), 'utf8')
  return rows.length
}

/**
 * The layer list a DeepWatch profile needs, with everything else preserved.
 *
 * The Harness's own layers come first and in order, then the DeepWatch bundle,
 * then anything a person put there themselves. Idempotent: a list that already
 * has all three comes back unchanged, because a duplicated layer composes
 * every row twice and the loader refuses to boot with `duplicate loader entry
 * id`.
 */
export function requiredBundles(existing: readonly string[]): string[] {
  const wanted = [BASE_LAYER, WEB_LAYER, BUNDLE_PACKAGE]
  const out: string[] = []
  for (const layer of wanted) if (!out.includes(layer)) out.push(layer)
  for (const layer of existing) if (!out.includes(layer)) out.push(layer)
  return out
}

/** Compose the DeepWatch profile, and prove it serves. */
export async function composeProfile(
  options: ComposeOptions,
): Promise<CompositionReport> {
  const say = options.onStep ?? ((): void => {})
  const env = { ...options.env, DSH_HOME: options.dshHome }
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const dsh = (args: readonly string[]) =>
    run(process.execPath, [options.dshEntry, ...args],
      { env, timeoutMs: options.timeoutMs, cwd: options.managedRoot })

  mkdirSync(options.dshHome, { recursive: true })
  // Before the Harness is asked to do anything with this home: the notice is
  // read at first paint, so marking it handled afterwards would still show it
  // once.
  const notice = acknowledgeUpstreamNotice(options.dshHome)

  const initialised = await dsh(['plugin', '--profile', options.profile, 'install'])
  if (initialised.code !== 0) {
    return {
      outcome: 'initialise-failed',
      detail: firstLine(initialised.stderr === '' ? initialised.stdout : initialised.stderr),
      fix: 'Run `deepwatch doctor` to see what the Harness is missing.',
    }
  }

  const manifestPath = join(profileDir, 'package.json')
  let manifest: ProfileManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
  } catch (error) {
    return {
      outcome: 'unreadable-profile',
      detail: `the Harness initialised the profile and left no readable manifest: ${String(error)}`,
      fix: 'Remove the profile directory and run setup again.',
    }
  }

  const before = manifest.dsh?.profile?.bundles ?? []
  const already = before.includes(BUNDLE_PACKAGE)
    && Object.keys(manifest.dependencies ?? {}).some(name => name.startsWith('@deepwatch/'))

  const tarballs = keptArtifacts(options.managedRoot)
  if (tarballs.length === 0) {
    return {
      outcome: 'install-failed',
      detail: `the managed runtime at ${options.managedRoot} kept no DeepWatch artifacts, so `
        + 'the profile has nowhere to install them from',
      fix: 'Run `deepwatch setup --artifacts <dir>` to rebuild the managed runtime.',
    }
  }

  say(`  installing ${String(tarballs.length)} DeepWatch packages into the profile`)
  writeArtifactOverrides(profileDir, tarballs)
  const added = await dsh(['plugin', '--profile', options.profile, 'add', ...tarballs])
  if (added.code !== 0) {
    return {
      outcome: 'install-failed',
      detail: firstLine(added.stderr === '' ? added.stdout : added.stderr),
      fix: 'The profile could not install the DeepWatch packages from the managed '
        + "runtime's own copies. Run `deepwatch setup --artifacts <dir>` again.",
    }
  }

  // Re-read: `plugin add` rewrites the manifest, so an edit made before it is
  // an edit thrown away.
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
  } catch (error) {
    return {
      outcome: 'unreadable-profile',
      detail: `the profile manifest could not be read after installing: ${String(error)}`,
      fix: 'Remove the profile directory and run setup again.',
    }
  }
  const bundles = requiredBundles(manifest.dsh?.profile?.bundles ?? [])
  writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
  }, null, 2)}\n`, 'utf8')

  // After `plugin add` (which rewrites the manifest) and before the config is
  // resolved, so the dump and the boot probe both see the override.
  const corePath = options.watchCoreBin === undefined || options.watchCoreBin === null
    ? undefined
    : writeCoreBinOverride(profileDir, options.watchCoreBin)
  if (corePath !== undefined) say(`  pointing the Bridge at ${corePath}`)

  const dumped = await dsh(['--profile', options.profile, '--dump-config'])
  if (dumped.code !== 0) {
    return {
      outcome: 'config-failed',
      detail: firstLine(dumped.stderr === '' ? dumped.stdout : dumped.stderr),
      fix: 'The composed profile did not resolve. Run `deepwatch setup` again.',
      bundles,
    }
  }

  if (!options.bootProbe) {
    return {
      outcome: already ? 'already-composed' : 'composed',
      detail: `${BUNDLE_PACKAGE} composed into ${options.profile}`,
      fix: '',
      bundles,
      changed: !already,
      upstreamNotice: notice,
      ...corePath === undefined ? {} : { watchCoreBin: corePath },
    }
  }

  // Port 0: the operating system picks one, so a probe never collides with
  // something the person already has open, and the Harness prints the URL it
  // actually chose.
  say('  opening the profile to check it serves')
  const watched = await startAndWaitFor(
    process.execPath,
    [options.dshEntry, '--profile', options.profile, '--no-open',
      '--host', '127.0.0.1', '--port', '0'],
    { env, timeoutMs: options.timeoutMs, cwd: options.managedRoot },
    /http:\/\/127\.0\.0\.1:\d+/)

  if (watched.match === null) {
    return {
      outcome: 'boot-failed',
      detail: watched.failure === 'timeout'
        ? 'the composed profile did not say it was listening before the deadline'
        : `the composed profile exited without serving: ${
          firstLine(watched.stderr === '' ? watched.stdout : watched.stderr)}`,
      fix: 'The runtime installed and the profile does not open. Run '
        + '`deepwatch setup --artifacts <dir>` again; if it repeats, report it with '
        + 'the receipt in the managed runtime.',
      bundles,
    }
  }

  return {
    outcome: already ? 'already-composed' : 'composed',
    detail: `${BUNDLE_PACKAGE} composed into ${options.profile}`,
    fix: '',
    bundles,
    servedFrom: watched.match,
    changed: !already,
    upstreamNotice: notice,
    ...corePath === undefined ? {} : { watchCoreBin: corePath },
  }
}

/** The first line of a child's output, for a message a person will read. */
function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'no output'
}
