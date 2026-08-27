// The browser half is built by the Watch client-bundle preset, which emits the
// exact artifact `@deepseek-ai/dsh-client-modules` serves and executes.
import { watchClientBundle } from '../../../scripts/client-bundle.mjs'

export default watchClientBundle(import.meta.dirname)
