/**
 * The doctor's verdict on the pnpm a machine will actually run.
 *
 * `package.json` pins an exact pnpm through `packageManager`, and the
 * bootstrap runs that exact version through Corepack. Anything a person types
 * by hand does not: `pnpm install` uses whatever is on PATH.
 *
 * The doctor used to compare only the major and report a mismatch as a
 * warning. Both halves were too weak. A different major is not a note --
 * pnpm 11 writes `allowBuilds` into `pnpm-workspace.yaml`, so a command that
 * is supposed to change nothing leaves a tracked file modified and the release
 * gate fails on a dirty tree. And comparing majors alone called 10.0.0 an
 * exact match for a pinned 10.29.1, which is the one thing the pin exists to
 * prevent.
 *
 * @module scripts/lib/package-manager
 */

/** The exact version a `packageManager` spec pins, or '' when it pins none. */
export function pinnedPnpmVersion(spec) {
  if (typeof spec !== 'string') return ''
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(spec.trim())
  return match === null ? '' : match[1]
}

/**
 * Grade the pnpm on PATH against the pinned one.
 *
 * Returns a finding level and the sentence that goes with it:
 *
 *   - `fail`    a different major. It will modify tracked files.
 *   - `warn`    the pinned major, a different exact version. It works, but it
 *               is not what CI resolved the lockfile with.
 *   - `ok`      exactly the pinned version, or nothing is pinned to check.
 */
export function classifyPnpm(pinnedSpec, actual) {
  const want = pinnedPnpmVersion(pinnedSpec)
  if (want === '' || typeof actual !== 'string' || actual === '') {
    return { level: 'ok', detail: actual, fix: '' }
  }
  if (actual === want) return { level: 'ok', detail: actual, fix: '' }

  const fix = `corepack pnpm@${want} install --frozen-lockfile, or corepack enable`
  if (actual.split('.')[0] !== want.split('.')[0]) {
    return {
      level: 'fail',
      detail: `${actual}, and packageManager pins ${want}`,
      fix: `A different pnpm major rewrites pnpm-workspace.yaml. Run ${fix}`,
    }
  }
  return {
    level: 'warn',
    detail: `${actual}, and packageManager pins ${want}`,
    fix: `Not the pinned version. Run ${fix}`,
  }
}
