/**
 * `watchMemory` — durable, correctable, scoped memory for a Harness workspace.
 *
 * The service is deliberately thin. The rules live in `records.ts`, the
 * authority in `ledger.ts`, the selection in `compiler.ts` and the human view
 * in `projector.ts`; this is the seam that mounts them into Cordis and holds
 * the ordering those pieces assume.
 *
 * Three behaviors define it, and all three are about a person keeping control:
 *
 * - **A correction takes effect on the next turn.** Not eventually, not after a
 *   re-index. `correct` supersedes in the same write and the next compile sees
 *   it, because a preference someone has already corrected being applied again
 *   is the failure that makes people stop correcting.
 * - **Forget removes, it does not hide.** The ledger folds a tombstoned id out
 *   of existence and every projection is rebuilt from that fold.
 * - **Nothing high-impact activates itself.** Whatever the confidence, and
 *   whatever it appears the person asked for.
 *
 * @module @deepwatch/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'

/** Owner read, write and traverse. Nothing for the group, nothing for others. */
const OWNER_ONLY_DIRECTORY = 0o700
/** Owner read and write. Nothing for anyone else. */
const OWNER_ONLY_FILE = 0o600

/**
 * Apply a mode, and carry on if the platform will not.
 *
 * Windows has no POSIX modes and `chmod` there is close to a no-op; a
 * filesystem may refuse outright. Neither is a reason to fail to start, and
 * neither is a reason to skip the call on the platforms where it does work.
 * The product never claims the file is protected -- only that it is created as
 * restricted as this machine allows.
 */
function restrict(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // A platform that does not enforce modes is the documented case, not a
    // failure: the Memory page says the ledger is a plain file.
  }
}

/**
 * Restrict every file already in the store, and the store itself.
 *
 * Called after anything that may have created a file this module did not name.
 * SQLite's `-wal` and `-shm` are the reason: they hold the same memories the
 * ledger does and appear without being asked for.
 */
function restrictAll(directory: string): void {
  restrict(directory, OWNER_ONLY_DIRECTORY)
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) restrict(join(directory, entry.name), OWNER_ONLY_FILE)
    }
  } catch {
    // Nothing to tighten yet.
  }
}
import { dirname, join } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {
  AdmissionDecision,
  MemoryEvent,
  MemoryKind,
  MemoryMode,
  MemoryOrigin,
  MemoryRecord,
  MemoryScope,
  ScopeContext,
} from './records.js'
import { activationFor, admit, modePolicy, supersededBy } from './records.js'
import { MemoryLedger } from './ledger.js'
import type { ContextPacket, CompileOptions } from './compiler.js'
import { compileContext, renderContext } from './compiler.js'
import { renderIndex, renderLog, renderTaste } from './projector.js'

export type * from './records.js'
export * from './records.js'
export { MemoryLedger } from './ledger.js'
export * from './compiler.js'
export * from './projector.js'
export * from './tools.js'
export * from './learning.js'
export * from './replay.js'

/** Deployment configuration for memory. */
export interface Config {
  /** What this profile permits. `off` writes and recalls nothing. */
  readonly mode: MemoryMode
  /** Directory for the ledger and the Markdown projections. */
  readonly directory: string
  /** Confidence at or above which an inferred, low-impact memory acts. */
  readonly inferredThreshold: number
  /** Hard ceiling on what memory may cost one turn. */
  readonly tokenBudget: number
  /** Write `taste.md` and friends whenever memory changes. */
  readonly writeProjections: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable, correctable memory scoped to a user, workspace or project. */
    watchMemory: WatchMemoryService
  }
}

/** What a caller supplies to remember something. */
export interface MemoryCandidate {
  readonly kind: MemoryKind
  readonly content: string
  readonly origin: MemoryOrigin
  readonly subjectScope: MemoryScope
  readonly scopeId: string
  readonly confidence?: number
  readonly sourceRefs?: readonly string[]
  readonly evidenceRefs?: readonly string[]
  readonly sensitivity?: MemoryRecord['sensitivity']
  readonly locale?: string | null
}

/** What happened to a candidate. */
export interface RememberResult {
  readonly stored: boolean
  readonly memoryId: string | null
  readonly status: MemoryRecord['status'] | null
  /** Why it was refused, or why it is proposed rather than active. */
  readonly reason: string
  readonly admission: AdmissionDecision
}

/** One recorded reason a memory reached a turn's context. */
export interface InjectionReason {
  readonly at: string
  readonly sessionId: string | null
  readonly reason: string
  readonly tokenEstimate: number
}

/** A portable copy of what one scope can see. */
export interface MemoryExport {
  readonly exportedAt: string
  readonly scope: ScopeContext
  readonly mode: MemoryMode
  readonly records: readonly MemoryRecord[]
  readonly events: readonly MemoryEvent[]
}

/** Durable memory as a Cordis service. */
export class WatchMemoryService extends Service {
  /** Loader validation for the memory policy. */
  static Config: s<Config> = s.object({
    // `off` by default. Durable memory about a person is not something a
    // deployment should acquire because nobody changed a setting.
    mode: s.union(['off', 'session_only', 'local_personal', 'workspace_shared'] as const)
      .default('off'),
    directory: s.string().default('.watch/memory'),
    inferredThreshold: s.number().min(0).max(1).default(0.8),
    tokenBudget: s.number().step(1).min(0).default(600),
    writeProjections: s.boolean().default(true),
  })

  private readonly ledger: MemoryLedger

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'watchMemory')

    const policy = modePolicy(config.mode)
    // `session_only` is an in-memory ledger rather than a file plus a rule
    // about reading it. Making the mode a property of the storage means there
    // is no code path that could accidentally recall across sessions.
    if (policy.persists && policy.recallsAcrossSessions) {
      // Owner-only, where the operating system enforces file modes. The store
      // is plaintext -- the product says so on the Memory page and will keep
      // saying so until an at-rest design exists that has been reviewed -- so
      // the permissions are the only protection it actually has, and leaving
      // them to the umask means a group-readable home makes them nothing.
      //
      // Windows ignores the mode and inherits the parent ACL, which is why the
      // disclosure is worded as it is rather than promising a guarantee this
      // cannot make everywhere.
      mkdirSync(config.directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY })
      restrict(config.directory, OWNER_ONLY_DIRECTORY)
      this.ledger = new MemoryLedger(join(config.directory, 'memory-events.db'))
      // Every file, not just the database. SQLite writes `-wal` and `-shm`
      // beside it, and the write-ahead log holds the same memories the ledger
      // does -- naming one file and forgetting the two it brings with it is how
      // a store ends up half protected.
      restrictAll(config.directory)
    } else {
      this.ledger = new MemoryLedger(':memory:')
    }

    ctx.effect(() => () => { this.ledger.close() }, 'watch-memory: ledger lifecycle')
  }

  /** What this profile permits. */
  mode(): MemoryMode {
    return this.config.mode
  }

  /**
   * Consider remembering something.
   *
   * Returns rather than throws when a candidate is refused: a refusal carries
   * an explanation the caller should relay, and an exception would strip that
   * down to a generic failure.
   */
  remember(candidate: MemoryCandidate, options: {
    readonly userAuthenticated?: boolean
    readonly actor?: 'user' | 'agent' | 'system'
  } = {}): RememberResult {
    const now = new Date().toISOString()
    const record = this.materialize(candidate, now)

    const admission = admit(record, this.config.mode, {
      userAuthenticated: options.userAuthenticated ?? false,
    })
    if (!admission.admitted) {
      return {
        stored: false,
        memoryId: null,
        status: null,
        reason: admission.explanation,
        admission,
      }
    }

    const activation = activationFor(record, { inferredThreshold: this.config.inferredThreshold })
    const stored: MemoryRecord = {
      ...record,
      status: activation.action === 'activate' ? 'active' : 'proposed',
    }

    this.ledger.append({
      kind: activation.action === 'activate' ? 'record.activated' : 'candidate.created',
      memoryId: stored.memoryId,
      at: now,
      actor: options.actor ?? 'agent',
      record: stored,
      detail: activation.action === 'propose' ? { reason: activation.reason } : {},
    })

    // Only a correction supersedes; a new preference alongside an old one is
    // two preferences, and deciding otherwise here would silently delete
    // things nobody asked to remove.
    this.rebuildProjections()

    return {
      stored: true,
      memoryId: stored.memoryId,
      status: stored.status,
      reason: activation.action === 'propose' ? activation.reason : '',
      admission,
    }
  }

  /**
   * Record a correction, superseding what it contradicts.
   *
   * The supersession happens in the same call, so the very next compile sees
   * the new value and none of the old ones. Anything slower — a queue, a
   * rebuild, a nightly pass — means the agent applies a preference the person
   * has already corrected, at least once, and that is the specific experience
   * that teaches people correcting is pointless.
   */
  correct(candidate: MemoryCandidate, options: {
    readonly userAuthenticated?: boolean
  } = {}): RememberResult {
    const result = this.remember(
      { ...candidate, origin: candidate.origin },
      { ...options, actor: 'user' },
    )
    if (!result.stored || result.memoryId === null) return result

    const correction = this.ledger.record(result.memoryId)
    if (correction === null) return result

    const now = new Date().toISOString()
    for (const stale of supersededBy(correction, this.ledger.records())) {
      this.ledger.append({
        kind: 'record.superseded',
        memoryId: stale.memoryId,
        at: now,
        actor: 'user',
        record: { ...stale, status: 'superseded', updatedAt: now },
        detail: { supersededBy: correction.memoryId },
      })
    }
    this.rebuildProjections()
    return result
  }

  /** Affirm a proposed or active memory. */
  confirm(memoryId: string): boolean {
    const record = this.ledger.record(memoryId)
    if (record === null) return false
    const now = new Date().toISOString()
    this.ledger.append({
      kind: 'record.confirmed',
      memoryId,
      at: now,
      actor: 'user',
      record: { ...record, status: 'active', lastConfirmedAt: now, updatedAt: now },
      detail: {},
    })
    this.rebuildProjections()
    return true
  }

  /** Mark a memory contradicted. It stops acting but stays readable. */
  dispute(memoryId: string, reason: string): boolean {
    const record = this.ledger.record(memoryId)
    if (record === null) return false
    const now = new Date().toISOString()
    this.ledger.append({
      kind: 'record.disputed',
      memoryId,
      at: now,
      actor: 'user',
      record: { ...record, status: 'disputed', updatedAt: now },
      detail: { reason },
    })
    this.rebuildProjections()
    return true
  }

  /**
   * Forget a memory.
   *
   * A tombstone in the ledger, then every projection rebuilt from the fold.
   * The record does not come back on replay, does not appear in `taste.md`,
   * and is not in the next context packet — because there is one fold and
   * everything reads it, rather than a delete plus a list of caches somebody
   * has to remember to clear.
   */
  forget(memoryId: string): boolean {
    if (this.ledger.record(memoryId) === null) return false
    this.ledger.append({
      kind: 'record.forgotten',
      memoryId,
      at: new Date().toISOString(),
      actor: 'user',
      record: null,
      // Deliberately no copy of the content: an audit trail of what was
      // forgotten, containing the thing that was forgotten, is not a deletion.
      detail: {},
    })
    this.rebuildProjections()
    return true
  }

  /**
   * Decline a proposal.
   *
   * Distinct from forgetting, and only valid on something still `proposed`.
   * Rejecting an active memory would be a way to remove it without the word
   * "forget" appearing anywhere, and the ledger would then record a deletion
   * as a decline. It tombstones, because a suggestion somebody said no to must
   * not still be sitting in the list they said no to it from.
   */
  reject(memoryId: string, reason: string): boolean {
    const record = this.ledger.record(memoryId)
    if (record === null) return false
    if (record.status !== 'proposed') return false
    this.ledger.append({
      kind: 'record.rejected',
      memoryId,
      at: new Date().toISOString(),
      actor: 'user',
      record: null,
      // The reason, never the content. An audit trail of what was declined,
      // containing the thing that was declined, is not a decline.
      detail: { reason },
    })
    this.rebuildProjections()
    return true
  }

  /**
   * Move a memory to a different scope.
   *
   * The guard is the point. Personal taste is private by default, so widening
   * a preference or anything sensitive into a shared workspace scope needs the
   * person to say so in this call rather than in a setting they changed once.
   * Narrowing is always allowed: pulling something back out of a shared scope
   * should never need permission.
   */
  moveScope(memoryId: string, target: {
    readonly subjectScope: MemoryScope
    readonly scopeId: string
  }, options: { readonly shareExplicitly?: boolean } = {}): {
    readonly moved: boolean
    readonly reason: string
  } {
    const record = this.ledger.record(memoryId)
    if (record === null) return { moved: false, reason: 'No such memory.' }

    const widening = target.subjectScope === 'workspace' && record.subjectScope !== 'workspace'
    const personal = record.kind === 'preference'
      || record.sensitivity === 'sensitive'
      || record.sensitivity === 'restricted'
    if (widening && personal && options.shareExplicitly !== true) {
      return {
        moved: false,
        reason: 'Personal taste is private by default. Sharing it with the workspace '
          + 'has to be chosen explicitly for this memory.',
      }
    }

    const now = new Date().toISOString()
    this.ledger.append({
      kind: 'record.scope_moved',
      memoryId,
      at: now,
      actor: 'user',
      record: {
        ...record,
        subjectScope: target.subjectScope,
        scopeId: target.scopeId,
        updatedAt: now,
      },
      detail: { from: record.subjectScope, to: target.subjectScope, shared: widening },
    })
    this.rebuildProjections()
    return { moved: true, reason: '' }
  }

  /**
   * Export what one scope can see.
   *
   * Built from the same fold every other reader uses, which is what makes the
   * guarantee hold: a forgotten memory is absent from the export for the same
   * reason it is absent from the next context packet, rather than because the
   * export remembered to filter it.
   *
   * Sensitive content is withheld unless asked for. The record still appears —
   * an export that silently omitted rows would misrepresent what is held — but
   * its content is replaced by a marker.
   */
  export(scope: ScopeContext, options: {
    readonly includeSensitive?: boolean
    readonly includeEvents?: boolean
  } = {}): MemoryExport {
    const records = this.ledger.visible(scope).map(record =>
      record.sensitivity === 'public' || record.sensitivity === 'private'
        || options.includeSensitive === true
        ? record
        : { ...record, content: '[withheld: sensitive]' })

    const forgotten = new Set(
      this.ledger.events()
        .filter(event => event.kind === 'record.forgotten' || event.kind === 'record.rejected')
        .map(event => event.memoryId),
    )

    return {
      exportedAt: new Date().toISOString(),
      scope,
      mode: this.config.mode,
      records,
      events: options.includeEvents === true
        // Tombstoned ids are dropped from the event stream too. Exporting the
        // history of something that was deleted would export the deletion and
        // everything it deleted.
        ? this.ledger.events().filter(event => !forgotten.has(event.memoryId))
        : [],
    }
  }

  /**
   * Why a memory was retrieved, in the words the compiler used.
   *
   * Read out of the ledger's own `context.injected` events rather than
   * recomputed, so the answer is what actually happened on that turn and not
   * what would happen if the same question were asked now.
   */
  whyRemembered(memoryId: string, sessionId?: string): readonly InjectionReason[] {
    return this.ledger.history(memoryId)
      .filter(event => event.kind === 'context.injected')
      .filter(event => sessionId === undefined || event.detail['sessionId'] === sessionId)
      .map(event => ({
        at: event.at,
        sessionId: typeof event.detail['sessionId'] === 'string' ? event.detail['sessionId'] : null,
        reason: typeof event.detail['reason'] === 'string' ? event.detail['reason'] : 'no reason recorded',
        tokenEstimate: typeof event.detail['tokens'] === 'number' ? event.detail['tokens'] : 0,
      }))
  }

  /** Every event in the ledger, for the Memory timeline surface. */
  events(sinceSeq = 0): readonly MemoryEvent[] {
    return this.ledger.events(sinceSeq)
  }

  /** Everything visible from a scope, whatever its status. For the UI. */
  list(scope: ScopeContext): readonly MemoryRecord[] {
    return this.ledger.visible(scope)
  }

  /** One record's full history, for "why does it think that?". */
  history(memoryId: string): ReturnType<MemoryLedger['history']> {
    return this.ledger.history(memoryId)
  }

  /**
   * Build the memory packet for one turn.
   *
   * Records the inclusion trace in the ledger as it goes, so "Why remembered?"
   * can answer for a turn that has already finished.
   */
  compile(scope: ScopeContext, options: Partial<CompileOptions> = {}): ContextPacket {
    if (!modePolicy(this.config.mode).recallsAcrossSessions
      && this.config.mode === 'off') {
      return { items: [], tokenEstimate: 0, droppedForBudget: [], fellBackToNone: false }
    }

    const now = new Date().toISOString()
    const packet = compileContext(
      this.ledger.injectable(scope, now),
      scope,
      { tokenBudget: this.config.tokenBudget, ...options },
    )

    for (const item of packet.items) {
      this.ledger.append({
        kind: 'context.injected',
        memoryId: item.memoryId,
        at: now,
        actor: 'system',
        record: null,
        detail: { reason: item.reason, sessionId: scope.sessionId, tokens: item.tokenEstimate },
      })
    }
    return packet
  }

  /** The packet as a system-prompt section, or empty when there is nothing. */
  render(scope: ScopeContext, options: Partial<CompileOptions> = {}): string {
    return renderContext(this.compile(scope, options))
  }

  /** Event counts, for the memory dashboard and diagnostics. */
  stats(): Readonly<Record<string, number>> {
    return this.ledger.counts()
  }

  /** Fill in everything a candidate did not state. */
  private materialize(candidate: MemoryCandidate, now: string): MemoryRecord {
    return {
      memoryId: `mem_${randomUUID()}`,
      kind: candidate.kind,
      subjectScope: candidate.subjectScope,
      scopeId: candidate.scopeId,
      content: candidate.content,
      origin: candidate.origin,
      sourceRefs: candidate.sourceRefs ?? [],
      evidenceRefs: candidate.evidenceRefs ?? [],
      // An explicit statement is certain by definition; anything else has to
      // say how sure it is rather than defaulting to sure.
      confidence: candidate.confidence ?? (candidate.origin === 'explicit_user' ? 1 : 0.5),
      status: 'proposed',
      sensitivity: candidate.sensitivity ?? 'private',
      validFrom: now,
      validUntil: null,
      createdAt: now,
      updatedAt: now,
      lastConfirmedAt: candidate.origin === 'explicit_user' ? now : null,
      supersedes: [],
      contradictedBy: [],
      locale: candidate.locale ?? null,
    }
  }

  /** Regenerate every Markdown projection from the ledger. */
  private rebuildProjections(): void {
    if (!modePolicy(this.config.mode).recallsAcrossSessions) return
    // Whatever else happens below, the store is left as tightly as this
    // platform allows. SQLite's write-ahead log appears on the first *write*,
    // not when the database is opened, so tightening only at construction
    // leaves a file holding the same memories the ledger does at whatever the
    // umask happened to be.
    try {
      if (!this.config.writeProjections) return
      this.writeProjections()
    } finally {
      restrictAll(this.config.directory)
    }
  }

  /** Regenerate the Markdown projections themselves. */
  private writeProjections(): void {
    const records = this.ledger.records()
    const files: Record<string, string> = {
      'taste.md': renderTaste(records),
      'index.md': renderIndex(records),
      'log.md': renderLog(this.ledger.events()),
    }
    for (const [name, content] of Object.entries(files)) {
      const path = join(this.config.directory, name)
      mkdirSync(dirname(path), { recursive: true, mode: OWNER_ONLY_DIRECTORY })
      writeFileSync(path, content, { encoding: 'utf8', mode: OWNER_ONLY_FILE })
      // `mode` on `writeFileSync` applies at creation only, so a projection
      // rewritten over a file that already exists would keep whatever
      // permissions it was first given.
      restrict(path, OWNER_ONLY_FILE)
    }
    this.ledger.append({
      kind: 'projection.rebuilt',
      memoryId: '-',
      at: new Date().toISOString(),
      actor: 'system',
      record: null,
      detail: { files: Object.keys(files) },
    })
  }
}

export default WatchMemoryService
