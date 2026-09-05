#!/usr/bin/env node
/**
 * The sealed manifest: which source these exact bytes came from.
 *
 * The gap this closes cost a release candidate. Provenance was a digest over
 * the sorted `name@version` list of the composed packages — a real property,
 * and the wrong one. A version is a label a human types; it does not change
 * when the code does. So when a `@deepwatch/dsh-memory` tarball was packed from
 * a commit that predated its memory-permission hardening, and the accepted
 * source contained that hardening, both byte sets wore one version and computed
 * the *same* composition digest. The gate reported a match, the tarball was
 * missing `restrictAll`, and nothing in the pipeline could see the difference.
 *
 * Worse was visible in the artifact set's own inventory once somebody read it:
 * `commit.clean` was `false`. The pack recorded that it had been taken from a
 * dirty tree three commits behind the accepted head, and no gate rejected it,
 * because recording a fact is not the same as enforcing it.
 *
 * So this manifest binds *content*, not labels:
 *
 * - the exact source commit and tree object the artifacts were built from;
 * - a SHA-256 over every tarball, the wheel and the sdist;
 * - the pinned upstream Harness identity;
 * - the toolchain that did the building;
 * - the SBOM identity that describes the same tree.
 *
 * Two different byte sets can no longer wear one identity, and an artifact
 * built from an older source is a mismatch rather than a match.
 *
 * **Not part of what it hashes.** The manifest is written outside the artifact
 * directory it describes, so sealing it cannot change the thing it is sealing.
 * A manifest that hashed itself would either need a hole in its own coverage or
 * a second pass that invalidates the first.
 *
 * The build timestamp is recorded and never compared. It is there so a reader
 * can date a set; a reproducible build must not depend on it, and a gate that
 * compared it would fail every honest rebuild.
 *
 * Usage:
 *   node scripts/gen-provenance-manifest.mjs --artifacts <dir> [--out <file>]
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')

/** The manifest format. Bumped when a consumer would misread an older one. */
export const PROVENANCE_VERSION = 1

/** Run a command and hand back its trimmed output, or null. */
function capture(command, args, cwd = REPO) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 }).trim()
  } catch {
    return null
  }
}

/** Read JSON, or null. */
function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** SHA-256 over a file's bytes, lowercase hex. */
export function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * What the repository is right now.
 *
 * `clean` covers untracked files as well as modifications: a tarball can
 * happily pack a file git has never seen, and a "clean except untracked" tree
 * is exactly how an unreviewed file ships.
 */
export function sourceIdentity(cwd = REPO) {
  const commit = capture('git', ['rev-parse', 'HEAD'], cwd)
  const tree = capture('git', ['rev-parse', 'HEAD^{tree}'], cwd)
  const status = capture('git', ['status', '--porcelain=v1', '--untracked-files=all'], cwd)
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  return {
    commit,
    tree,
    branch,
    clean: status === null ? null : status === '',
    dirtyEntries: status === null || status === '' ? 0 : status.split('\n').length,
  }
}

/**
 * The toolchain that produced a set, for a reader diagnosing a difference.
 *
 * pnpm is read from `packageManager` rather than probed. The probe recorded
 * `null` on Windows — pnpm arrives through a corepack shim that `execFileSync`
 * cannot exec without a shell — and a manifest field that claims to name the
 * build toolchain and silently says nothing is worse than one that reads the
 * pin. The pin is also the more honest answer: it is the version corepack will
 * use, whatever happens to be first on `PATH`.
 */
function toolchain() {
  const pinned = readJson(join(ROOT, 'package.json'))?.packageManager
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    pnpm: typeof pinned === 'string' ? pinned : capture('pnpm', ['--version'], ROOT),
    python: capture(
      process.platform === 'win32'
        ? join(REPO, '.venv', 'Scripts', 'python.exe')
        : join(REPO, '.venv', 'bin', 'python'),
      ['--version']),
  }
}

/** The upstream Harness this build composes, pinned exactly. */
function harnessIdentity() {
  const managed = join(ROOT, 'packages', 'watch', 'cli', 'src', 'generated', 'managed-runtime.ts')
  if (!existsSync(managed)) return null
  const source = readFileSync(managed, 'utf8')
  const pin = /'@deepseek-ai\/dsh':\s*'([^']+)'/.exec(source)
    ?? /HARNESS_VERSION\s*=\s*'([^']+)'/.exec(source)
  return pin === null ? null : { package: '@deepseek-ai/dsh', version: pin[1] }
}

/** Every artifact in a directory, with the digest that identifies its bytes. */
export function artifactDigests(dir) {
  const wanted = /\.(tgz|whl|tar\.gz)$/
  return readdirSync(dir).filter(name => wanted.test(name)).sort()
    .map(name => {
      const path = join(dir, name)
      return {
        file: name,
        bytes: statSync(path).size,
        sha256: digestFile(path),
        kind: name.endsWith('.tgz') ? 'npm' : name.endsWith('.whl') ? 'wheel' : 'sdist',
      }
    })
}

/**
 * The name and version a packed tarball actually declares.
 *
 * Read out of the tarball rather than inferred from its filename, because the
 * filename is a convention and the manifest inside is the fact. A set whose
 * names were parsed from filenames would agree with itself about a package
 * that had been renamed.
 */
function packedIdentity(path) {
  // Resolved, and read from the process cwd rather than the tarball's own
  // directory: passing a path relative to the directory it already names sent
  // tar looking for `.release-artifacts/.release-artifacts/…`, and every
  // lookup failed quietly enough to leave the names simply absent.
  //
  // `--force-local` because an absolute Windows path is `D:\…`, and GNU tar
  // reads `host:path` as a remote archive — so it tried to open a network
  // connection to a host called `D` and failed with a name-resolution error.
  const out = capture(
    'tar', ['--force-local', '-xzOf', resolve(path), 'package/package.json'], process.cwd())
  if (out === null) return null
  try {
    const manifest = JSON.parse(out)
    return { name: manifest.name, version: manifest.version }
  } catch {
    return null
  }
}

/** Build the sealed manifest for one artifact directory. */
export function buildManifest(artifactsDir, { repo = REPO } = {}) {
  const source = sourceIdentity(repo)
  const artifacts = artifactDigests(artifactsDir).map(entry => {
    if (entry.kind !== 'npm') return entry
    const identity = packedIdentity(join(artifactsDir, entry.file))
    return identity === null ? entry : { ...entry, ...identity }
  })
  const sbom = join(ROOT, 'docs', 'sbom.json')
  return {
    provenanceVersion: PROVENANCE_VERSION,
    note:
      'Binds these exact bytes to the source that produced them. A version is '
      + 'a label; a digest is the content. Nothing here has been published.',
    source,
    harness: harnessIdentity(),
    toolchain: toolchain(),
    sbom: existsSync(sbom) ? { file: 'docs/sbom.json', sha256: digestFile(sbom) } : null,
    counts: {
      npm: artifacts.filter(entry => entry.kind === 'npm').length,
      wheel: artifacts.filter(entry => entry.kind === 'wheel').length,
      sdist: artifacts.filter(entry => entry.kind === 'sdist').length,
    },
    artifacts,
    // Informational, never compared: a reproducible build must not depend on
    // the clock, and a gate that checked this would fail every honest rebuild.
    builtAt: new Date().toISOString(),
  }
}

/** `SHA256SUMS`, in the format `sha256sum -c` reads. */
export function sha256sums(manifest) {
  return `${manifest.artifacts.map(entry => `${entry.sha256}  ${entry.file}`).join('\n')}\n`
}

function main(argv) {
  const flag = name => {
    const at = argv.indexOf(name)
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null
  }
  const artifactsDir = flag('--artifacts')
  if (artifactsDir === null) {
    process.stderr.write('gen-provenance-manifest: --artifacts <dir> is required\n')
    return 2
  }
  if (!existsSync(artifactsDir)) {
    process.stderr.write(`gen-provenance-manifest: no directory at ${artifactsDir}\n`)
    return 2
  }

  const manifest = buildManifest(artifactsDir)

  // Refuse to seal what cannot be traced. A manifest that recorded "dirty" and
  // was written anyway is the artifact set that shipped without `restrictAll`.
  if (manifest.source.commit === null) {
    process.stderr.write(
      'gen-provenance-manifest: no git commit here, so these artifacts cannot be\n'
      + '                        bound to a source. Build from a checkout.\n')
    return 1
  }
  if (manifest.source.clean !== true) {
    process.stderr.write(
      `gen-provenance-manifest: the worktree has ${String(manifest.source.dirtyEntries)} `
      + 'uncommitted or untracked entries.\n'
      + '                        Artifacts sealed from a dirty tree name a commit that\n'
      + '                        does not describe them. Commit or stash, then repack.\n')
    return 1
  }

  const out = flag('--out') ?? join(dirname(artifactsDir), `${basename(artifactsDir)}-provenance.json`)
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(artifactsDir, 'SHA256SUMS'), sha256sums(manifest), 'utf8')
  process.stdout.write(
    `sealed ${String(manifest.artifacts.length)} artifacts from ${manifest.source.commit.slice(0, 12)}`
    + ` (tree ${String(manifest.source.tree).slice(0, 12)})\n${out}\n`)
  return 0
}

// `pathToFileURL` rather than a hand-built `file://` string: on Windows the
// real URL is `file:///D:/…` and a two-slash spelling never matches, so the
// hand-built comparison silently declined to run and the command exited 0
// having done nothing. A gate that quietly does nothing is worse than no gate.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
