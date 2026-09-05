/**
 * Just enough semantic versioning to decide whether one exact version
 * satisfies one declared range — and a refusal for everything else.
 *
 * This exists because the managed-runtime manifest is a *gate*. It has to
 * answer "does 18.3.1 satisfy `^18.2.0` and `^16.8.0 || ^17.0.0 || ^18.0.0 ||
 * ^19.0.0` at the same time?" and fail the build when the answer is no. The
 * npm `semver` package answers that properly and is not a dependency of this
 * workspace; adding one so a generator can compare two numbers is a poor
 * trade, and vendoring a partial copy that silently guesses is a worse one.
 *
 * So this is deliberately small and deliberately loud. It understands the
 * range shapes the audited closure actually contains — `^`, `~`, an exact
 * version, the `>=`/`>`/`<=`/`<`/`=` comparators, a space-separated
 * conjunction, and `||` alternation — and it throws {@link UnsupportedRange}
 * on anything else rather than returning `false`. A gate that reports "does
 * not satisfy" when it means "I could not read that" sends somebody looking
 * for a version conflict that is not there.
 *
 * Prereleases follow npm's rule, because the whole DSH baseline is one:
 * `0.1.1-rc.2` satisfies `^0.1.1-rc.2` and does **not** satisfy `^0.1.0`. A
 * prerelease is only ever admitted by a comparator that named a prerelease on
 * the same `major.minor.patch`, which is what stops an `rc` leaking into a
 * range whose author never considered one.
 *
 * @module scripts/lib/semver-lite
 */

/** A range this module will not guess at. */
export class UnsupportedRange extends Error {
  /**
   * @param {string} range - the range as it was declared.
   */
  constructor(range) {
    super(`semver-lite does not understand the range ${JSON.stringify(range)}`)
    this.name = 'UnsupportedRange'
    /** @type {string} */
    this.range = range
  }
}

/**
 * A version, split into the parts a comparison needs.
 *
 * @typedef {object} Version
 * @property {number} major - the first field.
 * @property {number} minor - the second field.
 * @property {number} patch - the third field.
 * @property {(string | number)[]} pre - the prerelease identifiers, if any.
 */

/**
 * One comparator: an operator and the version it is about.
 *
 * @typedef {object} Comparator
 * @property {string} operator - one of `>=`, `>`, `<=`, `<`, `=`.
 * @property {Version} version - the version it compares against.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

const PARTIAL = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Read an exact version.
 *
 * @param {string} text - e.g. `0.1.1-rc.2`.
 * @returns {Version} the parsed version.
 * @throws {UnsupportedRange} when it is not an exact version.
 */
export function parseVersion(text) {
  const match = VERSION.exec(text.trim())
  if (match === null) throw new UnsupportedRange(text)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined
      ? []
      : match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part)),
  }
}

/**
 * Order two versions the way the specification does.
 *
 * Numeric fields first, then prerelease: a version *with* a prerelease sorts
 * below the same version without one, and prerelease identifiers compare
 * numerically where both are numeric and by code unit otherwise.
 *
 * @param {Version} a - the left version.
 * @param {Version} b - the right version.
 * @returns {number} negative, zero or positive.
 */
export function compare(a, b) {
  for (const field of ['major', 'minor', 'patch']) {
    const left = /** @type {number} */ (a[/** @type {'major'} */ (field)])
    const right = /** @type {number} */ (b[/** @type {'major'} */ (field)])
    if (left !== right) return left < right ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const width = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < width; index += 1) {
    const left = a.pre[index]
    const right = b.pre[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return String(left) < String(right) ? -1 : 1
  }
  return 0
}

/**
 * Expand a possibly partial version such as `18` or `1.2`.
 *
 * @param {string} text - the possibly partial version.
 * @returns {{ version: Version, given: number }} the version, and how many
 * numeric fields were actually written.
 */
function parsePartial(text) {
  const match = PARTIAL.exec(text.trim().replace(/^v/, ''))
  if (match === null) throw new UnsupportedRange(text)
  const given = match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1
  const pre = match[4] === undefined ? '' : `-${match[4]}`
  return {
    version: parseVersion(`${match[1]}.${match[2] ?? '0'}.${match[3] ?? '0'}${pre}`),
    given,
  }
}

/**
 * Where a caret or tilde range stops.
 *
 * The upper bound carries a `0` prerelease so that a prerelease of the next
 * version — `2.0.0-rc.1` for `^1.2.3` — is excluded, which is what npm does
 * and what keeps an `rc` from being treated as the release before it.
 *
 * @param {Version} version - the version the range was written around.
 * @param {number} given - how many numeric fields the author wrote.
 * @param {'caret' | 'tilde'} kind - which operator was used.
 * @returns {Version} the exclusive upper bound.
 */
function upperBound(version, given, kind) {
  const zero = /** @type {(string | number)[]} */ ([0])
  if (kind === 'caret') {
    // `^1.2.3` → `<2.0.0`; `^0.1.2` → `<0.2.0`; `^0.0.3` → `<0.0.4`. The 0.x
    // rule, where the leftmost non-zero field is the one that may not move.
    if (version.major !== 0 || given === 1) {
      return { major: version.major + 1, minor: 0, patch: 0, pre: zero }
    }
    if (version.minor !== 0 || given === 2) {
      return { major: 0, minor: version.minor + 1, patch: 0, pre: zero }
    }
    return { major: 0, minor: 0, patch: version.patch + 1, pre: zero }
  }
  // `~1.2.3` → `<1.3.0`; `~1` → `<2.0.0`.
  return given === 1
    ? { major: version.major + 1, minor: 0, patch: 0, pre: zero }
    : { major: version.major, minor: version.minor + 1, patch: 0, pre: zero }
}

/**
 * Split one conjunction into comparators.
 *
 * @param {string} text - e.g. `>=1.2.0 <2.0.0`, `^18.2.0`, `4.0.1`.
 * @returns {Comparator[]} the comparators it stands for; empty means "any".
 * @throws {UnsupportedRange} for a shape this will not guess at.
 */
function comparators(text) {
  /** @type {Comparator[]} */
  const out = []
  // `>= 1.2` — a space after the operator is legal, and appears in the closure.
  const tokens = text.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/)
  for (const token of tokens) {
    if (token === '') continue
    if (token === '*' || token === 'x' || token === 'X') return []
    const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)
    if (match === null) throw new UnsupportedRange(text)
    const operator = match[1] ?? '='
    const { version, given } = parsePartial(/** @type {string} */ (match[2]))
    if (operator === '^' || operator === '~') {
      out.push({ operator: '>=', version })
      out.push({ operator: '<', version: upperBound(version, given, operator === '^' ? 'caret' : 'tilde') })
      continue
    }
    if (operator === '=' && given < 3) {
      // `18` means `>=18.0.0 <19.0.0`, and `1.2` means `>=1.2.0 <1.3.0`.
      out.push({ operator: '>=', version })
      out.push({ operator: '<', version: upperBound(version, given, 'tilde') })
      continue
    }
    out.push({ operator, version })
  }
  return out
}

/**
 * Whether one version satisfies one conjunction of comparators.
 *
 * @param {Version} version - the exact version under test.
 * @param {Comparator[]} set - the conjunction.
 * @returns {boolean} true when every comparator is satisfied.
 */
function satisfiesAll(version, set) {
  for (const comparator of set) {
    const order = compare(version, comparator.version)
    const ok = comparator.operator === '>=' ? order >= 0
      : comparator.operator === '>' ? order > 0
        : comparator.operator === '<=' ? order <= 0
          : comparator.operator === '<' ? order < 0
            : order === 0
    if (!ok) return false
  }
  if (version.pre.length === 0) return true
  // npm's prerelease rule: a prerelease is only admitted by a range that named
  // a prerelease on the same numeric tuple. Without this, `^0.1.0` would admit
  // `0.2.0-rc.1`, and every `-rc` baseline in this closure would compare wrong.
  return set.some(comparator =>
    comparator.version.pre.length > 0
    && comparator.version.major === version.major
    && comparator.version.minor === version.minor
    && comparator.version.patch === version.patch)
}

/**
 * Whether an exact version satisfies a declared range.
 *
 * @param {string} version - an exact version, e.g. `18.3.1`.
 * @param {string} range - a declared range, e.g. `^18.2.0`.
 * @returns {boolean} true when it does.
 * @throws {UnsupportedRange} when the range is a shape this will not guess at.
 */
export function satisfies(version, range) {
  const subject = parseVersion(version)
  for (const alternative of range.split('||')) {
    const set = comparators(alternative)
    if (set.length === 0) return true
    if (satisfiesAll(subject, set)) return true
  }
  return false
}

/**
 * The highest of a set of versions.
 *
 * @param {readonly string[]} versions - exact versions.
 * @returns {string | null} the highest, or null when the set is empty.
 */
export function highest(versions) {
  let best = null
  for (const candidate of versions) {
    if (best === null || compare(parseVersion(candidate), parseVersion(best)) > 0) best = candidate
  }
  return best
}
