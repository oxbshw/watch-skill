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

/**
 * The composition this release recorded, as a digest over its runtime packages.
 *
 * `deepwatch doctor` computes the same value from what is actually installed
 * and says whether the two agree, which is the whole provenance chain: an
 * installation that cannot name its own release is one nobody can audit.
 *
 * A constant rather than a runtime read, for the same reason as the versions
 * above -- a published package has no release manifest beside it. The manifest
 * is the source of truth and `tests/provenance-identity.test.mjs` holds this
 * against it, so a release that bumps a package version without regenerating
 * both fails a gate instead of shipping a CLI that vouches for the wrong build.
 */
export const RELEASE_RUNTIME_DIGEST = 'sha256:d4ba416a2f0e64756628df06cdba212fc5e8c7f35f44f90d84abcc797c92644f'

/**
 * Whether the `@deepwatch` scope exists on a public registry yet.
 *
 * `false`, and it must stay false until the publish step actually runs. The
 * distinction is not pedantry: `doctor` used to report that an installation
 * "matches the published composition", which was untrue of every installation
 * that has ever existed — nothing has been published, so nothing can match it.
 * A person reading that line would reasonably conclude they were running a
 * released build and that a registry could confirm it.
 *
 * What `doctor` can honestly say is narrower and more useful: these are the
 * packages this CLI was built to compose, and the digest agrees with the
 * release manifest. That is a *recorded* composition, not a published one.
 */
export const SCOPE_PUBLISHED = false

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
 * Upstream's internal-testing notice, as this baseline ships it.
 *
 * The Harness shows a developer-facing notice on first run and records the
 * acknowledgement as a durable setting, comparing it to this exact string. A
 * DeepWatch-managed profile marks it handled at setup, so a person gets one
 * onboarding surface — DeepWatch's — instead of an upstream notice about the
 * DSH plugin ecosystem followed by a second modal about DeepWatch.
 *
 * Nothing is disabled and nothing is patched: this is the same durable field
 * the Continue button writes, in the managed profile's own Harness home. A
 * stock DSH profile elsewhere on the machine is untouched and still shows it,
 * which is right — it is upstream's notice about upstream's product.
 *
 * Pinned rather than read at runtime, because the profile is seeded before
 * anything is running. `tests/onboarding.test.mjs` compares these three
 * constants against the pinned Harness source, so a baseline bump that changes
 * the notice fails a gate instead of quietly bringing the modal back.
 */
export const UPSTREAM_NOTICE_NAMESPACE = 'ui-onboarding'

/** The durable field carrying the last acknowledged notice version. */
export const UPSTREAM_NOTICE_FIELD = 'welcomeNoticeVersion'

/** The notice version the pinned Harness compares against, for exact equality. */
export const UPSTREAM_NOTICE_VERSION = '2026-08-13.1'

/**
 * The bundle version this CLI composes, which is its own.
 *
 * The DeepWatch packages are released as one set at one version, and
 * `tests/cli.test.mjs` holds this to the bundle's own manifest so the two
 * cannot drift into a CLI that composes a bundle nobody measured against it.
 */
export const BUNDLE_VERSION = VERSION
