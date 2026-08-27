/**
 * The OCR engine family: isolation, honesty, and a measurement framework that
 * refuses to report a number nobody measured.
 *
 * This machine has no GPU, so neither DeepSeek engine can be run here. That is
 * a constraint on what can be *measured*, not on what can be *built*, and the
 * two are kept strictly apart below:
 *
 * - The worker supervisor is tested against a real child process that speaks
 *   the protocol and can be told to hang, crash, OOM, announce the wrong
 *   revision or speak the wrong protocol. Every one of those is a process
 *   behaviour, and simulating them with a mock inside the test process would
 *   prove the bookkeeping and nothing about isolation.
 * - The qualification framework is tested against generated fixtures, which is
 *   enough to prove the metrics, the thresholds and the matrix shape.
 * - No test here produces a DeepSeek-OCR result, and one test asserts that no
 *   code path can: an unmeasured cell stays NOT_TESTED.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import {
  CLOUD_OCR,
  DEEPSEEK_OCR,
  DEEPSEEK_OCR2,
  DEFAULT_THRESHOLDS,
  OCR_ENGINES,
  OCR_WORKLOADS,
  OcrWorker,
  RAPID_OCR,
  SCRIPTS,
  TESSERACT,
  WORKER_PROTOCOL,
  buildMatrix,
  characterErrorRate,
  coverageOf,
  customOcrEngine,
  describeCoverage,
  hallucinationRate,
  installPlan,
  isEngineUsable,
  layoutF1,
  mayDistributeWeights,
  mayRunInProcess,
  omissionRate,
  qualify,
  readingOrderScore,
  regionIou,
  routeOcr,
  scoreObservation,
  thresholdFailures,
  untestedHealth,
  wordAccuracy,
  wordErrorRate,
} from '@watchskill/dsh-technology'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'fixtures', 'ocr-worker-stub.mjs')

/** A descriptor pinned to the revision the stub announces by default. */
function pinnedDescriptor(overrides = {}) {
  return {
    ...DEEPSEEK_OCR,
    id: 'ocr.stub',
    provenance: { ...DEEPSEEK_OCR.provenance, revision: 'pinned-revision' },
    ...overrides,
  }
}

/** Build a supervisor over the stub in one of its modes. */
function worker(mode, options = {}) {
  return new OcrWorker({
    descriptor: pinnedDescriptor(options.descriptor ?? {}),
    spawn: {
      command: process.execPath,
      args: [STUB, mode, options.revision ?? 'pinned-revision'],
    },
    startTimeoutMs: options.startTimeoutMs ?? 4_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    cancelGraceMs: options.cancelGraceMs ?? 300,
  })
}

// ── isolation and lifecycle ─────────────────────────────────────────────────

describe('the worker runs somewhere its death costs nothing', () => {
  test('a healthy worker announces itself and becomes ready', async () => {
    const engine = worker('ok')
    try {
      const started = await engine.start()
      assert.equal(started.ok, true)
      assert.equal(started.value.protocol, WORKER_PROTOCOL)
      assert.equal(engine.status().state, 'ready')
      assert.equal(engine.loadedRevision(), 'pinned-revision')
    } finally {
      await engine.stop()
    }
  })

  test('a real recognition is what earns machine_tested', async () => {
    const engine = worker('ok')
    try {
      await engine.start()
      assert.equal(engine.status().state, 'ready')
      const result = await engine.recognize({ expect: 'hello world' })
      assert.equal(result.ok, true)
      assert.equal(result.value.text, 'hello world')
      assert.equal(engine.status().state, 'machine_tested')
      assert.equal(engine.status().usable, true)
    } finally {
      await engine.stop()
    }
  })

  test('a worker that never announces itself is unavailable, with a fix', async () => {
    const engine = worker('silent', { startTimeoutMs: 300 })
    try {
      const started = await engine.start()
      assert.equal(started.ok, false)
      assert.equal(started.error.code, 'start_timeout')
      assert.equal(engine.status().state, 'unavailable')
      assert.notEqual(engine.status().fix, '')
    } finally {
      await engine.stop()
    }
  })

  test('a worker that loaded a different revision is refused', async () => {
    const engine = worker('wrong-revision')
    try {
      const started = await engine.start()
      assert.equal(started.ok, false)
      assert.equal(started.error.code, 'revision_mismatch')
      assert.equal(started.error.retryable, false)
      assert.match(engine.status().detail, /pinned-revision/)
    } finally {
      await engine.stop()
    }
  })

  test('a worker speaking another protocol is refused', async () => {
    const engine = worker('wrong-protocol')
    try {
      const started = await engine.start()
      assert.equal(started.ok, false)
      assert.equal(started.error.code, 'protocol_mismatch')
    } finally {
      await engine.stop()
    }
  })

  test('an unpinned descriptor accepts whatever loaded, and says what it was', async () => {
    const engine = worker('ok', {
      descriptor: { provenance: { ...DEEPSEEK_OCR.provenance, revision: null } },
      revision: 'whatever-was-installed',
    })
    try {
      const started = await engine.start()
      assert.equal(started.ok, true)
      assert.equal(engine.loadedRevision(), 'whatever-was-installed')
    } finally {
      await engine.stop()
    }
  })

  test('a library printing to stdout does not break the protocol', async () => {
    const engine = worker('noisy')
    try {
      const started = await engine.start()
      assert.equal(started.ok, true)
      assert.match(engine.log(), /Loading checkpoint shards/)
    } finally {
      await engine.stop()
    }
  })

  test('recognizing before starting refuses rather than hanging', async () => {
    const engine = worker('ok')
    const result = await engine.recognize({})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'not_started')
    assert.equal(result.error.retryable, true)
  })
})

describe('failure is reported as what it was, and never retried', () => {
  test('a crash degrades the engine and is not retryable', async () => {
    const engine = worker('crash')
    try {
      await engine.start()
      const result = await engine.recognize({})
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'worker_error')
      // The exit is what moves the health, and it says which code.
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(engine.status().state, 'degraded')
      assert.match(engine.status().detail, /exited with code 3/)
      assert.equal(engine.status().usable, false)
    } finally {
      await engine.stop()
    }
  })

  test('being killed for memory is distinguished from an ordinary crash', async () => {
    const engine = worker('oom')
    try {
      await engine.start()
      await engine.recognize({})
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(engine.status().state, 'degraded')
      assert.match(engine.status().detail, /killed for memory/)
      assert.match(engine.status().fix, /lighter engine|more memory/)
    } finally {
      await engine.stop()
    }
  })

  test('a hang times out with a fix, not a hang', async () => {
    const engine = worker('hang', { requestTimeoutMs: 200 })
    try {
      await engine.start()
      const result = await engine.recognize({})
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'timeout')
      assert.equal(result.error.retryable, false, 'a timeout invited a blind retry')
      assert.notEqual(result.error.fix, '')
    } finally {
      await engine.stop()
    }
  })

  test('a cancel is answered cooperatively when the worker cooperates', async () => {
    const engine = worker('hang', { requestTimeoutMs: 5_000, cancelGraceMs: 2_000 })
    try {
      await engine.start()
      const controller = new AbortController()
      const pending = engine.recognize({}, { signal: controller.signal })
      setTimeout(() => { controller.abort() }, 30)
      const result = await pending
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'worker_error')
    } finally {
      await engine.stop()
    }
  })

  test('a worker that ignores a cancel is killed by its handle', async () => {
    const engine = worker('uncancellable', { requestTimeoutMs: 10_000, cancelGraceMs: 150 })
    try {
      await engine.start()
      const controller = new AbortController()
      const pending = engine.recognize({}, { signal: controller.signal })
      setTimeout(() => { controller.abort() }, 30)
      const result = await pending
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'cancelled')
    } finally {
      await engine.stop()
    }
  })

  test('cancelling before dispatch never starts the work', async () => {
    const engine = worker('ok')
    try {
      await engine.start()
      const controller = new AbortController()
      controller.abort()
      const result = await engine.recognize({}, { signal: controller.signal })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'cancelled')
    } finally {
      await engine.stop()
    }
  })

  test('an untested engine says untested, which is not unavailable', () => {
    const health = untestedHealth('ocr.deepseek-ocr', '2026-08-27T00:00:00Z')
    assert.equal(health.state, 'not_tested')
    assert.equal(health.usable, false)
    assert.notEqual(health.fix, '')
    assert.equal(isEngineUsable('not_tested'), false)
    assert.equal(isEngineUsable('probed'), false)
    assert.equal(isEngineUsable('ready'), true)
    assert.equal(isEngineUsable('machine_tested'), true)
    assert.equal(isEngineUsable('degraded'), false)
  })
})

// ── the engine family ───────────────────────────────────────────────────────

describe('the engine family and what may run where', () => {
  test('every route the vision names is present', () => {
    const ids = OCR_ENGINES.map(engine => engine.id)
    for (const expected of ['ocr.rapidocr', 'ocr.tesseract', 'ocr.deepseek-ocr', 'ocr.deepseek-ocr2', 'ocr.cloud']) {
      assert.ok(ids.includes(expected), `missing ${expected}`)
    }
  })

  test('only a built-in library may run in the host process', () => {
    assert.equal(mayRunInProcess(RAPID_OCR), true)
    assert.equal(mayRunInProcess(TESSERACT), false, 'a local process is not in-process')
    assert.equal(mayRunInProcess(DEEPSEEK_OCR), false)
    assert.equal(mayRunInProcess(DEEPSEEK_OCR2), false)
    assert.equal(mayRunInProcess(CLOUD_OCR), false)
  })

  test('both DeepSeek engines are isolated, because their code is fetched', () => {
    for (const engine of [DEEPSEEK_OCR, DEEPSEEK_OCR2]) {
      assert.equal(engine.trust, 'isolated')
      assert.equal(engine.runtime, 'local_process')
      assert.notEqual(engine.provenance.revision, null, 'an isolated engine must be pinned')
    }
  })

  test('the weight distribution gate still refuses both', () => {
    assert.equal(mayDistributeWeights(DEEPSEEK_OCR), false)
    assert.equal(mayDistributeWeights(DEEPSEEK_OCR2), false)
    assert.equal(mayDistributeWeights(RAPID_OCR), true)
  })

  test('a custom engine cannot declare itself trusted', () => {
    const custom = customOcrEngine({
      id: 'ocr.vendor',
      displayName: 'Vendor OCR',
      version: '1.0',
      runtime: 'local_library',
      hardware: { gpu: 'none', minVramGb: null, minRamGb: 1, accelerators: [] },
      privacy: { egress: 'none', worksOffline: true, requiresEgressConsent: false },
      provenance: {
        codeLicense: 'MIT', weightsLicense: 'MIT', revision: 'v1',
        sourceUrl: 'https://example.test', weightsLicenseReviewed: true,
      },
      resources: { maxConcurrency: 1, timeoutMs: 30_000, maxMemoryMb: 512 },
      probeMethod: 'import check',
      testMethod: 'fixture image',
    })
    assert.equal(custom.trust, 'untrusted')
    assert.equal(custom.install.automatic, false)
    assert.equal(mayRunInProcess(custom), false)
  })

  test('the cloud route is excluded offline and without consent', () => {
    const health = new Map(OCR_ENGINES.map(engine => [engine.id, { usable: true, state: 'ready' }]))
    const base = { workload: 'document', scripts: ['Latin'], quality: 'best', hasGpu: false }

    const offline = routeOcr({ ...base, offlineOnly: true, egressConsent: true }, OCR_ENGINES, [], health)
    assert.notEqual(offline.engineId, 'ocr.cloud')
    assert.ok(offline.excluded.some(x => x.engineId === 'ocr.cloud' && /offline/.test(x.reason)))

    const noConsent = routeOcr({ ...base, offlineOnly: false, egressConsent: false }, OCR_ENGINES, [], health)
    assert.notEqual(noConsent.engineId, 'ocr.cloud')
    assert.ok(noConsent.excluded.some(x => x.engineId === 'ocr.cloud' && /consent/.test(x.reason)))
  })

  test('a degraded engine is routed around, with the reason recorded', () => {
    const health = new Map([
      ['ocr.rapidocr', { usable: false, state: 'degraded' }],
      ['ocr.tesseract', { usable: true, state: 'ready' }],
    ])
    const decision = routeOcr(
      { workload: 'ui_text', scripts: ['Latin'], quality: 'fast', hasGpu: false, offlineOnly: true, egressConsent: false },
      [RAPID_OCR, TESSERACT],
      [],
      health,
    )
    assert.equal(decision.engineId, 'ocr.tesseract')
    assert.ok(decision.excluded.some(x => x.engineId === 'ocr.rapidocr' && /degraded/.test(x.reason)))
  })

  test('with no GPU, neither DeepSeek engine can be selected', () => {
    const health = new Map(OCR_ENGINES.map(engine => [engine.id, { usable: true, state: 'ready' }]))
    const decision = routeOcr(
      { workload: 'document', scripts: ['Latin'], quality: 'best', hasGpu: false, offlineOnly: true, egressConsent: false },
      OCR_ENGINES,
      [],
      health,
    )
    assert.equal(['ocr.deepseek-ocr', 'ocr.deepseek-ocr2'].includes(decision.engineId), false)
    assert.match(decision.reason, /unqualified|qualified/)
  })
})

describe('install is described, never performed', () => {
  test('nothing is automatic, at the type level and at runtime', () => {
    const plan = installPlan(DEEPSEEK_OCR, { hasGpu: true, vramGb: 24 })
    assert.equal(plan.automatic, false)
    for (const step of plan.steps) assert.equal(step.command, null)
  })

  test('an unreviewed weight licence blocks the plan before hardware is even considered', () => {
    const plan = installPlan(DEEPSEEK_OCR, { hasGpu: true, vramGb: 24 })
    assert.ok(plan.blockers.some(blocker => /weight licence .* has not been reviewed/.test(blocker)))
    assert.match(plan.blockers[0], /DeepSeek-OCR/)
  })

  test('missing hardware is a blocker with the actual numbers', () => {
    const plan = installPlan(DEEPSEEK_OCR, { hasGpu: false, vramGb: null })
    assert.ok(plan.blockers.some(blocker => /requires a GPU/.test(blocker)))

    const small = installPlan(DEEPSEEK_OCR, { hasGpu: true, vramGb: 6 })
    assert.ok(small.blockers.some(blocker => /needs 12GB of VRAM; 6GB was detected/.test(blocker)))
  })

  test('a package-manager engine with a reviewed licence has no blockers', () => {
    const plan = installPlan(RAPID_OCR, { hasGpu: false, vramGb: null })
    assert.deepEqual([...plan.blockers], [])
  })
})

// ── the measurement framework ───────────────────────────────────────────────

describe('the metrics', () => {
  test('character error rate counts code points, not UTF-16 units', () => {
    assert.equal(characterErrorRate('abc', 'abc'), 0)
    assert.equal(characterErrorRate('abc', 'abd'), 1 / 3)
    // An emoji is one character. Scoring it as two would make an engine that
    // read it perfectly look half wrong.
    assert.equal(characterErrorRate('a😀b', 'a😀b'), 0)
    assert.equal(characterErrorRate('a😀b', 'axb'), 1 / 3)
  })

  test('error rate does not fold away diacritics or case', () => {
    assert.ok(characterErrorRate('مُحَمَّد', 'محمد') > 0, 'dropped diacritics scored as perfect')
    assert.ok(characterErrorRate('Deploy', 'deploy') > 0)
  })

  test('word error rate and word accuracy answer different questions', () => {
    assert.equal(wordErrorRate('the deploy succeeded', 'the deploy succeeded'), 0)
    assert.equal(wordAccuracy('the deploy succeeded', 'succeeded deploy the'), 1,
      'word accuracy should ignore order')
    assert.ok(wordErrorRate('the deploy succeeded', 'succeeded deploy the') > 0,
      'word error rate should not ignore order')
  })

  test('region IoU is zero for disjoint boxes and one for identical ones', () => {
    const box = { x: 0, y: 0, width: 10, height: 10 }
    assert.equal(regionIou(box, box), 1)
    assert.equal(regionIou(box, { x: 100, y: 100, width: 10, height: 10 }), 0)
    assert.ok(regionIou(box, { x: 5, y: 0, width: 10, height: 10 }) > 0.3)
  })

  test('layout F1 penalises both misses and extras', () => {
    const expected = [
      { text: 'a', bbox: { x: 0, y: 0, width: 10, height: 10 }, order: 0 },
      { text: 'b', bbox: { x: 0, y: 20, width: 10, height: 10 }, order: 1 },
    ]
    assert.equal(layoutF1(expected, expected), 1)
    assert.ok(layoutF1(expected, [expected[0]]) < 1, 'a miss scored perfectly')
    assert.ok(layoutF1([expected[0]], expected) < 1, 'an extra scored perfectly')
  })

  test('reading order catches a two-column document read across', () => {
    const expected = [
      { text: 'left-1', bbox: { x: 0, y: 0, width: 10, height: 10 }, order: 0 },
      { text: 'left-2', bbox: { x: 0, y: 20, width: 10, height: 10 }, order: 1 },
      { text: 'right-1', bbox: { x: 50, y: 0, width: 10, height: 10 }, order: 2 },
      { text: 'right-2', bbox: { x: 50, y: 20, width: 10, height: 10 }, order: 3 },
    ]
    assert.equal(readingOrderScore(expected, expected), 1)
    const acrossTheColumns = [expected[0], expected[2], expected[1], expected[3]]
    assert.ok(readingOrderScore(expected, acrossTheColumns) < 1,
      'reading straight across two columns scored as correct order')
  })

  test('omission and hallucination are separate numbers', () => {
    const expected = [
      { text: 'a', bbox: { x: 0, y: 0, width: 10, height: 10 }, order: 0 },
      { text: 'b', bbox: { x: 0, y: 20, width: 10, height: 10 }, order: 1 },
    ]
    const dropped = [expected[0]]
    assert.equal(omissionRate(expected, dropped), 0.5)
    assert.equal(hallucinationRate(expected, dropped), 0)

    const invented = [...expected, { text: 'never on the page', bbox: { x: 0, y: 40, width: 10, height: 10 }, order: 2 }]
    assert.equal(omissionRate(expected, invented), 0)
    assert.ok(hallucinationRate(expected, invented) > 0)
  })
})

describe('qualification refuses to invent a result', () => {
  function fixture(id, workload, script, overrides = {}) {
    return {
      fixtureId: id,
      workload,
      script,
      expectedText: 'Deploy succeeded',
      regions: [{ text: 'Deploy succeeded', bbox: { x: 0, y: 0, width: 100, height: 20 }, order: 0 }],
      imageDigest: `sha256:${id}`,
      ...overrides,
    }
  }

  function observation(id, text, regions, overrides = {}) {
    return {
      fixtureId: id,
      text,
      regions,
      latencyMs: 40,
      peakRamMb: 200,
      peakVramMb: null,
      crashed: false,
      ...overrides,
    }
  }

  const CONTEXT = { measuredAt: '2026-08-27T12:00:00.000Z', measuredOn: 'a laptop with no GPU' }

  test('a cell nobody ran is NOT_TESTED, with null timestamps and no metrics', () => {
    const cell = qualify('ocr.deepseek-ocr', 'document', 'Arabic', [], CONTEXT)
    assert.equal(cell.state, 'NOT_TESTED')
    assert.deepEqual(cell.metrics, {})
    assert.equal(cell.measuredAt, null)
    assert.equal(cell.measuredOn, null)
  })

  test('runs with no measurement context still produce NOT_TESTED', () => {
    const f = fixture('f1', 'document', 'Latin')
    const runs = [{ fixture: f, metrics: scoreObservation(f, observation('f1', f.expectedText, f.regions)) }]
    assert.equal(qualify('ocr.stub', 'document', 'Latin', runs, null).state, 'NOT_TESTED')
  })

  test('a clean run qualifies, and the number is attributable', () => {
    const f = fixture('f1', 'document', 'Latin')
    const runs = [{ fixture: f, metrics: scoreObservation(f, observation('f1', f.expectedText, f.regions)) }]
    const cell = qualify('ocr.stub', 'document', 'Latin', runs, CONTEXT)
    assert.equal(cell.state, 'QUALIFIED')
    assert.equal(cell.measuredOn, 'a laptop with no GPU')
    assert.equal(cell.metrics.fixtures, 1)
  })

  test('hallucination disqualifies outright, however good everything else is', () => {
    const f = fixture('f1', 'document', 'Latin')
    const invented = [
      ...f.regions,
      { text: 'Contact support at 555-0100', bbox: { x: 0, y: 30, width: 100, height: 20 }, order: 1 },
    ]
    const metrics = scoreObservation(f, observation('f1', f.expectedText, invented))
    const cell = qualify('ocr.stub', 'document', 'Latin', [{ fixture: f, metrics }], CONTEXT)
    assert.equal(cell.state, 'NOT_YET_QUALIFIED')
    assert.ok(cell.limitations.some(limitation => /hallucination/.test(limitation)))
    assert.ok(cell.limitations.some(limitation => /indistinguishable from a reading/.test(limitation)))
  })

  test('a crash on a fixture disqualifies', () => {
    const f = fixture('f1', 'document', 'Latin')
    const metrics = scoreObservation(f, observation('f1', f.expectedText, f.regions, { crashed: true }))
    const cell = qualify('ocr.stub', 'document', 'Latin', [{ fixture: f, metrics }], CONTEXT)
    assert.equal(cell.state, 'NOT_YET_QUALIFIED')
  })

  test('one weak metric is a limitation rather than a disqualification', () => {
    const f = fixture('f1', 'document', 'Latin')
    // Reading order is wrong; everything else is fine.
    const twoRegions = {
      ...f,
      regions: [
        { text: 'first', bbox: { x: 0, y: 0, width: 10, height: 10 }, order: 0 },
        { text: 'second', bbox: { x: 0, y: 20, width: 10, height: 10 }, order: 1 },
        { text: 'third', bbox: { x: 0, y: 40, width: 10, height: 10 }, order: 2 },
      ],
      expectedText: 'first second third',
    }
    const reordered = [twoRegions.regions[2], twoRegions.regions[0], twoRegions.regions[1]]
    const metrics = scoreObservation(twoRegions, observation('f1', 'first second third', reordered))
    const cell = qualify('ocr.stub', 'document', 'Latin', [{ fixture: twoRegions, metrics }], CONTEXT)
    assert.equal(cell.state, 'QUALIFIED_WITH_LIMITATIONS')
  })

  test('hallucination is held to a tighter bound than any accuracy metric', () => {
    assert.ok(DEFAULT_THRESHOLDS.maxHallucinationRate < DEFAULT_THRESHOLDS.maxCer)
    assert.ok(DEFAULT_THRESHOLDS.maxHallucinationRate < DEFAULT_THRESHOLDS.maxOmissionRate)
  })

  test('a threshold failure says the actual number', () => {
    const failures = thresholdFailures({
      cer: 0.4, wer: 0.4, wordAccuracy: 0.5, layoutF1: 0.2, readingOrder: 0.3,
      omissionRate: 0.4, hallucinationRate: 0.3, latencyMs: 10,
      peakRamMb: null, peakVramMb: null, crashed: false,
    })
    assert.ok(failures.some(failure => /0\.400/.test(failure)))
  })
})

describe('the matrix says how little it knows', () => {
  test('every workload and script has a cell, measured or not', () => {
    const matrix = buildMatrix('ocr.deepseek-ocr', [], null)
    assert.equal(matrix.length, OCR_WORKLOADS.length * SCRIPTS.length)
    for (const cell of matrix) assert.equal(cell.state, 'NOT_TESTED')
  })

  test('every script the vision names is in the matrix', () => {
    for (const script of ['Latin', 'Arabic', 'Han_Simplified', 'Japanese', 'Korean', 'Cyrillic', 'Devanagari', 'Thai', 'Greek', 'Hebrew', 'Mixed']) {
      assert.ok(SCRIPTS.includes(script), `missing script ${script}`)
    }
  })

  test('every workload the vision names is in the matrix', () => {
    for (const workload of ['ui_text', 'browser_form', 'subtitles', 'document', 'table', 'reading_order', 'low_resolution', 'dark_mode', 'mixed_script']) {
      assert.ok(OCR_WORKLOADS.includes(workload), `missing workload ${workload}`)
    }
  })

  test('coverage leads with what was not measured', () => {
    const empty = coverageOf(buildMatrix('ocr.deepseek-ocr', [], null))
    assert.equal(empty.measured, 0)
    assert.equal(empty.notTested, empty.total)
    assert.match(describeCoverage(empty), /none run/)
  })

  test('measuring one cell does not qualify the engine', () => {
    const f = {
      fixtureId: 'f1', workload: 'document', script: 'Latin',
      expectedText: 'Deploy succeeded',
      regions: [{ text: 'Deploy succeeded', bbox: { x: 0, y: 0, width: 100, height: 20 }, order: 0 }],
      imageDigest: 'sha256:f1',
    }
    const metrics = scoreObservation(f, {
      fixtureId: 'f1', text: f.expectedText, regions: f.regions,
      latencyMs: 10, peakRamMb: null, peakVramMb: null, crashed: false,
    })
    const matrix = buildMatrix('ocr.stub', [{ fixture: f, metrics }], {
      measuredAt: '2026-08-27T12:00:00.000Z', measuredOn: 'a laptop with no GPU',
    })
    const coverage = coverageOf(matrix)
    assert.equal(coverage.qualified, 1)
    assert.equal(coverage.measured, 1)
    assert.ok(coverage.notTested > 100)
    assert.match(describeCoverage(coverage), /1 of \d+ cell\(s\) measured/)
  })

  test('no DeepSeek result exists on this machine, and none can be manufactured', () => {
    // The engines are present, pinned and describable. Nothing has run.
    for (const engine of [DEEPSEEK_OCR, DEEPSEEK_OCR2]) {
      const matrix = buildMatrix(engine.id, [], null)
      assert.equal(coverageOf(matrix).measured, 0)
      for (const cell of matrix) {
        assert.equal(cell.metrics.cer, undefined, 'a metric appeared without a run')
        assert.equal(cell.measuredOn, null)
      }
    }
  })
})
