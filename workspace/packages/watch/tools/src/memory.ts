/**
 * Mounting memory into the agent loop.
 *
 * `@deepwatch/dsh-memory` owns what a memory is and what may be done with
 * one; this connects it to DSH — registering the tools with the real
 * `defineTool`, and putting the compiled context into the system prompt.
 *
 * The dependency runs this way round on purpose. Memory is useful headless,
 * and a memory package that could not be loaded without a tool runtime would
 * not be — so it takes `defineTool` as an argument and this file supplies it.
 *
 * @module @deepwatch/dsh-tools/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { applyMemoryTools } from '@deepwatch/dsh-memory'
import type { ScopeContext } from '@deepwatch/dsh-memory'

/**
 * Read a service that may not be there, without asking Cordis for it.
 *
 * Cordis proxies every context property. Reading a name it knows as a
 * service, from a plugin that did not declare it in `inject`, throws
 * `cannot get property "x" without inject` -- and optional chaining cannot
 * prevent that, because the throw happens on the access, before `?.` is
 * evaluated. `host.identity?.userId` therefore threw on any profile without
 * an identity provider, which is the stock web profile, and took down every
 * turn that compiled the memory section.
 *
 * Declaring the names in `inject` is the wrong fix: `inject` is a required
 * set in this Cordis, so the whole plugin would refuse to load rather than
 * one scope field falling back.
 *
 * @param ctx - the Cordis context for this turn.
 * @param name - the service to read.
 * @returns the service, or undefined when it is absent or not injected.
 */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as Record<string, T | undefined>)[name]
  } catch {
    return undefined
  }
}
/**
 * Resolve the scope the current turn belongs to.
 *
 * Read from the Cordis context each time rather than captured once: a Host
 * serves many sessions, and a scope resolved at plugin activation would pin
 * every later turn to whichever session happened to be first — which is a
 * cross-scope leak dressed up as a caching decision.
 */
function resolveScope(ctx: Context): ScopeContext {
  const session = optionalService<{ id?: string, workspaceId?: string }>(ctx, 'session')
  const identity = optionalService<{ userId?: string }>(ctx, 'identity')
  const workspace = optionalService<{ id?: string, root?: string }>(ctx, 'workspace')
  return {
    // Falling back to 'local' rather than to an empty string keeps the scope
    // key non-empty, so a record can never be created under a scope id that
    // would match every other unset one.
    userId: identity?.userId ?? 'local',
    workspaceId: workspace?.id ?? session?.workspaceId ?? 'local',
    projectId: workspace?.root ?? 'local',
    sessionId: session?.id ?? 'local',
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
  })
}
