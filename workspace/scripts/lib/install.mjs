/**
 * The one install invocation, shared with the product.
 *
 * Like `lib/process.mjs`, this file holds no implementation. It re-exports the
 * shipped CLI's own builder so that the product's `setup`, the packed-install
 * verifier, the closure capture and the integration tests all pass npm exactly
 * the same arguments.
 *
 * The reason is specific. `--legacy-peer-deps` is not a preference, it is a
 * load-bearing decision with a documented cost: it is the only mode that
 * finishes on this closure, and it installs no peers at all, so every required
 * peer has to be supplied explicitly alongside it. A second place that decides
 * whether to pass that flag is a second place that can decide differently, and
 * the last time two copies of one boundary disagreed the wrong one was the one
 * a user ran.
 *
 * @module scripts/lib/install
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUILT = join(ROOT, 'packages', 'watch', 'cli', 'lib', 'lib', 'install.js')

if (!existsSync(BUILT)) {
  throw new Error(
    'scripts/lib/install.mjs: @deepwatch/cli is not built, so the shared install '
    + `invocation is not there yet (looked for ${BUILT}). Run \`npm run build\` first.`,
  )
}

export { installInvocation } from '../../packages/watch/cli/lib/lib/install.js'

export {
  ARTIFACT_DIR,
  DEEPWATCH_PACKAGE_COUNT,
  installedPackages,
  managedDependencies,
  managedManifest,
  managedManifestDigest,
  missingRequiredPeers,
  readArtifacts,
} from '../../packages/watch/cli/lib/lib/provision.js'
