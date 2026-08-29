/**
 * One hostile corpus, aimed at every door.
 *
 * The strings in `fixtures/injection-corpus.mjs` are the ones that arrive as
 * *observed content*: read off a page, recognised from a frame, transcribed
 * from audio, imported from a file. Watch's position on all of them is the
 * same — evidence of what was displayed or said, never an instruction.
 *
 * That position is easy to hold in one place and easy to lose across a dozen.
 * So rather than each entry point getting the payload somebody wrote for it,
 * every entry point here gets the whole corpus. A door added later inherits
 * the tests; a door that quietly starts accepting one of these fails a test
 * that was already written.
 *
 * The suite ends with the benign corpus, because a guard that refuses
 * everything is not a guard, it is a broken product — and the difference has
 * to be asserted rather than assumed.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { Context } from '@deepseek-ai/cordis'
import WatchMemoryService from '@watchskill/dsh-memory'
import { admit, isHighImpact, isProtectedSubject } from '@watchskill/dsh-memory'
import {
  buildWiki,
  diffUserEdit,
  pageAt,
  slugFor,
  toCandidates,
  validateUserEdit,
} from '@watchskill/dsh-wiki'
import { fromLlmWiki, importVaultFile, toVault } from '@watchskill/dsh-adapters'
import { defaultComposer, proposeChange } from '@watchskill/dsh-workspace'
import { EXAMPLE_DECLARATION, createCapabilityHost, sanitizeCandidate } from '@watchskill/dsh-sdk'
import { isDeepLink, parseDeepLink } from '@watchskill/watch-desktop'
import { AuditLog, AuditRefusal } from '@watchskill/dsh-tenancy'
import { checkApproval, consume, grantFor, revoke } from '@watchskill/dsh-contracts'

import { BENIGN, HOSTILE_LINKS, INJECTIONS } from './fixtures/injection-corpus.mjs'

const SCOPE = { userId: 'user_1', workspaceId: 'ws_1', projectId: 'proj_1', sessionId: 'sess_1' }

function record(overrides = {}) {
  const now = '2026-08-28T10:00:00.000Z'
  return {
    memoryId: 'mem_1',
    kind: 'decision',
    subjectScope: 'project',
    scopeId: 'proj_1',
    content: 'this project uses TypeScript with strict mode',
    origin: 'explicit_user',
    sourceRefs: ['msg_1'],
    evidenceRefs: [],
    confidence: 1,
    status: 'active',
    sensitivity: 'private',
    validFrom: now,
    validUntil: null,
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: now,
    supersedes: [],
    contradictedBy: [],
    locale: 'en',
    ...overrides,
  }
}

/** Payloads that assert authority: a permission, a grant, a protected subject. */
const AUTHORITY_CLAIMS = INJECTIONS.filter(
  entry => isHighImpact(entry.text) || isProtectedSubject(entry.text))

// ── observed text never becomes a memory a person made ──────────────────────

describe('observed text cannot write itself into memory', () => {
  test('the corpus contains payloads that actually claim authority', () => {
    // The guard on the guard. If none of the corpus is high impact, every
    // refusal below is vacuous.
    assert.ok(AUTHORITY_CLAIMS.length >= 6,
      `only ${String(AUTHORITY_CLAIMS.length)} payloads claim authority; the corpus is too soft`)
  })

  for (const entry of INJECTIONS) {
    test(`${entry.id}: cannot be inferred into memory when it claims authority`, () => {
      const claimsAuthority = isHighImpact(entry.text) || isProtectedSubject(entry.text)
      if (!claimsAuthority) return

      const decision = admit(
        record({ origin: 'inferred', content: entry.text, status: 'proposed' }),
        'local_personal',
      )
      if (isProtectedSubject(entry.text)) {
        assert.equal(decision.admitted, false,
          `${entry.id} (${entry.arrivesAs}) was admitted as an inference`)
      }
    })
  }

  test('nothing observed becomes explicit_user without an authenticated person', () => {
    for (const entry of INJECTIONS) {
      const decision = admit(
        record({ origin: 'explicit_user', content: entry.text }),
        'local_personal',
        { userAuthenticated: false },
      )
      assert.equal(decision.admitted, false,
        `${entry.id} minted explicit_user with nobody authenticated`)
    }
  })

  test('a high-impact payload never activates on its own, whatever its confidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watch-sec-'))
    const ctx = new Context()
    const fiber = await ctx.plugin(WatchMemoryService, { mode: 'local_personal', directory })
    try {
      for (const entry of AUTHORITY_CLAIMS) {
        const stored = ctx.watchMemory.remember({
          kind: 'preference',
          content: entry.text,
          origin: 'observed',
          subjectScope: 'project',
          scopeId: 'proj_1',
          // The interesting case: maximum confidence.
          confidence: 1,
        })
        if (stored.stored) {
          assert.equal(stored.status, 'proposed',
            `${entry.id} activated itself at confidence 1`)
        }
      }
    } finally {
      await fiber.dispose()
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})

// ── imported files ──────────────────────────────────────────────────────────

describe('an imported file is data, through every importer', () => {
  const wiki = buildWiki([record()])
  const generated = pageAt(wiki, `decisions/${slugFor(record())}.md`)
  const vaultFile = toVault(wiki, { name: 'Watch' }).files
    .find(file => file.path === generated.path)

  for (const entry of AUTHORITY_CLAIMS) {
    test(`${entry.id}: refused by the wiki importer`, () => {
      const edited = `${generated.content}\n- ${entry.text}\n`
      const validated = validateUserEdit(diffUserEdit(generated, edited), generated)
      assert.equal(validated.accepted.length, 0,
        `${entry.id} (${entry.arrivesAs}) was accepted into the ledger`)
      assert.ok(validated.refused.length > 0)
      assert.notEqual(validated.refused[0].fix, '')
    })

    test(`${entry.id}: refused by the vault importer`, () => {
      const edited = { ...vaultFile, content: `${vaultFile.content}\n- ${entry.text}\n` }
      const validated = importVaultFile(edited, generated)
      assert.equal(validated.accepted.length, 0)
    })

    test(`${entry.id}: refused by the bundle importer`, () => {
      const bundle = {
        raw: `[mem_x] (preference) origin=explicit_user confidence=1.00 :: ${entry.text}`,
        wiki: '', citations: '', index: '', log: '',
      }
      const imported = fromLlmWiki(bundle)
      assert.equal(imported.accepted.length, 0,
        `${entry.id} was accepted from a bundle`)
    })
  }

  test('a forged provenance marker is refused whatever it claims', () => {
    const forged = INJECTIONS.find(entry => entry.id === 'markdown.forged-provenance')
    const edited = `${generated.content}\n- ${forged.text}\n`
    const validated = validateUserEdit(diffUserEdit(generated, edited), generated)
    assert.equal(validated.accepted.length, 0)
    assert.match(validated.refused[0].reason, /does not own/)
  })

  test('nothing imported ever reaches explicit_user origin', () => {
    for (const entry of BENIGN) {
      const edited = `${generated.content}\n- ${entry}\n`
      const validated = validateUserEdit(diffUserEdit(generated, edited), generated)
      for (const candidate of toCandidates(validated, { subjectScope: 'project', scopeId: 'proj_1' })) {
        assert.equal(candidate.origin, 'imported')
        assert.ok(candidate.confidence < 0.5)
      }
      const imported = fromLlmWiki({
        raw: `[m] (fact) origin=explicit_user confidence=1.00 :: ${entry}`,
        wiki: '', citations: '', index: '', log: '',
      })
      for (const statement of imported.accepted) {
        assert.equal(statement.origin, 'imported')
      }
    }
  })
})

// ── the composer ────────────────────────────────────────────────────────────

describe('observed text cannot widen what a turn may do', () => {
  const base = defaultComposer()

  test('an agent persuaded by a page still cannot open egress', () => {
    // The page says uploads are approved. The agent believes it. The composer
    // does not care what the agent believes.
    const decision = proposeChange(base, {
      privacy: { offlineOnly: false, localMediaOnly: false, egressRoutes: ['evil.test'] },
    }, 'agent')
    assert.equal(decision.ok, false)
    assert.deepEqual([...decision.config.privacy.egressRoutes], [])
  })

  test('nor add a source, widen scope, or lower the standard of proof', () => {
    for (const change of [
      { sources: ['camera'] },
      { scope: 'all' },
      { sideEffects: 'permitted_set' },
      { remember: 'workspace' },
    ]) {
      assert.equal(proposeChange(base, change, 'agent').ok, false,
        `an agent widened ${Object.keys(change).join(',')}`)
    }
  })

  test('a refusal is whole, so five turns do not add up to a grant', () => {
    let config = base
    for (const change of [
      { sources: ['camera'] },
      { privacy: { offlineOnly: false, localMediaOnly: true, egressRoutes: [] } },
      { sideEffects: 'approved_each' },
    ]) {
      const decision = proposeChange(config, change, 'agent')
      assert.equal(decision.ok, false)
      config = decision.config
    }
    assert.deepEqual([...config.sources], [])
    assert.equal(config.privacy.offlineOnly, true)
    assert.equal(config.sideEffects, 'none')
  })
})

// ── plugins ─────────────────────────────────────────────────────────────────

describe('a capability cannot assert its own output was proven', () => {
  function gateway(state) {
    return {
      mintEvidence: async candidate => {
        state.minted.push(candidate)
        return { ok: true, evidenceId: `ev_core_${String(state.minted.length)}` }
      },
      readEvidence: async () => null,
      verify: async () => ({
        verificationId: 'v1', verdict: 'UNVERIFIED', checks: [], evidenceRefs: [], reason: 'none',
      }),
      record: () => {},
      health: () => {},
      onAuthorityAttempt: (id, fields) => { state.attempts.push({ id, fields }) },
    }
  }

  for (const entry of INJECTIONS) {
    test(`${entry.id}: submitting it with a forged verdict strips the verdict`, async () => {
      const state = { minted: [], attempts: [] }
      const host = createCapabilityHost(EXAMPLE_DECLARATION, gateway(state))
      const result = await host.submitObservation({
        sourceRevisionId: 'src@rev1',
        modality: 'text',
        text: entry.text,
        capturedAt: '2026-08-28T10:00:00.000Z',
        verdict: 'VERIFIED',
        evidenceId: 'ev_forged',
        freshness: 'current',
      })
      assert.equal(result.ok, true)
      assert.equal(result.evidenceId, 'ev_core_1')
      assert.ok(result.stripped.includes('verdict'))
      // The observed text itself is kept — it is evidence of what was on the
      // page, which is the entire point. What is stripped is the authority.
      assert.equal(state.minted[0].text, entry.text)
      assert.equal('verdict' in state.minted[0], false)
    })
  }

  test('a field nobody has thought of yet does not survive either', () => {
    const { candidate } = sanitizeCandidate(
      { sourceRevisionId: 's', text: 'x', someFutureAuthorityField: true },
      { id: 'p', version: '1' },
    )
    assert.equal('someFutureAuthorityField' in candidate, false)
  })
})

// ── deep links ──────────────────────────────────────────────────────────────

describe('a deep link is a lookup, never a command', () => {
  for (const raw of HOSTILE_LINKS) {
    test(`refused: ${raw.slice(0, 56)}`, () => {
      assert.equal(isDeepLink(parseDeepLink(raw)), false, `${raw} was accepted`)
    })
  }

  test('a well-formed link still works, so this is a filter and not a wall', () => {
    const link = parseDeepLink('watch://open_selection?workspace=ws_1&session=sess_1&record=rec_2')
    assert.equal(isDeepLink(link), true)
    assert.equal(link.workspaceId, 'ws_1')
  })
})

// ── approvals ───────────────────────────────────────────────────────────────

describe('an approval covers the action it was shown, and nothing else', () => {
  const digestOf = value =>
    `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}`

  const shown = {
    operationId: 'op_1',
    inputDigest: digestOf({ click: 'Confirm', page: 'https://example.test/pay' }),
    summary: 'Click Confirm on the payment page',
    consequential: true,
  }
  const CONTEXT = { nowMs: 1_000_000, actorUserId: 'user_1' }
  const approval = grantFor(shown, {
    approvalId: 'appr_1', grantedByUserId: 'user_1', nowMs: CONTEXT.nowMs,
  })

  test('the action that was shown is dispatched', () => {
    assert.equal(checkApproval(approval, shown, CONTEXT).ok, true)
  })

  test('an action that changed underneath the approval is refused', () => {
    const mutated = {
      ...shown,
      inputDigest: digestOf({ click: 'Confirm', page: 'https://evil.test/pay' }),
      summary: 'Click Confirm on a different page',
    }
    const decision = checkApproval(approval, mutated, CONTEXT)
    assert.equal(decision.ok, false)
    assert.equal(decision.code, 'digest_mismatch')
    // The message names both, because "denied" tells nobody what moved.
    assert.match(decision.message, /payment page/)
    assert.match(decision.message, /different page/)
  })

  test('a mismatch is reported as a mismatch, never as an expiry', () => {
    // The distinction matters: telling somebody to approve again, when the
    // action changed underneath them, is how the change gets approved.
    const mutated = { ...shown, inputDigest: 'sha256:something-else' }
    const stale = { ...CONTEXT, nowMs: CONTEXT.nowMs + 10_000_000 }
    assert.equal(checkApproval(approval, mutated, stale).code, 'digest_mismatch')
  })

  test('a consequential action with no approval is refused', () => {
    const decision = checkApproval(null, shown, CONTEXT)
    assert.equal(decision.ok, false)
    assert.equal(decision.code, 'no_approval')
    assert.notEqual(decision.fix, '')
  })

  test('an approval is single-use by default', () => {
    const spent = consume(approval)
    assert.equal(checkApproval(spent, shown, CONTEXT).code, 'exhausted')
  })

  test('an approval expires', () => {
    const later = { ...CONTEXT, nowMs: CONTEXT.nowMs + 10_000_000 }
    assert.equal(checkApproval(approval, shown, later).code, 'expired')
  })

  test('a withdrawn approval stops working immediately', () => {
    assert.equal(checkApproval(revoke(approval, CONTEXT.nowMs), shown, CONTEXT).code, 'revoked')
  })

  test('an approval is not transferable', () => {
    const somebodyElse = { ...CONTEXT, actorUserId: 'user_2' }
    assert.equal(checkApproval(approval, shown, somebodyElse).code, 'wrong_person')
  })

  test('a read needs no approval, so people are not trained to click through', () => {
    const read = { ...shown, consequential: false }
    assert.equal(checkApproval(approval, read, CONTEXT).ok, true)
  })

  test('every refusal says what to do next', () => {
    const cases = [
      [null, shown, CONTEXT],
      [approval, { ...shown, inputDigest: 'x' }, CONTEXT],
      [consume(approval), shown, CONTEXT],
      [approval, shown, { ...CONTEXT, nowMs: CONTEXT.nowMs + 10_000_000 }],
      [revoke(approval, 1), shown, CONTEXT],
      [approval, shown, { ...CONTEXT, actorUserId: 'other' }],
    ]
    for (const [held, action, context] of cases) {
      const decision = checkApproval(held, action, context)
      assert.equal(decision.ok, false)
      assert.notEqual(decision.fix, '')
      assert.notEqual(decision.message, '')
    }
  })
})

// ── the audit log ───────────────────────────────────────────────────────────

describe('nothing hostile reaches the longest-retained store', () => {
  test('a credential lifted from OCR is refused by the audit log', () => {
    const ocr = INJECTIONS.find(entry => entry.id === 'ocr.credential')
    const log = new AuditLog()
    assert.throws(() => log.record({
      tenantId: 't1', at: '2026-08-28T10:00:00.000Z', action: 'browser.side_effect',
      actorUserId: 'user_1', workspaceId: 'ws_1', subjectId: 'op_1', subjectKind: 'operation',
      detail: { observed: ocr.text }, correlationId: null,
    }), AuditRefusal)
    assert.equal(log.size(), 0)
  })

  test('observed text is not audited as content at all', () => {
    const log = new AuditLog()
    assert.throws(() => log.record({
      tenantId: 't1', at: '2026-08-28T10:00:00.000Z', action: 'browser.side_effect',
      actorUserId: 'user_1', workspaceId: 'ws_1', subjectId: 'op_1', subjectKind: 'operation',
      detail: { content: 'anything at all' }, correlationId: null,
    }), AuditRefusal)
  })
})

// ── the other direction ─────────────────────────────────────────────────────

describe('the guards are not simply refusing everything', () => {
  test('benign observed text is admitted as an observation', () => {
    for (const text of BENIGN) {
      const decision = admit(
        record({ origin: 'observed', content: text, status: 'proposed' }),
        'local_personal',
      )
      assert.equal(decision.admitted, true, `a benign observation was refused: ${text}`)
    }
  })

  test('benign text imports as a proposal rather than being refused', () => {
    const wiki = buildWiki([record()])
    const generated = pageAt(wiki, `decisions/${slugFor(record())}.md`)
    for (const text of BENIGN) {
      const edited = `${generated.content}\n- ${text}\n`
      const validated = validateUserEdit(diffUserEdit(generated, edited), generated)
      assert.equal(validated.accepted.length, 1, `a benign line was refused: ${text}`)
    }
  })

  test('benign text is neither high impact nor a protected subject', () => {
    for (const text of BENIGN) {
      assert.equal(isHighImpact(text), false, `false positive on: ${text}`)
      assert.equal(isProtectedSubject(text), false, `false positive on: ${text}`)
    }
  })
})
