/**
 * Giving a child agent the route its parent is already using.
 *
 * **What happened.** The owner evaluation spawned three subagents. All three
 * ended immediately with the same message:
 *
 *     has no provider/model: set AgentOptions.provider and AgentOptions.model
 *     or supply both via the agent/request waterfall
 *
 * The UI showed "3 subagents". The parent described them as "not completed"
 * and did the work again itself, which is the expensive half: three ghost
 * sessions, three failures nobody could open, and a parent that spent the rest
 * of the turn duplicating work it had already delegated.
 *
 * **Why upstream is not at fault.** `resolveChildAgentOptions` inherits
 * `parent.options.provider` and `parent.options.model`. That is correct and it
 * works — for a deployment that puts its route in `AgentOptions`. DeepWatch
 * does not: a route here comes from the binding a person made, resolved per
 * request. So the parent's own `options.provider` is undefined, the child
 * inherits undefined, and the child throws on its first step. The parent never
 * noticed because the parent's route arrives by a different path.
 *
 * The fix is the one upstream's own error message names. `agent/request` is a
 * waterfall over the call configuration, and it is where a deployment that
 * resolves routes dynamically is supposed to supply them. Filling it there
 * fixes parent and child with one rule, because it is the same rule.
 *
 * **Three ghosts, one cause.** A child that cannot be routed should not become
 * a session. Preflight answers "is there a usable route" before anything is
 * created, so the parent gets a typed error it can act on instead of a child it
 * has to wait for and then explain. And the same missing configuration is
 * refused the same way every time it is asked about, so one broken setting
 * produces one refusal rather than a session per attempt.
 *
 * **What a child may spend.** A child runs inside its parent's turn and
 * borrows its authorisation. It gets a scope of its own so its calls are
 * attributable, and that scope closes when the parent's turn closes — a child
 * that outlived its parent's authorisation would be exactly the idle
 * background caller the routing guard exists to refuse.
 *
 * @module @deepwatch/dsh-technology/delegation
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { BINDINGS_NAMESPACE, readBindings } from '@deepwatch/dsh-contracts'
import type { WatchBindings } from '@deepwatch/dsh-contracts'
import { PROVENANCE_SERVICE } from './provenance.js'
import type { WatchProvenance } from './provenance.js'

/** The service name everything reaches this by. */
export const DELEGATION_SERVICE = 'watchDelegation'

/** The settings namespace the Harness keeps the resolved selection in. */
const SELECTION_NAMESPACE = 'agent-default-model'

/** The role a delegated child runs under, when nothing names another. */
export const DELEGATION_ROLE = 'agent_model'

/** One route, or the reason there is not one. */
export type RouteResolution =
  | { readonly ok: true, readonly provider: string, readonly model: string }
  | { readonly ok: false, readonly reason: string, readonly code: DelegationRefusalCode }

/** Why delegation was refused, in a form a caller can branch on. */
export type DelegationRefusalCode =
  /** No role is bound, so there is no route to inherit. */
  | 'no_binding'
  /** A route is bound but this Host has not proved it. */
  | 'route_unproved'
  /** The settings could not be read at all. */
  | 'settings_unreadable'

/** The minimal settings surface this reads. */
interface SettingsLike {
  section(ns: string): Record<string, unknown> | undefined
}

/**
 * The route a child should inherit, read from the same decisions the parent
 * uses.
 *
 * Two sources, in order: the binding a person made for the delegation role, and
 * the resolved selection the Harness keeps. The binding wins because it is the
 * decision; the selection is its projection, and a projection that disagreed
 * would mean something had gone wrong that a fallback should not paper over.
 */
export function resolveRoute(
  settings: SettingsLike | undefined, provenance: WatchProvenance | undefined,
): RouteResolution {
  if (settings === undefined) {
    return {
      ok: false, code: 'settings_unreadable',
      reason: 'this Host cannot read its own settings, so it cannot say which route a child '
        + 'would use',
    }
  }
  let bindings: WatchBindings
  let selection: { provider?: unknown, model?: unknown }
  try {
    bindings = readBindings(settings.section(BINDINGS_NAMESPACE))
    selection = settings.section(SELECTION_NAMESPACE) ?? {}
  } catch {
    return {
      ok: false, code: 'settings_unreadable',
      reason: 'the stored routing decisions could not be read',
    }
  }

  const bound = bindings.roles[DELEGATION_ROLE]
  const provider = bound?.provider
    ?? (typeof selection.provider === 'string' ? selection.provider : '')
  const model = bound?.model
    ?? (typeof selection.model === 'string' ? selection.model : '')

  if (provider === '' || model === '') {
    return {
      ok: false, code: 'no_binding',
      reason: 'no model is bound to this profile, so a subagent has no route to inherit. '
        + 'Bind a model on the Models screen and run the provider test first.',
    }
  }
  // A child spends real requests. It may only use a route this Host has
  // actually proved, for the same reason the parent may only use one.
  if (provenance !== undefined && !provenance.isReady(provider, model)) {
    return {
      ok: false, code: 'route_unproved',
      reason: `${provider}/${model} is bound but this Host has not proved it, so nothing may `
        + 'be sent to it yet. Run the provider test.',
    }
  }
  return { ok: true, provider, model }
}

/**
 * How many times one unchanged failure may create work before it stops.
 *
 * One. The evaluation spawned three children that failed identically, and the
 * second and third told nobody anything the first had not. A repeated attempt
 * at an unchanged configuration is not resilience, it is three ghosts.
 */
export const IDENTICAL_FAILURE_LIMIT = 1

/** What a delegation attempt did. */
export interface DelegationAttempt {
  readonly at: string
  readonly parentTurnId: string | null
  readonly childId: string | null
  readonly outcome: 'permitted' | 'refused' | 'suppressed'
  readonly code: DelegationRefusalCode | null
  readonly reason: string | null
}

/**
 * The Host's account of delegation: what a child may use, and what happened.
 *
 * Mounted once. Everything that needs a route or a preflight injects it, so
 * there is one answer to "may this delegate" per Host.
 */
export class WatchDelegation extends Service {
  /** Refusals already reported, by their code, so an unchanged one is not repeated. */
  private readonly reported = new Map<string, number>()
  private readonly attempts: DelegationAttempt[] = []
  /** Children currently running, by child id, with the parent turn they belong to. */
  private readonly children = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, DELEGATION_SERVICE)
  }

  /** The route a child would inherit right now. */
  route(): RouteResolution {
    return resolveRoute(
      this.ctx.get?.('settings') as SettingsLike | undefined,
      this.ctx.get?.(PROVENANCE_SERVICE) as WatchProvenance | undefined,
    )
  }

  /**
   * Whether a child may be created, answered before anything is created.
   *
   * The circuit breaker lives here rather than around the spawn: a caller that
   * asks twice about the same broken configuration gets the same typed answer
   * both times, and only the first one is worth a new session's worth of noise.
   */
  preflight(): RouteResolution & { readonly suppressed: boolean } {
    const resolution = this.route()
    if (resolution.ok) {
      this.attempts.push({
        at: new Date().toISOString(),
        parentTurnId: this.parentTurn(),
        childId: null,
        outcome: 'permitted',
        code: null,
        reason: null,
      })
      return { ...resolution, suppressed: false }
    }
    const seen = (this.reported.get(resolution.code) ?? 0) + 1
    this.reported.set(resolution.code, seen)
    const suppressed = seen > IDENTICAL_FAILURE_LIMIT
    this.attempts.push({
      at: new Date().toISOString(),
      parentTurnId: this.parentTurn(),
      childId: null,
      outcome: suppressed ? 'suppressed' : 'refused',
      code: resolution.code,
      reason: resolution.reason,
    })
    return { ...resolution, suppressed }
  }

  /** A configuration changed, so the same failure is worth reporting again. */
  resetBreaker(): void {
    this.reported.clear()
  }

  /** The turn a child would belong to. */
  private parentTurn(): string | null {
    const provenance = this.ctx.get?.(PROVENANCE_SERVICE) as WatchProvenance | undefined
    return provenance?.activeTurn() ?? null
  }

  /**
   * A child started. Open a scope for it inside the parent's turn.
   *
   * Its calls are attributable to it, and its authority is the parent's — which
   * is what makes closing the parent's turn close the child's too.
   */
  childStarted(childId: string): void {
    const parent = this.parentTurn()
    if (parent === null) return
    this.children.set(childId, parent)
    const provenance = this.ctx.get?.(PROVENANCE_SERVICE) as WatchProvenance | undefined
    provenance?.openTurn(parent)
  }

  /** A child ended. Give back the scope it borrowed. */
  childEnded(childId: string): void {
    const parent = this.children.get(childId)
    if (parent === undefined) return
    this.children.delete(childId)
    const provenance = this.ctx.get?.(PROVENANCE_SERVICE) as WatchProvenance | undefined
    provenance?.closeTurn(parent)
  }

  /** How many children are running. */
  runningCount(): number {
    return this.children.size
  }

  /** Every attempt, for the surfaces that must show real counts. */
  history(): readonly DelegationAttempt[] {
    return this.attempts
  }

  /** Forget everything. Profile teardown. */
  clear(): void {
    this.reported.clear()
    this.attempts.length = 0
    this.children.clear()
  }
}

/** The plugin's own name, so a composition can target the row. */
export const name = 'watch-delegation'

/** The provenance service decides whether a route is proved. */
export const inject = [PROVENANCE_SERVICE]

/**
 * Mount delegation, and supply the route where upstream asks for it.
 */
export function apply(ctx: Context): void {
  const delegation = new WatchDelegation(ctx)

  const link = ctx as unknown as {
    on(name: string, listener: (...args: never[]) => unknown): void
  }
  const observe = ctx as unknown as {
    on(name: string, listener: (payload: unknown) => void): void
  }

  // `agent/request` is a waterfall over the call configuration, and upstream's
  // own error names it as where a deployment supplies a route it resolves
  // dynamically. Filling it here fixes the parent and the child with one rule,
  // because for this product it is the same rule.
  ;(link as unknown as {
    on(
      name: 'agent/request',
      listener: (
        payload: unknown, next: () => Promise<{ provider?: string, model?: string }>,
      ) => Promise<{ provider?: string, model?: string }>,
    ): void
  }).on('agent/request', async (_payload, next) => {
    const proposed = await next()
    // Only when nothing upstream of this supplied one. An explicit route on the
    // request is somebody's decision and is not ours to replace.
    if (proposed.provider !== undefined && proposed.provider !== ''
      && proposed.model !== undefined && proposed.model !== '') return proposed
    const route = delegation.route()
    if (!route.ok) return proposed
    return { ...proposed, provider: route.provider, model: route.model }
  })

  /** The child id an emit carries, whichever shape it arrives in. */
  const childIdOf = (info: unknown): string | null => {
    const child = (info as { child?: { id?: unknown } } | undefined)?.child
    return typeof child?.id === 'string' ? child.id : null
  }

  observe.on('subagent/start', (info) => {
    const id = childIdOf(info)
    if (id !== null) delegation.childStarted(id)
  })

  observe.on('subagent/end', (info) => {
    const id = childIdOf(info)
    if (id !== null) delegation.childEnded(id)
  })

  // A settings write may have fixed the very thing that was refused, so the
  // same failure becomes worth reporting again.
  observe.on('settings/document-updated', () => { delegation.resetBreaker() })

  observe.on('agent/disposed', () => { delegation.clear() })
}

export default apply
