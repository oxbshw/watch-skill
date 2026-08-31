/**
 * The pnpm catalog, read once, so a `catalog:` protocol reads as a version.
 *
 * `catalog:` is how this workspace states the DSH baseline in one place. It
 * means something to pnpm at pack time and nothing to anybody else — not to a
 * person reading a package page, and not to the generator that has to decide
 * which exact version of `@deepseek-ai/dsh-client-ui-primitives` the managed
 * runtime must contain.
 *
 * Parsed by hand because the catalog is a flat block of `"name": version` and
 * adding a YAML dependency to read eighteen lines would be a poor trade. It
 * lives here rather than in the one script that first needed it because there
 * are now two callers, and two hand-written parsers of the same block is the
 * kind of drift this workspace has already paid for once.
 *
 * @module scripts/lib/catalog
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The catalog entries, by package name.
 *
 * @param {string} [root] - the workspace root to read from.
 * @returns {Map<string, string>} package name to the exact version it pins.
 */
export function catalog(root = ROOT) {
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const start = text.indexOf('\ncatalog:')
  if (start < 0) return new Map()
  const entries = new Map()
  for (const line of text.slice(start + 1).split('\n').slice(1)) {
    if (!/^\s/.test(line)) break
    const match = /^\s+"?([^":]+)"?:\s*(\S+)/.exec(line)
    if (match !== null) entries.set(match[1], match[2])
  }
  return entries
}

/**
 * A declared range as anything outside pnpm can act on it.
 *
 * @param {Map<string, string>} entries - the catalog.
 * @param {string} name - the package the range is about.
 * @param {string} declared - the range as the manifest writes it.
 * @returns {string} the resolved range, or the declared one when it is already
 * a range.
 */
export function resolveRange(entries, name, declared) {
  return declared.startsWith('catalog:') ? (entries.get(name) ?? declared) : declared
}
