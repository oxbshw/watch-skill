/**
 * The two versions this CLI has to be right about.
 *
 * Both are constants rather than reads at runtime, because a published package
 * has no repository to read from — the manifest is beside it but the
 * `upstream/deepseek-harness.lock` that pins the Harness is not. `tests/cli.test.mjs`
 * compares each against its source in the repository, so a bump to one without
 * the other fails a gate rather than shipping a CLI that reports a version it
 * is not.
 *
 * @module @deepwatch/cli/version
 */

/** Kept in step with this package's `version` by the test named above. */
export const VERSION = '0.1.0-preview.0'

/**
 * The DeepSeek Harness this distribution was measured against.
 *
 * `setup` installs exactly this. Not a range: parity, the slot inventory and
 * every composition gate in this repository were measured against one version,
 * and a CLI that installed a newer one would be running a product nobody
 * tested.
 */
export const HARNESS_VERSION = '0.1.1-rc.2'
