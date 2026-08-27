/**
 * Mounting memory into the agent loop.
 *
 * `@watchskill/dsh-memory` owns what a memory is and what may be done with
 * one; this connects it to DSH — registering the tools with the real
 * `defineTool`, and putting the compiled context into the system prompt.
 *
 * The dependency runs this way round on purpose. Memory is useful headless,
 * and a memory package that could not be loaded without a tool runtime would
 * not be — so it takes `defineTool` as an argument and this file supplies it.
 *
 * @module @watchskill/dsh-tools/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { applyMemoryTools } from '@watchskill/dsh-memory'
import type { ScopeContext } from '@watchskill/dsh-memory'

/**
 * Resolve the scope the current turn belongs to.
 *
 * Read from the Cordis context each time rather than captured once: a Host
 * serves many sessions, and a scope resolved at plugin activation would pin
 * every later turn to whichever session happened to be first — which is a
 * cross-scope leak dressed up as a caching decision.
 */
function resolveScope(ctx: Context): ScopeContext {
  const host = ctx as unknown as {
    readonly session?: { readonly id?: string; readonly workspaceId?: string }
    readonly identity?: { readonly userId?: string }
    readonly workspace?: { readonly id?: string; readonly root?: string }
  }
  return {
    // Falling back to 'local' rather than to an empty string keeps the scope
    // key non-empty, so a record can never be created under a scope id that
    // would match every other unset one.
    userId: host.identity?.userId ?? 'local',
    workspaceId: host.workspace?.id ?? host.session?.workspaceId ?? 'local',
    projectId: host.workspace?.root ?? 'local',
    sessionId: host.session?.id ?? 'local',
  }
}

/**
 * Register the memory tools and the per-turn context section.
 *
 * The section is a function of the turn, not a fixed string: it is recompiled
 * each time it is read, which is what makes a correction take effect on the
 * very next turn rather than at the next restart.
 */
export function applyMemory(ctx: Context): void {
  applyMemoryTools(ctx, {
    scope: () => resolveScope(ctx),
    // Widened once, here. `defineTool` infers argument and output types from a
    // literal definition, and instantiating that machinery against a value
    // typed `unknown` sends the checker into an unbounded recursion it reports
    // as "excessive stack depth". The memory package hands over plain
    // definitions and has no use for the inference anyway.
    defineTool: (defineTool as unknown as (definition: unknown) => unknown),
  })

  const prompt = (ctx as unknown as {
    systemPrompt?: { section(section: { name: string; order: number; text: string }): void }
  }).systemPrompt

  // Order 111 puts it directly after the memory guidance, so the rules about
  // what memory *is* are read before the memories themselves.
  prompt?.section({
    name: 'memory:context',
    order: 111,
    get text(): string {
      // Recompiled on read. Every included item is also recorded in the
      // ledger with the reason it was included, so "Why remembered?" can
      // answer for a turn that has already finished.
      return ctx.watchMemory.render(resolveScope(ctx))
    },
  } as { name: string; order: number; text: string })
}
