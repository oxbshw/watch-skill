/**
 * The MemoryEvent ledger.
 *
 * ADR-006 makes this the authority. Every record the rest of the system sees
 * is a fold over these events, and the Markdown projections and search indexes
 * are caches that can be deleted and rebuilt from here.
 *
 * That is not architectural taste — it is what makes *forget* mean something.
 * If records were the stored truth and projections were maintained alongside
 * them, forgetting would be a delete plus a set of cleanups that someone has
 * to remember to write, and the one that gets missed is where the forgotten
 * thing survives. Here there is one write path and one fold, so a tombstoned
 * record cannot come back through a stale index.
 *
 * @module @watchskill/dsh-memory/ledger
 */

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  MemoryEvent,
  MemoryEventKind,
  MemoryRecord,
  ScopeContext,
} from './records.js'
import { isInScope, isInjectable } from './records.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  record     TEXT,
  detail     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_events_by_memory ON memory_events (memory_id, seq);
CREATE INDEX IF NOT EXISTS memory_events_by_kind ON memory_events (kind, seq);
`

/** How the ledger reports what it did, without exposing its storage. */
export interface AppendResult {
  readonly eventId: string
  readonly seq: number
}

/** An append-only store of memory events, with a fold to current records. */
export class MemoryLedger {
  private readonly db: DatabaseSync

  /**
   * The fold, kept between calls and advanced incrementally.
   *
   * A benchmark found `compile()` at a 231ms p95 on a 500-record ledger
   * against a 50ms budget, and the whole of it was here: every caller of
   * `records()` re-read and re-parsed the entire event table, and `record()`
   * called `records()` for a single lookup.
   *
   * An append-only log is exactly the shape where this is safe. New events
   * only ever arrive after the ones already folded, so the cache advances by
   * reading `events(sinceSeq)` rather than by being invalidated — and there is
   * no update path that could make an already-folded event wrong, because
   * there is no update path at all.
   */
  private folded: Map<string, MemoryRecord> = new Map()
  private tombstoned: Set<string> = new Set()
  private foldedUpToSeq = 0

  /**
   * @param path - the database file, or `:memory:` for an ephemeral ledger.
   *   `session_only` mode uses the latter, which is what makes that mode a
   *   property of the storage rather than a rule someone has to enforce.
   */
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // WAL keeps a reader (a context compile) from blocking a writer (a
    // correction landing mid-turn), which is the normal shape of the load.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  /** Append one event. The only write path there is. */
  append(event: Omit<MemoryEvent, 'eventId'> & { readonly eventId?: string }): AppendResult {
    const eventId = event.eventId ?? `mev_${randomUUID()}`
    this.db.prepare(
      `INSERT INTO memory_events (event_id, kind, memory_id, at, actor, record, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      event.kind,
      event.memoryId,
      event.at,
      event.actor,
      event.record === null ? null : JSON.stringify(event.record),
      JSON.stringify(event.detail),
    )
    const row = this.db.prepare('SELECT seq FROM memory_events WHERE event_id = ?')
      .get(eventId) as { seq: number }
    return { eventId, seq: row.seq }
    // The fold is not advanced here. It advances lazily on the next read,
    // which keeps a write that nobody reads from paying for a fold.
  }

  /** Read the whole ledger in order. Used to rebuild every projection. */
  events(sinceSeq = 0): readonly MemoryEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_events WHERE seq > ? ORDER BY seq ASC',
    ).all(sinceSeq) as readonly Record<string, unknown>[]
    return rows.map(toEvent)
  }

  /** Every event about one memory, oldest first. Its whole history. */
  history(memoryId: string): readonly MemoryEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_events WHERE memory_id = ? ORDER BY seq ASC',
    ).all(memoryId) as readonly Record<string, unknown>[]
    return rows.map(toEvent)
  }

  /**
   * Fold the ledger into the records that currently exist.
   *
   * A forgotten memory is absent from the result entirely — not present with a
   * `deleted` status, which would leave every caller responsible for filtering
   * it and would eventually be forgotten by one of them.
   */
  records(): readonly MemoryRecord[] {
    this.advanceFold()
    return [...this.folded.values()]
  }

  /**
   * Read whatever has arrived since the last fold and apply it.
   *
   * The same rules as the original whole-log fold, applied to a suffix. The
   * tombstone set has to persist across calls for the "never comes back" rule
   * to survive: a `record.forgotten` in an earlier batch must still suppress a
   * record carried by an event in a later one.
   */
  private advanceFold(): void {
    const current = this.folded
    const forgotten = this.tombstoned
    let highest = this.foldedUpToSeq

    for (const event of this.eventsWithSeq(this.foldedUpToSeq)) {
      highest = Math.max(highest, event.seq)
      // A rejection tombstones exactly like a forget. A declined proposal that
      // stayed readable would be a suggestion the person said no to, still
      // sitting in the list they said no to it from.
      if (event.kind === 'record.forgotten' || event.kind === 'record.rejected') {
        forgotten.add(event.memoryId)
        current.delete(event.memoryId)
        continue
      }
      // A tombstoned id never comes back, even if a later event carries a
      // record for it. Replay must not resurrect what someone deleted.
      if (forgotten.has(event.memoryId)) continue
      if (event.record !== null) current.set(event.memoryId, event.record)
    }

    this.foldedUpToSeq = highest
  }

  /** Events after a sequence, carrying their sequence for the fold cursor. */
  private eventsWithSeq(sinceSeq: number): readonly (MemoryEvent & { seq: number })[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_events WHERE seq > ? ORDER BY seq ASC',
    ).all(sinceSeq) as readonly Record<string, unknown>[]
    return rows.map(row => ({ ...toEvent(row), seq: Number(row['seq']) }))
  }

  /** One current record, or null when it never existed or was forgotten. */
  record(memoryId: string): MemoryRecord | null {
    this.advanceFold()
    return this.folded.get(memoryId) ?? null
  }

  /**
   * Records visible from one scope and eligible to act.
   *
   * Both filters, always, in this order. Scope decides what may be seen at
   * all; injectability decides what may act. Splitting them lets the Memory
   * surface show a person their disputed and proposed records without any of
   * that reaching a model's context.
   */
  injectable(scope: ScopeContext, now: string): readonly MemoryRecord[] {
    return this.records().filter(record =>
      isInScope(record, scope) && isInjectable(record, now))
  }

  /** Everything visible from a scope, whatever its status. For the UI. */
  visible(scope: ScopeContext): readonly MemoryRecord[] {
    return this.records().filter(record => isInScope(record, scope))
  }

  /** Whether an id has been tombstoned. */
  isForgotten(memoryId: string): boolean {
    this.advanceFold()
    return this.tombstoned.has(memoryId)
  }

  /** Count events by kind, for diagnostics and the memory dashboard. */
  counts(): Readonly<Record<string, number>> {
    const rows = this.db.prepare(
      'SELECT kind, COUNT(*) AS total FROM memory_events GROUP BY kind',
    ).all() as readonly Record<string, unknown>[]
    return Object.fromEntries(rows.map(row => [String(row['kind']), Number(row['total'])]))
  }

  /** Release the handle. Safe to call twice. */
  close(): void {
    try {
      this.db.close()
    } catch {
      // Already closed. Shutdown runs this path more than once by design.
    }
  }
}

/** Rehydrate one stored row. */
function toEvent(row: Record<string, unknown>): MemoryEvent {
  return {
    eventId: String(row['event_id']),
    kind: String(row['kind']) as MemoryEventKind,
    memoryId: String(row['memory_id']),
    at: String(row['at']),
    actor: String(row['actor']) as MemoryEvent['actor'],
    // Narrowed rather than stringified. `String()` on an unexpected column
    // type produces "[object Object]", which then parses as nothing and hides
    // a schema problem behind an empty record.
    record: typeof row['record'] === 'string'
      ? JSON.parse(row['record']) as MemoryRecord
      : null,
    detail: typeof row['detail'] === 'string'
      ? JSON.parse(row['detail']) as Record<string, unknown>
      : {},
  }
}
