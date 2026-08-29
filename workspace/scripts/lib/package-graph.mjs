/**
 * The first-party dependency graph, and whether it has a cycle in it.
 *
 * Two graphs are read here, because a cycle can be introduced in either and
 * only one of them is noticed by anything else.
 *
 * The **package graph** is what pnpm resolves: every `workspace:` edge a Watch
 * manifest declares, in dependencies, devDependencies, peerDependencies and
 * optionalDependencies alike. pnpm reports a cycle in it as a `WARN`, which is
 * a line in an install log nobody reads twice, and then installs anyway.
 *
 * The **project graph** is what `tsc -b` resolves: the `references` list in
 * each package's tsconfig. TypeScript refuses a circular project reference
 * outright, so a cycle here is loud — but it is a *different* cycle, and the
 * two can disagree. A package may depend on another for its types alone and
 * reference it in neither direction, or reference a face config that the
 * manifest never mentions.
 *
 * The cycle this exists to prevent was real and cost a red pipeline:
 * `@watchskill/dsh-tools` reads the Library's index, so tools depends on
 * `@watchskill/dsh-library`; the Library's browser half then mounted the Typert
 * Remote generated *from* tools, so the Library depended on tools in return. It
 * installed. It even compiled, on a machine where the generated file already
 * existed. On a cold clone the first `tsc` stopped with TS2307, because no
 * build order can put a package before a file generated from its own dependent.
 *
 * @module scripts/lib/package-graph
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** Manifest fields that create a resolution edge between two workspace packages. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

/** Directories holding first-party packages, relative to the workspace root. */
const PACKAGE_ROOTS = [join('packages', 'watch'), 'apps']

const slash = value => value.replaceAll('\\', '/')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/**
 * Every first-party package, keyed by its package name.
 *
 * Discovered from the directories `pnpm-workspace.yaml` globs rather than from
 * a hand-kept list, so a package added tomorrow is in the graph without anybody
 * remembering this file exists.
 */
export function firstPartyPackages(root) {
  const found = new Map()
  for (const packageRoot of PACKAGE_ROOTS) {
    const dir = join(root, packageRoot)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).sort()) {
      const manifestPath = join(dir, entry, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = readJson(manifestPath)
      found.set(manifest.name, {
        name: manifest.name,
        dir: join(dir, entry),
        relative: slash(join(packageRoot, entry)),
        manifest,
      })
    }
  }
  return found
}

/**
 * The package graph: name → the first-party names it declares an edge to.
 *
 * Only edges between packages in this workspace matter. A dependency on an
 * upstream package cannot close a cycle here, and including them would bury the
 * answer under four hundred rows.
 */
export function packageGraph(root) {
  const packages = firstPartyPackages(root)
  const graph = new Map()
  for (const [name, entry] of packages) {
    const edges = new Map()
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(entry.manifest[field] ?? {})) {
        if (!packages.has(dependency) || dependency === name) continue
        // The first field that declares an edge is the one reported: a cycle
        // through `dependencies` and one through `devDependencies` are the same
        // cycle, and naming both makes the message longer, not clearer.
        if (!edges.has(dependency)) edges.set(dependency, field)
      }
    }
    graph.set(name, edges)
  }
  return graph
}

/**
 * The project graph: tsconfig path → the tsconfig paths it references.
 *
 * Keyed by workspace-relative config path rather than by package, because a
 * dual-face package has two configs and the whole point of separating them is
 * that they are different nodes.
 */
export function projectGraph(root) {
  const graph = new Map()
  const visit = configPath => {
    const key = slash(relative(root, configPath))
    if (graph.has(key)) return
    if (!existsSync(configPath)) {
      graph.set(key, [])
      return
    }
    const config = readJson(configPath)
    const references = (config.references ?? []).map(reference => {
      const target = resolve(dirname(configPath), reference.path)
      return target.endsWith('.json') ? target : join(target, 'tsconfig.json')
    })
    graph.set(key, references.map(target => slash(relative(root, target))))
    for (const target of references) visit(target)
  }

  visit(join(root, 'tsconfig.json'))
  visit(join(root, 'tsconfig.host.json'))
  return graph
}

/**
 * The first cycle in a graph, as the path that closes it, or null.
 *
 * A depth-first walk with three colours. Reporting one cycle rather than all of
 * them is deliberate: cycles overlap, an exhaustive list of a strongly
 * connected component reads as noise, and the fix for the first one usually
 * removes the rest.
 *
 * @param edges - node → iterable of the nodes it points at.
 * @returns the cycle as `[a, b, …, a]`, or null when the graph is acyclic.
 */
export function findCycle(edges) {
  const state = new Map()
  const stack = []

  const walk = node => {
    state.set(node, 'open')
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      const target = Array.isArray(next) ? next[0] : next
      if (!edges.has(target)) continue
      const colour = state.get(target)
      if (colour === 'open') {
        // The cycle is the tail of the stack from where the target sits, closed
        // by the target again so a reader can follow it round.
        return [...stack.slice(stack.indexOf(target)), target]
      }
      if (colour === undefined) {
        const cycle = walk(target)
        if (cycle !== null) return cycle
      }
    }
    stack.pop()
    state.set(node, 'closed')
    return null
  }

  for (const node of edges.keys()) {
    if (state.get(node) !== undefined) continue
    const cycle = walk(node)
    if (cycle !== null) return cycle
  }
  return null
}
