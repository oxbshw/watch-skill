/**
 * What a role may do, decided in one place, on the server.
 *
 * The permission catalogue below is the whole of it. There is no second table,
 * no per-endpoint improvisation, and no client-side check that a server-side
 * check does not repeat — a UI that hides a button is a courtesy, and treating
 * it as a control is how an API ends up open.
 *
 * Two properties are enforced structurally rather than by convention.
 *
 * **Every decision runs the tenant check first.** {@link authorize} takes the
 * owner as a required argument, so there is no shape of call that checks a role
 * without checking whose resource it is. A permission function that took only
 * a role would be the one somebody eventually calls.
 *
 * **Personal resources are not reachable by administration.** An admin of a
 * workspace is not an administrator of the people in it. Another member's taste
 * is denied at a rank above the role check, so no role can be added that would
 * reach it.
 *
 * @module @watchskill/dsh-tenancy/rbac
 */

import {
  ALLOWED,
  atLeast,
  deny,
  isLive,
  isOtherPersonsPersonal,
  membershipFor,
  sameTenant,
  type AccessDecision,
  type Directory,
  type Principal,
  type ResourceOwner,
  type Role,
} from './identity.js'

/** Everything a principal can be authorized to do. */
export type Permission =
  | 'workspace.read'
  | 'workspace.manage'
  | 'source.read'
  | 'source.write'
  | 'evidence.read'
  | 'artifact.read'
  | 'memory.read'
  | 'memory.write'
  /** Changing something in the *shared* memory scope. */
  | 'memory.shared.mutate'
  | 'browser.operate'
  | 'credential.use'
  | 'plugin.manage'
  | 'export.perform'
  | 'verification.policy.administer'
  | 'comment.write'
  | 'worker.submit'
  | 'audit.read'

/** Every permission, for enumerating a role editor. */
export const PERMISSIONS: readonly Permission[] = [
  'workspace.read', 'workspace.manage',
  'source.read', 'source.write',
  'evidence.read', 'artifact.read',
  'memory.read', 'memory.write', 'memory.shared.mutate',
  'browser.operate', 'credential.use', 'plugin.manage',
  'export.perform', 'verification.policy.administer',
  'comment.write', 'worker.submit', 'audit.read',
]

/**
 * The minimum role each permission requires.
 *
 * Written as one table so the whole authorization model is readable at once.
 * Anything that changes the world, spends money, or moves data out sits at
 * `admin` or above — not because members are untrusted, but because those are
 * the actions whose blast radius is the tenant rather than the session.
 */
export const REQUIRED_ROLE: Readonly<Record<Permission, Role>> = {
  'workspace.read': 'viewer',
  'workspace.manage': 'admin',
  'source.read': 'viewer',
  'source.write': 'member',
  'evidence.read': 'viewer',
  'artifact.read': 'viewer',
  'memory.read': 'member',
  'memory.write': 'member',
  // Changing what a whole workspace believes is not an ordinary edit.
  'memory.shared.mutate': 'admin',
  // Acting on a page changes the world.
  'browser.operate': 'member',
  'credential.use': 'member',
  'plugin.manage': 'admin',
  'export.perform': 'member',
  // Who decides what counts as proof is the most consequential setting here.
  'verification.policy.administer': 'admin',
  'comment.write': 'reviewer',
  'worker.submit': 'member',
  'audit.read': 'admin',
}

/**
 * Permissions that reach a person rather than a workspace.
 *
 * Listed so the rule is checkable directly: for these, ownership by another
 * user is denied before the role is even consulted.
 */
export const PERSONAL_PERMISSIONS: readonly Permission[] = [
  'memory.read', 'memory.write', 'export.perform',
]

/** What was asked for. */
export interface AuthorizationRequest {
  readonly principal: Principal
  readonly permission: Permission
  readonly owner: ResourceOwner
  readonly directory: Directory
}

/**
 * Decide one request.
 *
 * The order is the security property, and each step answers something the next
 * one would otherwise have to assume:
 *
 * 1. **Tenant.** A resource in another tenant does not exist.
 * 2. **Liveness.** Revocation and deletion are checked per request, not at
 *    sign-in, so an offboarding takes effect on the next call.
 * 3. **Personal ownership.** Another person's memory is theirs, whatever role
 *    the principal holds in the workspace it happens to sit beside.
 * 4. **Membership.** No membership, no access — including for a tenant owner,
 *    who has to join a workspace like anybody else.
 * 5. **Role.** Finally, is the role strong enough.
 */
export function authorize(request: AuthorizationRequest): AccessDecision {
  const { principal, permission, owner, directory } = request

  const tenant = sameTenant(principal, owner)
  if (!tenant.allowed) return tenant

  const live = isLive(principal, owner, directory)
  if (!live.allowed) return live

  if (PERSONAL_PERMISSIONS.includes(permission) && isOtherPersonsPersonal(principal, owner)) {
    // Above the role check on purpose. There is no role that reaches it, and
    // putting it here means a role added later still does not.
    return deny('not_owner', 'That belongs to someone else.')
  }

  if (owner.workspaceId === null) {
    // A tenant-level resource — a credential, a worker job. Membership of any
    // workspace in the tenant is required, so a user with no memberships at all
    // cannot reach tenant infrastructure.
    const anyMembership = principal.memberships.some(
      membership => membership.tenantId === principal.tenantId && membership.revokedAt === null)
    if (!anyMembership) return deny('no_membership', 'No workspace membership in this tenant.')
    const strongest = strongestRole(principal)
    if (strongest === null || !atLeast(strongest, REQUIRED_ROLE[permission])) {
      return deny('role_insufficient',
        `${permission} requires ${REQUIRED_ROLE[permission]} or above.`)
    }
    return ALLOWED
  }

  const membership = membershipFor(principal, owner.workspaceId)
  if (membership === null) {
    return deny('no_membership', 'No such resource.')
  }
  if (!atLeast(membership.role, REQUIRED_ROLE[permission])) {
    return deny('role_insufficient',
      `${permission} requires ${REQUIRED_ROLE[permission]}; this membership is ${membership.role}.`)
  }
  return ALLOWED
}

/** The strongest role a principal holds anywhere in their tenant. */
export function strongestRole(principal: Principal): Role | null {
  let best: Role | null = null
  for (const membership of principal.memberships) {
    if (membership.revokedAt !== null) continue
    if (membership.tenantId !== principal.tenantId) continue
    if (best === null || atLeast(membership.role, best)) best = membership.role
  }
  return best
}

/**
 * Filter a list to what a principal may see.
 *
 * Used everywhere a collection is served. Filtering rather than refusing is
 * right for a list — a search that returned an error because one result was
 * out of scope would be unusable — but the filter has to be the same
 * `authorize` every single-resource read uses, or the two drift and the list
 * becomes the way around the check.
 */
export function filterAuthorized<T>(
  items: readonly T[],
  ownerOf: (item: T) => ResourceOwner,
  request: Omit<AuthorizationRequest, 'owner'>,
): readonly T[] {
  return items.filter(item =>
    authorize({ ...request, owner: ownerOf(item) }).allowed)
}

/**
 * Whether a permission may be delegated by a principal holding one role.
 *
 * A member cannot grant admin. Privilege escalation through invitation is the
 * oldest hole in every collaboration product, and the rule that closes it is
 * that you may only grant what you already hold.
 */
export function mayGrant(granter: Role, granted: Role): boolean {
  if (!atLeast(granter, 'admin')) return false
  return atLeast(granter, granted)
}
