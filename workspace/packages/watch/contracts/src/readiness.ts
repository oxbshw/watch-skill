/**
 * Whether a role can actually run, kept as four separate facts.
 *
 * This module exists because they were one. A provider row showed a green dot
 * the moment a credential was saved, and a person reasonably read that as "the
 * product is ready" — so they typed a prompt, and the runtime routed it to a
 * provider they had never configured, failed on a missing environment
 * variable, and left a failed turn in their session. Every step of that was a
 * consequence of one indicator standing for four different questions:
 *
 *   1. is there a credential?          {@link ProviderCredentialStatus}
 *   2. does the provider answer?       {@link ProviderReachability}
 *   3. is a model chosen?              {@link ModelSelectionStatus}
 *   4. is a role bound and runnable?   {@link RoleBindingStatus}
 *
 * A credential is the *first* of those and implies none of the others.
 * {@link roleReadiness} is the only thing in this product allowed to answer
 * "ready", and it requires all four to line up, plus a route that supports the
 * role and a policy state that permits the request.
 *
 * **Nothing here ever carries secret material.** Not a value, not a prefix, a
 * suffix, a length or a hash. A credential appears in these types only as a
 * *reference* — an opaque handle the Host can resolve — and as a status word.
 * `configured_unverified` is the honest state after a save: something is
 * stored, and nobody has asked the provider whether it works.
 *
 * Verification is deliberately not automatic. Saving a credential must not
 * quietly spend a request, and discovering models must be distinguishable from
 * a billable completion — so both are user actions with their own results, and
 * {@link ProviderReachability} stays `unknown` until one of them runs.
 *
 * @module @deepwatch/dsh-contracts/readiness
 */

/**
 * What is known about a stored credential — never anything about its value.
 *
 * `configured_unverified` is the state a save produces and the one the UI has
 * to be honest about: it means stored, not working. `inaccessible` is separate
 * from `absent` because a credential store that cannot be opened is a fault to
 * report, not an empty slot to fill.
 */
export type ProviderCredentialStatus =
  /** No credential is stored for this provider. */
  | 'absent'
  /** Stored, and never checked against the provider. The state after a save. */
  | 'configured_unverified'
  /** A real request to the provider accepted it. */
  | 'verified'
  /** A real request to the provider rejected it. */
  | 'rejected'
  /** A credential is recorded but the store could not be read. */
  | 'inaccessible'

/**
 * Whether the provider itself answered, as distinct from whether it liked the
 * credential.
 *
 * `unknown` is the default and stays the default: this product does not
 * contact a provider because a settings page was opened.
 */
export type ProviderReachability =
  /** Never contacted from this installation. */
  | 'unknown'
  | 'reachable'
  /** Contacted and no usable answer came back. */
  | 'unreachable'
  /** Answered, and declined this request for rate reasons. */
  | 'rate_limited'
  /** Answered, and rejected the credential. */
  | 'unauthorized'

/** Whether a model has been chosen, and whether the choice still holds. */
export type ModelSelectionStatus =
  /** Nothing chosen. A provider with a credential is still in this state. */
  | 'none'
  | 'selected'
  /** Chosen once, and the provider no longer lists it. */
  | 'unavailable'
  /** Chosen, and not a well-formed model id for this provider. */
  | 'invalid'

/** Whether a role is wired to something that could run. */
export type RoleBindingStatus =
  /** No binding. Never a silent fallback to another role's model. */
  | 'unbound'
  /** A binding exists and has not been proved end to end. */
  | 'bound_unverified'
  /** Every requirement below is satisfied. The only state that may say "ready". */
  | 'executable'
  /** A binding exists and something forbids running it. */
  | 'blocked'

/**
 * Why a role is not executable.
 *
 * One reason per missing requirement, so the UI can name the exact next step
 * rather than saying "not configured" and leaving a person to guess which of
 * six things is missing.
 */
export type ReadinessBlocker =
  | 'no_binding'
  | 'provider_unknown'
  | 'credential_absent'
  | 'credential_rejected'
  | 'credential_inaccessible'
  | 'provider_untested'
  | 'provider_unreachable'
  | 'provider_rate_limited'
  | 'model_unset'
  | 'model_unavailable'
  | 'model_invalid'
  | 'route_lacks_role'
  | 'modality_unsupported'
  | 'consent_required'
  | 'policy_forbids'
  | 'contract_mismatch'

/** A modality a role may need a route to support. */
export type Modality = 'text' | 'vision' | 'audio' | 'embedding'

/**
 * What a route can do.
 *
 * Supplied by whatever knows the provider catalogue; this module only compares
 * it against what a role asks for.
 */
export interface RouteCapability {
  /** The provider route id, as the catalogue names it. */
  readonly provider: string
  /** Roles this route can serve at all. */
  readonly roles: readonly string[]
  readonly modalities: readonly Modality[]
  /** Model ids the provider listed, or null when nobody has asked it. */
  readonly models: readonly string[] | null
}

/**
 * One role's binding, as stored.
 *
 * `credentialRef` is an opaque handle, never a value: the Host resolves it
 * against its own credential store, and nothing that crosses into a browser or
 * a log ever holds more than this string.
 */
export interface RoleBinding {
  readonly role: string
  readonly provider: string
  readonly model: string
  /** Opaque handle to a credential the Host holds. Never a secret. */
  readonly credentialRef: string | null
  /** Modalities the bound work will actually need. */
  readonly modalities: readonly Modality[]
}

/** Everything {@link roleReadiness} is allowed to consider. */
export interface ReadinessInputs {
  readonly binding: RoleBinding | null
  readonly credential: ProviderCredentialStatus
  readonly reachability: ProviderReachability
  readonly model: ModelSelectionStatus
  readonly route: RouteCapability | null
  /** False when a required consent has not been granted for this work. */
  readonly consentGranted: boolean
  /** False when policy forbids the request regardless of consent. */
  readonly policyPermits: boolean
  /** False when the wire contract the route speaks is not one this build has. */
  readonly contractMatches: boolean
}

/** What the product knows about one role. */
export interface RoleReadiness {
  readonly role: string
  readonly status: RoleBindingStatus
  /** Empty exactly when the status is `executable`. */
  readonly blockers: readonly ReadinessBlocker[]
  /** The single next thing to fix, or null when there is nothing to fix. */
  readonly primaryBlocker: ReadinessBlocker | null
}

/**
 * The order blockers are reported in.
 *
 * Not alphabetical and not arbitrary: it is the order a person has to fix them
 * in. Telling somebody their model is unavailable when they have not chosen a
 * provider sends them to the wrong screen.
 */
const BLOCKER_ORDER: readonly ReadinessBlocker[] = [
  'no_binding',
  'provider_unknown',
  'credential_absent',
  'credential_inaccessible',
  'credential_rejected',
  'model_unset',
  'model_invalid',
  'model_unavailable',
  'provider_untested',
  'provider_unreachable',
  'provider_rate_limited',
  'route_lacks_role',
  'modality_unsupported',
  'contract_mismatch',
  'consent_required',
  'policy_forbids',
]

/**
 * Whether a role can run, and if not, exactly what is missing.
 *
 * The single gate. A caller may not assemble "ready" from parts: every surface
 * that shows readiness, and both halves of preflight, ask this function, so
 * there is one definition of executable and it is testable on its own.
 *
 * @param inputs - every fact that bears on the decision.
 * @param role - the role being asked about.
 * @returns the status and the blockers, in the order they must be fixed.
 */
export function roleReadiness(role: string, inputs: ReadinessInputs): RoleReadiness {
  const found = new Set<ReadinessBlocker>()
  const { binding, route } = inputs

  if (binding === null) {
    found.add('no_binding')
  } else {
    if (route === null) found.add('provider_unknown')

    if (inputs.credential === 'absent') found.add('credential_absent')
    if (inputs.credential === 'inaccessible') found.add('credential_inaccessible')
    if (inputs.credential === 'rejected') found.add('credential_rejected')
    if (inputs.credential === 'configured_unverified') found.add('provider_untested')
    // A rejected credential is also what an `unauthorized` probe reports; both
    // are the same missing step for a person, so they collapse to one blocker.
    if (inputs.reachability === 'unauthorized') found.add('credential_rejected')
    if (inputs.reachability === 'unknown') found.add('provider_untested')
    if (inputs.reachability === 'unreachable') found.add('provider_unreachable')
    if (inputs.reachability === 'rate_limited') found.add('provider_rate_limited')

    if (inputs.model === 'none' || binding.model === '') found.add('model_unset')
    if (inputs.model === 'invalid') found.add('model_invalid')
    if (inputs.model === 'unavailable') found.add('model_unavailable')

    if (route !== null) {
      if (!route.roles.includes(role)) found.add('route_lacks_role')
      const supported = new Set(route.modalities)
      if (!binding.modalities.every(modality => supported.has(modality))) {
        found.add('modality_unsupported')
      }
    }

    if (!inputs.contractMatches) found.add('contract_mismatch')
    if (!inputs.consentGranted) found.add('consent_required')
    if (!inputs.policyPermits) found.add('policy_forbids')
  }

  const blockers = BLOCKER_ORDER.filter(blocker => found.has(blocker))
  if (blockers.length === 0) {
    return { role, status: 'executable', blockers: [], primaryBlocker: null }
  }
  // `unbound` and `blocked` are different answers to "what do I do now?": one
  // needs a first choice, the other needs something repaired.
  const status: RoleBindingStatus = binding === null
    ? 'unbound'
    : blockers.every(blocker => blocker === 'provider_untested')
      ? 'bound_unverified'
      : 'blocked'
  return { role, status, blockers, primaryBlocker: blockers[0] ?? null }
}

/**
 * Whether a role may be described to a person as ready.
 *
 * A helper rather than a comparison at each call site, because "ready" is
 * exactly the word this whole module exists to stop being used loosely.
 */
export function isExecutable(readiness: RoleReadiness): boolean {
  return readiness.status === 'executable'
}

/** What a person should be told to do about one blocker, in their words. */
const BLOCKER_COPY: Readonly<Record<ReadinessBlocker, string>> = {
  no_binding: 'Choose a provider and model for this capability.',
  provider_unknown: 'The bound provider is no longer available. Choose another.',
  credential_absent: 'Add a credential for this provider.',
  credential_inaccessible: 'The saved credential could not be read. Save it again.',
  credential_rejected: 'The provider rejected the saved credential. Update it.',
  provider_untested: 'Run the provider test before using this capability.',
  provider_unreachable: 'The provider did not answer. Check the network and try again.',
  provider_rate_limited: 'The provider rate-limited the test. Wait, then try again.',
  model_unset: 'Choose a model for this capability.',
  model_invalid: 'The chosen model is not valid for this provider. Choose another.',
  model_unavailable: 'The provider no longer offers the chosen model. Choose another.',
  route_lacks_role: 'This provider cannot serve this capability. Choose another.',
  modality_unsupported: 'This model does not support what this capability needs.',
  contract_mismatch: 'This version of DeepWatch cannot talk to that provider.',
  consent_required: 'This capability needs a consent that has not been granted.',
  policy_forbids: 'Policy on this machine forbids this request.',
}

/**
 * One sentence a person can act on, for the blocker that matters most.
 *
 * Deliberately free of route ids, package names and environment variables:
 * those belong in Diagnostics, and a person reading their first error should
 * be told what to do rather than what broke internally.
 */
export function blockerMessage(readiness: RoleReadiness): string | null {
  const blocker = readiness.primaryBlocker
  return blocker === null ? null : BLOCKER_COPY[blocker]
}

/**
 * Whether a status word may be drawn with the affordance that reads as "good".
 *
 * Only a proved binding earns it. `bound_unverified` deliberately does not:
 * that is the state a green dot used to claim, and claiming it is what sent a
 * prompt to an unconfigured provider.
 */
export function isPositiveBindingStatus(status: RoleBindingStatus): boolean {
  return status === 'executable'
}

/**
 * The accessible label for a status, so colour is never the only signal.
 *
 * Every surface uses these words, so a screen reader and a sighted reader are
 * told the same thing, and a red or green dot is decoration on top of text
 * rather than the fact itself.
 */
export const BINDING_STATUS_LABEL: Readonly<Record<RoleBindingStatus, string>> = {
  unbound: 'Not configured',
  bound_unverified: 'Configured · not tested',
  executable: 'Ready',
  blocked: 'Blocked',
}

/** The accessible label for a credential status. */
export const CREDENTIAL_STATUS_LABEL: Readonly<Record<ProviderCredentialStatus, string>> = {
  absent: 'No credential',
  configured_unverified: 'Credential saved · not yet assigned',
  verified: 'Credential accepted',
  rejected: 'Credential rejected',
  inaccessible: 'Credential unreadable',
}

/** The accessible label for provider reachability. */
export const REACHABILITY_LABEL: Readonly<Record<ProviderReachability, string>> = {
  unknown: 'Not tested',
  reachable: 'Answered',
  unreachable: 'No answer',
  rate_limited: 'Rate limited',
  unauthorized: 'Rejected the credential',
}
