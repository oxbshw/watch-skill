/**
 * The composer, closed until something is actually bound to Chat — and the
 * fastest way to bind it, offered where the person is standing.
 *
 * A person typed a message into a composer that looked ready, pressed send,
 * and the prompt was routed to a provider they had never configured. Nothing
 * about the composer had told them otherwise: the model chip named a DeepSeek
 * model they had not chosen, the send button was live, and the first thing
 * that disagreed was a failed turn.
 *
 * This is the client half of preflight. It raises the block upstream provides
 * for exactly this — *"Composer blocks: the one way another plugin stops a
 * session's input"* — so the textarea goes inert, the send button stops
 * accepting, and the placeholder says why in the words of whoever knows.
 *
 * **This is an affordance, and it is not the enforcement.** It lives in a
 * browser tab. The Host refuses an unbound route regardless of what any client
 * disables (`@deepwatch/dsh-technology/routing`), and the composed default
 * names no route so the Harness's own admission boundary refuses a turn before
 * one exists. The value of this layer is not that it makes refusal certain — it
 * is that a person finds out *before* typing rather than after sending.
 *
 * **The draft survives.** Blocking is one inert textarea, never a second tree:
 * the composer keeps its DOM, so whatever was typed is still there when the
 * binding is fixed. That is upstream's design and this file's reason for using
 * it rather than rendering a replacement.
 *
 * **The way out is here, not somewhere else.** The settings panel's open state
 * is component-local to `SettingsRoot`, so no plugin can navigate to a section
 * — and a button that names a screen it cannot open is worse than no button.
 * So the fix is offered inline: the same provider-and-model picker the Role
 * Bindings screen uses, writing through the same store, so the two surfaces
 * cannot disagree about what a provider offers.
 *
 * @module @deepwatch/dsh-client-settings/chat-gate
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { PRIMARY_ROLE, ROLE_LABEL, cardForBlocker, isExecutable } from '@deepwatch/dsh-contracts'
import { StatusChip } from './components.js'
import { BindingEditor, CONTROL } from './role-bindings.js'
import { chatReadiness } from './binding-state.js'
import type { BindingSnapshot, BindingStore } from './binding-state.js'

/** The block registry, as `ctx.conversation.blocks` exposes it. */
export interface ComposerBlocks {
  set(sessionId: string, block: { readonly reason: string } | undefined): void
}

/** What the gate needs to do its job. */
export interface ChatGateProps {
  /** The session whose composer this gate governs. */
  readonly sessionId: string
  readonly store: BindingStore
  /**
   * The block registry, resolved when the gate renders rather than when the
   * plugin loads.
   *
   * A getter, and the reason is a bug this had. Registering the seat behind
   * `ctx.inject(['conversation'], …)` parked the registration on a service
   * that arrives with the conversation plugin, and the callback never ran --
   * so the card never drew and the composer was never blocked, silently, while
   * every other surface in this package worked. Upstream's own model-selection
   * plugin reaches the same registry with a plain `ctx.get('conversation')` at
   * the moment it needs it, which is late enough to be there and cheap enough
   * to repeat.
   */
  readonly blocks: () => ComposerBlocks | undefined
}

/**
 * The placeholder an inert composer carries.
 *
 * The blocker's own sentence, prefixed with the capability it is about. A
 * placeholder reading only "Not configured" leaves a person guessing which of
 * six things is missing, which is the failure the ordered blocker list exists
 * to prevent.
 */
export function blockReason(detail: string): string {
  return `${ROLE_LABEL[PRIMARY_ROLE]} is not configured — ${detail}`
}

/**
 * The block this snapshot calls for, or undefined when the composer may open.
 *
 * A pure function rather than a branch inside the effect, so the decision can
 * be tested as the decision. A test that re-derived the same condition beside
 * the component would agree with itself and prove nothing about what a person
 * gets.
 *
 * `idle` and `loading` deliberately produce nothing. Blocking a composer
 * because an answer has not arrived yet would make every reload look like a
 * misconfiguration — and the Host refuses an unbound route regardless, so the
 * safe direction here is to say nothing until something is known.
 *
 * @param snapshot - what the store currently knows.
 * @returns the block to raise, or undefined to lift any standing one.
 */
export function blockFor(snapshot: BindingSnapshot): { readonly reason: string } | undefined {
  if (snapshot.status !== 'ready') return undefined
  const chat = chatReadiness(snapshot)
  if (chat === null || isExecutable(chat) || chat.primaryBlocker === null) return undefined
  return { reason: blockReason(cardForBlocker(chat.primaryBlocker).detail) }
}

/**
 * Raise or clear this session's composer block, and offer the way out.
 *
 * @param props - see {@link ChatGateProps}.
 * @returns the setup card while Chat cannot run, and nothing once it can.
 */
export function ChatGate({ sessionId, store, blocks }: ChatGateProps): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [open, setOpen] = useState(false)

  // One load per mounted gate, not one per render. The store guards against a
  // slow answer landing after a newer one, so a second session mounting while
  // the first is loading does not produce a stale snapshot.
  useEffect(() => { void store.load() }, [store])

  const chat = chatReadiness(snapshot)
  const ready = chat !== null && isExecutable(chat)
  const card = chat === null || chat.primaryBlocker === null
    ? null
    : cardForBlocker(chat.primaryBlocker)

  // The same decision function the tests assert on, so what a person gets and
  // what is asserted cannot drift apart.
  const block = blockFor(snapshot)
  useEffect(() => {
    const registry = blocks()
    if (registry === undefined) return
    registry.set(sessionId, block)
    // Clearing on unmount matters: a session whose gate is gone must not keep
    // a block nothing is left to lift.
    return () => { registry.set(sessionId, undefined) }
  }, [blocks, sessionId, block?.reason])

  if (ready || card === null || chat === null) return null

  return (
    <section
      aria-label={`${ROLE_LABEL[PRIMARY_ROLE]} setup`}
      style={{
        border: '1px solid var(--watch-accent)',
        borderRadius: '10px',
        padding: '12px 14px',
        margin: '0 0 8px',
        background: 'var(--dsw-alias-bg-base)',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: '10px',
        justifyContent: 'space-between', flexWrap: 'wrap',
      }}
      >
        <h3 style={{ fontSize: '13px', fontWeight: 600, margin: 0 }}>{card.title}</h3>
        {/* The word, then the chip. Nothing here is carried by colour. */}
        <StatusChip tone="neutral">Not configured</StatusChip>
      </div>
      <p style={{
        fontSize: '12px', lineHeight: 1.55, margin: '6px 0 0',
        color: 'var(--dsw-alias-label-secondary)',
      }}
      >
        {card.detail}
      </p>

      {open
        ? (
            <BindingEditor
              row={{
                role: PRIMARY_ROLE,
                provider: null,
                model: null,
                readiness: chat,
              }}
              providers={snapshot.providers}
              saving={snapshot.saving}
              onBind={(provider, model) => {
                void store.bind(PRIMARY_ROLE, provider, model).then(() => { setOpen(false) })
              }}
              onCancel={() => { setOpen(false) }}
            />
          )
        : (
            <div style={CONTROL.row}>
              <button
                type="button"
                style={CONTROL.primary}
                disabled={!snapshot.writable}
                onClick={() => { setOpen(true) }}
              >
                {card.action}
              </button>
              <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>
                {/* Named rather than linked: the settings panel's open state is
                    local to its own component, so nothing can navigate there,
                    and a button that fails when pressed teaches people the
                    product is broken. */}
                Settings → Role Bindings has the full view.
              </span>
            </div>
          )}
    </section>
  )
}
