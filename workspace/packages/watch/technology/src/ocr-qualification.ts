/**
 * Measuring an OCR engine, and refusing to report a number nobody measured.
 *
 * The framework exists in full here even though this machine has no GPU, and
 * that is deliberate rather than aspirational. The scoring, the matrix shape,
 * the aggregation and — most importantly — the rules about what may be
 * *claimed* are all testable without a model, using generated fixtures. What
 * cannot be produced here is a DeepSeek-OCR result, and no code path below can
 * manufacture one: a cell without a real run stays `NOT_TESTED`, which is a
 * different answer from `NOT_YET_QUALIFIED`.
 *
 * Two measurement decisions are worth stating.
 *
 * **Omission and hallucination are separate metrics.** Character error rate
 * folds them together, and they are not the same failure. An engine that drops
 * a line produces text a person will notice is short. An engine that invents a
 * plausible line produces text nobody can distinguish from a reading — which,
 * in a product whose whole claim is evidence, is the worse of the two by a
 * long way.
 *
 * **Nothing is averaged across scripts.** An engine that is excellent on Latin
 * and unusable on Arabic has a fine average and is unusable for half the
 * world. Every cell is one engine on one workload in one script, and there is
 * no function here that produces a single overall score.
 *
 * @module @watchskill/dsh-technology/ocr-qualification
 */

import type { OcrWorkload, QualificationEntry, QualificationState, ScriptTag } from './ocr.js'
import { OCR_WORKLOADS, SCRIPTS } from './ocr.js'

/** One region a fixture expects to be read. */
export interface ExpectedRegion {
  readonly text: string
  readonly bbox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** Position in reading order, from zero. */
  readonly order: number
}

/** One measurement case. */
export interface OcrFixture {
  readonly fixtureId: string
  readonly workload: OcrWorkload
  readonly script: ScriptTag
  /** What the image says, exactly, in its original script. */
  readonly expectedText: string
  readonly regions: readonly ExpectedRegion[]
  /** Digest of the image, so a result is attributable to an exact input. */
  readonly imageDigest: string
}

/** What an engine produced for one fixture. */
export interface OcrObservation {
  readonly fixtureId: string
  readonly text: string
  readonly regions: readonly ExpectedRegion[]
  readonly latencyMs: number
  readonly peakRamMb: number | null
  readonly peakVramMb: number | null
  /** True when the worker died producing this. */
  readonly crashed: boolean
}

// ── metrics ─────────────────────────────────────────────────────────────────

/** Levenshtein distance, iterative and allocation-light. */
function distance(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1)
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      current.push(Math.min(substitution, deletion, insertion))
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

/**
 * Character error rate.
 *
 * Compared over Unicode code points rather than UTF-16 units, so a fixture in
 * an astral script is not scored as twice as long as it is. Not normalized,
 * not case-folded, not stripped of diacritics: an engine that drops Arabic
 * diacritics has changed the text, and a metric that folded them would score
 * that as perfect.
 */
export function characterErrorRate(expected: string, actual: string): number {
  // Code points, deliberately. Character error rate is defined over code
  // points, and grapheme segmentation would score a decomposed sequence as one
  // unit — which is exactly the difference an OCR engine got wrong.
  /* eslint-disable @typescript-eslint/no-misused-spread */
  const left = [...expected]
  if (left.length === 0) return [...actual].length === 0 ? 0 : 1
  return distance(left, [...actual]) / left.length
  /* eslint-enable @typescript-eslint/no-misused-spread */
}

/** Word error rate, over whitespace-separated tokens. */
export function wordErrorRate(expected: string, actual: string): number {
  const left = expected.split(/\s+/).filter(token => token !== '')
  if (left.length === 0) return actual.trim() === '' ? 0 : 1
  return distance(left, actual.split(/\s+/).filter(token => token !== '')) / left.length
}

/** Proportion of expected words reproduced exactly, in any position. */
export function wordAccuracy(expected: string, actual: string): number {
  const wanted = expected.split(/\s+/).filter(token => token !== '')
  if (wanted.length === 0) return 1
  const available = new Map<string, number>()
  for (const token of actual.split(/\s+/).filter(token => token !== '')) {
    available.set(token, (available.get(token) ?? 0) + 1)
  }
  let found = 0
  for (const token of wanted) {
    const remaining = available.get(token) ?? 0
    if (remaining > 0) {
      available.set(token, remaining - 1)
      found += 1
    }
  }
  return found / wanted.length
}

/** Intersection over union of two rectangles. */
export function regionIou(
  left: ExpectedRegion['bbox'],
  right: ExpectedRegion['bbox'],
): number {
  const x1 = Math.max(left.x, right.x)
  const y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width)
  const y2 = Math.min(left.y + left.height, right.y + right.height)
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = left.width * left.height + right.width * right.height - overlap
  return union === 0 ? 0 : overlap / union
}

/**
 * Layout F1 at an IoU threshold.
 *
 * A detected region counts as a match when it overlaps an expected one by at
 * least the threshold and no earlier detection already claimed it. Greedy
 * rather than optimal assignment: the difference is small in practice and the
 * greedy version is one function a reader can check.
 */
export function layoutF1(
  expected: readonly ExpectedRegion[],
  actual: readonly ExpectedRegion[],
  threshold = 0.5,
): number {
  if (expected.length === 0 && actual.length === 0) return 1
  if (expected.length === 0 || actual.length === 0) return 0

  const claimed = new Set<number>()
  let matched = 0
  for (const detection of actual) {
    let best = -1
    let bestIou = threshold
    for (const [index, region] of expected.entries()) {
      if (claimed.has(index)) continue
      const iou = regionIou(region.bbox, detection.bbox)
      if (iou >= bestIou) { bestIou = iou; best = index }
    }
    if (best !== -1) { claimed.add(best); matched += 1 }
  }

  const precision = matched / actual.length
  const recall = matched / expected.length
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
}

/**
 * How well reading order was preserved, as Kendall tau normalized to 0–1.
 *
 * Reading order is where an engine that scores well on characters can still be
 * useless: a two-column document read straight across produces every word and
 * no meaning.
 */
export function readingOrderScore(
  expected: readonly ExpectedRegion[],
  actual: readonly ExpectedRegion[],
): number {
  const position = new Map(expected.map(region => [region.text, region.order]))
  const sequence = actual
    .map(region => position.get(region.text))
    .filter((order): order is number => order !== undefined)
  if (sequence.length < 2) return sequence.length === expected.length ? 1 : 0

  let concordant = 0
  let discordant = 0
  for (let i = 0; i < sequence.length; i += 1) {
    for (let j = i + 1; j < sequence.length; j += 1) {
      const a = sequence[i] ?? 0
      const b = sequence[j] ?? 0
      if (a < b) concordant += 1
      else if (a > b) discordant += 1
    }
  }
  const pairs = concordant + discordant
  return pairs === 0 ? 1 : (concordant - discordant) / pairs / 2 + 0.5
}

/**
 * Proportion of expected regions the engine did not produce at all.
 *
 * Kept apart from CER because a person can see that a result is short.
 */
export function omissionRate(
  expected: readonly ExpectedRegion[],
  actual: readonly ExpectedRegion[],
): number {
  if (expected.length === 0) return 0
  const produced = new Set(actual.map(region => region.text))
  const missing = expected.filter(region => !produced.has(region.text)).length
  return missing / expected.length
}

/**
 * Proportion of produced regions that correspond to nothing expected.
 *
 * The metric that matters most in this product. An engine that invents a
 * plausible line produces text nobody can distinguish from a reading, and a
 * reading is what the rest of the system treats as evidence.
 */
export function hallucinationRate(
  expected: readonly ExpectedRegion[],
  actual: readonly ExpectedRegion[],
): number {
  if (actual.length === 0) return 0
  const wanted = new Set(expected.map(region => region.text))
  return actual.filter(region => !wanted.has(region.text)).length / actual.length
}

/** Every metric, for one fixture. */
export interface MetricSet {
  readonly cer: number
  readonly wer: number
  readonly wordAccuracy: number
  readonly layoutF1: number
  readonly readingOrder: number
  readonly omissionRate: number
  readonly hallucinationRate: number
  readonly latencyMs: number
  readonly peakRamMb: number | null
  readonly peakVramMb: number | null
  readonly crashed: boolean
}

/** Score one observation against its fixture. */
export function scoreObservation(
  fixture: OcrFixture,
  observation: OcrObservation,
): MetricSet {
  return {
    cer: characterErrorRate(fixture.expectedText, observation.text),
    wer: wordErrorRate(fixture.expectedText, observation.text),
    wordAccuracy: wordAccuracy(fixture.expectedText, observation.text),
    layoutF1: layoutF1(fixture.regions, observation.regions),
    readingOrder: readingOrderScore(fixture.regions, observation.regions),
    omissionRate: omissionRate(fixture.regions, observation.regions),
    hallucinationRate: hallucinationRate(fixture.regions, observation.regions),
    latencyMs: observation.latencyMs,
    peakRamMb: observation.peakRamMb,
    peakVramMb: observation.peakVramMb,
    crashed: observation.crashed,
  }
}

// ── thresholds ──────────────────────────────────────────────────────────────

/** What a cell has to clear to be qualified. */
export interface QualificationThresholds {
  readonly maxCer: number
  readonly minWordAccuracy: number
  readonly minLayoutF1: number
  readonly minReadingOrder: number
  /** Deliberately the tightest bound in the table. */
  readonly maxHallucinationRate: number
  readonly maxOmissionRate: number
}

/**
 * The default bar.
 *
 * Hallucination is held to a far tighter bound than any accuracy metric. An
 * engine that reads 92% of a page correctly is useful; an engine that invents
 * 5% of a page is dangerous, because the invented part looks exactly like the
 * read part to everything downstream.
 */
export const DEFAULT_THRESHOLDS: QualificationThresholds = {
  maxCer: 0.05,
  minWordAccuracy: 0.95,
  minLayoutF1: 0.8,
  minReadingOrder: 0.9,
  maxHallucinationRate: 0.01,
  maxOmissionRate: 0.05,
}

/** Which thresholds a metric set failed, in the words a report would use. */
export function thresholdFailures(
  metrics: MetricSet,
  thresholds: QualificationThresholds = DEFAULT_THRESHOLDS,
): readonly string[] {
  const failures: string[] = []
  if (metrics.crashed) failures.push('the worker crashed on this fixture')
  if (metrics.cer > thresholds.maxCer) {
    failures.push(`character error rate ${metrics.cer.toFixed(3)} exceeds ${String(thresholds.maxCer)}`)
  }
  if (metrics.wordAccuracy < thresholds.minWordAccuracy) {
    failures.push(`word accuracy ${metrics.wordAccuracy.toFixed(3)} below ${String(thresholds.minWordAccuracy)}`)
  }
  if (metrics.layoutF1 < thresholds.minLayoutF1) {
    failures.push(`layout F1 ${metrics.layoutF1.toFixed(3)} below ${String(thresholds.minLayoutF1)}`)
  }
  if (metrics.readingOrder < thresholds.minReadingOrder) {
    failures.push(`reading order ${metrics.readingOrder.toFixed(3)} below ${String(thresholds.minReadingOrder)}`)
  }
  if (metrics.hallucinationRate > thresholds.maxHallucinationRate) {
    failures.push(
      `hallucination rate ${metrics.hallucinationRate.toFixed(3)} exceeds `
      + `${String(thresholds.maxHallucinationRate)} — invented text is indistinguishable from a reading`,
    )
  }
  if (metrics.omissionRate > thresholds.maxOmissionRate) {
    failures.push(`omission rate ${metrics.omissionRate.toFixed(3)} exceeds ${String(thresholds.maxOmissionRate)}`)
  }
  return failures
}

/** One measured run: the fixture, what came out, and what it scored. */
export interface MeasuredRun {
  readonly fixture: OcrFixture
  readonly metrics: MetricSet
}

/** Where and when a measurement happened, so a number is attributable. */
export interface MeasurementContext {
  readonly measuredAt: string
  /** A machine description. Never a build number — see the bench note in the engine repo. */
  readonly measuredOn: string
}

/**
 * Turn measured runs into one matrix cell.
 *
 * The single most important line in this module is the first one: no runs
 * means `NOT_TESTED`, with empty metrics and null timestamps. There is no
 * fallback, no estimate, and no inheritance from a neighbouring script. A cell
 * nobody measured says nobody measured it.
 */
export function qualify(
  engineId: string,
  workload: OcrWorkload,
  script: ScriptTag,
  runs: readonly MeasuredRun[],
  context: MeasurementContext | null,
  thresholds: QualificationThresholds = DEFAULT_THRESHOLDS,
): QualificationEntry {
  const relevant = runs.filter(
    run => run.fixture.workload === workload && run.fixture.script === script)

  if (relevant.length === 0 || context === null) {
    return {
      engineId,
      workload,
      script,
      state: 'NOT_TESTED',
      metrics: {},
      limitations: [],
      measuredAt: null,
      measuredOn: null,
    }
  }

  const mean = (pick: (metrics: MetricSet) => number): number =>
    relevant.reduce((total, run) => total + pick(run.metrics), 0) / relevant.length

  const aggregate: MetricSet = {
    cer: mean(metrics => metrics.cer),
    wer: mean(metrics => metrics.wer),
    wordAccuracy: mean(metrics => metrics.wordAccuracy),
    layoutF1: mean(metrics => metrics.layoutF1),
    readingOrder: mean(metrics => metrics.readingOrder),
    omissionRate: mean(metrics => metrics.omissionRate),
    hallucinationRate: mean(metrics => metrics.hallucinationRate),
    latencyMs: mean(metrics => metrics.latencyMs),
    peakRamMb: null,
    peakVramMb: null,
    crashed: relevant.some(run => run.metrics.crashed),
  }

  const failures = thresholdFailures(aggregate, thresholds)
  const hallucinating = aggregate.hallucinationRate > thresholds.maxHallucinationRate

  // Hallucination and a crash are disqualifying outright. Everything else can
  // be a limitation somebody accepts with their eyes open; inventing text
  // cannot, because the invented part is indistinguishable downstream.
  const state: QualificationState = failures.length === 0
    ? 'QUALIFIED'
    : hallucinating || aggregate.crashed
      ? 'NOT_YET_QUALIFIED'
      : failures.length <= 2
        ? 'QUALIFIED_WITH_LIMITATIONS'
        : 'NOT_YET_QUALIFIED'

  return {
    engineId,
    workload,
    script,
    state,
    metrics: {
      cer: aggregate.cer,
      wer: aggregate.wer,
      wordAccuracy: aggregate.wordAccuracy,
      layoutF1: aggregate.layoutF1,
      readingOrder: aggregate.readingOrder,
      omissionRate: aggregate.omissionRate,
      hallucinationRate: aggregate.hallucinationRate,
      latencyMs: aggregate.latencyMs,
      fixtures: relevant.length,
    },
    limitations: failures,
    measuredAt: context.measuredAt,
    measuredOn: context.measuredOn,
  }
}

/**
 * Build the whole matrix for one engine.
 *
 * Every workload × script cell exists, and the ones nobody ran are present and
 * `NOT_TESTED`. A matrix that omitted unmeasured cells would make an engine
 * measured on three things look like an engine measured on three things out of
 * three.
 */
export function buildMatrix(
  engineId: string,
  runs: readonly MeasuredRun[],
  context: MeasurementContext | null,
  thresholds: QualificationThresholds = DEFAULT_THRESHOLDS,
): readonly QualificationEntry[] {
  const cells: QualificationEntry[] = []
  for (const workload of OCR_WORKLOADS) {
    for (const script of SCRIPTS) {
      cells.push(qualify(engineId, workload, script, runs, context, thresholds))
    }
  }
  return cells
}

/** How much of a matrix has actually been measured. */
export interface MatrixCoverage {
  readonly total: number
  readonly measured: number
  readonly qualified: number
  readonly withLimitations: number
  readonly notQualified: number
  readonly notTested: number
}

/** Count a matrix, so a claim of coverage is a number rather than an adjective. */
export function coverageOf(matrix: readonly QualificationEntry[]): MatrixCoverage {
  const count = (state: QualificationState): number =>
    matrix.filter(entry => entry.state === state).length
  return {
    total: matrix.length,
    measured: matrix.filter(entry => entry.measuredAt !== null).length,
    qualified: count('QUALIFIED'),
    withLimitations: count('QUALIFIED_WITH_LIMITATIONS'),
    notQualified: count('NOT_YET_QUALIFIED'),
    notTested: count('NOT_TESTED'),
  }
}

/**
 * One line describing a matrix honestly.
 *
 * Leads with what was not measured. "Qualified on 6 of 120 cells" reads very
 * differently from "qualified", and the second is what a summary that led with
 * successes would amount to.
 */
export function describeCoverage(coverage: MatrixCoverage): string {
  if (coverage.measured === 0) {
    return `Not measured on this machine: ${String(coverage.total)} cell(s), none run.`
  }
  return `${String(coverage.measured)} of ${String(coverage.total)} cell(s) measured — `
    + `${String(coverage.qualified)} qualified, `
    + `${String(coverage.withLimitations)} with limitations, `
    + `${String(coverage.notQualified)} not qualified, `
    + `${String(coverage.notTested)} never run.`
}
