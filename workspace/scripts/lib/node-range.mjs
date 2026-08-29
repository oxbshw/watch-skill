/**
 * Reading a `package.json` Node range without taking a semver dependency.
 *
 * The doctor is the first thing a new machine runs, before `pnpm install` has
 * put anything in `node_modules`, so it cannot import a range parser. It only
 * has to understand the two clause shapes this workspace actually declares --
 * a caret and a `>=` major -- and it should be honest about the ones it does
 * not understand rather than guessing.
 */

/** `^22.19.0 || >=24.0.0` against the running Node. */
export function nodeSatisfies(declared, actual) {
  const [major, minor, patch] = actual.replace(/^v/, '').split('.').map(Number)
  for (const clause of declared.split('||').map(part => part.trim())) {
    const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(clause)
    if (caret !== null) {
      const [, cMajor, cMinor, cPatch] = caret.map(Number)
      if (major !== cMajor) continue
      if (minor > cMinor) return true
      if (minor === cMinor && patch >= cPatch) return true
      continue
    }
    const atLeast = /^>=(\d+)/.exec(clause)
    if (atLeast !== null && major >= Number(atLeast[1])) return true
  }
  return false
}

/**
 * True when the running Node shares a major with a caret clause but sits below
 * it -- `22.18.0` against `^22.19.0`.
 *
 * That case is worth separating from a plain miss. The declared range is the
 * range CI installs and tests, not the range below which the code stops
 * working: a machine on `22.18.0` runs the full suite, both apps and every
 * capture. Reporting it as a hard failure tells a new contributor their
 * toolchain is unusable when it is merely untested, and sends them to install
 * a Node they do not need. A different or older major is a real failure --
 * that is where the APIs this workspace relies on stop being present, so it
 * stays a failure and this returns false for it.
 */
export function nodeBelowTestedFloorOnly(declared, actual) {
  const [major, minor, patch] = actual.replace(/^v/, '').split('.').map(Number)
  for (const clause of declared.split('||').map(part => part.trim())) {
    const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(clause)
    if (caret === null) continue
    const [, cMajor, cMinor, cPatch] = caret.map(Number)
    if (major !== cMajor) continue
    if (minor < cMinor || (minor === cMinor && patch < cPatch)) return true
  }
  return false
}
