/**
 * Finding the DeepWatch bundle inside the managed runtime, and refusing every
 * other thing that could be mistaken for it.
 *
 * **Nothing under `@deepwatch` is published.** `setup` used to compose the
 * profile with `dsh plugin add @deepwatch/dsh-bundle` — a bare package name,
 * which pnpm resolves against the public registry, where that scope does not
 * exist. On any machine that was a 404; it only ever appeared to work inside
 * this repository, where a workspace link answered first. A distribution whose
 * setup step depends on a package nobody published is not installable.
 *
 * So the bundle is never *fetched*. It is installed from a verified local
 * tarball into the managed runtime, and that is the only place it is looked
 * for.
 *
 * **The CLI's `node_modules` is not the Harness's, and an earlier version of
 * this file said otherwise.** It claimed the bundle was "already here" because
 * `@deepwatch/cli` depends on it, so every install that produced the CLI
 * produced the bundle in the same tree. That is false exactly where it
 * matters: `setup` builds the runtime under the DeepWatch home while the CLI
 * lives wherever the user installed it — an npx cache, a global prefix, some
 * project — so Node's resolver walking up from the Harness never reaches the
 * CLI's tree at all. `tests/resolution-model.test.mjs` proves the lookup fails
 * across real separated directories, which is why {@link resolveBundle} takes
 * the Harness anchor *and* the managed root, and has no default for either.
 *
 * **Why a name and not a path.** DeepSeek Harness resolves each entry in
 * `dsh.profile.bundles` from its own installation first, and only then from
 * the profile — the contract that makes `@deepseek-ai/dsh-base` and every
 * other in-box bundle come from the same installation as the running `dsh`.
 * The managed runtime puts this bundle in precisely that installation, so the
 * same lookup finds it. Composition therefore writes one package *name* into
 * the profile manifest and no path at all, which is what keeps a maintainer's
 * absolute directory out of profile state, out of the composed tree, and out
 * of anything the browser can read.
 *
 * Every check below fails closed. A bundle that is absent, the wrong version,
 * a link into a source checkout, or invisible to the Harness is reported as
 * exactly that, because composing anyway would produce a profile that boots
 * and is not the product.
 *
 * @module @deepwatch/cli/lib/bundle
 */

import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, sep } from 'node:path'

import { BUNDLE_PACKAGE, BUNDLE_VERSION } from '../version.js'

/** The bundle, once it has passed every check. */
export interface ResolvedBundle {
  readonly name: string
  readonly version: string
  /** The real directory it was found in. Never written into profile state. */
  readonly dir: string
  /** The patch file that makes it a composable layer. */
  readonly patch: string
  /** `sha256:…` over the package manifest and the patch layers it ships. */
  readonly digest: string
}

/** Why the installed bundle could not be used. */
export type BundleFailure =
  | 'missing'
  | 'unreadable'
  | 'wrong-package'
  | 'version-mismatch'
  | 'linked'
  | 'workspace'
  | 'outside-managed-root'
  | 'not-a-bundle'

/** What {@link resolveBundle} found, or why it found nothing usable. */
export interface BundleLookup {
  readonly bundle: ResolvedBundle | null
  readonly failure?: BundleFailure
  /** What was observed. Never a stack, never a secret. */
  readonly detail: string
  /** What to do about it. Empty when there is nothing to do. */
  readonly fix: string
}

/**
 * A package directory, by Node's own `node_modules` lookup order.
 *
 * The same probe the Harness uses to resolve a bundle, and for the same
 * reason: it finds the directory the loader would import from this anchor, it
 * follows the symlinks an isolated store layout uses, and it does not require
 * the package to export `./package.json` — which this bundle does not.
 */
function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  let paths: readonly string[] | null
  try {
    paths = createRequire(anchor).resolve.paths(packageName)
  } catch {
    return undefined
  }
  for (const searchPath of paths ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Files that say a directory is a package workspace rather than somewhere a
 * product was installed.
 *
 * `pnpm-workspace.yaml` is this repository's own marker, and a checkout is
 * exactly what must not be composed from: it produces a profile that works on
 * the machine that built it and nowhere else, and the packages in its
 * `node_modules` are the ones being edited rather than the ones released.
 */
const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'lerna.json']

/** Whether the install this bundle came from is really a source checkout. */
function insideWorkspace(dir: string): boolean {
  // An installed package always sits at `<root>/node_modules/@scope/<name>`.
  // Anything else is not an install, whatever its manifest says.
  const scope = dirname(dir)
  const modules = dirname(scope)
  if (basename(scope) !== '@deepwatch' || basename(modules) !== 'node_modules') return true

  // `<root>` is the project that owns this `node_modules`. A root that
  // declares a package workspace is the repository these packages are built
  // in, not a place they were installed to — the case where running setup
  // from inside the checkout would compose the tree under development. A
  // pnpm-linked copy is caught earlier, as a link; this catches a real
  // directory hoisted into the same tree.
  const owner = dirname(modules)
  return WORKSPACE_MARKERS.some(marker => existsSync(join(owner, marker)))
}

/** `sha256:…` over the manifest and every patch layer the bundle ships. */
function digestOf(dir: string, manifest: BundleManifest): string {
  const hash = createHash('sha256')
  const variants = manifest.dsh?.bundle?.variants ?? {}
  const layers = [
    manifest.dsh?.bundle?.patch,
    ...Object.keys(variants).sort().map(key => variants[key]),
  ].filter((layer): layer is string => typeof layer === 'string')

  hash.update(`${manifest.name}@${manifest.version}\n`)
  for (const layer of [...new Set(layers)].sort()) {
    const file = join(dir, layer.replace(/^\.\//, ''))
    // A declared layer that is not there is caught by the caller; hashing what
    // is present keeps the digest defined either way.
    hash.update(`${layer}\n`)
    if (existsSync(file)) hash.update(readFileSync(file))
  }
  return `sha256:${hash.digest('hex')}`
}

/** The parts of a bundle manifest this module reads. */
interface BundleManifest {
  name?: string
  version?: string
  dsh?: { bundle?: { patch?: string, variants?: Record<string, string> } }
}

/**
 * Whether a real path sits inside a root.
 *
 * Both sides are resolved through the filesystem first, so a junction, a
 * symlinked temporary directory or a `..` cannot make an outside path look
 * like an inside one. The separator is required, so `…/harness-old` is not
 * treated as being inside `…/harness`.
 */
export function isInside(root: string, candidate: string): boolean {
  let base: string
  let target: string
  try {
    base = realpathSync(root)
    target = realpathSync(candidate)
  } catch {
    return false
  }
  if (base === target) return true
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * The DeepWatch bundle inside the managed runtime, proved rather than assumed.
 *
 * @param harnessAnchor - the managed Harness's own `package.json`. This is the
 * anchor that matters: it is what the Harness resolves a profile layer from,
 * so a bundle visible from anywhere else — this CLI's own installation, the
 * source checkout, a global tree — is not the one that will be loaded.
 * @param managedRoot - the runtime directory the bundle has to be *inside*.
 * Resolving from the Harness anchor is necessary and not sufficient: Node's
 * lookup walks upwards, so a stray `@deepwatch/dsh-bundle` in a parent
 * directory of the DeepWatch home would answer, and the runtime would then
 * depend on a directory setup never wrote and cannot vouch for.
 */
export function resolveBundle(harnessAnchor: string, managedRoot: string): BundleLookup {
  // Anchored on the Harness, never on this module and never on `process.cwd()`.
  const found = packageDirFromAnchor(harnessAnchor, BUNDLE_PACKAGE)
  if (found === undefined) {
    return {
      bundle: null,
      failure: 'missing',
      detail: `${BUNDLE_PACKAGE} is not in the managed DeepWatch runtime`,
      fix: 'Run `deepwatch setup` to build the managed runtime. The bundle lives '
        + 'inside it, beside the Harness, because that is where the Harness can '
        + 'resolve it from.',
    }
  }

  // A link is refused before the manifest is read: what a link points at is
  // not what was installed, and following it is how a checkout gets composed.
  let stats
  try {
    stats = lstatSync(found)
  } catch (error) {
    return {
      bundle: null,
      failure: 'unreadable',
      detail: `${BUNDLE_PACKAGE} could not be read: ${String(error)}`,
      fix: 'Check the permissions on the DeepWatch installation directory.',
    }
  }
  if (stats.isSymbolicLink()) {
    return {
      bundle: null,
      failure: 'linked',
      detail: `${BUNDLE_PACKAGE} is a symbolic link, so what would be composed `
        + 'is not what was installed',
      fix: 'This is a development checkout, not an install. Install the packed '
        + 'DeepWatch packages into a directory of their own and run setup from there.',
    }
  }

  const dir = realpathSync(found)
  let manifest: BundleManifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as BundleManifest
  } catch (error) {
    return {
      bundle: null,
      failure: 'unreadable',
      detail: `${BUNDLE_PACKAGE} has no readable manifest: ${String(error)}`,
      fix: 'Reinstall DeepWatch.',
    }
  }

  if (manifest.name !== BUNDLE_PACKAGE) {
    return {
      bundle: null,
      failure: 'wrong-package',
      detail: `expected ${BUNDLE_PACKAGE} and found ${String(manifest.name)}`,
      fix: 'Reinstall DeepWatch.',
    }
  }
  if (manifest.version !== BUNDLE_VERSION) {
    // Refused rather than accepted. The row inventory, the parity register and
    // every composition gate were measured against one version pair, and a CLI
    // composing a different bundle is composing a product nobody tested.
    return {
      bundle: null,
      failure: 'version-mismatch',
      detail: `${BUNDLE_PACKAGE} is ${String(manifest.version)} and this CLI `
        + `composes ${BUNDLE_VERSION}`,
      fix: 'Install the DeepWatch packages as one set. Mixing versions across '
        + 'the bundle and the CLI is not a supported configuration.',
    }
  }
  if (insideWorkspace(dir)) {
    return {
      bundle: null,
      failure: 'workspace',
      detail: `${BUNDLE_PACKAGE} resolved to a source checkout rather than an install`,
      fix: 'Run setup against an installed copy of the packed packages, not '
        + 'against the repository they are built from.',
    }
  }
  if (!isInside(managedRoot, dir)) {
    // Node's lookup walks upwards from the anchor, so a bundle in some parent
    // of the DeepWatch home answers here and would make the runtime depend on
    // a directory setup never wrote. Refused: self-contained means contained.
    return {
      bundle: null,
      failure: 'outside-managed-root',
      detail: `${BUNDLE_PACKAGE} resolved from outside the managed runtime, so the `
        + 'runtime would depend on a directory setup does not own',
      fix: 'Run `deepwatch setup` to rebuild the managed runtime, and remove any '
        + 'stray @deepwatch packages above the DeepWatch home.',
    }
  }

  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !existsSync(join(dir, patch.replace(/^\.\//, '')))) {
    return {
      bundle: null,
      failure: 'not-a-bundle',
      detail: typeof patch === 'string'
        ? `${BUNDLE_PACKAGE} declares the layer ${patch}, which is not in the package`
        : `${BUNDLE_PACKAGE} declares no dsh.bundle.patch`,
      fix: 'Reinstall DeepWatch. The bundle ships the profile layer it declares, '
        + 'and a copy without it cannot be composed.',
    }
  }

  return {
    bundle: {
      name: BUNDLE_PACKAGE,
      version: BUNDLE_VERSION,
      dir,
      patch,
      digest: digestOf(dir, manifest),
    },
    detail: `${BUNDLE_PACKAGE}@${BUNDLE_VERSION}`,
    fix: '',
  }
}
