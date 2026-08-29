/**
 * In-process Bridge backend used before a real Watch Core is attached.
 *
 * Phase 1 of the plan needs the Host plugin, the profile bundle and the browser
 * half to be installable and demonstrably alive on stock DeepSeek Harness
 * before the Python engine is wired in. This backend is what makes that
 * possible without ever pretending a capability is present.
 *
 * The honesty rules it exists to demonstrate, not to bypass:
 *   - every capability reports `not_tested`, never `machine_tested`;
 *   - it never returns an EvidenceRecord or a verdict, because only Watch Core
 *     may mint those (ADR-002);
 *   - `transport: 'mock'` reaches the UI, so no screen can imply a real engine.
 *
 * @module @watchskill/dsh-core-bridge/transport/mock
 */

import type { CapabilityTruth, HandshakeResult, WatchResult } from '@watchskill/dsh-contracts'
import {
  EXPECTED_SCHEMA_DIGESTS,
  WATCH_PROTOCOL_VERSION,
  watchError,
} from '@watchskill/dsh-contracts'
import type { Transport, TransportEvent, TransportRequest } from '../transport.js'

/** Capabilities the product declares, every one of them unproven here. */
const DECLARED_CAPABILITIES: readonly string[] = [
  'watch.video.index',
  'watch.video.query',
  'watch.live.session',
  'watch.browser.observe',
  'watch.browser.operate',
  'watch.evidence.resolve',
  'watch.verification.run',
  'watch.library.search',
  'watch.memory.recall',
]

/** Describe one capability as untested rather than as absent or present. */
function untested(capabilityId: string): CapabilityTruth {
  return {
    capabilityId,
    provider: 'mock',
    providerVersion: null,
    status: 'not_tested',
    requirements: ['a running Watch Core'],
    detected: {},
    missing: ['watch-core'],
    fixes: [
      'Install Watch Core (`pip install watch-skill`) and set the Bridge transport to "stdio".',
    ],
    lastCheckedAt: null,
  }
}

/** Bridge backend that answers handshake and health, and refuses everything else. */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const

  private readonly eventListeners = new Set<(event: TransportEvent) => void>()

  connect(): Promise<WatchResult<void>> {
    return Promise.resolve({ ok: true, value: undefined })
  }

  send<T>(request: TransportRequest): Promise<WatchResult<T>> {
    if (request.signal.aborted) {
      return Promise.resolve(watchError(
        'bridge.cancelled',
        'The request was cancelled before it was sent.',
        'Reissue the request if you still need the result.',
        { correlationId: request.correlationId },
      ))
    }
    if (request.method === 'watch.handshake') {
      return Promise.resolve({ ok: true, value: this.handshake() as T })
    }
    // Everything else is deliberately a structured refusal. A mock that
    // invented plausible answers would be worse than no mock at all: it would
    // let a green screen ship without a single real observation behind it.
    return Promise.resolve(watchError(
      'bridge.core_unavailable',
      `Watch Core is not connected, so "${request.method}" cannot run.`,
      'Connect Watch Core in Settings → Watch, or start the Workspace with the stdio transport configured.',
      { details: { method: request.method }, retryable: false, correlationId: request.correlationId },
    ))
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  onFailure(): () => void {
    // A mock has no transport to lose, so there is nothing to report.
    return () => {}
  }

  dispose(): Promise<void> {
    this.eventListeners.clear()
    return Promise.resolve()
  }

  /** The one answer this backend is entitled to give. */
  private handshake(): HandshakeResult {
    return {
      coreVersion: '0.0.0-mock',
      coreBuild: null,
      protocolVersion: WATCH_PROTOCOL_VERSION,
      capabilities: DECLARED_CAPABILITIES.map(untested),
      // This backend runs in-process, so by construction it speaks exactly the
      // contract this build was written against. Reporting the expected
      // digests is the accurate answer, not a convenience: reporting nothing
      // would claim an unverifiable wire, and reporting something else would
      // claim a disagreement that does not exist.
      schemaDigests: { ...EXPECTED_SCHEMA_DIGESTS },
      policy: {
        // A backend that observes nothing sends nothing, so the strictest
        // policy is also the accurate one to report.
        offlineOnly: true,
        cloudPerceptionOptIn: false,
        memoryMode: 'off',
        defaultRetentionClass: 'none',
      },
      limits: {
        maxRequestBytes: 1_048_576,
        maxInFlight: 1,
        defaultDeadlineMs: 5_000,
      },
    }
  }
}
