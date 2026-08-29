/**
 * The Memory surfaces, and what a person is allowed to do to a memory.
 *
 * The backend has been real for a while: an append-only ledger, correction
 * precedence, forgetting that actually forgets. None of that is worth anything
 * to a person who cannot see it. A memory system whose contents are invisible
 * is indistinguishable, from the outside, from a model that has opinions —
 * which is the thing it exists to not be.
 *
 * So every view here is built on two rules.
 *
 * **Nothing is shown without its provenance.** Each card carries the id, the
 * kind, the scope, the origin, the confidence, the status, where it came from,
 * when a person last affirmed it, and — when it reached a turn — why it was
 * retrieved. A memory shown as a bare sentence is a memory nobody can argue
 * with, and arguing with it is the entire point of the surface.
 *
 * **Every operation is reachable from where the memory is.** Confirm, edit,
 * reject, dispute, forget, move scope and export are offered on the card, not
 * buried in a settings page. Correction has to be cheaper than tolerating the
 * wrong thing, or people tolerate the wrong thing.
 *
 * This module is pure. It takes records and events and returns view models; it
 * holds no ledger, opens no database and performs no operation. The service in
 * `@watchskill/dsh-memory` does all of that, and keeping the browser half
 * unable to reach it is what stops a UI from becoming a second writer.
 *
 * @module @watchskill/dsh-client-memory/views
 */

import type {
  InjectionReason,
  MemoryEvent,
  MemoryRecord,
  MemoryScope,
} from '@watchskill/dsh-memory'

/** The Memory surfaces, in tab order. */
export type MemoryView =
  | 'taste'
  | 'timeline'
  | 'wiki'
  | 'decisions'
  | 'lessons'
  | 'failures'
  | 'sources'

/** Every view, in tab order. */
export const MEMORY_VIEWS: readonly MemoryView[] = [
  'taste', 'timeline', 'wiki', 'decisions', 'lessons', 'failures', 'sources',
]

/** What each view is called and what it holds. */
export const VIEW_LABEL: Readonly<Record<MemoryView, string>> = {
  taste: 'Taste',
  timeline: 'Timeline',
  wiki: 'Wiki',
  decisions: 'Decisions',
  lessons: 'Lessons',
  failures: 'Failures',
  sources: 'Sources',
}

/**
 * Which record kinds each view shows.
 *
 * `timeline` and `wiki` are empty here because neither is a filter over
 * records: the timeline is over events, and the wiki is a generated projection
 * with its own module. Listing them with an empty set rather than leaving them
 * out keeps the view table exhaustive.
 */
const VIEW_KINDS: Readonly<Record<MemoryView, readonly MemoryRecord['kind'][]>> = {
  taste: ['preference'],
  timeline: [],
  wiki: [],
  decisions: ['decision'],
  lessons: ['lesson', 'procedure'],
  failures: ['failure'],
  sources: ['fact', 'episode'],
}

/**
 * The records one view shows, in a stable order.
 *
 * Ordered by most recently updated, then by id. The id tiebreak is not
 * decoration: without it, two records updated in the same millisecond swap
 * places between renders, and a list that reorders itself while being read is
 * a list people stop trusting.
 */
export function recordsForView(
  view: MemoryView,
  records: readonly MemoryRecord[],
): readonly MemoryRecord[] {
  const kinds = new Set(VIEW_KINDS[view])
  if (kinds.size === 0) return []
  return records
    .filter(record => kinds.has(record.kind))
    .sort((left, right) => {
      const byTime = right.updatedAt.localeCompare(left.updatedAt)
      return byTime !== 0 ? byTime : left.memoryId.localeCompare(right.memoryId)
    })
}

/** Events the Memory timeline shows, newest first. */
export function eventsForTimeline(events: readonly MemoryEvent[]): readonly MemoryEvent[] {
  return [...events].sort((left, right) => {
    const byTime = right.at.localeCompare(left.at)
    return byTime !== 0 ? byTime : left.eventId.localeCompare(right.eventId)
  })
}

// ── operations ──────────────────────────────────────────────────────────────

/** What a person can do to a memory. */
export type MemoryOperation =
  | 'confirm'
  | 'edit'
  | 'reject'
  | 'dispute'
  | 'forget'
  | 'move_scope'
  | 'export'

/** Every operation, for enumerating the toolbar. */
export const MEMORY_OPERATIONS: readonly MemoryOperation[] = [
  'confirm', 'edit', 'reject', 'dispute', 'forget', 'move_scope', 'export',
]

/** What each operation's button says. */
export const OPERATION_LABEL: Readonly<Record<MemoryOperation, string>> = {
  confirm: 'Confirm',
  edit: 'Edit',
  reject: 'Reject',
  dispute: 'Dispute',
  forget: 'Forget',
  move_scope: 'Move scope',
  export: 'Export',
}

/**
 * Which operations apply to one record.
 *
 * `reject` is offered only on a proposal, because rejecting an active memory
 * would be a way to delete one without the word "forget" appearing anywhere,
 * and the ledger would then record a deletion as a decline. `dispute` is the
 * opposite: it applies only to something that is actually in force, since
 * contradicting a suggestion is just declining it.
 *
 * `forget` is always available. There is no state of a memory in which a
 * person may not remove it, and any exception would eventually be the one that
 * matters.
 */
export function availableOperations(record: MemoryRecord): readonly MemoryOperation[] {
  const operations: MemoryOperation[] = []
  if (record.status === 'proposed' || record.status === 'active') operations.push('confirm')
  operations.push('edit')
  if (record.status === 'proposed') operations.push('reject')
  if (record.status === 'active') operations.push('dispute')
  operations.push('forget', 'move_scope', 'export')
  return operations
}

// ── cards ───────────────────────────────────────────────────────────────────

/**
 * A memory as a person reads it.
 *
 * Every field the vision requires is here as its own property rather than as
 * prose, so a test can assert the surface exposes all of them and a
 * translation cannot lose one.
 */
export interface MemoryCard {
  readonly memoryId: string
  readonly kind: MemoryRecord['kind']
  readonly scope: MemoryScope
  readonly scopeId: string
  readonly origin: MemoryRecord['origin']
  readonly confidence: number
  readonly status: MemoryRecord['status']
  /** Where this came from, as ids. Empty when nothing was recorded. */
  readonly provenance: readonly string[]
  /** ISO-8601, or null when a person has never affirmed it. */
  readonly lastConfirmedAt: string | null
  /** The content, or a marker when it is withheld. */
  readonly content: string
  /** Whether the content above is a marker rather than the memory. */
  readonly withheld: boolean
  /** Why it reached a turn's context, most recent first. */
  readonly why: readonly InjectionReason[]
  readonly operations: readonly MemoryOperation[]
  readonly locale: string | null
}

/** How the card was asked to treat sensitive content. */
export interface CardOptions {
  /** Reveal content for `sensitive` and `restricted` records. */
  readonly revealSensitive?: boolean
  /** Injection reasons, keyed by memory id. */
  readonly reasons?: ReadonlyMap<string, readonly InjectionReason[]>
}

/**
 * Build the card for one record.
 *
 * Sensitive content is withheld by default and the record still appears. The
 * alternative — hiding the row — would mean a person could not discover that
 * something sensitive is held about them, which is worse than not being able
 * to read it in one click.
 */
export function toCard(record: MemoryRecord, options: CardOptions = {}): MemoryCard {
  const sensitive = record.sensitivity === 'sensitive' || record.sensitivity === 'restricted'
  const withheld = sensitive && options.revealSensitive !== true
  return {
    memoryId: record.memoryId,
    kind: record.kind,
    scope: record.subjectScope,
    scopeId: record.scopeId,
    origin: record.origin,
    confidence: record.confidence,
    status: record.status,
    provenance: [...record.sourceRefs, ...record.evidenceRefs],
    lastConfirmedAt: record.lastConfirmedAt,
    content: withheld ? '[withheld — sensitive]' : record.content,
    withheld,
    why: options.reasons?.get(record.memoryId) ?? [],
    operations: availableOperations(record),
    locale: record.locale,
  }
}

/**
 * The one-line answer to "why do you know that?".
 *
 * Returns null rather than a placeholder when a memory has never been
 * retrieved. A chip reading "no reason recorded" on a memory that simply never
 * reached a turn would be a small lie repeated on every card.
 */
export function whyChip(card: MemoryCard): string | null {
  const latest = card.why[0]
  if (latest === undefined) return null
  return `Remembered: ${latest.reason}`
}

/**
 * Whether a card may claim it influenced a given session.
 *
 * The Memory surface and the "Why remembered?" chip in the conversation share
 * this, so a chip cannot appear on a turn the memory was not part of.
 */
export function influencedSession(card: MemoryCard, sessionId: string): boolean {
  return card.why.some(reason => reason.sessionId === sessionId)
}

// ── modes ───────────────────────────────────────────────────────────────────

/** What each durable memory mode means, in the words the UI uses. */
export const MODE_DESCRIPTION: Readonly<Record<
  'off' | 'session_only' | 'local_personal' | 'workspace_shared',
  string
>> = {
  off: 'Nothing is remembered. Nothing is recalled, this session or any other.',
  session_only: 'Remembered for this session and discarded when it ends. Never written to disk.',
  local_personal: 'Remembered on this machine, for you. Never shared with the workspace.',
  workspace_shared:
    'Project facts and decisions are shared with the workspace. Your personal taste stays private.',
}

/**
 * Whether a record is visible to other members of a shared workspace.
 *
 * The rule the mode name does not say on its own: `workspace_shared` shares
 * what is about the *work*, not what is about the *person*. A preference is
 * personal whatever scope it was filed under, and anything marked sensitive or
 * restricted stays where it is.
 */
export function isSharedWithWorkspace(record: MemoryRecord, mode: string): boolean {
  if (mode !== 'workspace_shared') return false
  if (record.subjectScope !== 'workspace' && record.subjectScope !== 'project') return false
  if (record.kind === 'preference') return false
  return record.sensitivity === 'public' || record.sensitivity === 'private'
}
