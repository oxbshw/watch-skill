/**
 * The Typert generation path, including the compatibility patch it needs.
 *
 * The generator recognises `@Remote` only when the decorator's declaration
 * comes from a registered workspace package or from an ambient `declare
 * module`. A package that depends on the protocol through node_modules — which
 * is every package outside upstream's own monorepo — matches neither, so
 * generation reported "publishes Remote artifacts but has no Remote methods"
 * and emitted nothing. The patch adds one branch that accepts a declaration
 * whose resolved file belongs to the genuinely installed protocol package.
 *
 * That branch is the thing most worth guarding, because the failure it fixes
 * is silent in the worst way: zero invocations is a *successful* generation of
 * an empty protocol. Every check here therefore asserts on content rather than
 * on an exit code.
 *
 * The negative cases matter as much as the positive one. The patch widens what
 * counts as the protocol, and a widening that accepts a lookalike would let
 * generation validate a protocol the Host never runs.
 *
 * The zero-invocation failure is reproduced by moving the protocol rather than
 * by unpatching the generator: a byte-identical copy of the real declarations,
 * imported under the real specifier, must still be rejected. That proves the
 * patch matches on what an import resolved to and not on what it was called,
 * and it needs no unpatched instance left behind in the pnpm store — a test
 * that depends on store residue passes here and fails on a clean install.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))
const GENERATOR_ENTRY = require.resolve('@deepseek-ai/dsh-typert-generator')
const PATCH_MARKER = 'watch-skill: accept a declaration resolved'
const slash = value => value.replaceAll('\\', '/')

/** The protocol and cordis type declarations, as installed. */
function installedTypes() {
  const fromTools = createRequire(join(ROOT, 'packages', 'watch', 'tools', 'package.json'))
  const protocol = join(
    dirname(fromTools.resolve('@deepseek-ai/dsh-typert-protocol/package.json')),
    'lib', 'types', 'index.d.ts')
  const cordis = join(
    dirname(require.resolve('@deepseek-ai/cordis/package.json')),
    'lib', 'types', 'index.d.ts')
  return { protocol: slash(protocol), cordis: slash(cordis) }
}

/**
 * A throwaway workspace holding one package, shaped like a Watch package.
 *
 * `source` is written verbatim, so a case can import the real protocol, a
 * lookalike, or nothing at all.
 */
function fixture({ source, extraFiles = {}, extraPaths = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'watch-typert-'))
  const pkg = join(root, 'packages', 'probe')
  mkdirSync(join(pkg, 'src'), { recursive: true })
  const types = installedTypes()

  writeFileSync(join(root, 'package.json'),
    JSON.stringify({ name: '@probe/workspace', private: true, type: 'module' }, null, 2))
  writeFileSync(join(root, 'tsconfig.base.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler',
      strict: true, composite: true, noEmit: true,
      allowImportingTsExtensions: true, ignoreDeprecations: '6.0', skipLibCheck: true,
      lib: ['ES2024', 'DOM'],
      paths: {
        '@deepseek-ai/dsh-typert-protocol': [types.protocol],
        '@deepseek-ai/cordis': [types.cordis],
        '@probe/probe': ['./packages/probe/src/index.ts'],
        ...extraPaths,
      },
    },
  }, null, 2))
  writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({
    extends: './tsconfig.base.json', files: [],
    references: [{ path: './packages/probe' }],
  }, null, 2))
  writeFileSync(join(pkg, 'tsconfig.json'), JSON.stringify({
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      rootDir: 'src', outDir: 'lib/types', noEmit: false,
      declaration: true, emitDeclarationOnly: true,
    },
    include: ['src'],
  }, null, 2))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: '@probe/probe', private: true, type: 'module',
    exports: {
      '.': './src/index.ts',
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
      './remote': {
        types: './lib/typert.remote-client.d.ts',
        default: './lib/typert.remote-client.js',
      },
    },
    files: [
      'lib/typert.host.js', 'lib/typert.host.d.ts',
      'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts',
    ],
  }, null, 2))
  writeFileSync(join(pkg, 'src', 'index.ts'), source)
  for (const [name, content] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return root
}

/** Generate against a fixture, with an optional alternative generator. */
async function generate(root, entry = GENERATOR_ENTRY) {
  const { WorkspaceTypertGenerator } = await import(`file:///${slash(entry)}?v=${Date.now()}`)
  try {
    return { ok: true, artifacts: new WorkspaceTypertGenerator(root).generate(undefined, ['host']) }
  } catch (cause) {
    return { ok: false, message: String(cause?.message ?? cause) }
  }
}

const REAL_SERVICE = `
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context { probe: ProbeService }
}

export class ProbeService extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'probe') }

  @Remote('ping')
  ping(value: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    return Promise.resolve(\`pong:\${value}\`)
  }
}
`

// ── the installed generator is the patched one ──────────────────────────────

test('the resolved generator carries the compatibility patch', () => {
  const text = readFileSync(GENERATOR_ENTRY, 'utf8')
  assert.ok(text.includes(PATCH_MARKER),
    'pnpm must apply patches/@deepseek-ai__dsh-typert-generator@0.1.1-rc.2.patch')
})

test('the patch is pinned to the exact version, with its digest in the lockfile', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const patched = manifest.pnpm?.patchedDependencies ?? {}
  const keys = Object.keys(patched)
  assert.deepEqual(keys, ['@deepseek-ai/dsh-typert-generator@0.1.1-rc.2'],
    'exactly one patched dependency, pinned to an exact version')

  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  assert.match(lock, /patchedDependencies:/)
  assert.match(lock, /'@deepseek-ai\/dsh-typert-generator@0\.1\.1-rc\.2':/)
})

test('only the build-time generator is patched', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const key of Object.keys(manifest.pnpm?.patchedDependencies ?? {})) {
    assert.doesNotMatch(key, /typert-protocol|api-gateway|typert-registry|client-connection/,
      'the runtime protocol, Gateway, registry and Connection must stay unmodified')
  }
  const patch = readFileSync(
    join(ROOT, 'patches', '@deepseek-ai__dsh-typert-generator@0.1.1-rc.2.patch'), 'utf8')
  const touched = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1].trim())
  assert.deepEqual(touched, ['lib/index.js'], 'the patch touches one build-time file')
})

test('no ambient declaration impersonates the protocol in maintained source', () => {
  // The upstream fixture uses an ambient `declare module` as a test double.
  // Shipping one would let generation validate a protocol the Host never runs.
  const { spawnSync } = require('node:child_process')
  // Assembled rather than written out. Spelling the ambient form as a literal
  // would put it in this file, and `git grep` would then report this test as
  // the very thing it exists to forbid.
  const ambient = ['declare', 'module', `'@deepseek-ai/dsh-typert-protocol'`].join(' ')
  const grep = spawnSync('git',
    ['grep', '-l', ambient, '--', 'workspace'],
    { cwd: join(ROOT, '..'), encoding: 'utf8' })
  // git grep exits 1 when it matches nothing, which is exactly the passing
  // case, so the status is read rather than thrown on.
  assert.ok(grep.status === 0 || grep.status === 1,
    `git grep failed: ${String(grep.stderr ?? '')}`)
  const found = (grep.stdout ?? '').split('\n').filter(Boolean)
  assert.deepEqual(found, [])
})

// ── positive: the real installed protocol is recognised ─────────────────────

test('a service importing the installed protocol generates a strict Remote', async () => {
  const root = fixture({ source: REAL_SERVICE })
  try {
    const result = await generate(root)
    assert.equal(result.ok, true, result.message)
    assert.equal(result.artifacts.length, 1, 'exactly one package')

    const [artifact] = result.artifacts
    assert.equal(artifact.package, '@probe/probe')

    const ids = [...artifact.js.matchAll(/id: '([^']+)'/g)].map(match => match[1])
    assert.deepEqual(ids, ['@probe/probe#probe/ping'], 'exactly one invocation')

    assert.equal((artifact.js.match(/mode: 'strict'/g) ?? []).length, 2,
      'a strict codec for the parameter and for the result')
    assert.match(artifact.js, /cancellation: \{ parameter: 'signal' \}/)

    for (const field of ['js', 'dts']) {
      assert.equal(typeof artifact[field], 'string', `host ${field}`)
    }
    for (const field of ['js', 'dts', 'dtsMap']) {
      assert.equal(typeof artifact.remote[field], 'string', `remote ${field}`)
    }
    assert.match(artifact.remote.dts, /ping: \(value: string, signal\?: AbortSignal\)/)
    assert.match(artifact.remote.dts, /RemoteResult<string>/,
      'Typert owns the outer result envelope')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── negative: nothing else may pass for the protocol ────────────────────────

test('a local function named Remote is not the protocol', async () => {
  const root = fixture({
    source: `
      /** A local decorator that shares a name and nothing else. */
      export function Remote(_method: unknown, _context: unknown): void {}
      export class NotAService {
        @Remote
        ping(value: string): Promise<string> { return Promise.resolve(value) }
      }
    `,
  })
  try {
    const result = await generate(root)
    const invocations = result.ok
      ? (result.artifacts[0]?.js.match(/id: '/g) ?? []).length
      : 0
    assert.equal(invocations, 0, 'a same-named local declaration must not be accepted')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lookalike package exporting the protocol names is not the protocol', async () => {
  const root = fixture({
    extraFiles: {
      'lookalike.d.ts': `
        export declare function Remote(exportName: string): MethodDecorator
        export declare abstract class TypertRemoteService {
          protected constructor(ctx: unknown, key: string)
        }
      `,
    },
    extraPaths: { '@evil/typert-protocol': ['./lookalike.d.ts'] },
    source: `
      import { Remote, TypertRemoteService } from '@evil/typert-protocol'
      export class Impostor extends TypertRemoteService {
        constructor() { super(undefined, 'probe') }
        @Remote('ping')
        ping(value: string): Promise<string> { return Promise.resolve(value) }
      }
    `,
  })
  try {
    const result = await generate(root)
    const invocations = result.ok
      ? (result.artifacts[0]?.js.match(/id: '/g) ?? []).length
      : 0
    assert.equal(invocations, 0, 'identity comes from the resolved package, not the name')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a copy of the protocol outside node_modules is not the protocol', async () => {
  // The patched branch accepts a declaration whose resolved file sits under a
  // node_modules path belonging to @deepseek-ai/dsh-typert-protocol. Copying
  // those exact declarations somewhere else and importing them under the real
  // specifier is the sharpest test of that rule: the source is byte-identical
  // and the identity is not, so anything that passed here would mean the patch
  // was matching on the import specifier rather than on what it resolved to.
  //
  // It is also the zero-invocation failure the patch exists to fix, reproduced
  // on demand without depending on an unpatched generator being left in the
  // store.
  const types = installedTypes()
  const copyRoot = mkdtempSync(join(tmpdir(), 'watch-typert-copy-'))
  const copied = join(copyRoot, 'protocol.d.ts')
  cpSync(types.protocol, copied)

  const root = fixture({
    source: REAL_SERVICE,
    extraPaths: { '@deepseek-ai/dsh-typert-protocol': [slash(copied)] },
  })
  try {
    const result = await generate(root)
    const invocations = result.ok
      ? (result.artifacts[0]?.js.match(/id: '/g) ?? []).length
      : 0
    assert.equal(invocations, 0,
      'identity must come from the resolved installed package, not the specifier')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(copyRoot, { recursive: true, force: true })
  }
})

// ── the bill of materials tells the truth about the patch ───────────────────

test('the SBOM records the patched dependency rather than an ordinary one', () => {
  const sbom = JSON.parse(readFileSync(join(ROOT, 'docs', 'sbom.json'), 'utf8'))
  const patched = sbom.patchedDependencies ?? []
  assert.equal(patched.length, 1, 'exactly one patched dependency')

  const [entry] = patched
  assert.equal(entry.name, '@deepseek-ai/dsh-typert-generator')
  assert.equal(entry.upstreamVersion, '0.1.1-rc.2')
  assert.equal(entry.patched, true)
  assert.equal(entry.license, 'MIT')
  assert.match(entry.scope, /build-time only/)
  assert.match(entry.upstreamRepository, /deepseek-harness/)
  assert.notEqual(entry.reason, '', 'a patch nobody explained is one nobody can review')

  // The digest pnpm verifies on install, and the one this document claims.
  // A patch edited without regenerating the SBOM is a mismatch a reader can act
  // on; a document that simply omits the digest is not.
  assert.match(entry.patchSha256, /^[0-9a-f]{64}$/)
  assert.equal(entry.lockfileHash, entry.patchSha256,
    'the SBOM digest must equal the digest recorded in pnpm-lock.yaml')
  assert.equal(entry.digestsAgree, true)

  // The patch file on disk has to be the one both of them name.
  const onDisk = createHash('sha256')
    .update(readFileSync(join(ROOT, entry.patchPath)))
    .digest('hex')
  assert.equal(onDisk, entry.patchSha256, 'the patch file changed without the SBOM')

  for (const runtime of entry.runtimePackagesUnmodified) {
    assert.doesNotMatch(entry.name, new RegExp(runtime.replace(/[/@-]/g, '.')),
      'a runtime package must never be the patched one')
  }
})

test('the patched generator is not listed as an ordinary third-party package', () => {
  const sbom = JSON.parse(readFileSync(join(ROOT, 'docs', 'sbom.json'), 'utf8'))
  const listed = sbom.thirdParty.filter(
    pkg => pkg.name === '@deepseek-ai/dsh-typert-generator')
  for (const pkg of listed) {
    assert.equal(pkg.version, '0.1.1-rc.2',
      'the upstream version is what the dependency graph resolves')
  }
  // It may appear in thirdParty -- it is a real dependency -- but the patched
  // record has to exist alongside it, or a reader sees an unmodified release.
  assert.ok((sbom.patchedDependencies ?? []).some(
    entry => entry.name === '@deepseek-ai/dsh-typert-generator'))
})
