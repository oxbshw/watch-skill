/**
 * The versions and endpoints this CLI has to be right about.
 *
 * Constants rather than runtime reads, because a published package has no
 * repository beside it: `package.json` is there, but the
 * `upstream/deepseek-harness.lock` that pins the Harness is not.
 * `tests/cli.test.mjs` compares each against its source in the repository, so a
 * bump to one without the other fails a gate rather than shipping a CLI that
 * reports a version it is not.
 *
 * @module @deepwatch/cli/version
 */

/** Kept in step with this package's `version` by the test named above. */
export const VERSION = '0.1.0-preview.0'

/** The Harness package DeepWatch composes. Official, unforked, unpatched. */
export const HARNESS_PACKAGE = '@deepseek-ai/dsh'

/**
 * The Harness version this distribution was measured against.
 *
 * Exact, never a range. Parity, the slot inventory and every composition gate
 * in this repository were measured against one version; a CLI that accepted a
 * newer one would be running a product nobody tested.
 */
export const HARNESS_VERSION = '0.1.1-rc.2'

/** Where it is fetched from, named in the plan before anything is fetched. */
export const HARNESS_REGISTRY = 'https://registry.npmjs.org'

/**
 * The DeepWatch profile layer `setup` composes.
 *
 * Never fetched from a registry — nobody published this scope. `setup`
 * installs it from a verified local tarball into the managed runtime, beside
 * the Harness, and `lib/bundle.ts` resolves it from the Harness's own anchor
 * and proves it is inside that runtime. It is *not* resolved from this CLI's
 * installation: that is a different directory, and assuming otherwise is the
 * mistake `tests/resolution-model.test.mjs` exists to keep out.
 */
export const BUNDLE_PACKAGE = '@deepwatch/dsh-bundle'

/**
 * The bundle version this CLI composes, which is its own.
 *
 * The DeepWatch packages are released as one set at one version, and
 * `tests/cli.test.mjs` holds this to the bundle's own manifest so the two
 * cannot drift into a CLI that composes a bundle nobody measured against it.
 */
export const BUNDLE_VERSION = VERSION
