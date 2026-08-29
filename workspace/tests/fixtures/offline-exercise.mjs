/**
 * Everything that could reach the network, exercised under the sentinel.
 *
 * Run as a child of `tests/offline-egress.test.mjs`, with
 * `tests/fixtures/egress-sentinel.cjs` already installed by `--require`. Every
 * import below therefore happens *after* the floor is patched, which is the
 * only ordering where the result means anything.
 *
 * The list is drawn from the governing spec's offline requirement rather than
 * from what looked likely: DSH model/provider routes, Watch perception and
 * provider routes, Watch Core, telemetry, plugin and update checks, memory
 * embeddings and reranking, OCR and cloud routes, hosted adapters, and browser
 * helper services. Anything in this repository that touches one of those is
 * driven here with `offline_only` set.
 *
 * Where a route is Watch Core's rather than the Workspace's, this exercises the
 * Workspace side that would call it — because that is the side this repository
 * can be responsible for, and the Core side has its own socket-level proof in
 * `watch-skill/tests/test_offline_egress.py`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Anything that throws here is a bug in the exercise, not a violation. */
const steps = []
async function step(name, run) {
  try {
    await run()
    steps.push({ name, ok: true })
  } catch (error) {
    steps.push({ name, ok: false, error: String(error?.message ?? error) })
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'watch-offline-'))

try {
  // ── the offline policy itself ─────────────────────────────────────────────
  await step('composer refuses every widening of egress', async () => {
    const { defaultComposer, proposeChange } = await import('@watchskill/dsh-workspace')
    const base = defaultComposer()
    if (!base.privacy.offlineOnly) throw new Error('the default is not offline')
    for (const change of [
      { privacy: { offlineOnly: false, localMediaOnly: true, egressRoutes: [] } },
      { privacy: { offlineOnly: true, localMediaOnly: true, egressRoutes: ['api.example.com'] } },
      { privacy: { offlineOnly: true, localMediaOnly: false, egressRoutes: [] } },
    ]) {
      if (proposeChange(base, change, 'agent').ok) throw new Error('an agent widened egress')
    }
  })

  // ── provider and engine routing ───────────────────────────────────────────
  await step('OCR routing excludes every egress route offline', async () => {
    const technology = await import('@watchskill/dsh-technology')
    const health = new Map(
      technology.OCR_ENGINES.map(engine => [engine.id, { usable: true, state: 'ready' }]))
    for (const quality of ['fast', 'balanced', 'best']) {
      const decision = technology.routeOcr(
        { workload: 'document', scripts: ['Latin'], quality, hasGpu: true, offlineOnly: true, egressConsent: true },
        technology.OCR_ENGINES, [], health,
      )
      const chosen = technology.OCR_ENGINES.find(engine => engine.id === decision.engineId)
      if (chosen !== undefined && !chosen.privacy.worksOffline) {
        throw new Error(`routing chose ${decision.engineId}, which needs the network`)
      }
    }
  })

  await step('every technology descriptor is inspected without contacting it', async () => {
    const technology = await import('@watchskill/dsh-technology')
    for (const engine of technology.OCR_ENGINES) {
      // The whole point: reading capability truth is a local operation. A
      // descriptor that probed on read would reach out here.
      technology.mayDistributeWeights(engine)
      technology.mayRunInProcess(engine)
      technology.installPlan(engine, { hasGpu: false, vramGb: null })
    }
  })

  // ── the Bridge transport ──────────────────────────────────────────────────
  await step('the Bridge mock transport does no networking', async () => {
    const bridge = await import('@watchskill/dsh-core-bridge')
    // The mock backend is what a profile falls back to when the engine is
    // absent. It must not phone anywhere to discover that.
    if (typeof bridge.MockTransport === 'function') {
      const transport = new bridge.MockTransport()
      if (typeof transport.close === 'function') transport.close()
    }
  })

  // ── memory: compile, retrieve, project, export ────────────────────────────
  await step('the memory service runs a whole turn locally', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const memory = await import('@watchskill/dsh-memory')
    const directory = join(scratch, 'memory')
    const ctx = new Context()
    const fiber = await ctx.plugin(memory.default, { mode: 'local_personal', directory })
    const scope = { userId: 'u1', workspaceId: 'ws1', projectId: 'p1', sessionId: 's1' }
    try {
      ctx.watchMemory.remember({
        kind: 'preference', content: 'run the build before the tests',
        origin: 'explicit_user', subjectScope: 'project', scopeId: 'p1',
      }, { userAuthenticated: true })
      // Retrieval and reranking are lexical and local. A semantic path that
      // called an embeddings endpoint would surface right here.
      ctx.watchMemory.compile(scope)
      ctx.watchMemory.render(scope)
      ctx.watchMemory.export(scope, { includeEvents: true })
      ctx.watchMemory.stats()
    } finally {
      await fiber.dispose()
    }
  })

  // ── projections, wiki, adapters ───────────────────────────────────────────
  await step('wiki projections and both adapters run locally', async () => {
    const wiki = await import('@watchskill/dsh-wiki')
    const adapters = await import('@watchskill/dsh-adapters')
    const now = '2026-08-28T10:00:00.000Z'
    const record = {
      memoryId: 'mem_1', kind: 'decision', subjectScope: 'project', scopeId: 'p1',
      content: 'this project uses TypeScript', origin: 'explicit_user',
      sourceRefs: [], evidenceRefs: [], confidence: 1, status: 'active',
      sensitivity: 'private', validFrom: now, validUntil: null, createdAt: now,
      updatedAt: now, lastConfirmedAt: now, supersedes: [], contradictedBy: [], locale: 'en',
    }
    const built = wiki.buildWiki([record])
    const page = wiki.pageAt(built, `decisions/${wiki.slugFor(record)}.md`)
    wiki.validateUserEdit(wiki.diffUserEdit(page, `${page.content}\n- a note\n`), page)

    // The Obsidian adapter constructs URIs and must never open one.
    const vault = adapters.toVault(built, { name: 'Watch' })
    adapters.backlinks(vault)
    adapters.pageUri('Watch', page.path)
    adapters.vaultUri('Watch')
    const bundle = adapters.toLlmWiki([record])
    adapters.fromLlmWiki(bundle)
  })

  // ── library search and the technology centre ──────────────────────────────
  await step('library search plans and facets locally', async () => {
    const library = await import('@watchskill/dsh-library')
    // A semantic path that fetched an embedding would appear here.
    library.searchPlan({ lexical: true, semantic: true })
    library.searchPlan({ lexical: true, semantic: false })
    const source = {
      sourceId: 's1', kind: 'video', title: 'x', locator: 'https://example.test/x',
      revisions: [{
        sourceRevisionId: 's1@r1', sourceId: 's1', revision: 1, contentDigest: 'sha256:x',
        observedAt: '2026-08-28T10:00:00.000Z', durationMs: 1, indexState: 'indexed',
        indexError: null, scripts: ['Latin'],
      }],
      collections: [], entities: [],
    }
    library.freshnessOf({ sourceRevisionId: 's1@r1', freshness: 'current' }, [source])
    library.facetsFor([], [source])
  })

  // ── trajectory, timeline, compare, selection ──────────────────────────────
  await step('projections and comparisons are pure folds', async () => {
    const trajectory = await import('@watchskill/dsh-trajectory')
    const workspace = await import('@watchskill/dsh-workspace')
    const events = [
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'watch_verify', arguments: {}, turn: 1, step: 1 } },
      {
        type: 'tool/result', seq: 2, time: 2,
        data: { turn: 1, message: { source: { callId: 'c1' }, content: [{ content: [{ type: 'text', text: JSON.stringify({ ok: true, verdict: 'VERIFIED', verificationId: 'v1' }) }] }] } },
      },
    ]
    const projection = trajectory.project(events, 's1')
    trajectory.projectionHash(projection)
    workspace.buildTimeline({ sessionId: 's1', events, projection }, 'analysis')
    trajectory.compareProjections(projection, projection, 'run', { leftId: 'a', rightId: 'b' })
  })

  // ── the capability SDK ────────────────────────────────────────────────────
  await step('a third-party capability submits without a network', async () => {
    const sdk = await import('@watchskill/dsh-sdk')
    const gateway = {
      mintEvidence: async () => ({ ok: true, evidenceId: 'ev_1' }),
      readEvidence: async () => null,
      verify: async () => ({ verificationId: 'v', verdict: 'UNVERIFIED', checks: [], evidenceRefs: [], reason: '' }),
      record: () => {},
      health: () => {},
    }
    await sdk.runExample(gateway, {
      sourceRevisionId: 's1@r1',
      subtitles: '1\n00:00:01,000 --> 00:00:02,000\nhello\n',
      capturedAt: '2026-08-28T10:00:00.000Z',
    })
  })

  // ── tenancy: workers, audit, sharing ──────────────────────────────────────
  await step('the worker coordinator and audit log are local', async () => {
    const tenancy = await import('@watchskill/dsh-tenancy')
    const coordinator = new tenancy.Coordinator()
    coordinator.register({
      workerId: 'w1', tenantId: 't1', displayName: 'w', capabilities: [],
      hasGpu: false, vramGb: null, maxConcurrency: 1,
      registeredAt: '2026-08-28T10:00:00.000Z', lastHeartbeatAt: '2026-08-28T10:00:00.000Z',
    })
    coordinator.lease('w1', 1)
    const log = new tenancy.AuditLog()
    log.record(tenancy.accessDenied({
      tenantId: 't1', actorUserId: 'u1', permission: 'evidence.read',
      code: 'cross_tenant', subjectId: 'e1', subjectKind: 'evidence',
      at: '2026-08-28T10:00:00.000Z',
    }))
  })

  // ── the desktop: capability detection and updates ─────────────────────────
  await step('desktop capability detection probes locally only', async () => {
    const desktop = await import('@watchskill/watch-desktop')
    // Version probes of local binaries. None of these may resolve a hostname.
    desktop.detectCapabilities()
    desktop.prepareAppData(join(scratch, 'appdata'))
    desktop.migrationPreflight(join(scratch, 'appdata'))
  })

  await step('the updater verifies a package without fetching one', async () => {
    const desktop = await import('@watchskill/watch-desktop')
    const { generateKeyPairSync, sign, createHash } = await import('node:crypto')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const bytes = Buffer.from('a local package')
    const base = {
      version: '0.2.0',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      schemaVersion: 1,
      signature: '',
      keyId: 'dev-1',
      releasedAt: '2026-08-28T00:00:00.000Z',
    }
    const manifest = {
      ...base,
      signature: sign(null, Buffer.from(desktop.canonicalManifest(base)), privateKey).toString('base64'),
    }
    // An update *check* that called home would appear here. Verification is
    // arithmetic on bytes already present.
    desktop.checkUpdate({
      manifest,
      packageBytes: bytes,
      keys: [{ keyId: 'dev-1', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), production: false }],
      installedVersion: '0.1.0',
      currentSchemaVersion: 1,
      supportedSchemaVersions: [1],
    })
  })

  // ── the generated release artefacts ───────────────────────────────────────
  await step('SBOM and release manifest generate from the local tree', async () => {
    const { spawnSync } = await import('node:child_process')
    for (const script of ['scripts/gen-sbom.mjs', 'scripts/gen-release-manifest.mjs']) {
      const result = spawnSync(process.execPath, [script, '--check'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
      })
      if (result.status !== 0) {
        throw new Error(`${script} --check exited ${String(result.status)}`)
      }
    }
  })

  writeFileSync(
    join(scratch, 'steps.json'),
    JSON.stringify(steps, null, 2),
    'utf8',
  )
  process.stdout.write(`WATCH_OFFLINE_STEPS ${JSON.stringify(steps)}\n`)
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}
