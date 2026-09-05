/**
 * A worked example: the smallest capability that does something real.
 *
 * Shipped as source rather than as documentation, and exercised by the SDK's
 * own tests, so an example that stops compiling is a failing build rather than
 * a page somebody finds out is wrong at the worst moment.
 *
 * It reads a subtitle file and submits what it found. That is deliberately
 * unglamorous — it is the shape of the thing that matters: declare, probe,
 * observe, submit, and never claim.
 *
 * @module @deepwatch/dsh-sdk/example
 */

import type { TechnologyDescriptor } from '@deepwatch/dsh-technology'
import {
  createCapabilityHost,
  type CapabilityDeclaration,
  type CoreGateway,
  type SubmissionResult,
  type WatchCapabilityHost,
} from './capability.js'

/** The descriptor an example third-party capability supplies. */
export const EXAMPLE_DESCRIPTOR: TechnologyDescriptor = {
  id: 'example.subtitle-reader',
  displayName: 'Subtitle Reader (example)',
  version: '1.0.0',
  kind: 'engine',
  capabilities: ['document_ocr'],
  modalities: ['text'],
  roles: ['ocr_layout'],
  runtime: 'local_library',
  protocols: [],
  endpoints: [],
  credentialReference: null,
  hardware: { gpu: 'none', minVramGb: null, minRamGb: 1, accelerators: [] },
  privacy: { egress: 'none', worksOffline: true, requiresEgressConsent: false },
  install: { method: 'package_manager', downloadBytes: null, automatic: false },
  provenance: {
    codeLicense: 'MIT',
    weightsLicense: null,
    revision: null,
    sourceUrl: 'https://example.test/subtitle-reader',
    weightsLicenseReviewed: false,
  },
  resources: { maxConcurrency: 2, timeoutMs: 30_000, maxMemoryMb: 256 },
  // Not 'built_in'. A capability that declared itself built in would be
  // refused by validateDeclaration(), which is the point of the example.
  trust: 'untrusted',
  probeMethod: 'parse a bundled fixture',
  testMethod: 'read a bundled subtitle file end to end',
}

/** The declaration an example third-party capability supplies. */
export const EXAMPLE_DECLARATION: CapabilityDeclaration = {
  id: 'example.subtitle-reader',
  displayName: 'Subtitle Reader (example)',
  version: '1.0.0',
  provides: ['source.subtitles'],
  modalities: ['text'],
  permissions: [
    {
      id: 'source.read',
      reason: 'Reads subtitle tracks from sources you have already indexed.',
      scope: 'read',
      highImpact: false,
    },
  ],
  descriptor: EXAMPLE_DESCRIPTOR,
}

/** One cue the example produces. */
export interface Cue {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

/**
 * Parse the smallest useful subtitle format.
 *
 * Real enough to be a real example, small enough that the SDK's shape is what
 * the reader is looking at rather than a parser.
 */
export function parseCues(source: string): readonly Cue[] {
  const cues: Cue[] = []
  for (const block of source.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(line => line.trim() !== '')
    const timing = lines.find(line => line.includes('-->'))
    if (timing === undefined) continue
    const [from, to] = timing.split('-->').map(part => part.trim())
    const text = lines.filter(line => line !== timing && !/^\d+$/.test(line.trim())).join(' ')
    if (text === '') continue
    cues.push({ startMs: toMs(from ?? ''), endMs: toMs(to ?? ''), text })
  }
  return cues
}

/** `00:01:02,500` to milliseconds. */
function toMs(stamp: string): number {
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(stamp)
  if (match === null) return 0
  return Number(match[1]) * 3_600_000
    + Number(match[2]) * 60_000
    + Number(match[3]) * 1_000
    + Number(match[4])
}

/**
 * Run the example capability over one source.
 *
 * Every cue becomes a candidate observation. None of them carries an evidence
 * id, because the capability has no way to produce one — the host mints them,
 * and the ids in the result came back from Core.
 */
export async function runExample(
  gateway: CoreGateway,
  input: { readonly sourceRevisionId: string; readonly subtitles: string; readonly capturedAt: string },
): Promise<readonly SubmissionResult[]> {
  const host: WatchCapabilityHost = createCapabilityHost(EXAMPLE_DECLARATION, gateway)
  host.reportHealth({ probed: true, detail: 'parsed a bundled fixture' })

  const results: SubmissionResult[] = []
  for (const cue of parseCues(input.subtitles)) {
    results.push(await host.submitObservation({
      sourceRevisionId: input.sourceRevisionId,
      temporalRange: { startMs: cue.startMs, endMs: cue.endMs },
      spatialRegion: null,
      modality: 'text',
      text: cue.text,
      artifactIds: [],
      capturedAt: input.capturedAt,
      qualityWarnings: [],
      // Null, honestly. A subtitle parser has no calibrated confidence, and
      // inventing one would put a number on screen that means nothing.
      confidence: null,
    }))
  }
  return results
}
