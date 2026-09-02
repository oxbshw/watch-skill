/**
 * The Watch Technology & Capability Center, registered into DSH's settings.
 *
 * `settings.section` is a list, so these seven sit alongside DSH's General,
 * Models and Plugins rather than replacing any of them. That is the whole
 * arrangement: the foundation keeps its settings, and Watch adds the surfaces
 * that make its own capabilities inspectable.
 *
 * The `order` values start at 20 so upstream's sections keep the top of the
 * list, and they are grouped so the reading order tells a story — what the
 * agent is (Intelligence), what it can perceive (Perception), what it keeps
 * (Memory), what it can prove (Truth), and what it actually is (System).
 *
 * @module @deepwatch/dsh-client-settings/client
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { CoreHealthReport } from '@deepwatch/dsh-contracts/query/wire'
import {
  AboutSection,
  DiagnosticsSection,
  EnginesSection,
  MemorySection,
  SourcesSection,
  VerificationSection,
} from './components.js'
import { WatchOnboarding } from './onboarding.js'
import type { OnboardingProps } from './onboarding.js'
import { BindingStore } from './binding-state.js'
import { RoleBindings } from './role-bindings.js'
import { ChatGate } from './chat-gate.js'
import type { ComposerBlocks } from './chat-gate.js'
import type { HostApi } from './binding-state.js'
import type { ProviderTestFacts } from './binding-state.js'

export * from './components.js'
export * from './onboarding.js'
export * from './readiness.js'
export * from './binding-state.js'
export * from './role-bindings.js'
export * from './chat-gate.js'

/**
 * Services this half needs before it can register anything.
 *
 * `connection` is what makes Role Bindings a working screen rather than a
 * description of one: it carries the RPC face this package asks for the
 * provider directory, the model catalogue, credential state and the stored
 * assignments. Registering the section without it would put a control on
 * screen that fails when pressed.
 */
// `remote` is listed because Diagnostics reads the engine through
// `remote.watchQuery`, and cordis refuses a property no inject entry claims —
// the Health card rendered as a crashed slot until this said so.
//
// `remote.watchQuery` is listed for the same reason: cordis guards the nested
// namespace separately, and reaching it without the entry crashed the settings
// slot rather than returning undefined.
//
// Listing it parks this plugin until the namespace is mounted, which is only
// safe because `@deepwatch/dsh-client-remotes` is now a declared
// `dsh.client.inject` dependency in package.json — the boot graph reads that,
// not this constant, and without it the mount ordering was not guaranteed.
// The lookup below is still written defensively, so a profile that somehow
// lacks the namespace gets "could not be read" rather than a blank card.
export const inject = ['slots', 'connection', 'remote', 'remote.watchQuery']

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/** The half of the conversation service a composer block needs. */
/** What Diagnostics renders: a health report, or nothing it could read. */
type CoreHealth = CoreHealthReport

/**
 * The one read plane method this package calls.
 *
 * Typed locally rather than imported from the Library's declared namespace:
 * this package needs one method and importing the whole face would make
 * Settings depend on the Library's view of a service it shares.
 */
type CoreHealthReader = (
  request: { protocol: number, requestId: string, deadlineMs: number },
  signal?: AbortSignal,
) => Promise<{ ok: true, value: unknown } | { ok: false }>

type ProviderTestReader = (
  request: {
    protocol: number
    requestId: string
    deadlineMs: number
    provider: string
    model: string
  },
  signal?: AbortSignal,
) => Promise<{ ok: true, value: unknown } | { ok: false }>

interface HealthSnapshot {
  readonly health: CoreHealth | null
  readonly reading: boolean
  readonly loaded: boolean
}

/** One live Core reading shared by onboarding and Diagnostics. */
class CoreHealthStore {
  private snapshot: HealthSnapshot = { health: null, reading: true, loaded: false }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private inFlight: Promise<void> | null = null

  constructor(private readonly reader: () => CoreHealthReader | null) {}

  getSnapshot = (): HealthSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(snapshot: HealthSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  /**
   * Read once, however many surfaces ask.
   *
   * Onboarding and Diagnostics mount independently and both need the same
   * reading. Firing a second Core handshake because a second surface appeared
   * is two readings that can disagree, and the one a person is looking at
   * would be whichever landed last.
   */
  ensureLoaded(): void {
    if (this.snapshot.loaded || this.inFlight !== null) return
    this.inFlight = this.refresh().finally(() => { this.inFlight = null })
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation
    this.publish({ ...this.snapshot, reading: true })
    const reader = this.reader()
    if (reader === null) {
      this.publish({ health: null, reading: false, loaded: true })
      return
    }
    try {
      const result = await reader({
        protocol: 1, requestId: `req_${Date.now().toString(36)}`, deadlineMs: 15_000,
      }, new AbortController().signal)
      if (generation !== this.generation) return
      const report = result.ok ? result.value as CoreHealth | null | undefined : null
      this.publish({
        health: report?.outcome === 'core_health' ? report : null,
        reading: false,
        loaded: true,
      })
    } catch {
      if (generation === this.generation) {
        this.publish({ health: null, reading: false, loaded: true })
      }
    }
  }
}

interface ConversationService {
  readonly blocks: ComposerBlocks
}

/** Add the Watch sections to DSH's settings panel. */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotService }).slots
  // One store for the whole panel. Two would be two answers to "is Chat
  // ready?", and the screen that showed a stale one would be the screen
  // somebody trusted.
  // Diagnostics reads the same store, so "Agent Model — Not configured" cannot
  // sit beside a Role Bindings screen saying Chat is ready. One store, one
  // answer, on every surface that asks.
  /**
   * The channel to the engine, looked up when Diagnostics renders.
   *
   * Deliberately *not* an `inject` entry. Naming `remote.watchQuery` there
   * parks this whole plugin until the service exists, and the cost of being
   * wrong about that is not a missing Health card — it is every Watch settings
   * section disappearing, which is what happened: "View diagnostics" became a
   * button that did nothing. The same mistake is recorded twenty lines below
   * about `conversation`, and it is the same mistake.
   *
   * So this is read at the point of use, and its absence is a state the panel
   * already renders honestly: "could not be read" rather than a plausible
   * default. A screen that says it does not know beats a screen that is not
   * there.
   */
  const readHealth = (): CoreHealthReader | null => {
    const remote = (ctx as unknown as {
      remote?: { watchQuery?: { coreHealth?: CoreHealthReader } }
    }).remote
    return remote?.watchQuery?.coreHealth ?? null
  }
  const runProviderTest = async (
    provider: string, model: string, signal: AbortSignal,
  ): Promise<ProviderTestFacts> => {
    const method = (ctx as unknown as {
      remote?: { watchQuery?: { providerTest?: ProviderTestReader } }
    }).remote?.watchQuery?.providerTest
    if (method === undefined) throw new Error('provider test remote unavailable')
    const result = await method({
      protocol: 1, requestId: `req_provider_${Date.now().toString(36)}`,
      deadlineMs: 15_000, provider, model,
    }, signal)
    if (!result.ok) throw new Error('provider test remote refused the request')
    const value = result.value as ProviderTestFacts & { outcome?: string }
    if (value.outcome !== 'provider_test' || value.provider !== provider || value.model !== model) {
      throw new Error('provider test returned a mismatched response')
    }
    return value
  }
  const store = new BindingStore(
    (ctx.get('connection') as { api: HostApi }).api, runProviderTest,
  )
  const RoleBindingsSection = (): ReactNode => RoleBindings({ store })
  const healthStore = new CoreHealthStore(readHealth)

  const DiagnosticsWithRoles = (): ReactNode => {
    // Subscribed, not sampled: a Diagnostics page that read the snapshot once
    // would show the readiness that happened to be loaded when it mounted, and
    // go quietly stale the moment somebody bound something in the next tab.
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    useEffect(() => { void store.load() }, [])

    const core = useSyncExternalStore(
      healthStore.subscribe, healthStore.getSnapshot, healthStore.getSnapshot,
    )
    useEffect(() => { healthStore.ensureLoaded() }, [])

    return DiagnosticsSection({
      roles: snapshot.roles, health: core.health, reading: core.reading,
      onRefresh: () => { void healthStore.refresh() },
    })
  }

  const OnboardingWithReadiness = (props: OnboardingProps): ReactNode => {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const core = useSyncExternalStore(
      healthStore.subscribe, healthStore.getSnapshot, healthStore.getSnapshot,
    )
    useEffect(() => { void store.load(); healthStore.ensureLoaded() }, [])
    return WatchOnboarding({
      ...props, roles: snapshot.roles, health: core.health, reading: core.reading,
    })
  }

  const section = (id: string, label: string, order: number, component: unknown): void => {
    slots.inject('settings.section', () => {
      slots.register({ name: 'settings.section', id, label, order }, component)
    })
  }

  // A section label has 112px, measured in the running settings nav.
  //
  // "Perception Engines", "Sources & Devices" and "Memory & Retrieval" were
  // 118px, 114px and 124px, so all three ellipsised to "Perception Engi…",
  // "Sources & Devic…" and "Memory & Retri…" — three of eight Watch sections
  // unreadable in every screenshot. The one-word forms are 66px, 49px and
  // 52px, and they sit consistently beside the labels that already fit:
  // Role Bindings 84px, Verification 70px, Diagnostics 72px, About 39px.
  //
  // The nav width is DSH's, so the label is the half that has to give.

  // INTELLIGENCE — what the agent is, and what each capability is bound to.
  // DSH's own Models section stays where it is; this adds the per-role view it
  // has no reason to carry, since roles are a Watch concept.
  section('watch-roles', 'Role Bindings', 20, RoleBindingsSection)

  // PERCEPTION — what runs here, and what it is allowed to see.
  section('watch-engines', 'Perception', 30, EnginesSection)
  section('watch-sources', 'Sources', 40, SourcesSection)

  // MEMORY — what is kept, under which rules.
  section('watch-memory', 'Memory', 50, MemorySection)

  // TRUTH — what a verdict means and who may issue one.
  section('watch-verification', 'Verification', 60, VerificationSection)

  // SYSTEM — what this installation actually is.
  section('watch-diagnostics', 'Diagnostics', 70, DiagnosticsWithRoles)
  section('watch-about', 'About', 80, AboutSection)

  // The composer's own preflight, in the seat beside it.
  //
  // The seat is claimed unconditionally and the conversation service is looked
  // up when the gate renders. Parking the registration behind
  // `ctx.inject(['conversation'], …)` looked tidier and was wrong: the
  // callback never ran, so the card never drew and the composer was never
  // blocked -- silently, while every other surface in this package worked.
  // Upstream's own model-selection plugin reaches the same registry with a
  // plain `ctx.get('conversation')` at the point of use, which is late enough
  // to be there.
  //
  // It lives here rather than in the shell because this is the package that
  // knows. Upstream's note on composer blocks says the model-selection plugin
  // is what raises one -- "the composer cannot read the plugins that would
  // know" -- and in this distribution that is this package: it holds the
  // store, the readiness and the picker. Anywhere else would mean a second
  // store, and two answers to "can Chat run?".
  const blocks = (): ComposerBlocks | undefined =>
    (ctx.get('conversation') as ConversationService | undefined)?.blocks
  slots.inject('conversation.input.dock', () => {
    slots.register(
      // Order 5, ahead of the Watch composer panel at 10: a person who cannot
      // send yet should meet the reason before the turn controls.
      { name: 'conversation.input.dock', id: 'watch-chat-gate', order: 5 },
      ({ sessionId }: { readonly sessionId: string }): ReactNode =>
        ChatGate({ sessionId, store, blocks }),
    )
  })

  // The first-run screen, ahead of upstream's.
  //
  // `settings.onboarding` is a list and DSH renders `{ only: currentStep }`, so
  // order decides what a person sees first. Upstream registers
  // `deepseek-official` at 0; this sits at -50 and leads instead with what the
  // product is and what is actually ready.
  //
  // Upstream's step is not removed. DeepSeek remains a perfectly good provider
  // choice, and continuing past this screen reaches it unchanged — the change
  // is that connecting it is no longer presented as the price of entry.
  slots.inject('settings.onboarding', () => {
    slots.register(
      { name: 'settings.onboarding', id: 'watch-welcome', order: -50 },
      OnboardingWithReadiness,
    )
  })
}
