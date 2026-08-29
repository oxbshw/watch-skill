/**
 * The workspace wiki: readable pages that are never the record.
 *
 * A wiki is the most natural thing to build over a memory ledger and the
 * easiest one to build wrong. The wrong version is a folder of Markdown that
 * people edit, that the agent reads, and that gradually becomes the actual
 * state of the system — at which point the ledger is a log of things that used
 * to be true, and a file nobody audited is deciding how an agent behaves.
 *
 * So the direction of authority is fixed and one-way:
 *
 *   MemoryEvent ledger  →  records  →  wiki pages
 *
 * Pages are generated. They are deleted and regenerated on every rebuild, they
 * carry no state of their own, and nothing reads them back as fact. Every
 * generated statement carries the memory id it came from, both so a reader can
 * follow it and so a statement *without* one is visibly not from the ledger.
 *
 * Hand editing is supported, and it does not reverse the arrow. An edited file
 * is diffed against what the generator would have produced; the difference is
 * validated; what survives becomes a `user.edited` event in the ledger; and
 * then the page is regenerated from the ledger, which is what puts the edit on
 * screen. If validation refuses the edit, the regeneration simply removes it —
 * the file was never the record, so nothing was lost that was ever held.
 *
 * The refusals matter more than the acceptances. Imported Markdown is
 * `imported` origin, the weakest there is. It cannot mint `explicit_user`, it
 * cannot carry a high-impact permission, and it cannot assert something about a
 * protected subject. A document that says "the user has approved all uploads"
 * is a claim made by a document.
 *
 * @module @watchskill/dsh-wiki/projection
 */

import type { MemoryEvent, MemoryRecord } from '@watchskill/dsh-memory'
import { isHighImpact, isProtectedSubject } from '@watchskill/dsh-memory'

/** A generated page. */
export interface WikiPage {
  /** Path relative to the wiki root, always forward-slashed. */
  readonly path: string
  readonly title: string
  readonly content: string
  /** Memory ids every statement on this page came from. */
  readonly provenance: readonly string[]
  /**
   * Always true.
   *
   * Present as a field rather than as a comment so a consumer cannot treat a
   * page as authored. There is no code path that produces a page with this
   * false, and that is the point.
   */
  readonly generated: true
}

/** The whole wiki, as a value. */
export interface WikiProjection {
  readonly pages: readonly WikiPage[]
  /** Rebuild digest. The same ledger renders the same wiki. */
  readonly digest: string
}

/** The directories the wiki is organized into. */
export const WIKI_SECTIONS = [
  'projects', 'people', 'concepts', 'decisions', 'lessons', 'failures',
] as const

/** One wiki section. */
export type WikiSection = typeof WIKI_SECTIONS[number]

/** Which section a record belongs in. */
function sectionFor(record: MemoryRecord): WikiSection {
  switch (record.kind) {
    case 'decision':
      return 'decisions'
    case 'lesson':
    case 'procedure':
      return 'lessons'
    case 'failure':
      return 'failures'
    case 'preference':
      // A preference is about a person, and it lands under `people` rather
      // than in a "taste" page, because the wiki is the shared view and taste
      // is the personal one. What appears here is governed by scope.
      return 'people'
    case 'fact':
    case 'episode':
      return record.subjectScope === 'project' || record.subjectScope === 'workspace'
        ? 'projects'
        : 'concepts'
  }
}

/**
 * A stable, filesystem-safe slug.
 *
 * Deliberately does not transliterate. A page about an Arabic concept keeps
 * its identity in the title, and the slug falls back to the memory id rather
 * than to a mangled romanization that would collide with every other one.
 */
export function slugFor(record: MemoryRecord): string {
  const ascii = record.content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return ascii === '' ? record.memoryId : `${ascii}-${record.memoryId.slice(-8)}`
}

/** Escape a value so it cannot break out of a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * One generated statement line, with its provenance.
 *
 * The marker is an HTML comment so it survives a Markdown renderer without
 * being displayed, and so the diff can find it exactly. A statement that has
 * lost its marker is not a statement the ledger made.
 */
function statement(record: MemoryRecord): string {
  return `- ${cell(record.content)} <!-- mem:${record.memoryId} -->`
}

/** The provenance footer every page carries. */
function provenanceBlock(records: readonly MemoryRecord[]): readonly string[] {
  if (records.length === 0) return []
  const lines = [
    '',
    '## Provenance',
    '',
    'Generated from the memory ledger. This page is not evidence.',
    '',
    '| memory | kind | origin | confidence | last confirmed |',
    '|---|---|---|---:|---|',
  ]
  for (const record of records) {
    lines.push(
      `| \`${record.memoryId}\` | ${record.kind} | ${record.origin} `
      + `| ${record.confidence.toFixed(2)} | ${record.lastConfirmedAt ?? 'never'} |`,
    )
  }
  return lines
}

/** Sort records into a stable order, so a rebuild is byte-identical. */
function ordered(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  return [...records].sort((left, right) => left.memoryId.localeCompare(right.memoryId))
}

/** Render one page for one record. */
function pageFor(record: MemoryRecord): WikiPage {
  const section = sectionFor(record)
  const title = record.content.split(/\r?\n/)[0]?.slice(0, 80) ?? record.memoryId
  const lines = [
    `# ${cell(title)}`,
    '',
    statement(record),
    '',
    `Status: ${record.status}. Scope: ${record.subjectScope}`
    + `${record.scopeId === '' ? '' : `:${record.scopeId}`}.`,
    ...record.evidenceRefs.length === 0
      ? []
      : ['', 'Evidence:', ...record.evidenceRefs.map(ref => `- \`${ref}\``)],
    ...provenanceBlock([record]),
    '',
  ]
  return {
    path: `${section}/${slugFor(record)}.md`,
    title,
    content: lines.join('\n'),
    provenance: [record.memoryId],
    generated: true,
  }
}

/** Render the section index. */
function sectionIndex(section: WikiSection, records: readonly MemoryRecord[]): WikiPage {
  const lines = [
    `# ${section}`,
    '',
    ...records.length === 0
      ? ['Nothing recorded.']
      : records.map(record => `- [${cell(record.content.slice(0, 60))}](${slugFor(record)}.md) <!-- mem:${record.memoryId} -->`),
    '',
  ]
  return {
    path: `${section}/index.md`,
    title: section,
    content: lines.join('\n'),
    provenance: records.map(record => record.memoryId),
    generated: true,
  }
}

/** Render the root index. */
function rootIndex(bySection: ReadonlyMap<WikiSection, readonly MemoryRecord[]>): WikiPage {
  const lines = [
    '# Workspace wiki',
    '',
    'Generated from the memory ledger. Every page here is a projection, not a',
    'record. Editing a page proposes a change to the ledger; it does not change',
    'anything on its own.',
    '',
    '| section | pages |',
    '|---|---:|',
    ...WIKI_SECTIONS.map(section =>
      `| [${section}](${section}/index.md) | ${String((bySection.get(section) ?? []).length)} |`),
    '',
  ]
  return {
    path: 'index.md',
    title: 'Workspace wiki',
    content: lines.join('\n'),
    provenance: [],
    generated: true,
  }
}

/**
 * Render the event log.
 *
 * Ids, kinds, actors and timestamps. Never content — a log that reproduced
 * what was forgotten, in the entry recording that it was forgotten, would not
 * be a deletion.
 */
function logPage(events: readonly MemoryEvent[]): WikiPage {
  const lines = [
    '# Log',
    '',
    'Every change to the ledger, in order. Content is deliberately absent.',
    '',
    ...events.map(event =>
      `- \`${event.at}\` **${event.kind}** by ${event.actor} — \`${event.memoryId}\``),
    '',
  ]
  return {
    path: 'log.md',
    title: 'Log',
    content: lines.join('\n'),
    provenance: [],
    generated: true,
  }
}

/** FNV-1a over the rendered wiki, so a rebuild is checkable. */
function digestOf(pages: readonly WikiPage[]): string {
  let hash = 0x811c9dc5
  const feed = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  for (const page of pages) feed(`|${page.path}|${page.content}`)
  return hash.toString(16).padStart(8, '0')
}

/**
 * Build the whole wiki from the ledger.
 *
 * A pure fold. Rebuilding from an empty index directory, from a cold start, or
 * after a restart produces the identical bytes, which is what makes "the wiki
 * is a projection" a testable claim rather than a design intention.
 *
 * Deleted records are absent because the fold that produced `records` already
 * excluded them. There is no separate wiki deletion path, and therefore no
 * separate wiki deletion path to forget to run.
 */
export function buildWiki(
  records: readonly MemoryRecord[],
  events: readonly MemoryEvent[] = [],
): WikiProjection {
  const bySection = new Map<WikiSection, MemoryRecord[]>()
  for (const section of WIKI_SECTIONS) bySection.set(section, [])
  for (const record of ordered(records)) {
    // Forgotten records never reach here — the ledger's fold drops them — but
    // a superseded one is real history and belongs on its page, marked.
    bySection.get(sectionFor(record))?.push(record)
  }

  const pages: WikiPage[] = [rootIndex(bySection)]
  for (const section of WIKI_SECTIONS) {
    const inSection = bySection.get(section) ?? []
    pages.push(sectionIndex(section, inSection))
    for (const record of inSection) pages.push(pageFor(record))
  }
  pages.push(logPage(events))

  const sorted = [...pages].sort((left, right) => left.path.localeCompare(right.path))
  return { pages: sorted, digest: digestOf(sorted) }
}

/** Look one page up by path. */
export function pageAt(projection: WikiProjection, path: string): WikiPage | null {
  return projection.pages.find(page => page.path === path) ?? null
}

// ── user edits ──────────────────────────────────────────────────────────────

/** One line a person added or removed. */
export interface EditedLine {
  readonly text: string
  /** The memory id the line claimed, when it carried a marker. */
  readonly memoryId: string | null
}

/** What a hand edit proposes. */
export interface EditProposal {
  readonly path: string
  readonly added: readonly EditedLine[]
  readonly removed: readonly EditedLine[]
}

/** Read a provenance marker off a line. */
function markerOf(line: string): string | null {
  return /<!--\s*mem:([A-Za-z0-9_-]+)\s*-->/.exec(line)?.[1] ?? null
}

/** Statement lines only — headings, tables and blank lines are chrome. */
function statementLines(content: string): readonly string[] {
  return content.split(/\r?\n/).filter(line => line.trimStart().startsWith('- '))
}

/**
 * Diff a hand-edited page against what the generator produced.
 *
 * Line-level and deliberately crude. A structural Markdown diff would be more
 * precise and would also be a place for a clever edit to hide; comparing the
 * statement lines catches everything that could carry a claim.
 */
export function diffUserEdit(generated: WikiPage, edited: string): EditProposal {
  const before = new Set(statementLines(generated.content))
  const after = new Set(statementLines(edited))

  const added = [...after].filter(line => !before.has(line))
    .map(line => ({ text: line, memoryId: markerOf(line) }))
  const removed = [...before].filter(line => !after.has(line))
    .map(line => ({ text: line, memoryId: markerOf(line) }))

  return { path: generated.path, added, removed }
}

/** Why one edited line was refused. */
export interface EditRefusal {
  readonly line: string
  readonly reason: string
  readonly fix: string
}

/** What survived validation, and what did not. */
export interface ValidatedEdit {
  readonly path: string
  /** Lines that may become `user.edited` events. */
  readonly accepted: readonly EditedLine[]
  readonly refused: readonly EditRefusal[]
  /** Memory ids the edit asks to remove. */
  readonly removals: readonly string[]
}

/** Strip the provenance marker to get the claim itself. */
function claimOf(line: string): string {
  return line.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*-\s*/, '').trim()
}

/**
 * Validate a hand edit.
 *
 * Four refusals, each closing a way a file could write itself into authority:
 *
 * - **A forged marker.** A line carrying `mem:` for an id the page does not
 *   own is trying to attribute a new claim to an existing record.
 * - **High impact.** A permission, a standing grant, a weakened safeguard.
 *   Imported text is the weakest origin there is; it does not get to authorize
 *   anything, at any confidence.
 * - **A protected subject.** Health, beliefs, and the rest are things a person
 *   states about themselves. A file stating them is a file making a claim.
 * - **An empty claim.** A marker with no statement is a way to create a record
 *   with no content and then fill it later.
 *
 * Everything accepted becomes `imported` origin and `proposed` status. Nothing
 * a file says can make it `explicit_user`, because that origin means a person
 * did something, and reading a file is not a person doing something.
 */
export function validateUserEdit(
  proposal: EditProposal,
  generated: WikiPage,
): ValidatedEdit {
  const owned = new Set(generated.provenance)
  const accepted: EditedLine[] = []
  const refused: EditRefusal[] = []

  for (const line of proposal.added) {
    const claim = claimOf(line.text)

    if (line.memoryId !== null && !owned.has(line.memoryId)) {
      refused.push({
        line: line.text,
        reason: `The line claims memory ${line.memoryId}, which this page does not own.`,
        fix: 'Remove the provenance comment. A new statement is a new memory.',
      })
      continue
    }
    if (claim === '') {
      refused.push({
        line: line.text,
        reason: 'The line carries a provenance marker but states nothing.',
        fix: 'Write the statement, or delete the line.',
      })
      continue
    }
    if (isHighImpact(claim)) {
      refused.push({
        line: line.text,
        reason: 'Imported text cannot grant a permission or weaken a safeguard.',
        fix: 'If this is intended, state it yourself in the conversation.',
      })
      continue
    }
    if (isProtectedSubject(claim)) {
      refused.push({
        line: line.text,
        reason: 'Imported text cannot assert something about a protected subject.',
        fix: 'If this is about you, state it yourself in the conversation.',
      })
      continue
    }
    accepted.push({ text: claim, memoryId: line.memoryId })
  }

  return {
    path: proposal.path,
    accepted,
    refused,
    removals: proposal.removed
      .map(line => line.memoryId)
      .filter((id): id is string => id !== null),
  }
}

/** A candidate the ledger may admit, produced from an accepted edit line. */
export interface ImportedCandidate {
  readonly kind: MemoryRecord['kind']
  readonly content: string
  readonly origin: 'imported'
  readonly subjectScope: MemoryRecord['subjectScope']
  readonly scopeId: string
  readonly confidence: number
  readonly sourceRefs: readonly string[]
}

/**
 * Turn accepted edit lines into ledger candidates.
 *
 * `imported` origin and a low confidence, always, whatever the file said. The
 * scope comes from the caller — the wiki knows which workspace it belongs to
 * and a file does not get to choose.
 */
export function toCandidates(
  edit: ValidatedEdit,
  scope: { readonly subjectScope: MemoryRecord['subjectScope']; readonly scopeId: string },
): readonly ImportedCandidate[] {
  const kind: MemoryRecord['kind'] = edit.path.startsWith('decisions/')
    ? 'decision'
    : edit.path.startsWith('lessons/')
      ? 'lesson'
      : edit.path.startsWith('failures/')
        ? 'failure'
        : 'fact'

  return edit.accepted.map(line => ({
    kind,
    content: line.text,
    origin: 'imported' as const,
    subjectScope: scope.subjectScope,
    scopeId: scope.scopeId,
    // Not a number the file chose. An imported claim starts weak and earns its
    // way up by a person confirming it.
    confidence: 0.3,
    sourceRefs: [`wiki:${edit.path}`],
  }))
}

/**
 * One line describing what a hand edit will actually do.
 *
 * Shown before the edit is applied. "3 accepted, 1 refused" is what stops a
 * person believing their file is now the state of the system.
 */
export function describeEdit(edit: ValidatedEdit): string {
  const parts = [
    `${String(edit.accepted.length)} statement(s) proposed`,
    `${String(edit.removals.length)} removal(s)`,
  ]
  if (edit.refused.length > 0) parts.push(`${String(edit.refused.length)} refused`)
  parts.push('the page will be regenerated from the ledger')
  return parts.join(' · ')
}
