/**
 * The one profile-composition boundary, shared with the product.
 *
 * Like `scripts/lib/process.mjs`, this file holds no implementation. It
 * re-exports `@deepwatch/cli`'s own `lib/compose` so the release and QA
 * tooling answers upstream's onboarding notice through exactly the same code
 * `deepwatch setup` uses. A second, differently-correct copy of that
 * acknowledgement is how a QA profile ends up showing a modal the shipped
 * product does not, and then nobody can tell which one a user will see.
 *
 * Importing from the CLI's build output means the CLI must be built before the
 * scripts that use this run. That ordering already holds — `npm run check`
 * builds before it packs — and a missing build fails here with a clear message
 * naming `npm run build` rather than with a module-resolution error from three
 * frames deeper.
 *
 * @module scripts/lib/compose
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMPOSE = join(ROOT, 'packages', 'watch', 'cli', 'lib', 'lib', 'compose.js')

if (!existsSync(COMPOSE)) {
  throw new Error(
    'scripts/lib/compose.mjs: @deepwatch/cli is not built, so the shared profile '
    + `composition boundary is not there yet (looked for ${COMPOSE}). `
    + 'Run `npm run build` first.',
  )
}

export { acknowledgeUpstreamNotice } from '../../packages/watch/cli/lib/lib/compose.js'
