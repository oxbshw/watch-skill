/**
 * The first-party dependency graph, and the detector that keeps it acyclic.
 *
 * Two separate claims live here, and only one of them is about this repository.
 *
 * The first is that the graph is acyclic *now*. That is what
 * `scripts/verify-package-graph.mjs` reports, and the reason it exists is a
 * cycle that shipped: `@deepwatch/dsh-tools` reads the Library's index, and
 * the Library's browser half mounted the Typert Remote generated from tools.
 * pnpm printed a WARN and installed. `tsc` succeeded on every machine that had
 * built before, and failed on every cold clone with TS2307 — because no build
 * order can put a package before a file generated from its own dependent.
 *
 * The second is that the detector detects. A gate that reports "no cycle" on a
 * graph it cannot see through is worse than no gate, so the cycle finder is
 * exercised against graphs whose answers are known, including the exact shape
 * of the regression above.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findCycle, packageGraph, projectGraph } from '../scripts/lib/package-graph.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('the cycle finder', () => {
  test('an acyclic graph has no cycle', () => {
    assert.equal(findCycle(new Map([
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', []],
    ])), null)
  })

  test('a two-node cycle is found and reported as a round trip', () => {
    // The shape that shipped: library -> tools -> library.
    const cycle = findCycle(new Map([
      ['library', ['tools']],
      ['tools', ['library']],
    ]))
    assert.deepEqual(cycle, ['library', 'tools', 'library'])
  })

  test('a cycle behind an acyclic prefix is still found', () => {
    // The walk must not stop at the first node that looks settled: `root` is
    // fine, and everything it reaches is not.
    const cycle = findCycle(new Map([
      ['root', ['a']],
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]))
    assert.deepEqual(cycle, ['a', 'b', 'c', 'a'])
  })

  test('a node reached twice by different paths is not a cycle', () => {
    // A diamond closes no loop, and an implementation that colours nodes with
    // "seen" rather than "on the current stack" reports one here.
    assert.equal(findCycle(new Map([
      ['a', ['b', 'c']],
      ['b', ['d']],
      ['c', ['d']],
      ['d', []],
    ])), null)
  })

  test('a self-edge is a cycle', () => {
    assert.deepEqual(findCycle(new Map([['a', ['a']]])), ['a', 'a'])
  })

  test('an edge leaving the graph is ignored', () => {
    // Only first-party edges can close a first-party cycle; an upstream
    // dependency is a node this graph does not contain.
    assert.equal(findCycle(new Map([['a', ['b', '@deepseek-ai/cordis']], ['b', []]])), null)
  })
})

describe('this workspace', () => {
  test('the package graph is acyclic', () => {
    const packages = packageGraph(ROOT)
    assert.ok(packages.size >= 15, 'the graph is suspiciously small; discovery is broken')
    const cycle = findCycle(new Map(
      [...packages].map(([name, edges]) => [name, [...edges.keys()]]),
    ))
    assert.equal(cycle, null,
      cycle === null ? '' : `cyclic workspace dependency: ${cycle.join(' -> ')}`)
  })

  test('the TypeScript project graph is acyclic', () => {
    const projects = projectGraph(ROOT)
    assert.ok(projects.size >= 15, 'the project graph is suspiciously small')
    const cycle = findCycle(projects)
    assert.equal(cycle, null,
      cycle === null ? '' : `circular project reference: ${cycle.join(' -> ')}`)
  })

  test('the Library owns its capability and not the transport for it', () => {
    // The specific edge, named rather than left to the general rule. The
    // general rule catches the cycle; this says which direction was wrong, so
    // somebody re-adding the dependency reads the reason and not just a cycle.
    const packages = packageGraph(ROOT)
    assert.equal(packages.get('@deepwatch/dsh-library')?.has('@deepwatch/dsh-tools'), false,
      'the Library must not depend on the Host that reads it; the Remote is '
      + 'mounted by @deepwatch/dsh-client-remotes')
    assert.equal(packages.get('@deepwatch/dsh-tools')?.has('@deepwatch/dsh-library'), true,
      'the Host does read the Library index, and that edge is the correct one')
    assert.equal(
      packages.get('@deepwatch/dsh-client-remotes')?.has('@deepwatch/dsh-tools'), true,
      'the composition package is what may depend on the generated Remote')
  })

  test('the gate itself refuses a cycle rather than merely describing one', () => {
    // Running it is the only way to know the exit code is wired to the answer.
    const report = JSON.parse(execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'verify-package-graph.mjs'), '--json'],
      { cwd: ROOT, encoding: 'utf8' },
    ))
    assert.equal(report.ok, true)
    assert.deepEqual(report.problems, [])
    assert.ok(report.edges > 0, 'a graph with no edges cannot have a cycle, and proves nothing')
  })
})
