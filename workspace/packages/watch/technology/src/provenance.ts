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
 * hash, no prefix, no length. A receipt binds to the credential *reference*, to
 * a count of how many times the Host has been told that reference was
 * rewritten, and to the provider's stored profile — all of which the Host
 * already holds in the clear. That is also how a rotated key stops authorising
 * anything: the count moved, without this module having been near the secret.
 *
 * @module @deepwatch/dsh-technology/provenance
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** The service name both halves reach this by. */
export const PROVENANCE_SERVICE = 'watchProvenance'

/** The settings namespace the Harness keeps provider routes in. */
const PROVIDER_NAMESPACE = 'llm-pi-ai'

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
   * A digest of the provider's whole stored profile — base URL, API flavour,
   * headers, timeouts, model overrides, and the credential *reference*.
   *
   * The whole entry rather than a chosen few fields, because a hand-picked
   * list is a list of the ways a configuration change was allowed to go
   * unnoticed. Upstream's schema is what makes that safe: exactly one field,
   * `apiKeyEnv`, is declared `role('credential-ref')`, and a reference is not
   * a value. Nothing else in a provider profile is a secret by that schema's
   * own account, so digesting all of it stores no credential and leaves no
   * configuration gap.
   */
  readonly providerRevision: string
  /**
   * Which credential the route resolves through, and how many times this Host
   * has seen that credential rewritten.
   *
   * A reference and a counter. Never a value, and nothing measured from one —
   * so a rotated key invalidates the proof taken under the old one without
   * this module ever having touched either. The counter comes from the
   * credentials service's own `credentials/reference-updated` and
   * `credentials/record-updated` notifications, which upstream fans out only
   * after a write has committed.
   */
  readonly credentialRevision: string
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

/**
 * What a screen may say about one route, and it is the Host that says it.
 *
 * A browser tab holding its own memory of a provider test is a claim about a
 * Host it cannot see: the Host may have restarted, or the base URL may have
 * been edited in another tab, and the tab would still be drawing a tested
 * badge over a route the Host would refuse. So the verdict is read from here.
 */
export type RouteReadiness = 'proved' | 'never_tested' | 'configuration_changed' | 'unreadable'

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
 * a different model, a base URL or header edited after the test, a credential
 * pointed somewhere else, a key rotated at the same reference. Any of them and
 * the answer is no — not "probably still fine".
 *
 * *Which role is bound to this route is deliberately not here.* A proof is
 * about whether this provider and model answer, which is what the provider
 * test established; who may use them is a separate question, and the guard
 * asks it of the live binding document on every request rather than of a
 * digest taken minutes earlier. Pinning it here would have been weaker in one
 * direction — a snapshot cannot notice an edit that arrives without an event —
 * and wrong in the other: the product's own order is configure, test, bind,
 * prompt, so a proof that died when a role was bound was a proof that never
 * survived to be used.
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

  /**
   * Forget everything proved.
   *
   * Nothing in normal operation calls this: a receipt lapses by no longer
   * matching the route's live facts, which is precise where forgetting
   * everything was merely loud. It stays because a Host that is tearing a
   * profile down should not leave proofs behind it, and because a test that
   * wants an unproved route should be able to say so directly.
   */
  clearReceipts(): void {
    this.receipts.clear()
  }

  /** Whether the Host would serve this route to a user turn right now. */
  isReady(provider: string, model: string): boolean {
    return receiptAuthorises(
      this.receiptFor(provider, model), provider, model, this.factsFor(provider, model))
  }

  /**
   * The same answer, in the words a screen has to use.
   *
   * `isReady` is the guard's question and a boolean is all it needs. A person
   * looking at a binding needs to know *which* thing to do, and "never tested"
   * and "tested, then something moved" have different next steps — run the
   * test, or look at what changed first. Nothing here is derived from a
   * credential and nothing names one.
   */
  readiness(provider: string, model: string): RouteReadiness {
    const facts = this.factsFor(provider, model)
    if (facts === null) return 'unreadable'
    const receipt = this.receiptFor(provider, model)
    if (receipt === undefined) return 'never_tested'
    return receiptAuthorises(receipt, provider, model, facts) ? 'proved' : 'configuration_changed'
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
    try {
      providers = settings.section(PROVIDER_NAMESPACE)?.['providers'] as
        Record<string, unknown> | undefined
    } catch {
      // A malformed section is not a licence to proceed.
      return null
    }
    const entry = (providers?.[provider] ?? {}) as Record<string, unknown>
    // The reference the profile names, and the record the adapter would look
    // for under its own scope. Either can be the one that answers, so a write
    // to either has to count.
    const reference = typeof entry['apiKeyEnv'] === 'string' ? entry['apiKeyEnv'] : null
    const record = `${PROVIDER_NAMESPACE}/${provider}`
    return {
      // The profile entire, plus the route it is being asked about. Digested
      // over settings this Host already holds in the clear; upstream marks the
      // one credential-bearing field as a reference, and a reference is what
      // this is allowed to bind to.
      providerRevision: digestOf({ provider, model, entry }),
      credentialRevision: digestOf({
        reference,
        referenceWrites: reference === null ? 0 : (this.credentialWrites.get(reference) ?? 0),
        record,
        recordWrites: this.credentialWrites.get(record) ?? 0,
      }),
    }
  }

  /* ── credentials ──────────────────────────────────────────────────────── */

  /**
   * How many times each credential reference or record has been rewritten.
   *
   * A counter per name, and nothing else: this module is told *that* a stored
   * value changed and never what it was or is. Wired to the credentials
   * service's own notifications in {@link apply}, which upstream fans out
   * after the write commits — so a receipt taken before a key rotation stops
   * authorising at the next request rather than at the next restart.
   */
  private readonly credentialWrites = new Map<string, number>()

  /** A stored credential changed. Everything proved under the old one lapses. */
  noteCredentialWrite(name: string): void {
    this.credentialWrites.set(name, (this.credentialWrites.get(name) ?? 0) + 1)
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

  // Upstream's event declarations are not merged into this package's `Events`
  // — it depends on `dsh-llm` and `dsh-settings` and not on the agent loop or
  // the credentials seam — so registration goes through a described surface.
  // Two shapes, because the loop has two: an observer, and a waterfall link
  // that is handed `next` and must return it.
  const observe = ctx as unknown as {
    on(name: string, listener: (payload: unknown) => void): void
  }
  const link = ctx as unknown as {
    on(
      name: string,
      listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
    ): void
  }

  // A rewritten credential is the one change to a route that leaves no trace
  // in settings: the reference stays the same word while the thing behind it
  // becomes something else. Upstream announces it, so this counts the
  // announcements — a name and a number, never a value.
  //
  // Every *other* way a route can change is caught by comparison instead of by
  // event, because `factsFor` reads the live settings document on each request.
  // An earlier version cleared every receipt on any settings write, which
  // sounded conservative and was not: it also cleared them on the write that
  // binds a role, so the product's own configure–test–bind–prompt order ended
  // at a refusal, and the browser pass caught it.
  observe.on('credentials/reference-updated', (ref) => {
    if (typeof ref === 'string') provenance.noteCredentialWrite(ref)
  })
  observe.on('credentials/record-updated', (key) => {
    if (typeof key === 'string') provenance.noteCredentialWrite(key)
  })

  // A turn is open only while the agent loop says so. An event that never
  // fires leaves no turn open, and no turn open refuses — so a rename upstream
  // fails closed rather than silently permitting.
  //
  // `agent/pre-step` is a *waterfall*, and that is not a detail. Its listeners
  // are handed the loop's own `next` and are expected to return a step
  // decision; a listener that takes only the payload and returns nothing does
  // not observe the step, it answers it — with `undefined`, in place of the
  // decision the loop was about to make. Registered that way, this opened the
  // turn correctly and then ended it: the browser pass reported the provider
  // seeing seven provider tests and no turn at all, and the same signature
  // survived turning the guard itself off, which is what finally located it.
  // Only this one event is a waterfall; `agent/turn-stopping` is serial and
  // the other three are plain emits, so their listeners are observers and
  // return nothing on purpose.
  link.on('agent/pre-step', async (payload, next) => {
    provenance.openTurn(turnIdOf(payload))
    return next()
  })
  observe.on('agent/turn-stopping', (payload) => { provenance.closeTurn(turnIdOf(payload)) })
  observe.on('agent/error', () => { provenance.closeAllTurns() })
  observe.on('agent/disposed', () => { provenance.closeAllTurns() })
  observe.on('agent/session-start', () => { provenance.closeAllTurns() })
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
