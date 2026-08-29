/**
 * Watch capabilities as DeepSeek Harness agent tools.
 *
 * This is the seam that makes Watch reachable from the agent loop. Everything
 * else — the inspector, the timeline, the receipts — is presentation over what
 * these calls return.
 *
 * Two rules shape every tool here:
 *
 * 1. A tool never reports more certainty than Watch Core gave it. An answer
 *    with citations is an *evidence-linked* answer, not a verified one. Only
 *    `watch_verify` can produce a verdict, and only Watch Core can mint it
 *    (ADR-002).
 * 2. A missing capability is a stated refusal with a fix, never a silent
 *    fallback to guessing from the conversation. The model is told, in its
 *    system prompt, that this is the contract.
 *
 * @module @watchskill/dsh-tools
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyLibrarySearch } from './library-search.js'
import { applyReadPlane } from './read-plane.js'
import type { GenericCallView, JsonValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@watchskill/dsh-core-bridge'
import type { EvidenceRecord, VerificationOutcome, WatchResult } from '@watchskill/dsh-contracts'
import { SENSORY_GUIDANCE, applySensoryTools } from './sensory.js'
import { applyMemory } from './memory.js'
import { BROWSER_GUIDANCE, applyBrowserTools } from './browser.js'

export { SENSORY_GUIDANCE, applySensoryTools } from './sensory.js'
export { applyMemory } from './memory.js'
export { BROWSER_GUIDANCE, applyBrowserTools } from './browser.js'
export type { BrowserConfig } from './browser.js'
export type { SensoryConfig } from './sensory.js'

export const name = 'watch-tools'
export const inject = ['tools', 'watchCore', 'systemPrompt']

/** Deployment policy for the Watch tool surface. */
export interface Config {
  /** Deadline for a source query, which may involve perception work. */
  readonly queryTimeoutMs: number
  /** Deadline for one verification contract. */
  readonly verifyTimeoutMs: number
  /** Deadline for a search or a moment lookup. */
  readonly readTimeoutMs: number
  /** Deadline for starting a live session, which may launch a browser. */
  readonly liveStartTimeoutMs: number
  /** Deadline for one browser action, including its re-observation. */
  readonly actTimeoutMs: number
  /** Deadline for a page observation. */
  readonly observeTimeoutMs: number
  /**
   * Directories the library index may read.
   *
   * Empty by default, and deliberately so: a deployment that has not said
   * where its evidence lives should get a tool that reports having nothing to
   * search, not one that guesses at a convenient directory.
   */
  readonly libraryRoots?: readonly string[]
  /**
   * Which workspace this host answers for.
   *
   * Read-plane cursors are bound to it, so a cursor issued here cannot be
   * replayed against another workspace's snapshot.
   */
  readonly workspaceScope?: string
}

/** Schemastery validation for the tool-surface policy. */
export const Config: s<Config> = s.object({
  queryTimeoutMs: s.number().step(1).min(1_000).default(120_000),
  verifyTimeoutMs: s.number().step(1).min(1_000).default(60_000),
  readTimeoutMs: s.number().step(1).min(1_000).default(30_000),
  liveStartTimeoutMs: s.number().step(1).min(1_000).default(60_000),
  actTimeoutMs: s.number().step(1).min(1_000).default(60_000),
  observeTimeoutMs: s.number().step(1).min(1_000).default(30_000),
})

/**
 * What the model is told about Watch, in the system prompt.
 *
 * Written to close the two failure modes that matter: answering from memory
 * when a source was named, and reporting success because a tool returned
 * without error.
 */
const GUIDANCE = `## Watch: seeing, and proving

You have senses through Watch: recorded video, live sources, browser pages, and
their transcripts, on-screen text and timing. Watch answers from what was
actually observed and returns citations you can open.

- When the user refers to a video, a stream, a screen or a page, answer through
  \`watch_ask_source\` rather than from memory. If Watch cannot answer, say so
  and report the fix it gave you; do not substitute a guess.
- Every claim about a source must carry the evidence ids Watch returned. An
  answer without citations is not grounded, and you should say that plainly.
- A tool returning successfully means the call ran. It does not mean the thing
  you did worked. To claim that something worked, run \`watch_verify\` and
  report the verdict it returns.
- \`UNVERIFIED\` and \`INCONCLUSIVE\` are honest, useful answers. Report them as
  they are. Never describe an unverified outcome as done, working or fixed.
- Call \`watch_capabilities\` when you are unsure whether a sense is available
  here, instead of attempting a call that will be refused.`

/** Generic pending presentation shared by the read-only Watch tools. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * The shared output declaration for Watch payloads.
 *
 * The schema is `json` on purpose: the authoritative shape of an evidence
 * record or a verification outcome is Watch Core's JSON Schema, negotiated by
 * digest at handshake, not a second copy maintained here that could drift.
 */
const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/**
 * Hand a typed contract value to the tool runner.
 *
 * `JsonValue` requires an index signature that a named contract interface
 * deliberately does not have, so the conversion is asserted once here rather
 * than at every call site. The values are already plain JSON: they arrived
 * over the Bridge as parsed JSON and are not re-shaped on the way through.
 */
function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

/**
 * Convert a Bridge failure into a tool value the model can act on.
 *
 * Deliberately not a thrown error: a refusal carries a `fix`, and the model
 * needs to read and relay it. An exception would reach the user as a generic
 * tool failure with the actionable part stripped out.
 */
function refusal(result: Extract<WatchResult<never>, { ok: false }>): ToolRefusal {
  return {
    ok: false,
    error: result.error.error,
    message: result.error.message,
    fix: result.error.fix,
    retryable: result.error.retryable,
  }
}

/** The shape every Watch tool returns when the capability is not available. */
interface ToolRefusal {
  readonly ok: false
  readonly error: string
  readonly message: string
  readonly fix: string
  readonly retryable: boolean
}

/** Answer returned by a source query, always with its citations attached. */
interface SourceAnswer {
  readonly ok: true
  readonly answer: string
  readonly evidence: readonly EvidenceRecord[]
  /**
   * Always null here. A query observes; it does not verify. Present in the
   * shape so the model sees the distinction on every single call rather than
   * only when a verification happens to run.
   */
  readonly verification: null
}

/** Register the Watch tool surface and the guidance that governs its use. */
export function apply(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({ name: 'tool:watch', order: 120, text: GUIDANCE })
  // A separate section rather than one long block: the sensory rules only
  // matter once the agent reaches for a source it has not identified yet, and
  // splitting them keeps each part readable at the point it applies.
  ctx.systemPrompt.section({ name: 'tool:watch-sensory', order: 121, text: SENSORY_GUIDANCE })
  ctx.systemPrompt.section({ name: 'tool:watch-browser', order: 122, text: BROWSER_GUIDANCE })
  applySensoryTools(ctx, config)
  applyBrowserTools(ctx, config)
  // Memory is optional, and this is how Cordis says so. A child plugin whose
  // injects are unsatisfied stays pending rather than failing, and activates
  // by itself if the Memory service is mounted later. Reading ctx.watchMemory
  // directly would throw, because Cordis refuses a service the plugin did not
  // declare; adding it to this plugin's own inject would instead make the
  // whole Watch tool surface wait for a service the bundle may never mount.
  ctx.plugin({
    name: 'watch-memory-tools',
    inject: ['watchMemory', 'tools'],
    apply: applyMemory,
  })

  ctx.tools.register(defineTool({
    name: 'watch_capabilities',
    description:
      'Report what Watch can actually do on this machine right now: which senses are connected, '
      + 'which were tested, and what is missing. Call this before assuming a video, live, browser '
      + 'or OCR capability is available. Never fails.',
    parameters: {},
    output: JSON_OUTPUT,
    execute() {
      const health = ctx.watchCore.health()
      // Reported verbatim from the handshake. A capability that was declared
      // but never exercised says so; the model must not read "implemented" as
      // "works here".
      return Promise.resolve(asJson({
        connection: health.phase,
        transport: health.transport,
        coreVersion: health.handshake?.coreVersion ?? null,
        problem: health.error === null ? null : {
          error: health.error.error,
          message: health.error.message,
          fix: health.error.fix,
        },
        capabilities: ctx.watchCore.capabilities().map(capability => ({
          id: capability.capabilityId,
          status: capability.status,
          usable: ctx.watchCore.isCapable(capability.capabilityId),
          missing: capability.missing,
          fixes: capability.fixes,
        })),
      }))
    },
    presentCall: () => present('Check Watch capabilities', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'watch_ask_source',
    description:
      'Ask a question about an indexed source — a recorded video, a live session, a browser page '
      + 'or a screen capture — and receive an answer grounded in timestamped evidence. Returns the '
      + 'evidence records behind the answer so every claim can be opened at the moment it came from. '
      + 'This observes; it does not verify. Use watch_verify to establish that something worked.',
    parameters: {
      source_id: {
        type: 'string',
        required: true,
        description: 'Id of an indexed source. Use watch_list_sources when you do not have one.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The question to answer from the source.',
      },
      start_ms: {
        type: 'number',
        description: 'Optional start of the time range to search, in milliseconds.',
      },
      end_ms: {
        type: 'number',
        description: 'Optional end of the time range to search, in milliseconds.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const range = args.start_ms === undefined && args.end_ms === undefined
        ? undefined
        : { startMs: args.start_ms ?? 0, endMs: args.end_ms ?? Number.MAX_SAFE_INTEGER }
      const result = await ctx.watchCore.request<{ answer: string; evidence: EvidenceRecord[] }>(
        'watch.source.ask',
        { sourceId: args.source_id, question: args.question, ...range === undefined ? {} : { range } },
        { deadlineMs: config.queryTimeoutMs, ...abortOf(exec) },
      )
      if (!result.ok) return asJson(refusal(result))
      const answer: SourceAnswer = {
        ok: true,
        answer: result.value.answer,
        evidence: result.value.evidence,
        verification: null,
      }
      return asJson(answer)
    },
    presentCall: args => present('Ask a source', 'read', args.question),
  }))

  ctx.tools.register(defineTool({
    name: 'watch_list_sources',
    description:
      'List the sources Watch has indexed in this workspace, with their ids, kinds and durations. '
      + 'Use this to find the source_id for watch_ask_source.',
    parameters: {
      query: { type: 'string', description: 'Optional text filter over source titles and paths.' },
      limit: { type: 'number', description: 'Maximum sources to return. Defaults to 20.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const result = await ctx.watchCore.request(
        'watch.library.list',
        { query: args.query ?? null, limit: args.limit ?? 20 },
        abortOf(exec),
      )
      return asJson(result.ok ? result.value : refusal(result))
    },
    presentCall: args => present('List Watch sources', 'read', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'watch_get_evidence',
    description:
      'Resolve one evidence id returned by another Watch tool into its full record: the source '
      + 'revision it came from, its time range and region, how it was produced, and whether it is '
      + 'still current. Use this to check that a citation is fresh before relying on it.',
    parameters: {
      evidence_id: { type: 'string', required: true, description: 'An evidence id from a prior Watch result.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const result = await ctx.watchCore.request<EvidenceRecord>(
        'watch.evidence.get',
        { evidenceId: args.evidence_id },
        abortOf(exec),
      )
      return asJson(result.ok ? result.value : refusal(result))
    },
    presentCall: args => present('Open evidence', 'read', args.evidence_id),
  }))

  // Library search runs on the host because that is the only place that can
  // read the evidence store: a client plugin gets no config, and ctx.remote
  // is an event bus rather than a query client.
  const library = applyLibrarySearch(ctx, { roots: config.libraryRoots ?? [] })

  // The same index, reachable by the surfaces as well as by the agent. A
  // `conversation.view` entry is handed `{ inspect, onInspectDone }` and
  // nothing else, so without this the Library mode has no way to obtain the
  // records it renders and defaults to an empty array.
  applyReadPlane(ctx, {
    index: library.index,
    scope: config.workspaceScope ?? 'default',
  })

  ctx.tools.register(defineTool({
    name: 'watch_verify',
    description:
      'Run a verification contract and return an independent verdict with a receipt. This is the '
      + 'only way to establish that something actually worked. VERIFIED means an executable '
      + 'expectation passed against valid evidence. UNVERIFIED means there was no executable '
      + 'expectation or not enough evidence — report it as such; it is not a failure and it is not '
      + 'a success. Never describe work as done on the strength of a tool returning without error.',
    parameters: {
      expectation: {
        type: 'string',
        required: true,
        description:
          'The concrete, checkable outcome to prove. Name what should be observable, not what you '
          + 'intended: "the row for order 4182 is gone from the table", not "the delete worked".',
      },
      source_id: {
        type: 'string',
        description: 'Optional source to re-observe. Defaults to the session\'s bound source.',
      },
      evidence_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional prior evidence to check the expectation against.',
      },
    },
    output: {
      ...JSON_OUTPUT,
      /**
       * Project the verdict for the result card.
       *
       * Presentation-only. It reads the verdict Watch Core returned; it never
       * derives one, and a payload without a verdict projects null rather than
       * a default that would read as success.
       */
      presentationMeta: (_args: unknown, value: JsonValue): JsonValue => {
        const verdict = (value as { verdict?: unknown } | null)?.verdict
        return { verdict: typeof verdict === 'string' ? verdict : null }
      },
    },
    async execute(args, exec) {
      const result = await ctx.watchCore.request<VerificationOutcome>(
        'watch.verification.run',
        {
          expectation: args.expectation,
          sourceId: args.source_id ?? null,
          evidenceIds: args.evidence_ids ?? [],
          // Minted here so the verdict, the receipt and the Trajectory record
          // all hang off one id the user can follow.
          verificationId: `ver_${randomUUID()}`,
        },
        { deadlineMs: config.verifyTimeoutMs, ...abortOf(exec) },
      )
      return asJson(result.ok ? result.value : refusal(result))
    },
    presentCall: args => present('Verify', 'other', args.expectation),
    presentResult: (_args, result) => {
      // The card must never turn an honest non-answer green. It reports the
      // verdict verbatim, including UNVERIFIED and INCONCLUSIVE, and falls
      // back to the generic card when there is no verdict to report at all.
      const verdict = (result.meta as { verdict?: unknown } | undefined)?.verdict
      if (typeof verdict !== 'string') return undefined
      return { card: 'generic', title: `Verification: ${verdict}` }
    },
  }))
}

/** Forward the tool runner's cancellation to the Bridge when one exists. */
function abortOf(exec: { readonly signal?: AbortSignal }): { signal?: AbortSignal } {
  return exec.signal === undefined ? {} : { signal: exec.signal }
}

/**
 * The plugin, as the Cordis loader resolves it.
 *
 * An object rather than the bare `apply` function, and that distinction is the
 * whole reason this exists. The loader takes `module.default` and then reads
 * `plugin.inject` off it — so a default export of the function alone leaves the
 * named `inject` sitting on the module namespace where nothing looks, and the
 * first `ctx.systemPrompt` access throws "cannot get property without inject"
 * at boot.
 *
 * Nothing catches that before a real boot: the composed tree is correct, the
 * install smoke passes, and the profile fails the moment it actually starts.
 * `scripts/boot-smoke.mjs` is the gate that does catch it.
 */
export default { name: 'watch-tools', inject, apply }

export * from './library-search.js'
