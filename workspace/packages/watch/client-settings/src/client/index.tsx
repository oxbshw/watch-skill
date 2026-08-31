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
import {
  AboutSection,
  DiagnosticsSection,
  EnginesSection,
  MemorySection,
  SourcesSection,
  VerificationSection,
} from './components.js'
import { WatchOnboarding } from './onboarding.js'
import { BindingStore } from './binding-state.js'
import { RoleBindings } from './role-bindings.js'
import { ChatGate } from './chat-gate.js'
import type { ComposerBlocks } from './chat-gate.js'
import type { HostApi } from './binding-state.js'

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
export const inject = ['slots', 'connection']

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/** The half of the conversation service a composer block needs. */
interface ConversationService {
  readonly blocks: ComposerBlocks
}

/** Add the Watch sections to DSH's settings panel. */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotService }).slots
  // One store for the whole panel. Two would be two answers to "is Chat
  // ready?", and the screen that showed a stale one would be the screen
  // somebody trusted.
  const store = new BindingStore((ctx.get('connection') as { api: HostApi }).api)
  const RoleBindingsSection = (): ReactNode => RoleBindings({ store })
  // Diagnostics reads the same store, so "Agent Model — Not configured" cannot
  // sit beside a Role Bindings screen saying Chat is ready. One store, one
  // answer, on every surface that asks.
  const DiagnosticsWithRoles = (): ReactNode => {
    // Subscribed, not sampled: a Diagnostics page that read the snapshot once
    // would show the readiness that happened to be loaded when it mounted, and
    // go quietly stale the moment somebody bound something in the next tab.
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    useEffect(() => { void store.load() }, [])
    return DiagnosticsSection({ roles: snapshot.roles })
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
      WatchOnboarding,
    )
  })
}
