/**
 * The audit log, and the two things it must never contain.
 *
 * An audit log exists so somebody can reconstruct what happened after the fact.
 * That makes it the single most attractive place in the system to put "just a
 * bit more context", and the single worst place for that instinct to win —
 * because an audit log is retained longer than anything else, read by more
 * people than anything else, and exported to places nobody was thinking about
 * when the entry was written.
 *
 * So two rules are enforced here rather than reviewed:
 *
 * **No raw credential, ever.** {@link record} refuses an entry whose detail
 * looks like a secret. Not redacts — refuses, and throws, because a silently
 * redacted audit entry is one nobody notices was nearly a disclosure.
 *
 * **No memory content beyond what the event is about.** A memory mutation is
 * audited as an id, a kind and an actor. Logging the sentence that was
 * forgotten would mean the deletion did not delete it, and the place it
 * survived would be the log nobody thinks to check.
 *
 * @module @deepwatch/dsh-tenancy/audit
 */

/** What gets audited. Every entry is one of these; there is no `other`. */
export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.failed'
  | 'permission.granted'
  | 'permission.revoked'
  | 'membership.added'
  | 'membership.removed'
  | 'credential.used'
  | 'egress.sensitive'
  | 'browser.side_effect'
  | 'memory.mutated'
  | 'memory.scope_moved'
  | 'plugin.installed'
  | 'plugin.removed'
  | 'export.performed'
  | 'verification.policy_changed'
  | 'share.granted'
  | 'share.revoked'
  | 'tenant.deleted'
  | 'access.denied'

/** Every audited action, so a retention policy can enumerate them. */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'auth.login', 'auth.logout', 'auth.failed',
  'permission.granted', 'permission.revoked',
  'membership.added', 'membership.removed',
  'credential.used', 'egress.sensitive', 'browser.side_effect',
  'memory.mutated', 'memory.scope_moved',
  'plugin.installed', 'plugin.removed',
  'export.performed', 'verification.policy_changed',
  'share.granted', 'share.revoked', 'tenant.deleted',
  'access.denied',
]

/** One audit entry. */
export interface AuditEntry {
  readonly entryId: string
  readonly tenantId: string
  readonly at: string
  readonly action: AuditAction
  /** Who did it. Null for a system action. */
  readonly actorUserId: string | null
  readonly workspaceId: string | null
  /** What it was done to, as an id. */
  readonly subjectId: string | null
  readonly subjectKind: string | null
  /**
   * Detail, as scalars.
   *
   * Deliberately not free text and deliberately not nested: a flat record of
   * short scalars is checkable, and a nested blob is where a payload hides.
   */
  readonly detail: Readonly<Record<string, string | number | boolean>>
  /** Correlates with a Bridge request and a receipt. */
  readonly correlationId: string | null
}

/**
 * Patterns that mean a value is, or contains, a credential.
 *
 * Deliberately broad. A false positive costs one caller rewording a detail
 * field; a false negative writes a token into the longest-retained store in
 * the product.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Bearer tokens, JWTs, and anything shaped like one.
  /\beyJ[A-Za-z0-9_-]{10,}\./,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  // Provider key prefixes. The trailing class allows separators, because
  // `sk_live_...` is the common real shape and an alphanumeric-only tail
  // missed it entirely — found by a test that fed in a realistic key.
  /\b(sk|pk|rk|ghp|gho|ghs|ghu|xox[abprs])[-_][A-Za-z0-9_-]{16,}/,
  // Anything self-describing.
  /\b(password|passwd|secret|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token)\b\s*[:=]/i,
  // PEM blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A long unbroken high-entropy run. Crude, and the last line of defence.
  // No `\b` in front: a run preceded by an underscore has no word boundary,
  // which is exactly how a prefixed key slipped past the first version.
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/,
]

/** Whether a value looks like a secret. */
export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(value))
}

/** Why an entry was refused. */
export class AuditRefusal extends Error {
  constructor(public readonly field: string, message: string) {
    super(message)
    this.name = 'AuditRefusal'
  }
}

/**
 * Fields whose presence is a mistake regardless of content.
 *
 * `content` is here because a memory audit entry that carried the memory's
 * text would defeat forgetting; `token`, `password` and friends because there
 * is no version of those that belongs in a log.
 */
const FORBIDDEN_DETAIL_KEYS: readonly string[] = [
  'content', 'text', 'body', 'password', 'secret', 'token', 'apiKey', 'api_key',
  'privateKey', 'private_key', 'authorization', 'cookie', 'credential',
]

/** An append-only audit log, scoped per tenant on read. */
export class AuditLog {
  private readonly entries: AuditEntry[] = []
  private sequence = 1

  /**
   * Record one entry, or refuse it.
   *
   * Throws rather than redacting. A redaction here would be silent, and the
   * caller that nearly wrote a token into the audit log is exactly the caller
   * who needs to find out.
   */
  record(entry: Omit<AuditEntry, 'entryId'>): AuditEntry {
    for (const [key, value] of Object.entries(entry.detail)) {
      if (FORBIDDEN_DETAIL_KEYS.includes(key)) {
        throw new AuditRefusal(
          key,
          `An audit entry may not carry "${key}". Record an identifier instead: `
          + 'the log is retained longer and read more widely than anything it describes.',
        )
      }
      if (typeof value === 'string' && looksLikeSecret(value)) {
        throw new AuditRefusal(
          key,
          `The value of "${key}" looks like a credential. Audit the fact that a `
          + 'credential was used, and its reference, never the credential.',
        )
      }
    }

    const recorded: AuditEntry = { ...entry, entryId: `audit_${String(this.sequence)}` }
    this.sequence += 1
    this.entries.push(recorded)
    return recorded
  }

  /**
   * Read one tenant's audit trail.
   *
   * Tenant-scoped at the query rather than filtered by the caller. A log that
   * returned everything and trusted its callers to filter would leak the first
   * time somebody wrote a new report.
   */
  forTenant(tenantId: string): readonly AuditEntry[] {
    return this.entries.filter(entry => entry.tenantId === tenantId)
  }

  /** Entries about one subject, within one tenant. */
  forSubject(tenantId: string, subjectId: string): readonly AuditEntry[] {
    return this.entries.filter(
      entry => entry.tenantId === tenantId && entry.subjectId === subjectId)
  }

  /** How many entries exist in total. For diagnostics, never for a report. */
  size(): number {
    return this.entries.length
  }
}

/**
 * Audit a credential use without auditing the credential.
 *
 * The reference is a handle into DSH's own credential store — Watch never
 * holds a secret — so the entry says which connection was used, by whom, for
 * what, and nothing that could be replayed.
 */
export function credentialUse(input: {
  readonly tenantId: string
  readonly workspaceId: string | null
  readonly actorUserId: string
  readonly connectionId: string
  readonly purpose: string
  readonly at: string
  readonly correlationId: string | null
}): Omit<AuditEntry, 'entryId'> {
  return {
    tenantId: input.tenantId,
    at: input.at,
    action: 'credential.used',
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    subjectId: input.connectionId,
    subjectKind: 'connection',
    detail: { purpose: input.purpose },
    correlationId: input.correlationId,
  }
}

/**
 * Audit a memory mutation without auditing the memory.
 *
 * Ids and kinds only. An audit trail of what was forgotten, containing what
 * was forgotten, is not a deletion — and the log is precisely where that
 * mistake survives longest.
 */
export function memoryMutation(input: {
  readonly tenantId: string
  readonly workspaceId: string | null
  readonly actorUserId: string | null
  readonly memoryId: string
  readonly kind: string
  readonly operation: string
  readonly at: string
}): Omit<AuditEntry, 'entryId'> {
  return {
    tenantId: input.tenantId,
    at: input.at,
    action: 'memory.mutated',
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    subjectId: input.memoryId,
    subjectKind: 'memory',
    detail: { operation: input.operation, kind: input.kind },
    correlationId: null,
  }
}

/**
 * Audit a refused access.
 *
 * Denials are audited as carefully as grants, because a run of them is the
 * clearest signal there is that somebody is enumerating ids. The denial code
 * is recorded; the resource that was asked for is recorded as an id, so a
 * cross-tenant attempt is visible without the log itself becoming the oracle.
 */
export function accessDenied(input: {
  readonly tenantId: string
  readonly actorUserId: string
  readonly permission: string
  readonly code: string
  readonly subjectId: string
  readonly subjectKind: string
  readonly at: string
}): Omit<AuditEntry, 'entryId'> {
  return {
    tenantId: input.tenantId,
    at: input.at,
    action: 'access.denied',
    actorUserId: input.actorUserId,
    workspaceId: null,
    subjectId: input.subjectId,
    subjectKind: input.subjectKind,
    detail: { permission: input.permission, code: input.code },
    correlationId: null,
  }
}
