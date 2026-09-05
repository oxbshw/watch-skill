#!/usr/bin/env node
/**
 * Read what is actually inside the tarballs, rather than what the build meant
 * to put there.
 *
 * `verify-packed-install` proves the artifacts install and their exports
 * resolve. `verify-packed-exec` proves the CLI runs from them. Neither opens a
 * file and looks at the bytes — so a tarball could install perfectly, run
 * perfectly, and carry the build machine's directory names, a credential a
 * generator interpolated, or a `file:` specifier that only resolves here.
 *
 * Those are the failures that survive every other gate, because they are not
 * failures *of* the build. They are things the build faithfully copied.
 *
 * Five checks, each for something that has gone wrong in a published package
 * somewhere:
 *
 *   - **a build-machine path.** `D:\watch-skill-main` in a shipped file is a
 *     directory that exists on exactly one computer. Checked against the real
 *     roots of this machine rather than against a general "looks like a path"
 *     pattern, because the general one cannot tell `C:\Users\…` from the
 *     `C:\…\deepwatch.cmd` a diagnostic legitimately prints.
 *   - **a secret.** Any of the shapes a key takes when a generator interpolates
 *     one it should not have had.
 *   - **a symlink.** A link inside a tarball resolves against whatever the
 *     installing machine has at that path, which is not a thing a package gets
 *     to decide.
 *   - **an unresolved `workspace:` specifier.** It means the manifest was
 *     packed without its versions being rewritten, and the install would ask a
 *     registry for a protocol it does not speak.
 *   - **a `file:` dependency.** It resolves to a directory on this machine and
 *     nowhere else.
 *
 * Usage: node scripts/verify-packed-contents.mjs [--dir <artifacts>]
 */

import { readdirSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const dirFlag = argv.indexOf('--dir')
const ARTIFACTS = dirFlag < 0 ? join(ROOT, '.release-artifacts') : argv[dirFlag + 1]

/** Files worth reading as text. Anything else is bytes nobody greps. */
const TEXT = /\.(?:js|cjs|mjs|ts|mts|cts|json|md|ya?ml|txt|map|html|css)$/

/**
 * The directories that would identify this machine.
 *
 * Both separator spellings, because a path reaches a generated file through
 * Node (forward slashes) and through a shell or a Windows API (backslashes)
 * about equally often, and a check that knew only one would miss half of them.
 */
function machineRoots() {
  const raw = [
    ROOT,
    join(ROOT, '..'),
    tmpdir(),
    process.env['HOME'] ?? '',
    process.env['USERPROFILE'] ?? '',
    process.env['APPDATA'] ?? '',
    process.env['PNPM_HOME'] ?? '',
  ].filter(entry => entry !== '' && entry.length > 3)
  const both = new Set()
  for (const entry of raw) {
    both.add(entry)
    both.add(entry.split('\\').join('/'))
  }
  return [...both]
}

/**
 * Credential shapes.
 *
 * The CLI ships a redactor whose *source* contains these same patterns, so a
 * literal match there is the tool rather than a leak. A match adjacent to a
 * quantifier is that source; a match without one is a value.
 */
const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]

/** Whether a hit sits inside a regular-expression literal rather than in data. */
function insidePattern(body, index) {
  const around = body.slice(Math.max(0, index - 12), index + 48)
  return /[A-Za-z0-9_-]\{\d/.test(around) || around.includes('\\b')
}

/** Every file in one extracted package, with its path relative to the root. */
function* walk(dir, rel = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    const relative = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isSymbolicLink()) { yield { relative, symlink: true }; continue }
    if (entry.isDirectory()) { yield* walk(absolute, relative); continue }
    yield { relative, absolute, symlink: false }
  }
}

function main() {
  if (!existsSync(ARTIFACTS)) {
    process.stderr.write(`watch: ${ARTIFACTS} does not exist. Run \`npm run pack\` first.\n`)
    process.exit(1)
  }
  const tarballs = readdirSync(ARTIFACTS).filter(name => name.endsWith('.tgz')).sort()
  if (tarballs.length === 0) {
    process.stderr.write(`watch: ${ARTIFACTS} holds no tarballs\n`)
    process.exit(1)
  }

  const roots = machineRoots()
  const problems = []
  const room = mkdtempSync(join(tmpdir(), 'deepwatch-contents-'))
  let files = 0
  let scanned = 0

  for (const tarball of tarballs) {
    // `--force-local`: GNU tar reads `D:\path` as `host:path` and tries to
    // resolve `D` as a hostname, so every extraction on a Windows drive fails
    // with "Cannot connect to D: resolve failed" before it opens the file.
    execFileSync(
      'tar',
      ['--force-local', '-xzf', join(ARTIFACTS, tarball), '-C', room],
      { stdio: 'pipe' })
    // npm packs every package under a single `package/` directory.
    const extracted = join(room, 'package')
    for (const entry of walk(extracted)) {
      files += 1
      if (entry.symlink) {
        problems.push(`${tarball}: ${entry.relative} is a symlink`)
        continue
      }
      if (!TEXT.test(entry.relative)) continue
      scanned += 1
      const body = readFileSync(entry.absolute, 'utf8')

      for (const root of roots) {
        if (body.includes(root)) {
          problems.push(`${tarball}: ${entry.relative} carries the build machine's ${root}`)
        }
      }
      for (const shape of SECRETS) {
        for (const match of body.matchAll(shape)) {
          if (insidePattern(body, match.index ?? 0)) continue
          problems.push(`${tarball}: ${entry.relative} carries ${match[0].slice(0, 12)}…`)
        }
      }
      if (entry.relative === 'package.json') {
        const manifest = JSON.parse(body)
        for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
          for (const [name, range] of Object.entries(manifest[field] ?? {})) {
            if (typeof range !== 'string') continue
            if (range.startsWith('workspace:')) {
              problems.push(`${tarball}: ${field}.${name} is still "${range}"`)
            }
            if (range.startsWith('file:') || range.startsWith('link:')) {
              problems.push(`${tarball}: ${field}.${name} is "${range}", which resolves only here`)
            }
          }
        }
      }
    }
    rmSync(extracted, { recursive: true, force: true })
  }
  rmSync(room, { recursive: true, force: true })

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} problem(s) inside the packed artifacts\n`)
    process.exit(1)
  }

  process.stdout.write(
    `packed-contents: ${tarballs.length} tarballs, ${files} files (${scanned} read) — `
    + 'no build-machine paths, secrets, symlinks, workspace or file specifiers\n')
}

main()
