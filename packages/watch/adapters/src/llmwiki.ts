/**
 * LLMWiki compatibility: five files in, five files out, no authority moved.
 *
 * LLMWiki's shape — raw, wiki, citations, index, log — is a good one, and
 * being able to read and write it means a workspace is not trapped here. That
 * is the whole reason this adapter exists, and it is optional in both
 * directions: nothing in Watch requires it, and nothing about importing a
 * bundle makes LLMWiki the authority for anything.
 *
 * The asymmetry is deliberate and is the only interesting thing in the module.
 *
 * **Export is lossless about provenance and lossy about nothing else.** Every
 * exported statement carries its memory id, and `citations` carries the
 * evidence refs, so a bundle that leaves here can be read by something else
 * without the reader having to trust a sentence with no source.
 *
 * **Import is lossy on purpose.** Everything imported arrives as `imported`
 * origin at low confidence, whatever the bundle claims. A bundle that says a
 * statement is `explicit_user`, or high confidence, or already verified, is a
 * bundle making claims about a person it has never met. Those fields are read
 * and discarded rather than trusted, and the discarding is tested with a
 * bundle that asserts all of them at once.
 *
 * @module @watchskill/dsh-adapters/llmwiki
 */

import type { MemoryEvent, MemoryRecord } from '@watchskill/dsh-memory'
import { isHighImpact, isProtectedSubject } from '@watchskill/dsh-memory'

/** The five files an LLMWiki bundle carries. */
export interface LlmWikiBundle {
  /** Statements as they were captured, one per line, with provenance markers. */
  readonly raw: string
  /** The readable pages. */
  readonly wiki: string
  /** Evidence references, one per line. */
  readonly citations: string
  /** What is in the bundle, by kind. */
  readonly index: string
  /** What happened, by id and kind. Never content. */
  readonly log: string
}

/** One statement, as the bundle format carries it. */
export interface LlmWikiStatement {
  readonly id: string
  readonly kind: string
  readonly text: string
  /** What the bundle claims. Read, reported, and never trusted on import. */
  readonly claimedOrigin: string | null
  readonly claimedConfidence: number | null
  readonly evidenceRefs: readonly string[]
}

/** Serialize one statement line. */
function statementLine(record: MemoryRecord): string {
  const refs = record.evidenceRefs.length === 0 ? '' : ` refs=${record.evidenceRefs.join(',')}`
  return `[${record.memoryId}] (${record.kind}) origin=${record.origin} `
    + `confidence=${record.confidence.toFixed(2)}${refs} :: ${record.content.replace(/\r?\n/g, ' ')}`
}

/** Parse one statement line back. */
export function parseStatement(line: string): LlmWikiStatement | null {
  const match = /^\[([^\]]+)\]\s*\(([^)]*)\)\s*(.*?)::\s*(.*)$/.exec(line.trim())
  if (match === null) return null
  const [, id, kind, attributes, text] = match
  const origin = /origin=([A-Za-z_]+)/.exec(attributes ?? '')?.[1] ?? null
  const confidence = /confidence=([0-9.]+)/.exec(attributes ?? '')?.[1]
  const refs = /refs=([^\s]+)/.exec(attributes ?? '')?.[1]
  return {
    id: id ?? '',
    kind: kind ?? '',
    text: (text ?? '').trim(),
    claimedOrigin: origin,
    claimedConfidence: confidence === undefined ? null : Number(confidence),
    evidenceRefs: refs === undefined ? [] : refs.split(',').filter(ref => ref !== ''),
  }
}

/** Records in a stable order, so a bundle is byte-reproducible. */
function ordered(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  return [...records].sort((left, right) => left.memoryId.localeCompare(right.memoryId))
}

/**
 * Export a bundle.
 *
 * Deterministic: the same records and events produce the same five files, so
 * two exports of an unchanged workspace are identical and a diff between them
 * is a real change rather than a reordering.
 */
export function toLlmWiki(
  records: readonly MemoryRecord[],
  events: readonly MemoryEvent[] = [],
): LlmWikiBundle {
  const sorted = ordered(records)

  const raw = sorted.map(statementLine).join('\n')

  const byKind = new Map<string, MemoryRecord[]>()
  for (const record of sorted) {
    const bucket = byKind.get(record.kind) ?? []
    bucket.push(record)
    byKind.set(record.kind, bucket)
  }

  const wiki = [...byKind.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([kind, bucket]) => [
      `## ${kind}`,
      '',
      ...bucket.map(record => `- ${record.content.replace(/\r?\n/g, ' ')} ^${record.memoryId}`),
      '',
    ])
    .join('\n')

  const citations = sorted
    .filter(record => record.evidenceRefs.length > 0 || record.sourceRefs.length > 0)
    .map(record => `${record.memoryId} :: ${[...record.evidenceRefs, ...record.sourceRefs].join(',')}`)
    .join('\n')

  const index = [
    '| kind | count |',
    '|---|---:|',
    ...[...byKind.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, bucket]) => `| ${kind} | ${String(bucket.length)} |`),
  ].join('\n')

  // Ids, kinds, actors, timestamps. Never content — a log that reproduced what
  // was forgotten, in the entry recording that it was forgotten, is not a
  // deletion, and an export is exactly where that mistake escapes the product.
  const log = events
    .map(event => `${event.at} ${event.kind} ${event.actor} ${event.memoryId}`)
    .join('\n')

  return { raw, wiki, citations, index, log }
}

/** Why an imported statement was refused. */
export interface ImportRefusal {
  readonly statement: LlmWikiStatement
  readonly reason: string
}

/** A candidate the ledger may consider, produced from an imported statement. */
export interface ImportedStatement {
  readonly kind: MemoryRecord['kind']
  readonly content: string
  readonly origin: 'imported'
  readonly confidence: number
  readonly sourceRefs: readonly string[]
  readonly evidenceRefs: readonly string[]
  /** What the bundle claimed, kept for the review UI. Never acted on. */
  readonly claimed: { readonly origin: string | null; readonly confidence: number | null }
}

/** The outcome of reading a bundle. */
export interface ImportResult {
  readonly accepted: readonly ImportedStatement[]
  readonly refused: readonly ImportRefusal[]
  /** One line for the import dialog. */
  readonly summary: string
}

/** Kinds this adapter recognizes; anything else becomes a plain fact. */
const KNOWN_KINDS = new Set<MemoryRecord['kind']>([
  'preference', 'fact', 'episode', 'decision', 'lesson', 'procedure', 'failure',
])

/** Coerce a claimed kind into one the ledger knows. */
function kindOf(claimed: string): MemoryRecord['kind'] {
  return KNOWN_KINDS.has(claimed as MemoryRecord['kind'])
    ? claimed as MemoryRecord['kind']
    : 'fact'
}

/**
 * Read a bundle.
 *
 * Every accepted statement comes back as `imported` at a fixed low confidence.
 * The claimed origin and confidence travel alongside, so a review surface can
 * show "this bundle says you stated it" without the ledger acting on it —
 * which is the difference between reporting a claim and believing one.
 *
 * The refusals are the same two the wiki import uses, for the same reason: a
 * bundle is a file, and a file that could grant a permission or assert
 * something about a protected subject is a file that writes itself into
 * authority.
 */
export function fromLlmWiki(bundle: LlmWikiBundle): ImportResult {
  const accepted: ImportedStatement[] = []
  const refused: ImportRefusal[] = []

  for (const line of bundle.raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const statement = parseStatement(line)
    if (statement === null) {
      refused.push({
        statement: { id: '', kind: '', text: line, claimedOrigin: null, claimedConfidence: null, evidenceRefs: [] },
        reason: 'The line is not in the bundle statement format.',
      })
      continue
    }
    if (statement.text === '') {
      refused.push({ statement, reason: 'The statement is empty.' })
      continue
    }
    if (isHighImpact(statement.text)) {
      refused.push({
        statement,
        reason: 'An imported statement cannot grant a permission or weaken a safeguard.',
      })
      continue
    }
    if (isProtectedSubject(statement.text)) {
      refused.push({
        statement,
        reason: 'An imported statement cannot assert something about a protected subject.',
      })
      continue
    }

    accepted.push({
      kind: kindOf(statement.kind),
      content: statement.text,
      // Fixed, whatever the bundle said. A file claiming a person stated
      // something is a file making a claim about a person it never met.
      origin: 'imported',
      confidence: 0.3,
      sourceRefs: ['llmwiki:import'],
      evidenceRefs: statement.evidenceRefs,
      claimed: { origin: statement.claimedOrigin, confidence: statement.claimedConfidence },
    })
  }

  const summary = `${String(accepted.length)} statement(s) proposed, `
    + `${String(refused.length)} refused. `
    + 'Everything imported arrives unconfirmed, at the weakest origin.'

  return { accepted, refused, summary }
}

/**
 * Whether a round trip preserved what it should.
 *
 * Checks content and evidence refs, and deliberately does *not* check origin or
 * confidence — those are supposed to be lost on import, and a round-trip test
 * that required them to survive would be a test demanding the vulnerability.
 */
export function roundTripPreservesContent(
  original: readonly MemoryRecord[],
  imported: readonly ImportedStatement[],
): boolean {
  const wanted = new Map(original.map(record => [record.content, record.evidenceRefs.join(',')]))
  for (const statement of imported) {
    const refs = wanted.get(statement.content)
    if (refs === undefined) return false
    if (refs !== statement.evidenceRefs.join(',')) return false
  }
  return wanted.size === new Set(imported.map(statement => statement.content)).size
}

/** What this adapter can claim. Optional, and never an authority. */
export function llmWikiAvailability(): {
  readonly adapterId: string
  readonly optional: true
  readonly proven: readonly string[]
  readonly notMachineTested: readonly string[]
} {
  return {
    adapterId: 'adapter.llmwiki',
    optional: true,
    proven: [
      'Export of all five files, deterministically.',
      'Import of a bundle as proposals, at imported origin.',
      'Round trip preserving content and evidence refs.',
      'Refusal of a hostile bundle: permissions, safeguards and protected subjects.',
    ],
    notMachineTested: [
      'Interoperability with a specific LLMWiki release. The format here is written '
      + 'against its documented file set, and no LLMWiki installation was available '
      + 'to exchange a bundle with.',
    ],
  }
}
