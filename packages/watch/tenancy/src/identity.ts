/**
 * Who owns what, and the rule that makes multi-tenancy real.
 *
 * A login screen is not multi-tenancy. Multi-tenancy is the property that every
 * persisted and served resource carries an explicit owner, and that no code
 * path returns one without checking it. The difference shows up the first time
 * somebody guesses an id, and by then it is a disclosure rather than a bug.
 *
 * So the model here is deliberately blunt. Every resource has a
 * {@link ResourceOwner}, every owner names a tenant, and {@link sameTenant} is
 * the check that stands between a request and an answer. There is no "public"
 * resource, no "system" tenant that can read everything, and no ambient
 * fallback when the owner is unknown — an unowned resource is unreachable, and
 * that is the safe direction to fail in.
 *
 * The hierarchy is a hierarchy, not a set of parallel ids:
 *
 *   tenant → workspace → session/source/evidence/memory
 *   tenant → user → membership(role, workspace)
 *
 * A user belongs to exactly one tenant. Cross-tenant users are the feature that
 * turns every access check into a question about which identity is currently
 * in play, and the answer is wrong exactly once before it matters.
 *
 * @module @watchskill/dsh-tenancy/identity
 */

/** A tenant: the boundary nothing crosses without an explicit share. */
export interface Tenant {
  readonly tenantId: string
  readonly displayName: string
  /** Set when the tenant has been deleted; nothing under it is servable. */
  readonly deletedAt: string | null
}

/** A person, inside exactly one tenant. */
export interface User {
  readonly userId: string
  readonly tenantId: string
  readonly displayName: string
  /** Set when access has been revoked; every check fails from that moment. */
  readonly revokedAt: string | null
}

/** A workspace, inside exactly one tenant. */
export interface Workspace {
  readonly workspaceId: string
  readonly tenantId: string
  readonly displayName: string
  readonly deletedAt: string | null
}

/** What a member may do. */
export type Role =
  /** Everything, including tenant administration. */
  | 'owner'
  /** Everything inside a workspace, including sharing and policy. */
  | 'admin'
  /** Ordinary work: observe, act with approval, contribute memory. */
  | 'member'
  /** Read what is shared, comment, and nothing else. */
  | 'reviewer'
  /** Read what is shared. */
  | 'viewer'

/** Every role, strongest first. */
export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'reviewer', 'viewer']

/** One person's membership of one workspace. */
export interface Membership {
  readonly userId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly role: Role
  readonly grantedAt: string
  readonly revokedAt: string | null
}

/** The kinds of thing that can be owned. */
export type ResourceKind =
  | 'workspace'
  | 'session'
  | 'source'
  | 'evidence'
  | 'artifact'
  | 'memory'
  | 'credential'
  | 'worker_job'
  | 'collection'
  | 'comment'

/**
 * Who a resource belongs to.
 *
 * `workspaceId` is null for something owned by a tenant directly (a
 * credential, a worker job). `userId` is set only for things that are
 * personal — a taste memory belongs to a person, not to their workspace, and
 * that distinction is what keeps personal taste out of a shared scope.
 */
export interface ResourceOwner {
  readonly kind: ResourceKind
  readonly resourceId: string
  readonly tenantId: string
  readonly workspaceId: string | null
  readonly userId: string | null
}

/** The identity a request is made under. */
export interface Principal {
  readonly userId: string
  readonly tenantId: string
  /** Memberships this principal holds, already loaded. */
  readonly memberships: readonly Membership[]
}

/** Why an access check failed. */
export interface AccessDenial {
  readonly reason: string
  /** A stable code, for the audit log. */
  readonly code:
    | 'cross_tenant'
    | 'no_membership'
    | 'role_insufficient'
    | 'not_owner'
    | 'revoked'
    | 'deleted'
    | 'unowned'
}

/** The outcome of an access check. */
export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly denial: AccessDenial }

/** Allow, as a shared value. */
export const ALLOWED: AccessDecision = Object.freeze({ allowed: true })

/** Deny with a code and a reason. */
export function deny(code: AccessDenial['code'], reason: string): AccessDecision {
  return { allowed: false, denial: { code, reason } }
}

/**
 * The first and most important check.
 *
 * Called before anything else, everywhere. A resource in another tenant does
 * not produce a "not permitted" — as far as the principal is concerned it does
 * not exist, and the denial reason says nothing about it.
 */
export function sameTenant(principal: Principal, owner: ResourceOwner): AccessDecision {
  if (owner.tenantId === '') {
    return deny('unowned', 'The resource has no owner, so it cannot be served.')
  }
  if (principal.tenantId !== owner.tenantId) {
    // Deliberately says nothing about what was asked for. A denial that
    // distinguished "exists, not yours" from "does not exist" is an existence
    // oracle, which is how ids get enumerated.
    return deny('cross_tenant', 'No such resource.')
  }
  return ALLOWED
}

/** The membership a principal holds for one workspace, if any. */
export function membershipFor(
  principal: Principal,
  workspaceId: string,
): Membership | null {
  return principal.memberships.find(membership =>
    membership.workspaceId === workspaceId
    && membership.tenantId === principal.tenantId
    && membership.revokedAt === null) ?? null
}

/** Role strength, for comparisons. */
const ROLE_RANK: Readonly<Record<Role, number>> = {
  owner: 5,
  admin: 4,
  member: 3,
  reviewer: 2,
  viewer: 1,
}

/** Whether one role is at least as strong as another. */
export function atLeast(held: Role, required: Role): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required]
}

/**
 * Whether a resource is personal to somebody other than the principal.
 *
 * The rule behind "personal taste is private by default": a resource with a
 * `userId` belongs to that person, and workspace membership does not reach it.
 * An admin cannot read another member's taste, which is deliberate — an
 * administrator of a workspace is not an administrator of a person.
 */
export function isOtherPersonsPersonal(
  principal: Principal,
  owner: ResourceOwner,
): boolean {
  return owner.userId !== null && owner.userId !== principal.userId
}

/** The state of the world an access check reads. */
export interface Directory {
  readonly tenants: ReadonlyMap<string, Tenant>
  readonly users: ReadonlyMap<string, User>
  readonly workspaces: ReadonlyMap<string, Workspace>
}

/**
 * Whether the principal, the tenant and the workspace are all still live.
 *
 * Revocation and deletion are checked on every request rather than at login.
 * A session that outlived a revocation is the thing an offboarding process is
 * supposed to prevent, and checking once at sign-in means it does not.
 */
export function isLive(
  principal: Principal,
  owner: ResourceOwner,
  directory: Directory,
): AccessDecision {
  const tenant = directory.tenants.get(principal.tenantId)
  if (tenant === undefined || tenant.deletedAt !== null) {
    return deny('deleted', 'This tenant no longer exists.')
  }
  const user = directory.users.get(principal.userId)
  if (user === undefined || user.revokedAt !== null) {
    return deny('revoked', 'This account no longer has access.')
  }
  if (owner.workspaceId !== null) {
    const workspace = directory.workspaces.get(owner.workspaceId)
    if (workspace === undefined || workspace.deletedAt !== null) {
      return deny('deleted', 'No such resource.')
    }
    if (workspace.tenantId !== owner.tenantId) {
      // A resource claiming a workspace in another tenant is corrupt data, and
      // the safe reading of corrupt ownership is that nobody may have it.
      return deny('cross_tenant', 'No such resource.')
    }
  }
  return ALLOWED
}
