/**
 * Remote Watch Core workers: a queue where a lease is the only thing that
 * grants work, and a retry is never free.
 *
 * The distributed version of the same rule the browser operator already
 * enforces locally: **no blind retry of a consequential action**. When a worker
 * stops answering, the coordinator does not know whether the job never ran,
 * ran and failed, or ran and succeeded before the network went. For a
 * read-only job that ambiguity is a cost; for a job that changed something it
 * is the difference between one deployment and two.
 *
 * So a job declares whether it is consequential, and a lease that expires on a
 * consequential job is *not* requeued. It is surfaced as needing a decision,
 * with its idempotency key, so a person or a receipt lookup resolves what
 * actually happened.
 *
 * Everything here is tenant-scoped. A worker registers to a tenant, leases only
 * jobs from that tenant, and a coordinator that returns a job across the
 * boundary is a coordinator that has leaked a workload description — which
 * frequently contains a URL, a source name and an expectation.
 *
 * @module @watchskill/dsh-tenancy/workers
 */

import type { CapabilityTruth } from '@watchskill/dsh-contracts'
import type { ResourceOwner } from './identity.js'

/** What a worker says it can do, and what has actually run on it. */
export interface WorkerRegistration {
  readonly workerId: string
  readonly tenantId: string
  readonly displayName: string
  /**
   * Capability truth in Watch Core's own vocabulary.
   *
   * A worker claiming `implemented` is not a worker a GPU job may be routed
   * to. The distinction is the same one the local Technology Centre draws, and
   * it matters more here: a remote worker is a machine nobody in the room can
   * look at.
   */
  readonly capabilities: readonly CapabilityTruth[]
  readonly hasGpu: boolean
  readonly vramGb: number | null
  /** Concurrent leases this worker may hold. */
  readonly maxConcurrency: number
  readonly registeredAt: string
  readonly lastHeartbeatAt: string
}

/** Where a job is. */
export type JobState =
  | 'queued'
  | 'leased'
  | 'succeeded'
  | 'failed'
  /** A consequential job whose lease expired. Requires a decision. */
  | 'needs_resolution'
  | 'cancelled'

/** One unit of work. */
export interface Job {
  readonly jobId: string
  readonly tenantId: string
  readonly workspaceId: string
  /** Who submitted it, for the audit trail and for cancellation rights. */
  readonly submittedByUserId: string
  readonly kind: string
  /** Capability ids this job needs, checked against worker truth. */
  readonly requires: readonly string[]
  readonly requiresGpu: boolean
  /**
   * Whether running this changes something outside Watch.
   *
   * The single most consequential field in this module. It decides whether an
   * expired lease is requeued or escalated.
   */
  readonly consequential: boolean
  /**
   * Stable across retries of the same intent.
   *
   * What lets a receipt lookup answer "did this already happen" without
   * running anything.
   */
  readonly idempotencyKey: string
  readonly deadlineAtMs: number
  readonly state: JobState
  readonly leasedByWorkerId: string | null
  readonly leaseExpiresAtMs: number | null
  readonly attempts: number
  /** Correlates with the receipt Watch Core issues, when one exists. */
  readonly receiptId: string | null
  readonly detail: string
}

/** How the coordinator is configured. */
export interface CoordinatorPolicy {
  readonly leaseDurationMs: number
  /** How long a worker may go silent before its leases are reclaimed. */
  readonly heartbeatTimeoutMs: number
  /** Attempts for a read-only job. A consequential one gets one attempt. */
  readonly maxAttempts: number
}

/** The default policy. */
export const DEFAULT_POLICY: CoordinatorPolicy = {
  leaseDurationMs: 60_000,
  heartbeatTimeoutMs: 90_000,
  maxAttempts: 3,
}

/** The owner record for a job, so RBAC can be applied to it. */
export function jobOwner(job: Job): ResourceOwner {
  return {
    kind: 'worker_job',
    resourceId: job.jobId,
    tenantId: job.tenantId,
    workspaceId: job.workspaceId,
    userId: null,
  }
}

/** Why a lease was refused. */
export interface LeaseRefusal {
  readonly reason: string
}

/** What a lease attempt produced. */
export type LeaseResult =
  | { readonly ok: true; readonly job: Job }
  | { readonly ok: false; readonly refusal: LeaseRefusal }

/** Whether a worker's capability truth satisfies a job's requirements. */
export function workerCanRun(worker: WorkerRegistration, job: Job): boolean {
  if (job.requiresGpu && !worker.hasGpu) return false
  const proven = new Set(
    worker.capabilities
      // Only what has actually run on that machine. A remote worker is one
      // nobody can look at, so "implemented" is worth even less here.
      .filter(capability => capability.status === 'machine_tested')
      .map(capability => capability.capabilityId),
  )
  return job.requires.every(required => proven.has(required))
}

/**
 * An in-memory coordinator.
 *
 * Storage is deliberately not this module's problem — the rules are, and they
 * are the part that is wrong in most implementations. A persistent backing
 * store implements the same transitions.
 */
export class Coordinator {
  private readonly jobs = new Map<string, Job>()
  private readonly workers = new Map<string, WorkerRegistration>()
  /** Idempotency key to the job that claimed it, per tenant. */
  private readonly claimed = new Map<string, string>()

  constructor(private readonly policy: CoordinatorPolicy = DEFAULT_POLICY) {}

  /** Register or refresh a worker. */
  register(worker: WorkerRegistration): void {
    this.workers.set(worker.workerId, worker)
  }

  /** Record a heartbeat. A worker that stops beating loses its leases. */
  heartbeat(workerId: string, atMs: number): boolean {
    const worker = this.workers.get(workerId)
    if (worker === undefined) return false
    this.workers.set(workerId, {
      ...worker,
      lastHeartbeatAt: new Date(atMs).toISOString(),
    })
    return true
  }

  /**
   * Submit a job.
   *
   * An idempotency key already claimed inside this tenant returns the existing
   * job rather than creating a second one. The key is namespaced by tenant, so
   * two tenants choosing the same key never collide — which would otherwise be
   * a cross-tenant read dressed up as deduplication.
   */
  submit(job: Job): Job {
    const key = `${job.tenantId}:${job.idempotencyKey}`
    const existingId = this.claimed.get(key)
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId)
      if (existing !== undefined) return existing
    }
    this.jobs.set(job.jobId, job)
    this.claimed.set(key, job.jobId)
    return job
  }

  /** One job, or null. Tenant-checked by the caller through `jobOwner`. */
  job(jobId: string): Job | null {
    return this.jobs.get(jobId) ?? null
  }

  /** Every job in one tenant. Never across tenants. */
  jobsFor(tenantId: string): readonly Job[] {
    return [...this.jobs.values()].filter(job => job.tenantId === tenantId)
  }

  /**
   * Lease the next runnable job for a worker.
   *
   * Tenant first, then capability truth, then deadline. A worker only ever
   * sees work from its own tenant, and a job whose deadline has passed is
   * failed rather than handed out — running something the requester has
   * stopped waiting for is work nobody will read.
   */
  lease(workerId: string, nowMs: number): LeaseResult {
    const worker = this.workers.get(workerId)
    if (worker === undefined) {
      return { ok: false, refusal: { reason: 'This worker is not registered.' } }
    }

    this.reclaimExpired(nowMs)

    const held = [...this.jobs.values()].filter(
      job => job.state === 'leased' && job.leasedByWorkerId === workerId).length
    if (held >= worker.maxConcurrency) {
      return { ok: false, refusal: { reason: 'This worker is at its concurrency limit.' } }
    }

    for (const job of this.jobs.values()) {
      if (job.state !== 'queued') continue
      // The line that makes this multi-tenant rather than a shared queue.
      if (job.tenantId !== worker.tenantId) continue
      if (job.deadlineAtMs <= nowMs) {
        this.jobs.set(job.jobId, {
          ...job,
          state: 'failed',
          detail: 'The deadline passed before any worker took it.',
        })
        continue
      }
      if (!workerCanRun(worker, job)) continue

      const leased: Job = {
        ...job,
        state: 'leased',
        leasedByWorkerId: workerId,
        leaseExpiresAtMs: nowMs + this.policy.leaseDurationMs,
        attempts: job.attempts + 1,
      }
      this.jobs.set(job.jobId, leased)
      return { ok: true, job: leased }
    }

    return { ok: false, refusal: { reason: 'Nothing to do.' } }
  }

  /** Report a result. Only the worker holding the lease may. */
  complete(input: {
    readonly jobId: string
    readonly workerId: string
    readonly ok: boolean
    readonly detail: string
    readonly receiptId?: string | null
  }): boolean {
    const job = this.jobs.get(input.jobId)
    if (job === undefined) return false
    if (job.leasedByWorkerId !== input.workerId) return false
    this.jobs.set(job.jobId, {
      ...job,
      state: input.ok ? 'succeeded' : 'failed',
      leasedByWorkerId: null,
      leaseExpiresAtMs: null,
      receiptId: input.receiptId ?? job.receiptId,
      detail: input.detail,
    })
    return true
  }

  /** Cancel a job. Only its submitter, or an admin, should reach this. */
  cancel(jobId: string, detail: string): boolean {
    const job = this.jobs.get(jobId)
    if (job === undefined) return false
    if (job.state === 'succeeded' || job.state === 'failed') return false
    this.jobs.set(jobId, {
      ...job,
      state: 'cancelled',
      leasedByWorkerId: null,
      leaseExpiresAtMs: null,
      detail,
    })
    return true
  }

  /**
   * Reclaim leases from workers that went quiet.
   *
   * The heart of the module. A read-only job goes back on the queue until its
   * attempt budget runs out. A **consequential** job does not — it becomes
   * `needs_resolution`, carrying its idempotency key, because the coordinator
   * genuinely does not know whether it ran. Requeueing it would be guessing,
   * and the cost of guessing wrong is a second real-world action.
   */
  reclaimExpired(nowMs: number): readonly Job[] {
    const reclaimed: Job[] = []
    for (const job of this.jobs.values()) {
      if (job.state !== 'leased') continue
      if (job.leaseExpiresAtMs !== null && job.leaseExpiresAtMs > nowMs) continue

      if (job.consequential) {
        const escalated: Job = {
          ...job,
          state: 'needs_resolution',
          leasedByWorkerId: null,
          leaseExpiresAtMs: null,
          detail:
            'The worker stopped answering while this job was running. It may have '
            + 'completed. Check the receipt for idempotency key '
            + `${job.idempotencyKey} before running it again.`,
        }
        this.jobs.set(job.jobId, escalated)
        reclaimed.push(escalated)
        continue
      }

      if (job.attempts >= this.policy.maxAttempts) {
        const exhausted: Job = {
          ...job,
          state: 'failed',
          leasedByWorkerId: null,
          leaseExpiresAtMs: null,
          detail: `Gave up after ${String(job.attempts)} attempt(s).`,
        }
        this.jobs.set(job.jobId, exhausted)
        reclaimed.push(exhausted)
        continue
      }

      const requeued: Job = {
        ...job,
        state: 'queued',
        leasedByWorkerId: null,
        leaseExpiresAtMs: null,
        detail: 'The lease expired; requeued.',
      }
      this.jobs.set(job.jobId, requeued)
      reclaimed.push(requeued)
    }
    return reclaimed
  }

  /** Workers that have not beaten within the timeout. */
  staleWorkers(nowMs: number): readonly WorkerRegistration[] {
    return [...this.workers.values()].filter(worker =>
      nowMs - Date.parse(worker.lastHeartbeatAt) > this.policy.heartbeatTimeoutMs)
  }

  /** Resolve a job that needed a decision, once somebody established what happened. */
  resolve(jobId: string, outcome: 'succeeded' | 'failed', detail: string): boolean {
    const job = this.jobs.get(jobId)
    if (job === undefined || job.state !== 'needs_resolution') return false
    this.jobs.set(jobId, { ...job, state: outcome, detail })
    return true
  }
}

/**
 * One line describing a job that needs a person.
 *
 * Always names the idempotency key, because that is the thing that turns "we
 * do not know" into an answerable question.
 */
export function describeUnresolved(job: Job): string {
  return `${job.kind} (${job.jobId}) may or may not have run. `
    + `Look up receipt for ${job.idempotencyKey} before retrying.`
}
