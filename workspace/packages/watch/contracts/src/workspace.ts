/**
 * The one resolved workspace every layer agrees on.
 *
 * A real owner session created `owner-test/totals.json` correctly and then
 * could not be verified, because three layers each answered "which directory
 * is this relative path in?" from a different place:
 *
 * - the agent's filesystem tools resolved against the Harness session
 *   workspace, which the Harness derives from *its own process cwd*;
 * - Watch Core was spawned with an empty `cwd`, so it inherited whatever the
 *   Host happened to be started from;
 * - the verifier, given no `workingDir`, fell back to `Path(".")` — the Core
 *   process's cwd, which was neither of the above.
 *
 * Every one of those defaults is individually reasonable and the combination
 * is a product that writes a file it cannot then find. The file landed outside
 * every root the verifier would look in, so the honest answer was
 * `INCONCLUSIVE` — correct, and useless.
 *
 * The fix is not to widen the verifier until it can see the file. It is to
 * make the question have one answer. A {@link WorkspaceContext} is that
 * answer: one absolute, traversal-resolved root, established once at launch
 * and handed to the filesystem tools, the shell, Watch policy, the verifier,
 * the evidence resolver, receipts, the Library projection and the session UI.
 *
 * **Fail closed.** {@link requireWorkspace} throws rather than inventing a
 * root. A layer that cannot say where it is must stop and say so, because the
 * alternative is what shipped: a silent default that looks like it worked.
 *
 * @module @deepwatch/dsh-contracts/workspace
 */

import {
  containsPath, isAbsoluteLocalPath, normalisePath, relativeToRoot, resolveTraversal,
  type PathRoot, type PathRoots,
} from './paths.js'

/** Environment variable naming the canonical workspace for a composed run. */
export const WORKSPACE_ENV = 'DEEPWATCH_WORKSPACE'

/**
 * One workspace, resolved once.
 *
 * `root` is absolute, separator-normalised and traversal-resolved, so two
 * layers comparing it are comparing the same string rather than two spellings
 * of one directory.
 */
export interface WorkspaceContext {
  /** The canonical absolute root. Never rendered to a person or a model. */
  readonly root: string
  /** How this root was chosen, for a diagnostic that can be acted on. */
  readonly origin: WorkspaceOrigin
  /** Redaction roots, with the workspace already registered. */
  readonly roots: PathRoots
}

/**
 * Where a canonical workspace came from.
 *
 * Recorded because "the workspace is wrong" and "there was no workspace and
 * something guessed" are different bugs with different fixes, and the failed
 * owner session could not tell them apart.
 */
export type WorkspaceOrigin =
  /** A person named it: `deepwatch web --workspace <dir>`. */
  | 'flag'
  /** Inherited from a composed profile or launcher environment. */
  | 'environment'
  /** The directory the command was invoked from, adopted deliberately. */
  | 'invocation'

/** Raised when a layer needs the canonical workspace and none was established. */
export class WorkspaceNotEstablished extends Error {
  readonly where: string
  constructor(where: string) {
    super(
      `${where} needs the canonical workspace and none was established. `
      + 'Start DeepWatch with `deepwatch web --workspace <dir>`, or set '
      + `${WORKSPACE_ENV} to an absolute path, so the agent's tools, Watch `
      + 'containment and the verifier all resolve relative paths in one place.')
    this.name = 'WorkspaceNotEstablished'
    this.where = where
  }
}

/** Raised when a relative path would resolve outside the canonical workspace. */
export class WorkspaceEscape extends Error {
  readonly attempted: string
  constructor(attempted: string) {
    super(
      `"${attempted}" resolves outside the workspace. `
      + 'Paths handed to the agent, the shell and the verifier are workspace-relative '
      + 'by contract; nothing outside it is reachable by relative path.')
    this.name = 'WorkspaceEscape'
    this.attempted = attempted
  }
}

/**
 * Establish the canonical workspace from an absolute path.
 *
 * Rejects a relative candidate rather than resolving it against the current
 * process cwd. Resolving here is what created the original defect: each layer
 * had a different cwd, so "resolve it against cwd" produced three roots. A
 * caller that only has a relative path has not yet decided which directory it
 * means, and must decide before calling.
 *
 * @param candidate - an absolute local path.
 * @param origin - how it was chosen, for diagnostics.
 * @param extra - further roots to register for redaction (profile, dsh-home).
 */
export function establishWorkspace(
  candidate: string, origin: WorkspaceOrigin, extra: PathRoots = [],
): WorkspaceContext {
  if (candidate === '' || !isAbsoluteLocalPath(candidate)) {
    throw new Error(
      `A canonical workspace must be an absolute path; got "${candidate}". `
      + 'Resolve it where the directory is actually known, not here — this module '
      + 'has no cwd of its own on purpose.')
  }
  const root = resolveTraversal(candidate)
  const workspaceRoot: PathRoot = { kind: 'workspace', path: root }
  return { root, origin, roots: [workspaceRoot, ...extra] }
}

/**
 * The established workspace, or a failure naming what to do about it.
 *
 * The fail-closed half of the contract. Call it from any layer that is about
 * to resolve a relative path, so an unestablished workspace is a stop rather
 * than a guess.
 */
export function requireWorkspace(
  context: WorkspaceContext | null | undefined, where: string,
): WorkspaceContext {
  if (context === null || context === undefined) throw new WorkspaceNotEstablished(where)
  return context
}

/**
 * Read the canonical workspace out of an environment.
 *
 * Returns null rather than throwing, so a caller can distinguish "nobody said"
 * from "somebody said something unusable" and report the right one.
 */
export function workspaceFromEnvironment(
  env: Readonly<Record<string, string | undefined>>, extra: PathRoots = [],
): WorkspaceContext | null {
  const named = env[WORKSPACE_ENV]
  if (typeof named !== 'string' || named === '') return null
  if (!isAbsoluteLocalPath(named)) return null
  return establishWorkspace(named, 'environment', extra)
}

/**
 * An absolute path for a workspace-relative one, or a refusal.
 *
 * The single resolution every layer routes through. `..` is resolved *before*
 * the containment test, so `../elsewhere/notes.md` is refused rather than
 * quietly landing a directory up — the check that a literal prefix comparison
 * gets wrong.
 *
 * An already-absolute input is accepted only when it is inside the workspace,
 * which keeps a caller from smuggling an outside path through a parameter
 * documented as relative.
 */
export function resolveInWorkspace(context: WorkspaceContext, relative: string): string {
  const joined = isAbsoluteLocalPath(relative)
    ? resolveTraversal(relative)
    : resolveTraversal(`${context.root}/${relative}`)
  if (!containsPath(context.root, joined)) throw new WorkspaceEscape(relative)
  return joined
}

/**
 * Whether a path lands inside the canonical workspace.
 *
 * The containment question for a boundary that must answer before the side
 * effect, not after it.
 */
export function insideWorkspace(context: WorkspaceContext, candidate: string): boolean {
  return containsPath(context.root, candidate)
}

/**
 * The workspace-relative, forward-slashed spelling of a path.
 *
 * What a receipt, a Library row and a verifier request should carry, so the
 * same file is one string everywhere and no machine's directory names ride
 * along. Returns null when the path is outside, so a caller cannot treat a
 * failed conversion as a success and emit an absolute path.
 */
export function workspaceRelative(context: WorkspaceContext, candidate: string): string | null {
  return relativeToRoot(resolveTraversal(candidate), context.root)
}

/**
 * Whether two layers agree about the workspace.
 *
 * The assertion a composed run makes at startup. Comparing normalised
 * spellings rather than raw strings is the point: `D:\Ws` and `d:/Ws/` are one
 * directory, and a mismatch reported between those two would send somebody
 * looking for a bug that is not there.
 */
export function sameWorkspace(left: string, right: string): boolean {
  return normalisePath(resolveTraversal(left)) === normalisePath(resolveTraversal(right))
}
