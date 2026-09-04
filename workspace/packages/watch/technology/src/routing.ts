/**
 * The Host's own answer to "may this request go out?", asked before it does.
 *
 * A composer that refuses to submit is an affordance. It is the right thing to
 * build and it is not enforcement: it lives in a browser tab, it can be stale,
 * and the RPC it declines to call stays callable. Upstream says so in as many
 * words — *"This is an affordance, not enforcement: the Host refuses a prompt
 * it cannot route regardless of what any client disables."*
 *
 * So this is the other half. It runs in the Host, it reads the same stored
 * decisions the screens write, and it refuses a model request whose route
 * nobody in this profile chose. A tab holding a selection from before a
 * binding changed, or a caller that set a selection directly and skipped the
 * screens entirely, arrives here and is stopped.
 *
 * **Where this sits, exactly, and what that costs.**
 *
 * There are two places a request can be stopped, and this distribution uses
 * both because neither is sufficient alone:
 *
 *   1. *Before a turn exists.* `sessions.prompt` resolves the addressed agent
 *      through `turnAgentFor`, which refuses when no adapter serves the
 *      session's selection — before `agent.followup`, so nothing durable is
 *      written. That boundary is upstream's and this distribution reaches it
 *      by composing an empty default selection: a fresh profile names no
 *      route, so an unconfigured capability is refused there with no turn, no
 *      trajectory and no provider request.
 *
 *   2. *Before the provider request.* Everything past step 1 has an open turn.
 *      `agent-loop` appends `turn/start` and only then dispatches
 *      `agent/pre-step`, so the earliest extension point in the loop already
 *      has a durable turn behind it. `llm/stream` is the last waterfall before
 *      the adapter is reached, and it is where this module sits.
 *
 * The honest consequence: a refusal here spends no provider request, no token
 * and no cost, and reaches no tool — but it cannot un-append a `turn/start`
 * that upstream wrote before any extension point ran. Only route registration
 * decides step 1, and this distribution does not get to decide which routes a
 * person may configure. Refusing later and cleanly is the strongest position
 * available to a plugin, and pretending otherwise would be the same kind of
 * overclaim this whole subsystem exists to stop making.
 *
 * **What it does not do.** It does not check credentials, reachability, or
 * whether a model still exists. Those are the Host's to discover at the moment
 * of the request, and asking them here would mean either contacting a provider
 * to decide whether to contact a provider, or caching an answer that goes
 * stale the moment a key is revoked. This asks the one question a stored
 * document can answer honestly: did somebody choose this route.
 *
 * @module @deepwatch/dsh-technology/routing
 */

import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only: brings the `llm/stream` waterfall into the Events merge, so the
// listener below is checked against upstream's signature rather than trusted.
import type {} from '@deepseek-ai/dsh-llm'
import {
  BINDINGS_NAMESPACE, BINDINGS_VERSION, isRoutePermitted, permittedRoutes,
  readBindings,
} from '@deepwatch/dsh-contracts'
import type { WatchBindings } from '@deepwatch/dsh-contracts'
import { PROVENANCE_SERVICE, routeKey } from './provenance.js'
import type { CapabilityVerdict, WatchProvenance } from './provenance.js'

/** The settings section the binding screens write and this module reads. */
export const BINDINGS_SETTINGS_NAMESPACE = settingsNamespace(BINDINGS_NAMESPACE)

/** One stored decision, exactly as the settings document holds it. */
export interface StoredRecord {
  provider: string
  model: string
  credentialRef?: string
  boundAt?: string
}

/** The section's value type, which is what `installSettingsSection` is generic over. */
export interface StoredBindings {
  version: number
  roles: Record<string, StoredRecord>
}

/** One stored decision, as the settings document validates it. */
const RECORD_SCHEMA = s.object({
  provider: s.string().required(),
  model: s.string().required(),
  credentialRef: s.string(),
  boundAt: s.string(),
})

/**
 * The stored document's shape.
 *
 * A dictionary keyed by role rather than a list, so a second binding for one
 * role is not representable: "which model serves Chat" has one answer, and a
 * shape that allowed two would eventually be asked to pick between them.
 */
export const BINDINGS_SCHEMA: s<StoredBindings> = s.object({
  version: s.number().default(BINDINGS_VERSION),
  roles: s.dict(RECORD_SCHEMA).default({}),
})

/** How this Host treats a request for a route nobody bound. */
export interface Config {
  /**
   * Refuse it, rather than reporting it and letting it through.
   *
   * On by default and meant to stay on. It exists as a switch because a
   * deployment driving the Harness through the SDK — no screens, no stored
   * bindings, a selection supplied per call — has authorised its routes
   * somewhere else, and for that shape every request would otherwise be
   * refused. Turning it off is a deployment saying it owns this decision, not
   * a way to soften the check for an interactive profile.
   */
  readonly enforce: boolean
  /**
   * Bindings this deployment composes, under whatever a person chooses here.
   *
   * The composition base of the settings section, which is upstream's own
   * layering: schema defaults, then this, then the user's document. Empty by
   * default, because a distribution that composed a binding would be making
   * the decision this module exists to stop making on somebody's behalf.
   *
   * It is not empty for a deployment that ships pre-configured — a managed
   * install pointed at an internal gateway — where the person is not the one
   * choosing. Anything they *do* choose still wins, because a user layer
   * always sits above a composition base.
   */
  readonly bindings?: StoredBindings
}

/** Schemastery validation for the routing policy. */
export const Config: s<Config> = s.object({
  enforce: s.boolean().default(true),
  bindings: BINDINGS_SCHEMA,
})

export const name = 'watch-routing'

/**
 * `llm` only.
 *
 * `settings` is deliberately absent: `installSettingsSection` injects it
 * itself and falls back to the composition entry when no settings provider is
 * mounted. Injecting it here would park this plugin — and with it the
 * refusal — on any deployment that composes no settings file, which is the
 * exact shape where a fail-open would go unnoticed.
 */
export const inject = ['llm', PROVENANCE_SERVICE]

/**
 * A request refused because nothing asked for it.
 *
 * Separate from {@link UnboundRouteError} because it is a different fault with
 * a different fix. That one is about a route; this one is about a caller. A
 * timer, a recovery task, a restored session or a title job that resolves a
 * perfectly good selection arrives here — the route may be proved, and nobody
 * asked.
 */
export class UnattributedRequestError extends Error {
  readonly provider: string
  readonly model: string
  /** Which way the attribution failed, for a log somebody has to read. */
  readonly verdict: CapabilityVerdict | 'no_open_turn'

  constructor(
    provider: string, model: string, verdict: CapabilityVerdict | 'no_open_turn',
  ) {
    super(
      `nothing initiated the request to ${provider}/${model} (${verdict}): a provider `
      + 'request must carry a capability from an explicit provider test, or belong '
      + 'to an open user turn')
    this.name = 'UnattributedRequestError'
    this.provider = provider
    this.model = model
    this.verdict = verdict
  }
}

/**
 * A request refused because its route is not one this profile is ready to use.
 *
 * Two refusals kept apart, because they need opposite actions: a route nobody
 * bound is fixed by choosing one, and a route bound but never proved is fixed
 * by running the provider test. Reporting both as "not bound" sent somebody to
 * a screen where the binding they were told was missing sat in front of them.
 */
export class UnboundRouteError extends Error {
  /** The route the request named. Not a credential and not a path. */
  readonly provider: string
  readonly model: string
  /** Whether the refusal was about proof rather than about choice. */
  readonly boundButUnproved: boolean

  constructor(
    provider: string, model: string, permitted: readonly string[], boundButUnproved = false,
  ) {
    // Written for a Host log and for Diagnostics. It never reaches a
    // conversation as-is: the browser half maps this onto a typed card, which
    // is what stops a route id being shown to somebody who did not choose it.
    super(
      boundButUnproved
        ? `${provider}/${model} is bound but no provider test has proved it, so `
          + 'nothing may be sent to it yet'
        : `no capability in this profile is bound to ${provider}/${model}`
          + (permitted.length === 0
            ? '; nothing is bound yet'
            : `; bound routes are ${permitted.join(', ')}`))
    this.name = 'UnboundRouteError'
    this.provider = provider
    this.model = model
    this.boundButUnproved = boundButUnproved
  }
}

/**
 * The routing preflight, and the store the binding screens persist through.
 *
 * @param ctx - the Host context this plugin is composed into.
 * @param config - the routing policy.
 */
export function apply(ctx: Context, config: Config): void {
  const composed: StoredBindings = config.bindings ?? { version: BINDINGS_VERSION, roles: {} }
  let read: () => StoredBindings = () => composed
  // Seeded from the composition base rather than left empty, because
  // `installSettingsSection` hands its hooks over inside `ctx.inject(['settings'])`
  // and a deployment that mounts no settings provider never reaches them. Left
  // at empty, such a deployment would refuse the routes it had itself composed.
  let current: WatchBindings = readBindings(composed)

  installSettingsSection(
    ctx,
    BINDINGS_SETTINGS_NAMESPACE,
    BINDINGS_SCHEMA,
    composed,
    {
      setSource: (source: () => StoredBindings) => { read = source },
      // Re-read rather than re-derive: the document is small, it changes when
      // a person presses a button, and holding a projection of it would be one
      // more thing that can disagree with the file somebody just edited.
      onChange: () => { current = readBindings(read()) },
    },
  )

  if (!config.enforce) return

  /**
   * Why this request may not go out, or null when it may.
   *
   * Three questions, in this order, because they fail for different reasons and
   * a caller deserves the one actually blocking it.
   *
   *   1. *Who asked?* Either a capability issued for this exact route by a
   *      provider test somebody requested, or a turn this Host has open.
   *      Nothing else has authority to spend a request however good the route
   *      is — which is what stops a timer, a restored session or a deferred
   *      title task from reaching a provider on the strength of a binding.
   *   2. *Did somebody choose this route?* The original question, asked of the
   *      binding document as it stands right now. It is asked live rather than
   *      pinned into the proof, because the document can be edited between one
   *      request and the next and a digest taken at proof time would not know.
   *   3. *Has this route been proved?* A receipt minted when a provider test
   *      actually came back, still matching the provider profile and credential
   *      reference it was taken under.
   *
   * A provider test answers the first question and is exempt from the other
   * two, because it is the request that establishes them — a route cannot be
   * proved before the request that proves it, and this is the screen where
   * somebody is deciding whether to bind it at all. It is exempt from nothing
   * else: one use, one route, and it expires.
   */
  const refuse = (options: {
    provider: string, model: string, watchAuthorization?: unknown,
  }): Error | null => {
    const provenance = ctx.get(PROVENANCE_SERVICE) as unknown as WatchProvenance | undefined
    if (provenance === undefined) {
      // Injected, so unreachable in a composed profile — and if the wiring ever
      // changes, the safe reading of "I have no way to check" is a refusal.
      return new UnattributedRequestError(options.provider, options.model, 'unknown')
    }
    const route = routeKey(options.provider, options.model)

    if (options.watchAuthorization !== undefined) {
      const verdict = provenance.consume(options.watchAuthorization, route)
      return verdict === 'ok'
        ? null
        : new UnattributedRequestError(options.provider, options.model, verdict)
    }

    if (provenance.activeTurn() === null) {
      return new UnattributedRequestError(options.provider, options.model, 'no_open_turn')
    }
    if (!isRoutePermitted(current, options.provider, options.model)) {
      return new UnboundRouteError(options.provider, options.model, permittedRoutes(current))
    }
    if (provenance.isReady(options.provider, options.model)) return null
    return new UnboundRouteError(options.provider, options.model, permittedRoutes(current), true)
  }

  // `prepend`, so this runs ahead of the retry and replay listeners. A
  // refusal that a retry listener could reach first would be retried, and a
  // request nobody authorised would be attempted several times rather than
  // none.
  ctx.on('llm/stream', (options: {
    provider: string, model: string, watchAuthorization?: unknown,
  }, next) => {
    const refusal = refuse(options)
    if (refusal === null) return next()
    // Returned as an iterable that rejects on the first pull, rather than
    // thrown from the listener body. The waterfall's contract is that a
    // listener hands back an async iterable, and a synchronous throw here
    // would surface as a plugin fault rather than as the request failure it
    // is.
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
        next: (): Promise<IteratorResult<never>> => Promise.reject(refusal),
      }),
    }
  }, { prepend: true })
}

export default apply
