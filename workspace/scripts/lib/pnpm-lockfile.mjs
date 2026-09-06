/**
 * Read the dependency set out of `pnpm-lock.yaml`.
 *
 * The SBOM used to enumerate `node_modules/.pnpm`, on the reasoning that what
 * is on disk is what actually ships. That reasoning fails for one class of
 * package. Optional native binaries are installed only for the host: a Windows
 * machine materialises `lightningcss-win32-x64-msvc` and none of its eight
 * siblings, a Linux machine materialises the linux ones and not the Windows
 * one. Fifty packages in this lockfile carry an `os` constraint, so the SBOM
 * generated on Windows and the SBOM generated on Linux each deleted about
 * forty of the other's entries, and whichever machine ran the gate last
 * rewrote a committed file. A bill of materials that changes with the machine
 * that printed it is not a bill of materials.
 *
 * The lockfile names every platform variant on every machine, which is what
 * makes it the reproducible source. It is parsed here rather than with a YAML
 * dependency because the shape being read is two levels deep and adding a
 * dependency to change how dependencies are recorded is its own small joke.
 * The parser is deliberately strict: it refuses a lockfile version it was not
 * written against instead of quietly returning a short list.
 *
 * @module scripts/lib/pnpm-lockfile
 */

/** The lockfile format this parser was written against. */
export const SUPPORTED_LOCKFILE_VERSION = '9.0'

/** Split `@scope/name@1.2.3` into its name and version. */
export function splitSpec(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return null
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

/**
 * Every package the lockfile records, with any platform constraints.
 *
 * Order follows the lockfile, which pnpm writes sorted, so the result is
 * stable without sorting it again.
 */
export function parseLockfilePackages(text) {
  const version = /^lockfileVersion:\s*'?([\d.]+)'?\s*$/m.exec(text)?.[1]
  if (version !== SUPPORTED_LOCKFILE_VERSION) {
    throw new Error(
      `pnpm-lock.yaml is lockfileVersion ${String(version)}, and this reader `
      + `understands ${SUPPORTED_LOCKFILE_VERSION}. Update scripts/lib/pnpm-lockfile.mjs `
      + 'rather than letting the SBOM silently shorten.',
    )
  }

  const packages = []
  let inSection = false
  let current = null

  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) { inSection = true; continue }
    if (!inSection) continue
    // Any other top-level key ends the section: `snapshots:` follows it.
    if (/^\S/.test(line)) break

    const key = /^ {2}('?)(\S.*?)\1:\s*$/.exec(line)
    if (key !== null) {
      const split = splitSpec(key[2])
      current = split === null ? null : { ...split, os: [], cpu: [] }
      if (current !== null) packages.push(current)
      continue
    }
    if (current === null) continue

    const constraint = /^ {4}(os|cpu):\s*\[(.*)\]\s*$/.exec(line)
    if (constraint !== null) {
      current[constraint[1]] = constraint[2].split(',').map(entry => entry.trim()).filter(Boolean)
    }
  }
  return packages
}

/**
 * The family a platform-specific binary belongs to, or null.
 *
 * `lightningcss-win32-x64-msvc` and `lightningcss-linux-x64-gnu` are the same
 * package built twice, so they carry the same licence. Only one of them is
 * ever on disk, and the SBOM has to state a licence for both.
 */
export function platformFamily(name) {
  const match = /^(.*?)-(darwin|linux|win32|android|freebsd|openharmony)(-.*)?$/.exec(name)
  return match === null ? null : match[1]
}
