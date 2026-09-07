#!/usr/bin/env node
/**
 * Pack every publishable package, and read what came out.
 *
 * A manifest describes what a package *intends* to ship. A tarball is what it
 * actually ships, and the two disagree more often than anyone expects: an
 * `exports` entry pointing at a declaration nobody generated, a `files` glob
 * that quietly stopped matching, a `workspace:` range that only pnpm can
 * resolve, a stray log or profile directory swept in by a broad pattern.
 *
 * So this packs with **pnpm**, not npm — pnpm is what rewrites `workspace:^`
 * into a real range, and a tarball packed the other way is one nobody outside
 * this repository could install — and then opens each tarball and checks it:
 *
 * - nothing in it may be a credential, a `.env`, a log, a QA profile, or a
 *   path from the machine that built it;
 * - every `exports` target, `bin` and `types` entry must be a file that is
 *   really in there;
 * - no dependency may still say `workspace:`, name a private package, or
 *   mention the scope this project used to publish under.
 *
 * What it writes is evidence, in two files that answer two different
 * questions and must not be one file.
 *
 * `<out>/packed-artifacts.json` describes **these** archives: the commit they
 * were packed from, each tarball's name, its SHA-256 and its size. It lives
 * beside the tarballs, is ignored by git, and is what every consumer checks a
 * tarball against — `deepwatch setup --artifacts`, the profile builder and
 * the first-publish bootstrap all read the inventory written by the pack that
 * produced the archives they are looking at.
 *
 * `inventory/packed-artifacts.json` is tracked, and describes what a pack of
 * *this source* is expected to produce: names, versions, access, file lists,
 * dependency and peer sets, exports and bins. Nothing in it comes from a
 * particular run, so packing does not modify it.
 *
 * That separation is not tidiness. The tracked file used to carry digests and
 * a date, so `npm run release:artifacts` left the worktree dirty — and the
 * very next command the release guide gives, `first-publish`, refuses a dirty
 * tree. The documented path to a first publication could not be walked.
 *
 * Usage:
 *   node scripts/pack-release.mjs
 *   node scripts/pack-release.mjs --out <dir>
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { audit } from './verify-publishable.mjs'
import { publishOrder } from './publish-order.mjs'
import { byCodeUnit } from './lib/order.mjs'
import { resolvePnpm } from './lib/process.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Things that must never be inside a tarball, by the name they arrive under. */
const FORBIDDEN_FILES = [
  { rule: 'dotenv', pattern: /(^|\/)\.env(\.|$)/ },
  { rule: 'npm-credentials', pattern: /(^|\/)\.npmrc$/ },
  { rule: 'log', pattern: /\.log$/ },
  { rule: 'private-key', pattern: /\.(pem|key|p12|pfx|jks)$/ },
  { rule: 'ssh-key', pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/ },
  { rule: 'vcs', pattern: /(^|\/)\.git(\/|$)/ },
  { rule: 'nested-install', pattern: /(^|\/)node_modules(\/|$)/ },
  { rule: 'qa-profile', pattern: /(^|\/)(\.dsh-home|qa|screenshots)(\/|$)/ },
  { rule: 'build-cache', pattern: /\.tsbuildinfo$/ },
]

/** Things that must never be inside a *file* in a tarball. */
const FORBIDDEN_CONTENT = [
  { rule: 'maintainer-drive', pattern: /[A-Za-z]:[\\/]{1,2}(Users|watch-skill|watch-toolchain)/ },
  { rule: 'maintainer-home', pattern: /\/(Users|home)\/[A-Za-z0-9._-]+\// },
  { rule: 'stale-scope', pattern: /@watchskill\// },
  { rule: 'workspace-protocol', pattern: /"workspace:/ },
  { rule: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/ },
  { rule: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { rule: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  { rule: 'aws-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'authorization-header', pattern: /[Aa]uthorization:\s*(Bearer|Basic)\s+[A-Za-z0-9._-]{16,}/ },
]

/** Files worth scanning as text at all. */
const TEXT = /\.(js|mjs|cjs|ts|mts|cts|d\.ts|json|yml|yaml|md|map|html|css|txt)$/

/**
 * The commit these archives were packed from, for the inventory beside them.
 *
 * Recorded with whether the tree was clean, because "packed from abc1234" and
 * "packed from abc1234 plus whatever was in the working tree" are different
 * claims and only one of them is checkable later.
 */
function headCommit() {
  const at = join(ROOT, '..')
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: at })
  if (sha.code !== 0) return { sha: null, clean: null }
  const dirt = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: at })
  return {
    sha: sha.stdout.trim(),
    clean: dirt.code === 0 ? dirt.stdout.trim() === '' : null,
  }
}

/**
 * One package as the tracked inventory records it.
 *
 * Everything here is read out of a manifest, so it is the same on every
 * machine and in every run. What is deliberately absent is everything that is
 * true of one pack and not of the source: the digest, the archive size, the
 * date and the directory.
 */
function structural(record) {
  return {
    name: record.name,
    version: record.version,
    access: record.access,
    fileCount: record.fileCount,
    dependencies: record.dependencies,
    peerDependencies: record.peerDependencies,
    exports: record.exports,
    bin: record.bin,
    files: record.files,
  }
}

/** Run a command and hand back everything it did. */
function run(command, args, options = {}) {
  const ran = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
}

/**
 * Run pnpm, through the boundary the product uses.
 *
 * This used to build a quoted command string and ask for a shell, because on
 * Windows `pnpm` is a `.cmd` and Node will not spawn one otherwise. That
 * worked — and it was a *second* answer to a question the shipped CLI answered
 * differently and wrongly, which is how `spawn EINVAL` reached a user's
 * machine. `resolvePnpm` is now the single answer: it finds the `.js` entry
 * behind the shim (a real pnpm install, or the Corepack shim a Node
 * distribution provides) so Node runs it directly, with no shell and no
 * quoting, on every platform. A path with a space is then simply an argument.
 */
function pnpmPack(args, cwd) {
  const pnpm = resolvePnpm()
  if (pnpm === null) {
    return { code: 1, stdout: '', stderr: 'no pnpm this tooling can run was found' }
  }
  return run(pnpm.command, [...pnpm.prefix, ...args], { cwd })
}

/**
 * The tenth byte of a gzip member says which operating system wrote it.
 *
 * zlib fills it in from the platform it was compiled for: `0x03` on Unix,
 * `0x0a` on Windows. Nothing reads it — `tar`, npm and every unpacker ignore
 * it — but it is inside the archive, so it is inside the digest, and two packs
 * of one commit on two operating systems therefore produce twenty tarballs
 * that differ in exactly one byte each.
 *
 * That single byte is enough to break a release. The first publication has to
 * be made from a machine, because npm will not accept a Trusted Publisher for
 * a package that does not exist yet; the `deepwatch-v*` tag then re-packs on a
 * Linux runner and asks the registry whether it holds these same bytes.
 * `publish-plan.mjs` compares integrity, correctly refuses "already published
 * with DIFFERENT bytes", and the release cannot be completed at that version
 * by anyone. Measured, not theorised: eighteen of the twenty archives packed
 * here matched CI's byte for byte once this byte was equalised.
 *
 * Normalised to `0x03` rather than zeroed, because `0x03` is what the Linux
 * runners that publish every subsequent release already write.
 *
 * The rest of the archive was already deterministic: pnpm zeroes the gzip
 * mtime, and npm stamps every tar entry with a fixed date and uid/gid 0.
 *
 * @param tarball - path to a `.tgz`, rewritten in place.
 */
function normaliseGzipOs(tarball) {
  const bytes = readFileSync(tarball)
  if (bytes.length < 10 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error(`${basename(tarball)} is not a gzip member`)
  }
  if (bytes[9] === GZIP_OS_UNIX) return
  bytes[9] = GZIP_OS_UNIX
  writeFileSync(tarball, bytes)
}

/** The value zlib writes on the platform every release runner uses. */
const GZIP_OS_UNIX = 0x03

/**
 * Every path inside a tarball, without unpacking it.
 *
 * Run from the tarball's own directory with a bare filename, because a tar
 * that sees `D:\...` reads the drive letter as a remote host and tries to
 * connect to it.
 */
function listing(tarball) {
  const ran = run('tar', ['-tzf', basename(tarball)], { cwd: dirname(tarball) })
  if (ran.code !== 0) throw new Error(`tar could not read ${tarball}: ${ran.stderr}`)
  return ran.stdout.split('\n')
    .map(line => line.trim().replace(/^package\//, ''))
    .filter(line => line !== '' && !line.endsWith('/'))
    .sort()
}

/** One file out of a tarball, as text. */
function extract(tarball, path) {
  const ran = run('tar', ['-xzOf', basename(tarball), `package/${path}`],
    { cwd: dirname(tarball), maxBuffer: 64 * 1024 * 1024 })
  return ran.code === 0 ? ran.stdout : null
}

/** Every file an `exports` map points at, however deeply it nests. */
function exportTargets(exports_) {
  const out = []
  const walk = value => {
    if (typeof value === 'string') { out.push(value); return }
    if (value === null || typeof value !== 'object') return
    for (const nested of Object.values(value)) walk(nested)
  }
  walk(exports_)
  return out.filter(target => target.startsWith('./')).map(target => target.slice(2))
}

/** Every workspace package's version, so a `workspace:` range resolves here. */
function workspaceVersions() {
  const versions = new Map()
  for (const parent of ['packages/watch', 'apps']) {
    const at = join(ROOT, parent)
    if (!existsSync(at)) continue
    for (const name of readdirSync(at)) {
      const path = join(at, name, 'package.json')
      if (!existsSync(path)) continue
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof manifest.name === 'string') versions.set(manifest.name, manifest.version)
    }
  }
  return versions
}

/** pnpm's workspace protocol, resolved the way pnpm resolves it. */
function resolveWorkspaceRange(range, version) {
  if (!range.startsWith('workspace:')) return range
  const rest = range.slice('workspace:'.length)
  if (rest === '*') return version
  if (rest === '^' || rest === '~') return `${rest}${version}`
  // `workspace:>=1.2.0` and friends publish as the range itself.
  return rest
}

const DEPENDENCY_FIELDS = [
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
]

/**
 * The manifest as it will be published, in an order nothing can reorder.
 *
 * pnpm resolves `workspace:` ranges itself while packing, and the object it
 * writes back comes out in a different key order on each run — so two packs of
 * one commit produced two different archives for `@deepwatch/dsh-bundle`, the
 * one package with thirteen siblings, and its digest moved for a reason that
 * had nothing to do with its contents. Resolving the ranges here, sorted,
 * leaves pnpm nothing to rewrite and nothing to reorder.
 */
function canonicalManifest(manifest, versions) {
  const canonical = { ...manifest }
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest[field]
    if (declared === undefined) continue
    const resolved = {}
    for (const name of Object.keys(declared).sort(byCodeUnit)) {
      const range = String(declared[name])
      const version = versions.get(name)
      if (range.startsWith('workspace:') && version === undefined) {
        throw new Error(
          `${manifest.name}: ${name} is a workspace range and no workspace package declares it`)
      }
      resolved[name] = resolveWorkspaceRange(range, version ?? '')
    }
    canonical[field] = resolved
  }
  return canonical
}

/** Pack one package and describe what came out of it. */
function packOne(entry, out, versions) {
  const dir = join(ROOT, entry.dir)
  const manifestPath = join(dir, 'package.json')
  // Staged over the real manifest for the length of one `pnpm pack`, and
  // restored from the bytes that were there whatever happens. Packing from a
  // copy elsewhere would mean deciding what ships, which is the manifest's own
  // job and not something this script should answer a second time.
  const original = readFileSync(manifestPath, 'utf8')
  let packed
  try {
    writeFileSync(manifestPath,
      `${JSON.stringify(canonicalManifest(entry.manifest, versions), null, 2)}\n`, 'utf8')
    packed = pnpmPack(['pack', '--pack-destination', out], dir)
  } finally {
    writeFileSync(manifestPath, original, 'utf8')
  }
  if (packed.code !== 0) {
    throw new Error(`pnpm pack failed for ${entry.manifest.name}:\n${packed.stderr}`)
  }
  const filename = packed.stdout.trim().split('\n').map(line => line.trim())
    .reverse().find(line => line.endsWith('.tgz'))
  if (filename === undefined) throw new Error(`pnpm pack printed no tarball for ${entry.dir}`)

  const tarball = join(out, filename.split(/[\\/]/).pop())
  normaliseGzipOs(tarball)
  const bytes = readFileSync(tarball)
  const files = listing(tarball)
  const manifest = JSON.parse(extract(tarball, 'package.json') ?? '{}')

  let unpacked = 0
  const problems = []
  const say = (rule, file, detail) => problems.push({ package: manifest.name, rule, file, detail })

  for (const file of files) {
    for (const { rule, pattern } of FORBIDDEN_FILES) {
      if (pattern.test(file)) say(rule, file, 'must not be published')
    }
  }

  for (const file of files) {
    if (!TEXT.test(file)) continue
    const text = extract(tarball, file)
    if (text === null) continue
    unpacked += Buffer.byteLength(text)
    for (const { rule, pattern } of FORBIDDEN_CONTENT) {
      // Redacted on purpose: a report that quotes the finding publishes it.
      if (pattern.test(text)) say(rule, file, 'matched a forbidden content rule')
    }
  }

  // What it says it ships must be in there. `exports` pointing at a
  // declaration nobody generated is the failure this catches, and it is
  // invisible until somebody installs the package.
  const promised = new Set([
    ...exportTargets(manifest.exports ?? {}),
    ...Object.values(manifest.bin ?? {}).map(path => path.replace(/^\.\//, '')),
    ...(manifest.types === undefined ? [] : [manifest.types]),
    ...(manifest.main === undefined ? [] : [manifest.main]),
  ])
  const have = new Set(files)
  for (const target of promised) {
    if (target === 'package.json') continue
    if (!have.has(target)) say('missing-file', target, 'is promised by the manifest and absent')
  }

  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith('workspace:')) {
        say('workspace-protocol', 'package.json', `${dep} is still a workspace range`)
      }
      if (dep === '@deepwatch/desktop' || dep === '@deepwatch/monorepo') {
        say('private-dependency', 'package.json', `${dep} is never published`)
      }
    }
  }

  return {
    record: {
      file: filename.split(/[\\/]/).pop(),
      name: manifest.name,
      version: manifest.version,
      access: manifest.publishConfig?.access ?? null,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fileCount: files.length,
      unpackedTextBytes: unpacked,
      dependencies: manifest.dependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      exports: Object.keys(manifest.exports ?? {}).sort(),
      bin: Object.keys(manifest.bin ?? {}).sort(),
      files,
    },
    problems,
  }
}

function main() {
  const outFlag = process.argv.indexOf('--out')
  const out = outFlag >= 0 ? process.argv[outFlag + 1] : join(ROOT, '.release-artifacts')

  const report = audit()
  if (report.problems.length > 0) {
    for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
    process.stderr.write('\npack: refusing to pack a workspace that fails its metadata gate\n')
    return 1
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const entries = []
  for (const parent of ['packages/watch', 'apps']) {
    const at = join(ROOT, parent)
    if (!existsSync(at)) continue
    for (const name of readdirSync(at)) {
      const path = join(at, name, 'package.json')
      if (!existsSync(path)) continue
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (manifest.private === true) continue
      entries.push({ dir: `${parent}/${name}`, manifest })
    }
  }

  const versions = workspaceVersions()
  const records = []
  const problems = []
  for (const entry of entries.sort((a, b) => byCodeUnit(a.manifest.name, b.manifest.name))) {
    process.stdout.write(`  packing ${entry.manifest.name}\n`)
    const packed = packOne(entry, out, versions)
    records.push(packed.record)
    problems.push(...packed.problems)
  }

  // Nothing may be in the output directory that this run did not pack — a
  // stale tarball from an earlier version is exactly the artifact somebody
  // publishes by accident.
  const stray = readdirSync(out).filter(
    name => !records.some(record => record.file === name))
  for (const name of stray) {
    problems.push({ package: '(output)', rule: 'stray-artifact', file: name, detail: 'not packed by this run' })
  }

  const totalBytes = records.reduce((total, record) => total + record.bytes, 0)
  const totalFiles = records.reduce((total, record) => total + record.fileCount, 0)
  const directory = outFlag >= 0 ? out : '.release-artifacts'

  // Beside the tarballs: what *these* archives are. `deepwatch setup
  // --artifacts <dir>`, the profile builder and the first-publish bootstrap
  // each read the inventory written by the pack that produced the tarballs
  // they are looking at, so a digest is always compared within one pack.
  writeFileSync(join(out, 'packed-artifacts.json'), `${JSON.stringify({
    generatedBy: 'scripts/pack-release.mjs',
    note: 'These are local artifacts for install testing. Nothing here has been '
      + 'published. The digests below belong to this pack and to no other.',
    packedAt: new Date().toISOString(),
    commit: headCommit(),
    directory,
    counts: { packages: records.length, bytes: totalBytes, files: totalFiles },
    packages: records,
  }, null, 2)}\n`)

  // Tracked: what a pack of this source is expected to produce. Every field is
  // read out of a manifest, so packing rewrites it to the same bytes and the
  // worktree stays clean -- which the release guide's next command requires.
  writeFileSync(join(ROOT, 'inventory', 'packed-artifacts.json'), `${JSON.stringify({
    generatedBy: 'scripts/pack-release.mjs',
    note: 'Source-derived expectations for a release pack. Per-run facts -- the '
      + 'digest, the size, the commit, the directory -- belong to the inventory '
      + 'written beside the tarballs, never here.',
    counts: { packages: records.length, files: totalFiles },
    publishOrder: publishOrder().map(entry => entry.name),
    packages: records.map(structural),
  }, null, 2)}\n`)

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`  ${problem.package}: ${problem.rule} in ${problem.file} — ${problem.detail}\n`)
    }
    process.stderr.write(`\npack: ${problems.length} problem(s) in the packed artifacts\n`)
    return 1
  }
  const megabytes = (totalBytes / 1024 / 1024).toFixed(1)
  process.stdout.write(
    `\npacked ${records.length} packages, ${totalFiles} files, ${megabytes} MB `
    + `into ${directory}\n`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`pack: ${error.message}\n`)
    process.exitCode = 1
  }
}
