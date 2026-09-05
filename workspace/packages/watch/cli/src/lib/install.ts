/**
 * The one npm invocation this product ever builds.
 *
 * Every argument here was decided once, for a measured reason, and there is
 * exactly one place that decides them. `setup` calls this, the packed-install
 * verifier calls this, the closure capture calls this, and the integration
 * tests call this — through `scripts/lib/install.mjs`, which re-exports this
 * module rather than keeping a second copy. Two implementations of one
 * boundary is the shape of the defect that shipped: the release tooling knew
 * how to start a package manager on Windows and the CLI did not, and the CLI
 * is the half a user runs.
 *
 * **`--legacy-peer-deps` is not a preference.** npm's default peer resolution
 * does not complete on the Harness closure — two attempts, roughly ten and
 * seventy minutes, about 3 GB resident, no files written. This mode completes
 * in seconds. What it costs is that it installs *no* peers at all, which on
 * its own leaves required peers missing and a Harness that will not start. The
 * flag is therefore only ever correct together with an explicit, exact,
 * generated required-peer set on the same command line — which is what
 * `generated/managed-runtime.ts` is for. Passing one without the other is the
 * wrong half of a two-part decision.
 *
 * **`--no-audit --no-fund` because the repository says so.** Neither changes
 * what is installed; both add a network round trip and output nobody reads to
 * a step that is already the longest thing setup does.
 *
 * **Lifecycle scripts are allowed, deliberately.** The audited closure
 * contains packages that build or place a native binary during installation,
 * and `--ignore-scripts` would produce a tree that installs cleanly and cannot
 * run. That is a property of the dependency graph rather than a choice, and it
 * is recorded in the closure evidence as `hasInstallScript`.
 *
 * **No retries and no fallback.** A failed install is reported, not retried
 * into a different shape: an unbounded retry hides the failure that mattered,
 * and falling back to another package manager produces a tree nobody measured.
 *
 * @module @deepwatch/cli/lib/install
 */

import { HARNESS_REGISTRY } from '../version.js'

/**
 * The arguments for one npm install, after the npm entry point itself.
 *
 * @param specs - exact package specifications to install. Empty installs
 * whatever the manifest in the working directory declares.
 * @param registry - the registry the plan named. Never inherited silently from
 * an ambient configuration the plan did not show a person.
 * @returns the argument array, to be passed to a shell-free spawn.
 */
export function installInvocation(
  specs: readonly string[] = [], registry: string = HARNESS_REGISTRY,
): readonly string[] {
  return [
    'install',
    '--no-audit',
    '--no-fund',
    // See the module note. Only ever correct alongside an explicit exact peer
    // set, which is why the generated manifest and this flag live one import
    // apart and are used together or not at all.
    '--legacy-peer-deps',
    `--registry=${registry}`,
    ...specs,
  ]
}
