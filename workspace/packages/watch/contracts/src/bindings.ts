/**
 * What a person actually chose: which provider, which model, for which role.
 *
 * {@link module:@deepwatch/dsh-contracts/readiness} answers "can this run?"
 * from four separate facts. This module is where three of those facts are
 * *kept* — a durable document recording the decisions, so that reopening the
 * product finds the same bindings rather than an empty screen and a composer
 * pointed at somebody else's default.
 *
 * **A binding is a reference, never a credential.** The document below can be
 * read by anything: it is written to the Harness's own settings file, it rides
 * the settings RPC, it appears in Diagnostics, and it is included in a session
 * export. None of that is safe unless the rule is absolute, so it is: the only
 * credential-shaped field here is {@link RoleBindingRecord.credentialRef}, an
 * opaque handle the Host resolves against its own store. No value, no prefix,
 * no suffix, no length, no hash. {@link assertNoSecretMaterial} is the test
 * this file is held to.
 *
 * **Nothing is bound implicitly.** There is no "default role", no inheritance
 * from one role to another, and no provider that becomes bound because it was
 * the only one configured. A role with no entry in {@link WatchBindings.roles}
 * is unbound, and unbound means the composer refuses. That is the whole point
 * of the module: the failure it exists to prevent was a product that treated a
 * saved credential as a decision the person never made.
 *
 * @module @deepwatch/dsh-contracts/bindings
 */

import type { Modality, RoleBinding } from './readiness.js'

/**
 * The settings namespace this document lives in.
 *
 * A DeepWatch-owned section of the Harness's own user-settings document, which
 * is what makes the binding durable, hot-reloaded and editable by hand without
 * DeepWatch inventing a second configuration store beside the one the product
 * already has.
 */
export const BINDINGS_NAMESPACE = 'watch-bindings'

/**
 * The document revision this build writes.
 *
 * Read forward, never rewritten in place: an older document is migrated on
 * read and a newer one is refused rather than silently reinterpreted, because
 * misreading a binding routes somebody's prompt somewhere they did not choose.
 */
export const BINDINGS_VERSION = 1

/**
 * The roles a person can bind to a provider, in the order setup presents them.
 *
 * These ids are `RoleId`s from `@deepwatch/dsh-technology`, spelled here rather
 * than imported because `contracts` is the package everything else depends on
 * and must not depend on anything. `tests/bindings-store.test.mjs` asserts the
 * two lists agree, so the duplication is checked rather than trusted -- one
 * role vocabulary with a gate on it, instead of two that drift.
 *
 * It is a *subset*. `verifier`, `ocr_layout`, `reranking` and
 * `speaker_diarization` are served by local engines rather than chosen from a
 * provider catalogue, so offering them here would offer a choice that is not
 * there.
 *
 * `agent_model` is first and is the only one the first conversation needs. The
 * rest are progressive: a product that demanded five bindings before the first
 * message would be a product nobody finished configuring.
 */
export const BINDABLE_ROLES = [
  'agent_model', 'visual_perception', 'asr', 'audio_understanding', 'embeddings',
] as const

/** One of the roles this product knows how to bind. */
export type BindableRole = (typeof BINDABLE_ROLES)[number]

/** The role the first conversation needs, named once so nothing spells it twice. */
export const PRIMARY_ROLE: BindableRole = 'agent_model'

/**
 * What each role is called on screen.
 *
 * `agent_model` is labelled **Chat**, and the difference is not cosmetic. A
 * person configuring this product is not choosing an "agent model" -- they are
 * choosing what answers them in the surface the Harness calls Chat, and every
 * blocked-composer message and setup step has to name the thing they are
 * looking at. The id stays `agent_model` because that is the vocabulary the
 * descriptors and the routing rules already use.
 */
export const ROLE_LABEL: Readonly<Record<BindableRole, string>> = {
  agent_model: 'Chat',
  visual_perception: 'Visual perception',
  asr: 'Speech to text',
  audio_understanding: 'Audio understanding',
  embeddings: 'Embeddings and retrieval',
}

/** Whether a string is a role this product binds. */
export function isBindableRole(value: string): value is BindableRole {
  return (BINDABLE_ROLES as readonly string[]).includes(value)
}

/**
 * What each role is for, in a person's words.
 *
 * Here rather than in a component because the setup flow, the Role Bindings
 * screen and the blocked-composer card all name the same role, and three
 * copies of this sentence would eventually be three different sentences.
 */
export const ROLE_PURPOSE: Readonly<Record<BindableRole, string>> = {
  agent_model: 'Plans, reasons and writes. This is what answers you in a conversation.',
  visual_perception: 'Reads what is on screen or in a frame.',
  asr: 'Speech to text, with timings a citation can point at.',
  audio_understanding: 'Non-speech audio: events, tone, music.',
  embeddings: 'Search over the library and over memory.',
}

/** The modalities each role's work actually needs a route to support. */
export const ROLE_MODALITIES: Readonly<Record<BindableRole, readonly Modality[]>> = {
  agent_model: ['text'],
  visual_perception: ['vision'],
  asr: ['audio'],
  audio_understanding: ['audio'],
  embeddings: ['embedding'],
}

/**
 * One stored decision.
 *
 * `boundAt` exists so Role Bindings can say when a choice was made rather than
 * presenting every binding as timeless; it is a decision timestamp, not a
 * verification one. Whether the binding *works* is never stored — that is
 * derived at read time from the live credential and route facts, because a
 * stored "verified" would go stale the moment a key was revoked and would be
 * the same lie about readiness this whole subsystem exists to stop telling.
 */
export interface RoleBindingRecord {
  /** The provider route id, as the Harness's catalogue names it. */
  readonly provider: string
  /** The provider-owned model id. */
  readonly model: string
  /**
   * Opaque handle the Host resolves against its own credential store.
   *
   * Null when the route needs no credential (a local endpoint). Never a value.
   */
  readonly credentialRef: string | null
  /** ISO-8601 instant the person made this choice. */
  readonly boundAt: string
}

/** The whole document, as stored. */
export interface WatchBindings {
  readonly version: number
  /** One entry per bound role. An absent role is unbound; there is no default. */
  readonly roles: Readonly<Partial<Record<BindableRole, RoleBindingRecord>>>
}

/** The document a profile that has never been configured has. */
export const EMPTY_BINDINGS: WatchBindings = { version: BINDINGS_VERSION, roles: {} }

/**
 * A model id worth storing.
 *
 * Deliberately permissive about shape — provider model ids are provider-owned
 * and this product does not get to decide that `openai/gpt-4o` is malformed —
 * and deliberately strict about the things that make a stored value dangerous:
 * control characters, newlines and absurd length, all of which arrive from a
 * hand-edited settings file rather than from the picker.
 */
export function isStorableId(value: unknown): value is string {
  return typeof value === 'string'
    && value !== ''
    && value.length <= 200
    // eslint-disable-next-line no-control-regex -- rejecting these is the point.
    && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Read a stored document, keeping only what is well-formed.
 *
 * A hand-edited settings file is a supported way to configure this product, so
 * a malformed entry must not take the whole document with it: the bad role is
 * dropped and the rest survive. Dropping is the safe direction — an unbound
 * role refuses at the composer, where a person is told what to fix, whereas a
 * half-read binding would route a prompt somewhere nobody chose.
 *
 * @param raw - whatever the settings document held.
 * @returns a document this build can act on.
 */
export function readBindings(raw: unknown): WatchBindings {
  if (typeof raw !== 'object' || raw === null) return EMPTY_BINDINGS
  const record = raw as { version?: unknown, roles?: unknown }
  // A document from a future build is not merged, not guessed at, and not
  // partially honoured: the shape it uses is one this build has never seen.
  if (typeof record.version === 'number' && record.version > BINDINGS_VERSION) {
    return EMPTY_BINDINGS
  }
  if (typeof record.roles !== 'object' || record.roles === null) return EMPTY_BINDINGS

  const roles: Partial<Record<BindableRole, RoleBindingRecord>> = {}
  for (const [role, value] of Object.entries(record.roles as Record<string, unknown>)) {
    if (!isBindableRole(role)) continue
    const entry = readBindingRecord(value)
    if (entry !== null) roles[role] = entry
  }
  return { version: BINDINGS_VERSION, roles }
}

/** One entry, or null when it is not something this build can honour. */
function readBindingRecord(value: unknown): RoleBindingRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  if (!isStorableId(entry['provider']) || !isStorableId(entry['model'])) return null
  const ref = entry['credentialRef']
  // A non-string reference is read as "no reference" rather than refused: the
  // binding's provider and model are still the person's choice, and the Host
  // reports an unresolvable credential as a blocker they can act on.
  const credentialRef = typeof ref === 'string' && ref !== '' ? ref : null
  const boundAt = typeof entry['boundAt'] === 'string' ? entry['boundAt'] : ''
  return { provider: entry['provider'], model: entry['model'], credentialRef, boundAt }
}

/**
 * The document with one role bound, as a new value.
 *
 * Never mutates: the caller holds a snapshot it may still be rendering from,
 * and a document edited underneath a React tree is a stale-render bug that
 * shows somebody the binding they had a moment ago.
 */
export function withBinding(
  current: WatchBindings, role: BindableRole, record: RoleBindingRecord,
): WatchBindings {
  return { version: BINDINGS_VERSION, roles: { ...current.roles, [role]: record } }
}

/** The document with one role unbound. */
export function withoutBinding(current: WatchBindings, role: BindableRole): WatchBindings {
  const roles = Object.fromEntries(
    Object.entries(current.roles).filter(([key]) => key !== role),
  ) as Partial<Record<BindableRole, RoleBindingRecord>>
  return { version: BINDINGS_VERSION, roles }
}

/**
 * The readiness-shaped view of one stored role, or null when it is unbound.
 *
 * The join between this module and `readiness`: storage keeps records, the
 * gate takes {@link RoleBinding}s, and this is the only place that converts
 * one into the other — so the modalities a role is checked against always come
 * from {@link ROLE_MODALITIES} rather than from whatever a call site guessed.
 */
export function bindingFor(bindings: WatchBindings, role: BindableRole): RoleBinding | null {
  const record = bindings.roles[role]
  if (record === undefined) return null
  return {
    role,
    provider: record.provider,
    model: record.model,
    credentialRef: record.credentialRef,
    modalities: ROLE_MODALITIES[role],
  }
}

/** Whether a role has a stored decision at all. Not whether it can run. */
export function isBound(bindings: WatchBindings, role: BindableRole): boolean {
  return bindings.roles[role] !== undefined
}

/**
 * Every provider a stored binding names, once each.
 *
 * What Settings uses to decide which providers to show credential state for:
 * the ones a person actually pointed something at, rather than all
 * thirty-seven routes the catalogue carries.
 */
export function boundProviders(bindings: WatchBindings): readonly string[] {
  const seen = new Set<string>()
  for (const record of Object.values(bindings.roles)) seen.add(record.provider)
  return [...seen].sort()
}

/**
 * Whether a provider/model pair is one this profile actually bound.
 *
 * The authoritative question, and deliberately the *narrow* one. It does not
 * ask whether the route exists, whether a credential is stored, or whether the
 * provider is reachable — those are the Host's to answer at the moment of the
 * request. It asks the only thing a stored document can answer: did somebody
 * choose this pair for something.
 *
 * That is what makes it usable as a gate at a routing boundary. A request for
 * a pair nobody bound is a request nobody authorised, whatever the client that
 * produced it believed — a stale tab holding a selection that has since been
 * changed, or a caller that set one directly and skipped the screens.
 *
 * Any bound role counts, not only the one being served: a person who bound
 * OpenRouter to Chat has authorised that route, and the title and compaction
 * calls that ride the same selection are the same authorisation, not new ones.
 *
 * @param bindings - the stored document.
 * @param provider - the route the request names.
 * @param model - the model the request names.
 * @returns whether some role in this profile is bound to exactly that pair.
 */
export function isRoutePermitted(
  bindings: WatchBindings, provider: string, model: string,
): boolean {
  if (provider === '' || model === '') return false
  return Object.values(bindings.roles).some(
    record => record.provider === provider && record.model === model)
}

/**
 * Every distinct provider/model pair this profile bound, for a diagnostic.
 *
 * A refusal that says "this route is not bound" is not much use without the
 * ability to say what *is*, and that list is a set of choices rather than
 * anything sensitive — no credential, no reference, no host path.
 */
export function permittedRoutes(bindings: WatchBindings): readonly string[] {
  const seen = new Set<string>()
  for (const record of Object.values(bindings.roles)) {
    seen.add(`${record.provider}/${record.model}`)
  }
  return [...seen].sort()
}

/**
 * Patterns that must never appear in a stored binding.
 *
 * Not an exhaustive secret detector — there is no such thing — but a guard on
 * the shapes a credential takes when somebody pastes one into a field meant to
 * hold a reference.
 *
 * `OPENROUTER_API_KEY` is deliberately *not* one of them, and that distinction
 * is the design rather than an omission: it is a reference — the name of a
 * place the Host looks — and naming a place is exactly what `credentialRef` is
 * for. A guard that refused it would refuse every legitimate binding, be
 * switched off within a day, and stop catching what it was written for. What
 * is refused is a *value*: the shapes a key has when the key itself is pasted.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bsk_live_[A-Za-z0-9]{8,}/,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
  // A long run of mixed-case token characters. A reference is a name a person
  // could read aloud; anything this long that is not one is a value somebody
  // pasted where a name belongs.
  /(?=[A-Za-z0-9+/_-]{32,})(?=[^\n]*[a-z])(?=[^\n]*[A-Z])(?=[^\n]*\d)[A-Za-z0-9+/_-]{32,}/,
]

/**
 * Throw when a document about to be stored or shown carries secret material.
 *
 * A programming error rather than a runtime condition: every write path builds
 * this document from a picker, so a value matching one of these means a code
 * path has started copying a credential into a place that is read back in
 * plain text. Failing loudly at the write is the only point where that is
 * still cheap to fix.
 *
 * @param where - the surface being guarded, for a message that can be acted on.
 * @param bindings - the document about to leave a trusted boundary.
 */
export function assertNoSecretMaterial(where: string, bindings: WatchBindings): void {
  for (const [role, record] of Object.entries(bindings.roles)) {
    for (const [field, value] of Object.entries(record)) {
      if (typeof value !== 'string') continue
      for (const shape of SECRET_SHAPES) {
        if (!shape.test(value)) continue
        throw new Error(
          `${where}: the ${role} binding's ${field} looks like credential material. `
          + 'A binding stores a reference the Host resolves, never a value.')
      }
    }
  }
}
