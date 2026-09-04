/**
 * Who asked for this provider request, and has this exact route been proved.
 *
 * One service, mounted once, injected by everything that needs it. That shape
 * is the point rather than an implementation detail, so it is worth saying why
 * three earlier shapes were wrong.
 *
 * **What went wrong first.** An offline profile configured against a loopback
 * stub acquired a `watch-bindings` entry naming a public provider and a model
 * nobody had chosen, and seven seconds later the Host attempted a chat
 * completion against it. The routing guard allowed it, correctly by its rule at
 * the time: the stored document did name that pair. A document is evidence of a
 * decision only when nothing but a person can write it, and a settings file —
 * hand editable, RPC writable, hot reloaded — does not have that property.
 *
 * **What went wrong next.** Recording `testedAt` on the binding put the proof
 * in the same document that had just been forged, so anything able to write a
 * binding could write the proof beside it. It also contradicted this
 * repository's own rule in `contracts/bindings.ts`: whether a binding *works*
 * is never stored, because a stored verdict goes stale the moment a key is
 * revoked.
 *
 * **What went wrong after that.** Holding the state on the plugin that
 * constructed it, or on a module, or in `AsyncLocalStorage`, all failed the
 * same way: a Cordis service is reflected per scope, and the routing guard and
 * the read plane ended up reading different objects. The guard watched one set
 * of open windows while the provider test opened another, so the single request
 * allowed to prove a route was refused — an imitation of a broken provider good
 * enough to cost an afternoon. There is one owner now, mounted at the root of
 * the bundle, and both halves reach it by injection. A boundary that depends on
 * resolving the same object twice through a reflection layer is a boundary with
 * a way to be wrong.
 *
 * **The rule it enforces.** No request reaches a provider unless it is one of
 * exactly two things: a provider test somebody asked for, carrying a one-use
 * capability bound to that route, or a request inside a user turn the Host has
 * open. A configured model, a stored binding, a restored session, a title task,
 * a timer, a retry — none of them authorise anything on their own.
 *
 * **What is never here.** No credential value and nothing derived from one: no
 * hash, no prefix, no length. A receipt binds to the credential *reference* and
 * to the provider's routable configuration, both of which the Host already
 * holds in plain settings.
 *
 * @module @deepwatch/dsh-technology/provenance
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** The service name both halves reach this by. */
export const PROVENANCE_SERVICE = 'watchProvenance'

/** The settings namespace the Harness keeps provider routes in. */
const PROVIDER_NAMESPACE = 'llm-pi-ai'

/** The settings namespace DeepWatch keeps role bindings in. */
const BINDINGS_NAMESPACE_ID = 'watch-bindings'

/**
 * How long a provider-test capability stays usable.
 *
 * Short, because it exists to cover one round trip that has already been
 * requested. A capability that outlives the click that created it is a
 * capability something else can find.
 */
const CAPABILITY_TTL_MS = 60_000

/**
 * How many spent tokens stay recognisable as spent.
 *
 * Enough that a replay attempted anywhere near the original is named as one,
 * and bounded so a Host that runs for days does not accumulate a set nobody
 * reads. Past it a replay reads as `unknown`, which refuses just the same.
 */
const SPENT_MEMORY = 256

/** The kinds of thing allowed to cause a provider request. */
export type RequestInitiator = 'provider_test' | 'user_turn'

/** Everything about a route that must not have changed since it was proved. */
export interface RouteFacts {
  /**
   * A digest of the provider's routable configuration: base URL, API flavour
   * and the credential *reference*. Never a credential value.
   */
  readonly providerRevision: string
  /** The credential reference the route resolves through. Never a value. */
  readonly credentialRevision: string
  /** A digest of the binding document the proof was taken under. */
  readonly bindingRevision: string
}

/** Proof that one exact route answered one real request. */
export interface RouteReceipt extends RouteFacts {
  readonly provider: string
  readonly model: string
  /** The provider-test request that succeeded. Correlates the Host's own log. */
  readonly requestId: string
  /** When it succeeded. Reported, never used to decide anything. */
  readonly at: string
}

/**
 * A one-use permit for exactly one provider request on exactly one route.
 *
 * Passed through the real dispatch path as a field on the request rather than
 * inferred from execution context. `llm.stream` is lazy — nothing reaches the
 * waterfall until the first pull — so an ambient scope opened around the call
 * has already closed by the time the request happens. A value that travels with
 * the request cannot be out of date when the request arrives.
 */
export interface RequestCapability {
  readonly token: string
  readonly route: string
  readonly initiator: RequestInitiator
  readonly causeId: string
}

/** Why a capability was refused, for a message somebody has to act on. */
export type CapabilityVerdict =
  | 'ok' | 'unknown' | 'replayed' | 'route_mismatch' | 'expired'

/** One route, spelled the one way, so two spellings cannot disagree. */
export function routeKey(provider: string, model: string): string {
  return `${provider} ${model}`
}

/**
 * Whether a receipt still proves anything about this route.
 *
 * Every field has to match, and each is a way a proof could go stale unnoticed:
 * a different model, a base URL edited after the test, a credential pointed
 * somewhere else, a rebinding. Any of them and the answer is no — not
 * "probably still fine".
 */
export function receiptAuthorises(
  receipt: RouteReceipt | undefined, provider: string, model: string,
  facts: RouteFacts | null,
): boolean {
  if (receipt === undefined || facts === null) return false
  return receipt.provider === provider
    && receipt.model === model
    && receipt.providerRevision === facts.providerRevision
    && receipt.credentialRevision === facts.credentialRevision
    && receipt.bindingRevision === facts.bindingRevision
}

/**
 * A short, stable digest of a small document.
 *
 * Not a cryptographic claim: it identifies a revision so a change is noticed.
 * It is only ever computed over settings this Host already holds in the clear —
 * routes, references and bindings — and never over a credential value.
 */
function digestOf(value: unknown): string {
  const text = JSON.stringify(value ?? null)
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The settings surface this reads, described structurally. */
interface SettingsLike {
  section(ns: string): Record<string, unknown> | undefined
}

/**
 * The Host's record of who is asking and what has been proved.
 *
 * Mounted once by {@link apply} and injected everywhere else, so there is
 * exactly one of these per Host and no way for two halves to disagree.
 */
export class WatchProvenance extends Service {
  private readonly receipts = new Map<string, RouteReceipt>()
  /** Turns the agent loop currently has open, by its own turn id. */
  private readonly openTurns = new Map<string, number>()
  /** Capabilities issued and not yet spent, by token. */
  private readonly capabilities = new Map<string, RequestCapability & { expiresAt: number }>()
  private issued = 0

  constructor(ctx: Context) {
    super(ctx, PROVENANCE_SERVICE)
  }

  /* ── capabilities ─────────────────────────────────────────────────────── */

  /**
   * Permit exactly one provider request on exactly one route.
   *
   * Issued only where a person asked for a provider test. One use, one route,
   * and a minute to spend it — a permit that could be replayed, pointed
   * elsewhere or kept is not a permit, it is a key.
   */
  authorizeProviderTest(provider: string, model: string, causeId: string): RequestCapability {
    this.issued += 1
    const capability: RequestCapability = {
      // Unguessable is not the property that matters — this never leaves the
      // Host — but distinct is, so two tests in flight cannot spend each
      // other's permit.
      token: `wp-${String(this.issued)}-${Math.random().toString(36).slice(2, 10)}`,
      route: routeKey(provider, model),
      initiator: 'provider_test',
      causeId,
    }
    this.prune()
    this.capabilities.set(capability.token, { ...capability, expiresAt: Date.now() + CAPABILITY_TTL_MS })
    return capability
  }

  /**
   * Drop permits nobody spent, and forget spent tokens once they cannot recur.
   *
   * Both sets are unbounded otherwise, and a Host runs for days. The spent set
   * is what turns a second presentation into `replayed` rather than `unknown`,
   * so it is kept long enough to be useful and trimmed rather than grown: a
   * token that has aged out reads as unknown, which is still a refusal.
   */
  private prune(): void {
    const now = Date.now()
    for (const [token, held] of this.capabilities) {
      if (held.expiresAt < now) this.capabilities.delete(token)
    }
    if (this.spent.size <= SPENT_MEMORY) return
    const excess = this.spent.size - SPENT_MEMORY
    let dropped = 0
    for (const token of this.spent) {
      if (dropped >= excess) break
      this.spent.delete(token)
      dropped += 1
    }
  }

  /**
   * Spend a capability, or say exactly why it cannot be spent.
   *
   * Removed on the first look, whatever the verdict: a token that has been
   * presented once is spent even if it was presented at the wrong route, so a
   * caller cannot probe with it.
   */
  consume(token: unknown, route: string): CapabilityVerdict {
    if (typeof token !== 'string') return 'unknown'
    const held = this.capabilities.get(token)
    if (held === undefined) return this.spent.has(token) ? 'replayed' : 'unknown'
    this.capabilities.delete(token)
    this.spent.add(token)
    if (held.expiresAt < Date.now()) return 'expired'
    if (held.route !== route) return 'route_mismatch'
    return 'ok'
  }

  /** Tokens already presented, so a second presentation is named as a replay. */
  private readonly spent = new Set<string>()

  /* ── turns ────────────────────────────────────────────────────────────── */

  /** A turn began. Anything it dispatches is attributable to it. */
  openTurn(turnId: string): void {
    this.openTurns.set(turnId, (this.openTurns.get(turnId) ?? 0) + 1)
  }

  /** A turn ended, by completing, being cancelled, or erroring. */
  closeTurn(turnId: string): void {
    const depth = (this.openTurns.get(turnId) ?? 0) - 1
    if (depth > 0) this.openTurns.set(turnId, depth)
    else this.openTurns.delete(turnId)
  }

  /** Every turn ends when the agent goes away. */
  closeAllTurns(): void {
    this.openTurns.clear()
  }

  /** The turn a request would be attributed to, or null when there is none. */
  activeTurn(): string | null {
    const [turn] = [...this.openTurns.keys()]
    return turn ?? null
  }

  /** How many turns are open. Read by Diagnostics and by tests. */
  openTurnCount(): number {
    return this.openTurns.size
  }

  /* ── readiness ────────────────────────────────────────────────────────── */

  /**
   * Record that one exact route answered one real request.
   *
   * The only way a receipt comes into being, and it is not reachable from the
   * settings RPC, from a binding write, or from anything a browser can call
   * directly. The read plane calls it after its own provider test has actually
   * completed, which is the event this is evidence of.
   */
  mint(receipt: RouteReceipt): void {
    this.receipts.set(routeKey(receipt.provider, receipt.model), receipt)
  }

  /** The proof held for one route, if any. */
  receiptFor(provider: string, model: string): RouteReceipt | undefined {
    return this.receipts.get(routeKey(provider, model))
  }

  /** Forget everything proved. Any settings change calls this. */
  clearReceipts(): void {
    this.receipts.clear()
  }

  /** Whether the Host would serve this route to a user turn right now. */
  isReady(provider: string, model: string): boolean {
    return receiptAuthorises(
      this.receiptFor(provider, model), provider, model, this.factsFor(provider, model))
  }

  /**
   * The route's authoritative facts as they are *now*, or null when nothing
   * can say.
   *
   * Read straight out of the settings service, synchronously, so the base URL
   * a request would actually use is the one compared against. Null is a
   * refusal rather than an exemption: a Host that cannot read its own settings
   * cannot tell a current receipt from a stale one, and the safe reading of "I
   * cannot check" is "not proved".
   */
  factsFor(provider: string, model: string): RouteFacts | null {
    const settings = this.ctx.get('settings') as unknown as SettingsLike | undefined
    if (settings === undefined) return null
    let providers: Record<string, unknown> | undefined
    let bindings: Record<string, unknown> | undefined
    try {
      providers = settings.section(PROVIDER_NAMESPACE)?.['providers'] as
        Record<string, unknown> | undefined
      bindings = settings.section(BINDINGS_NAMESPACE_ID)
    } catch {
      // A malformed section is not a licence to proceed.
      return null
    }
    const entry = (providers?.[provider] ?? {}) as Record<string, unknown>
    return {
      // Everything that decides *where* the request goes, and the reference it
      // resolves a credential through. No value, and nothing measured from one.
      providerRevision: digestOf({
        provider,
        model,
        baseURL: entry['baseURL'] ?? null,
        api: entry['api'] ?? null,
      }),
      credentialRevision: digestOf(entry['apiKeyEnv'] ?? null),
      bindingRevision: digestOf(bindings ?? null),
    }
  }
}

/** The plugin's own name, so a composition can target the row. */
export const name = 'watch-provenance'

/**
 * Mount the one registry this Host has.
 *
 * A row of its own, rather than something the routing guard constructs, so that
 * `watch-routing` and `watch-tools` both *inject* it and are handed the same
 * service. That is the whole reason this file exists separately.
 */
export function apply(ctx: Context): void {
  const provenance = new WatchProvenance(ctx)

  // Any settings change at all invalidates every proof. A receipt is taken
  // against a base URL, a credential reference and a binding document; working
  // out which edit touched which route would be cleverness in the one place
  // where being wrong means a request nobody authorised. Forgetting costs one
  // provider test.
  const events = ctx as unknown as {
    on(name: string, listener: (...args: unknown[]) => void): void
  }
  events.on('settings/document-updated', () => { provenance.clearReceipts() })
  events.on('settings/updated', () => { provenance.clearReceipts() })

  // A turn is open only while the agent loop says so. An event that never
  // fires leaves no turn open, and no turn open refuses — so a rename upstream
  // fails closed rather than silently permitting.
  events.on('agent/pre-step', (payload) => { provenance.openTurn(turnIdOf(payload)) })
  events.on('agent/turn-stopping', (payload) => { provenance.closeTurn(turnIdOf(payload)) })
  events.on('agent/error', () => { provenance.closeAllTurns() })
  events.on('agent/disposed', () => { provenance.closeAllTurns() })
  events.on('agent/session-start', () => { provenance.closeAllTurns() })
}

/**
 * The turn an agent event is about, as an id this module can count.
 *
 * The loop reports a turn number scoped to one agent, so the agent is part of
 * the identity: two sessions both on turn 3 are two turns, and collapsing them
 * would let one close the other's window.
 */
export function turnIdOf(payload: unknown): string {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    turn?: unknown
    agent?: { id?: unknown }
  }
  const agent = typeof record.agent?.id === 'string' ? record.agent.id : 'agent'
  const turn = typeof record.turn === 'number' ? String(record.turn) : 'turn'
  return `${agent}#${turn}`
}

export default apply
