/**
 * The browser's view of what is configured, assembled from four Host answers.
 *
 * A person saved an OpenRouter credential, saw a green dot and the words
 * "Saved openrouter.", and reasonably concluded the product was ready. It was
 * not: no model had been chosen and nothing had been assigned to anything. The
 * dot was answering "is a credential stored?" while the reader was asking "can
 * I send a message?", and those turn out to be four separate questions.
 *
 * So this store never derives readiness itself. It gathers the four facts —
 * from `llm.providers`, `llm.models`, `credentials.describe` and the stored
 * bindings in `settings.describe` — and hands them to `roleReadiness`, which
 * is the only thing in this product allowed to answer "ready". A surface that
 * wanted to shade a dot green would have to go through the same gate.
 *
 * **Nothing here contacts a provider.** Opening a settings page must not spend
 * somebody's money or rate budget, so reachability stays `unknown` until a
 * person asks for a check. That is why a freshly saved credential reads
 * "Credential saved · not yet assigned" rather than a claim about whether it
 * works: the honest state after a save is *stored*, and the product says so.
 *
 * **No value crosses this boundary.** `credentials.describe` is structurally
 * value-free — it answers `configured`, `source`, `writable` and has no slot
 * for a value — and the binding this store writes holds a reference the Host
 * resolves. There is nowhere in this file for a key to be, which is the
 * property that makes the store safe to render, log and screenshot.
 *
 * @module @deepwatch/dsh-client-settings/binding-state
 */

import {
  BINDABLE_ROLES, BINDINGS_NAMESPACE, BINDINGS_VERSION, EMPTY_BINDINGS, PRIMARY_ROLE,
  ROLE_MODALITIES, assertNoSecretMaterial, bindingFor, readBindings, roleReadiness,
  withBinding, withoutBinding,
} from '@deepwatch/dsh-contracts'
import type {
  BindableRole, ProviderCredentialStatus, ProviderReachability, RoleReadiness,
  RouteCapability, WatchBindings,
} from '@deepwatch/dsh-contracts'

/**
 * Upstream's own settings section for the selection a new session starts with.
 *
 * Spelled here rather than imported: `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`
 * lives in a Host package, and a browser bundle that imported it would carry
 * the Harness's server-side settings machinery to learn one string.
 * `tests/binding-flow.test.mjs` holds it to the value the pinned baseline
 * composes.
 */
export const DEFAULT_MODEL_NAMESPACE = 'agent-default-model'

/* ── the Host surface this store uses ───────────────────────────────────── */

/**
 * The RPC envelope, narrowed to what a caller reads.
 *
 * Declared structurally rather than imported, which is the same choice
 * `./index.tsx` makes for the slot service. A browser bundle that imported the
 * Host's contract package for four method signatures would carry the whole
 * gateway's types to describe calls it makes by name anyway.
 */
type Rpc<T> = { readonly result: { ok: true, value: T } | { ok: false, error: { code: string, message: string } } }

/** One namespace as the settings domain describes it. */
export interface NamespaceView {
  readonly ns: string
  readonly value: unknown
  readonly user?: unknown
  readonly revision: number
}

/** One provider route, as the provider directory describes it. */
export interface ProviderView {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  /** Whether an adapter currently serves the route. */
  readonly active: boolean
}

/** One model a provider advertised. */
export interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One provider and the models it advertised. */
export interface ModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly CatalogModel[]
}

/** What the Host will answer about a credential. Never a value. */
export interface CredentialView {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/** The Host methods this store calls, by the names the gateway gives them. */
export interface HostApi {
  readonly settings: {
    describe(payload: Record<string, never>): Promise<Rpc<{
      writable: boolean
      namespaces: readonly NamespaceView[]
    }>>
    replace(payload: { ns: string, section: object, expectedRevision?: number }):
    Promise<Rpc<NamespaceView>>
  }
  readonly llm: {
    providers(payload: Record<string, never>): Promise<Rpc<{ providers: readonly ProviderView[] }>>
    models(payload: Record<string, never>): Promise<Rpc<{
      groups: readonly ModelGroup[]
      failures: readonly { id: string, message: string }[]
    }>>
  }
  readonly credentials: {
    describe(payload: { refs: string[] }): Promise<Rpc<{
      credentials: Record<string, CredentialView>
    }>>
  }
}

/**
 * The identity a provider test result belongs to.
 *
 * Provider and model alone are not enough. Rebinding a role to a route served
 * through a different credential must not inherit the previous verdict — that
 * is the same "saved means working" claim this whole file exists to remove,
 * wearing a route it was never asked about. So the credential *reference* is
 * part of the key.
 *
 * What it deliberately cannot see: a value rotated behind a reference that
 * did not change. No credential value crosses this boundary, so the browser
 * half has nothing to compare. A result therefore lives only as long as the
 * session that produced it, and is never persisted or restored — an untested
 * binding after a reload reads as untested, which is the truthful answer.
 */
export function providerTestKey(
  provider: string, model: string, credentialRef: string | null,
): string {
  return [provider, model, credentialRef ?? ''].join('\u0000')
}

/** Provider-neutral result of the explicit, user-triggered one-token test. */
export interface ProviderTestFacts {
  readonly provider: string
  readonly model: string
  readonly ok: boolean
  readonly credential: 'configured_unverified' | 'verified' | 'rejected'
  readonly reachability: Exclude<ProviderReachability, 'unknown'>
  readonly message: string
}

export type ProviderTester = (
  provider: string, model: string, signal: AbortSignal,
) => Promise<ProviderTestFacts>

/** The Host's own verdict on one route, and why, when it is not ready. */
export interface RouteReadinessFacts {
  readonly proved: boolean
  readonly reason: 'proved' | 'never_tested' | 'configuration_changed' | 'unreadable'
}

/**
 * Ask the Host whether it would serve a route, without spending anything.
 *
 * Optional, because a deployment may mount this panel against a Host without
 * the read plane. Absent, the tab falls back to its own memory of the tests it
 * ran — which is what this exists to stop being the only answer, and is still
 * better than refusing to draw the screen.
 */
export type RouteReadinessReader = (
  provider: string, model: string, signal: AbortSignal,
) => Promise<RouteReadinessFacts>

/* ── what a surface renders from ────────────────────────────────────────── */

/** One provider, with everything a setup screen needs to talk about it. */
export interface ProviderRow {
  readonly provider: string
  readonly displayName: string
  /** Whether an adapter serves the route right now. */
  readonly active: boolean
  /** The opaque handle the Host resolves a credential through. Never a value. */
  readonly credentialRef: string | null
  readonly credential: ProviderCredentialStatus
  /** Models the provider advertised, empty when it advertised none. */
  readonly models: readonly CatalogModel[]
  /** Why the catalogue is empty, when the provider said. */
  readonly catalogError: string | null
}

/** One role, its stored decision, and whether that decision can run. */
export interface RoleRow {
  readonly role: BindableRole
  readonly provider: string | null
  readonly model: string | null
  readonly readiness: RoleReadiness
}

/** Everything a binding surface reads. */
export interface BindingSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** A message for the reader when the Host could not be asked. */
  readonly error: string | null
  /** False when the settings document cannot be written here. */
  readonly writable: boolean
  readonly providers: readonly ProviderRow[]
  readonly roles: readonly RoleRow[]
  /** The stored document, for a surface that needs the raw decision. */
  readonly bindings: WatchBindings
  /** True while a write is in flight, so a form can disable itself. */
  readonly saving: boolean
  readonly testingRole: BindableRole | null
  readonly testMessage: string | null
}

const EMPTY: BindingSnapshot = {
  status: 'idle',
  error: null,
  writable: false,
  providers: [],
  roles: [],
  bindings: EMPTY_BINDINGS,
  saving: false,
  testingRole: null,
  testMessage: null,
}

/* ── deriving the four facts ────────────────────────────────────────────── */

/**
 * The credential reference a provider's own settings section names.
 *
 * Walked out of the described value rather than asked for separately: the
 * settings domain already returns each namespace's resolved value, and
 * `apiKeyEnv` is a field in it. The walk is plain property access because the
 * described value is plain JSON — the secret slots have already been removed
 * by the seam, which is what makes reading this safe.
 */
export function credentialRefOf(
  view: NamespaceView | undefined, path: readonly string[],
): string | null {
  if (view === undefined) return null
  let cursor: unknown = view.value
  for (const step of path) {
    if (typeof cursor !== 'object' || cursor === null) return null
    cursor = (cursor as Record<string, unknown>)[step]
  }
  if (typeof cursor !== 'object' || cursor === null) return null
  const ref = (cursor as Record<string, unknown>)['apiKeyEnv']
  return typeof ref === 'string' && ref !== '' ? ref : null
}

/**
 * What is known about a provider's credential.
 *
 * `configured_unverified` rather than `verified` is the whole point. The Host
 * can say a value resolves; only a provider can say it works, and nothing here
 * has asked one. Calling a stored credential verified is the claim that sent a
 * prompt to a provider nobody had configured.
 */
export function credentialStatusOf(
  ref: string | null, described: Record<string, CredentialView>, readable: boolean,
): ProviderCredentialStatus {
  if (ref === null) return 'absent'
  // A store that could not be read is a fault to report, not an empty slot to
  // fill: telling somebody to add a credential they already added is how a
  // person ends up entering a key three times.
  if (!readable) return 'inaccessible'
  return described[ref]?.configured === true ? 'configured_unverified' : 'absent'
}

/** The route capability a provider row amounts to. */
function routeOf(row: ProviderRow | undefined, role: BindableRole): RouteCapability | null {
  if (row === undefined || !row.active) return null
  return {
    provider: row.provider,
    // Every bindable role, because DSH's directory describes routes rather
    // than roles: a chat-completions endpoint is not annotated with which of
    // this product's capabilities it could serve. Narrowing it here would
    // invent a restriction the provider never stated.
    roles: [...BINDABLE_ROLES],
    modalities: ROLE_MODALITIES[role],
    // Null, not empty, when the provider advertised nothing: "nobody asked" and
    // "the provider offers no models" are different, and only the second one
    // should make a stored model read as unavailable.
    models: row.models.length === 0 ? null : row.models.map(model => model.id),
  }
}

/** Everything known about one role, folded through the single readiness gate. */
export function roleRowOf(
  role: BindableRole, bindings: WatchBindings, providers: readonly ProviderRow[],
  tests: ReadonlyMap<string, ProviderTestFacts> = new Map(),
): RoleRow {
  const binding = bindingFor(bindings, role)
  const row = binding === null
    ? undefined
    : providers.find(entry => entry.provider === binding.provider)
  const route = routeOf(row, role)
  const known = route?.models ?? null
  const tested = binding === null
    ? undefined
    : tests.get(providerTestKey(binding.provider, binding.model, row?.credentialRef ?? null))
  const readiness = roleReadiness(role, {
    binding,
    credential: tested?.credential ?? row?.credential ?? 'absent',
    // Never probed from a settings page. A person asks for a check; opening a
    // screen is not asking.
    reachability: tested?.reachability ?? 'unknown',
    model: binding === null
      ? 'none'
      : known === null || known.includes(binding.model) ? 'selected' : 'unavailable',
    route,
    consentGranted: true,
    policyPermits: true,
    contractMatches: true,
  })
  return {
    role,
    provider: binding?.provider ?? null,
    model: binding?.model ?? null,
    readiness,
  }
}

/* ── the store ──────────────────────────────────────────────────────────── */

/**
 * The binding store, shaped for `useSyncExternalStore`.
 *
 * Deliberately a plain object with `subscribe`/`getSnapshot` rather than a
 * framework store: this package's browser half is loaded into somebody else's
 * React tree, and bringing a state library into a plugin bundle to hold six
 * fields is how a distribution ends up shipping two of them.
 */
export class BindingStore {
  private snapshot: BindingSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  /** Guards against a slow load landing after a newer one. */
  private generation = 0
  private revision: number | undefined
  private defaultRevision: number | undefined
  private readonly providerTests = new Map<string, ProviderTestFacts>()
  private providerTestAbort: AbortController | null = null

  constructor(
    private readonly api: HostApi,
    private readonly providerTester?: ProviderTester,
    private readonly readinessReader?: RouteReadinessReader,
  ) {}

  /**
   * Replace what this tab believes about tested routes with what the Host says.
   *
   * The browser used to be the only place a provider-test verdict lived, and a
   * tab cannot see a Host restart, an edit made in another tab, or a key
   * rotated behind a reference that did not change. It drew a tested badge over
   * routes the Host had already stopped being willing to serve, and the
   * composer that badge unlocks opened onto a refusal.
   *
   * So the Host is asked, per bound route, and its answer wins in both
   * directions: a route it still proves is tested even in a tab that has just
   * been reloaded and ran no test, and a route it no longer proves stops being
   * tested here the moment this is read.
   */
  private async reconcileReadiness(
    bindings: WatchBindings, providers: readonly ProviderRow[], signal: AbortSignal,
  ): Promise<void> {
    if (this.readinessReader === undefined) return
    for (const role of BINDABLE_ROLES) {
      const binding = bindingFor(bindings, role)
      if (binding === null) continue
      const credentialRef = providers
        .find(entry => entry.provider === binding.provider)?.credentialRef ?? null
      const key = providerTestKey(binding.provider, binding.model, credentialRef)
      let verdict: RouteReadinessFacts
      try {
        verdict = await this.readinessReader(binding.provider, binding.model, signal)
      } catch {
        // A read that failed says nothing about the route, and inventing
        // either answer would be the defect. The tab keeps what it has.
        continue
      }
      if (signal.aborted) return
      if (verdict.proved) {
        this.providerTests.set(key, {
          provider: binding.provider,
          model: binding.model,
          ok: true,
          credential: 'verified',
          reachability: 'reachable',
          // Deliberately not "the provider test succeeded": this tab did not
          // run one. What is true is that the Host still holds the proof.
          message: 'The Host still holds a proof for this route.',
        })
      } else {
        this.providerTests.delete(key)
      }
    }
  }

  /** @returns the current snapshot; stable between changes. */
  getSnapshot = (): BindingSnapshot => this.snapshot

  /** @param listener - called after every change. @returns the unsubscriber. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(next: Partial<BindingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  /**
   * Ask the Host everything, and fold it into one snapshot.
   *
   * The three reads run together because they are independent and a settings
   * page that took three round trips in series felt broken on a slow link.
   * Their failures are not equal, though: providers and settings are the page,
   * so losing either is an error, while a credential describe that fails
   * downgrades those providers to `inaccessible` and leaves the rest readable.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.publish({ status: 'loading', error: null })

    let providers: readonly ProviderView[]
    let namespaces: readonly NamespaceView[]
    let groups: readonly ModelGroup[] = []
    let failures: readonly { id: string, message: string }[] = []
    let writable = false
    try {
      const [directory, settings, catalogue] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
        // A catalogue read can fail per provider without failing the page, so
        // its rejection is absorbed rather than allowed to take the load down.
        this.api.llm.models({}).catch(() => null),
      ])
      if (!directory.result.ok) throw new Error(directory.result.error.message)
      if (!settings.result.ok) throw new Error(settings.result.error.message)
      providers = directory.result.value.providers
      namespaces = settings.result.value.namespaces
      writable = settings.result.value.writable
      if (catalogue !== null && catalogue.result.ok) {
        groups = catalogue.result.value.groups
        failures = catalogue.result.value.failures
      }
    } catch (error) {
      if (generation !== this.generation) return
      this.publish({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const byNs = new Map(namespaces.map(view => [view.ns, view]))
    const stored = byNs.get(BINDINGS_NAMESPACE)
    this.revision = stored?.revision
    const bindings = readBindings(stored?.value)

    const refs = new Map<string, string | null>()
    for (const entry of providers) {
      refs.set(entry.provider, credentialRefOf(byNs.get(entry.settingsNs), entry.settingsPath))
    }
    const wanted = [...new Set([...refs.values()].filter((ref): ref is string => ref !== null))]

    let credentials: Record<string, CredentialView> = {}
    let readable = true
    if (wanted.length > 0) {
      try {
        const answer = await this.api.credentials.describe({ refs: wanted })
        if (answer.result.ok) credentials = answer.result.value.credentials
        else readable = false
      } catch {
        readable = false
      }
    }
    if (generation !== this.generation) return

    const catalogByProvider = new Map(groups.map(group => [group.id, group]))
    const failureByProvider = new Map(failures.map(entry => [entry.id, entry.message]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const ref = refs.get(entry.provider) ?? null
      return {
        provider: entry.provider,
        displayName: entry.displayName,
        active: entry.active,
        credentialRef: ref,
        credential: credentialStatusOf(ref, credentials, readable),
        models: catalogByProvider.get(entry.provider)?.models ?? [],
        catalogError: failureByProvider.get(entry.provider) ?? null,
      }
    })

    // Before the first publish, so no frame is ever drawn from this tab's own
    // memory when the Host has a different answer.
    const readiness = new AbortController()
    await this.reconcileReadiness(bindings, rows, readiness.signal)
    if (generation !== this.generation) return

    this.publish({
      status: 'ready',
      error: null,
      writable,
      providers: rows,
      bindings,
      roles: BINDABLE_ROLES.map(role => roleRowOf(role, bindings, rows, this.providerTests)),
    })

    // The binding is the authority; the Harness selection is a projection of
    // it. Reconciling on read rather than only on write means a profile bound
    // by an earlier build -- or a settings file somebody edited by hand -- is
    // repaired by being looked at, instead of staying in the state this whole
    // subsystem exists to prevent: a decision recorded, and a runtime that
    // never heard about it.
    if (writable) await this.reconcileDefaultSelection(bindings, byNs.get(DEFAULT_MODEL_NAMESPACE))
  }

  /**
   * Write the Harness selection only when it disagrees with the binding.
   *
   * Guarded on disagreement because this runs on every load: rewriting an
   * already-correct section would bump its revision, invalidate every other
   * open editor's `expectedRevision`, and turn a read into a source of write
   * conflicts.
   */
  private async reconcileDefaultSelection(
    bindings: WatchBindings, view: NamespaceView | undefined,
  ): Promise<void> {
    this.defaultRevision = view?.revision
    const chat = bindings.roles[PRIMARY_ROLE]
    const wanted = chat === undefined
      ? { provider: '', model: '' }
      : { provider: chat.provider, model: chat.model }
    const current = (view?.value ?? {}) as { provider?: unknown, model?: unknown }
    if (current.provider === wanted.provider && current.model === wanted.model) return
    await this.syncDefaultSelection(bindings)
  }

  /**
   * Bind one role to one provider and model, and persist the decision.
   *
   * `replace` rather than `update`, because unbinding has to be expressible:
   * a merge cannot remove a key, and a role that could be added but not
   * removed is a role somebody is stuck with. The whole document is rewritten
   * from the snapshot the caller is looking at, and `expectedRevision` is what
   * turns a concurrent edit into a refusal rather than a silent overwrite.
   */
  async bind(role: BindableRole, provider: string, model: string): Promise<void> {
    const row = this.snapshot.providers.find(entry => entry.provider === provider)
    await this.write(withBinding(this.snapshot.bindings, role, {
      provider,
      model,
      credentialRef: row?.credentialRef ?? null,
      boundAt: new Date().toISOString(),
    }))
  }

  /** Remove one role's binding. The role becomes unbound, never inherited. */
  async unbind(role: BindableRole): Promise<void> {
    await this.write(withoutBinding(this.snapshot.bindings, role))
  }

  /** Run the exact bound route once; saving a credential never calls this. */
  async testRole(role: BindableRole): Promise<void> {
    const binding = bindingFor(this.snapshot.bindings, role)
    if (binding === null || this.providerTester === undefined) {
      this.publish({ testMessage: 'Assign a provider and model before running the test.' })
      return
    }
    const credentialRef = this.snapshot.providers
      .find(entry => entry.provider === binding.provider)?.credentialRef ?? null
    const controller = new AbortController()
    this.providerTestAbort?.abort()
    this.providerTestAbort = controller
    this.publish({ testingRole: role, testMessage: null })
    try {
      const facts = await this.providerTester(binding.provider, binding.model, controller.signal)
      if (controller.signal.aborted) return
      this.providerTests.set(
        providerTestKey(binding.provider, binding.model, credentialRef), facts)
      this.publish({
        testingRole: null,
        testMessage: facts.message,
        roles: BINDABLE_ROLES.map(current => roleRowOf(
          current, this.snapshot.bindings, this.snapshot.providers, this.providerTests,
        )),
      })
    } catch {
      if (controller.signal.aborted) return
      this.publish({
        testingRole: null,
        testMessage: 'The provider test could not be started. Check Diagnostics and try again.',
      })
    } finally {
      if (this.providerTestAbort === controller) this.providerTestAbort = null
    }
  }

  /** Cancel only the explicit provider probe; no Chat turn is involved. */
  cancelProviderTest(): void {
    if (this.providerTestAbort === null) return
    this.providerTestAbort.abort()
    this.providerTestAbort = null
    this.publish({
      testingRole: null,
      testMessage: 'Provider test cancelled. This binding remains not tested.',
    })
  }

  /**
   * Point the Harness's own default selection at what Chat is bound to.
   *
   * The link this subsystem was missing, and the failure it caused is worth
   * stating plainly: a person added a provider, chose a model and assigned it
   * to Chat, and still could not send. Every DeepWatch surface agreed the
   * binding existed. It did — in DeepWatch's document. But the thing that
   * actually routes a prompt is the Harness's model selection, which this
   * distribution had *emptied* so that nothing would be chosen for anybody,
   * and binding Chat never filled it in. Two records of one decision, and the
   * one the runtime reads was the one nobody was writing.
   *
   * So a Chat binding writes both. `agent-default-model` is upstream's own
   * settings section, read live by `AgentDefaultModelConfig` and re-read by a
   * blank session on every look — so a session opened before the binding
   * picks it up without being told.
   *
   * Only Chat. The other roles are DeepWatch's own concepts and have no
   * upstream selection to keep in step; writing one for them would point the
   * conversation at a model chosen for something else.
   */
  private async syncDefaultSelection(next: WatchBindings): Promise<void> {
    const chat = next.roles[PRIMARY_ROLE]
    const section = chat === undefined
      // Emptied rather than removed: the row stays mounted and its schema
      // requires both keys, so "nothing chosen" is two empty strings -- which
      // is exactly the value a fresh profile composes.
      ? { provider: '', model: '' }
      : { provider: chat.provider, model: chat.model }
    try {
      const response = await this.api.settings.replace({
        ns: DEFAULT_MODEL_NAMESPACE,
        section,
        ...this.defaultRevision === undefined ? {} : { expectedRevision: this.defaultRevision },
      })
      if (response.result.ok) this.defaultRevision = response.result.value.revision
      else this.publish({ error: response.result.error.message })
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async write(next: WatchBindings): Promise<void> {
    // Before the document leaves the browser, not after somebody reports it in
    // a screenshot. Every write path builds this from a picker, so a value
    // matching a credential shape means a code path started copying one.
    assertNoSecretMaterial('the binding document', next)
    this.publish({ saving: true, error: null })
    try {
      const response = await this.api.settings.replace({
        ns: BINDINGS_NAMESPACE,
        section: { version: BINDINGS_VERSION, roles: next.roles },
        ...this.revision === undefined ? {} : { expectedRevision: this.revision },
      })
      if (!response.result.ok) {
        this.publish({ saving: false, error: response.result.error.message })
        return
      }
      this.revision = response.result.value.revision
      const bindings = readBindings(response.result.value.value)
      // After the binding is durable, never before: a default pointing at a
      // binding that failed to save would route somewhere the record does not
      // admit to.
      await this.syncDefaultSelection(bindings)
      this.publish({
        saving: false,
        bindings,
        roles: BINDABLE_ROLES.map(role => roleRowOf(
          role, bindings, this.snapshot.providers, this.providerTests,
        )),
      })
    } catch (error) {
      this.publish({
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * Whether the capability a conversation needs can actually run.
 *
 * The one question the composer asks, given its own name so no surface has to
 * remember which role Chat is or re-derive readiness to find out.
 */
export function chatReadiness(snapshot: BindingSnapshot): RoleReadiness | null {
  return snapshot.roles.find(row => row.role === PRIMARY_ROLE)?.readiness ?? null
}
