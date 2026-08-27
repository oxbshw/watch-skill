/**
 * The Watch Core contract digests this build was written against.
 *
 * ADR-004 makes the Pydantic models in `watch-skill` the semantic source of
 * truth for the wire, and the TypeScript types in this package a face over
 * them. The risk in that arrangement is drift: the engine adds a field, the
 * Workspace keeps compiling, and the mismatch first shows up as a value that
 * is quietly `undefined` in production.
 *
 * These digests close that. Watch Core reports the same values in its
 * handshake, computed from the models themselves, and the Bridge compares them
 * on connect. A family that disagrees disables the Watch features that depend
 * on it and names both sides, instead of failing later somewhere unrelated.
 *
 * Regenerate with `python scripts/gen_bridge_schemas.py` in `watch-skill`, then
 * copy the `families` block from `schemas/bridge/manifest.json`.
 *
 * @module @watchskill/dsh-contracts/digests
 */

/** One contract family: a group of fields consumers break on together. */
export type SchemaFamily =
  | 'handshake'
  | 'evidence'
  | 'verification'
  | 'answer'
  | 'library'
  | 'error'

/**
 * Digests from `watch-skill@1.3.0rc2`, `schemas/bridge/manifest.json`.
 *
 * A digest changes when a family's schema changes in a way that matters:
 * hashing is over the canonical, key-sorted document, so a reordered field
 * does not read as a breaking change and a renamed one does.
 */
export const EXPECTED_SCHEMA_DIGESTS: Readonly<Record<SchemaFamily, string>> = {
  answer: 'sha256:b1d08711b75396f21b1823a5e69c8b37',
  error: 'sha256:b6e7b03def9e68dcd25d74347f1c1f77',
  evidence: 'sha256:9d75abea243404fe19909146a340ecfa',
  handshake: 'sha256:41e44cf6f9e29e4d4dbe7e4680dfc226',
  library: 'sha256:c409cf6a0e2c71ade790be43525c7b98',
  verification: 'sha256:3fb92fb22ccc8aa6258bd3b620bd76b1',
}

/**
 * Which Watch capability each contract family is load-bearing for.
 *
 * Used to disable *only* the affected features on a mismatch. A changed
 * `library` schema should not take verification offline, and vice versa.
 */
export const FAMILY_CAPABILITIES: Readonly<Record<SchemaFamily, readonly string[]>> = {
  handshake: ['watch.video.query', 'watch.library.search', 'watch.verification.run'],
  evidence: ['watch.video.query', 'watch.evidence.resolve'],
  verification: ['watch.verification.run'],
  answer: ['watch.video.query'],
  library: ['watch.library.search'],
  error: [],
}

/** One family whose digest did not match. */
export interface SchemaDrift {
  readonly family: SchemaFamily
  /** What this build was written against. */
  readonly expected: string
  /** What Watch Core reported, or null when it reported nothing for it. */
  readonly actual: string | null
  /** Capabilities that must be treated as unavailable because of it. */
  readonly affects: readonly string[]
}

/**
 * Compare the handshake's digests against this build's.
 *
 * A family Watch Core does not report at all counts as drift with a null
 * `actual`: an engine that has stopped publishing a digest is exactly as
 * unverifiable as one publishing a different value, and treating silence as
 * agreement is how this check would come to mean nothing.
 *
 * @param reported - the `schemaDigests` map from the handshake.
 * @returns every family that disagrees, empty when the contract matches.
 */
export function detectSchemaDrift(
  reported: Readonly<Record<string, string>>,
): readonly SchemaDrift[] {
  const drift: SchemaDrift[] = []
  for (const [family, expected] of Object.entries(EXPECTED_SCHEMA_DIGESTS)) {
    const actual = reported[family]
    if (actual === expected) continue
    drift.push({
      family: family as SchemaFamily,
      expected,
      actual: actual ?? null,
      affects: FAMILY_CAPABILITIES[family as SchemaFamily],
    })
  }
  return drift
}

/**
 * Whether an engine reporting no digests at all should be treated as drift.
 *
 * It should not. A Watch Core older than the schema manifest reports an empty
 * map, and refusing to talk to it would break a working setup to enforce a
 * check it predates. The Bridge surfaces that as "unverified contract" — a
 * degraded, visible state — rather than as a mismatch it cannot substantiate.
 *
 * @param reported - the `schemaDigests` map from the handshake.
 * @returns true when the engine published nothing to compare.
 */
export function isContractUnverified(
  reported: Readonly<Record<string, string>>,
): boolean {
  return Object.keys(reported).length === 0
}
