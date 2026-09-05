/**
 * The composer: what this turn is allowed to see, keep, do and claim.
 *
 * DSH's composer asks one question — what do you want to say. Watch needs
 * seven more, and they are the ones that decide whether an answer is worth
 * anything: which sources are in scope, which senses are on, what may be
 * remembered, what the agent may do, what would count as proof, what it may
 * spend, and what may leave the machine.
 *
 * The configuration itself is the easy half. The load-bearing half is
 * {@link proposeChange}, and the rule it enforces:
 *
 * > The agent may narrow. Only a person may widen.
 *
 * Five axes are one-way for the agent — source scope, cloud media, egress,
 * side effects, and assurance. Every one of them has the same failure shape:
 * the agent hits a wall, reasons its way to "I'll just enable the thing that
 * would let me finish", and the guarantee the person thought they had is gone
 * without a dialog ever appearing. Making the widening *unrepresentable* from
 * the agent's side is the only version of this that holds, because any version
 * that depends on the model choosing correctly is a version that fails on the
 * day the model is convinced by something it read on a page.
 *
 * Narrowing is deliberately free. An agent that decides it does not need the
 * camera should not need permission to stop using it.
 *
 * @module @deepwatch/dsh-workspace/composer
 */

// ── the eight sections ──────────────────────────────────────────────────────

/** Where observation comes from. */
export type SourceKind =
  | 'video' | 'live' | 'browser' | 'screen' | 'window' | 'camera' | 'microphone' | 'files'

/** Every source kind, for enumerating the section. */
export const SOURCE_KINDS: readonly SourceKind[] = [
  'video', 'live', 'browser', 'screen', 'window', 'camera', 'microphone', 'files',
]

/** How much of the selected sources is in play. */
export type ScopeKind = 'all' | 'source' | 'time_range' | 'region' | 'selected_evidence'

/**
 * Scope breadth, for the widening check.
 *
 * `all` is the widest; a selected-evidence scope is the narrowest. The numbers
 * are ordering only and have no other meaning.
 */
const SCOPE_BREADTH: Readonly<Record<ScopeKind, number>> = {
  all: 5,
  source: 4,
  time_range: 3,
  region: 2,
  selected_evidence: 1,
}

/** Which senses are on. */
export type ObserveChannel =
  | 'visual' | 'ocr' | 'speech' | 'speaker' | 'audio_events' | 'dom' | 'network'

/** Every observation channel. */
export const OBSERVE_CHANNELS: readonly ObserveChannel[] = [
  'visual', 'ocr', 'speech', 'speaker', 'audio_events', 'dom', 'network',
]

/** What may be remembered from this turn (ADR-006 scopes). */
export type RememberMode = 'off' | 'session' | 'personal' | 'workspace' | 'explicit'

/** Remember breadth, widest first. */
const REMEMBER_BREADTH: Readonly<Record<RememberMode, number>> = {
  workspace: 4,
  personal: 3,
  session: 2,
  explicit: 1,
  off: 0,
}

/** How far a side effect may go. */
export type SideEffectPolicy = 'none' | 'reversible_only' | 'approved_each' | 'permitted_set'

/** Side-effect breadth, widest first. */
const SIDE_EFFECT_BREADTH: Readonly<Record<SideEffectPolicy, number>> = {
  permitted_set: 3,
  approved_each: 2,
  reversible_only: 1,
  none: 0,
}

/**
 * How strong a claim this turn is allowed to make.
 *
 * `deterministic` means an executable expectation against world evidence.
 * `observed` means someone looked. `none` means no verification is attempted
 * and nothing may be reported as proven.
 */
export type Assurance = 'none' | 'observed' | 'deterministic'

/** Assurance strength, strongest first. */
const ASSURANCE_STRENGTH: Readonly<Record<Assurance, number>> = {
  deterministic: 2,
  observed: 1,
  none: 0,
}

/** Where media and text are permitted to go. */
export interface PrivacySection {
  /** No non-loopback egress from any role. */
  readonly offlineOnly: boolean
  /** Media never leaves the machine, even when text may. */
  readonly localMediaOnly: boolean
  /**
   * Explicit destinations egress is permitted to.
   *
   * An allowlist rather than a boolean: "cloud is on" is not a permission, it
   * is a category. The set is what a receipt can name.
   */
  readonly egressRoutes: readonly string[]
}

/** What this turn may spend. */
export interface BudgetSection {
  readonly latencyMs: number | null
  readonly maxTokens: number | null
  readonly maxCostUsd: number | null
  readonly gpuSeconds: number | null
  /** Retention class for artifacts this turn captures. */
  readonly retentionClass: string
}

/** What would count as proof. */
export interface VerifySection {
  /** Plain-language statement of what should be true afterwards. */
  readonly expectation: string
  /** Contract id, when a reusable one was chosen. */
  readonly contractId: string | null
  readonly assurance: Assurance
  readonly timeoutMs: number | null
}

/** The whole composer state. */
export interface ComposerConfig {
  readonly sources: readonly SourceKind[]
  readonly scope: ScopeKind
  /** Ids the scope refers to, when it refers to specific things. */
  readonly scopeRefs: readonly string[]
  readonly observe: readonly ObserveChannel[]
  readonly remember: RememberMode
  /** Memory ids the person explicitly selected, when remember is `explicit`. */
  readonly rememberRefs: readonly string[]
  readonly permittedTools: readonly string[]
  readonly sideEffects: SideEffectPolicy
  readonly verify: VerifySection
  readonly budget: BudgetSection
  readonly privacy: PrivacySection
}

/**
 * The default a new session opens on.
 *
 * Deliberately narrow. A default that had the camera on, cloud egress open and
 * side effects permitted would be a product that assumed consent it never
 * asked for, and every one of those settings is easier to turn on than to
 * discover was on.
 */
export function defaultComposer(): ComposerConfig {
  return {
    sources: [],
    scope: 'selected_evidence',
    scopeRefs: [],
    observe: ['visual', 'ocr'],
    remember: 'session',
    rememberRefs: [],
    permittedTools: [],
    sideEffects: 'none',
    verify: { expectation: '', contractId: null, assurance: 'observed', timeoutMs: null },
    budget: {
      latencyMs: null,
      maxTokens: null,
      maxCostUsd: null,
      gpuSeconds: null,
      retentionClass: 'session',
    },
    privacy: { offlineOnly: true, localMediaOnly: true, egressRoutes: [] },
  }
}

// ── change control ──────────────────────────────────────────────────────────

/** Who is asking for a change. */
export type Actor = 'user' | 'agent'

/** A partial change to the composer. */
export type ComposerChange = {
  readonly [K in keyof ComposerConfig]?: ComposerConfig[K]
}

/** The five axes the agent may not widen. */
export type GuardedAxis =
  | 'source_scope'
  | 'cloud_media'
  | 'egress'
  | 'side_effects'
  | 'assurance'

/** Every guarded axis, for enumerating the refusals a UI must explain. */
export const GUARDED_AXES: readonly GuardedAxis[] = [
  'source_scope', 'cloud_media', 'egress', 'side_effects', 'assurance',
]

/** One reason a change was refused. */
export interface ComposerRefusal {
  readonly axis: GuardedAxis
  readonly message: string
  /** What the person would have to do. Never a bare "not permitted". */
  readonly fix: string
}

/** The outcome of proposing a change. */
export type ComposerDecision =
  | { readonly ok: true; readonly config: ComposerConfig; readonly changed: readonly string[] }
  | { readonly ok: false; readonly config: ComposerConfig; readonly refusals: readonly ComposerRefusal[] }

/** Whether `next` adds any source kind `current` did not have. */
function widensSources(current: ComposerConfig, next: ComposerConfig): boolean {
  const had = new Set(current.sources)
  return next.sources.some(kind => !had.has(kind))
}

/** Whether the scope selector got broader. */
function widensScope(current: ComposerConfig, next: ComposerConfig): boolean {
  if (SCOPE_BREADTH[next.scope] > SCOPE_BREADTH[current.scope]) return true
  // Same selector, more referents, is also wider: three sources is broader
  // than one, even though both say `source`.
  if (next.scope !== current.scope) return false
  const had = new Set(current.scopeRefs)
  return next.scopeRefs.some(ref => !had.has(ref))
}

/** Whether media gained permission to leave the machine. */
function widensCloudMedia(current: ComposerConfig, next: ComposerConfig): boolean {
  return current.privacy.localMediaOnly && !next.privacy.localMediaOnly
}

/** Whether anything gained permission to leave the machine. */
function widensEgress(current: ComposerConfig, next: ComposerConfig): boolean {
  if (current.privacy.offlineOnly && !next.privacy.offlineOnly) return true
  const had = new Set(current.privacy.egressRoutes)
  return next.privacy.egressRoutes.some(route => !had.has(route))
}

/** Whether the agent may now do more to the world than it could. */
function widensSideEffects(current: ComposerConfig, next: ComposerConfig): boolean {
  if (SIDE_EFFECT_BREADTH[next.sideEffects] > SIDE_EFFECT_BREADTH[current.sideEffects]) return true
  const had = new Set(current.permittedTools)
  return next.permittedTools.some(tool => !had.has(tool))
}

/**
 * Whether the claim this turn may make got weaker.
 *
 * Note the direction. Every other axis is guarded against getting *wider*;
 * assurance is guarded against getting *lower*, because that is the version
 * that helps the agent: dropping from a deterministic contract to "someone
 * looked" is how a turn that could not be proven gets reported as done.
 */
function downgradesAssurance(current: ComposerConfig, next: ComposerConfig): boolean {
  return ASSURANCE_STRENGTH[next.verify.assurance] < ASSURANCE_STRENGTH[current.verify.assurance]
}

/** Whether memory scope got broader. */
function widensRemember(current: ComposerConfig, next: ComposerConfig): boolean {
  return REMEMBER_BREADTH[next.remember] > REMEMBER_BREADTH[current.remember]
}

/** Field-level diff, for the change log and for the tests. */
function changedFields(current: ComposerConfig, next: ComposerConfig): readonly string[] {
  const changed: string[] = []
  for (const key of Object.keys(current) as (keyof ComposerConfig)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) changed.push(key)
  }
  return changed
}

/**
 * Apply a proposed change, or refuse it with reasons.
 *
 * A user proposal is applied. An agent proposal is checked against all five
 * guarded axes and refused *in full* if any of them widens — never partially
 * applied. Partial application would let an agent widen one axis per turn and
 * arrive at the same place in five turns, which is the same failure with more
 * steps.
 */
export function proposeChange(
  current: ComposerConfig,
  change: ComposerChange,
  actor: Actor,
): ComposerDecision {
  const next: ComposerConfig = { ...current, ...change }

  if (actor === 'user') {
    return { ok: true, config: next, changed: changedFields(current, next) }
  }

  const refusals: ComposerRefusal[] = []

  if (widensSources(current, next) || widensScope(current, next)) {
    refusals.push({
      axis: 'source_scope',
      message: 'An agent cannot add a source or broaden the scope of this turn.',
      fix: 'Ask for the source you need and let the person add it in the composer.',
    })
  }
  if (widensCloudMedia(current, next)) {
    refusals.push({
      axis: 'cloud_media',
      message: 'Media is local-only for this turn and an agent cannot change that.',
      fix: 'Turn off local-media-only in the composer if sending media out is intended.',
    })
  }
  if (widensEgress(current, next)) {
    refusals.push({
      axis: 'egress',
      message: 'An agent cannot grant itself a network route.',
      fix: 'Add the destination to the composer’s egress routes.',
    })
  }
  if (widensSideEffects(current, next)) {
    refusals.push({
      axis: 'side_effects',
      message: 'An agent cannot widen what it is permitted to do to the world.',
      fix: 'Add the tool, or raise the side-effect policy, in the composer.',
    })
  }
  if (downgradesAssurance(current, next)) {
    refusals.push({
      axis: 'assurance',
      message: 'An agent cannot lower the standard of proof this turn is held to.',
      fix: 'Lower the assurance level in the composer if a weaker claim is acceptable.',
    })
  }
  // Memory scope is guarded by ADR-008 on the memory side too; refusing here
  // as well means the composer never *shows* a widened scope the ledger would
  // then reject, which would read as the product disagreeing with itself.
  if (widensRemember(current, next)) {
    refusals.push({
      axis: 'source_scope',
      message: 'An agent cannot broaden what this turn is allowed to remember.',
      fix: 'Change the Remember setting in the composer.',
    })
  }

  if (refusals.length > 0) return { ok: false, config: current, refusals }
  return { ok: true, config: next, changed: changedFields(current, next) }
}

/**
 * Whether a configuration can be submitted, and what is missing if not.
 *
 * The one hard requirement is the honest one: a turn that asks for a
 * deterministic verdict has to say what it expects. "Verify that it worked" is
 * not an expectation, and a contract with no statement in it can only ever
 * return UNVERIFIED — better to say so before the run than after it.
 */
export function validate(config: ComposerConfig): readonly string[] {
  const problems: string[] = []
  if (config.verify.assurance === 'deterministic'
    && config.verify.expectation.trim() === ''
    && config.verify.contractId === null) {
    problems.push('A deterministic verification needs an expectation or a contract id.')
  }
  if (config.remember === 'explicit' && config.rememberRefs.length === 0) {
    problems.push('Remember is set to explicit selection but no memories are selected.')
  }
  if (config.scope !== 'all' && config.scope !== 'selected_evidence' && config.scopeRefs.length === 0) {
    problems.push(`Scope is ${config.scope} but nothing is selected.`)
  }
  if (config.sideEffects !== 'none' && config.permittedTools.length === 0) {
    problems.push('Side effects are permitted but no tool is allowed to cause one.')
  }
  if (!config.privacy.offlineOnly && config.privacy.egressRoutes.length === 0) {
    problems.push('Network is permitted but no egress route is named.')
  }
  return problems
}

/**
 * One line summarizing what the composer is set to.
 *
 * Rendered above the input, where it is read by people who will not open the
 * panel. It leads with the two things that decide whether an answer means
 * anything — what is being observed and what would count as proof.
 */
export function describeComposer(config: ComposerConfig): string {
  const sources = config.sources.length === 0 ? 'no source' : config.sources.join(', ')
  const senses = config.observe.length === 0 ? 'nothing' : config.observe.join('+')
  const proof = config.verify.assurance === 'deterministic'
    ? 'deterministic check'
    : config.verify.assurance === 'observed' ? 'observation only' : 'no verification'
  const privacy = config.privacy.offlineOnly ? 'offline' : `egress: ${config.privacy.egressRoutes.join(', ')}`
  return `${sources} · ${senses} · ${proof} · remember ${config.remember} · ${privacy}`
}
