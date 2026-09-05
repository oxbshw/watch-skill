/**
 * `taste.md` and the other Markdown projections.
 *
 * ADR-007: this is a *view*, not a database and not a prompt. It exists so a
 * person can read what the agent has concluded about working with them, in one
 * place, without a UI — and correct it.
 *
 * Two properties make that safe. It is deterministic, so the same ledger always
 * renders the same file and a diff means something actually changed. And it is
 * rebuilt rather than edited, so it cannot drift from the ledger and cannot
 * become a second place where memory lives.
 *
 * Every entry shows its origin, scope, confidence and status. A file that
 * showed only the content would let an inference the agent made and a
 * statement the person made look identical, which is precisely the confusion
 * that makes personalization feel arbitrary.
 *
 * @module @deepwatch/dsh-memory/projector
 */

import type { MemoryRecord } from './records.js'

/** Human wording for an origin. */
const ORIGIN_LABEL: Record<MemoryRecord['origin'], string> = {
  explicit_user: 'you told me',
  observed: 'observed',
  inferred: 'inferred',
  imported: 'imported',
  system: 'set by this deployment',
}

/** Scope shown as a bracketed tag, the way the plan renders it. */
function scopeTag(record: MemoryRecord): string {
  return record.subjectScope === 'user'
    ? '[global]'
    : `[${record.subjectScope}${record.scopeId === '' ? '' : `:${record.scopeId}`}]`
}

/** One entry, with everything needed to judge it. */
function entry(record: MemoryRecord): readonly string[] {
  const meta = [
    ORIGIN_LABEL[record.origin],
    record.origin === 'inferred' ? `confidence ${record.confidence.toFixed(2)}` : null,
    record.lastConfirmedAt === null
      ? 'never confirmed'
      : `confirmed ${record.lastConfirmedAt.slice(0, 10)}`,
  ].filter((part): part is string => part !== null)

  return [
    `- ${scopeTag(record)} ${record.content}`,
    `  Source: ${meta.join(' · ')} · \`${record.memoryId}\``,
  ]
}

/** Stable ordering: newest first, then by id so a redraw never reshuffles. */
function ordered(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  return [...records].sort((a, b) => {
    const byCreated = b.createdAt.localeCompare(a.createdAt)
    return byCreated !== 0 ? byCreated : a.memoryId.localeCompare(b.memoryId)
  })
}

/** Render one section, or nothing when it is empty. */
function section(
  title: string,
  note: string | null,
  records: readonly MemoryRecord[],
): readonly string[] {
  if (records.length === 0) return []
  const lines = [`## ${title}`, '']
  if (note !== null) lines.push(`_${note}_`, '')
  for (const record of ordered(records)) lines.push(...entry(record))
  lines.push('')
  return lines
}

/**
 * Render `taste.md` from the current records.
 *
 * Explicit and inferred preferences are kept in separate sections rather than
 * merged and annotated. Mixing them and relying on a per-line label means the
 * distinction survives only as long as everyone reads carefully, and the whole
 * point is that someone skimming can see which is which.
 */
export function renderTaste(records: readonly MemoryRecord[]): string {
  const preferences = records.filter(record => record.kind === 'preference')
  const active = preferences.filter(record => record.status === 'active')

  const lines = [
    '# Taste',
    '',
    '_How I have learned to work with you. This file is generated from the memory_',
    '_ledger — edit it and the change is read back as a correction, not overwritten._',
    '',
    ...section(
      'Explicit',
      'Things you told me directly.',
      active.filter(record => record.origin === 'explicit_user'),
    ),
    ...section(
      'Learned — active',
      'Concluded from how you worked, and currently in effect.',
      active.filter(record => record.origin === 'observed' || record.origin === 'inferred'),
    ),
    ...section(
      'Imported',
      'Claims from a source you connected. Kept, but not agreed to by you.',
      active.filter(record => record.origin === 'imported'),
    ),
    ...section(
      'Proposed',
      'Waiting for you. Not acting on anything yet.',
      preferences.filter(record => record.status === 'proposed'),
    ),
    ...section(
      'Disputed',
      'Contradicted by something newer. Not in use.',
      preferences.filter(record => record.status === 'disputed'),
    ),
    ...section(
      'Superseded',
      'Replaced. Kept so the history of a correction stays readable.',
      preferences.filter(record => record.status === 'superseded'),
    ),
  ]

  if (preferences.length === 0) {
    lines.push('_Nothing yet. Preferences appear here as they are learned or set._', '')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * Render `index.md`: what is remembered, by kind.
 *
 * A map rather than a listing. Somebody arriving at a memory directory needs to
 * know what is in it before they need the contents.
 */
export function renderIndex(records: readonly MemoryRecord[]): string {
  const kinds = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    const bucket = kinds.get(record.kind) ?? []
    bucket.push(record)
    kinds.set(record.kind, bucket)
  }

  const lines = ['# Memory index', '']
  if (kinds.size === 0) {
    lines.push('_Nothing is remembered yet._', '')
    return `${lines.join('\n')}\n`
  }

  lines.push('| Kind | Active | Proposed | Other |', '|---|---:|---:|---:|')
  for (const [kind, bucket] of [...kinds].sort()) {
    const active = bucket.filter(record => record.status === 'active').length
    const proposed = bucket.filter(record => record.status === 'proposed').length
    lines.push(`| ${kind} | ${active} | ${proposed} | ${bucket.length - active - proposed} |`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * Render `log.md`: the chronology.
 *
 * The ledger is the authority but it is not readable. This is the part a
 * person actually checks when they want to know when the agent started
 * behaving a certain way.
 */
export function renderLog(
  events: readonly {
    readonly at: string
    readonly kind: string
    readonly memoryId: string
    readonly actor: string
  }[],
  limit = 200,
): string {
  const lines = ['# Memory log', '', '_Most recent first._', '']
  const recent = [...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
  if (recent.length === 0) {
    lines.push('_No memory events yet._', '')
    return `${lines.join('\n')}\n`
  }
  for (const event of recent) {
    lines.push(`- \`${event.at}\` **${event.kind}** by ${event.actor} — \`${event.memoryId}\``)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
