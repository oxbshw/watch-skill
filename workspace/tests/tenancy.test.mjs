/**
 * Two tenants, and every way one could reach the other.
 *
 * The governing rule for this file is blunt: **a single cross-tenant leak means
 * Team is not supported.** So the isolation suite is written adversarially —
 * tenant B's principal tries each thing in turn, with correct ids, guessed ids,
 * and ids that are real but not theirs — rather than as a set of happy paths
 * with an "and it denies" at the end.
 *
 * The other half of the file is the rules that only look like configuration
 * until somebody exercises them: that an admin of a workspace is not an
 * administrator of the people in it, that a member cannot grant admin, that a
 * consequential job whose worker vanished is never silently retried, and that
 * an audit log refuses a credential rather than redacting one.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIT_ACTIONS,
  AuditLog,
  AuditRefusal,
  Coordinator,
  PERMISSIONS,
  REQUIRED_ROLE,
  ROLES,
  accessDenied,
  atLeast,
  authorize,
  credentialUse,
  describeShare,
  filterAuthorized,
  isOtherPersonsPersonal,
  jobOwner,
  leaksRedactedText,
  looksLikeSecret,
  mayGrant,
  mayResolveNote,
  mayShare,
  memoryMutation,
  membershipFor,
  redactedView,
  sameTenant,
  sharedOwner,
  strongestRole,
  workerCanRun,
} from '@deepwatch/dsh-tenancy'

// ── the two tenants ─────────────────────────────────────────────────────────

const NOW = '2026-08-27T12:00:00.000Z'

const TENANT_A = { tenantId: 'tenant_a', displayName: 'Acme', deletedAt: null }
const TENANT_B = { tenantId: 'tenant_b', displayName: 'Beta', deletedAt: null }

const WORKSPACE_A = { workspaceId: 'ws_a', tenantId: 'tenant_a', displayName: 'Acme work', deletedAt: null }
const WORKSPACE_B = { workspaceId: 'ws_b', tenantId: 'tenant_b', displayName: 'Beta work', deletedAt: null }

const USER_A = { userId: 'user_a', tenantId: 'tenant_a', displayName: 'Ana', revokedAt: null }
const USER_A2 = { userId: 'user_a2', tenantId: 'tenant_a', displayName: 'Amir', revokedAt: null }
const USER_B = { userId: 'user_b', tenantId: 'tenant_b', displayName: 'Bea', revokedAt: null }

const DIRECTORY = {
  tenants: new Map([['tenant_a', TENANT_A], ['tenant_b', TENANT_B]]),
  users: new Map([['user_a', USER_A], ['user_a2', USER_A2], ['user_b', USER_B]]),
  workspaces: new Map([['ws_a', WORKSPACE_A], ['ws_b', WORKSPACE_B]]),
}

function membership(userId, tenantId, workspaceId, role) {
  return { userId, tenantId, workspaceId, role, grantedAt: NOW, revokedAt: null }
}

/** Ana: an admin in tenant A. */
const ANA = {
  userId: 'user_a',
  tenantId: 'tenant_a',
  memberships: [membership('user_a', 'tenant_a', 'ws_a', 'admin')],
}

/** Amir: an ordinary member in the same workspace as Ana. */
const AMIR = {
  userId: 'user_a2',
  tenantId: 'tenant_a',
  memberships: [membership('user_a2', 'tenant_a', 'ws_a', 'member')],
}

/** Bea: an owner in tenant B, and the adversary throughout. */
const BEA = {
  userId: 'user_b',
  tenantId: 'tenant_b',
  memberships: [membership('user_b', 'tenant_b', 'ws_b', 'owner')],
}

/** A resource in tenant A's workspace. */
function ownedByA(kind, resourceId, userId = null) {
  return { kind, resourceId, tenantId: 'tenant_a', workspaceId: 'ws_a', userId }
}

/** A tenant-level resource in tenant A. */
function tenantResourceA(kind, resourceId) {
  return { kind, resourceId, tenantId: 'tenant_a', workspaceId: null, userId: null }
}

function ask(principal, permission, owner) {
  return authorize({ principal, permission, owner, directory: DIRECTORY })
}

// ── the isolation suite ─────────────────────────────────────────────────────

describe('tenant B cannot reach tenant A, by any route', () => {
  test('a workspace in another tenant does not exist', () => {
    const decision = ask(BEA, 'workspace.read', ownedByA('workspace', 'ws_a'))
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'cross_tenant')
  })

  test('the denial is not an existence oracle', () => {
    const real = ask(BEA, 'evidence.read', ownedByA('evidence', 'ev_that_exists'))
    const invented = ask(BEA, 'evidence.read', ownedByA('evidence', 'ev_never_created'))
    assert.equal(real.allowed, false)
    assert.equal(invented.allowed, false)
    assert.equal(real.denial.reason, invented.denial.reason,
      'the denial distinguishes a real resource from an imaginary one')
  })

  test('memory in another tenant is unreachable', () => {
    const decision = ask(BEA, 'memory.read', ownedByA('memory', 'mem_a1', 'user_a'))
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'cross_tenant')
  })

  test('an artifact in another tenant cannot be resolved', () => {
    for (const permission of ['artifact.read', 'evidence.read', 'source.read']) {
      const decision = ask(BEA, permission, ownedByA('artifact', 'art_a1'))
      assert.equal(decision.allowed, false, `${permission} was allowed across tenants`)
    }
  })

  test('a credential in another tenant cannot be used', () => {
    const decision = ask(BEA, 'credential.use', tenantResourceA('credential', 'conn_a1'))
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'cross_tenant')
  })

  test('a worker job in another tenant cannot be observed', () => {
    const job = {
      jobId: 'job_a1', tenantId: 'tenant_a', workspaceId: 'ws_a',
      submittedByUserId: 'user_a', kind: 'ocr', requires: [], requiresGpu: false,
      consequential: false, idempotencyKey: 'k1', deadlineAtMs: 1, state: 'queued',
      leasedByWorkerId: null, leaseExpiresAtMs: null, attempts: 0, receiptId: null, detail: '',
    }
    const decision = ask(BEA, 'worker.submit', jobOwner(job))
    assert.equal(decision.allowed, false)
  })

  test('a forged membership for another tenant grants nothing', () => {
    // Bea hands herself a membership row naming tenant A's workspace. The
    // membership lookup is tenant-scoped, so it resolves to nothing.
    const forged = {
      userId: 'user_b',
      tenantId: 'tenant_b',
      memberships: [
        membership('user_b', 'tenant_b', 'ws_b', 'owner'),
        membership('user_b', 'tenant_a', 'ws_a', 'owner'),
      ],
    }
    assert.equal(ask(forged, 'workspace.read', ownedByA('workspace', 'ws_a')).allowed, false)
    assert.equal(membershipFor(forged, 'ws_a'), null,
      'a membership naming another tenant resolved')
  })

  test('a principal claiming another tenant on the request is still denied', () => {
    // The principal's own tenantId is the one that counts, and a resource must
    // match it. Claiming tenant A while holding tenant B's memberships gives
    // no membership in tenant A.
    const spoofed = { ...BEA, tenantId: 'tenant_a' }
    assert.equal(ask(spoofed, 'workspace.read', ownedByA('workspace', 'ws_a')).allowed, false)
  })

  test('a list is filtered by the same check a single read uses', () => {
    const items = [
      { id: 'a', owner: ownedByA('evidence', 'ev_a1') },
      { id: 'b', owner: sharedOwner('evidence', 'ev_b1', { tenantId: 'tenant_b', workspaceId: 'ws_b' }) },
    ]
    const visible = filterAuthorized(items, item => item.owner, {
      principal: BEA, permission: 'evidence.read', directory: DIRECTORY,
    })
    assert.deepEqual(visible.map(item => item.id), ['b'])
  })

  test('an unowned resource is unreachable rather than public', () => {
    const orphan = { kind: 'evidence', resourceId: 'ev_orphan', tenantId: '', workspaceId: null, userId: null }
    assert.equal(sameTenant(ANA, orphan).allowed, false)
    assert.equal(sameTenant(ANA, orphan).denial.code, 'unowned')
  })

  test('a resource whose workspace belongs to another tenant is refused', () => {
    // Corrupt ownership: the row claims tenant A but names tenant B's
    // workspace. The safe reading is that nobody may have it.
    const corrupt = { kind: 'evidence', resourceId: 'ev_x', tenantId: 'tenant_a', workspaceId: 'ws_b', userId: null }
    const decision = ask(ANA, 'evidence.read', corrupt)
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'cross_tenant')
  })

  test('authorized sharing does work, so the isolation is not simply "nothing works"', () => {
    const shared = sharedOwner('evidence', 'ev_b1', { tenantId: 'tenant_b', workspaceId: 'ws_b' })
    assert.equal(ask(BEA, 'evidence.read', shared).allowed, true)
    assert.equal(ask(ANA, 'evidence.read', ownedByA('evidence', 'ev_a1')).allowed, true)
  })

  test('deleting a tenant takes effect on the next request', () => {
    const directory = {
      ...DIRECTORY,
      tenants: new Map([...DIRECTORY.tenants, ['tenant_a', { ...TENANT_A, deletedAt: NOW }]]),
    }
    const decision = authorize({
      principal: ANA,
      permission: 'workspace.read',
      owner: ownedByA('workspace', 'ws_a'),
      directory,
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'deleted')
  })

  test('revoking a user takes effect on the next request, not at next sign-in', () => {
    const directory = {
      ...DIRECTORY,
      users: new Map([...DIRECTORY.users, ['user_a', { ...USER_A, revokedAt: NOW }]]),
    }
    const decision = authorize({
      principal: ANA,
      permission: 'workspace.read',
      owner: ownedByA('workspace', 'ws_a'),
      directory,
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'revoked')
  })

  test('revoking a membership removes access while the account remains', () => {
    const revoked = {
      ...ANA,
      memberships: [{ ...membership('user_a', 'tenant_a', 'ws_a', 'admin'), revokedAt: NOW }],
    }
    assert.equal(ask(revoked, 'workspace.read', ownedByA('workspace', 'ws_a')).allowed, false)
    assert.equal(membershipFor(revoked, 'ws_a'), null)
  })
})

// ── personal taste ──────────────────────────────────────────────────────────

describe('an admin of a workspace is not an administrator of a person', () => {
  test('an admin cannot read another member’s personal memory', () => {
    const amirsTaste = ownedByA('memory', 'mem_amir_1', 'user_a2')
    const decision = ask(ANA, 'memory.read', amirsTaste)
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'not_owner')
  })

  test('nor write it, nor export it', () => {
    const amirsTaste = ownedByA('memory', 'mem_amir_1', 'user_a2')
    for (const permission of ['memory.write', 'export.perform']) {
      assert.equal(ask(ANA, permission, amirsTaste).allowed, false, `${permission} reached it`)
    }
  })

  test('a person reaches their own', () => {
    const amirsTaste = ownedByA('memory', 'mem_amir_1', 'user_a2')
    assert.equal(ask(AMIR, 'memory.read', amirsTaste).allowed, true)
    assert.equal(ask(AMIR, 'memory.write', amirsTaste).allowed, true)
  })

  test('the personal rule sits above the role check, so no new role reaches it', () => {
    const amirsTaste = ownedByA('memory', 'mem_amir_1', 'user_a2')
    const owner = { ...ANA, memberships: [membership('user_a', 'tenant_a', 'ws_a', 'owner')] }
    assert.equal(ask(owner, 'memory.read', amirsTaste).allowed, false)
    assert.equal(isOtherPersonsPersonal(owner, amirsTaste), true)
  })

  test('shared workspace memory is reachable by role, because it has no owner', () => {
    const workspaceMemory = ownedByA('memory', 'mem_shared_1', null)
    assert.equal(ask(ANA, 'memory.read', workspaceMemory).allowed, true)
    assert.equal(ask(AMIR, 'memory.read', workspaceMemory).allowed, true)
  })

  test('mutating shared memory needs admin, and a member is refused', () => {
    const workspaceMemory = ownedByA('memory', 'mem_shared_1', null)
    assert.equal(ask(ANA, 'memory.shared.mutate', workspaceMemory).allowed, true)
    const decision = ask(AMIR, 'memory.shared.mutate', workspaceMemory)
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'role_insufficient')
  })
})

// ── roles ───────────────────────────────────────────────────────────────────

describe('roles and what they reach', () => {
  test('every permission the vision names has a required role', () => {
    for (const permission of PERMISSIONS) {
      assert.notEqual(REQUIRED_ROLE[permission], undefined, `${permission} has no required role`)
      assert.ok(ROLES.includes(REQUIRED_ROLE[permission]))
    }
    for (const expected of [
      'workspace.manage', 'source.read', 'source.write', 'evidence.read', 'artifact.read',
      'memory.read', 'memory.shared.mutate', 'browser.operate', 'credential.use',
      'plugin.manage', 'export.perform', 'verification.policy.administer',
    ]) {
      assert.ok(PERMISSIONS.includes(expected), `the catalogue is missing ${expected}`)
    }
  })

  test('a viewer reads and does nothing else', () => {
    const viewer = {
      userId: 'user_a2', tenantId: 'tenant_a',
      memberships: [membership('user_a2', 'tenant_a', 'ws_a', 'viewer')],
    }
    assert.equal(ask(viewer, 'evidence.read', ownedByA('evidence', 'ev_a1')).allowed, true)
    for (const permission of ['source.write', 'browser.operate', 'export.perform', 'plugin.manage']) {
      assert.equal(ask(viewer, permission, ownedByA('source', 'src_a1')).allowed, false,
        `a viewer reached ${permission}`)
    }
  })

  test('changing what counts as proof needs admin', () => {
    const owner = ownedByA('workspace', 'ws_a')
    assert.equal(ask(AMIR, 'verification.policy.administer', owner).allowed, false)
    assert.equal(ask(ANA, 'verification.policy.administer', owner).allowed, true)
  })

  test('a member cannot grant admin', () => {
    assert.equal(mayGrant('member', 'member'), false)
    assert.equal(mayGrant('admin', 'admin'), true)
    assert.equal(mayGrant('admin', 'owner'), false)
    assert.equal(mayGrant('owner', 'admin'), true)
  })

  test('role strength is a total order', () => {
    assert.equal(atLeast('owner', 'viewer'), true)
    assert.equal(atLeast('viewer', 'owner'), false)
    assert.equal(atLeast('member', 'member'), true)
    assert.equal(strongestRole(ANA), 'admin')
    assert.equal(strongestRole({ ...ANA, memberships: [] }), null)
  })

  test('a tenant-level resource needs a membership somewhere in the tenant', () => {
    const orphan = { userId: 'user_a', tenantId: 'tenant_a', memberships: [] }
    const decision = ask(orphan, 'credential.use', tenantResourceA('credential', 'conn_a1'))
    assert.equal(decision.allowed, false)
    assert.equal(decision.denial.code, 'no_membership')
    assert.equal(ask(AMIR, 'credential.use', tenantResourceA('credential', 'conn_a1')).allowed, true)
  })
})

// ── sharing ─────────────────────────────────────────────────────────────────

describe('what a share hands over', () => {
  test('memory is never shared by sharing a workspace', () => {
    const decision = mayShare(ownedByA('memory', 'mem_a1', null))
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /Move its scope deliberately/)
  })

  test('a credential is never shared', () => {
    assert.equal(mayShare(tenantResourceA('credential', 'conn_a1')).ok, false)
  })

  test('a personal resource of any kind is not shareable', () => {
    assert.equal(mayShare(ownedByA('source', 'src_a1', 'user_a')).ok, false)
  })

  test('sources, evidence and comments are shareable', () => {
    for (const kind of ['source', 'evidence', 'artifact', 'collection', 'comment', 'session']) {
      assert.equal(mayShare(ownedByA(kind, `${kind}_1`)).ok, true, `${kind} was refused`)
    }
  })

  test('a shared resource has no personal owner, or nobody else could read it', () => {
    const shared = sharedOwner('evidence', 'ev_1', { tenantId: 'tenant_a', workspaceId: 'ws_a' })
    assert.equal(shared.userId, null)
    assert.equal(ask(AMIR, 'evidence.read', shared).allowed, true)
  })

  test('the share summary says what goes, including that memory does not', () => {
    const line = describeShare({ sources: 3, evidence: 12, redactions: 2, comments: 4 })
    assert.match(line, /3 source\(s\)/)
    assert.match(line, /2 redaction\(s\) applied/)
    assert.match(line, /no personal memory/)
  })
})

describe('redaction travels with the evidence', () => {
  const REDACTIONS = [{
    redactionId: 'red_1',
    evidenceId: 'ev_1',
    region: { x: 10, y: 20, width: 100, height: 30 },
    range: null,
    textPatterns: ['sk_test_EXAMPLE_NOT_A', 'customer@example.test'],
    reason: 'a token and a customer address were on screen',
    createdByUserId: 'user_a',
  }]

  const EVIDENCE = {
    evidenceId: 'ev_1',
    text: 'Authorization: sk_test_EXAMPLE_NOT_A — invoice sent to customer@example.test — deploy succeeded',
  }

  test('the redacted text does not contain what was redacted', () => {
    const view = redactedView(EVIDENCE, REDACTIONS)
    assert.equal(view.text.includes('sk_test_EXAMPLE_NOT_A'), false)
    assert.equal(view.text.includes('customer@example.test'), false)
    assert.equal(leaksRedactedText(view, REDACTIONS), false)
  })

  test('what remains is still readable, and says it was redacted', () => {
    const view = redactedView(EVIDENCE, REDACTIONS)
    assert.match(view.text, /deploy succeeded/)
    assert.match(view.text, /\[redacted\]/)
    assert.equal(view.redactionCount, 1)
    assert.equal(view.redactedRegions.length, 1)
  })

  test('the leak check would catch a redaction that did not apply', () => {
    // The guard on the guard: an unredacted view against the same redactions
    // must be reported as leaking, or a passing test above means nothing.
    const unredacted = { evidenceId: 'ev_1', text: EVIDENCE.text, redactedRegions: [], redactedRanges: [], redactionCount: 0 }
    assert.equal(leaksRedactedText(unredacted, REDACTIONS), true)
  })

  test('redactions for other evidence do not apply', () => {
    const other = redactedView({ evidenceId: 'ev_2', text: EVIDENCE.text }, REDACTIONS)
    assert.equal(other.redactionCount, 0)
    assert.match(other.text, /sk_test_EXAMPLE_NOT_A/)
  })

  test('a note is resolved by its author or an admin, and nobody else', () => {
    const note = {
      commentId: 'c1', tenantId: 'tenant_a', workspaceId: 'ws_a',
      authorUserId: 'user_a2', subjectId: 'ev_1', subjectKind: 'evidence',
      body: 'is this the right frame?', createdAt: NOW, resolvedAt: null,
    }
    assert.equal(mayResolveNote(note, AMIR, 'member'), true)
    assert.equal(mayResolveNote(note, ANA, 'admin'), true)
    assert.equal(mayResolveNote(note, ANA, 'member'), false)
  })
})

// ── remote workers ──────────────────────────────────────────────────────────

describe('remote workers lease work, and never guess about consequences', () => {
  function worker(overrides = {}) {
    return {
      workerId: 'worker_1',
      tenantId: 'tenant_a',
      displayName: 'GPU box',
      capabilities: [
        { capabilityId: 'ocr.deepseek', provider: 'w', providerVersion: '1', status: 'machine_tested', requirements: [], detected: {}, missing: [], fixes: [], lastCheckedAt: NOW },
      ],
      hasGpu: true,
      vramGb: 24,
      maxConcurrency: 1,
      registeredAt: NOW,
      lastHeartbeatAt: NOW,
      ...overrides,
    }
  }

  function job(overrides = {}) {
    return {
      jobId: 'job_1',
      tenantId: 'tenant_a',
      workspaceId: 'ws_a',
      submittedByUserId: 'user_a',
      kind: 'ocr',
      requires: ['ocr.deepseek'],
      requiresGpu: true,
      consequential: false,
      idempotencyKey: 'idem_1',
      deadlineAtMs: 10_000,
      state: 'queued',
      leasedByWorkerId: null,
      leaseExpiresAtMs: null,
      attempts: 0,
      receiptId: null,
      detail: '',
      ...overrides,
    }
  }

  test('a worker only ever sees its own tenant’s work', () => {
    const coordinator = new Coordinator()
    coordinator.register(worker({ tenantId: 'tenant_b' }))
    coordinator.submit(job())
    const leased = coordinator.lease('worker_1', 1_000)
    assert.equal(leased.ok, false)
    assert.match(leased.refusal.reason, /Nothing to do/)
  })

  test('a job listing is tenant-scoped', () => {
    const coordinator = new Coordinator()
    coordinator.submit(job())
    coordinator.submit(job({ jobId: 'job_b', tenantId: 'tenant_b', idempotencyKey: 'idem_b' }))
    assert.deepEqual(coordinator.jobsFor('tenant_b').map(entry => entry.jobId), ['job_b'])
    assert.deepEqual(coordinator.jobsFor('tenant_a').map(entry => entry.jobId), ['job_1'])
  })

  test('an unproven capability does not attract a GPU job', () => {
    const unproven = worker({
      capabilities: [{ capabilityId: 'ocr.deepseek', provider: 'w', providerVersion: '1', status: 'implemented', requirements: [], detected: {}, missing: [], fixes: [], lastCheckedAt: NOW }],
    })
    assert.equal(workerCanRun(unproven, job()), false)
    assert.equal(workerCanRun(worker(), job()), true)
    assert.equal(workerCanRun(worker({ hasGpu: false }), job()), false)
  })

  test('an idempotency key is namespaced by tenant', () => {
    const coordinator = new Coordinator()
    const first = coordinator.submit(job())
    const second = coordinator.submit(job({ jobId: 'job_dup' }))
    assert.equal(second.jobId, first.jobId, 'a repeated key created a second job')

    const otherTenant = coordinator.submit(job({ jobId: 'job_b', tenantId: 'tenant_b' }))
    assert.equal(otherTenant.jobId, 'job_b',
      'the same key in another tenant returned this tenant’s job')
  })

  test('a lease expires and a read-only job goes back on the queue', () => {
    const coordinator = new Coordinator({ leaseDurationMs: 100, heartbeatTimeoutMs: 500, maxAttempts: 3 })
    coordinator.register(worker())
    coordinator.submit(job())
    assert.equal(coordinator.lease('worker_1', 0).ok, true)
    coordinator.reclaimExpired(500)
    assert.equal(coordinator.job('job_1').state, 'queued')
    assert.equal(coordinator.job('job_1').attempts, 1)
  })

  test('a read-only job gives up after its attempt budget', () => {
    const coordinator = new Coordinator({ leaseDurationMs: 10, heartbeatTimeoutMs: 500, maxAttempts: 2 })
    coordinator.register(worker())
    coordinator.submit(job({ deadlineAtMs: 1_000_000 }))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      coordinator.lease('worker_1', attempt * 100)
      coordinator.reclaimExpired(attempt * 100 + 50)
    }
    assert.equal(coordinator.job('job_1').state, 'failed')
    assert.match(coordinator.job('job_1').detail, /Gave up after/)
  })

  test('a consequential job whose worker vanished is never silently retried', () => {
    const coordinator = new Coordinator({ leaseDurationMs: 100, heartbeatTimeoutMs: 500, maxAttempts: 3 })
    coordinator.register(worker())
    coordinator.submit(job({ consequential: true, deadlineAtMs: 1_000_000 }))
    coordinator.lease('worker_1', 0)
    coordinator.reclaimExpired(500)

    const settled = coordinator.job('job_1')
    assert.equal(settled.state, 'needs_resolution',
      'a consequential job was requeued after its worker vanished')
    assert.match(settled.detail, /idem_1/)
    assert.match(settled.detail, /may have/)
  })

  test('a job needing resolution is not handed to another worker', () => {
    const coordinator = new Coordinator({ leaseDurationMs: 100, heartbeatTimeoutMs: 500, maxAttempts: 3 })
    coordinator.register(worker())
    coordinator.submit(job({ consequential: true, deadlineAtMs: 1_000_000 }))
    coordinator.lease('worker_1', 0)
    coordinator.reclaimExpired(500)
    assert.equal(coordinator.lease('worker_1', 600).ok, false)
  })

  test('resolving says what actually happened', () => {
    const coordinator = new Coordinator({ leaseDurationMs: 100, heartbeatTimeoutMs: 500, maxAttempts: 3 })
    coordinator.register(worker())
    coordinator.submit(job({ consequential: true, deadlineAtMs: 1_000_000 }))
    coordinator.lease('worker_1', 0)
    coordinator.reclaimExpired(500)
    assert.equal(coordinator.resolve('job_1', 'succeeded', 'receipt rcpt_9 confirms it ran once'), true)
    assert.equal(coordinator.job('job_1').state, 'succeeded')
  })

  test('only the leaseholder may report a result', () => {
    const coordinator = new Coordinator()
    coordinator.register(worker())
    coordinator.register(worker({ workerId: 'worker_2' }))
    coordinator.submit(job())
    coordinator.lease('worker_1', 0)
    assert.equal(coordinator.complete({ jobId: 'job_1', workerId: 'worker_2', ok: true, detail: 'done' }), false)
    assert.equal(coordinator.complete({ jobId: 'job_1', workerId: 'worker_1', ok: true, detail: 'done', receiptId: 'rcpt_1' }), true)
    assert.equal(coordinator.job('job_1').receiptId, 'rcpt_1')
  })

  test('a job past its deadline is failed rather than handed out', () => {
    const coordinator = new Coordinator()
    coordinator.register(worker())
    coordinator.submit(job({ deadlineAtMs: 100 }))
    assert.equal(coordinator.lease('worker_1', 500).ok, false)
    assert.equal(coordinator.job('job_1').state, 'failed')
  })

  test('concurrency is respected', () => {
    const coordinator = new Coordinator()
    coordinator.register(worker({ maxConcurrency: 1 }))
    coordinator.submit(job({ deadlineAtMs: 1_000_000 }))
    coordinator.submit(job({ jobId: 'job_2', idempotencyKey: 'idem_2', deadlineAtMs: 1_000_000 }))
    assert.equal(coordinator.lease('worker_1', 0).ok, true)
    assert.equal(coordinator.lease('worker_1', 0).ok, false)
  })

  test('a silent worker is reported as stale', () => {
    const coordinator = new Coordinator({ leaseDurationMs: 100, heartbeatTimeoutMs: 1_000, maxAttempts: 3 })
    coordinator.register(worker())
    const later = Date.parse(NOW) + 5_000
    assert.equal(coordinator.staleWorkers(later).length, 1)
    coordinator.heartbeat('worker_1', later)
    assert.equal(coordinator.staleWorkers(later).length, 0)
  })
})

// ── audit ───────────────────────────────────────────────────────────────────

describe('the audit log refuses what it must not keep', () => {
  test('every action the vision names is audited', () => {
    for (const expected of [
      'auth.login', 'permission.granted', 'credential.used', 'egress.sensitive',
      'browser.side_effect', 'memory.mutated', 'plugin.installed',
      'export.performed', 'verification.policy_changed',
    ]) {
      assert.ok(AUDIT_ACTIONS.includes(expected), `${expected} is not audited`)
    }
  })

  test('a credential use is audited without the credential', () => {
    const log = new AuditLog()
    const entry = log.record(credentialUse({
      tenantId: 'tenant_a', workspaceId: 'ws_a', actorUserId: 'user_a',
      connectionId: 'conn_a1', purpose: 'browser login', at: NOW, correlationId: 'corr_1',
    }))
    assert.equal(entry.subjectId, 'conn_a1')
    assert.equal(/sk_|password|token/i.test(JSON.stringify(entry)), false)
  })

  test('an entry carrying a token is refused, not redacted', () => {
    const log = new AuditLog()
    assert.throws(
      () => log.record({
        tenantId: 'tenant_a', at: NOW, action: 'credential.used', actorUserId: 'user_a',
        workspaceId: 'ws_a', subjectId: 'conn_a1', subjectKind: 'connection',
        detail: { value: 'sk_test_EXAMPLE_NOT_A_REAL_KEY_0000' },
        correlationId: null,
      }),
      AuditRefusal,
    )
    assert.equal(log.size(), 0, 'a refused entry was still written')
  })

  test('a field named for content is refused whatever it holds', () => {
    const log = new AuditLog()
    for (const key of ['content', 'text', 'password', 'token']) {
      assert.throws(
        () => log.record({
          tenantId: 'tenant_a', at: NOW, action: 'memory.mutated', actorUserId: 'user_a',
          workspaceId: 'ws_a', subjectId: 'mem_1', subjectKind: 'memory',
          detail: { [key]: 'anything at all' }, correlationId: null,
        }),
        AuditRefusal,
        `a detail field named ${key} was accepted`,
      )
    }
  })

  test('a memory mutation is audited as an id, so forgetting stays forgotten', () => {
    const log = new AuditLog()
    const entry = log.record(memoryMutation({
      tenantId: 'tenant_a', workspaceId: 'ws_a', actorUserId: 'user_a',
      memoryId: 'mem_1', kind: 'preference', operation: 'forgotten', at: NOW,
    }))
    assert.equal(entry.subjectId, 'mem_1')
    assert.deepEqual(entry.detail, { operation: 'forgotten', kind: 'preference' })
  })

  test('the secret detector catches the shapes that matter', () => {
    for (const value of [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0',
      'Bearer abcdefghijklmnopqrstuvwxyz012345',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'password: hunter2',
      '-----BEGIN RSA PRIVATE KEY-----',
    ]) {
      assert.equal(looksLikeSecret(value), true, `missed: ${value}`)
    }
    for (const value of ['browser login', 'ocr.deepseek', 'mem_1', 'forgotten']) {
      assert.equal(looksLikeSecret(value), false, `false positive: ${value}`)
    }
  })

  test('the log is read per tenant, at the query', () => {
    const log = new AuditLog()
    log.record(accessDenied({
      tenantId: 'tenant_a', actorUserId: 'user_a', permission: 'evidence.read',
      code: 'role_insufficient', subjectId: 'ev_1', subjectKind: 'evidence', at: NOW,
    }))
    log.record(accessDenied({
      tenantId: 'tenant_b', actorUserId: 'user_b', permission: 'evidence.read',
      code: 'cross_tenant', subjectId: 'ev_a1', subjectKind: 'evidence', at: NOW,
    }))
    assert.equal(log.forTenant('tenant_a').length, 1)
    assert.equal(log.forTenant('tenant_b').length, 1)
    assert.equal(log.forTenant('tenant_a')[0].actorUserId, 'user_a')
    assert.equal(log.forSubject('tenant_a', 'ev_a1').length, 0,
      'a subject from another tenant was returned')
  })

  test('a denial is audited, because a run of them is the signal', () => {
    const log = new AuditLog()
    const decision = ask(BEA, 'evidence.read', ownedByA('evidence', 'ev_a1'))
    assert.equal(decision.allowed, false)
    const entry = log.record(accessDenied({
      tenantId: BEA.tenantId, actorUserId: BEA.userId, permission: 'evidence.read',
      code: decision.denial.code, subjectId: 'ev_a1', subjectKind: 'evidence', at: NOW,
    }))
    assert.equal(entry.detail.code, 'cross_tenant')
    // Audited under the *actor's* tenant, so tenant A's log is not a place
    // tenant B's activity shows up.
    assert.equal(entry.tenantId, 'tenant_b')
  })
})
