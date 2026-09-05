/**
 * Make the pinned pnpm the one a child process finds on PATH.
 *
 * `dsh plugin` forwards to whatever `pnpm` resolves to in the profile
 * directory. Corepack resolves that from the nearest `packageManager` field,
 * and a DSH profile has none, so it supplied the newest pnpm -- 11.24.0
 * against the workspace's 10.29.1. pnpm 11 does not read `pnpm.overrides` from
 * package.json, which is exactly how a profile points at packed local
 * tarballs, so every Watch package silently left the resolution.
 *
 * Writing `packageManager` into the profile manifest fixes the second install
 * and not the first: `dsh plugin install` is what *creates* that manifest, and
 * it runs pnpm while doing so. Repairing it afterwards means purging a tree
 * linked from the wrong store, and that purge is destructive in a way that is
 * not obvious -- DSH installs the profile's base layers during
 * auto-initialization without recording them in `dependencies`, so a purge
 * removes `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` and nothing
 * puts them back. The profile then composes on paper and cannot boot.
 *
 * So the version is settled before the first command runs, by putting a shim
 * ahead of everything else on PATH. It is directory-independent, which is the
 * property the manifest approach lacks.
 *
 * @module scripts/lib/pnpm-shim
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { manualRoot } from './manual-paths.mjs'

/** The exact pnpm the workspace pins, validated before it is interpolated. */
export function pinnedPackageManager(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const spec = manifest.packageManager
  if (typeof spec !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/.test(spec)) {
    throw new Error(
      `package.json packageManager must pin an exact pnpm, got ${String(spec)}`,
    )
  }
  return spec
}

/**
 * Write the shim and return the directory holding it.
 *
 * Both forms are written regardless of platform. They cost two small files and
 * mean a POSIX runner and a Windows runner are reading the same fix rather
 * than two that have to be kept in agreement.
 */
export function pnpmShimDir(root) {
  const spec = pinnedPackageManager(root)
  const dir = join(manualRoot(), 'pnpm-shim')
  mkdirSync(dir, { recursive: true })

  const cmd = join(dir, 'pnpm.cmd')
  const body = `@echo off\r\ncorepack ${spec} %*\r\n`
  if (!existsSync(cmd) || readFileSync(cmd, 'utf8') !== body) {
    writeFileSync(cmd, body, 'utf8')
  }

  const sh = join(dir, 'pnpm')
  const shBody = `#!/bin/sh\nexec corepack ${spec} "$@"\n`
  if (!existsSync(sh) || readFileSync(sh, 'utf8') !== shBody) {
    writeFileSync(sh, shBody, 'utf8')
    try {
      chmodSync(sh, 0o755)
    } catch {
      // Windows has no execute bit to set, and does not need one.
    }
  }
  return dir
}

/**
 * `env` with the pinned pnpm ahead of anything already on PATH.
 *
 * Also silences Corepack's download prompt: a fresh machine has not fetched
 * this pnpm before, and an unattended script has nobody to answer it.
 */
export function withPinnedPnpm(root, env = process.env) {
  const dir = pnpmShimDir(root)
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH'
  return {
    ...env,
    [key]: `${dir}${process.platform === 'win32' ? ';' : ':'}${env[key] ?? ''}`,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  }
}
