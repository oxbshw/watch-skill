/**
 * Keeping this machine's directory names out of everything that leaves it.
 *
 * A workspace was selected, and from then on `D:\Ws` appeared in the Context
 * panel, in the session log, and in the text handed to the model — because a
 * workspace is a directory and every layer below the UI quite reasonably
 * carries the directory. None of those places needed the absolute path. The
 * panel needed a name, the log needed something stable to group by, and the
 * model needed to know which files exist relative to a root it never has to
 * name.
 *
 * So this module converts a real path into a *logical* one: `<workspace>/src`
 * rather than `D:\Ws\src`. The logical form is stable, comparable, and says
 * everything the reader needs, and the real path stays on the Host where the
 * filesystem actually is.
 *
 * **Structured, never blanket.** The one thing this must not do is replace
 * substrings across arbitrary text: evidence content, a transcript, a captured
 * page, a user's own message may legitimately contain a string that looks like
 * a path, and rewriting it would corrupt the very record the product exists to
 * preserve. Everything here therefore operates on a *named field* or on a
 * bounded diagnostic string a caller has explicitly identified. There is no
 * function in this file that takes a document and scrubs it.
 *
 * Windows makes the comparison harder than it looks, and each of these is
 * handled rather than hoped about: drive letters differ in case (`D:\` and
 * `d:\` are one directory), separators are mixed within a single string by the
 * time Node and a shell have both touched it, UNC paths have a leading `\\`
 * that is not a separator, and a prefix match without a boundary check makes
 * `D:\Wsuite` look like it is inside `D:\Ws`.
 *
 * @module @deepwatch/dsh-contracts/paths
 */

/** A local root worth naming rather than printing. */
export type PathRootKind =
  /** The directory the user chose to work in. */
  | 'workspace'
  /** The DeepWatch profile: runtime, receipts, profile state. */
  | 'profile'
  /** The DeepSeek Harness home inside that profile. */
  | 'dsh-home'
  /** A source checkout, present only on a developer's machine. */
  | 'checkout'
  /** The operating system user's home directory. */
  | 'home'
  /** The system temporary directory. */
  | 'temp'

/** One root, and the label that replaces it. */
export interface PathRoot {
  readonly kind: PathRootKind
  /** The real absolute path. Never rendered, never sent. */
  readonly path: string
  /**
   * What a reader sees instead, without the angle brackets.
   *
   * Defaults to the kind, so `workspace` renders as `<workspace>`. A caller
   * with two workspaces open can pass `workspace:notes` and keep them apart
   * without either becoming a directory name.
   */
  readonly label?: string
}

/** The roots a redaction is measured against, longest first. */
export type PathRoots = readonly PathRoot[]

/** Windows drive-absolute, e.g. `D:\Ws` or `d:/Ws`. */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
/** UNC, e.g. `\\server\share\dir`. */
const UNC_ABSOLUTE = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/

/**
 * Whether a string is an absolute local path in any of the three shapes.
 *
 * Used to decide whether a *field known to hold a path* needs converting. It
 * is deliberately not used to scan prose.
 */
export function isAbsoluteLocalPath(value: string): boolean {
  return DRIVE_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value) || value.startsWith('/')
}

/**
 * One comparable spelling of a path.
 *
 * Separators become `/`, a trailing separator is dropped, and a drive letter
 * is upper-cased — Windows treats `d:` and `D:` as one directory and a
 * case-sensitive comparison would miss half the matches. The rest of the path
 * keeps its case: on a case-sensitive filesystem `src` and `SRC` are two
 * directories, and folding them would make the redaction wrong in the other
 * direction.
 */
export function normalisePath(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\//.exec(slashed)
  const cased = drive === null
    ? slashed
    : `${drive[1]?.toUpperCase() ?? ''}:/${slashed.slice(3)}`
  return cased.length > 1 && cased.endsWith('/') ? cased.slice(0, -1) : cased
}

/**
 * Whether `candidate` is `root` or sits inside it.
 *
 * The separator check is the whole point: a bare `startsWith` reports that
 * `D:\Wsuite` is inside `D:\Ws`, which would redact an unrelated
 * directory and leave the reader with a path that never existed.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const base = normalisePath(root)
  const target = normalisePath(candidate)
  if (base === target) return true
  // Windows is case-insensitive about the whole path in practice, but only the
  // drive is folded above; comparing the remainder exactly is the safe side of
  // that trade — a missed redaction is caught by tests, a wrong one is not.
  return target.startsWith(base.endsWith('/') ? base : `${base}/`)
}

/** The label a root renders as, in angle brackets. */
function labelOf(root: PathRoot): string {
  return `<${root.label ?? root.kind}>`
}

/**
 * The logical form of a path, or the path unchanged when no root contains it.
 *
 * Roots are tried longest-first so a workspace nested inside a profile is
 * reported as `<workspace>/…` rather than `<profile>/workspace/…`: the more
 * specific name is the more useful one.
 *
 * A path under no known root is returned as it came in. That is deliberate —
 * silently mangling an unrecognised path would make a diagnostic unreadable —
 * and it is why {@link assertNoLocalPath} exists for the surfaces where an
 * unrecognised absolute path must be a failure rather than a passthrough.
 */
export function redactPath(value: string, roots: PathRoots): string {
  if (value === '') return value
  const ordered = [...roots].sort(
    (a, b) => normalisePath(b.path).length - normalisePath(a.path).length)
  for (const root of ordered) {
    if (!isInsideRoot(root.path, value)) continue
    const base = normalisePath(root.path)
    const target = normalisePath(value)
    const rest = target.slice(base.length).replace(/^\//, '')
    return rest === '' ? labelOf(root) : `${labelOf(root)}/${rest}`
  }
  return value
}

/**
 * The path relative to a root, for the places that want no label at all.
 *
 * What a model should be given: `src/index.ts`, not `<workspace>/src/index.ts`
 * and certainly not `D:\Ws\src\index.ts`. Returns null when the path is not
 * inside the root, so a caller cannot accidentally send an absolute path by
 * treating a failed conversion as a success.
 */
export function relativeToRoot(value: string, root: string): string | null {
  if (!isInsideRoot(root, value)) return null
  const base = normalisePath(root)
  const target = normalisePath(value)
  return target === base ? '.' : target.slice(base.length).replace(/^\//, '')
}

/**
 * Redact only the named fields of a record.
 *
 * The safe shape of this operation. A caller says which keys hold paths, and
 * nothing else in the object is examined — so a `content`, a `transcript` or a
 * `message` beside them is carried through byte for byte.
 *
 * @param record - the object to copy.
 * @param fields - the keys whose string values are paths.
 * @param roots - the roots to measure against.
 * @returns a shallow copy with those fields converted.
 */
export function redactFields<T extends Record<string, unknown>>(
  record: T, fields: readonly (keyof T & string)[], roots: PathRoots,
): T {
  const out: Record<string, unknown> = { ...record }
  for (const field of fields) {
    const value = out[field]
    if (typeof value === 'string') out[field] = redactPath(value, roots)
  }
  return out as T
}

/**
 * Redact one diagnostic string a caller has identified as path-bearing.
 *
 * Bounded on purpose: it rewrites only complete path tokens, delimited by
 * whitespace, quotes or the common punctuation a path is wrapped in when it
 * lands in a message. It is for a log line or an error detail whose shape the
 * caller knows — never for evidence, a transcript, a captured document or
 * anything a person wrote.
 */
export function redactDiagnosticText(text: string, roots: PathRoots): string {
  let out = text
  const ordered = [...roots].sort(
    (a, b) => normalisePath(b.path).length - normalisePath(a.path).length)
  for (const root of ordered) {
    const base = normalisePath(root.path)
    // Both spellings, because a path reaches a message through Node (forward
    // slashes) and through a shell or a Windows API (backslashes) equally often.
    for (const spelling of [base, base.replace(/\//g, '\\')]) {
      const pattern = new RegExp(
      // portability-ok: a character class matching either separator, not a path
      // this module builds. Reading paths written on another platform is the job.
        `${escapeForPattern(spelling)}(?![A-Za-z0-9_.-])([\\\\/][^\\s"'\`,;)\\]]*)?`, 'g')  // portability-ok
      out = out.replace(pattern, (_match, rest: string | undefined) =>
        rest === undefined || rest === ''
          ? labelOf(root)
          : `${labelOf(root)}${rest.replace(/\\/g, '/')}`)
    }
  }
  return out
}

/** Escape a literal for use inside a regular expression. */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * POSIX directories that hold a person's machine rather than a server's URL
 * space.
 *
 * A bare leading `/` cannot be the test: `/api/v1/chat` is a URL path and
 * appears in every honest diagnostic this product writes, so matching it would
 * make the assertion below fire constantly and be switched off. These are the
 * roots a real leak comes from.
 */
const POSIX_LOCAL_ROOTS = ['home', 'Users', 'var', 'tmp', 'root', 'mnt', 'media', 'opt', 'private']

/**
 * Every absolute local path a string still contains.
 *
 * The test-facing half. A surface that must never carry one asserts this is
 * empty, and gets the offending text back rather than a bare false.
 *
 * A path preceded by `//` in a URL is skipped: `https://host/home/x` names a
 * server's route, not this machine's disk, and reporting it would be a false
 * alarm in exactly the diagnostics a reader needs.
 *
 * The same false alarm reached the Windows branch by a subtler route, and cost
 * more: a drive letter is one letter followed by a colon, and `https:` ends in
 * exactly that shape. Every ordinary URL was therefore reported as a local
 * path — `s://api.example.com` — so `assertNoLocalPath` threw on honest
 * diagnostics like "failed to reach https://…", which is precisely the kind of
 * guard somebody switches off. The lookbehind is what makes a drive letter a
 * drive letter: nothing alphabetic before it, and no colon before a `//`.
 *
 * `file:///D:/Ws/x` still matches, and should: a file URL carries a real local
 * path, and the `D:` in it is preceded by `/` rather than by a scheme.
 */
export function findAbsolutePaths(text: string): readonly string[] {
  const found: string[] = []
  const windows = /(?<![A-Za-z:])(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/\s]+[\\/])[^\s"'`,;)\]]*/g
  for (const match of text.matchAll(windows)) found.push(match[0])

  // portability-ok: the escaped class is regex syntax, not a path separator.
  const posix = new RegExp(`(^|[^A-Za-z0-9_:/])(/(?:${POSIX_LOCAL_ROOTS.join('|')})/[^\\s"'\`,;)\\]]*)`, 'g')  // portability-ok
  for (const match of text.matchAll(posix)) {
    const value = match[2]
    if (value !== undefined) found.push(value)
  }
  return found
}

/**
 * Throw when a value that must be free of local paths is not.
 *
 * Used at the boundaries where a passthrough would be a leak rather than a
 * convenience: a provider payload, an export, a rendered surface. The message
 * names the field and the offending token so the failure is fixable, and it is
 * a programming error rather than a runtime condition.
 */
export function assertNoLocalPath(where: string, value: string): void {
  const found = findAbsolutePaths(value)
  if (found.length === 0) return
  throw new Error(
    `${where} carries ${String(found.length)} absolute local path(s), starting with `
    + `${String(found[0])}. Convert it with redactPath or relativeToRoot first.`)
}
