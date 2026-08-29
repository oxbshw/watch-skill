#!/usr/bin/env node
/**
 * The release manifest: what this build is, exactly, and what it fits with.
 *
 * The SBOM next door answers "what is in the tree". This answers the three
 * questions somebody has *after* that, each of which has bitten a release
 * somewhere:
 *
 * **Is this the build somebody signed?** Every first-party package gets a
 * digest over its own source, so an artifact can be checked against the
 * manifest rather than trusted because it came from the right URL.
 *
 * **Does this build fit what is already installed?** A compatibility matrix
 * naming the DSH baseline, the Bridge protocol range, the Watch Core version
 * and every contract digest. A mismatch on any of them is a specific sentence
 * rather than a runtime surprise three screens later.
 *
 * **Can this build open the store that is there?** A migration manifest
 * listing the schema versions it understands and the transitions it can
 * perform. The desktop's preflight reads the same numbers, so "refused to open
 * a newer store" and "this release cannot read that" are the same fact stated
 * once.
 *
 * The SPDX block is deliberately a real SPDX document rather than a
 * SPDX-flavoured one. A field named `licenseDeclared` that does not follow the
 * spec is worse than no field: it will be parsed by something that believes
 * it.
 *
 * Usage:
 *   node scripts/gen-release-manifest.mjs           write docs/release-manifest.json
 *   node scripts/gen-release-manifest.mjs --check   fail if it is stale
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'docs', 'release-manifest.json')

/** Read JSON, or null. */
function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Every source file of one package, in a stable order.
 *
 * Sorted by path so a digest is reproducible: a directory listing is not
 * ordered by contract, and an unsorted digest changes on a filesystem that
 * enumerates differently.
 */
function sourceFiles(dir) {
  const found = []
  const walk = current => {
    for (const entry of readdirSync(current).sort()) {
      // Build output and dependencies are not what the package *is*.
      if (['node_modules', 'lib', 'dist'].includes(entry)) continue
      const path = join(current, entry)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (/\.(ts|tsx|css|yml|json|md)$/.test(entry)) found.push(path)
    }
  }
  walk(dir)
  return found.sort()
}

/**
 * A digest over a package's source.
 *
 * Over the *content plus the relative path*, so moving a file changes the
 * digest. A digest of concatenated bytes alone would call two different trees
 * identical whenever a rename balanced out.
 */
function packageDigest(dir) {
  const hash = createHash('sha256')
  let files = 0
  for (const path of sourceFiles(dir)) {
    hash.update(relative(dir, path).replace(/\\/g, '/'))
    hash.update('\0')
    // Normalized to LF before hashing.
    //
    // Every file digested here is text, and `.gitattributes` declares LF
    // canonical. Hashing raw bytes made the digest a property of the
    // *checkout* rather than of the content: a working tree holding CRLF
    // produced one set of digests and a clean clone of the same commit
    // produced another, so the committed manifest could never match a fresh
    // checkout. For a manifest whose whole purpose is checking an installed
    // build, that made it unable to verify anything.
    hash.update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
    hash.update('\0')
    files += 1
  }
  return { digest: `sha256:${hash.digest('hex')}`, files }
}

/** Every first-party package, with its integrity digest. */
function firstPartyPackages() {
  const roots = [join(ROOT, 'packages', 'watch'), join(ROOT, 'apps')]
  const packages = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root).sort()) {
      const dir = join(root, entry)
      const manifest = readJson(join(dir, 'package.json'))
      if (manifest === null) continue
      const { digest, files } = packageDigest(dir)
      packages.push({
        name: manifest.name,
        version: manifest.version,
        license: manifest.license ?? 'NOASSERTION',
        path: relative(ROOT, dir).replace(/\\/g, '/'),
        private: manifest.private === true,
        integrity: digest,
        sourceFiles: files,
      })
    }
  }
  return packages
}

/** Read the contract digests out of the TypeScript that declares them. */
function schemaDigests() {
  const source = readFileSync(
    join(ROOT, 'packages', 'watch', 'contracts', 'src', 'digests.ts'), 'utf8')
  const block = /EXPECTED_SCHEMA_DIGESTS[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  const digests = {}
  for (const match of block.matchAll(/(\w+):\s*'([^']+)'/g)) {
    digests[match[1]] = match[2]
  }
  return digests
}

/** The protocol range this build speaks. */
function protocolRange() {
  const source = readFileSync(
    join(ROOT, 'packages', 'watch', 'contracts', 'src', 'index.ts'), 'utf8')
  const max = /WATCH_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(source)?.[1]
  const min = /WATCH_PROTOCOL_MIN\s*=\s*(\d+)/.exec(source)?.[1]
  return { min: Number(min ?? 0), max: Number(max ?? 0) }
}

/** The store schema version the desktop understands. */
function schemaVersion() {
  const source = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'startup.ts'), 'utf8')
  return Number(/STORE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(source)?.[1] ?? 0)
}

/** Build the SPDX document. */
function spdxDocument(packages, root) {
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${root.name}-${root.version}`,
    documentNamespace:
      `https://github.com/oxbshw/watch-workspace/spdx/${root.version}/${Date.now().toString(36)}`,
    creationInfo: {
      // A tool, named. An SPDX document with no creator is one nobody can ask
      // about a field they do not understand.
      creators: ['Tool: watch-gen-release-manifest'],
      created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
    packages: packages.map(pkg => ({
      SPDXID: `SPDXRef-Package-${pkg.name.replace(/[^A-Za-z0-9.-]/g, '-')}`,
      name: pkg.name,
      versionInfo: pkg.version,
      // Declared, not concluded: this is what the manifest says, and nobody
      // has audited the files to conclude anything stronger.
      licenseDeclared: pkg.license,
      licenseConcluded: 'NOASSERTION',
      downloadLocation: pkg.private ? 'NONE' : 'NOASSERTION',
      filesAnalyzed: false,
      copyrightText: 'NOASSERTION',
      checksums: [{
        algorithm: 'SHA256',
        checksumValue: pkg.integrity.replace(/^sha256:/, ''),
      }],
    })),
    relationships: packages.map(pkg => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: `SPDXRef-Package-${pkg.name.replace(/[^A-Za-z0-9.-]/g, '-')}`,
    })),
  }
}

function main() {
  const check = process.argv.includes('--check')
  const root = readJson(join(ROOT, 'package.json'))
  const lock = existsSync(join(ROOT, 'upstream', 'deepseek-harness.lock'))
    ? readFileSync(join(ROOT, 'upstream', 'deepseek-harness.lock'), 'utf8')
    : ''
  const status = readJson(join(ROOT, 'docs', 'implementation-status.json'))

  const packages = firstPartyPackages()
  const problems = []

  for (const pkg of packages) {
    if (pkg.license === 'NOASSERTION') {
      problems.push(`${pkg.name} declares no licence, so it cannot appear in an SPDX document`)
    }
    if (pkg.sourceFiles === 0) {
      problems.push(`${pkg.name} has no source files, so its integrity digest means nothing`)
    }
  }

  const manifest = {
    generatedBy: 'scripts/gen-release-manifest.mjs',
    note:
      'Integrity digests are over each package’s own source, path-sensitive so a '
      + 'rename changes them. The compatibility block is what an installed build is '
      + 'checked against; the migration block is what it can open.',
    release: {
      name: root.name,
      version: root.version,
      engines: root.engines ?? {},
    },
    // ── what this build fits with ───────────────────────────────────────────
    compatibility: {
      deepseekHarness: status?.baseline?.dsh ?? 'unknown',
      watchCore: status?.baseline?.watchCore ?? 'unknown',
      bridgeProtocol: protocolRange(),
      schemaDigests: schemaDigests(),
      upstreamLockPresent: lock !== '',
      // Stated explicitly rather than inferred from the digests: a consumer
      // needs to know that *any* family mismatch degrades only that family.
      onDigestMismatch:
        'The affected contract family is disabled and both digests are reported. '
        + 'Other families continue.',
    },
    // ── what this build can open ────────────────────────────────────────────
    migration: {
      storeSchemaVersion: schemaVersion(),
      understands: Array.from({ length: schemaVersion() }, (_, index) => index + 1),
      transitions: [
        {
          from: null,
          to: schemaVersion(),
          kind: 'initialize',
          reversible: false,
          note: 'A fresh store is created and stamped.',
        },
      ],
      refusesNewer: true,
      onNewerStore:
        'The store is not opened. The application starts in read-only replay and '
        + 'says which schema it found.',
    },
    integrity: {
      algorithm: 'sha256',
      scope: 'first-party package source, excluding node_modules and build output',
      packages: packages.map(pkg => ({
        name: pkg.name,
        version: pkg.version,
        integrity: pkg.integrity,
        sourceFiles: pkg.sourceFiles,
      })),
    },
    spdx: spdxDocument(packages, root),
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} release manifest problem(s)\n`)
    process.exit(1)
  }

  // The namespace and creation time change every run by design, so staleness
  // is judged on everything that describes the build rather than on the whole
  // document.
  const comparable = value => JSON.stringify({
    release: value.release,
    compatibility: value.compatibility,
    migration: value.migration,
    integrity: value.integrity,
    packages: value.spdx.packages,
  })

  const existing = readJson(OUTPUT)
  if (existing !== null && comparable(existing) === comparable(manifest)) {
    if (!check) process.stdout.write('release manifest: up to date\n')
    return
  }
  if (check) {
    process.stderr.write('watch: docs/release-manifest.json is stale\n')
    process.stderr.write('watch: run `node scripts/gen-release-manifest.mjs` and commit the result\n')
    process.exit(1)
  }

  writeFileSync(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `wrote docs/release-manifest.json\n`
    + `  ${String(packages.length)} first-party package(s), digested\n`
    + `  Bridge protocol ${String(manifest.compatibility.bridgeProtocol.min)}`
    + `–${String(manifest.compatibility.bridgeProtocol.max)}, `
    + `${String(Object.keys(manifest.compatibility.schemaDigests).length)} contract famil(ies)\n`
    + `  store schema ${String(manifest.migration.storeSchemaVersion)}, newer stores refused\n`,
  )
}

/**
 * Exported so the line-ending property can be tested against the real
 * function rather than a reimplementation of it in a test, which would only
 * ever prove that the test agrees with itself.
 */
export { packageDigest }

// Run only when invoked directly, so importing for a test does not regenerate
// the manifest as a side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) main()
