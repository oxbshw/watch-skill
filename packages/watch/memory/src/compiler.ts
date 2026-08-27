/**
 * The Context Compiler: what the agent is told, and why.
 *
 * The temptation with memory is to inject all of it and let the model sort it
 * out. That fails in three ways at once — it costs tokens on every turn, it
 * lets stale and disputed records act as instructions, and it makes
 * personalization unexplainable, because nobody can say which remembered thing
 * caused a given behavior.
 *
 * So this selects the smallest useful packet and records why each item is in
 * it. The inclusion trace is not diagnostics: it is what "Why remembered?"
 * shows a person, and what lets them correct the specific record that made the
 * agent behave the way it did.
 *
 * @module @watchskill/dsh-memory/compiler
 */

import type { MemoryRecord, ScopeContext } from './records.js'

/** One memory selected for a turn, with the reason it was selected. */
export interface ContextItem {
  readonly memoryId: string
  readonly content: string
  readonly kind: MemoryRecord['kind']
  readonly scope: MemoryRecord['subjectScope']
  readonly origin: MemoryRecord['origin']
  readonly confidence: number
  /** Roughly what this costs to include. */
  readonly tokenEstimate: number
  /** One sentence a person can read. Never empty. */
  readonly reason: string
}

/** What the compiler produced, and what it left out. */
export interface ContextPacket {
  readonly items: readonly ContextItem[]
  readonly tokenEstimate: number
  /** Records that were in scope and eligible but did not fit the budget. */
  readonly droppedForBudget: readonly string[]
  /**
   * True when personalization was skipped entirely.
   *
   * A hard budget must degrade to *no* memory rather than to an arbitrary
   * half of it: a packet trimmed at random is worse than none, because the
   * agent then acts on a partial picture nobody chose.
   */
  readonly fellBackToNone: boolean
}

/** What the compiler is allowed to spend and prefer. */
export interface CompileOptions {
  /** Hard ceiling. Nothing is included past it. */
  readonly tokenBudget: number
  /** Words in the current task, used to prefer what is relevant to it. */
  readonly task: string
  /** How many items may come from any one scope, so one does not crowd out. */
  readonly perScopeLimit: number
}

const DEFAULTS: CompileOptions = {
  tokenBudget: 600,
  task: '',
  perScopeLimit: 4,
}

/**
 * Estimate the token cost of a string.
 *
 * Four characters per token is the usual rough figure for Latin text and
 * over-counts for CJK, which is the safe direction: over-estimating stops
 * early, and under-estimating silently blows the budget the caller set.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** Scope precedence: the nearest scope to the work is the most relevant. */
const SCOPE_WEIGHT: Record<MemoryRecord['subjectScope'], number> = {
  session: 5,
  project: 4,
  workspace: 3,
  user: 2,
  agent: 1,
}

/** Origin precedence, mirroring the trust ordering in `records.ts`. */
const ORIGIN_WEIGHT: Record<MemoryRecord['origin'], number> = {
  explicit_user: 4,
  system: 3,
  observed: 2,
  inferred: 1,
  imported: 0,
}

/** Words worth matching on, lowercased and de-duplicated. */
function terms(text: string): ReadonlySet<string> {
  return new Set(
    text.toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length > 2),
  )
}

/** How much of the task's vocabulary a record shares. */
function relevance(record: MemoryRecord, taskTerms: ReadonlySet<string>): number {
  if (taskTerms.size === 0) return 0
  const recordTerms = terms(record.content)
  let shared = 0
  for (const term of recordTerms) if (taskTerms.has(term)) shared += 1
  return shared === 0 ? 0 : shared / Math.sqrt(recordTerms.size)
}

/** Why this record was included, in a sentence a person can read. */
function reasonFor(record: MemoryRecord, matched: boolean): string {
  const where = record.subjectScope === 'user'
    ? 'a preference you set'
    : `scoped to this ${record.subjectScope}`
  const how = record.origin === 'explicit_user'
    ? 'you told me directly'
    : record.origin === 'observed'
      ? 'observed from how you worked'
      : record.origin === 'imported'
        ? 'imported from a source you connected'
        : record.origin === 'system'
          ? 'set by this deployment'
          : `inferred, confidence ${record.confidence.toFixed(2)}`
  return matched
    ? `Relevant to this task — ${where}, ${how}.`
    : `${where.charAt(0).toUpperCase()}${where.slice(1)}, ${how}.`
}

/**
 * Choose the smallest useful set of memories for one turn.
 *
 * @param candidates - records already filtered to this scope and injectable.
 *   This function deliberately does not filter by scope itself: doing it in
 *   two places is how one of them eventually stops matching the other.
 */
export function compileContext(
  candidates: readonly MemoryRecord[],
  _scope: ScopeContext,
  options: Partial<CompileOptions> = {},
): ContextPacket {
  const resolved = { ...DEFAULTS, ...options }
  const taskTerms = terms(resolved.task)

  const scored = candidates.map(record => ({
    record,
    matched: relevance(record, taskTerms) > 0,
    score:
      SCOPE_WEIGHT[record.subjectScope] * 2
      + ORIGIN_WEIGHT[record.origin]
      + relevance(record, taskTerms) * 6
      + record.confidence,
  }))
  // Ties broken by id so the same inputs always produce the same packet;
  // a context that reshuffles between runs makes replay meaningless.
  scored.sort((a, b) =>
    b.score - a.score || a.record.memoryId.localeCompare(b.record.memoryId))

  const items: ContextItem[] = []
  const dropped: string[] = []
  const perScope = new Map<string, number>()
  let spent = 0

  for (const { record, matched } of scored) {
    const used = perScope.get(record.subjectScope) ?? 0
    if (used >= resolved.perScopeLimit) {
      // Diversity, not scarcity: without this, a workspace with forty project
      // notes would push out every personal preference the person actually set.
      dropped.push(record.memoryId)
      continue
    }
    const reason = reasonFor(record, matched)
    const cost = estimateTokens(record.content) + estimateTokens(reason)
    if (spent + cost > resolved.tokenBudget) {
      dropped.push(record.memoryId)
      continue
    }
    items.push({
      memoryId: record.memoryId,
      content: record.content,
      kind: record.kind,
      scope: record.subjectScope,
      origin: record.origin,
      confidence: record.confidence,
      tokenEstimate: cost,
      reason,
    })
    perScope.set(record.subjectScope, used + 1)
    spent += cost
  }

  return {
    items,
    tokenEstimate: spent,
    droppedForBudget: dropped,
    fellBackToNone: items.length === 0 && candidates.length > 0,
  }
}

/**
 * Render a packet for a system-prompt section.
 *
 * The framing matters as much as the content. These are things the agent knows
 * about someone, and they are labelled that way — including the reminder that
 * they are preferences rather than permissions, because the one failure mode
 * worth engineering against is a remembered preference being read as
 * authorization.
 */
export function renderContext(packet: ContextPacket): string {
  if (packet.items.length === 0) return ''
  const lines = [
    '## What I remember about working with you',
    '',
    'These are preferences and context, not permissions. They never authorize an',
    'action on their own, and the person can correct or remove any of them.',
    '',
  ]
  for (const item of packet.items) {
    lines.push(`- ${item.content}`)
    lines.push(`  _(${item.reason} · \`${item.memoryId}\`)_`)
  }
  return lines.join('\n')
}
