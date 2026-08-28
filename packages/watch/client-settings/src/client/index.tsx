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
 * @module @watchskill/dsh-client-settings/client
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  AboutSection,
  DiagnosticsSection,
  EnginesSection,
  MemorySection,
  RoleBindingsSection,
  SourcesSection,
  VerificationSection,
} from './components.js'
import { WatchOnboarding } from './onboarding.js'

export * from './components.js'
export * from './onboarding.js'
export * from './readiness.js'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/** Add the Watch sections to DSH's settings panel. */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotService }).slots

  const section = (id: string, label: string, order: number, component: unknown): void => {
    slots.inject('settings.section', () => {
      slots.register({ name: 'settings.section', id, label, order }, component)
    })
  }

  // INTELLIGENCE — what the agent is, and what each capability is bound to.
  // DSH's own Models section stays where it is; this adds the per-role view it
  // has no reason to carry, since roles are a Watch concept.
  section('watch-roles', 'Role Bindings', 20, RoleBindingsSection)

  // PERCEPTION — what runs here, and what it is allowed to see.
  section('watch-engines', 'Perception Engines', 30, EnginesSection)
  section('watch-sources', 'Sources & Devices', 40, SourcesSection)

  // MEMORY — what is kept, under which rules.
  section('watch-memory', 'Memory & Retrieval', 50, MemorySection)

  // TRUTH — what a verdict means and who may issue one.
  section('watch-verification', 'Verification', 60, VerificationSection)

  // SYSTEM — what this installation actually is.
  section('watch-diagnostics', 'Diagnostics', 70, DiagnosticsSection)
  section('watch-about', 'About', 80, AboutSection)

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
