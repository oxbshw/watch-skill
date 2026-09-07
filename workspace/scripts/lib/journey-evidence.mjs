/**
 * What counts as evidence in the real-model journey.
 *
 * Separate from `qa-journey-live.mjs` so the predicates can be run against
 * counterexamples without starting a Host, binding a provider or spending a
 * turn. That matters here more than usual: three of this journey's assertions
 * were satisfied by evidence that did not support them, and the only way to
 * show a fix is a fix is to run the old inputs through the new rule.
 *
 * The counterexamples each rule has to reject are in
 * `tests/journey-evidence.test.mjs`, written from the runs that produced them.
 *
 * @module scripts/lib/journey-evidence
 */

/** The tool each journalled receipt names. */
export function toolsIn(records) {
  const counts = {}
  for (const record of records) {
    const tag = (record.tags ?? []).find(entry => entry.startsWith('tool:'))
    if (tag === undefined) continue
    counts[tag.slice('tool:'.length)] = (counts[tag.slice('tool:'.length)] ?? 0) + 1
  }
  return counts
}

/** The tool a journalled receipt names, or null. */
export function toolOf(record) {
  const tag = (record?.tags ?? []).find(entry => entry.startsWith('tool:'))
  return tag === undefined ? null : tag.slice('tool:'.length)
}

/**
 * Receipts this run appended during one phase, for one session.
 *
 * The whole reason this exists: three assertions were phase-blind, so evidence
 * produced in an earlier phase satisfied a claim about a later one. The worst
 * of them was `LJ-09`, "the broken claim fails" — which passed on a run whose
 * only FAILED verdict came from the *first* verification, where the model had
 * invented a sha256 and Core had rightly refused it. The mismatch phase could
 * have done nothing at all and the claim would still have been green.
 *
 * A phase is a slice of the journal: everything appended between the mark
 * taken before the turn and the journal as it stands after it.
 *
 * @param all - the journal, in dispatch order.
 * @param from - how many records existed when the phase began.
 * @param sessionId - the session the phase belongs to.
 */
export function phaseSlice(all, from, sessionId) {
  return all.slice(from).filter(record =>
    sessionId === undefined || record.runId === undefined || record.runId === sessionId)
}

/** Verifications in a slice, with the verdict Core returned for each. */
export function verificationsIn(records) {
  return records
    .filter(record => toolOf(record) === 'watch_verify')
    .map(record => ({
      recordId: record.recordId ?? null,
      verdict: typeof record.verdict === 'string' ? record.verdict : null,
      identities: (record.evidenceIds ?? []).filter(id => String(id).startsWith('ver_')),
      text: typeof record.text === 'string' ? record.text : '',
    }))
}

/**
 * Did the Library hand back, for every verification, the verdict the journal
 * recorded and the Core identity that produced it?
 *
 * `LJ-12` used to count `outcome === 'record'` and distinct revision ids and
 * nothing else, so a row opening with `verdict: null` — the exact defect this
 * release was opened to close — satisfied it.
 *
 * @param opened - `libraryGet` answers, in the same order as `journal`.
 * @param journal - the verifications as the journal recorded them.
 */
export function libraryAgreesWithCore(opened, journal) {
  if (opened.length === 0 || opened.length !== journal.length) {
    return { ok: false, reason: 'nothing was opened, or the two lists disagree in length' }
  }
  const rows = []
  for (const [at, entry] of opened.entries()) {
    const shown = entry?.record?.verdict ?? null
    const recorded = journal[at]?.verdict ?? null
    rows.push({
      recordId: journal[at]?.recordId ?? null,
      outcome: entry?.outcome ?? null,
      shown,
      recorded,
      revisionId: entry?.record?.revisionId ?? null,
    })
  }
  const problems = []
  for (const row of rows) {
    if (row.outcome !== 'record') problems.push(`${row.recordId}: did not open`)
    // The point of the whole exercise: a row Compare renders must carry a
    // verdict, and it must be the one Core issued.
    else if (typeof row.shown !== 'string' || row.shown === '') {
      problems.push(`${row.recordId}: opened with no verdict (${JSON.stringify(row.shown)})`)
    } else if (row.shown !== row.recorded) {
      problems.push(`${row.recordId}: Library shows ${row.shown}, journal recorded ${row.recorded}`)
    } else if (typeof row.revisionId !== 'string' || row.revisionId === '') {
      problems.push(`${row.recordId}: no revision identity`)
    }
  }
  const revisions = new Set(rows.map(row => row.revisionId).filter(Boolean))
  if (revisions.size !== rows.length) {
    problems.push('two rows share a revision identity, so they are one row rewritten')
  }
  return { ok: problems.length === 0, problems, rows }
}

/**
 * Did a perception call actually read the fixture?
 *
 * `LJ-13` used to accept any `watch_*` tool other than `watch_verify` on a
 * settled turn, so `watch_capabilities` — which reads nothing — satisfied a
 * claim about reading a video. What is required now is the token that was
 * drawn into the frames and a timestamp to go with it.
 *
 * @param records - receipts from the perception phase.
 * @param token - the on-screen text the fixture was generated with.
 */
export function perceptionProved(records, token) {
  const reads = records.filter((record) => {
    const tool = toolOf(record)
    return tool !== null && tool.startsWith('watch_') && tool !== 'watch_verify'
  })
  for (const record of reads) {
    const text = typeof record.text === 'string' ? record.text : ''
    if (!text.includes(token)) continue
    // A timestamp beside the text, because "the video contains this word" and
    // "this word is on screen at 0.477s" are different answers and only the
    // second one is evidence of a read.
    const stamp = /"timestampMs"\s*:\s*(\d+)/.exec(text)
      ?? /"timestamp_ms"\s*:\s*(\d+)/.exec(text)
    if (stamp === null) continue
    return { ok: true, tool: toolOf(record), token, timestampMs: Number(stamp[1]) }
  }
  return {
    ok: false,
    tool: null,
    token,
    timestampMs: null,
    tried: reads.map(record => toolOf(record)),
    reason: reads.length === 0
      ? 'no Watch read tool was called in this phase'
      : `no call returned ${token} with a timestamp beside it`,
  }
}

/**
 * Did the delegated child actually do the work and report back?
 *
 * The presence of a `subagent` receipt says a child was started, which is not
 * the claim. What is asserted is the child's own outcome: a completed receipt
 * whose recorded result names what it was sent to find.
 *
 * @param records - receipts from the delegation phase.
 * @param expected - strings the child's answer has to contain.
 */
export function delegationSucceeded(records, expected) {
  const children = records.filter(record => ['subagent', 'task'].includes(toolOf(record)))
  if (children.length === 0) {
    return { ok: false, reason: 'no child task was dispatched in this phase' }
  }
  for (const child of children) {
    const state = (child.tags ?? []).find(tag => tag.startsWith('state:')) ?? null
    const text = typeof child.text === 'string' ? child.text : ''
    if (state !== 'state:completed') continue
    const missing = expected.filter(want => !text.includes(want))
    if (missing.length === 0) {
      return { ok: true, state, chars: text.length }
    }
  }
  return {
    ok: false,
    reason: 'a child was dispatched, but none completed with a result naming what it found',
    states: children.map(child =>
      (child.tags ?? []).find(tag => tag.startsWith('state:')) ?? null),
  }
}

