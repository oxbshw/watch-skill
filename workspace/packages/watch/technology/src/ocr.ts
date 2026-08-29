/**
 * The OCR engine family, and what it is honest to claim about each one.
 *
 * The governing decision (spec §33): DeepSeek-OCR is integrated as an
 * **optional, measured engine**, not as a dependency and not as the only
 * source of text. OCR2 is the high-quality document candidate where the
 * hardware suits it; the lightweight local route stays the default because it
 * is what works on a laptop with no GPU, which is most machines.
 *
 * Two rules are structural here rather than advisory.
 *
 * **Isolation.** DeepSeek-OCR's published inference path uses
 * `trust_remote_code=True`. That code does not run inside the DSH Host or the
 * Watch Core main process — it runs in a worker with a pinned revision, so a
 * crash, an OOM or a surprise in a model repository takes down a worker
 * instead of the workspace.
 *
 * **Qualification is per workload, never a single score.** An engine that
 * scores well on clean documents can be worse than a lighter one on subtitles,
 * dark-mode UI, or mixed scripts. One global number would hide exactly the
 * cases a user cares about, so the matrix is per engine × workload × script.
 *
 * @module @watchskill/dsh-technology/ocr
 */

import type { TechnologyDescriptor } from './descriptor.js'

/** The workloads OCR is judged against separately. */
export type OcrWorkload =
  | 'ui_text'
  | 'browser_form'
  | 'subtitles'
  | 'video_overlay'
  | 'document'
  | 'table'
  | 'reading_order'
  | 'low_resolution'
  | 'dark_mode'
  | 'mixed_script'

/** Every workload, for enumerating a qualification matrix. */
export const OCR_WORKLOADS: readonly OcrWorkload[] = [
  'ui_text', 'browser_form', 'subtitles', 'video_overlay', 'document',
  'table', 'reading_order', 'low_resolution', 'dark_mode', 'mixed_script',
]

/**
 * The scripts the matrix is structured around.
 *
 * Structural support, stated separately from measured results. A script
 * appearing here means the contract handles it, not that any engine has been
 * qualified on it.
 */
export type ScriptTag =
  | 'Latin' | 'Arabic' | 'Han_Simplified' | 'Han_Traditional' | 'Japanese'
  | 'Korean' | 'Cyrillic' | 'Devanagari' | 'Thai' | 'Greek' | 'Hebrew' | 'Mixed'

/** Every script the matrix is structured around. */
export const SCRIPTS: readonly ScriptTag[] = [
  'Latin', 'Arabic', 'Han_Simplified', 'Han_Traditional', 'Japanese',
  'Korean', 'Cyrillic', 'Devanagari', 'Thai', 'Greek', 'Hebrew', 'Mixed',
]

/**
 * What can be said about an engine on one workload.
 *
 * `NOT_TESTED` and `NOT_YET_QUALIFIED` are different answers, and keeping them
 * apart is the whole point. The first means nobody ran it; the second means
 * somebody did and it was not good enough. Collapsing them would let an
 * untested engine look evaluated.
 */
export type QualificationState =
  | 'QUALIFIED'
  | 'QUALIFIED_WITH_LIMITATIONS'
  | 'NOT_YET_QUALIFIED'
  | 'NOT_TESTED'

/** One cell of the matrix. */
export interface QualificationEntry {
  readonly engineId: string
  readonly workload: OcrWorkload
  readonly script: ScriptTag
  readonly state: QualificationState
  /** Measured values. Empty when nothing was measured — never estimated. */
  readonly metrics: Readonly<Record<string, number>>
  /** Why it is limited, when it is. */
  readonly limitations: readonly string[]
  /** ISO-8601, or null when never run. */
  readonly measuredAt: string | null
  /** The machine it was measured on, so a number is attributable. */
  readonly measuredOn: string | null
}

/** An untested cell: structurally present, honestly empty. */
export function notTested(
  engineId: string,
  workload: OcrWorkload,
  script: ScriptTag,
): QualificationEntry {
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

/**
 * Whether an engine may be selected as a default for a workload.
 *
 * Only a qualified engine. An untested one may be *chosen* by a user who wants
 * it, but it never becomes what happens when nobody chose — which is the
 * mechanism by which "we integrated OCR2" would otherwise turn into "OCR2 runs
 * on everything, including the cases it is bad at".
 */
export function canDefault(entry: QualificationEntry): boolean {
  return entry.state === 'QUALIFIED' || entry.state === 'QUALIFIED_WITH_LIMITATIONS'
}

/** The canonical OCR result, whatever engine produced it. */
export interface OcrResult {
  readonly ocrResultId: string
  readonly sourceRevisionId: string
  /** Digest of the exact image this was read from. */
  readonly artifactDigest: string
  readonly temporalRangeMs: { readonly startMs: number; readonly endMs: number } | null
  readonly frameIndex: number | null
  readonly engineId: string
  readonly model: string
  readonly revision: string
  /** Which prompt profile was used, for an engine that has them. */
  readonly promptProfile: string | null
  readonly preprocessing: Readonly<Record<string, unknown>>
  readonly text: string
  readonly blocks: readonly OcrBlock[]
  readonly readingOrder: readonly number[] | null
  readonly markdown: string | null
  readonly languageTags: readonly string[]
  readonly scripts: readonly ScriptTag[]
  readonly latencyMs: number
  readonly resourceUsage: Readonly<Record<string, number>>
  readonly qualityWarnings: readonly string[]
  /**
   * Null unless the engine produces a *calibrated* score.
   *
   * Token probability is not calibrated confidence, and converting one to the
   * other produces a number that looks like a probability and is not. An
   * engine without calibration reports null, and the UI shows no confidence
   * rather than a fabricated one.
   */
  readonly confidence: number | null
}

/** One recognized region. */
export interface OcrBlock {
  readonly index: number
  readonly text: string
  readonly bbox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly languageTags: readonly string[]
  readonly scripts: readonly ScriptTag[]
  readonly direction: 'ltr' | 'rtl' | 'mixed' | 'unknown'
  readonly confidence: number | null
}

/** What an OCR request is being asked to read. */
export interface OcrRoutingRequest {
  readonly workload: OcrWorkload
  readonly scripts: readonly ScriptTag[]
  /** Prefer speed or accuracy. */
  readonly quality: 'fast' | 'balanced' | 'best'
  readonly hasGpu: boolean
  readonly offlineOnly: boolean
  readonly egressConsent: boolean
}

/** Why an engine was not chosen. */
export interface RoutingExclusion {
  readonly engineId: string
  readonly reason: string
}

/** What the router decided, and why. */
export interface RoutingDecision {
  readonly engineId: string | null
  /** One sentence, recorded in the receipt so a choice is auditable. */
  readonly reason: string
  readonly excluded: readonly RoutingExclusion[]
}

/**
 * Choose an OCR engine.
 *
 * Deterministic filtering first, preference second — the model never picks
 * from a menu. Hardware, privacy and qualification decide what is *allowed*,
 * and only then does the quality profile choose among what is left. Every
 * exclusion is recorded, so "why did it use the light one?" has an answer.
 */
export function routeOcr(
  request: OcrRoutingRequest,
  engines: readonly TechnologyDescriptor[],
  qualification: readonly QualificationEntry[],
  health: ReadonlyMap<string, { readonly usable: boolean; readonly state: string }>,
): RoutingDecision {
  const excluded: RoutingExclusion[] = []
  const candidates: TechnologyDescriptor[] = []

  for (const engine of engines) {
    const engineHealth = health.get(engine.id)
    if (engineHealth === undefined || !engineHealth.usable) {
      excluded.push({
        engineId: engine.id,
        reason: `not usable (${engineHealth?.state ?? 'unknown'})`,
      })
      continue
    }
    if (request.offlineOnly && !engine.privacy.worksOffline) {
      excluded.push({ engineId: engine.id, reason: 'offline-only profile' })
      continue
    }
    if (engine.privacy.requiresEgressConsent && !request.egressConsent) {
      excluded.push({ engineId: engine.id, reason: 'egress consent not given' })
      continue
    }
    if (engine.hardware.gpu === 'required' && !request.hasGpu) {
      excluded.push({ engineId: engine.id, reason: 'requires a GPU' })
      continue
    }
    candidates.push(engine)
  }

  if (candidates.length === 0) {
    return {
      engineId: null,
      reason: 'No OCR engine is available under this policy and hardware.',
      excluded,
    }
  }

  /** Whether an engine is qualified for what is being asked. */
  const qualified = (engineId: string): boolean =>
    request.scripts.every(script =>
      qualification.some(entry =>
        entry.engineId === engineId
        && entry.workload === request.workload
        && entry.script === script
        && canDefault(entry)))

  const ranked = [...candidates].sort((a, b) => {
    // Qualified beats unqualified, always. An engine nobody measured on this
    // workload does not get chosen for it by default, however capable it is
    // elsewhere.
    const aQualified = qualified(a.id) ? 1 : 0
    const bQualified = qualified(b.id) ? 1 : 0
    if (aQualified !== bQualified) return bQualified - aQualified

    // Then the quality profile. `fast` prefers something with no GPU need;
    // `best` prefers the heavier engine when the hardware allows it.
    const weight = (engine: TechnologyDescriptor): number =>
      engine.hardware.gpu === 'none' ? 0 : engine.hardware.gpu === 'optional' ? 1 : 2
    const direction = request.quality === 'fast' ? 1 : -1
    const byWeight = (weight(a) - weight(b)) * direction
    if (byWeight !== 0) return byWeight

    return a.id.localeCompare(b.id)
  })

  const chosen = ranked[0]
  if (chosen === undefined) {
    return { engineId: null, reason: 'No OCR engine remained after filtering.', excluded }
  }

  for (const engine of ranked.slice(1)) {
    excluded.push({ engineId: engine.id, reason: 'a better-matching engine was available' })
  }

  return {
    engineId: chosen.id,
    reason: qualified(chosen.id)
      ? `qualified for ${request.workload} on ${request.scripts.join(', ')}`
      : `no engine is qualified for ${request.workload} on ${request.scripts.join(', ')}; `
        + `${chosen.displayName} was the best available and its output is unqualified`,
    excluded,
  }
}

// ── the shipped engine family ───────────────────────────────────────────────

/** Shared resource limits for a local OCR engine. */
const LOCAL_LIMITS = { maxConcurrency: 2, timeoutMs: 120_000, maxMemoryMb: 4096 } as const

/**
 * The lightweight local route.
 *
 * The default, because it runs everywhere. Not because it is the most accurate
 * — on clean documents it is not — but because a default that needs a GPU is
 * not a default.
 */
export const RAPID_OCR: TechnologyDescriptor = {
  id: 'ocr.rapidocr',
  displayName: 'RapidOCR (ONNX)',
  version: '1.x',
  kind: 'engine',
  capabilities: ['document_ocr', 'visual'],
  modalities: ['image'],
  roles: ['ocr_layout'],
  runtime: 'local_library',
  protocols: [],
  endpoints: [],
  credentialReference: null,
  hardware: { gpu: 'none', minVramGb: null, minRamGb: 2, accelerators: [] },
  privacy: { egress: 'none', worksOffline: true, requiresEgressConsent: false },
  install: { method: 'package_manager', downloadBytes: null, automatic: false },
  provenance: {
    codeLicense: 'Apache-2.0',
    weightsLicense: 'Apache-2.0',
    revision: null,
    sourceUrl: 'https://github.com/RapidAI/RapidOCR',
    weightsLicenseReviewed: true,
  },
  resources: LOCAL_LIMITS,
  trust: 'built_in',
  probeMethod: 'import check',
  testMethod: 'recognize a bundled fixture image',
}

/** The deterministic system fallback, for scripts the ONNX route cannot read. */
export const TESSERACT: TechnologyDescriptor = {
  id: 'ocr.tesseract',
  displayName: 'Tesseract',
  version: '5.x',
  kind: 'engine',
  capabilities: ['document_ocr'],
  modalities: ['image'],
  roles: ['ocr_layout'],
  runtime: 'local_process',
  protocols: [],
  endpoints: [],
  credentialReference: null,
  hardware: { gpu: 'none', minVramGb: null, minRamGb: 1, accelerators: [] },
  privacy: { egress: 'none', worksOffline: true, requiresEgressConsent: false },
  install: { method: 'package_manager', downloadBytes: null, automatic: false },
  provenance: {
    codeLicense: 'Apache-2.0',
    weightsLicense: 'Apache-2.0',
    revision: null,
    sourceUrl: 'https://github.com/tesseract-ocr/tesseract',
    weightsLicenseReviewed: true,
  },
  resources: LOCAL_LIMITS,
  trust: 'built_in',
  probeMethod: 'tesseract --version',
  testMethod: 'recognize a bundled fixture image',
}

/**
 * DeepSeek-OCR, the compatibility and comparison route.
 *
 * Pinned to a reviewed revision. `trust_remote_code` in its published
 * inference path is why `trust` is `isolated` and the runtime is a separate
 * process: a surprise in a model repository should cost a worker, not the
 * workspace.
 */
export const DEEPSEEK_OCR: TechnologyDescriptor = {
  id: 'ocr.deepseek-ocr',
  displayName: 'DeepSeek-OCR',
  version: '1.0',
  kind: 'engine',
  capabilities: ['document_ocr', 'visual'],
  modalities: ['image'],
  roles: ['ocr_layout'],
  runtime: 'local_process',
  protocols: [],
  endpoints: [],
  credentialReference: null,
  hardware: { gpu: 'required', minVramGb: 12, minRamGb: 16, accelerators: ['cuda'] },
  privacy: { egress: 'none', worksOffline: true, requiresEgressConsent: false },
  install: { method: 'download', downloadBytes: null, automatic: false },
  provenance: {
    codeLicense: 'MIT',
    // Not asserted from the repository licence. An MIT repository does not
    // make its published weights MIT, and this stays null until a licence has
    // actually been read.
    weightsLicense: null,
    revision: '09eaf526153e7a01ed16c9dea8c96282aaea29c0',
    sourceUrl: 'https://github.com/deepseek-ai/DeepSeek-OCR',
    weightsLicenseReviewed: false,
  },
  resources: { maxConcurrency: 1, timeoutMs: 300_000, maxMemoryMb: 16_384 },
  trust: 'isolated',
  probeMethod: 'worker handshake',
  testMethod: 'recognize a bundled fixture image in the worker',
}

/** DeepSeek-OCR2, the high-quality document candidate. */
export const DEEPSEEK_OCR2: TechnologyDescriptor = {
  ...DEEPSEEK_OCR,
  id: 'ocr.deepseek-ocr2',
  displayName: 'DeepSeek-OCR2',
  version: '2.0',
  provenance: {
    codeLicense: 'Apache-2.0',
    weightsLicense: null,
    revision: '2f3699ebbb96fa8af32212e8c170f2cc28730fad',
    sourceUrl: 'https://github.com/deepseek-ai/DeepSeek-OCR-2',
    weightsLicenseReviewed: false,
  },
}

/**
 * A cloud OCR route, behind an explicit consent.
 *
 * Present as a descriptor rather than as an integration: the point of having
 * it here is that the routing rules can *refuse* it. `requiresEgressConsent`
 * and `worksOffline: false` together mean `routeOcr` excludes it under an
 * offline-only profile and under a profile where cloud perception was never
 * agreed to — which is a different consent from holding a provider API key.
 *
 * No endpoint is baked in. A deployment that wants a cloud OCR route names its
 * own, and the route it names is what appears in the receipt.
 */
export const CLOUD_OCR: TechnologyDescriptor = {
  id: 'ocr.cloud',
  displayName: 'Cloud OCR (deployment-configured)',
  version: '1.0',
  kind: 'engine',
  capabilities: ['document_ocr', 'visual'],
  modalities: ['image'],
  roles: ['ocr_layout'],
  runtime: 'remote',
  protocols: ['https'],
  endpoints: [],
  credentialReference: 'dsh:connection',
  hardware: { gpu: 'none', minVramGb: null, minRamGb: 0, accelerators: [] },
  privacy: { egress: 'content', worksOffline: false, requiresEgressConsent: true },
  install: { method: 'none', downloadBytes: null, automatic: false },
  provenance: {
    codeLicense: 'proprietary',
    weightsLicense: 'proprietary',
    revision: null,
    sourceUrl: '',
    // A hosted service's terms are the deployment's to accept, and the flag
    // here is about redistributing weights — which never applies to a service
    // whose weights nobody receives.
    weightsLicenseReviewed: true,
  },
  resources: { maxConcurrency: 4, timeoutMs: 60_000, maxMemoryMb: 256 },
  trust: 'untrusted',
  probeMethod: 'endpoint reachability',
  testMethod: 'recognize a bundled fixture image over the wire',
}

/**
 * Build a descriptor for a third-party OCR engine.
 *
 * The custom-provider seam. A capability author supplies what they know and
 * gets a descriptor that the same routing, health and licence rules apply to —
 * which is the point: a third-party engine is subject to every gate a built-in
 * one is, and cannot opt out of any of them.
 *
 * Two fields are forced regardless of what the caller passes. `trust` is
 * `third_party`, and `install.automatic` is false. Neither is something a
 * plugin gets to decide about itself.
 */
export function customOcrEngine(input: {
  readonly id: string
  readonly displayName: string
  readonly version: string
  readonly runtime: TechnologyDescriptor['runtime']
  readonly hardware: TechnologyDescriptor['hardware']
  readonly privacy: TechnologyDescriptor['privacy']
  readonly provenance: TechnologyDescriptor['provenance']
  readonly resources: TechnologyDescriptor['resources']
  readonly probeMethod: string
  readonly testMethod: string
  readonly endpoints?: readonly string[]
  readonly credentialReference?: string | null
}): TechnologyDescriptor {
  return {
    id: input.id,
    displayName: input.displayName,
    version: input.version,
    kind: 'engine',
    capabilities: ['document_ocr'],
    modalities: ['image'],
    roles: ['ocr_layout'],
    runtime: input.runtime,
    protocols: [],
    endpoints: input.endpoints ?? [],
    credentialReference: input.credentialReference ?? null,
    hardware: input.hardware,
    privacy: input.privacy,
    install: { method: 'none', downloadBytes: null, automatic: false },
    provenance: input.provenance,
    resources: input.resources,
    // Not the plugin's call. A third-party engine is assumed hostile however
    // it describes itself, and the trust tier is what decides whether its code
    // is allowed anywhere except a worker.
    trust: 'untrusted',
    probeMethod: input.probeMethod,
    testMethod: input.testMethod,
  }
}

/**
 * Whether an engine's code may run in the host process.
 *
 * Only a built-in library. Everything else — third party, and anything marked
 * `isolated` because its inference path executes code fetched from a model
 * repository — runs in a worker, and this is what a caller checks before
 * choosing how to run it.
 */
export function mayRunInProcess(descriptor: TechnologyDescriptor): boolean {
  return descriptor.trust === 'built_in' && descriptor.runtime === 'local_library'
}

/** The engines this build knows about. */
export const OCR_ENGINES: readonly TechnologyDescriptor[] = [
  RAPID_OCR, TESSERACT, DEEPSEEK_OCR, DEEPSEEK_OCR2, CLOUD_OCR,
]

/**
 * Whether an engine's weights may be distributed or auto-fetched.
 *
 * A release gate. The repository licence is about the code; shipping or
 * downloading weights on someone's behalf needs the weight licence to have
 * been read, and `weightsLicenseReviewed` is the record that it was.
 */
export function mayDistributeWeights(descriptor: TechnologyDescriptor): boolean {
  return descriptor.provenance.weightsLicense !== null
    && descriptor.provenance.weightsLicenseReviewed
}
