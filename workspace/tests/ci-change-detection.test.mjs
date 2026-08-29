/**
 * Which half of the monorepo a change touches, and why the answer matters.
 *
 * Branch protection requires a named status. A workflow filtered by
 * `paths:` that does not trigger produces no status at all -- not a failing
 * one, an absent one -- so a pull request protected on a check inside it waits
 * forever with nothing to explain the wait. That is the failure this
 * classification exists to make impossible: both workflows trigger on
 * everything, both aggregators always report, and only the expensive matrices
 * are conditional.
 *
 * The five cases below are the ones a monorepo actually sees. The
 * documentation case is the one that looks wrong and is not:
 * `tests/test_cli_docs.py` walks every Markdown file in the repository,
 * including under `workspace/`, and checks the commands it documents against
 * the CLI that exists. A Markdown change therefore has to run Core, wherever
 * it lives.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyChanges, outputLines } from '../../.github/changed-half.mjs'

test('a Core-only change runs Core and skips the Workspace', () => {
  const result = classifyChanges([
    'src/watch_skill/surfaces/cli/main.py',
    'tests/test_cli.py',
    'pyproject.toml',
    'uv.lock',
  ])
  assert.deepEqual(result, { core: true, workspace: false, markdown: false })
})

test('a Workspace-only change runs the Workspace and skips Core', () => {
  const result = classifyChanges([
    'workspace/packages/watch/live/src/client/live-mode.tsx',
    'workspace/scripts/build.mjs',
    'workspace/package.json',
    'workspace/pnpm-lock.yaml',
  ])
  assert.deepEqual(result, { core: false, workspace: true, markdown: false })
})

test('a cross-boundary change runs both', () => {
  const result = classifyChanges([
    'src/watch_skill/contracts.py',
    'workspace/packages/watch/contracts/src/index.ts',
  ])
  assert.equal(result.core, true)
  assert.equal(result.workspace, true)
})

test('a workflow change runs both, because either product can break', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/release.yml',
    '.github/changed-half.mjs']) {
    const result = classifyChanges([path])
    assert.equal(result.core, true, path)
    assert.equal(result.workspace, true, path)
  }
})

test('the Workspace workflow runs only the Workspace', () => {
  const result = classifyChanges(['.github/workflows/workspace-ci.yml'])
  assert.equal(result.workspace, true)
  assert.equal(result.core, false,
    'the Workspace workflow cannot change what the Python matrix proves')
})

test('a documentation change runs Core, wherever the document lives', () => {
  const root = classifyChanges(['README.md'])
  assert.equal(root.core, true, 'test_cli_docs walks every Markdown file')
  assert.equal(root.workspace, false)

  const inside = classifyChanges(['workspace/docs/getting-started.md'])
  assert.equal(inside.core, true, 'a Workspace document is still walked by a Core test')
  assert.equal(inside.workspace, true, 'and is still a Workspace change')
})

test('a change touching nothing either half builds from runs neither matrix', () => {
  const result = classifyChanges([])
  assert.deepEqual(result, { core: false, workspace: false, markdown: false })
})

test('paths are normalised, so a Windows checkout classifies the same', () => {
  const windows = classifyChanges(['workspace\\packages\\watch\\live\\src\\index.ts'])
  const posix = classifyChanges(['workspace/packages/watch/live/src/index.ts'])
  assert.deepEqual(windows, posix)
})

test('blank and whitespace entries are ignored rather than classified', () => {
  assert.deepEqual(classifyChanges(['', '   ', '\t']),
    { core: false, workspace: false, markdown: false })
})

test('the step output is the exact shape a workflow reads', () => {
  assert.deepEqual(outputLines(classifyChanges(['src/x.py'])),
    ['core=true', 'workspace=false'])
  assert.deepEqual(outputLines(classifyChanges(['workspace/x.ts'])),
    ['core=false', 'workspace=true'])
})
