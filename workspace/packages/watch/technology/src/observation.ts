/**
 * Watch, listening at the boundary every tool call already goes through.
 *
 * **What happened without this.** An owner evaluation ran a real task against a
 * real provider: 1 user turn, 47 model rounds, 76 tool calls, ten minutes. Watch
 * recorded nothing. Not a failure to write — a failure to be present: every
 * Watch capability was a *tool the model could choose to call*, and the model
 * never chose to. So Trajectory held a generic agent transcript, Watch held no
 * execution record, Library reported `Index is behind the store` over an empty
 * index, Compare had nothing, and the agent's own `verification.json` — written
 * by the model and reread by the model — was the only thing resembling a
 * verdict. The product whose entire subject is evidence produced none.
 *
 * The tempting fix is a paragraph in the system prompt asking the model to
 * remember Watch. That is not a fix. A capability that depends on the model
 * remembering it exists is a suggestion, and it fails exactly when the task is
 * busy enough to matter.
 *
 * **Where this sits.** `@deepseek-ai/dsh-tools` publishes the whole dispatch
 * lifecycle, so nothing here forks upstream or patches an individual tool:
 *
 *   - `tools/pre-execute` — a **waterfall** returning allow/deny/ask. The one
 *     place containment can refuse a call before it happens.
 *   - `tools/execute` — a **waterfall** wrapped around the dispatch. Where a
 *     call becomes `running`, and where its duration comes from.
 *   - `tools/result` — an **emit** carrying the frozen final outcome. Where a
 *     record settles. Listener failures are contained here by upstream, which
 *     is why the settling half lives on the safe event rather than the
 *     load-bearing one.
 *
 * Modes are load-bearing and getting one wrong is silent: a waterfall listener
 * written as an observer returns `undefined` in place of the decision the
 * pipeline was about to make. That exact mistake cost this branch an afternoon
 * on `agent/pre-step`, so every waterfall here takes `next` and returns it, and
 * a test reads upstream's own `@mode` annotations to keep it that way.
 *
 * **One owner.** A Cordis service is reflected per scope, so a registry held by
 * whichever plugin constructed it is a registry two halves can disagree about —
 * also learned expensively, on this branch, in `provenance.ts`. This is a
 * bundle row of its own and everything that needs it injects it.
 *
 * **What it will not do.** It does not decide whether anything worked. A record
 * settles as `completed` and stays `UNVERIFIED`; only a verification contract
 * evaluated against evidence moves it. It spends no provider request, ever:
 * every field is taken from the dispatch that was already happening.
 *
 * @module @deepwatch/dsh-technology/observation
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  EXECUTION_RECORD_VERSION, boundSummary, executionKey, redactSecrets,
} from '@deepwatch/dsh-contracts'
import type {
  ScopeDecision, SideEffectClass, ToolExecutionRecord, WorkspaceScope,
} from '@deepwatch/dsh-contracts'
import {
  containsPath, findAbsolutePaths, relativeToRoot, resolveTraversal,
} from '@deepwatch/dsh-contracts'
import { PROVENANCE_SERVICE } from './provenance.js'
import type { WatchProvenance } from './provenance.js'

/** The service name everything reaches this by. */
export const OBSERVATION_SERVICE = 'watchObservation'

/**
 * How many settled records the Host keeps in memory.
 *
 * The ledger is a live view, not the durable store — records are handed to the
 * Library for that. This bound is what stops a ten-minute, 76-call session from
 * becoming a memory leak, and it is generous enough that the whole of such a
 * session is still inspectable.
 */
export const LEDGER_LIMIT = 2_000

/**
 * Which tools touch what, by their declared upstream names.
 *
 * A table rather than a guess from the name: `read_file` and `read_page` are
 * not the same kind of act, and a substring match would eventually classify
 * something dangerous as a read. A name absent from this table is `unknown`,
 * and `unknown` never counts as harmless.
 */
const SIDE_EFFECTS: Readonly<Record<string, SideEffectClass>> = {
  read_file: 'read',
  read_files: 'read',
  list_dir: 'read',
  glob: 'read',
  grep: 'read',
  search: 'read',
  write_file: 'write',
  edit_file: 'write',
  create_file: 'write',
  delete_file: 'write',
  move_file: 'write',
  apply_patch: 'write',
  bash: 'execute',
  shell: 'execute',
  powershell: 'execute',
  run_code: 'execute',
  run_command: 'execute',
  fetch: 'network',
  web_search: 'network',
  todo_write: 'none',
  update_plan: 'none',
}

/** The argument keys that carry a path, by the tools that take them. */
const PATH_KEYS: readonly string[] = [
  'path', 'file', 'filePath', 'file_path', 'dir', 'directory', 'cwd',
  'source', 'destination', 'target', 'paths', 'files',
]

/** The classification for one tool name, failing closed on anything unlisted. */
export function classifySideEffect(toolName: string): SideEffectClass {
  return SIDE_EFFECTS[toolName] ?? 'unknown'
}

/** Every path-shaped value in an argument object, without interpreting the rest. */
export function pathsIn(argumentValue: unknown): readonly string[] {
  if (typeof argumentValue !== 'object' || argumentValue === null) return []
  const record = argumentValue as Record<string, unknown>
  const found: string[] = []
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') found.push(value)
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string' && entry !== '') found.push(entry)
    }
  }
  return found
}

/**
 * The path a call would actually reach, with links followed.
 *
 * Traversal is resolved in the shared helper, which is pure and can run in a
 * browser. A symlink or a junction cannot be: only the filesystem knows where
 * one points, and a boundary that compares spellings is a boundary a link walks
 * through. So the Host resolves what exists.
 *
 * A path that does not exist yet — a file about to be written — has its nearest
 * existing ancestor resolved instead, which is the case that matters: writing
 * into a symlinked directory is how a write escapes, and the directory exists
 * even when the file does not.
 *
 * Unresolvable, the traversal-resolved spelling is returned. That fails towards
 * refusal rather than towards permission: an unreadable path is not shown to be
 * inside the workspace, so containment treats it as outside.
 */
export function realise(candidate: string): string {
  let probe = resolve(resolveTraversal(candidate))
  const climbed: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = realpathSync.native(probe)
      return resolveTraversal(climbed.length === 0 ? real : join(real, ...climbed.reverse()))
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return resolveTraversal(candidate)
      // Both separators. The slice keeps whichever one this platform used, and
      // stripping only the forward one leaves a leading backslash that `join`
      // would then treat as the start of a path of its own.
      climbed.push(probe.slice(parent.length).replace(/^[\\/]+/u, ''))
      probe = parent
    }
  }
  return resolveTraversal(candidate)
}

/** Where a call's paths land relative to the chosen workspace. */
export interface ScopeReading {
  readonly scope: WorkspaceScope
  /** Workspace-relative, and only for the paths that are inside it. */
  readonly inside: readonly string[]
  readonly outsideCount: number
}

/**
 * Decide containment for one call's paths.
 *
 * A path outside the workspace is counted, never recorded. The count is the
 * fact a person needs — that the agent reached outside — and the path itself is
 * the disclosure they did not ask for: it carries their user name and the shape
 * of their disk into a record that gets exported, indexed and shown.
 */
export function readScope(
  paths: readonly string[], workspace: string | null,
): ScopeReading {
  if (paths.length === 0) return { scope: 'not_applicable', inside: [], outsideCount: 0 }
  if (workspace === null || workspace === '') {
    return { scope: 'no_workspace', inside: [], outsideCount: 0 }
  }
  // Both sides realised, so a workspace that is itself reached through a link
  // still contains the files inside it.
  const root = realise(workspace)
  const inside: string[] = []
  let outsideCount = 0
  for (const path of paths) {
    const landing = realise(path)
    if (containsPath(root, landing)) {
      const relative = relativeToRoot(landing, root)
      if (relative !== null) inside.push(relative)
    } else outsideCount += 1
  }
  return {
    scope: outsideCount > 0 ? 'outside_workspace' : 'inside',
    inside,
    outsideCount,
  }
}

/**
 * How strictly the Host holds a call to the workspace somebody selected.
 *
 * `enforce` is the default and the only setting under which `Workspace Write`
 * is a true statement. `record` exists for a deployment mid-migration that
 * wants the ledger before the refusals, and says so in its own name rather
 * than pretending to contain anything. `off` is for a deployment that has its
 * own boundary and does not want a second one.
 */
export type ContainmentMode = 'enforce' | 'record' | 'off'

/** Why a call was refused, in words a person can act on. */
export interface Refusal {
  readonly reason: string
  readonly reading: ScopeReading
}

/**
 * The permission modes upstream offers, and what each means for containment.
 *
 * `danger-full-access` is the one that opts out. It is named that way upstream
 * for the same reason it is honoured here: somebody chose it explicitly, and a
 * boundary that ignored an explicit wider grant would be a different lie from
 * the one this fixes.
 */
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Whether one call may proceed, given where its paths resolve.
 *
 * Returns null to allow. Everything about this is deliberately boring: it
 * asks the same question of every tool and answers it the same way, because
 * the failure it replaces was a boundary that existed only as a label.
 *
 * The empty-workspace case is the one worth reading twice. The evaluation that
 * prompted this selected an empty workspace, found nothing in it, and — instead
 * of stopping — searched other drives and read unrelated locations. "Nothing
 * here" is a question for the person who chose the directory, not licence to go
 * looking. So a path-bearing call with no workspace is refused, and the refusal
 * says what to do about it.
 */
export function containmentRefusal(
  reading: ScopeReading, mode: ContainmentMode, permission: PermissionMode,
): Refusal | null {
  if (mode !== 'enforce') return null
  if (permission === 'danger-full-access') return null
  if (reading.scope === 'inside' || reading.scope === 'not_applicable') return null
  if (reading.scope === 'no_workspace') {
    return {
      reason: 'no workspace is selected, so this path cannot be checked against one. '
        + 'Choose the directory to work in and try again; searching outside it is not '
        + 'the same as working in it.',
      reading,
    }
  }
  return {
    reason: `${String(reading.outsideCount)} path(s) in this call resolve outside the `
      + 'selected workspace. Work inside it, or ask for a wider permission mode '
      + 'explicitly — "workspace write" means the workspace.',
    reading,
  }
}

/** What an absolute path outside the workspace is replaced by. */
export const OUTSIDE_PLACEHOLDER = '<outside-workspace>'

/**
 * Convert every absolute path in a summary before it is stored.
 *
 * The counterfactual that found this: an outside path was correctly kept out of
 * the `paths` array and then walked straight back in through the serialised
 * arguments, because a summary is text and nobody had asked the text the
 * containment question. A record that says `outside_workspace` while printing
 * the path beside it has disclosed exactly what the classification was there
 * to avoid — the operating system user's name included.
 *
 * Inside the workspace, a path becomes workspace-relative — the useful half.
 * Outside it, the path becomes {@link OUTSIDE_PLACEHOLDER} — the fact without
 * the disclosure. A path under no workspace at all is replaced too: with no
 * root to measure against, there is no relative form to fall back to and the
 * absolute one is not ours to keep.
 */
export function redactPathsIn(text: string, workspace: string | null): string {
  let out = text
  // Longest first, so replacing a short path cannot cut a longer one in half.
  const found = [...new Set(findAbsolutePaths(text))]
    .sort((a, b) => b.length - a.length)
  for (const path of found) {
    const relative = workspace === null ? null : relativeToRoot(path, workspace)
    out = out.split(path).join(relative ?? OUTSIDE_PLACEHOLDER)
  }
  return out
}

/** `sha256:…` over the exact bytes a summary was cut from. */
export function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** The minimum this module needs from an execution, described structurally. */
interface ExecutionLike {
  readonly callId?: unknown
  readonly rootCallId?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
  readonly agent?: { readonly id?: unknown } | undefined
}

/** The minimum this module needs from a result. */
interface ResultLike {
  readonly isError?: unknown
  readonly error?: unknown
  readonly content?: unknown
  readonly value?: unknown
}

/** A record still being built, between `tools/execute` and `tools/result`. */
interface OpenCall {
  readonly identity: { sessionId: string, turnId: string, callId: string, attempt: number }
  readonly startedAt: number
  readonly toolName: string
}

/**
 * The Host's ledger of what its tools actually did.
 *
 * Mounted once by {@link apply}; everything else injects it. Holds settled
 * records and the calls currently in flight, and answers the read plane.
 */
export class WatchObservation extends Service {
  /** Settled records, oldest first, bounded by {@link LEDGER_LIMIT}. */
  private readonly records: ToolExecutionRecord[] = []
  /** In-flight calls, by the upstream call id. */
  private readonly open = new Map<string, OpenCall>()
  /** Attempts already seen per action, so a retry is numbered rather than duplicated. */
  private readonly attempts = new Map<string, number>()
  /**
   * The workspace each session was opened in, by session id.
   *
   * Per session rather than one global, because two sessions can be open on two
   * directories and a single root would quietly measure one against the other.
   */
  private readonly workspaces = new Map<string, string>()
  /** The session whose workspace an unattributed call is measured against. */
  private fallbackWorkspace: string | null = null
  /** How strictly this Host holds calls to it. */
  private mode: ContainmentMode = 'enforce'

  constructor(ctx: Context) {
    super(ctx, OBSERVATION_SERVICE)
  }

  /** Point containment at the workspace a person selected for one session. */
  setWorkspace(root: string | null, sessionId?: string): void {
    const value = root === null || root === '' ? null : root
    if (sessionId === undefined) {
      this.fallbackWorkspace = value
      return
    }
    if (value === null) this.workspaces.delete(sessionId)
    else this.workspaces.set(sessionId, value)
  }

  /** The workspace one session is held to, or the fallback when it named none. */
  workspaceRoot(sessionId?: string): string | null {
    if (sessionId !== undefined) {
      const known = this.workspaces.get(sessionId)
      if (known !== undefined) return known
    }
    return this.fallbackWorkspace
  }

  /** How strictly calls are held to the workspace. */
  containmentMode(): ContainmentMode {
    return this.mode
  }

  /** Set it. A composition decides this; nothing in a conversation can. */
  setContainmentMode(mode: ContainmentMode): void {
    this.mode = mode
  }

  /**
   * Decide one call, and record the decision whichever way it goes.
   *
   * Called from `tools/pre-execute`. A refusal is a record too: an attempt to
   * reach outside the workspace is something the owner is entitled to see, and
   * the evaluation that prompted this made several that nobody could.
   */
  screen(
    exec: ExecutionLike, sessionId: string, permission: PermissionMode,
  ): Refusal | null {
    const workspace = this.workspaceRoot(sessionId)
    const reading = readScope(pathsIn(exec.arguments), workspace)
    const refusal = containmentRefusal(reading, this.mode, permission)
    if (refusal !== null) this.refuse(exec, sessionId, reading, 'denied')
    return refusal
  }

  /**
   * The turn a call belongs to, taken from the same service that authorised the
   * provider request.
   *
   * One source for "which turn is this", so a tool record and the request that
   * paid for it cannot disagree about which turn they were part of.
   */
  private turnOf(): { turnId: string, authorisedBy: string | null } {
    const provenance = this.ctx.get?.(PROVENANCE_SERVICE) as unknown as
      WatchProvenance | undefined
    const active = provenance?.activeTurn() ?? null
    return { turnId: active ?? 'no-turn', authorisedBy: active }
  }

  /**
   * Note that a call is starting, and say which attempt it is.
   *
   * Called from the around-dispatch waterfall, so a call that never returns is
   * still visible as `running` rather than absent.
   */
  begin(exec: ExecutionLike, sessionId: string): string {
    const callId = typeof exec.callId === 'string' ? exec.callId : 'unknown-call'
    const toolName = typeof exec.name === 'string' ? exec.name : 'unknown-tool'
    const { turnId } = this.turnOf()
    const action = `${sessionId}/${turnId}/${callId}`
    const attempt = (this.attempts.get(action) ?? 0) + 1
    this.attempts.set(action, attempt)
    this.open.set(callId, {
      identity: { sessionId, turnId, callId, attempt },
      startedAt: Date.now(),
      toolName,
    })
    return callId
  }

  /**
   * Settle a call into a record.
   *
   * Everything it needs was captured at `begin`; a call that reaches here
   * without one still produces a record, marked as the single attempt it can be
   * proved to be, because a missing start is not a reason to lose the fact that
   * something ran.
   */
  settle(exec: ExecutionLike, result: ResultLike, sessionId: string): ToolExecutionRecord {
    const callId = typeof exec.callId === 'string' ? exec.callId : 'unknown-call'
    const opened = this.open.get(callId)
    this.open.delete(callId)
    const { turnId, authorisedBy } = this.turnOf()
    const identity = opened?.identity ?? { sessionId, turnId, callId, attempt: 1 }
    const toolName = opened?.toolName
      ?? (typeof exec.name === 'string' ? exec.name : 'unknown-tool')

    const startedAt = opened?.startedAt ?? Date.now()
    const endedAt = Date.now()
    const failed = result.isError === true
    const paths = pathsIn(exec.arguments)
    const reading = readScope(paths, this.workspaceRoot(sessionId))
    const output = renderContent(result)

    const record: ToolExecutionRecord = {
      version: EXECUTION_RECORD_VERSION,
      ...identity,
      idempotencyKey: executionKey(identity),
      rootCallId: typeof exec.rootCallId === 'string' ? exec.rootCallId : null,
      subagentId: typeof exec.agent?.id === 'string' ? exec.agent.id : null,
      parentTurnId: opened === undefined ? null : authorisedBy,
      toolName,
      state: failed ? 'failed' : 'completed',
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
      exitStatus: failed ? failureCode(result) : 'ok',
      sideEffect: classifySideEffect(toolName),
      scope: reading.scope,
      scopeDecision: 'allowed',
      paths: reading.inside,
      outsidePathCount: reading.outsideCount,
      inputSummary: this.summarise(renderArguments(exec.arguments), sessionId),
      outputSummary: this.summarise(output, sessionId),
      // Over the real output, not the redacted summary: the digest is what
      // makes the summary checkable against what actually came back.
      outputDigest: digestOf(output),
      authorisedBy,
      // Never anything else at mint. A tool that returned is a tool that
      // returned; the verdict is a separate question with a separate answer.
      verification: 'UNVERIFIED',
    }
    this.push(record)
    return record
  }

  /** Record a call the containment gate refused, which never dispatched. */
  refuse(
    exec: ExecutionLike, sessionId: string, reading: ScopeReading, decision: ScopeDecision,
  ): ToolExecutionRecord {
    const callId = typeof exec.callId === 'string' ? exec.callId : 'unknown-call'
    const toolName = typeof exec.name === 'string' ? exec.name : 'unknown-tool'
    const { turnId, authorisedBy } = this.turnOf()
    const action = `${sessionId}/${turnId}/${callId}`
    const attempt = (this.attempts.get(action) ?? 0) + 1
    this.attempts.set(action, attempt)
    const identity = { sessionId, turnId, callId, attempt }
    const at = new Date().toISOString()

    const record: ToolExecutionRecord = {
      version: EXECUTION_RECORD_VERSION,
      ...identity,
      idempotencyKey: executionKey(identity),
      rootCallId: typeof exec.rootCallId === 'string' ? exec.rootCallId : null,
      subagentId: typeof exec.agent?.id === 'string' ? exec.agent.id : null,
      parentTurnId: authorisedBy,
      toolName,
      state: 'cancelled',
      startedAt: at,
      endedAt: at,
      durationMs: 0,
      exitStatus: 'denied',
      sideEffect: classifySideEffect(toolName),
      scope: reading.scope,
      scopeDecision: decision,
      paths: reading.inside,
      outsidePathCount: reading.outsideCount,
      inputSummary: this.summarise(renderArguments(exec.arguments), sessionId),
      outputSummary: 'refused before dispatch',
      outputDigest: digestOf(''),
      authorisedBy,
      verification: 'UNVERIFIED',
    }
    this.push(record)
    return record
  }

  /**
   * The one way text becomes a stored summary.
   *
   * Three passes in a deliberate order: secrets first, because a credential
   * inside a path is still a credential; then paths, so nothing absolute
   * survives; then the length bound, so the cut happens after both and cannot
   * split a replacement in half.
   */
  private summarise(text: string, sessionId: string): string {
    return boundSummary(redactPathsIn(redactSecrets(text), this.workspaceRoot(sessionId)))
  }

  private push(record: ToolExecutionRecord): void {
    this.records.push(record)
    while (this.records.length > LEDGER_LIMIT) this.records.shift()
    // Announced so the Library can index a receipt as it is minted rather than
    // waiting for somebody to press Refresh. The event is the whole reason the
    // index can be caught up instead of behind.
    const events = this.ctx as unknown as { emit(name: string, ...args: unknown[]): void }
    events.emit('watch/execution-recorded', record)
  }

  /** Every settled record, oldest first. */
  all(): readonly ToolExecutionRecord[] {
    return this.records
  }

  /** The records for one session. */
  forSession(sessionId: string): readonly ToolExecutionRecord[] {
    return this.records.filter(record => record.sessionId === sessionId)
  }

  /** How many calls are in flight. */
  openCount(): number {
    return this.open.size
  }

  /** Forget everything. For a profile teardown, and for tests that want a clean ledger. */
  clear(): void {
    this.records.length = 0
    this.open.clear()
    this.attempts.clear()
  }
}

/** The arguments as a short line, without interpreting values the Host does not own. */
function renderArguments(argumentValue: unknown): string {
  if (argumentValue === undefined || argumentValue === null) return ''
  try {
    return JSON.stringify(argumentValue) ?? ''
  } catch {
    return '<unserialisable arguments>'
  }
}

/** The result's text, for the digest and the summary. */
function renderContent(result: ResultLike): string {
  const content = result.content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block !== 'object' || block === null) return ''
        const text = (block as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      })
      .join('\n')
  }
  if (typeof result.value === 'string') return result.value
  try {
    return JSON.stringify(result.value ?? null) ?? ''
  } catch {
    return ''
  }
}

/** The tool's own failure code, when it named one. */
function failureCode(result: ResultLike): string {
  const error = result.error
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'error'
}

/** The plugin's own name, so a composition can target the row. */
export const name = 'watch-observation'

/**
 * Mount the ledger and subscribe it to the dispatch lifecycle.
 *
 * A row of its own, ahead of everything that injects it, because there has to
 * be exactly one — a service reflected per scope is a ledger two halves can
 * disagree about.
 */
export function apply(ctx: Context): void {
  const observation = new WatchObservation(ctx)

  // Two described surfaces over the same context, because the lifecycle has
  // two shapes and confusing them is silent. `link` hands back what it was
  // given; `observe` returns nothing on purpose.
  const link = ctx as unknown as {
    on(
      name: string,
      listener: (...args: never[]) => unknown,
    ): void
  }
  const observe = ctx as unknown as {
    on(name: string, listener: (...args: never[]) => void): void
  }

  /** The session a call belongs to, as far as the boundary can tell. */
  const sessionOf = (exec: ExecutionLike): string => {
    const agent = exec.agent as { session?: { id?: unknown } } | undefined
    const id = agent?.session?.id
    return typeof id === 'string' ? id : 'unknown-session'
  }

  /**
   * The directory the session was opened in.
   *
   * Read structurally, and from two places, because a live session and a stored
   * header spell it differently and neither is this package's to define. Absent,
   * the answer is null and containment treats the call as having no workspace —
   * which refuses rather than allows.
   */
  const workspaceOf = (exec: ExecutionLike): string | null => {
    const session = (exec.agent as {
      session?: { cwd?: unknown, header?: { cwd?: unknown } }
    } | undefined)?.session
    const direct = session?.cwd
    if (typeof direct === 'string' && direct !== '') return direct
    const stored = session?.header?.cwd
    return typeof stored === 'string' && stored !== '' ? stored : null
  }

  /**
   * The permission mode this call runs under.
   *
   * Upstream owns this value and a person sets it; read structurally and
   * defaulted to the narrow one, so a Host that stops reporting it becomes
   * stricter rather than more permissive.
   */
  const permissionOf = (exec: ExecutionLike): PermissionMode => {
    const value = (exec.agent as { permissions?: { current?: unknown } } | undefined)
      ?.permissions?.current
    return value === 'danger-full-access' || value === 'read-only'
      ? value
      : 'workspace-write'
  }

  // `tools/pre-execute` is a waterfall returning allow/deny/ask, and it is the
  // only point at which a call can be stopped before it happens. Containment
  // lives here for that reason: a boundary that reports afterwards is a log,
  // not a boundary.
  ;(link as unknown as {
    on(
      name: 'tools/pre-execute',
      listener: (
        exec: ExecutionLike, next: () => Promise<{ kind: string }>,
      ) => Promise<{ kind: string, reason?: string }>,
    ): void
  }).on('tools/pre-execute', async (exec, next) => {
    const sessionId = sessionOf(exec)
    // Learned here rather than configured: the session already knows where it
    // was opened, and a second place to say so is a second place to be wrong.
    observation.setWorkspace(workspaceOf(exec), sessionId)
    const refusal = observation.screen(exec, sessionId, permissionOf(exec))
    if (refusal === null) return next()
    return { kind: 'deny', reason: refusal.reason }
  })

  // `tools/execute` is a waterfall around the dispatch: it must return what
  // `next()` gives it, or the call it was watching never returns a result.
  ;(link as unknown as {
    on(
      name: 'tools/execute',
      listener: (exec: ExecutionLike, next: () => Promise<unknown>) => Promise<unknown>,
    ): void
  }).on('tools/execute', async (exec, next) => {
    observation.begin(exec, sessionOf(exec))
    return next()
  })

  // `tools/result` is an emit carrying the frozen outcome, and upstream
  // contains a listener that throws. The settling half belongs here rather than
  // on a waterfall for exactly that reason.
  ;(observe as unknown as {
    on(name: 'tools/result', listener: (exec: ExecutionLike, result: ResultLike) => void): void
  }).on('tools/result', (exec, result) => {
    observation.settle(exec, result, sessionOf(exec))
  })

  // A profile that is torn down should not leave a ledger behind it.
  observe.on('agent/disposed', () => { observation.clear() })
}

export default apply
