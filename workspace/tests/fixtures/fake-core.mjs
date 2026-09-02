/**
 * A minimal stand-in for Watch Core's Bridge mode.
 *
 * It speaks exactly the wire the real engine speaks — `Content-Length` framed
 * JSON-RPC 2.0 over stdio — and nothing else. Its purpose is to let the
 * transport's hard parts be tested for real: frame boundaries that fall in the
 * middle of a header, a request that never answers, a cancellation that
 * arrives after dispatch, and a process that dies mid-flight.
 *
 * It is a protocol fixture, not a mock engine: it never returns an
 * EvidenceRecord or a verdict, because only Watch Core may mint those.
 *
 * Behaviors are selected by method name so one fixture covers every case:
 *   fixture.echo       → returns its params
 *   fixture.silent     → never answers (exercises the deadline)
 *   fixture.slow       → answers after 500ms
 *   fixture.fail       → returns a Watch error contract in `data`
 *   fixture.rawFail    → returns a bare JSON-RPC error with no contract
 *   fixture.split      → answers in two writes split inside the header
 *   fixture.crash      → exits the process without answering
 *   fixture.event      → pushes a notification, then answers
 */

import { Buffer } from 'node:buffer'
import { EXPECTED_SCHEMA_DIGESTS } from '@deepwatch/dsh-contracts'

const HEADER_TERMINATOR = '\r\n\r\n'

let buffer = Buffer.alloc(0)
/** Correlation ids the fixture was asked to cancel, for the cancel assertion. */
const cancelled = new Set()

/** Write one framed message. */
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${body.byteLength}${HEADER_TERMINATOR}`)
  process.stdout.write(body)
}

/** Write one framed message split across two writes inside the header. */
function sendSplit(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = `Content-Length: ${body.byteLength}${HEADER_TERMINATOR}`
  process.stdout.write(header.slice(0, 7))
  setTimeout(() => {
    process.stdout.write(header.slice(7))
    process.stdout.write(body)
  }, 20)
}

/** The handshake a protocol fixture is entitled to answer. */
function handshake() {
  return {
    coreVersion: '1.4.0rc1-fixture',
    coreBuild: 'fixture',
    protocolVersion: 1,
    capabilities: [{
      capabilityId: 'watch.video.query',
      provider: 'fixture',
      providerVersion: '1',
      status: 'machine_tested',
      requirements: [],
      detected: { fixture: 'true' },
      missing: [],
      fixes: [],
      lastCheckedAt: new Date(0).toISOString(),
    }],
    // The fixture stands in for an engine whose contract matches, so the
    // transport tests exercise the transport rather than the drift path.
    // Drift has its own suite, with a backend built to disagree.
    schemaDigests: { ...EXPECTED_SCHEMA_DIGESTS },
    policy: {
      offlineOnly: true,
      cloudPerceptionOptIn: false,
      memoryMode: 'off',
      defaultRetentionClass: 'session',
    },
    limits: { maxRequestBytes: 1048576, maxInFlight: 8, defaultDeadlineMs: 5000 },
  }
}

/** Handle one decoded request or notification. */
function handle(message) {
  if (message.method === 'watch.cancel') {
    cancelled.add(message.params?.correlationId)
    return
  }
  if (message.id === undefined) return

  const reply = result => send({ jsonrpc: '2.0', id: message.id, result })

  switch (message.method) {
    case 'watch.handshake':
      reply(handshake())
      return
    case 'fixture.echo':
      // The envelope's correlationId is echoed back so the test can prove it
      // travels with the request rather than being invented by the client.
      reply({ params: message.params, correlationId: message.correlationId })
      return
    case 'fixture.silent':
      return
    case 'fixture.slow':
      setTimeout(() => {
        reply({ cancelledSeen: cancelled.has(message.correlationId) })
      }, 500)
      return
    case 'fixture.split':
      sendSplit({ jsonrpc: '2.0', id: message.id, result: { split: true } })
      return
    case 'fixture.fail':
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: 'the engine refused',
          data: {
            error: 'fixture.refused',
            message: 'The engine refused this request.',
            fix: 'Do the thing the engine asked for.',
            details: { from: 'fixture' },
            retryable: false,
            correlationId: message.correlationId ?? null,
          },
        },
      })
      return
    case 'fixture.rawFail':
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } })
      return
    case 'fixture.event':
      send({ jsonrpc: '2.0', method: 'watch.progress', params: { pct: 42 } })
      reply({ done: true })
      return
    case 'fixture.crash':
      process.exit(3)
      return
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown ${message.method}` } })
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf(HEADER_TERMINATOR)
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (match === null) { process.exit(9) }
    const bodyStart = headerEnd + HEADER_TERMINATOR.length
    const bodyEnd = bodyStart + Number(match[1])
    if (buffer.byteLength < bodyEnd) return
    const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8')
    buffer = buffer.subarray(bodyEnd)
    handle(JSON.parse(body))
  }
})

// A fixture that keeps stdin open keeps the process alive; nothing else should.
process.stdin.resume()
