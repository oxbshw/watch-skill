/**
 * The product shell, and the four things it must not get wrong.
 *
 * 1. Seven modes, one session. Switching what is on screen never changes what
 *    is being looked at, because the moment it can, "the agent verified it but
 *    Watch shows nothing" becomes a plausible state of the product rather than
 *    a bug.
 * 2. A capability that is absent is *said*, never hidden and never faked. Both
 *    silent failure modes are tested here, because both are what happens when
 *    nobody tests either.
 * 3. The sensory timeline is a projection. Same input, same output, gaps
 *    intact, and no density may hide a verdict.
 * 4. The composer's guarded axes are one-way for the agent.
 *
 * The rendering assertions run through `react-dom/server`. That is a real gate
 * on the markup — disabled state, accessible names, non-colour status signals —
 * without pretending to be a browser test.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  DENSITY_LANES,
  DSH_SIDEBAR_ROWS,
  GUARDED_AXES,
  INSPECTOR_PANELS,
  MODE_DESCRIPTORS,
  TIMELINE_LANES,
  WORKSPACE_MODES,
  buildTimeline,
  defaultComposer,
  defaultPanel,
  describeComposer,
  hasHiddenGap,
  headlineVerdict,
  initialState,
  modeForSelection,
  privacyChip,
  proposeChange,
  resolveMode,
  resolveModes,
  sessionHeader,
  sidebarRows,
  switchMode,
  switchSession,
  timelineDigest,
  validate,
} from '@watchskill/dsh-workspace'

import {
  ComposerPanel,
  ModeSwitcher,
  SensoryTimelineStrip,
  SessionHeaderBar,
  WorkspaceShell,
} from '@watchskill/dsh-workspace/components'

// ── fixtures ────────────────────────────────────────────────────────────────

function capability(capabilityId, status, extra = {}) {
  return {
    capabilityId,
    provider: 'watch-core',
    providerVersion: '1.3.0rc2',
    status,
    requirements: [],
    detected: {},
    missing: [],
    fixes: [],
    lastCheckedAt: '2026-08-27T00:00:00Z',
    ...extra,
  }
}

function health(phase, extra = {}) {
  return {
    phase,
    transport: 'stdio',
    handshake: null,
    error: null,
    changedAt: '2026-08-27T00:00:00Z',
    ...extra,
  }
}

/** An engine where everything Watch needs has actually run here. */
const READY = {
  capabilities: [capability('source.ask', 'machine_tested'), capability('live.observe', 'machine_tested'), capability('library.search', 'machine_tested')],
  health: health('ready'),
}

function toolCall(seq, callId, name) {
  return { type: 'tool/call', seq, time: 1_700_000_000_000 + seq, data: { callId, name, arguments: {}, turn: 1, step: seq } }
}

function toolResult(seq, callId, value) {
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { turn: 1, message: { source: { callId }, content: [{ content: [{ type: 'text', text: JSON.stringify(value) }] }] } },
  }
}

function evidenceRecord(evidenceId, modality, overrides = {}) {
  return {
    evidenceId,
    sourceRevisionId: 'src@rev1',
    artifactIds: [],
    temporalRange: { startMs: 1000, endMs: 2000 },
    spatialRegion: null,
    modality,
    provenance: 'observation',
    producer: 'watch-core',
    producerVersion: '1.3.0rc2',
    captureQuality: null,
    gaps: [],
    freshness: 'current',
    contentDigest: `sha256:${evidenceId}`,
    retentionClass: 'session',
    confidence: null,
    ...overrides,
  }
}

// ── modes ───────────────────────────────────────────────────────────────────

describe('seven modes, one session', () => {
  test('every mode in the vision is present, in order', () => {
    assert.deepEqual(
      [...WORKSPACE_MODES],
      ['agent', 'watch', 'live', 'memory', 'library', 'compare', 'trajectory'],
    )
    for (const mode of WORKSPACE_MODES) {
      assert.equal(MODE_DESCRIPTORS[mode].id, mode)
      assert.notEqual(MODE_DESCRIPTORS[mode].label, '')
    }
  })

  test('switching mode cannot change the session', () => {
    const start = initialState('ws-1', 'sess-1')
    let state = start
    for (const mode of WORKSPACE_MODES) {
      state = switchMode(state, mode)
      assert.equal(state.sessionId, 'sess-1', `${mode} changed the session`)
      assert.equal(state.workspaceId, 'ws-1')
    }
    assert.equal(state.mode, 'trajectory')
    assert.equal(state.previousMode, 'compare')
  })

  test('switching session keeps the mode', () => {
    const state = switchSession(switchMode(initialState('ws-1', 'sess-1'), 'live'), 'sess-2')
    assert.equal(state.mode, 'live')
    assert.equal(state.sessionId, 'sess-2')
  })

  test('switching to the mode already open is a no-op object', () => {
    const state = switchMode(initialState('ws-1', 'sess-1'), 'agent')
    assert.equal(state.mode, 'agent')
    assert.equal(state.previousMode, null)
  })

  test('a deep link resolves to a mode that can show the thing', () => {
    const none = { memoryId: null, sourceId: null, verificationId: null, receiptId: null, evidenceId: null }
    assert.equal(modeForSelection({ ...none, memoryId: 'mem-1' }), 'memory')
    assert.equal(modeForSelection({ ...none, verificationId: 'v-1' }), 'trajectory')
    assert.equal(modeForSelection({ ...none, receiptId: 'r-1' }), 'trajectory')
    assert.equal(modeForSelection({ ...none, evidenceId: 'e-1' }), 'watch')
    assert.equal(modeForSelection({ ...none, sourceId: 's-1' }), 'library')
    assert.equal(modeForSelection(none), 'agent')
  })
})

describe('a missing capability is said, not hidden', () => {
  test('with no engine, the Core-backed modes are unavailable with a reason and a fix', () => {
    const states = resolveModes({ capabilities: [], health: null })
    const byId = new Map(states.map(state => [state.id, state]))
    for (const mode of ['watch', 'live', 'library']) {
      const state = byId.get(mode)
      assert.equal(state.availability, 'unavailable', `${mode} should be unavailable`)
      assert.notEqual(state.reason, '', `${mode} must say why`)
      assert.notEqual(state.fix, '', `${mode} must say what to do`)
    }
  })

  test('the local modes still work without an engine', () => {
    const states = resolveModes({ capabilities: [], health: null })
    const byId = new Map(states.map(state => [state.id, state]))
    for (const mode of ['agent', 'memory', 'compare', 'trajectory']) {
      assert.equal(byId.get(mode).availability, 'available', `${mode} needs no engine`)
    }
  })

  test('no mode is ever dropped from the switcher', () => {
    for (const env of [{ capabilities: [], health: null }, READY, { capabilities: [], health: health('failed') }]) {
      assert.equal(resolveModes(env).length, WORKSPACE_MODES.length)
    }
  })

  test('a capability that exists but was never run here is degraded, not available', () => {
    const state = resolveMode('live', {
      capabilities: [capability('live.observe', 'implemented')],
      health: health('ready'),
    })
    assert.equal(state.availability, 'degraded')
    assert.match(state.reason, /implemented/)
  })

  test('a probe passing is not a mode working', () => {
    const state = resolveMode('library', {
      capabilities: [capability('library.search', 'probed')],
      health: health('ready'),
    })
    assert.equal(state.availability, 'degraded')
  })

  test('an unavailable capability carries the engine’s own fix', () => {
    const state = resolveMode('live', {
      capabilities: [capability('live.observe', 'unavailable', { fixes: ['Install ffmpeg.'] })],
      health: health('ready'),
    })
    assert.equal(state.availability, 'unavailable')
    assert.equal(state.fix, 'Install ffmpeg.')
  })

  test('everything machine tested is available and says nothing extra', () => {
    for (const state of resolveModes(READY)) {
      assert.equal(state.availability, 'available', `${state.id} should be available`)
      assert.equal(state.reason, '')
    }
  })

  test('a degraded bridge degrades its modes even when capabilities are proven', () => {
    const state = resolveMode('watch', {
      capabilities: READY.capabilities,
      health: health('degraded', {
        error: { error: 'protocol.partial', message: 'Negotiated protocol 1 of 2.', fix: 'Upgrade Watch Core.', details: {}, retryable: false, correlationId: null },
      }),
    })
    assert.equal(state.availability, 'degraded')
    assert.equal(state.fix, 'Upgrade Watch Core.')
  })
})

// ── shell ───────────────────────────────────────────────────────────────────

describe('the shell composition', () => {
  test('DSH’s own operations rows survive in the sidebar', () => {
    const ids = sidebarRows().map(row => row.id)
    for (const row of DSH_SIDEBAR_ROWS) {
      assert.ok(ids.includes(row.id), `${row.id} must remain reachable`)
    }
  })

  test('the sidebar carries every row the product promises', () => {
    const ids = sidebarRows().map(row => row.id)
    for (const expected of ['workspaces', 'sessions', 'live', 'memory', 'library', 'saved-verification', 'search', 'jobs', 'schedules', 'plugins', 'settings']) {
      assert.ok(ids.includes(expected), `sidebar is missing ${expected}`)
    }
  })

  test('every inspector panel the vision names exists', () => {
    assert.deepEqual(
      [...INSPECTOR_PANELS],
      ['evidence', 'verification', 'memory', 'tools', 'files', 'browser', 'network', 'console', 'run'],
    )
  })

  test('every mode opens on a panel that exists', () => {
    for (const mode of WORKSPACE_MODES) {
      assert.ok(INSPECTOR_PANELS.includes(defaultPanel(mode)), `${mode} opens on an unknown panel`)
    }
  })

  test('a proven failure outranks a proven success in the header', () => {
    assert.equal(headlineVerdict(['VERIFIED', 'FAILED']), 'FAILED')
    assert.equal(headlineVerdict(['FAILED', 'VERIFIED']), 'FAILED')
    assert.equal(headlineVerdict(['UNVERIFIED', 'VERIFIED']), 'VERIFIED')
    assert.equal(headlineVerdict([]), null)
  })

  test('privacy is reported from the policy, never assumed', () => {
    assert.match(privacyChip(null).label, /unknown/)
    const chip = privacyChip({
      offlineOnly: true,
      cloudPerceptionOptIn: false,
      memoryMode: 'local_personal',
      defaultRetentionClass: 'session',
    })
    assert.equal(chip.offlineOnly, true)
    assert.match(chip.label, /Offline only/)
    assert.match(chip.label, /local personal/)
  })

  test('execution state and verification state are separate header fields', () => {
    const state = sessionHeader({
      sessionId: 'sess-1',
      agentModel: 'deepseek-chat',
      roleBindings: [],
      dshConnected: true,
      health: health('ready'),
      execution: 'completed',
      verdicts: ['UNVERIFIED'],
      runId: 'run-1',
      costLabel: '$0.01',
      degraded: [],
    })
    assert.equal(state.execution, 'completed')
    assert.equal(state.verification, 'UNVERIFIED')
  })
})

// ── timeline ────────────────────────────────────────────────────────────────

describe('the sensory timeline is a projection', () => {
  const events = [
    toolCall(1, 'c1', 'watch_ask_source'),
    toolResult(2, 'c1', {
      ok: true,
      answer: 'observed',
      evidence: [
        { evidenceId: 'e-visual', sourceRevisionId: 'src@rev1', temporalRange: { startMs: 1000, endMs: 2000 } },
        { evidenceId: 'e-audio', sourceRevisionId: 'src@rev1', temporalRange: { startMs: 1000, endMs: 2000 } },
      ],
    }),
    toolCall(3, 'c2', 'watch_verify'),
    toolResult(4, 'c2', { ok: true, verdict: 'FAILED', verificationId: 'v-1', evidenceRefs: ['e-visual'] }),
    { type: 'tool/result', seq: 5, time: 1_700_000_000_005, data: { isError: true, name: 'shell', message: { source: { callId: 'c3' }, isError: true } } },
  ]

  function inputFor(evidence) {
    // Imported lazily through the trajectory package the projection lives in.
    return { sessionId: 'sess-1', events, projection: evidence.projection, evidence: evidence.map }
  }

  test('the same input builds the same timeline, twice', async () => {
    const { project } = await import('@watchskill/dsh-trajectory')
    const projection = project(events, 'sess-1')
    const input = { sessionId: 'sess-1', events, projection }
    const first = buildTimeline(input, 'analysis')
    const second = buildTimeline(input, 'analysis')
    assert.equal(timelineDigest(first), timelineDigest(second))
    assert.deepEqual(first.entries, second.entries)
  })

  test('lane assignment says whether evidence or only a record decided it', async () => {
    const { project } = await import('@watchskill/dsh-trajectory')
    const projection = project(events, 'sess-1')
    const unresolved = buildTimeline({ sessionId: 'sess-1', events, projection }, 'analysis')
    // Only the evidence rows. A verdict also references evidence, and it
    // belongs on the verdicts lane whatever the evidence turns out to be.
    const evidenceRows = unresolved.entries.filter(entry => entry.recordId?.endsWith(':evidence') === true)
    assert.ok(evidenceRows.length > 0)
    for (const entry of evidenceRows) {
      assert.equal(entry.laneSource, 'record')
      assert.equal(entry.lane, 'tools', 'unresolved evidence must not be filed under a guessed sense')
    }

    const map = new Map([
      ['e-visual', evidenceRecord('e-visual', 'visual')],
      ['e-audio', evidenceRecord('e-audio', 'audio')],
    ])
    const resolved = buildTimeline(inputFor({ projection, map }), 'analysis')
    const lanes = new Map(resolved.entries
      .filter(entry => entry.recordId?.endsWith(':evidence') === true)
      .map(entry => [entry.evidenceId, entry.lane]))
    assert.equal(lanes.get('e-visual'), 'media')
    assert.equal(lanes.get('e-audio'), 'speech')
  })

  test('a gap is its own entry, and is never smoothed away', async () => {
    const { project } = await import('@watchskill/dsh-trajectory')
    const projection = project(events, 'sess-1')
    const map = new Map([
      ['e-visual', evidenceRecord('e-visual', 'visual', { gaps: [{ startMs: 1200, endMs: 1500 }], freshness: 'gap' })],
      ['e-audio', evidenceRecord('e-audio', 'audio')],
    ])
    const timeline = buildTimeline(inputFor({ projection, map }), 'analysis')
    const gaps = timeline.entries.filter(entry => entry.kind === 'gap')
    assert.equal(gaps.length, 1)
    assert.deepEqual(gaps[0].range, { startMs: 1200, endMs: 1500 })
  })

  test('no density can hide a verdict, an action or an error', () => {
    for (const density of ['collapsed', 'compact', 'analysis']) {
      for (const lane of ['verdicts', 'actions', 'errors']) {
        assert.ok(DENSITY_LANES[density].includes(lane), `${density} hides ${lane}`)
      }
    }
  })

  test('density only ever adds lanes', () => {
    const collapsed = new Set(DENSITY_LANES.collapsed)
    const compact = new Set(DENSITY_LANES.compact)
    for (const lane of collapsed) assert.ok(compact.has(lane))
    for (const lane of compact) assert.ok(DENSITY_LANES.analysis.includes(lane))
    assert.deepEqual([...DENSITY_LANES.analysis], [...TIMELINE_LANES])
  })

  test('collapsing counts what it hid, and flags a hidden gap', async () => {
    const { project } = await import('@watchskill/dsh-trajectory')
    const projection = project(events, 'sess-1')
    const map = new Map([
      ['e-visual', evidenceRecord('e-visual', 'visual', { gaps: [{ startMs: 1200, endMs: 1500 }] })],
      ['e-audio', evidenceRecord('e-audio', 'audio')],
    ])
    const input = inputFor({ projection, map })
    const collapsed = buildTimeline(input, 'collapsed')
    assert.ok(collapsed.hidden > 0)
    assert.equal(hasHiddenGap(input, 'collapsed'), true)
    assert.equal(hasHiddenGap(input, 'analysis'), false)
  })

  test('a FAILED verdict survives the tightest density', async () => {
    const { project } = await import('@watchskill/dsh-trajectory')
    const projection = project(events, 'sess-1')
    const collapsed = buildTimeline({ sessionId: 'sess-1', events, projection }, 'collapsed')
    assert.ok(collapsed.entries.some(entry => entry.verdict === 'FAILED'))
  })

  test('memory records never appear on a sensory lane', async () => {
    const { recordFromMemoryEvent, withRecords, project } = await import('@watchskill/dsh-trajectory')
    const projection = project(events, 'sess-1')
    const memory = recordFromMemoryEvent({
      sessionId: 'sess-1',
      seq: 9,
      time: 1_700_000_000_009,
      type: 'memory.context.injected',
      memoryIds: ['mem-1'],
      summary: '2 memories injected',
      redacted: true,
    })
    const withMemory = withRecords(projection, [memory])
    const timeline = buildTimeline({ sessionId: 'sess-1', events, projection: withMemory }, 'analysis')
    assert.equal(timeline.entries.some(entry => entry.recordId === memory.recordId), false)
  })
})

// ── composer ────────────────────────────────────────────────────────────────

describe('the composer’s guarded axes are one-way for the agent', () => {
  const base = defaultComposer()

  test('the default opens narrow', () => {
    assert.deepEqual([...base.sources], [])
    assert.equal(base.sideEffects, 'none')
    assert.equal(base.privacy.offlineOnly, true)
    assert.equal(base.privacy.localMediaOnly, true)
    assert.deepEqual([...base.privacy.egressRoutes], [])
  })

  test('an agent cannot add a source', () => {
    const decision = proposeChange(base, { sources: ['camera'] }, 'agent')
    assert.equal(decision.ok, false)
    assert.ok(decision.refusals.some(refusal => refusal.axis === 'source_scope'))
    assert.deepEqual([...decision.config.sources], [])
  })

  test('an agent cannot broaden the scope selector', () => {
    const scoped = { ...base, scope: 'time_range', scopeRefs: ['src-1'] }
    const decision = proposeChange(scoped, { scope: 'all' }, 'agent')
    assert.equal(decision.ok, false)
  })

  test('an agent cannot add a referent to the same scope selector', () => {
    const scoped = { ...base, scope: 'source', scopeRefs: ['src-1'] }
    const decision = proposeChange(scoped, { scopeRefs: ['src-1', 'src-2'] }, 'agent')
    assert.equal(decision.ok, false)
  })

  test('an agent cannot send media to the cloud', () => {
    const decision = proposeChange(base, { privacy: { ...base.privacy, localMediaOnly: false } }, 'agent')
    assert.equal(decision.ok, false)
    assert.ok(decision.refusals.some(refusal => refusal.axis === 'cloud_media'))
  })

  test('an agent cannot grant itself a network route', () => {
    const online = { ...base, privacy: { offlineOnly: false, localMediaOnly: true, egressRoutes: ['api.example.com'] } }
    const decision = proposeChange(online, {
      privacy: { offlineOnly: false, localMediaOnly: true, egressRoutes: ['api.example.com', 'evil.example.com'] },
    }, 'agent')
    assert.equal(decision.ok, false)
    assert.ok(decision.refusals.some(refusal => refusal.axis === 'egress'))
  })

  test('an agent cannot turn offline mode off', () => {
    const decision = proposeChange(base, { privacy: { ...base.privacy, offlineOnly: false } }, 'agent')
    assert.equal(decision.ok, false)
  })

  test('an agent cannot widen what it may do to the world', () => {
    const decision = proposeChange(base, { sideEffects: 'permitted_set' }, 'agent')
    assert.equal(decision.ok, false)
    assert.ok(decision.refusals.some(refusal => refusal.axis === 'side_effects'))
  })

  test('an agent cannot add itself a tool', () => {
    const allowed = { ...base, sideEffects: 'approved_each', permittedTools: ['watch_browser_act'] }
    const decision = proposeChange(allowed, { permittedTools: ['watch_browser_act', 'shell'] }, 'agent')
    assert.equal(decision.ok, false)
  })

  test('an agent cannot lower the standard of proof', () => {
    const strict = { ...base, verify: { ...base.verify, assurance: 'deterministic', expectation: 'the row exists' } }
    const decision = proposeChange(strict, { verify: { ...strict.verify, assurance: 'observed' } }, 'agent')
    assert.equal(decision.ok, false)
    assert.ok(decision.refusals.some(refusal => refusal.axis === 'assurance'))
  })

  test('an agent cannot broaden what may be remembered', () => {
    const decision = proposeChange(base, { remember: 'workspace' }, 'agent')
    assert.equal(decision.ok, false)
  })

  test('a refused proposal is refused in full, never partially applied', () => {
    const decision = proposeChange(base, {
      observe: ['visual', 'ocr', 'speech'],
      sources: ['camera'],
    }, 'agent')
    assert.equal(decision.ok, false)
    assert.deepEqual([...decision.config.observe], ['visual', 'ocr'])
  })

  test('an agent may narrow anything', () => {
    const wide = {
      ...base,
      sources: ['video', 'camera'],
      scope: 'all',
      sideEffects: 'permitted_set',
      permittedTools: ['a', 'b'],
      privacy: { offlineOnly: false, localMediaOnly: false, egressRoutes: ['a.example.com'] },
    }
    const decision = proposeChange(wide, {
      sources: ['video'],
      scope: 'source',
      scopeRefs: [],
      sideEffects: 'none',
      permittedTools: [],
      privacy: { offlineOnly: true, localMediaOnly: true, egressRoutes: [] },
    }, 'agent')
    assert.equal(decision.ok, true)
    assert.deepEqual([...decision.config.sources], ['video'])
  })

  test('an agent may raise the standard of proof', () => {
    const decision = proposeChange(base, {
      verify: { expectation: 'the row exists', contractId: null, assurance: 'deterministic', timeoutMs: null },
    }, 'agent')
    assert.equal(decision.ok, true)
  })

  test('a person may widen every guarded axis', () => {
    const decision = proposeChange(base, {
      sources: ['camera', 'screen'],
      scope: 'all',
      sideEffects: 'permitted_set',
      permittedTools: ['watch_browser_act'],
      remember: 'workspace',
      privacy: { offlineOnly: false, localMediaOnly: false, egressRoutes: ['api.example.com'] },
    }, 'user')
    assert.equal(decision.ok, true)
    assert.ok(decision.changed.includes('sources'))
    assert.ok(decision.changed.includes('privacy'))
  })

  test('every guarded axis has a refusal path a person can act on', () => {
    const seen = new Set()
    const cases = [
      [base, { sources: ['camera'] }],
      [base, { privacy: { ...base.privacy, localMediaOnly: false } }],
      [base, { privacy: { ...base.privacy, offlineOnly: false } }],
      [base, { sideEffects: 'permitted_set' }],
      [{ ...base, verify: { ...base.verify, assurance: 'deterministic' } }, { verify: { ...base.verify, assurance: 'none' } }],
    ]
    for (const [from, change] of cases) {
      const decision = proposeChange(from, change, 'agent')
      assert.equal(decision.ok, false)
      for (const refusal of decision.refusals) {
        assert.notEqual(refusal.fix, '', `${refusal.axis} refusal has no fix`)
        seen.add(refusal.axis)
      }
    }
    for (const axis of GUARDED_AXES) assert.ok(seen.has(axis), `${axis} was never exercised`)
  })

  test('validation catches a claim with nothing behind it', () => {
    const problems = validate({ ...base, verify: { ...base.verify, assurance: 'deterministic' } })
    assert.ok(problems.some(problem => /expectation or a contract/.test(problem)))
  })

  test('validation catches network permitted with no route named', () => {
    const problems = validate({ ...base, privacy: { offlineOnly: false, localMediaOnly: true, egressRoutes: [] } })
    assert.ok(problems.some(problem => /no egress route/.test(problem)))
  })

  test('the one-line summary leads with what was observed and what counts as proof', () => {
    const line = describeComposer(base)
    assert.match(line, /no source/)
    assert.match(line, /observation only/)
    assert.match(line, /offline/)
  })
})

// ── rendering ───────────────────────────────────────────────────────────────

describe('what the shell actually draws', () => {
  test('an unavailable mode is drawn, disabled, with its reason readable', () => {
    const states = resolveModes({ capabilities: [], health: null })
    const markup = renderToStaticMarkup(
      createElement(ModeSwitcher, { active: 'agent', states, onSelect: () => {} }),
    )
    assert.match(markup, /data-watch-mode="live"/)
    assert.match(markup, /aria-disabled="true"/)
    assert.match(markup, /Watch Core is not configured/)
  })

  test('every mode tab is present in the markup', () => {
    const markup = renderToStaticMarkup(
      createElement(ModeSwitcher, { active: 'agent', states: resolveModes(READY), onSelect: () => {} }),
    )
    for (const mode of WORKSPACE_MODES) {
      assert.match(markup, new RegExp(`data-watch-mode="${mode}"`))
    }
  })

  test('a verdict is never signalled by colour alone', () => {
    const markup = renderToStaticMarkup(createElement(SessionHeaderBar, {
      state: sessionHeader({
        sessionId: 'sess-1',
        agentModel: 'deepseek-chat',
        roleBindings: [],
        dshConnected: true,
        health: health('ready'),
        execution: 'completed',
        verdicts: ['FAILED'],
        runId: null,
        costLabel: null,
        degraded: [],
      }),
    }))
    assert.match(markup, /data-watch-status="FAILED"/)
    assert.match(markup, /✗/)
    assert.match(markup, /FAILED/)
    // The agent finishing is drawn as its own fact, never as the verdict.
    assert.match(markup, /agent completed/)
  })

  test('a gap is drawn as a gap, with a glyph as well as a tone', async () => {
    const { project } = await import('@watchskill/dsh-trajectory')
    const events = [
      toolCall(1, 'c1', 'watch_ask_source'),
      toolResult(2, 'c1', { ok: true, answer: 'x', evidence: [{ evidenceId: 'e1', sourceRevisionId: 'src@rev1', temporalRange: { startMs: 0, endMs: 10 } }] }),
    ]
    const timeline = buildTimeline({
      sessionId: 'sess-1',
      events,
      projection: project(events, 'sess-1'),
      evidence: new Map([['e1', evidenceRecord('e1', 'visual', { freshness: 'gap' })]]),
    }, 'analysis')
    const markup = renderToStaticMarkup(createElement(SensoryTimelineStrip, {
      timeline,
      onDensity: () => {},
      onSelect: () => {},
    }))
    assert.match(markup, /data-watch-kind="gap"/)
    assert.match(markup, /capture gap/)
    assert.match(markup, /⌇/)
  })

  test('the composer shows a refused agent request rather than swallowing it', () => {
    const decision = proposeChange(defaultComposer(), { sources: ['camera'] }, 'agent')
    const markup = renderToStaticMarkup(createElement(ComposerPanel, {
      config: defaultComposer(),
      refusals: decision.refusals,
    }))
    assert.match(markup, /data-watch-axis="source_scope"/)
    assert.match(markup, /cannot add a source/)
  })

  test('the shell renders exactly one session id, whichever mode is open', async () => {
    const { project } = await import('@watchskill/dsh-trajectory')
    const projection = project([], 'sess-1')
    const timeline = buildTimeline({ sessionId: 'sess-1', events: [], projection }, 'compact')
    for (const mode of WORKSPACE_MODES) {
      const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
        sessionId: 'sess-1',
        mode,
        modeStates: resolveModes(READY),
        header: sessionHeader({
          sessionId: 'sess-1',
          agentModel: 'deepseek-chat',
          roleBindings: [],
          dshConnected: true,
          health: health('ready'),
          execution: 'running',
          verdicts: [],
          runId: null,
          costLabel: null,
          degraded: [],
        }),
        rows: sidebarRows(),
        panel: defaultPanel(mode),
        timeline,
        composer: defaultComposer(),
        onMode: () => {},
        onPanel: () => {},
        onDensity: () => {},
        onEntry: () => {},
        onRow: () => {},
      }))
      const occurrences = markup.match(/data-watch-session="sess-1"/g) ?? []
      assert.equal(occurrences.length, 2, `${mode} rendered ${String(occurrences.length)} session markers`)
      assert.match(markup, new RegExp(`data-watch-mode-body="${mode}"`))
    }
  })

  test('DSH’s operations rows are rendered, marked as upstream’s', async () => {
    const { project } = await import('@watchskill/dsh-trajectory')
    const projection = project([], 'sess-1')
    const markup = renderToStaticMarkup(createElement(WorkspaceShell, {
      sessionId: 'sess-1',
      mode: 'agent',
      modeStates: resolveModes(READY),
      header: sessionHeader({
        sessionId: 'sess-1', agentModel: null, roleBindings: [], dshConnected: true,
        health: health('ready'), execution: 'queued', verdicts: [], runId: null, costLabel: null, degraded: [],
      }),
      rows: sidebarRows(),
      panel: 'tools',
      timeline: buildTimeline({ sessionId: 'sess-1', events: [], projection }, 'collapsed'),
      composer: defaultComposer(),
      onMode: () => {}, onPanel: () => {}, onDensity: () => {}, onEntry: () => {}, onRow: () => {},
    }))
    for (const row of DSH_SIDEBAR_ROWS) {
      assert.match(markup, new RegExp(`data-watch-row="${row.id}"`))
    }
    assert.match(markup, /data-watch-origin="dsh"/)
  })
})
