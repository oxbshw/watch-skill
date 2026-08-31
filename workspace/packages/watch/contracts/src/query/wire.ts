/**
 * The read plane's wire DTOs, and nothing else.
 *
 * Typert builds a type graph over a Remote's signature and emits a strict
 * codec from it. That graph is only as tractable as the types it reaches, so
 * this module is deliberately the smallest thing that can describe the wire:
 * concrete, JSON-representable, and free of the machinery that makes the
 * runtime module useful to write against.
 *
 * What is banned here, and why each one matters to a generated schema:
 *
 *   - `unknown` and `any` — nothing to describe, so the analyzer has nothing
 *     to emit and fails rather than reporting an empty model.
 *   - an open `Record<string, unknown>` — a schema that validates anything is
 *     a schema that validates nothing.
 *   - generics at the boundary — `QuerySnapshot<Item>` is pleasant to write
 *     and forces the analyzer to instantiate a type it cannot name.
 *   - parser functions — they take `unknown` by their nature.
 *   - Host classes, Node types, filesystem types — none of them cross a wire.
 *
 * There is exactly one result envelope, and it is not here. Typert wraps every
 * invocation in `RemoteResult<T>`, which carries transport, Gateway,
 * cancellation and codec failure. What this module defines is the *domain*
 * outcome inside that envelope: the answers a surface has to render
 * differently, like a cursor that has expired or an index that is still
 * rebuilding. Nesting a second `WatchResult` inside `RemoteResult` would give
 * two overlapping vocabularies for failure and no rule about which one owns a
 * given case.
 *
 * Browser-safe: no Node imports, no runtime identity, nothing a client bundle
 * would have to deduplicate.
 *
 * @module @deepwatch/dsh-contracts/query/wire
 */

/** The read-plane contract version a wire message declares. */
export const WATCH_QUERY_WIRE_VERSION = 1

// ── requests ────────────────────────────────────────────────────────────────

/** What a Library search asks for. */
export interface LibrarySearchRequest {
  /** The contract version the caller speaks. */
  readonly protocol: number
  /** Correlates the answer, and is what a cancellation names. */
  readonly requestId: string
  /** Free text. Every term must match; the host decides how it tokenises. */
  readonly query: string
  /** Restrict to these modalities. Empty means all of them. */
  readonly modalities: readonly string[]
  /** How many records to return. The host clamps it. */
  readonly limit: number
  /** Continues an earlier snapshot, or null to start one. */
  readonly cursor: string | null
  /** How long the caller will wait. The host clamps it. */
  readonly deadlineMs: number
}

/** One Library record, by id. */
export interface LibraryGetRequest {
  readonly protocol: number
  readonly requestId: string
  /** An identifier, never a path: no separator, no colon, no dot-dot. */
  readonly recordId: string
  readonly deadlineMs: number
}

// ── records ─────────────────────────────────────────────────────────────────

/**
 * One record, as the surface renders it.
 *
 * The provenance fields are the persisted ones rather than anything derived.
 * `observedAt` in particular is the record's own timestamp: an earlier version
 * of this shape computed a `capturedAt` from a temporal range's `startMs`,
 * which is a media-relative offset, so a clip beginning at zero was rendered
 * as January 1970.
 */
export interface LibraryRecord {
  readonly recordId: string
  readonly revisionId: string
  readonly title: string
  readonly modality: string
  /** When the source was observed. An ISO-8601 instant, or null if unknown. */
  readonly observedAt: string | null
  /** Which source produced it. */
  readonly source: string
  /** The run it belongs to, when it belongs to one. */
  readonly runId: string | null
  /** Core's verdict, when Core minted one. Never invented here. */
  readonly verdict: string | null
  readonly tags: readonly string[]
  /** The evidence this record points at. Never a filesystem path. */
  readonly evidenceIds: readonly string[]
  /** False when a newer revision of the same source exists. */
  readonly current: boolean
}

/**
 * Where a hit sits inside its source, on that source's own clock.
 *
 * Media-relative milliseconds, deliberately not an instant. A range and a
 * timestamp are different measurements and converting one to the other is how
 * a zero offset becomes 1970.
 */
export interface MediaRange {
  readonly startMs: number
  readonly endMs: number
}

// ── responses ───────────────────────────────────────────────────────────────

/** How complete an answer is, said out loud rather than implied by emptiness. */
export type LibraryIndexState = 'ready' | 'rebuilding' | 'stale' | 'empty'

/** A successful Library search. */
export interface LibrarySearchPage {
  readonly outcome: 'page'
  readonly protocol: number
  readonly requestId: string
  /** The host revision this page was produced from. */
  readonly revision: number
  /**
   * Which index generation answered.
   *
   * Explicit rather than left implicit inside `revision`. A surface that has
   * just asked for a refresh needs to know whether the page in front of it
   * came from the new index or the old one, and recovering that by arithmetic
   * on a packed number is the kind of thing a caller gets wrong once.
   */
  readonly generation: number
  readonly records: readonly LibraryRecord[]
  /** Non-null when more remains; pass it back as `cursor`. */
  readonly nextCursor: string | null
  /** How many records match in total, not merely on this page. */
  readonly total: number
  readonly indexState: LibraryIndexState
}

/** A single record, found. */
export interface LibraryRecordFound {
  readonly outcome: 'record'
  readonly protocol: number
  readonly requestId: string
  readonly revision: number
  readonly record: LibraryRecord
}

/** A single record, absent. Not a failure: the question had an answer. */
export interface LibraryRecordAbsent {
  readonly outcome: 'absent'
  readonly protocol: number
  readonly requestId: string
  readonly revision: number
  readonly recordId: string
}

/**
 * The cursor names a snapshot this host no longer holds.
 *
 * Bounded fields on purpose. The surface needs to say "your page is gone,
 * search again" and nothing here helps it say anything more specific, so
 * nothing here invites a caller to depend on more.
 */
export interface LibraryCursorExpired {
  readonly outcome: 'cursor_expired'
  readonly protocol: number
  readonly requestId: string
  /** The revision the host is on now, so a surface can say what changed. */
  readonly revision: number
}

/** The request did not satisfy the contract. Nothing was read. */
export interface LibraryRequestRejected {
  readonly outcome: 'rejected'
  readonly protocol: number
  readonly requestId: string
  /** Which rule the request broke. A closed set, not free text. */
  readonly reason:
    | 'protocol_mismatch'
    | 'malformed_request'
    | 'request_too_large'
    | 'identifier_invalid'
  /** Which field, when one field is responsible. */
  readonly field: string | null
}

/** The host could not answer inside the deadline it was given. */
export interface LibraryDeadlineExceeded {
  readonly outcome: 'deadline_exceeded'
  readonly protocol: number
  readonly requestId: string
  /** The deadline that elapsed, so the surface can offer a longer one. */
  readonly deadlineMs: number
}

/**
 * What `librarySearch` answers.
 *
 * A discriminated union on `outcome`, so a surface switches on one field and
 * the compiler tells it when a case is unhandled.
 */
export type LibrarySearchResponse =
  | LibrarySearchPage
  | LibraryCursorExpired
  | LibraryRequestRejected
  | LibraryDeadlineExceeded

/** What `libraryGet` answers. */
export type LibraryGetResponse =
  | LibraryRecordFound
  | LibraryRecordAbsent
  | LibraryRequestRejected
  | LibraryDeadlineExceeded

// ── refresh ─────────────────────────────────────────────────────────────────

/**
 * Ask the host to read its roots again and build a new index generation.
 *
 * An explicit operation rather than a flag on a search, because rebuilding is
 * a side effect and a search is not. Folding it into `librarySearch` would
 * make every keystroke a potential re-read of the corpus, and would leave a
 * caller with no way to say "answer from what you have" — which is what a
 * search means.
 */
export interface LibraryRefreshRequest {
  readonly protocol: number
  readonly requestId: string
  /**
   * How long the caller will wait.
   *
   * A caller that stops waiting does not stop the rebuild on its own: the work
   * belongs to the host and other callers may be waiting on the same one. What
   * ends it early is every waiter withdrawing, which the host tracks.
   */
  readonly deadlineMs: number
}

/**
 * One index generation, described.
 *
 * `generation` increments only when a rebuild produced a healthy index that
 * was swapped into service, so a caller comparing it across two answers learns
 * whether what it is reading changed underneath it.
 */
export interface LibraryIndexGeneration {
  readonly generation: number
  /** ISO-8601. When the rebuild that produced this generation began. */
  readonly startedAt: string
  /** ISO-8601, or null while a rebuild is still running. */
  readonly completedAt: string | null
  /** Roots read. */
  readonly sourceCount: number
  /** Records indexed. */
  readonly recordCount: number
  readonly indexState: LibraryIndexState
}

/** The rebuild finished and its result is now what searches answer from. */
export interface LibraryRefreshed {
  readonly outcome: 'refreshed'
  readonly protocol: number
  readonly requestId: string
  readonly index: LibraryIndexGeneration
  /** Files the host declined to read, by name. Never a path. */
  readonly skipped: readonly string[]
}

/**
 * Every waiter withdrew before the rebuild finished, so it was abandoned.
 *
 * The generation named here is the one still in service — a cancelled rebuild
 * never replaces a healthy index.
 */
export interface LibraryRefreshCancelled {
  readonly outcome: 'refresh_cancelled'
  readonly protocol: number
  readonly requestId: string
  readonly index: LibraryIndexGeneration
}

/**
 * The rebuild failed, and the previous generation is still in service.
 *
 * Reported rather than thrown: a failed refresh leaves a working Library, and
 * a surface has to be able to say both things at once.
 */
export interface LibraryRefreshFailed {
  readonly outcome: 'refresh_failed'
  readonly protocol: number
  readonly requestId: string
  /** What went wrong, in words. Never a path and never a stack. */
  readonly reason: string
  readonly index: LibraryIndexGeneration
}

/** What `libraryRefresh` answers. */
export type LibraryRefreshResponse =
  | LibraryRefreshed
  | LibraryRefreshCancelled
  | LibraryRefreshFailed
  | LibraryRequestRejected
  | LibraryDeadlineExceeded

// -- core health -------------------------------------------------------------

/**
 * Ask the Host what Watch Core is doing right now.
 *
 * This method exists because Diagnostics had no way to find out. The panel
 * rendered "Watch Core — Connected over stdio" as a green chip and a version
 * beside it, and both were literals typed into a component: the read plane
 * carried Library reads and nothing else, so the one screen whose job is to
 * report the state of the engine was the one screen with no channel to it.
 *
 * The interim fix was to say "not read from here", which was honest and is not
 * a product. This is the channel.
 */
export interface CoreHealthRequest {
  readonly protocol: number
  readonly requestId: string
  readonly deadlineMs: number
}

/**
 * Why the product is in the state it is in, in one word a screen can act on.
 *
 * Mirrors `BridgeBlocker`. Restated here rather than imported because this
 * union crosses a generated codec, and a codec generated from an alias to
 * another module's type is a codec that stops matching when that module moves.
 */
export type CoreBlocker =
  | 'connected'
  | 'core_missing'
  | 'bridge_surface_missing'
  | 'handshake_failed'
  | 'protocol_mismatch'
  | 'contract_mismatch'
  | 'core_crashed'
  | 'core_timeout'
  | 'circuit_open'
  | 'test_only_mock'

/** How many capabilities are in each state, so a screen need not count. */
export interface CapabilityTally {
  /** Usable now: the engine reported them implemented or machine-tested. */
  readonly ready: number
  /** Known to be unusable here, with a reason the report carries. */
  readonly unavailable: number
  /** Present but reduced — a dependency probed, or a contract family drifted. */
  readonly degraded: number
  /** Never checked. Not the same as unavailable. */
  readonly unknown: number
}

/**
 * What the Host observed about Watch Core, at the moment it was asked.
 *
 * Every field is read from the running Bridge. There is no field here a
 * component may substitute a default for: a value that could not be read is
 * `null`, and a screen renders that as "not reported" rather than as a
 * plausible number.
 */
export interface CoreHealthReport {
  readonly outcome: 'core_health'
  readonly protocol: number
  readonly requestId: string
  /** `disconnected` | `connecting` | `ready` | `degraded` | `failed`. */
  readonly phase: string
  readonly blocker: CoreBlocker
  /** The engine's own version string. Null until a handshake has completed. */
  readonly coreVersion: string | null
  readonly coreBuild: string | null
  /** The negotiated protocol, and the range Core said it supports. */
  readonly protocolVersion: number | null
  readonly protocolMin: number | null
  /** Which backend is actually in use. Null before the first attempt. */
  readonly transport: string | null
  /**
   * True only when the backend is the in-process fixture.
   *
   * Every surface that could present data as observed reads this first. It is
   * carried separately from `transport` so that adding a second fake backend
   * cannot quietly bypass the check.
   */
  readonly isTestOnlyMock: boolean
  /** Whether Core's contract digests matched this build's. */
  readonly contractsMatch: boolean
  /** Families that disagreed, empty when they match. */
  readonly contractDrift: readonly string[]
  /** ISO-8601 of the last handshake that completed, null if none ever has. */
  readonly lastHandshakeAt: string | null
  /** Core processes started this session. A climbing number is a crash loop. */
  readonly restartCount: number
  readonly capabilities: CapabilityTally
  /** What to do about `blocker`, in words. Empty only when connected. */
  readonly fix: string
}

/** What `coreHealth` answers. */
export type CoreHealthResponse =
  | CoreHealthReport
  | LibraryRequestRejected
  | LibraryDeadlineExceeded
