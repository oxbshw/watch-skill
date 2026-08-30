#!/usr/bin/env node
/**
 * The first-party dependency graph must be acyclic.
 *
 * pnpm tolerates a cyclic workspace dependency. It prints
 *
 *     WARN  There are cyclic workspace dependencies: …/library, …/tools
 *
 * and installs anyway, which means the fact survives in an install log and
 * nowhere else. What it costs shows up much later and somewhere else: a build
 * that depends on an artifact generated from a package's own dependent, and so
 * passes on any machine that has built before and fails on every cold clone.
 *
 * That is not a hypothetical here. The Library's browser half mounted the
 * Typert Remote generated from `@deepwatch/dsh-tools`, which reads the
 * Library's index — so each package needed the other, and the first compilation
 * on a clean checkout stopped at
 *
 *     TS2307: Cannot find module '@deepwatch/dsh-tools/remote'
 *
 * The fix was a composition boundary, `@deepwatch/dsh-client-remotes`. This
 * gate is what keeps the boundary from being quietly deleted: it re-derives the
 * same graph pnpm resolves, and the project graph `tsc -b` resolves, and refuses
 * a cycle in either.
 *
 * Usage:
 *   node scripts/verify-package-graph.mjs
 *   node scripts/verify-package-graph.mjs --json
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findCycle, packageGraph, projectGraph } from './lib/package-graph.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')

/** Render one cycle the way somebody has to read it: as a round trip. */
function describe(cycle, labels) {
  return cycle
    .map((node, at) => {
      if (at === cycle.length - 1) return node
      const via = labels?.get(node)?.get(cycle[at + 1])
      return via === undefined || via === 'dependencies' ? node : `${node} (${via})`
    })
    .join('\n         -> ')
}

function main() {
  const problems = []

  const packages = packageGraph(ROOT)
  const packageCycle = findCycle(new Map(
    [...packages].map(([name, edges]) => [name, [...edges.keys()]]),
  ))
  if (packageCycle !== null) {
    problems.push({
      message: `the first-party package graph has a cycle:\n         ${describe(packageCycle, packages)}`,
      fix: 'A package that owns a capability must not also depend on the package '
        + 'that consumes it. Move the consuming edge to a composition package — '
        + '@deepwatch/dsh-client-remotes is the one that already exists for this.',
    })
  }

  const projects = projectGraph(ROOT)
  const projectCycle = findCycle(projects)
  if (projectCycle !== null) {
    problems.push({
      message: `the TypeScript project graph has a cycle:\n         ${describe(projectCycle)}`,
      fix: 'Remove the back reference, or split the referenced package into the '
        + 'face the referrer actually needs.',
    })
  }

  const edgeCount = [...packages.values()].reduce((total, edges) => total + edges.size, 0)

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({
      ok: problems.length === 0,
      packages: packages.size,
      edges: edgeCount,
      projects: projects.size,
      problems,
    }, null, 2)}\n`)
    process.exit(problems.length === 0 ? 0 : 1)
  }

  for (const problem of problems) {
    process.stderr.write(` FAIL  ${problem.message}\n        ${problem.fix}\n`)
  }
  if (problems.length > 0) {
    process.stderr.write(`\nwatch: ${String(problems.length)} graph problem(s)\n`)
    process.exit(1)
  }

  process.stdout.write(
    `package graph: ${String(packages.size)} first-party package(s), `
    + `${String(edgeCount)} workspace edge(s), no cycle\n`
    + `project graph: ${String(projects.size)} TypeScript project(s), no cycle\n`,
  )
}

main()
