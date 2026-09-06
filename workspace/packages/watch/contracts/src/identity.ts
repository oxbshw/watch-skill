/**
 * Content identity, as Watch Core defines it.
 *
 * This is a mirror, not a second algorithm. `src/watch_skill/identity.py` is
 * the source of truth, and it exists because of a specific defect: a video's id
 * used to be `sha256(source_string)`, so overwriting `demo.mp4` returned
 * yesterday's frames, OCR and cached answers for today's file with nothing in
 * the reply admitting it. Core's answer was to stop treating the string as the
 * identity and to name four things separately — the alias the user typed, the
 * logical asset, the immutable revision keyed by content digest, and the cheap
 * fingerprint that decides whether the digest has to be recomputed.
 *
 * The Workspace needs the same identity for the same reason. A Library record
 * read from a file that carries no id of its own was briefly identified by a
 * digest of its *path*, which fixed a disclosure problem and reintroduced the
 * original one: move the bytes and they became a different record; overwrite
 * them and they stayed the same one.
 *
 * So the functions below reproduce Core's exactly, including the material
 * strings that go into each hash, and `tests/content-identity.test.mjs` runs
 * the Python and asserts the two agree. A change to either side that is not
 * made to both fails that test rather than silently splitting the namespace.
 *
 * Browser-safe: hashing goes through the Web Crypto API where the caller has
 * bytes, and every id here is derived from a digest the caller already holds.
 *
 * @module @deepwatch/dsh-contracts/identity
 */

/** The one digest algorithm this contract uses. Mirrors `DIGEST_ALGORITHM`. */
export const DIGEST_ALGORITHM = 'sha256'

/** Hex characters in a short id. Sixteen, as every Core id already is. */
const SHORT_LENGTH = 16

/** Lowercase hex of a sha-256 digest, and nothing else. */
const DIGEST = /^[0-9a-f]{64}$/

/** Whether a value is a content digest this contract will carry. */
export function isContentDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value)
}

/**
 * `sha256(material)` truncated to sixteen hex characters, with a prefix.
 *
 * `identity._short`. The truncation is Core's and is kept: every id ever
 * printed, cached, or written into an agent's notes is this width, and
 * widening it here would split the namespace in the other direction.
 */
function short(prefix: string, material: string, digest: (value: string) => string): string {
  return prefix + digest(material).slice(0, SHORT_LENGTH)
}

/**
 * The id for one immutable version of some content.
 *
 * `identity.revision_id_for`. The material is `"<algorithm>:<digest>"`, so the
 * algorithm is inside the hash and a future digest change cannot collide with
 * this one.
 */
export function revisionIdFor(
  contentDigest: string, digest: (value: string) => string,
): string {
  return short('rev_', `${DIGEST_ALGORITHM}:${contentDigest}`, digest)
}

/**
 * The canonical id for the content itself.
 *
 * `identity.video_id_for_digest`. Named for content rather than for video
 * here because the Library indexes documents, pages and captures through the
 * same function; the material string is Core's, unchanged, so the two produce
 * the same id for the same bytes.
 *
 * Sixteen hex characters with no prefix, which is both what Core hands out and
 * an identifier `@deepwatch/dsh-contracts/query` will accept — so an id
 * derived here can be sent straight back through a read that validates it.
 */
export function contentIdFor(
  contentDigest: string, digest: (value: string) => string,
): string {
  return digest(`watch-skill/v2/${contentDigest}`).slice(0, SHORT_LENGTH)
}
