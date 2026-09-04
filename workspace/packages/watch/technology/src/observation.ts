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
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  EXECUTION_RECORD_VERSION, boundSummary, executionKey, redactSecrets,
} from '@deepwatch/dsh-contracts'
import type {
  ScopeDecision, SideEffectClass, ToolExecutionRecord, WorkspaceScope,
} from '@deepwatch/dsh-contracts'
import { findAbsolutePaths, isInsideRoot, relativeToRoot } from '@deepwatch/dsh-contracts'
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
  const inside: string[] = []
  let outsideCount = 0
  for (const path of paths) {
    if (isInsideRoot(workspace, path)) {
      const relative = relativeToRoot(path, workspace)
      if (relative !== null) inside.push(relative)
    } else outsideCount += 1
  }
  return {
    scope: outsideCount > 0 ? 'outside_workspace' : 'inside',
    inside,
    outsideCount,
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
 * `D:/Users/<name>/…` beside it has disclosed exactly what the classification
 * was there to avoid.
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
  /** The workspace containment is measured against. Null until one is chosen. */
  private workspace: string | null = null

  constructor(ctx: Context) {
    super(ctx, OBSERVATION_SERVICE)
  }

  /** Point containment at the workspace a person selected. */
  setWorkspace(root: string | null): void {
    this.workspace = root === null || root === '' ? null : root
  }

  /** The workspace containment is currently measured against. */
  workspaceRoot(): string | null {
    return this.workspace
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
    const reading = readScope(paths, this.workspace)
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
      inputSummary: this.summarise(renderArguments(exec.arguments)),
      outputSummary: this.summarise(output),
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
      inputSummary: this.summarise(renderArguments(exec.arguments)),
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
  private summarise(text: string): string {
    return boundSummary(redactPathsIn(redactSecrets(text), this.workspace))
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
