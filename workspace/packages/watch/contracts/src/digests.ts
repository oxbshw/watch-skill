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
 * @module @deepwatch/dsh-contracts/digests
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
 * Digests generated from Watch Core's Bridge wire models.
 *
 * Source: `schemas/bridge/manifest.json`, written by
 * `python scripts/gen_bridge_schemas.py` from
 * `watch_skill.surfaces.bridge.wire`. Core computes the same values at import
 * and reports them in the handshake, so these two are one artifact seen from
 * two sides rather than two lists that have to be kept in step by hand.
 *
 * A digest changes when a family's schema changes in a way that matters:
 * hashing is over the canonical, key-sorted document, so a reordered field
 * does not read as a breaking change and a renamed one does.
 */
export const EXPECTED_SCHEMA_DIGESTS: Readonly<Record<SchemaFamily, string>> = {
  answer: 'sha256:2abc33bc76abe07486446bae94c70211',
  error: 'sha256:f83b04be5dffc2dfab6963f071c7455a',
  evidence: 'sha256:3facf1e0c00ffb61e9724d0a17b5d589',
  handshake: 'sha256:215466e1a4d3ea526e71c5a162bf861b',
  library: 'sha256:cb1a1721b33ccca2e25ea000fe41c7f1',
  verification: 'sha256:0f381733ba98849b8335ad0fa1534534',
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
  reported: Readonly<Record<string, string>> | null | undefined,
): boolean {
  // Absent and empty are the same answer: nothing was published to compare.
  // The type says this map is always present, and the type does not survive
  // the wire — this value came out of `JSON.parse` of whatever the engine
  // actually sent. An engine that omits the field used to take `Object.keys`
  // straight into a TypeError, which escaped `connect()` as an unhandled
  // throw and lost the degraded state this function exists to produce.
  if (reported === null || reported === undefined || typeof reported !== 'object') return true
  return Object.keys(reported).length === 0
}
