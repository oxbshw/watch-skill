/**
 * Tenants, roles, remote workers, sharing and audit.
 *
 * A login screen is not multi-tenancy. Multi-tenancy is the property that every
 * persisted and served resource carries an explicit owner and that no code path
 * returns one without checking it — which is why the tenant check is a required
 * argument of `authorize()` rather than something a caller remembers.
 *
 * @module @watchskill/dsh-tenancy
 */

export * from './identity.js'
export * from './rbac.js'
export * from './workers.js'
export * from './collaboration.js'
export * from './audit.js'
