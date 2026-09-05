/**
 * Turning what the Host saw into a question only Watch Core may answer.
 *
 * **The division this file exists to hold.** The Host is allowed to notice that
 * a file was written, to work out what would make that write true, to freeze
 * that question and to carry it across the Bridge. It is not allowed to answer
 * it. ADR-002 is mechanical about this — `scripts/verify-verdict-authority.mjs`
 * fails the build if any file under `packages` produces a verdict — and the
 * rule is right: a verdict minted by the same process that did the work is the
 * `verification.json` failure with better formatting.
 *
 * So everything here builds *checks*. Core runs them, in its own isolated
 * verifier, against paths bounded by its own roots, and Core returns the
 * verdict. Nothing in this module writes one, and the two places that read one
 * read it from Core's reply.
 *
 * **Why the claims are so small.** An automatic contract is written by
 * machinery that does not know what the person wanted. It can therefore only
 * assert things that follow from the act itself:
 *
 *   - a write happened → the file is there, and its bytes are the bytes that
 *     were written;
 *   - a read or a search happened → nothing at all. A read proves the file was
 *     readable, which is not a claim about the task, so it produces a ledger
 *     receipt and no contract.
 *
 * That list is short on purpose, and the gap in it is the important part.
 *
 * **Why a shell command gets no automatic contract.** Core's `command_exit`
 * check *runs a command*. Submitting the agent's own command back to it would
 * re-execute it — a second `git push`, a second `rm`, a second migration —
 * under the name "verification". A check that changes the world is not a check.
 * The exit status the Host already observed is recorded as a receipt and stays
 * a receipt: "the command exited 0" is a fact about a process, and the distance
 * between that and "the thing the user asked for is true" is the whole subject
 * of this product. An explicit contract may name a command, because there a
 * person chose it; machinery may not choose it for them.
 *
 * @module @deepwatch/dsh-technology/attestation
 */

import { createHash } from 'node:crypto'
import type { ToolExecutionRecord } from '@deepwatch/dsh-contracts'

/**
 * One check, in the shape Watch Core's contract model accepts.
 *
 * Deliberately Core's vocabulary rather than a DeepWatch one. A second
 * spelling translated at the boundary would be a second place for the two
 * sides to disagree about what was asked.
 */
export interface CoreCheck {
  readonly id: string
  readonly type: 'file_exists' | 'file_digest' | 'json_value' | 'command_exit'
  readonly required: boolean
  readonly description: string
  readonly params: Readonly<Record<string, unknown>>
}

/**
 * Why an automatic contract was or was not built, in the Host's own words.
 *
 * Separate from anything Core says. `no_claim_available` is the interesting
 * one: it is what an honest system says about a read, and about a write whose
 * content it never saw.
 */
export type AttestationBasis =
  /** Checks were built and can be submitted. */
  | 'operation_checks'
  /** The act supports no claim the Host can make truthfully. */
  | 'no_claim_available'
  /** Re-running it would be a side effect, not a check. */
  | 'would_re_execute'

/** What the Host prepared for one record, before Core has seen it. */
export interface OperationContract {
  readonly basis: AttestationBasis
  readonly checks: readonly CoreCheck[]
  /** What the contract is about, for the record and for a person reading it. */
  readonly expectation: string
  /** Stable across identical inputs, so one act yields one contract. */
  readonly contractId: string
}

/** `sha256:` over UTF-8 bytes. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A short, stable id derived from what the contract is about. */
function contractIdFor(record: ToolExecutionRecord): string {
  return `op_${sha256(record.idempotencyKey).slice(0, 16)}`
}

/**
 * The content a write tool was given, when it was given any.
 *
 * Read from the argument shapes the file tools actually use. Absent — an edit
 * expressed as a patch, a copy, a tool this distribution has not seen — the
 * Host does not know what should be on disk and says so rather than guessing.
 */
export function writtenContent(argumentsValue: unknown): string | null {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return null
  const record = argumentsValue as Record<string, unknown>
  for (const key of ['content', 'contents', 'text', 'data', 'body']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}

/**
 * Build the narrowest true contract for one settled action.
 *
 * Every branch here is a decision about what may honestly be claimed, and the
 * refusals are as deliberate as the checks.
 */
export function operationContract(
  record: ToolExecutionRecord, argumentsValue: unknown,
): OperationContract {
  const contractId = contractIdFor(record)

  // A refused or failed action is not something to verify. There is nothing to
  // be true about a write that did not happen, and the ledger already says so.
  if (record.state !== 'completed') {
    return {
      basis: 'no_claim_available', checks: [], contractId,
      expectation: `${record.toolName} did not complete, so there is nothing to verify`,
    }
  }

  // A read proves the file was readable. That is a fact about the filesystem,
  // not about the task, so it earns a receipt and no verdict.
  if (record.sideEffect === 'read' || record.sideEffect === 'none') {
    return {
      basis: 'no_claim_available', checks: [], contractId,
      expectation: `${record.toolName} observed state without changing it`,
    }
  }

  // See the module note. Re-running the command would be the side effect it
  // claims to be checking.
  if (record.sideEffect === 'execute') {
    return {
      basis: 'would_re_execute', checks: [], contractId,
      expectation:
        `${record.toolName} exited ${String(record.exitStatus)}. That is the exit status of a `
        + 'process, not evidence that the task succeeded, and re-running the command to '
        + 'check it would repeat whatever it did.',
    }
  }

  // A write with no path is a write the Host cannot name a file for.
  if (record.paths.length === 0) {
    return {
      basis: 'no_claim_available', checks: [], contractId,
      expectation: `${record.toolName} changed state at no path this Host can name`,
    }
  }

  const content = writtenContent(argumentsValue)
  const checks: CoreCheck[] = []
  for (const [index, path] of record.paths.entries()) {
    checks.push({
      id: `${contractId}_exists_${String(index)}`,
      type: 'file_exists',
      required: true,
      description: `${path} exists after the write`,
      params: { path, expected: true },
    })
    // Only when the Host actually saw the bytes. A digest of something it did
    // not see would be a check of its own guess.
    if (content !== null && record.paths.length === 1) {
      checks.push({
        id: `${contractId}_digest_${String(index)}`,
        type: 'file_digest',
        required: true,
        description: `${path} holds exactly the bytes that were written`,
        params: { path, sha256: sha256(content) },
      })
    }
  }

  return {
    basis: 'operation_checks',
    checks,
    contractId,
    expectation: content === null
      ? `${record.toolName} wrote ${record.paths.join(', ')}`
      : `${record.toolName} wrote ${record.paths.join(', ')} with the exact content it was given`,
  }
}

/**
 * What became of an attestation, from the Host's side.
 *
 * None of these is a verdict, and the naming keeps it that way. `answered`
 * means Core replied and its verdict is recorded beside this; every other value
 * means no verdict exists, which a surface must show as such.
 */
export type AttestationState =
  /** Built, not yet sent. */
  | 'prepared'
  /** Nothing truthful to ask, so nothing was asked. */
  | 'no_contract'
  /** Sent, and Core answered. Read its verdict, not this. */
  | 'answered'
  /**
   * A verification was asked for and no valid contract reached Core.
   *
   * The honest non-verdict. A surface showing this must not present
   * verification as successful, and the final response must not either.
   */
  | 'requested_but_not_run'
  /** Core could not be reached. Also not a verdict. */
  | 'unavailable'

/** One attestation, as the ledger holds it. */
export interface Attestation {
  readonly idempotencyKey: string
  readonly contractId: string
  readonly state: AttestationState
  readonly basis: AttestationBasis
  readonly expectation: string
  /** `sha256:…` over the frozen checks, so the question cannot change after the fact. */
  readonly contractDigest: string
  /**
   * Core's verdict, exactly as Core returned it, or null when there is none.
   *
   * Read, never derived. A null here is not a failure and not a success; it is
   * the absence of a verdict, and the difference is the product.
   */
  readonly coreVerdict: string | null
  readonly coreReason: string | null
  readonly verificationId: string | null
  readonly at: string
}

/** The frozen digest of a contract's checks. */
export function freezeChecks(checks: readonly CoreCheck[]): string {
  return `sha256:${sha256(JSON.stringify(checks))}`
}

/**
 * The payload `watch.verification.run` expects.
 *
 * Built here so the one place that talks to Core about an automatic contract is
 * the one place that knows the wire shape.
 */
export function verificationRequest(
  contract: OperationContract, verificationId: string, workingDir: string | null,
): Record<string, unknown> {
  return {
    expectation: contract.expectation,
    verificationId,
    checks: contract.checks,
    ...workingDir === null ? {} : { workingDir },
  }
}
