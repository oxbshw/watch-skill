/**
 * What one turn is allowed to spend, and what it has spent so far.
 *
 * **The run this is measured against.** One user turn in the owner evaluation
 * produced 47 model rounds, 76 tool calls, three subagents, nine minutes and
 * fifty-four seconds, and roughly 2.97M tokens of processed context — 90,497
 * uncached input, 2,877,440 cache reads, 35,405 output. A 97% cache hit rate
 * made it cheap, which is exactly why nobody stopped it: the price signal that
 * would normally end a runaway had been optimised away, and the turn simply
 * kept going.
 *
 * Three of those numbers were avoidable and one was not. The subagents all
 * failed for one fixable reason and the parent redid their work; that is fixed
 * elsewhere. What is left is the shape of the problem: nothing in the Host had
 * an opinion about how long a turn may run, so the only limit was the model
 * deciding it was finished.
 *
 * **Where the defaults come from.** Above, and deliberately. Every hard limit
 * sits well clear of that run, because the point is to catch a turn that has
 * stopped converging rather than to shape ordinary work — a budget that fires
 * during normal use teaches people to raise it, and then it is not a budget.
 * The soft warnings sit at roughly the observed run, so the shape it had
 * becomes visible while it is happening rather than in a post-mortem.
 *
 * **Cache reads are counted and never hidden.** They are the cheapest tokens
 * and the ones that make a runaway invisible: 2.88M of them is still 2.88M
 * tokens of context processed, and a status bar that showed only billed input
 * would have reported this turn as small. Counted separately, shown
 * separately, and included in the total.
 *
 * **How a hard limit stops.** By refusing the next model request, the same way
 * the routing guard refuses one — a rejecting iterable at the `llm/stream`
 * waterfall. Nothing is killed mid-write, no tool is interrupted, the
 * trajectory stays consistent, and the turn ends with a typed reason rather
 * than a truncation nobody can explain.
 *
 * @module @deepwatch/dsh-technology/budget
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'

/** The service name everything reaches this by. */
export const BUDGET_SERVICE = 'watchBudget'

/** One dimension a turn is measured in. */
export type BudgetDimension =
  | 'modelRounds'
  | 'toolCalls'
  | 'subagents'
  | 'uncachedInputTokens'
  | 'cacheReadTokens'
  | 'outputTokens'
  | 'wallClockMs'

/** A soft threshold and a hard one, for one dimension. */
export interface Limit {
  readonly warn: number
  readonly hard: number
}

/**
 * The defaults, and why each one is where it is.
 *
 * Every `hard` is above the measured pathological run; every `warn` is near it.
 * A deployment may raise or lower these per profile, which is the honest way to
 * disagree with a default — unlike removing the check.
 */
export const DEFAULT_LIMITS: Readonly<Record<BudgetDimension, Limit>> = {
  /** Observed 47. A turn still proposing steps at 60 has stopped converging. */
  modelRounds: { warn: 25, hard: 60 },
  /** Observed 76. */
  toolCalls: { warn: 50, hard: 150 },
  /** Observed 3, all of which failed. Ten is a delegation loop, not a plan. */
  subagents: { warn: 3, hard: 10 },
  /** Observed 90,497. */
  uncachedInputTokens: { warn: 100_000, hard: 400_000 },
  /** Observed 2,877,440. The cheap ones, counted anyway. */
  cacheReadTokens: { warn: 3_000_000, hard: 12_000_000 },
  /** Observed 35,405. */
  outputTokens: { warn: 40_000, hard: 150_000 },
  /** Observed 9m54s. Twenty minutes of one turn is a turn nobody is watching. */
  wallClockMs: { warn: 300_000, hard: 1_200_000 },
}

/** What a profile may override. */
export interface Config {
  readonly enforce: boolean
  readonly limits: Partial<Record<BudgetDimension, Partial<Limit>>>
}

/** Schemastery validation for the budget policy. */
export const Config: s<Config> = s.object({
  enforce: s.boolean().default(true),
  limits: s.dict(s.object({ warn: s.number(), hard: s.number() })).default({}),
})

/** Everything spent so far in one turn. */
export interface Spend {
  readonly modelRounds: number
  readonly toolCalls: number
  readonly subagents: number
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly wallClockMs: number
  /**
   * Everything the model actually processed.
   *
   * Uncached input plus cache reads plus output. Not a billing figure — the
   * point is the size of the thing being pushed through the model, which is
   * what a 97% cache hit rate hides.
   */
  readonly totalContextTokens: number
}

/** A dimension that crossed a threshold. */
export interface BudgetBreach {
  readonly dimension: BudgetDimension
  readonly level: 'warn' | 'hard'
  readonly spent: number
  readonly limit: number
}

/** How a turn ended, where the budget had an opinion about it. */
export type BudgetOutcome = 'within_budget' | 'warned' | 'stopped'

/** The error a refused request carries when a hard limit is reached. */
export class BudgetExceededError extends Error {
  readonly dimension: BudgetDimension
  readonly spent: number
  readonly limit: number

  constructor(breach: BudgetBreach) {
    super(
      `this turn reached its ${breach.dimension} limit (${String(breach.spent)} of `
      + `${String(breach.limit)}) and was stopped before another model request. `
      + 'Nothing was interrupted mid-action; start a new turn, or raise the limit for this '
      + 'profile if the work genuinely needs it.')
    this.name = 'BudgetExceededError'
    this.dimension = breach.dimension
    this.spent = breach.spent
    this.limit = breach.limit
  }
}

/** An empty ledger. */
function emptySpend(): Spend {
  return {
    modelRounds: 0,
    toolCalls: 0,
    subagents: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    wallClockMs: 0,
    totalContextTokens: 0,
  }
}

/** The whole limit table, with a profile's overrides folded in. */
export function resolveLimits(
  overrides: Config['limits'] | undefined,
): Readonly<Record<BudgetDimension, Limit>> {
  // Defaulted here rather than trusted from the schema. A composed row supplies
  // the keys it cares about — `{ enforce: true }` and nothing else — and the
  // loader hands that object through as it stands, so a plugin that assumed a
  // schema default had been applied threw on the profile's first boot and took
  // the whole tree down with it. A plugin reads its own config defensively or
  // it does not survive being configured partially.
  const supplied = overrides ?? {}
  const out: Record<string, Limit> = {}
  for (const [dimension, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const over = supplied[dimension as BudgetDimension]
    out[dimension] = {
      warn: over?.warn ?? fallback.warn,
      hard: over?.hard ?? fallback.hard,
    }
  }
  return out as Record<BudgetDimension, Limit>
}

/** Every dimension that has crossed a threshold, worst level first. */
export function breachesIn(
  spend: Spend, limits: Readonly<Record<BudgetDimension, Limit>>,
): readonly BudgetBreach[] {
  const found: BudgetBreach[] = []
  for (const dimension of Object.keys(limits) as BudgetDimension[]) {
    const spent = spend[dimension]
    const limit = limits[dimension]
    if (spent >= limit.hard) found.push({ dimension, level: 'hard', spent, limit: limit.hard })
    else if (spent >= limit.warn) found.push({ dimension, level: 'warn', spent, limit: limit.warn })
  }
  return found.sort((a, b) => (a.level === b.level ? 0 : a.level === 'hard' ? -1 : 1))
}

/**
 * The Host's per-turn accounting.
 *
 * One instance, mounted as its own row. The counters live per turn because
 * that is the unit a person asked for and the unit a limit should apply to;
 * a session-wide budget would punish a long conversation for being long.
 */
export class WatchBudget extends Service {
  private readonly limits: Readonly<Record<BudgetDimension, Limit>>
  private readonly enforce: boolean
  /** Live counters by turn id. */
  private readonly turns = new Map<string, { spend: Spend, startedAt: number }>()
  /** Dimensions already warned about, so one threshold is announced once. */
  private readonly warned = new Map<string, Set<BudgetDimension>>()
  private stopped = new Map<string, BudgetBreach>()

  constructor(ctx: Context, config: Partial<Config> | undefined) {
    super(ctx, BUDGET_SERVICE)
    this.limits = resolveLimits(config?.limits)
    // Enforcing unless a composition says otherwise: an absent flag is not a
    // request to stop enforcing.
    this.enforce = config?.enforce !== false
  }

  /** Begin counting for one turn, if it is not already counted. */
  open(turnId: string): void {
    if (this.turns.has(turnId)) return
    this.turns.set(turnId, { spend: emptySpend(), startedAt: Date.now() })
    this.warned.set(turnId, new Set())
  }

  /** Stop counting, keeping the final figures for the surfaces. */
  close(turnId: string): void {
    const held = this.turns.get(turnId)
    if (held === undefined) return
    this.turns.set(turnId, { ...held, spend: this.spendFor(turnId) })
  }

  /** Everything spent in one turn, with the clock read live. */
  spendFor(turnId: string): Spend {
    const held = this.turns.get(turnId)
    if (held === undefined) return emptySpend()
    const wallClockMs = Date.now() - held.startedAt
    const spend = held.spend
    return {
      ...spend,
      wallClockMs,
      totalContextTokens:
        spend.uncachedInputTokens + spend.cacheReadTokens + spend.outputTokens,
    }
  }

  /** Add to one dimension, and announce anything it crosses. */
  add(turnId: string, dimension: Exclude<BudgetDimension, 'wallClockMs'>, amount: number): void {
    const held = this.turns.get(turnId)
    if (held === undefined || amount <= 0) return
    this.turns.set(turnId, {
      ...held,
      spend: { ...held.spend, [dimension]: held.spend[dimension] + amount },
    })
    this.announce(turnId)
  }

  /** Record a model call's token usage, in the disjoint counts upstream reports. */
  addUsage(
    turnId: string,
    usage: {
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    },
  ): void {
    const held = this.turns.get(turnId)
    if (held === undefined) return
    this.turns.set(turnId, {
      ...held,
      spend: {
        ...held.spend,
        uncachedInputTokens: held.spend.uncachedInputTokens + (usage.inputTokens ?? 0),
        outputTokens: held.spend.outputTokens + (usage.outputTokens ?? 0),
        cacheReadTokens: held.spend.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: held.spend.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      },
    })
    this.announce(turnId)
  }

  /** Emit a warning the first time each dimension crosses its soft threshold. */
  private announce(turnId: string): void {
    const events = this.ctx as unknown as { emit(name: string, ...args: unknown[]): void }
    const seen = this.warned.get(turnId) ?? new Set<BudgetDimension>()
    for (const breach of breachesIn(this.spendFor(turnId), this.limits)) {
      if (breach.level !== 'warn' || seen.has(breach.dimension)) continue
      seen.add(breach.dimension)
      events.emit('watch/budget-warning', { turnId, ...breach })
    }
    this.warned.set(turnId, seen)
  }

  /**
   * The hard breach that should stop the next model request, if there is one.
   *
   * Read rather than acted on here: the refusal belongs at the request
   * boundary, where declining is the whole of the effect.
   */
  hardBreach(turnId: string): BudgetBreach | null {
    if (!this.enforce) return null
    const already = this.stopped.get(turnId)
    if (already !== undefined) return already
    const hard = breachesIn(this.spendFor(turnId), this.limits)
      .find(breach => breach.level === 'hard')
    if (hard === undefined) return null
    this.stopped.set(turnId, hard)
    const events = this.ctx as unknown as { emit(name: string, ...args: unknown[]): void }
    events.emit('watch/budget-stopped', { turnId, ...hard })
    return hard
  }

  /** How a turn stands, for the status bar. */
  outcomeFor(turnId: string): BudgetOutcome {
    if (this.stopped.has(turnId)) return 'stopped'
    return breachesIn(this.spendFor(turnId), this.limits).length > 0 ? 'warned' : 'within_budget'
  }

  /** The limits in force, so a surface can show a proportion rather than a number. */
  limitTable(): Readonly<Record<BudgetDimension, Limit>> {
    return this.limits
  }

  /** Every turn being counted. */
  turnIds(): readonly string[] {
    return [...this.turns.keys()]
  }

  /** Forget everything. Profile teardown. */
  clear(): void {
    this.turns.clear()
    this.warned.clear()
    this.stopped = new Map()
  }
}

/** The plugin's own name, so a composition can target the row. */
export const name = 'watch-budget'

/** The stream it counts, and refuses at. */
export const inject = ['llm']

/**
 * Mount the accounting and hang it off the events that already happen.
 */
export function apply(ctx: Context, config?: Partial<Config>): void {
  const budget = new WatchBudget(ctx, config)

  const link = ctx as unknown as {
    on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): void
  }
  const observe = ctx as unknown as {
    on(name: string, listener: (payload: unknown) => void): void
  }

  /** The turn a count belongs to. */
  const turnOf = (payload: unknown): string => {
    const record = (payload ?? {}) as { agent?: { id?: unknown }, turn?: unknown }
    const agent = typeof record.agent?.id === 'string' ? record.agent.id : 'agent'
    const turn = typeof record.turn === 'number' ? String(record.turn) : 'turn'
    return `${agent}#${turn}`
  }

  // A model round is a step the loop proposed. `agent/pre-step` is a waterfall,
  // so this hands back what it was given.
  ;(link as unknown as {
    on(
      name: 'agent/pre-step',
      listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
    ): void
  }).on('agent/pre-step', async (payload, next) => {
    const turnId = turnOf(payload)
    budget.open(turnId)
    budget.add(turnId, 'modelRounds', 1)
    return next()
  })

  observe.on('agent/turn-stopping', (payload) => { budget.close(turnOf(payload)) })
  observe.on('tools/result', (payload) => {
    for (const turnId of budget.turnIds()) budget.add(turnId, 'toolCalls', 1)
    void payload
  })
  observe.on('subagent/start', () => {
    for (const turnId of budget.turnIds()) budget.add(turnId, 'subagents', 1)
  })
  observe.on('agent/disposed', () => { budget.clear() })

  if (config?.enforce === false) return

  // The refusal, and the counting, at the one boundary every model request
  // passes through. `prepend` so a spent budget is not retried by a retry
  // listener sitting in front of this.
  ;(link as unknown as {
    on(
      name: 'llm/stream',
      listener: (
        options: unknown, next: () => Promise<AsyncIterable<unknown>>,
      ) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>,
      options?: { prepend?: boolean },
    ): void
  }).on('llm/stream', (_options, next) => {
    const turnId = budget.turnIds().at(-1) ?? null
    if (turnId !== null) {
      const breach = budget.hardBreach(turnId)
      if (breach !== null) {
        const error = new BudgetExceededError(breach)
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
            next: (): Promise<IteratorResult<never>> => Promise.reject(error),
          }),
        }
      }
    }
    // Counted as it streams, so a turn's figures are live rather than
    // reconstructed afterwards.
    return (async function* counted() {
      const inner = await next()
      for await (const chunk of inner) {
        const typed = chunk as { type?: unknown, usage?: Record<string, number> }
        if (typed.type === 'usage' && typed.usage !== undefined && turnId !== null) {
          budget.addUsage(turnId, typed.usage)
        }
        yield chunk
      }
    })()
  }, { prepend: true })
}

export default apply
