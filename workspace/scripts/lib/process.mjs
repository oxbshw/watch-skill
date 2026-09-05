/**
 * The one process-launch boundary, shared with the product.
 *
 * This file deliberately holds no implementation. It re-exports
 * `@deepwatch/cli`'s own `lib/exec` so the release tooling and the shipped CLI
 * create processes through exactly the same code.
 *
 * They did not, once, and it mattered. The pack tooling knew that Node will
 * not spawn a Windows `.cmd` without a shell and worked around it in a local
 * helper with a comment explaining why; the CLI's `ensureHarness` spawned
 * `npm.cmd` with `shell: false` and shipped. Two implementations of the same
 * boundary, one correct, and the one a user runs was the other. A single
 * import is what makes that impossible rather than merely unlikely.
 *
 * Importing from the CLI's build output means the CLI must be built before the
 * release scripts that use this run. That ordering already holds — `npm run
 * check` builds before it packs — and a missing build fails here with a clear
 * message rather than at a subtler place later.
 *
 * @module scripts/lib/process
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXEC = join(ROOT, 'packages', 'watch', 'cli', 'lib', 'lib', 'exec.js')

if (!existsSync(EXEC)) {
  throw new Error(
    'scripts/lib/process.mjs: @deepwatch/cli is not built, so the shared process '
    + `boundary is not there yet (looked for ${EXEC}). Run \`npm run build\` first.`,
  )
}

export {
  assertSafeShimArgument,
  describeCommand,
  describeEnv,
  launchWindowsShim,
  probe,
  resolveNodeCli,
  resolveNpm,
  resolvePnpm,
  run,
  stop,
  supervise,
  UnsafeCommandError,
} from '../../packages/watch/cli/lib/lib/exec.js'
