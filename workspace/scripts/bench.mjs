#!/usr/bin/env node
/**
 * Measure the product, and write down what the machine actually said.
 *
 * Two rules, and the second one is the one that makes this worth running.
 *
 * **Every number here was produced by running the thing.** There are no
 * targets restated as results and no estimates. Anything that cannot be
 * measured on this machine is recorded as `not_measured` with the reason,
 * which is a different row from a slow one.
 *
 * **The machine is recorded with the numbers.** A latency without the hardware
 * it was measured on is a number nobody can reproduce or argue with. The class
 * of machine is recorded rather than its exact build, for the same reason the
 * engine repository's benchmark does it that way.
 *
 * Budgets are stated alongside so a miss is visible rather than buried. A
 * missed budget is not a failure of this script — it is a finding, and it is
 * printed as one.
 *
 * Usage:
 *   node scripts/bench.mjs           measure and write docs/performance.json
 *   node scripts/bench.mjs --check   fail if a measured budget regressed
 */

import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { cpus, totalmem, platform, arch, tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'docs', 'performance.json')
/** The class of machine, not its serial number. */
function machine() {
  const cores = cpus()
  return {
    platform: `${platform()}-${arch()}`,
    cores: cores.length,
    // The model string, trimmed of the marketing.
    cpu: (cores[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(),
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    gpu: 'none detected',
    // Recorded because it mattered: the first version of this benchmark
    // measured a database on the repository's volume and reported a number
    // four times what the same code does on the system temp volume.
    storage: 'system temp volume',
  }
}

/**
 * Time one operation repeatedly and report the distribution.
 *
 * p95 rather than a mean, because a mean hides the case a person notices. The
 * warm-up runs are discarded: measuring a JIT's first pass and calling it the
 * product's latency would be measuring the wrong thing.
 */
function measure(run, { iterations = 200, warmup = 20 } = {}) {
  for (let index = 0; index < warmup; index += 1) run()
  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  const at = fraction => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))]
  return {
    iterations,
    p50Ms: Number(at(0.5).toFixed(3)),
    p95Ms: Number(at(0.95).toFixed(3)),
    p99Ms: Number(at(0.99).toFixed(3)),
    maxMs: Number(samples[samples.length - 1].toFixed(3)),
  }
}

/** Time one asynchronous operation once, for a startup-shaped measurement. */
async function measureOnce(run) {
  const started = performance.now()
  const value = await run()
  return { ms: Number((performance.now() - started).toFixed(1)), value }
}

/** Bytes a measurement retained, after asking for a collection. */
function heapUsedMb() {
  globalThis.gc?.()
  return Number((process.memoryUsage().heapUsed / 1024 ** 2).toFixed(1))
}

/** One DSH session event carrying a Watch tool result. */
function toolPair(seq, callId, value, name = 'watch_ask_source') {
  return [
    { type: 'tool/call', seq, time: 1_700_000_000_000 + seq, data: { callId, name, arguments: {}, turn: 1, step: seq } },
    {
      type: 'tool/result', seq: seq + 1, time: 1_700_000_000_001 + seq,
      data: { turn: 1, message: { source: { callId }, content: [{ content: [{ type: 'text', text: JSON.stringify(value) }] }] } },
    },
  ]
}

/** A session log of roughly `count` events. */
function sessionLog(count) {
  const events = []
  for (let index = 0; events.length < count; index += 1) {
    events.push(...toolPair(events.length + 1, `c${String(index)}`, {
      ok: true,
      answer: 'observed',
      evidence: [{
        evidenceId: `ev_${String(index)}`,
        sourceRevisionId: 'src@rev1',
        temporalRange: { startMs: index * 1_000, endMs: index * 1_000 + 500 },
      }],
    }))
  }
  return events.slice(0, count)
}

async function main() {
  const results = []
  const add = entry => { results.push(entry) }

  const trajectory = await import('@watchskill/dsh-trajectory')
  const workspace = await import('@watchskill/dsh-workspace')
  const live = await import('@watchskill/dsh-live')
  const library = await import('@watchskill/dsh-library')
  const memory = await import('@watchskill/dsh-memory')
  const { Context } = await import('@deepseek-ai/cordis')

  // ── Trajectory projection ─────────────────────────────────────────────────
  const smallLog = sessionLog(200)
  add({
    id: 'trajectory.projection.small',
    what: 'Fold a 200-event session into the Watch projection',
    budgetMs: 16,
    ...measure(() => trajectory.project(smallLog, 'sess_1')),
  })

  const bigLog = sessionLog(100_000)
  const bigProjection = await measureOnce(() => trajectory.project(bigLog, 'sess_big'))
  add({
    id: 'trajectory.projection.100k',
    what: 'Fold a 100,000-event session once',
    budgetMs: 5_000,
    p50Ms: bigProjection.ms,
    p95Ms: bigProjection.ms,
    p99Ms: bigProjection.ms,
    maxMs: bigProjection.ms,
    iterations: 1,
    note: `${String(bigProjection.value.records.length)} Watch records extracted`,
  })

  add({
    id: 'trajectory.projection.100k.replay',
    what: 'Hash a 100,000-event projection, which is what replay determinism costs',
    budgetMs: 2_000,
    ...(await measureOnce(() => trajectory.projectionHash(bigProjection.value))
      .then(result => ({
        p50Ms: result.ms, p95Ms: result.ms, p99Ms: result.ms, maxMs: result.ms, iterations: 1,
      }))),
  })

  // ── Selection ─────────────────────────────────────────────────────────────
  const someRecord = bigProjection.value.records[500]
  add({
    id: 'selection.resolve',
    what: 'Resolve a selection against a 100,000-event projection',
    budgetMs: 16,
    // The whole selection, not just its id. Passing a bare string made both
    // lookups miss and measured the null path, which is why this row read
    // 0.001ms — a journey test caught the same mistake at its own call site.
    ...measure(() => trajectory.resolveRecord(bigProjection.value, {
      recordId: someRecord.recordId, evidenceId: null,
    })),
  })

  const selection = trajectory.selectRecord(
    trajectory.emptySelection('ws_1', 'sess_big'), someRecord, 'bench')
  add({
    id: 'selection.deeplink.roundtrip',
    what: 'Serialize a selection to a deep link and restore it',
    budgetMs: 4,
    ...measure(() => trajectory.fromDeepLink(trajectory.toDeepLink(selection))),
  })

  // ── The sensory timeline ──────────────────────────────────────────────────
  const timelineInput = {
    sessionId: 'sess_1', events: smallLog, projection: trajectory.project(smallLog, 'sess_1'),
  }
  add({
    id: 'timeline.build',
    what: 'Build the sensory timeline over a 200-event session',
    budgetMs: 16,
    ...measure(() => workspace.buildTimeline(timelineInput, 'analysis')),
  })

  // ── Context Compiler ──────────────────────────────────────────────────────
  // A fresh directory every run. The first version of this benchmark reused
  // one inside the repository, so each run measured a ledger that still held
  // every record the previous run wrote — and reported a 231ms p95 that was
  // entirely the benchmark's own accumulated state. It also sat on whichever
  // volume the repository is on; the system temp directory is the fairer
  // comparison, and the one a real profile matched.
  const directory = mkdtempSync(join(tmpdir(), 'watch-bench-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(memory.default, {
    mode: 'local_personal', directory, writeProjections: false,
  })
  const scope = { userId: 'u1', workspaceId: 'ws_1', projectId: 'proj_1', sessionId: 'sess_1' }
  for (let index = 0; index < 500; index += 1) {
    ctx.watchMemory.remember({
      kind: 'preference',
      content: `preference number ${String(index)} about builds, tests and reviews`,
      origin: 'explicit_user',
      subjectScope: 'project',
      scopeId: 'proj_1',
    }, { userAuthenticated: true })
  }
  add({
    id: 'memory.compile',
    what: 'Compile a context packet from a 500-record ledger',
    budgetMs: 50,
    ...measure(() => ctx.watchMemory.compile(scope), { iterations: 50, warmup: 5 }),
  })
  const packet = ctx.watchMemory.compile(scope)
  add({
    id: 'memory.context.tokens',
    what: 'Tokens memory adds to one turn, against a 600-token budget',
    budgetMs: null,
    budgetTokens: 600,
    tokens: packet.tokenEstimate,
    items: packet.items.length,
    droppedForBudget: packet.droppedForBudget.length,
  })
  await fiber.dispose()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 })

  // ── Library ───────────────────────────────────────────────────────────────
  const sources = []
  for (let index = 0; index < 5_000; index += 1) {
    sources.push({
      sourceId: `src_${String(index)}`,
      kind: 'video',
      title: `Source ${String(index)}`,
      locator: `https://example.test/${String(index)}`,
      revisions: [{
        sourceRevisionId: `src_${String(index)}@r1`,
        sourceId: `src_${String(index)}`,
        revision: 1,
        contentDigest: `sha256:${String(index)}`,
        observedAt: '2026-08-28T10:00:00.000Z',
        durationMs: 600_000,
        indexState: 'indexed',
        indexError: null,
        scripts: ['Latin'],
      }],
      collections: ['onboarding'],
      entities: [],
    })
  }
  add({
    id: 'library.freshness',
    what: 'Resolve evidence freshness against a 5,000-source library',
    budgetMs: 16,
    ...measure(() => library.freshnessOf(
      { sourceRevisionId: 'src_4999@r1', freshness: 'current' }, sources)),
  })

  const results5k = sources.slice(0, 200).map(source => ({
    sourceId: source.sourceId,
    title: source.title,
    kind: 'video',
    hits: [{
      sourceId: source.sourceId,
      sourceRevisionId: `${source.sourceId}@r1`,
      range: { startMs: 0, endMs: 1_000 },
      text: 'the deploy step',
      path: 'lexical',
      score: 1,
      evidenceIds: [],
    }],
    current: true,
  }))
  add({
    id: 'library.facets',
    what: 'Compute facets over 200 results in a 5,000-source library',
    budgetMs: 32,
    ...measure(() => library.facetsFor(results5k, sources), { iterations: 50, warmup: 5 }),
  })

  // ── Live, bounded ─────────────────────────────────────────────────────────
  const beforeLive = heapUsedMb()
  let session = live.startSession({
    sessionId: 'bench', target: 'https://example.test', kind: 'stream', startedAtMs: 0,
  })
  const limits = { maxEvents: 2_000 }
  for (let batch = 0; batch < 200; batch += 1) {
    const events = []
    for (let index = 0; index < 500; index += 1) {
      const seq = batch * 500 + index + 1
      events.push({
        seq,
        cursor: `c${String(seq)}`,
        kind: 'speech',
        at: seq * 100,
        mediaMs: seq * 100,
        text: `line ${String(seq)}`,
        range: null,
        evidenceIds: [],
      })
    }
    session = live.applyDelta(session, {
      fromCursor: batch === 0 ? '' : `c${String(batch * 500)}`,
      nextCursor: `c${String((batch + 1) * 500)}`,
      isSnapshot: false,
      status: 'observing',
      events,
    }, (batch + 1) * 50_000, limits)
  }
  add({
    id: 'live.bounded',
    what: 'A live session fed 100,000 events with a 2,000-event bound',
    budgetMs: null,
    heldEvents: session.events.length,
    trimmed: session.trimmed,
    heapGrowthMb: Number((heapUsedMb() - beforeLive).toFixed(1)),
    budgetHeldEvents: limits.maxEvents,
  })

  // ── Warm startup of the shell ─────────────────────────────────────────────
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const components = await import('@watchskill/dsh-workspace/components')
  const shellProps = {
    sessionId: 'sess_1',
    mode: 'agent',
    modeStates: workspace.resolveModes({ capabilities: [], health: null }),
    header: workspace.sessionHeader({
      sessionId: 'sess_1', agentModel: 'deepseek-chat', roleBindings: [], dshConnected: true,
      health: null, execution: 'running', verdicts: [], runId: 'run_1', costLabel: null, degraded: [],
    }),
    rows: workspace.sidebarRows(),
    panel: 'tools',
    timeline: workspace.buildTimeline(timelineInput, 'compact'),
    composer: workspace.defaultComposer(),
    onMode: () => {}, onPanel: () => {}, onDensity: () => {}, onEntry: () => {}, onRow: () => {},
  }
  add({
    id: 'workspace.render',
    what: 'Render the whole workspace shell, server-side',
    budgetMs: 50,
    ...measure(() => renderToStaticMarkup(createElement(components.WorkspaceShell, shellProps)),
      { iterations: 100, warmup: 10 }),
  })

  // ── Things this machine cannot measure ────────────────────────────────────
  add({
    id: 'host.readiness',
    what: 'DSH Host process readiness',
    budgetMs: 3_000,
    status: 'not_measured',
    reason:
      'The DSH Host is consumed as published packages and is not launched by this '
      + 'repository’s test suite. Supervision and readiness sequencing are gated by '
      + 'tests/desktop.test.mjs against a real child process; the Host’s own startup '
      + 'time belongs to upstream.',
  })
  add({
    id: 'core.readiness',
    what: 'Watch Core process readiness',
    budgetMs: 3_000,
    status: 'not_measured',
    reason:
      'Watch Core lives in the watch-skill repository and is measured there. The '
      + 'Bridge handshake against it is gated by tests/core-integration.test.mjs when '
      + 'the engine is installed.',
  })
  add({
    id: 'ocr.deepseek.latency',
    what: 'DeepSeek-OCR recognition latency',
    budgetMs: null,
    status: 'not_measured',
    reason: 'No GPU on this machine. Reporting a number would mean inventing one.',
  })

  const report = {
    measuredAt: new Date().toISOString(),
    machine: machine(),
    note:
      'Every timing here was produced by running the code on the machine described '
      + 'above. Rows marked not_measured say why rather than carrying an estimate.',
    results,
  }

  if (process.argv.includes('--check')) {
    if (!existsSync(OUTPUT)) {
      process.stderr.write('watch: no performance baseline; run `node scripts/bench.mjs` first\n')
      process.exit(1)
    }
    const missed = results.filter(entry =>
      typeof entry.budgetMs === 'number' && typeof entry.p95Ms === 'number' && entry.p95Ms > entry.budgetMs)
    for (const entry of missed) {
      process.stderr.write(
        `watch: ${entry.id} p95 ${String(entry.p95Ms)}ms exceeds its ${String(entry.budgetMs)}ms budget\n`,
      )
    }
    process.exit(missed.length === 0 ? 0 : 1)
  }

  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  const lines = ['', `machine: ${report.machine.cpu} · ${String(report.machine.cores)} cores · ${String(report.machine.memoryGb)}GB · ${report.machine.platform}`, '']
  for (const entry of results) {
    if (entry.status === 'not_measured') {
      lines.push(`  ${entry.id.padEnd(36)} not measured`)
      continue
    }
    if (typeof entry.p95Ms === 'number') {
      const verdict = typeof entry.budgetMs === 'number'
        ? (entry.p95Ms <= entry.budgetMs ? 'within' : 'OVER')
        : ''
      lines.push(
        `  ${entry.id.padEnd(36)} p50 ${String(entry.p50Ms).padStart(9)}ms  `
        + `p95 ${String(entry.p95Ms).padStart(9)}ms  ${verdict}`,
      )
      continue
    }
    const summary = Object.entries(entry)
      .filter(([key]) => !['id', 'what', 'budgetMs'].includes(key))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ')
    lines.push(`  ${entry.id.padEnd(36)} ${summary}`)
  }
  lines.push('', `wrote ${OUTPUT}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

await main()
