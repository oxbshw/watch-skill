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
import { BUNDLE_PACKAGE } from '../version.js'

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
  readonly onStep?: (message: string) => void
}

/** The profile manifest, in the parts composition touches. */
interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  [key: string]: unknown
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
  }
}

/** The first line of a child's output, for a message a person will read. */
function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'no output'
}
