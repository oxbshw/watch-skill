#!/usr/bin/env node
/**
 * The order the twenty packages must be published in.
 *
 * npm resolves a dependency at install time, not at publish time, so a
 * registry will happily accept `@deepwatch/cli@0.1.0` naming a
 * `@deepwatch/dsh-bundle@0.1.0` that does not exist yet. The version number is
 * then spent: it cannot be republished, and every install of it fails until
 * the missing package appears. Publishing in dependency order is what makes
 * each version resolvable the moment it is public.
 *
 * Derived from the manifests rather than written down, because a hand-kept
 * list is one refactor away from being wrong in exactly the way nobody
 * notices until a release is half done.
 *
 * Usage:
 *   node scripts/publish-order.mjs           one package name per line
 *   node scripts/publish-order.mjs --json    the same, with versions
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every publishable package, by name. */
function publishable() {
  const found = new Map()
  for (const parent of ['packages/watch', 'apps']) {
    const at = join(ROOT, parent)
    if (!existsSync(at)) continue
    for (const name of readdirSync(at)) {
      const path = join(at, name, 'package.json')
      if (!existsSync(path)) continue
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (manifest.private === true) continue
      found.set(manifest.name, { dir: `${parent}/${name}`, manifest })
    }
  }
  return found
}

/**
 * Dependencies first, then dependents, and alphabetical within a tier.
 *
 * Alphabetical rather than whatever the filesystem returned, so two runs of a
 * release produce the same order and a partially completed one can be resumed
 * by reading this list.
 */
export function publishOrder() {
  const packages = publishable()
  const order = []
  const placed = new Set()
  const visiting = new Set()

  const visit = name => {
    if (placed.has(name)) return
    if (visiting.has(name)) throw new Error(`dependency cycle at ${name}`)
    visiting.add(name)
    const entry = packages.get(name)
    const deps = Object.keys(entry.manifest.dependencies ?? {})
      .filter(dep => packages.has(dep))
      .sort()
    for (const dep of deps) visit(dep)
    visiting.delete(name)
    placed.add(name)
    order.push(name)
  }

  for (const name of [...packages.keys()].sort()) visit(name)
  return order.map(name => ({
    name,
    version: packages.get(name).manifest.version,
    dir: packages.get(name).dir,
  }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const order = publishOrder()
  process.stdout.write(process.argv.includes('--json')
    ? `${JSON.stringify(order, null, 2)}\n`
    : `${order.map(entry => entry.name).join('\n')}\n`)
}
