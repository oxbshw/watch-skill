/**
 * Which pnpm a release gate runs, and why it must not be corepack's.
 *
 * `packed-artifacts` failed three times on CI with a truncated Node stack. The
 * whole error, once the reporter stopped throwing it away, was:
 *
 *   ! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-12.3.4.tgz
 *   Error: Cannot find module '…/corepack/v1/pnpm/12.3.4/bin/pnpm.cjs'
 *
 * The runner had a real pnpm — `pnpm/action-setup` installs it and sets
 * `PNPM_HOME=~/setup-pnpm/node_modules/.bin`. `resolveNodeCli` did not find it,
 * because it looked for `<entry>/node_modules/<tool>` and
 * `<entry>/../lib/node_modules/<tool>` and never for the layout npm and pnpm
 * actually use: a shim in `node_modules/.bin` whose package is its *sibling*,
 * `node_modules/<tool>`.
 *
 * So the gate fell through to corepack. corepack is a version manager, not a
 * pnpm: asked for one with no pinned `packageManager`, it resolves the newest
 * release and downloads it. The day pnpm 12 shipped, that download decided
 * whether a release could be cut. Nothing in the repository had changed.
 *
 * Two rules come out of it, and both are tested here rather than described:
 * the `.bin` sibling layout resolves, and a downloader is never preferred to a
 * tool that is already installed.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { resolveNodeCli, resolvePnpm } from '../scripts/lib/process.mjs'

const BASE = mkdtempSync(join(tmpdir(), 'watch-launcher-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })

let rooms = 0
/** A directory nobody else is using. */
function room() {
  rooms += 1
  const dir = join(BASE, `r${String(rooms)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The layout `pnpm/action-setup` leaves behind, and `npm i -g` before it.
 *
 * `<root>/node_modules/.bin/pnpm` is the shim that goes on `PATH`;
 * `<root>/node_modules/pnpm/bin/pnpm.cjs` is the package it runs.
 *
 * @returns `{ binDir, entry }` — what goes on PATH, and what must be resolved.
 */
function installLikeActionSetup(root, tool = 'pnpm', relative = join('bin', 'pnpm.cjs')) {
  const binDir = join(root, 'node_modules', '.bin')
  const pkgDir = join(root, 'node_modules', tool, ...relative.split(/[\\/]/).slice(0, -1))
  mkdirSync(binDir, { recursive: true })
  mkdirSync(pkgDir, { recursive: true })
  for (const shim of [tool, `${tool}.cmd`, `${tool}.exe`]) {
    writeFileSync(join(binDir, shim), '#!/usr/bin/env node\n', 'utf8')
  }
  const entry = join(root, 'node_modules', tool, relative)
  writeFileSync(entry, '// the real thing\n', 'utf8')
  return { binDir, entry }
}

describe('a tool installed on PATH is the tool that runs', () => {
  test('the node_modules/.bin sibling layout resolves', () => {
    const root = room()
    const { binDir, entry } = installLikeActionSetup(root)
    const found = resolveNodeCli('pnpm', join('bin', 'pnpm.cjs'), { PATH: binDir })
    assert.equal(found, entry,
      'the layout `pnpm/action-setup` produces did not resolve, so the gate '
      + 'would fall through to corepack again')
  })

  test('resolvePnpm prefers it over corepack, even when corepack is also there', () => {
    // Both present, which is the runner's situation exactly: Node ships
    // corepack, and the workflow installs a pinned pnpm beside it.
    const root = room()
    const { binDir, entry } = installLikeActionSetup(root)
    const corepackRoot = room()
    installLikeActionSetup(corepackRoot, 'corepack', join('dist', 'pnpm.js'))

    const launcher = resolvePnpm({
      PATH: [binDir, join(corepackRoot, 'node_modules', '.bin')].join(delimiter),
    })
    assert.notEqual(launcher, null)
    assert.equal(launcher.kind, 'node-entry')
    assert.deepEqual(launcher.prefix, [entry],
      'corepack was preferred to an installed pnpm; corepack downloads, pnpm does not')
    assert.ok(!launcher.prefix[0].includes('corepack'))
  })

  test('with no pnpm on PATH, the fallback is the platform’s and is named', () => {
    // Not an assertion that nothing resolves: `resolveNodeCli` also looks
    // beside the running node, and corepack ships with node. What matters is
    // that this is the *fallback* — the test above is the one that proves an
    // installed pnpm wins — and that whatever comes back is a launcher rather
    // than a guess.
    const launcher = resolvePnpm({ PATH: '' })
    if (launcher === null) return
    assert.ok(launcher.kind === 'node-entry' || launcher.kind === 'executable')
    if (launcher.kind === 'executable') {
      assert.equal(launcher.command, 'pnpm', 'a POSIX fallback is pnpm itself, offline')
    } else {
      assert.match(launcher.prefix[0], /corepack|pnpm/,
        'a node-entry fallback must be a pnpm or the corepack that manages one')
    }
  })

  test('a shim with no package beside it is not mistaken for one', () => {
    // A `.bin` entry whose package was removed. Resolving it would hand back a
    // path that does not exist, and the failure would surface as a Node stack
    // three steps later.
    const root = room()
    const binDir = join(root, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    for (const shim of ['pnpm', 'pnpm.cmd', 'pnpm.exe']) {
      writeFileSync(join(binDir, shim), '#!/usr/bin/env node\n', 'utf8')
    }
    assert.equal(resolveNodeCli('pnpm', join('bin', 'pnpm.cjs'), { PATH: binDir }), null)
  })
})
