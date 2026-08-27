/**
 * The capability SDK, and the boundary it exists to hold.
 *
 * Somebody should be able to add a sense to Watch without forking DSH,
 * patching Watch Core, or asking anyone. The test file for that path is
 * therefore mostly about the one thing they must not be able to do, because an
 * SDK is exactly where ADR-002 would erode — not by anyone deciding to break
 * it, but by a helper that accepts a `verdict` field because an author asked.
 *
 * The boundary is built two ways, and both are tested, because either alone
 * fails. By shape: nothing in the SDK returns an EvidenceRecord or a Verdict,
 * asserted by reading the module's own surface. By sanitization: types are
 * erased at runtime and a plugin is a JavaScript object, so a submission
 * carrying `verdict: 'VERIFIED'` is stripped — and the attempt is reported,
 * because a silent strip would make a hostile capability look like a correct
 * one.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  AUTHORITY_FIELDS,
  EXAMPLE_DECLARATION,
  EXAMPLE_DESCRIPTOR,
  createCapabilityHost,
  normalizePermissions,
  parseCues,
  runExample,
  sanitizeCandidate,
  validateDeclaration,
} from '@watchskill/dsh-sdk'
import {
  SubtitleReadingView,
  readToolValue,
  registerExampleView,
} from '@watchskill/dsh-sdk/client-example'
import { toneFor, tokenFor } from '@watchskill/dsh-client-brand'

/** A stand-in for Watch Core, recording everything it is asked. */
function fakeCore(overrides = {}) {
  const state = {
    minted: [],
    verifications: [],
    records: [],
    health: [],
    authorityAttempts: [],
    nextId: 1,
  }
  const gateway = {
    mintEvidence: async candidate => {
      state.minted.push(candidate)
      // The id is Core's. A capability has no way to influence it, and this is
      // where that is true rather than merely stated.
      const evidenceId = `ev_core_${String(state.nextId)}`
      state.nextId += 1
      return { ok: true, evidenceId }
    },
    readEvidence: async () => null,
    verify: async request => {
      state.verifications.push(request)
      return {
        verificationId: 'ver_core_1',
        // Core's answer. Whatever the plugin asked for, this is what comes back.
        verdict: 'UNVERIFIED',
        checks: [],
        evidenceRefs: [],
        reason: 'no executable expectation was supplied',
      }
    },
    record: event => { state.records.push(event) },
    health: (id, health) => { state.health.push({ id, health }) },
    onAuthorityAttempt: (id, fields) => { state.authorityAttempts.push({ id, fields }) },
    ...overrides,
  }
  return { state, gateway }
}

// ── the boundary ────────────────────────────────────────────────────────────

describe('a third-party capability cannot mint VERIFIED', () => {
  test('nothing the SDK exports produces a verdict or an evidence record', async () => {
    const sdk = await import('@watchskill/dsh-sdk')
    for (const [name, value] of Object.entries(sdk)) {
      if (typeof value !== 'function') continue
      // A name that promises minting is the first sign of the boundary moving.
      assert.equal(
        /mint|issueVerdict|createEvidence|setVerdict|markVerified/i.test(name),
        false,
        `the SDK exports ${name}, which sounds like it mints something`,
      )
    }
    assert.equal('mintEvidence' in sdk, false)
    assert.equal('createEvidenceRecord' in sdk, false)
  })

  test('a submission carrying a verdict has it stripped', async () => {
    const { state, gateway } = fakeCore()
    const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway)

    const result = await host.submitObservation({
      sourceRevisionId: 'src@rev1',
      modality: 'text',
      text: 'Deploy succeeded',
      capturedAt: '2026-08-27T10:00:00.000Z',
      // Everything a hostile capability would try.
      verdict: 'VERIFIED',
      evidenceId: 'ev_forged_by_plugin',
      freshness: 'current',
      provenance: 'observation',
      contentDigest: 'sha256:whatever-i-like',
      verified: true,
    })

    assert.equal(result.ok, true)
    assert.equal(result.evidenceId, 'ev_core_1', 'the plugin chose its own evidence id')

    const submitted = state.minted[0]
    for (const field of ['verdict', 'evidenceId', 'freshness', 'provenance', 'contentDigest', 'verified']) {
      assert.equal(field in submitted, false, `${field} survived sanitization`)
    }
  })

  test('the attempt is reported rather than swallowed', async () => {
    const { state, gateway } = fakeCore()
    const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway)
    const result = await host.submitObservation({
      sourceRevisionId: 'src@rev1',
      text: 'x',
      verdict: 'VERIFIED',
      evidenceId: 'ev_forged',
    })
    assert.deepEqual([...result.stripped].sort(), ['evidenceId', 'verdict'])
    assert.equal(state.authorityAttempts.length, 1)
    assert.equal(state.authorityAttempts[0].id, 'example.subtitle-reader')
  })

  test('a clean submission reports nothing stripped', async () => {
    const { gateway } = fakeCore()
    const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway)
    const result = await host.submitObservation({
      sourceRevisionId: 'src@rev1',
      modality: 'text',
      text: 'Deploy succeeded',
      capturedAt: '2026-08-27T10:00:00.000Z',
      confidence: null,
    })
    assert.deepEqual([...result.stripped], [])
  })

  test('a capability cannot claim to be a different capability', async () => {
    const { state, gateway } = fakeCore()
    const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway)
    await host.submitObservation({
      sourceRevisionId: 'src@rev1',
      text: 'x',
      producer: 'watch-core',
      producerVersion: '99.0',
    })
    assert.equal(state.minted[0].producer, 'example.subtitle-reader')
    assert.equal(state.minted[0].producerVersion, '1.0.0')
  })

  test('requesting verification returns Core’s answer, not the plugin’s', async () => {
    const { state, gateway } = fakeCore()
    const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway)
    const outcome = await host.requestVerification({
      expectation: 'the row exists',
      contractId: null,
      evidenceIds: ['ev_core_1'],
      timeoutMs: null,
    })
    assert.equal(outcome.verdict, 'UNVERIFIED')
    assert.equal(state.verifications.length, 1)
  })

  test('the host offers no way to reach the Bridge', () => {
    const { gateway } = fakeCore()
    const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway)
    assert.deepEqual(Object.keys(host).sort(), [
      'recordTrajectory', 'reportHealth', 'requestEvidence', 'requestVerification', 'submitObservation',
    ])
    for (const name of ['bridge', 'core', 'request', 'gateway', 'raw']) {
      assert.equal(name in host, false, `the host exposes ${name}`)
    }
  })

  test('every authority field is covered by the sanitizer', () => {
    const carrying = Object.fromEntries(AUTHORITY_FIELDS.map(field => [field, 'x']))
    const { candidate, stripped } = sanitizeCandidate(
      { ...carrying, sourceRevisionId: 'src@rev1', text: 'hello' },
      { id: 'p', version: '1' },
    )
    assert.deepEqual([...stripped].sort(), [...AUTHORITY_FIELDS].sort())
    for (const field of AUTHORITY_FIELDS) {
      assert.equal(field in candidate, false, `${field} survived`)
    }
    assert.equal(candidate.text, 'hello')
  })

  test('an unknown extra field does not survive either', () => {
    const { candidate } = sanitizeCandidate(
      { sourceRevisionId: 'src@rev1', text: 'hello', somethingNobodyThoughtOf: true },
      { id: 'p', version: '1' },
    )
    assert.equal('somethingNobodyThoughtOf' in candidate, false,
      'the sanitizer is a denylist, so tomorrow’s authority field gets through')
  })

  test('a nonsense submission produces a well-formed candidate rather than throwing', () => {
    for (const raw of [null, undefined, 42, 'a string', []]) {
      const { candidate } = sanitizeCandidate(raw, { id: 'p', version: '1' })
      assert.equal(typeof candidate.text, 'string')
      assert.equal(candidate.producer, 'p')
    }
  })

  test('an unrecognized modality falls back rather than being trusted', () => {
    const { candidate } = sanitizeCandidate(
      { sourceRevisionId: 's', text: 't', modality: 'telepathy' },
      { id: 'p', version: '1' },
    )
    assert.equal(candidate.modality, 'text')
  })
})

// ── declarations ────────────────────────────────────────────────────────────

describe('a capability declares itself, and is corrected where it flatters itself', () => {
  test('a valid declaration is accepted', () => {
    assert.deepEqual(validateDeclaration(EXAMPLE_DECLARATION), [])
  })

  test('a capability cannot declare itself built in or trusted', () => {
    for (const trust of ['built_in', 'trusted']) {
      const refusals = validateDeclaration({
        ...EXAMPLE_DECLARATION,
        descriptor: { ...EXAMPLE_DESCRIPTOR, trust },
      })
      assert.ok(refusals.some(refusal => /not a capability’s to claim/.test(refusal.reason)))
      assert.ok(refusals.every(refusal => refusal.fix !== ''))
    }
  })

  test('a capability cannot install itself', () => {
    const refusals = validateDeclaration({
      ...EXAMPLE_DECLARATION,
      descriptor: {
        ...EXAMPLE_DESCRIPTOR,
        install: { method: 'download', downloadBytes: 4_000_000_000, automatic: true },
      },
    })
    assert.ok(refusals.some(refusal => /install itself automatically/.test(refusal.reason)))
  })

  test('a permission with no reason is refused', () => {
    const refusals = validateDeclaration({
      ...EXAMPLE_DECLARATION,
      permissions: [{ id: 'browser.act', reason: '  ', scope: 'act', highImpact: true }],
    })
    assert.ok(refusals.some(refusal => /no stated reason/.test(refusal.reason)))
  })

  test('a capability that provides nothing is refused', () => {
    assert.ok(validateDeclaration({ ...EXAMPLE_DECLARATION, provides: [] }).length > 0)
  })

  test('an act permission is high impact whatever it claims', () => {
    const normalized = normalizePermissions([
      { id: 'browser.act', reason: 'clicks things', scope: 'act', highImpact: false },
      { id: 'source.read', reason: 'reads sources', scope: 'read', highImpact: false },
    ])
    assert.equal(normalized[0].highImpact, true)
    assert.equal(normalized[1].highImpact, false)
  })
})

// ── the worked example ──────────────────────────────────────────────────────

describe('the example capability, end to end', () => {
  const SUBTITLES = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    'Starting the deployment now.',
    '',
    '2',
    '00:00:09,000 --> 00:00:11,000',
    'And it says succeeded.',
    '',
  ].join('\n')

  test('it parses cues with their timings', () => {
    const cues = parseCues(SUBTITLES)
    assert.equal(cues.length, 2)
    assert.equal(cues[0].startMs, 1_000)
    assert.equal(cues[1].endMs, 11_000)
    assert.match(cues[1].text, /succeeded/)
  })

  test('every cue becomes evidence Core minted, not evidence the plugin named', async () => {
    const { state, gateway } = fakeCore()
    const results = await runExample(gateway, {
      sourceRevisionId: 'src@rev1',
      subtitles: SUBTITLES,
      capturedAt: '2026-08-27T10:00:00.000Z',
    })
    assert.equal(results.length, 2)
    assert.deepEqual(results.map(result => result.evidenceId), ['ev_core_1', 'ev_core_2'])
    assert.equal(state.minted.length, 2)
    assert.equal(state.minted[0].temporalRange.startMs, 1_000)
  })

  test('it probes before it claims to work', async () => {
    const { state, gateway } = fakeCore()
    await runExample(gateway, { sourceRevisionId: 's', subtitles: SUBTITLES, capturedAt: 'now' })
    assert.equal(state.health.length, 1)
    assert.equal(state.health[0].health.probed, true)
  })

  test('it reports no confidence rather than inventing one', async () => {
    const { state, gateway } = fakeCore()
    await runExample(gateway, { sourceRevisionId: 's', subtitles: SUBTITLES, capturedAt: 'now' })
    for (const candidate of state.minted) assert.equal(candidate.confidence, null)
  })

  test('the example itself would pass installation validation', () => {
    assert.deepEqual(validateDeclaration(EXAMPLE_DECLARATION), [])
    assert.equal(EXAMPLE_DESCRIPTOR.trust, 'untrusted')
    assert.equal(EXAMPLE_DESCRIPTOR.install.automatic, false)
  })

  test('a refusal from Core reaches the capability intact', async () => {
    const { gateway } = fakeCore({
      mintEvidence: async () => ({
        ok: false,
        error: {
          error: 'evidence.source_unknown',
          message: 'That source revision is not indexed.',
          fix: 'Index the source first.',
          details: {},
          retryable: false,
          correlationId: null,
        },
      }),
    })
    const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway)
    const result = await host.submitObservation({ sourceRevisionId: 'src@missing', text: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.error.error, 'evidence.source_unknown')
    assert.notEqual(result.error.fix, '')
  })

  test('trajectory records carry identifiers and never payloads', async () => {
    const { state, gateway } = fakeCore()
    const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway)
    host.recordTrajectory({ type: 'observation.created', summary: '2 cues read', evidenceIds: ['ev_core_1'] })
    assert.equal(state.records.length, 1)
    assert.deepEqual(Object.keys(state.records[0]).sort(), ['evidenceIds', 'summary', 'type'])
  })
})

// ── the browser half ────────────────────────────────────────────────────────

describe('a capability’s own view cannot show a verdict nobody issued', () => {
  /** A settled tool block, as the conversation carries one. */
  function block(value) {
    return {
      kind: 'result',
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    }
  }

  const READING = {
    ok: true,
    cues: [{ startMs: 1_000, text: 'Starting the deployment now.' }],
    evidenceIds: ['ev_core_1'],
  }

  test('it renders what the tool returned', () => {
    const markup = renderToStaticMarkup(createElement(SubtitleReadingView, {
      toolName: 'example_read_subtitles',
      block: block(READING),
    }))
    assert.match(markup, /data-example-capability="subtitle-reader"/)
    assert.match(markup, /Starting the deployment now/)
    assert.match(markup, /Evidence: ev_core_1/)
  })

  test('with no verdict, it draws no verdict element at all', () => {
    const markup = renderToStaticMarkup(createElement(SubtitleReadingView, {
      toolName: 'example_read_subtitles',
      block: block(READING),
    }))
    assert.equal(/data-example-verdict/.test(markup), false,
      'a view rendered a verification state nobody issued')
    assert.equal(/UNVERIFIED/.test(markup), false)
  })

  test('a verdict Core issued is rendered verbatim, in the brand’s tone', () => {
    const markup = renderToStaticMarkup(createElement(SubtitleReadingView, {
      toolName: 'example_read_subtitles',
      block: block({ ...READING, verdict: 'FAILED' }),
      tokenForStatus: status => tokenFor(toneFor(status)),
    }))
    assert.match(markup, /data-example-verdict="FAILED"/)
    assert.match(markup, /var\(--watch-tone-error\)/)
  })

  test('a verdict this build has no tone for is not rendered', () => {
    const parsed = readToolValue(block({ ...READING, verdict: 'DEFINITELY_FINE' }))
    assert.equal(parsed.verdict, null, 'an unknown verdict was passed through')
  })

  test('absent and UNVERIFIED stay different facts', () => {
    assert.equal(readToolValue(block(READING)).verdict, null)
    assert.equal(readToolValue(block({ ...READING, verdict: 'UNVERIFIED' })).verdict, 'UNVERIFIED')
  })

  test('an unreadable result renders nothing, so the generic row takes over', () => {
    for (const bad of [null, {}, { kind: 'result', isError: true, content: [] }, { content: [] }]) {
      assert.equal(readToolValue(bad), null)
      assert.equal(
        renderToStaticMarkup(createElement(SubtitleReadingView, { toolName: 't', block: bad })),
        '',
      )
    }
  })

  test('a refusal is not rendered as a reading', () => {
    assert.equal(readToolValue(block({ ok: false, error: 'engine.unavailable' })), null)
  })

  test('registration is additive and keyed to the capability’s own tool', () => {
    const registered = []
    const slots = {
      inject: (name, register) => { register() },
      register: (entry, component) => { registered.push({ entry, component }) },
    }
    registerExampleView(slots, 'example_read_subtitles')
    assert.equal(registered.length, 1)
    assert.equal(registered[0].entry.name, 'tool.call.toolview')
    assert.equal(registered[0].entry.key, 'example_read_subtitles')
    assert.equal(registered[0].component, SubtitleReadingView)
  })
})
