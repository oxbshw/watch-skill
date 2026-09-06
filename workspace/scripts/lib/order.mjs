/**
 * One ordering for every generated artifact, and it is not the locale's.
 *
 * `String.prototype.localeCompare` sorts the way the machine's collation says
 * to, and collation treats punctuation as noise: `.`, `-`, `@` and `/` are
 * weighted differently — sometimes ignored entirely — depending on the ICU
 * data a runtime was built with. Two machines with the same files then produce
 * the same entries in a different order.
 *
 * That is not hypothetical. `inventory/dsh-slots.json` was byte-stable on
 * Windows and byte-different on Linux and macOS with an identical slot set,
 * because `conversation.composer.bar` and `conversation.composer.dock` collate
 * differently either side of the dot. The gate could only say "stale", and a
 * per-entry diff showed nothing, because nothing had changed except the order.
 *
 * Code-unit comparison has no locale, no options and no ICU dependency. It is
 * the wrong choice for anything a person reads as a sorted list in their own
 * language, and the right one for a file whose whole purpose is to be
 * identical on every machine.
 *
 * @module scripts/lib/order
 */

/**
 * Compare two strings by UTF-16 code unit.
 *
 * @param {string} a - the first string.
 * @param {string} b - the second string.
 * @returns {number} negative, zero or positive, the way a comparator wants.
 */
export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compare two objects by one string field, by code unit.
 *
 * @param {string} field - the property to order on.
 * @returns {(a: Record<string, unknown>, b: Record<string, unknown>) => number}
 */
export function byField(field) {
  return (a, b) => byCodeUnit(String(a[field]), String(b[field]))
}
