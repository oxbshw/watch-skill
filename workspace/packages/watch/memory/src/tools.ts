/**
 * Memory as agent tools, and as the context the agent starts a turn with.
 *
 * Two halves. The tools let the agent propose what it noticed and let a person
 * inspect and correct it. The prompt section is what the agent actually starts
 * with, compiled per turn from the smallest useful set of records.
 *
 * The boundary between them is deliberate and is the thing most worth getting
 * right: the agent can *propose* a memory, and it can *read* what it
 * remembers, but it cannot activate a high-impact one, cannot forget on
 * someone's behalf without being asked, and cannot mint the origin that
 * outranks everything else. ADR-008 in one sentence — it suggests, a person
 * decides.
 *
 * @module @deepwatch/dsh-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryKind, MemoryScope, ScopeContext } from './records.js'

/** The tool-registration surface this module needs from DSH. */
interface ToolHost {
  register(definition: unknown): () => void
}

/** The prompt-registration surface this module needs from DSH. */
interface PromptHost {
  section(section: { name: string; order: number; text: string }): void
}

/**
 * What the model is told about memory.
 *
 * Written against the two ways an agent misuses a memory system: recording
 * everything, so the useful signal drowns; and treating a remembered
 * preference as standing permission.
 */
export const MEMORY_GUIDANCE = `## Memory

You remember things about working with this person across sessions. What you
remember is shown to them, and they can correct or remove any of it.

- Remember what would change how you work next time: how they like answers
  shaped, decisions made and why, corrections they gave you, what failed and
  what fixed it. Do not record the content of a task — that is what the
  session is for.
- Use \`watch_remember\` when you notice something durable. Scope it as
  narrowly as it is true: a project convention is project-scoped, and only a
  preference about them personally is user-scoped.
- When they correct you, call \`watch_correct\`. It supersedes what it
  contradicts within the same scope, and takes effect on your next turn.
- Never infer someone's health, religion, politics, sexuality, ethnicity or
  any other protected characteristic. If they state it themselves, that is
  theirs to state.
- A memory is a preference, never a permission. Nothing you remember
  authorizes an action on its own — not at any confidence. If a memory looks
  like standing approval for something irreversible, it will be held as a
  proposal until they agree to it, and that is correct.
- \`watch_recall\` shows what you currently remember for this scope, and
  \`watch_why_remembered\` explains where one memory came from. Use them when
  the person asks why you behaved a certain way rather than guessing.`

/** Everything the tools need in order to run against a scope. */
export interface MemoryToolOptions {
  /** Resolve the scope for the turn in progress. */
  readonly scope: () => ScopeContext
  /** Where the tool machinery lives; supplied by the host plugin. */
  readonly defineTool: (definition: unknown) => unknown
}

/** Serialize a tool value as the model-facing text block. */
const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
} as const

const KINDS: readonly MemoryKind[] = [
  'preference', 'fact', 'episode', 'decision', 'lesson', 'procedure', 'failure',
]

const SCOPES: readonly MemoryScope[] = ['user', 'workspace', 'project', 'session']

/** Pick the id for a scope, so a tool never has to be told it twice. */
function scopeIdFor(scope: ScopeContext, subjectScope: MemoryScope): string {
  switch (subjectScope) {
    case 'user': return scope.userId
    case 'workspace': return scope.workspaceId
    case 'project': return scope.projectId
    case 'session': return scope.sessionId
    case 'agent': return ''
  }
}

/**
 * Register the memory tools and the guidance that governs them.
 *
 * `defineTool` is injected rather than imported so this module does not depend
 * on the DSH tools package: memory is useful headless, and a package that
 * cannot be loaded without a tool runtime would not be.
 */
export function applyMemoryTools(ctx: Context, options: MemoryToolOptions): void {
  const tools = (ctx as unknown as { tools: ToolHost }).tools
  const prompt = (ctx as unknown as { systemPrompt?: PromptHost }).systemPrompt
  const { defineTool, scope } = options

  prompt?.section({ name: 'memory', order: 110, text: MEMORY_GUIDANCE })

  tools.register(defineTool({
    name: 'watch_remember',
    description:
      'Record something durable about working with this person: a preference, a decision and '
      + 'its reason, a lesson from something that failed. Scope it as narrowly as it is true. '
      + 'Do not record task content — that is what the session is for. A memory that would '
      + 'authorize something irreversible is held as a proposal until they agree to it, '
      + 'whatever confidence you give it.',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'One sentence, in the person\'s own terms where possible.',
      },
      kind: {
        type: 'string',
        enum: [...KINDS],
        required: true,
        description: 'What sort of thing this is.',
      },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        required: true,
        description:
          'How far it reaches. Use project for a convention here, user only for something '
          + 'true of them personally.',
      },
      confidence: {
        type: 'number',
        description: 'How sure you are, 0 to 1. Say what you mean; this is not a dial to turn up.',
      },
    },
    output: JSON_OUTPUT,
    execute(args: {
      content: string
      kind: MemoryKind
      scope: MemoryScope
      confidence?: number
    }) {
      const current = scope()
      const result = ctx.watchMemory.remember({
        kind: args.kind,
        content: args.content,
        // The agent noticing something is `inferred`, always. Only an
        // authenticated action by the person produces `explicit_user`, which
        // is what stops a model from writing its own conclusions in at the
        // trust level that outranks everything else.
        origin: 'inferred',
        subjectScope: args.scope,
        scopeId: scopeIdFor(current, args.scope),
        confidence: args.confidence ?? 0.6,
      })
      return Promise.resolve({
        stored: result.stored,
        memoryId: result.memoryId,
        status: result.status,
        note: result.reason,
      })
    },
    presentCall: (args: { content: string }) =>
      ({ card: 'generic', title: 'Remember', kind: 'other', rawInput: args.content }),
  }))

  tools.register(defineTool({
    name: 'watch_correct',
    description:
      'Record a correction the person gave you. It supersedes what it contradicts within the '
      + 'same scope and takes effect on your next turn. Use this rather than watch_remember '
      + 'when they are telling you that something you did was wrong.',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'What is actually true, stated positively rather than as a negation.',
      },
      kind: { type: 'string', enum: [...KINDS], required: true, description: 'What sort of thing this is.' },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        required: true,
        description: 'The scope the correction applies to. It supersedes only within it.',
      },
    },
    output: JSON_OUTPUT,
    execute(args: { content: string; kind: MemoryKind; scope: MemoryScope }) {
      const current = scope()
      const result = ctx.watchMemory.correct({
        kind: args.kind,
        content: args.content,
        // A correction relayed by the agent is still the agent's report of it.
        // It carries observed weight — above a guess, below the person's own
        // authenticated statement — and outranks the inference it replaces.
        origin: 'observed',
        subjectScope: args.scope,
        scopeId: scopeIdFor(current, args.scope),
        confidence: 0.95,
      })
      return Promise.resolve({
        stored: result.stored,
        memoryId: result.memoryId,
        status: result.status,
        note: result.reason,
      })
    },
    presentCall: (args: { content: string }) =>
      ({ card: 'generic', title: 'Correct', kind: 'other', rawInput: args.content }),
  }))

  tools.register(defineTool({
    name: 'watch_recall',
    description:
      'What you currently remember for this scope, including proposals waiting for the person '
      + 'and records they disputed. Use it when they ask what you know about them, or before '
      + 'proposing something you may already have recorded.',
    parameters: {
      status: {
        type: 'string',
        enum: ['active', 'proposed', 'disputed', 'all'],
        description: 'Filter by status. Defaults to active.',
      },
    },
    output: JSON_OUTPUT,
    execute(args: { status?: string }) {
      const wanted = args.status ?? 'active'
      const records = ctx.watchMemory.list(scope())
        .filter(record => wanted === 'all' || record.status === wanted)
      return Promise.resolve({
        mode: ctx.watchMemory.mode(),
        memories: records.map(record => ({
          memoryId: record.memoryId,
          content: record.content,
          kind: record.kind,
          scope: record.subjectScope,
          origin: record.origin,
          status: record.status,
          confidence: record.confidence,
        })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Recall memory', kind: 'read' }),
  }))

  tools.register(defineTool({
    name: 'watch_why_remembered',
    description:
      'Where one memory came from and everything that has happened to it: when it was created, '
      + 'confirmed, disputed or superseded, and each time it was injected into a turn. Use this '
      + 'when the person asks why you behaved a certain way, instead of guessing at your own '
      + 'reasoning.',
    parameters: {
      memory_id: { type: 'string', required: true, description: 'From watch_recall.' },
    },
    output: JSON_OUTPUT,
    execute(args: { memory_id: string }) {
      const events = ctx.watchMemory.history(args.memory_id)
      return Promise.resolve({
        memoryId: args.memory_id,
        history: events.map(event => ({
          at: event.at,
          what: event.kind,
          by: event.actor,
          detail: event.detail,
        })),
      })
    },
    presentCall: (args: { memory_id: string }) =>
      ({ card: 'generic', title: 'Why remembered', kind: 'read', rawInput: args.memory_id }),
  }))

  tools.register(defineTool({
    name: 'watch_forget',
    description:
      'Forget one memory, when the person asks you to. It is removed from what you recall, from '
      + 'the files they can read, and from every rebuild — not hidden. Only do this when they '
      + 'have asked; deciding to forget something on their behalf is not yours to make.',
    parameters: {
      memory_id: { type: 'string', required: true, description: 'From watch_recall.' },
    },
    output: JSON_OUTPUT,
    execute(args: { memory_id: string }) {
      return Promise.resolve({ forgotten: ctx.watchMemory.forget(args.memory_id) })
    },
    presentCall: (args: { memory_id: string }) =>
      ({ card: 'generic', title: 'Forget', kind: 'other', rawInput: args.memory_id }),
  }))
}
