/**
 * Role Bindings, as a screen somebody can actually finish setup on.
 *
 * This surface used to be four rows of static copy saying "Not bound" and a
 * paragraph explaining that bindings were stored by DSH. Both true. Neither
 * gave anybody a way to bind anything — so a person who had saved an OpenRouter
 * credential arrived here, read that nothing was bound, and had no control to
 * change it. The screen described the product's design instead of operating it.
 *
 * What it does now is the four steps in order, because they *are* ordered and
 * pretending otherwise is what made a saved credential look like a finished
 * setup:
 *
 *   1. a provider has a credential          — stored, and nothing more
 *   2. that provider advertises models      — asked for, never assumed
 *   3. a model is assigned to a capability  — explicitly, by a person
 *   4. the capability can run                — derived, never stored
 *
 * **Nothing here is signalled by colour alone.** Every state carries the word
 * for it, and the chip is decoration on top of that word. A status conveyed by
 * a green dot is a status a screen reader does not have, and — as the incident
 * that produced this file showed — one a sighted reader misreads too.
 *
 * **Nothing is chosen implicitly.** There is no "use my only credential", no
 * defaulting to the first model in the list, and no provider that becomes
 * bound because it was configured. Every binding here is a button somebody
 * pressed.
 *
 * @module @deepwatch/dsh-client-settings/role-bindings
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  BINDABLE_ROLES, BINDING_STATUS_LABEL, CREDENTIAL_STATUS_LABEL, PRIMARY_ROLE,
  ROLE_LABEL, ROLE_PURPOSE, blockerMessage, isExecutable,
} from '@deepwatch/dsh-contracts'
import type { BindableRole, RoleReadiness } from '@deepwatch/dsh-contracts'
import { StatusChip, T } from './components.js'
import {
  DEEPSEEK_IS_OPTIONAL, HOSTED_COUNT, PROVIDER_COUNT, SAMPLE_PROVIDERS, SELF_HOSTED_COUNT,
} from '../providers.js'
import type { ChipTone } from './components.js'
import type { BindingSnapshot, BindingStore, ProviderRow, RoleRow } from './binding-state.js'

/** What the section is handed by whoever mounts it. */
export interface RoleBindingsProps {
  readonly store: BindingStore
}

/**
 * The tone a readiness status earns.
 *
 * `bound_unverified` is deliberately not `active`. That is precisely the state
 * a green dot used to claim, and claiming it is what sent a prompt to a
 * provider nobody had configured.
 */
function toneFor(readiness: RoleReadiness): ChipTone {
  if (isExecutable(readiness)) return 'active'
  return readiness.status === 'blocked' ? 'caution' : 'neutral'
}

/** The tone a credential state earns. Stored is not working. */
function credentialTone(status: string): ChipTone {
  if (status === 'verified') return 'active'
  if (status === 'rejected' || status === 'inaccessible') return 'caution'
  return 'neutral'
}

export const CONTROL = {
  select: {
    font: 'inherit', fontSize: '13px', padding: '7px 10px', borderRadius: '10px',
    border: '1px solid color-mix(in srgb, var(--watch-accent) 12%, var(--dsw-alias-border-l2))',
    background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
    minWidth: '180px', maxWidth: '100%',
  },
  primary: {
    font: 'inherit', fontSize: '13px', fontWeight: 600, padding: '8px 15px',
    borderRadius: '10px', cursor: 'pointer',
    border: '1px solid var(--watch-accent)',
    background: 'var(--watch-accent)', color: 'white',
    boxShadow: '0 6px 18px color-mix(in srgb, var(--watch-accent) 22%, transparent)',
  },
  quiet: {
    font: 'inherit', fontSize: '13px', padding: '8px 13px', borderRadius: '10px',
    cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)',
    background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent)', color: 'var(--dsw-alias-label-secondary)',
  },
  field: {
    display: 'flex', flexDirection: 'column' as const, gap: '4px', minWidth: 0,
  },
  label: {
    fontSize: '11px', letterSpacing: '0.03em', textTransform: 'uppercase' as const,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  // Wraps rather than scrolls: a narrow settings panel is the common case, and
  // a row of controls that overflows horizontally hides the one on the right.
  row: {
    display: 'flex', flexWrap: 'wrap' as const, gap: '10px',
    alignItems: 'flex-end', marginTop: '12px',
  },
}

/**
 * The editor for one role: pick a provider, pick one of its models, assign it.
 *
 * Two selects rather than one combined list, because the two choices fail
 * differently. A provider with no credential is a different problem from a
 * provider whose catalogue is empty, and a single flattened list would report
 * both as "nothing to choose".
 *
 * Exported because the blocked composer offers the same choice in place. A
 * person who is stopped from sending should be able to fix it where they are
 * standing, and offering them a *second* picker written separately is how two
 * screens end up disagreeing about what a provider offers.
 */
export function BindingEditor(
  { row, providers, saving, onBind, onCancel }: {
    readonly row: RoleRow
    readonly providers: readonly ProviderRow[]
    readonly saving: boolean
    readonly onBind: (provider: string, model: string) => void
    readonly onCancel: () => void
  },
): ReactNode {
  const providerId = useId()
  const modelId = useId()
  const noticeId = useId()
  const first = useRef<HTMLSelectElement>(null)

  const [provider, setProvider] = useState(row.provider ?? '')
  const [model, setModel] = useState(row.model ?? '')

  // Focus the first control when the editor opens: a person who pressed
  // "Choose a model" is already looking here, and leaving focus on the button
  // they just activated means the next Tab goes backwards through the card.
  useEffect(() => { first.current?.focus() }, [])

  const chosen = providers.find(entry => entry.provider === provider)
  const models = chosen?.models ?? []

  // The chosen model is cleared when the provider changes, rather than carried
  // over. A model id from one provider is not a model id for another, and
  // keeping it produced bindings that looked complete and could not run.
  const pickProvider = (next: string): void => {
    setProvider(next)
    setModel('')
  }

  const notice = chosen === undefined
    ? 'Choose a provider to see the models it offers.'
    : chosen.credential === 'absent'
      ? `${chosen.displayName} has no credential yet. Add one in Models & Providers, then come back.`
      : chosen.catalogError !== null
        ? `${chosen.displayName} did not return a model list.`
        : models.length === 0
          ? `${chosen.displayName} advertised no models.`
          : `${String(models.length)} model(s) offered by ${chosen.displayName}.`

  return (
    <div style={CONTROL.row}>
      <span style={CONTROL.field}>
        <label htmlFor={providerId} style={CONTROL.label}>Provider</label>
        <select
          id={providerId}
          ref={first}
          style={CONTROL.select}
          value={provider}
          disabled={saving}
          aria-describedby={noticeId}
          onChange={event => { pickProvider(event.target.value) }}
        >
          <option value="">Choose a provider…</option>
          {providers.map(entry => (
            <option key={entry.provider} value={entry.provider}>
              {`${entry.displayName} — ${CREDENTIAL_STATUS_LABEL[entry.credential]}`}
            </option>
          ))}
        </select>
      </span>

      <span style={CONTROL.field}>
        <label htmlFor={modelId} style={CONTROL.label}>Model</label>
        <select
          id={modelId}
          style={CONTROL.select}
          value={model}
          disabled={saving || models.length === 0}
          aria-describedby={noticeId}
          onChange={event => { setModel(event.target.value) }}
        >
          <option value="">Choose a model…</option>
          {models.map(entry => (
            <option key={entry.id} value={entry.id}>{entry.name === '' ? entry.id : entry.name}</option>
          ))}
        </select>
      </span>

      <button
        type="button"
        style={{ ...CONTROL.primary, opacity: provider === '' || model === '' || saving ? 0.5 : 1 }}
        disabled={provider === '' || model === '' || saving}
        onClick={() => { onBind(provider, model) }}
      >
        {saving ? 'Assigning…' : `Assign to ${ROLE_LABEL[row.role]}`}
      </button>
      <button type="button" style={CONTROL.quiet} onClick={onCancel} disabled={saving}>
        Cancel
      </button>

      <p
        id={noticeId}
        style={{
          flexBasis: '100%', margin: '2px 0 0', fontSize: '12px', lineHeight: 1.5,
          color: 'var(--dsw-alias-label-tertiary)',
        }}
      >
        {notice}
      </p>
    </div>
  )
}

/** One role: what it is, what it is bound to, and whether that can run. */
function RoleCard(
  { row, providers, snapshot, store, openEditor, editing, onEdit, onClose }: {
    readonly row: RoleRow
    readonly providers: readonly ProviderRow[]
    readonly snapshot: BindingSnapshot
    readonly store: BindingStore
    readonly openEditor: boolean
    readonly editing: BindableRole | null
    readonly onEdit: (role: BindableRole) => void
    readonly onClose: () => void
  },
): ReactNode {
  const provider = providers.find(entry => entry.provider === row.provider)
  const blocker = blockerMessage(row.readiness)
  const ready = isExecutable(row.readiness)

  return (
    <div style={T.card}>
      <div style={T.cardHead}>
        <h3 style={T.title}>{ROLE_LABEL[row.role]}</h3>
        {/* The word first, the chip second. The chip repeats the word rather
            than replacing it, so nothing here is carried by colour alone. */}
        <StatusChip tone={toneFor(row.readiness)}>
          {BINDING_STATUS_LABEL[row.readiness.status]}
        </StatusChip>
      </div>
      <p style={{ ...T.lead, margin: '6px 0 0' }}>{ROLE_PURPOSE[row.role]}</p>

      <div style={T.meta}>
        <span style={T.key}>Provider</span>
        <span style={T.value}>{provider?.displayName ?? row.provider ?? 'Nothing assigned'}</span>
        <span style={T.key}>Model</span>
        <span style={T.value}>{row.model ?? 'Nothing assigned'}</span>
        <span style={T.key}>Status</span>
        <span style={T.value}>
          {ready
            ? `${ROLE_LABEL[row.role]} can run.`
            : blocker ?? 'Not configured.'}
        </span>
      </div>

      {openEditor && editing === row.role
        ? (
            <BindingEditor
              row={row}
              providers={providers}
              saving={snapshot.saving}
              onBind={(chosenProvider, chosenModel) => {
                void store.bind(row.role, chosenProvider, chosenModel).then(onClose)
              }}
              onCancel={onClose}
            />
          )
        : (
            <div style={CONTROL.row}>
              <button
                type="button"
                style={CONTROL.primary}
                disabled={!snapshot.writable}
                aria-describedby={snapshot.writable ? undefined : 'watch-bindings-readonly'}
                onClick={() => { onEdit(row.role) }}
              >
                {row.model === null ? 'Choose a model' : 'Change model'}
              </button>
              {row.model === null
                ? null
                : (
                    <button
                      type="button"
                      style={CONTROL.quiet}
                      disabled={(snapshot.testingRole !== null && snapshot.testingRole !== row.role) || snapshot.saving}
                      onClick={() => {
                        if (snapshot.testingRole === row.role) store.cancelProviderTest()
                        else void store.testRole(row.role)
                      }}
                    >
                      {snapshot.testingRole === row.role ? 'Cancel provider test' : 'Run provider test'}
                    </button>
                  )}
              {row.model === null
                ? null
                : (
                    <button
                      type="button"
                      style={CONTROL.quiet}
                      disabled={!snapshot.writable || snapshot.saving}
                      aria-describedby={snapshot.writable ? undefined : 'watch-bindings-readonly'}
                      onClick={() => { void store.unbind(row.role) }}
                    >
                      {`Unassign ${ROLE_LABEL[row.role]}`}
                    </button>
                  )}
            </div>
          )}
    </div>
  )
}

/** The providers a person has actually configured, and what is known of each. */
function ProviderList({ providers }: { readonly providers: readonly ProviderRow[] }): ReactNode {
  const configured = providers.filter(entry => entry.credential !== 'absent')
  if (configured.length === 0) {
    return (
      <div style={{ ...T.card, borderStyle: 'dashed' }}>
        <div style={T.cardHead}>
          <h3 style={T.title}>No provider is configured yet</h3>
          <StatusChip tone="neutral">No credential</StatusChip>
        </div>
        <p style={{ ...T.lead, margin: '8px 0 0' }}>
          Add a credential in the Harness’s own Models &amp; Providers screen. A
          saved credential is the first of four steps — it stores a key and
          assigns nothing.
        </p>
      </div>
    )
  }
  return (
    <>
      {/* The catalogue, before the configured rows: a person whose only
          provider is one they half-set-up should be able to see that there are
          thirty-odd others and that none of them is required. The numbers are
          generated from the pinned catalogue, never typed. */}
      <div style={T.card}>
        <div style={T.cardHead}>
          <h3 style={T.title}>{`${String(PROVIDER_COUNT)} routes are available`}</h3>
          <StatusChip tone="neutral">
            {`${String(configured.length)} configured`}
          </StatusChip>
        </div>
        <p style={{ ...T.lead, margin: '8px 0 0' }}>
          {`${String(HOSTED_COUNT)} hosted and ${String(SELF_HOSTED_COUNT)} where you supply the endpoint — `}
          {SAMPLE_PROVIDERS.join(', ')}
          {' and others. Watch adds none of these and removes none of them: the '}
          {'catalogue is the Harness’s, reached through its own Models & Providers screen.'}
        </p>
        <div style={T.meta}>
          <span style={T.key}>A local model</span>
          <span style={T.value}>
            An OpenAI-compatible server you run — Ollama, vLLM, LM Studio,
            llama.cpp — is a base URL you supply, not a separate feature.
          </span>
          <span style={T.key}>DeepSeek</span>
          <span style={T.value}>
            {DEEPSEEK_IS_OPTIONAL
              ? 'One route among many. Nothing here requires it, and nothing selects it for you.'
              : 'The only route in this catalogue.'}
          </span>
        </div>
      </div>
      {configured.map(entry => (
        <div key={entry.provider} style={T.card}>
          <div style={T.cardHead}>
            <h3 style={T.title}>{entry.displayName}</h3>
            <StatusChip tone={credentialTone(entry.credential)}>
              {CREDENTIAL_STATUS_LABEL[entry.credential]}
            </StatusChip>
          </div>
          <div style={T.meta}>
            <span style={T.key}>Route</span>
            <span style={T.value}>{entry.active ? 'Served by an adapter' : 'Not currently served'}</span>
            <span style={T.key}>Models offered</span>
            <span style={T.value}>
              {entry.catalogError !== null
                ? 'The provider did not return a list.'
                : entry.models.length === 0
                  ? 'None advertised.'
                  : String(entry.models.length)}
            </span>
            <span style={T.key}>Credential save</span>
            <span style={T.value}>
              Does not contact the provider. Tests are explicit and apply to
              one exact provider/model binding.
            </span>
          </div>
        </div>
      ))}
    </>
  )
}

/**
 * Role Bindings.
 *
 * @param props.store - the binding store this surface reads and writes.
 * @returns the section body.
 */
export function RoleBindings({ store }: RoleBindingsProps): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [editing, setEditing] = useState<BindableRole | null>(null)

  useEffect(() => { void store.load() }, [store])

  const onEdit = useCallback((role: BindableRole) => { setEditing(role) }, [])
  const onClose = useCallback(() => { setEditing(null) }, [])

  const chat = useMemo(
    () => snapshot.roles.find(row => row.role === PRIMARY_ROLE) ?? null,
    [snapshot.roles])

  if (snapshot.status === 'error') {
    return (
      <div style={T.page}>
        <div style={{ ...T.card, borderStyle: 'dashed' }}>
          <div style={T.cardHead}>
            <h3 style={T.title}>Settings could not be read</h3>
            <StatusChip tone="caution">Unavailable</StatusChip>
          </div>
          <p style={{ ...T.lead, margin: '8px 0 0' }}>
            The Harness did not answer. Nothing has been changed, and no
            capability has been reconfigured.
          </p>
          <div style={CONTROL.row}>
            <button type="button" style={CONTROL.primary} onClick={() => { void store.load() }}>
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={T.page}>
      <p style={T.lead}>
        A capability is assigned per role, not per provider. One provider may
        serve several roles, and a role with nothing assigned says so — it never
        falls back to another role’s model, and a stored credential never
        assigns itself.
      </p>

      {/* Every control below is disabled when the Harness will not accept a
          settings write, and three greyed-out buttons with no reason is the
          kind of screen a person blames themselves for. The reason is stated
          once, here, and referenced by the controls it explains. */}
      {snapshot.writable
        ? null
        : (
            <div id="watch-bindings-readonly" style={{ ...T.card, borderStyle: 'dashed' }}>
              <div style={T.cardHead}>
                <h3 style={T.title}>Settings are read-only</h3>
                <StatusChip tone="caution">Not writable</StatusChip>
              </div>
              <p style={{ ...T.lead, margin: '8px 0 0' }}>
                This Workspace was opened against a configuration the Harness
                will not let it change, so assignments cannot be edited here.
                Nothing is wrong with the capabilities themselves — what is
                shown below is accurate and read from the running system.
              </p>
            </div>
          )}

      {/* The one thing a person has to finish before a conversation works, at
          the top and stated as a fact rather than a warning. It disappears the
          moment Chat can run, so a configured product is not still being told
          to configure itself. */}
      {chat !== null && !isExecutable(chat.readiness)
        ? (
            <div style={{ ...T.card, borderColor: 'var(--watch-accent)' }}>
              <div style={T.cardHead}>
                <h3 style={T.title}>Chat is not ready yet</h3>
                <StatusChip tone="neutral">{BINDING_STATUS_LABEL[chat.readiness.status]}</StatusChip>
              </div>
              <p style={{ ...T.lead, margin: '8px 0 0' }}>
                {blockerMessage(chat.readiness) ?? 'Choose a provider and model for Chat.'}
                {' Until then the composer stays closed and nothing is sent.'}
              </p>
              <div style={CONTROL.row}>
                <button
                  type="button"
                  style={CONTROL.primary}
                  disabled={!snapshot.writable}
                  aria-describedby={snapshot.writable ? undefined : 'watch-bindings-readonly'}
                  onClick={() => { setEditing(PRIMARY_ROLE) }}
                >
                  Choose models and roles
                </button>
              </div>
            </div>
          )
        : null}

      {/* Announced rather than only drawn: a save that changes a chip a person
          is not looking at is a save they have no way to know happened. */}
      <p
        role="status"
        aria-live="polite"
        style={{
          margin: '0 0 10px', fontSize: '12px',
          color: 'var(--dsw-alias-label-tertiary)',
          minHeight: '1em',
        }}
      >
        {snapshot.saving
          ? 'Saving the assignment…'
          : snapshot.testingRole !== null
            ? `Testing ${ROLE_LABEL[snapshot.testingRole]} with one bounded provider request…`
            : snapshot.testMessage !== null
              ? snapshot.testMessage
          : snapshot.error !== null
            ? snapshot.error
            : ''}
      </p>

      <h2 style={T.h2}>Capabilities</h2>
      {BINDABLE_ROLES.map((role) => {
        const row = snapshot.roles.find(entry => entry.role === role)
        return row === undefined
          ? null
          : (
              <RoleCard
                key={role}
                row={row}
                providers={snapshot.providers}
                snapshot={snapshot}
                store={store}
                openEditor={editing === role}
                editing={editing}
                onEdit={onEdit}
                onClose={onClose}
              />
            )
      })}

      <h2 style={T.h2}>Providers</h2>
      <ProviderList providers={snapshot.providers} />

      <p style={T.note}>
        Assignments are stored beside the Harness’s own settings, and reference
        a credential rather than holding one. Watch keeps no second credential
        store and never sees a key.
      </p>
    </div>
  )
}
