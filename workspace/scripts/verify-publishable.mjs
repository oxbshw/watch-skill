#!/usr/bin/env node
/**
 * What may be published, and what may never be.
 *
 * Two mistakes this gate exists to prevent, both of which are cheap to make
 * and expensive to undo, because a published version number can never be
 * reused:
 *
 * **Publishing something that was never meant to be public.** `@deepwatch/
 * monorepo` is the workspace root and `@deepwatch/desktop` is an Electron
 * shell that ships as a signed installer. Neither is an npm package. A missing
 * `"private": true` is one keystroke, and `npm publish` does not ask twice.
 *
 * **Publishing something public that is missing the metadata a consumer needs
 * to trust it.** A package with no repository, no licence and no engines range
 * is one a reviewer cannot place, a security tool cannot map, and a package
 * manager cannot warn about. Every public package here answers the same
 * questions in the same shape.
 *
 * This is static: it reads manifests and nothing else, so it runs in a second
 * and belongs in `npm run check`. The claims that need a real tarball —
 * contents, resolution, imports — are `scripts/pack-release.mjs`.
 *
 * Usage:
 *   node scripts/verify-publishable.mjs
 *   node scripts/verify-publishable.mjs --json
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Packages that must never reach a registry, and why. */
const NEVER_PUBLISH = new Map([
  ['@deepwatch/monorepo', 'the workspace root, which is a repository and not a package'],
  ['@deepwatch/desktop', 'the Electron shell, which ships as a signed platform installer'],
])

/** Fields every public package answers, because a consumer needs every one. */
const REQUIRED = [
  'name', 'version', 'description', 'license', 'author', 'repository',
  'homepage', 'bugs', 'keywords', 'files', 'engines', 'publishConfig',
]

/** Every manifest in the workspace, with where it came from. */
function manifests() {
  const found = [{
    dir: '.',
    path: join(ROOT, 'package.json'),
    manifest: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
  }]
  for (const parent of ['packages/watch', 'apps']) {
    const at = join(ROOT, parent)
    if (!existsSync(at)) continue
    for (const name of readdirSync(at)) {
      const path = join(at, name, 'package.json')
      if (!existsSync(path)) continue
      found.push({
        dir: `${parent}/${name}`,
        path,
        manifest: JSON.parse(readFileSync(path, 'utf8')),
      })
    }
  }
  return found
}

/** Everything wrong with the workspace's publishable surface. */
export function audit() {
  const all = manifests()
  const problems = []
  const say = (name, detail) => problems.push(`${name}: ${detail}`)

  const byName = new Map(all.map(entry => [entry.manifest.name, entry]))
  const version = byName.get('@deepwatch/monorepo')?.manifest.version

  for (const { dir, manifest } of all) {
    const name = manifest.name ?? dir
    const reason = NEVER_PUBLISH.get(name)

    if (reason !== undefined) {
      if (manifest.private !== true) {
        say(name, `must be "private": true — it is ${reason}`)
      }
      if (manifest.publishConfig !== undefined) {
        say(name, 'a private package must not carry publishConfig')
      }
      continue
    }
    if (manifest.private === true) {
      say(name, 'is private and is not on the never-publish list; add it there or publish it')
      continue
    }

    for (const field of REQUIRED) {
      if (manifest[field] === undefined) say(name, `has no ${field}`)
    }
    if (manifest.version !== version) {
      say(name, `is ${manifest.version} and the workspace is ${version}`)
    }
    if (manifest.license !== 'MIT') say(name, `declares ${manifest.license}, not MIT`)
    if (manifest.publishConfig?.access !== 'public') {
      // A scoped package defaults to restricted, and a restricted publish on
      // an account without a paid scope fails halfway through a release.
      say(name, 'is scoped, so publishConfig.access must be "public"')
    }
    if (manifest.repository?.directory !== `workspace/${dir}`) {
      say(name, `repository.directory should be workspace/${dir}`)
    }
    if (manifest.engines?.node === undefined) say(name, 'has no engines.node range')

    // Types without the declarations in `files` is a package that type-checks
    // for its author and resolves to `any` for everyone else.
    if (manifest.types !== undefined) {
      const files = manifest.files ?? []
      if (!files.some(entry => entry.includes('.d.ts'))) {
        say(name, 'declares types and does not ship .d.ts in files')
      }
    }
    if (manifest.exports !== undefined && manifest.exports['./package.json'] === undefined) {
      say(name, 'should export ./package.json, which tooling reads')
    }

    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (NEVER_PUBLISH.has(dep)) {
          say(name, `${field} names ${dep}, which is never published`)
        }
        if (dep.startsWith('@deepwatch/') && !byName.has(dep)) {
          say(name, `${field} names ${dep}, which is not in this workspace`)
        }
        if (dep.startsWith('@watchskill/') || range.includes('@watchskill')) {
          say(name, `${field} still names the old @watchskill scope`)
        }
      }
    }

    const text = JSON.stringify(manifest)
    if (text.includes('@watchskill')) say(name, 'still mentions the old @watchskill scope')
    if (/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(text)) {
      say(name, 'contains an absolute path from a maintainer machine')
    }
  }

  const published = all.filter(entry => entry.manifest.private !== true)
  if (published.length !== 20) {
    say('workspace', `${published.length} publishable packages, expected 20`)
  }
  return { published: published.map(entry => entry.manifest.name).sort(), problems }
}

function main() {
  const report = audit()
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (report.problems.length === 0) {
    process.stdout.write(
      `publishable: ${report.published.length} public packages, `
      + `${NEVER_PUBLISH.size} held back\n`)
  } else {
    for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
    process.stderr.write(`\npublishable: ${report.problems.length} problem(s)\n`)
  }
  return report.problems.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
