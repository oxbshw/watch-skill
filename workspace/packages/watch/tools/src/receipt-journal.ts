/**
 * Execution receipts that outlive the process that made them.
 *
 * They did not. Receipts were indexed live by the Host as each call settled
 * and were never written anywhere, so stopping DeepWatch lost them: a room
 * holding thirteen receipts was restarted and afterwards the Library returned
 * one, the receipt created after the restart. `Refresh` did not bring them
 * back — it re-reads evidence roots on disk, and an in-memory receipt from
 * before the restart is not on disk to be read.
 *
 * That made the Library two different things wearing one name. Indexed sources
 * are Watch Core's and persist; receipts were a live view that looked
 * identical and did not. A person who read "every receipt this workspace
 * recorded" and came back tomorrow found nothing, with no error to explain it.
 *
 * So receipts get a journal. It is append-only, one JSON object per line, and
 * it is owned by this plugin rather than by Core: a receipt is the *Host's*
 * observation of its own tool calls, and Core is the verdict authority, not
 * the Host's filing cabinet (ADR-002). Sending receipts across the Bridge to
 * be stored would put Core's name on a record it did not make.
 *
 * **What is written is what was already filed.** The record is the same
 * {@link IndexableRecord} the Library indexes, whose text is built from the
 * ledger's own bounded, redacted summaries. Nothing is re-derived here from
 * anything unredacted, no raw tool arguments are kept, and no credential can
 * reach it: the ledger it comes from carries neither.
 *
 * **A torn line is not a lost journal.** Appends are single writes of a
 * complete line, which is atomic enough for the failure that actually happens
 * — the process dying mid-append — but not a guarantee. So the reader parses
 * line by line and drops what it cannot parse, counting it, rather than
 * refusing the whole file. A journal whose last line is half-written still
 * restores every receipt before it.
 *
 * **Replay is idempotent.** Lines are keyed by `recordId`, last write wins, so
 * a receipt and its later verdict revision collapse to one record with the
 * verdict on it, and reading the journal twice yields the same set.
 *
 * @module
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { IndexableRecord } from '@deepwatch/dsh-library'

/** Only the owner may read a journal: it names paths inside their workspace. */
const OWNER_ONLY_DIRECTORY = 0o700
const OWNER_ONLY_FILE = 0o600

/** What a load found, so a caller can report damage rather than hide it. */
export interface JournalLoad {
  /** Records, newest write per `recordId`, in the order they were first seen. */
  readonly records: readonly IndexableRecord[]
  /** Lines that could not be parsed — a torn append, or a corrupted file. */
  readonly damaged: number
  /** Lines read in total, damaged included. */
  readonly lines: number
}

/** Best-effort permission tightening; a filesystem that cannot is not a failure. */
function restrict(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // Windows and most network filesystems ignore POSIX modes. The journal is
    // inside a profile directory the operating system already protects, so a
    // refusal here is not worth failing a boot over.
  }
}

/**
 * A record is only worth restoring if it still has an identity.
 *
 * Written defensively because this reads a file that survived a crash: a line
 * that parses as JSON is not necessarily a record, and filing a shapeless
 * object would put a row in the Library that no reader could act on.
 */
function isRecord(value: unknown): value is IndexableRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['recordId'] === 'string' && record['recordId'] !== ''
    && typeof record['revisionId'] === 'string'
    && typeof record['title'] === 'string'
    && typeof record['text'] === 'string'
}

/** An append-only journal of execution receipts for one profile. */
export class ReceiptJournal {
  readonly #path: string

  /**
   * @param directory - where the journal lives, created if it is not there.
   */
  constructor(directory: string) {
    this.#path = join(directory, 'receipts.jsonl')
  }

  /** Where the journal is, for a diagnostic that has to name it. */
  get path(): string {
    return this.#path
  }

  /**
   * Add one record to the end of the journal.
   *
   * Never throws. A receipt that cannot be journalled is still indexed live,
   * and losing the durable copy is not a reason to fail the tool call it
   * describes — the call already happened.
   *
   * @param record - the record as it was filed in the Library.
   * @returns true when it was written.
   */
  append(record: IndexableRecord): boolean {
    try {
      const directory = dirname(this.#path)
      if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY })
        restrict(directory, OWNER_ONLY_DIRECTORY)
      }
      const fresh = !existsSync(this.#path)
      // One write of one complete line. The failure this survives is the
      // process dying mid-append, which leaves a partial last line that the
      // reader drops.
      appendFileSync(this.#path, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8', mode: OWNER_ONLY_FILE,
      })
      if (fresh) restrict(this.#path, OWNER_ONLY_FILE)
      return true
    } catch {
      return false
    }
  }

  /**
   * Every record the journal holds, last write per id.
   *
   * A missing journal is an empty one: a first run has nothing to restore and
   * that is not a fault. A damaged line is counted and skipped, so a torn
   * append costs one record rather than all of them.
   */
  load(): JournalLoad {
    if (!existsSync(this.#path)) return { records: [], damaged: 0, lines: 0 }
    let text: string
    try {
      text = readFileSync(this.#path, 'utf8')
    } catch {
      return { records: [], damaged: 0, lines: 0 }
    }
    const lines = text.split('\n').filter(line => line.trim() !== '')
    const byId = new Map<string, IndexableRecord>()
    let damaged = 0
    for (const line of lines) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        damaged += 1
        continue
      }
      if (!isRecord(parsed)) {
        damaged += 1
        continue
      }
      // Last write wins, and the insertion order of the first sighting is
      // kept: a verdict revision replaces its receipt in place rather than
      // moving it to the end of the Library.
      byId.set(parsed.recordId, parsed)
    }
    return { records: [...byId.values()], damaged, lines: lines.length }
  }
}
