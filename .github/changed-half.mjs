#!/usr/bin/env node
/**
 * Which half of the monorepo a change touches.
 *
 * Both products live here, and their gates cost very different amounts: the
 * Core matrix is six runners with model downloads, the Workspace matrix is
 * three operating systems with an Electron smoke. Running both for every
 * change wastes twenty minutes on a Workspace typo, and running neither is
 * how a required check never reports.
 *
 * Workflow-level `paths:` filters cannot decide this. A workflow that does not
 * trigger produces no status at all, so a branch protected on a check inside
 * it waits forever -- the check is not failing, it is absent, and GitHub has
 * nothing to report. So both workflows trigger on everything and decide
 * *inside* themselves what to run, which is what lets the aggregator status be
 * present on every pull request while the expensive jobs stay skipped.
 *
 * The classification is here rather than in YAML because it has real edges,
 * and an edge encoded in a shell one-liner inside a workflow is one nobody can
 * test. The sharpest is documentation: `tests/test_cli_docs.py` walks every
 * Markdown file in the repository and checks the commands it documents against
 * the CLI that exists. A Markdown change anywhere -- including under
 * `workspace/` -- can therefore fail a Core test, so Markdown counts as Core.
 * That is not conservatism; it is the one case where the halves genuinely are
 * not separable.
 *
 * Usage:
 *   node .github/changed-half.mjs <file>...   classify the named paths
 *   node .github/changed-half.mjs --stdin     read NUL- or newline-separated
 *
 * Writes `core=` and `workspace=` to $GITHUB_OUTPUT when that is set, and the
 * same to stdout either way.
 *
 * @module .github/changed-half
 */

import { appendFileSync, readFileSync } from 'node:fs'

/** Everything under here belongs to the Workspace and to nothing else. */
const WORKSPACE_PREFIX = 'workspace/'

/** The Workspace's own workflow: a change to it must run the Workspace gates. */
const WORKSPACE_WORKFLOW = '.github/workflows/workspace-ci.yml'

/**
 * Classify a set of changed paths.
 *
 * Returns which halves must run. Both may be true; both may be false, which is
 * the case a change touching nothing either product builds from -- and even
 * then the aggregators still report, because they run unconditionally.
 */
export function classifyChanges(paths) {
  const result = { core: false, workspace: false, markdown: false }

  for (const raw of paths) {
    const path = String(raw).trim().replaceAll('\\', '/')
    if (path === '') continue

    // Markdown is read by a Core test wherever it lives, so it is Core --
    // and when it lives under workspace/ it is both.
    if (path.toLowerCase().endsWith('.md')) {
      result.core = true
      result.markdown = true
      if (path.startsWith(WORKSPACE_PREFIX)) result.workspace = true
      continue
    }

    if (path === WORKSPACE_WORKFLOW) {
      result.workspace = true
      continue
    }

    // A change to any other workflow, or to anything shared, has to run both:
    // a release or CI change can break either product, and neither half owns
    // the answer to whether it did.
    if (path.startsWith('.github/')) {
      result.core = true
      result.workspace = true
      continue
    }

    if (path.startsWith(WORKSPACE_PREFIX)) {
      result.workspace = true
      continue
    }

    result.core = true
  }

  return result
}

/** The lines a workflow step writes to $GITHUB_OUTPUT. */
export function outputLines(result) {
  return [`core=${String(result.core)}`, `workspace=${String(result.workspace)}`]
}

function main(argv) {
  let paths
  if (argv.includes('--stdin')) {
    const raw = readAllStdin()
    paths = raw.split(/\0|\r?\n/)
  } else {
    paths = argv.filter(entry => entry !== '--stdin')
  }

  const result = classifyChanges(paths)
  const lines = outputLines(result)
  for (const line of lines) process.stdout.write(`${line}\n`)

  const output = process.env.GITHUB_OUTPUT
  if (typeof output === 'string' && output !== '') {
    appendFileSync(output, `${lines.join('\n')}\n`, 'utf8')
  }
}

/** Read stdin to the end. `git diff --name-only` can be long; this is not. */
function readAllStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith('changed-half.mjs')
  && process.argv[1].endsWith('changed-half.mjs')) {
  main(process.argv.slice(2))
}
