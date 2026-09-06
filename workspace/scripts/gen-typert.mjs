#!/usr/bin/env node
/**
 * Generate the Typert Host and Remote Client artifacts, or verify them.
 *
 * Typert derives a strict wire protocol from the Host TypeScript program: a
 * zod codec per parameter and result, and the client declaration that makes
 * `ctx.remote.watchQuery.librarySearch` exist as a typed function. Those files
 * are build output that is also read by the client bundle, so they are
 * generated here rather than by tsdown — the Workspace compiles its Host
 * halves with `tsc -b`, and the upstream generator ships as a tsdown plugin
 * that never runs in that path.
 *
 * `--check` is a verification, not a repair. It regenerates into memory and
 * compares against disk; a stale artifact fails rather than being silently
 * rewritten, because the whole point of a freshness gate is to notice that
 * somebody changed a Remote signature and did not regenerate.
 *
 * The generator is patched. `scripts/verify-typert-patch.mjs` owns that
 * argument; what matters here is that the patch is present, because without it
 * generation reports zero invocations and every check below would pass over an
 * empty protocol.
 *
 * Usage:
 *   node scripts/gen-typert.mjs           write the artifacts
 *   node scripts/gen-typert.mjs --check   fail if they are absent or stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')

/**
 * The packages whose Remotes are generated.
 *
 * Named rather than discovered. Unscoped analysis walks every registered
 * package and fails on `@deepwatch/dsh-library`, which declares client-only
 * export subpaths that the Host face deliberately excludes — so the scope is
 * the set of packages that actually contribute a Remote.
 */
const CONTRIBUTORS = ['@deepwatch/dsh-tools']

/** What each artifact is written as, from the generator's own field names. */
const ARTIFACTS = [
  { field: 'js', file: 'lib/typert.host.js' },
  { field: 'dts', file: 'lib/typert.host.d.ts' },
  { field: 'remote.js', file: 'lib/typert.remote-client.js' },
  { field: 'remote.dts', file: 'lib/typert.remote-client.d.ts' },
  { field: 'remote.dtsMap', file: 'lib/typert.remote-client.d.ts.map' },
]

const problems = []
const fail = (message, fix) => { problems.push({ message, fix }) }

const slash = value => value.replaceAll('\\', '/')
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex')
const pick = (artifact, field) => field
  .split('.')
  .reduce((value, key) => (value === undefined ? undefined : value[key]), artifact)

/** The generator, and proof the compatibility patch is in the copy we loaded. */
function loadGenerator() {
  const require = createRequire(join(ROOT, 'package.json'))
  const entry = require.resolve('@deepseek-ai/dsh-typert-generator')
  const patched = readFileSync(entry, 'utf8')
    .includes('watch-skill: accept a declaration resolved')
  if (!patched) {
    fail('the resolved Typert generator does not carry the compatibility patch',
      'Run `pnpm install`. Without it the real installed protocol decorator is '
      + 'not recognised and generation reports zero invocations.')
  }
  return { entry }
}

async function main() {
  const { entry } = loadGenerator()
  if (problems.length > 0) return report([])

  const { WorkspaceTypertGenerator } = await import(`file:///${slash(entry)}`)
  let generated
  try {
    generated = new WorkspaceTypertGenerator(ROOT).generate(CONTRIBUTORS, ['host'])
  } catch (cause) {
    fail(`generation failed: ${String(cause?.message ?? cause)}`,
      'Run `node scripts/verify-typert-face.mjs` first; a face or mapping '
      + 'problem surfaces there with the package and subpath that caused it.')
    return report([])
  }

  if (generated.length === 0) {
    fail('generation produced no packages',
      `Expected one artifact per contributor: ${CONTRIBUTORS.join(', ')}.`)
    return report([])
  }

  const written = []
  for (const artifact of generated) {
    const packageDir = join(ROOT, artifact.packageRoot)
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

    // The protocol has to be non-empty and strict before anything is written.
    const invocations = [...String(artifact.js).matchAll(/id: '([^']+)'/g)].map(match => match[1])
    if (invocations.length === 0) {
      fail(`${artifact.package} generated no invocations`,
        'A Remote method needs the @Remote decorator from the installed '
        + 'protocol package and a concrete, JSON-representable signature.')
    }
    const strict = String(artifact.js).match(/mode: 'strict'/g) ?? []
    if (strict.length < invocations.length * 2) {
      fail(`${artifact.package} has ${String(strict.length)} strict codecs for `
        + `${String(invocations.length)} invocation(s); expected at least two each`,
      'A non-strict codec validates less than the signature promises.')
    }
    const cancellation = String(artifact.js).match(/cancellation: \{ parameter: '[^']+' \}/g) ?? []
    if (cancellation.length !== invocations.length) {
      fail(`${artifact.package} records ${String(cancellation.length)} cancellation `
        + `descriptor(s) for ${String(invocations.length)} invocation(s)`,
      'Every Remote method must take a trailing `signal: AbortSignal`.')
    }

    // The exports and file allowlist the generated files are published under.
    for (const [subpath, expected] of [
      ['./typert', { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' }],
      ['./remote', {
        types: './lib/typert.remote-client.d.ts',
        default: './lib/typert.remote-client.js',
      }],
    ]) {
      const actual = manifest.exports?.[subpath]
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(`${artifact.package} must export ${subpath} as ${JSON.stringify(expected)}`,
          'The generated artifacts are unreachable without it.')
      }
    }
    for (const { file } of ARTIFACTS) {
      if (!(manifest.files ?? []).includes(file)) {
        fail(`${artifact.package} package files must include ${file}`,
          'A published tarball would omit the generated protocol.')
      }
    }

    for (const { field, file } of ARTIFACTS) {
      const content = pick(artifact, field)
      if (typeof content !== 'string') {
        fail(`${artifact.package} generated no ${field}`,
          `Expected content for ${file}.`)
        continue
      }
      const path = join(packageDir, file)
      const relativePath = slash(relative(ROOT, path))
      const hash = digest(content)

      if (CHECK) {
        if (!existsSync(path)) {
          fail(`${relativePath} is missing`, 'Run `npm run typert:generate` and commit the result.')
          continue
        }
        const onDisk = readFileSync(path, 'utf8')
        if (onDisk !== content) {
          fail(`${relativePath} is stale`,
            'Run `npm run typert:generate` and commit the result. This check '
            + 'never repairs: a stale artifact means a Remote signature changed.')
          continue
        }
        written.push({ file: relativePath, hash, bytes: content.length })
        continue
      }

      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
      written.push({ file: relativePath, hash, bytes: content.length })
    }

    written.invocations = invocations
  }
  return report(written)
}

function report(written) {
  const ok = problems.length === 0
  process.stdout.write(`typert ${CHECK ? 'check' : 'generate'}\n\n`)
  for (const entry of written) {
    process.stdout.write(`  ${entry.hash.slice(0, 16)}  ${String(entry.bytes).padStart(7)}  ${entry.file}\n`)
  }
  if (Array.isArray(written.invocations)) {
    process.stdout.write(`\n  invocations: ${written.invocations.join(', ')}\n`)
  }
  process.stdout.write('\n')
  for (const problem of problems) {
    process.stdout.write(` FAIL  ${problem.message}\n        ${problem.fix}\n`)
  }
  process.stdout.write(ok
    ? `${CHECK ? 'Artifacts are current.' : 'Artifacts written.'}\n`
    : `\n${String(problems.length)} problem(s).\n`)
  process.exit(ok ? 0 : 1)
}

await main()
