/**
 * Library search, as a tool the host owns.
 *
 * The index has to live somewhere that can read the evidence store, and the
 * browser cannot: a client plugin receives no config, `ctx.remote` is an event
 * bus rather than a query client, and the boot graph carries no data. The host
 * can read the store, so the host holds the index and the agent reaches it the
 * way it reaches everything else in Watch — as a tool.
 *
 * It is the same `LibraryIndex` the client surface uses. One implementation,
 * one set of semantics, one place where "every term must match" is decided;
 * two would drift within a release and disagree about what the library
 * contains.
 *
 * Three things it will not do.
 *
 * It reads only inside the roots it was configured with. `isWithinRoots`
 * refuses traversal rather than normalising it, because normalising an attempt
 * to escape produces a path that works.
 *
 * It returns no verdict. A search result is a pointer to a record, and whether
 * that record's claim is true is `watch_verify`'s question. A tool that
 * answered both would let a search become an assertion.
 *
 * And it never rebuilds silently. A stale or corrupt index is reported as such
 * in the result, because a search that quietly returns less than it should is
 * worse than one that says it is behind.
 *
 * @module @watchskill/dsh-tools/library-search
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { contentIdFor, revisionIdFor } from '@watchskill/dsh-contracts/identity'
import { LibraryIndex, MAX_LIMIT, isWithinRoots } from '@watchskill/dsh-library'
import type { IndexableRecord } from '@watchskill/dsh-library'

/** Where the index is allowed to read from. */
export interface LibrarySearchConfig {
  /**
   * Directories holding evidence records.
   *
   * Nothing outside these is read, whatever a filename claims. An empty list
   * means the tool has nothing to index and says so rather than falling back
   * to somewhere convenient.
   */
  readonly roots: readonly string[]
  /**
   * Who owns the index, when somebody does.
   *
   * The tool used to hold its own, which was fine while it was the only
   * reader. It is not: the read plane answers the same corpus for the Library
   * surface, and a refresh asked for by either has to be the same refresh.
   * Two caches would drift inside one release and disagree about what the
   * library contains — a person searching the UI and the agent searching the
   * tool getting different answers to the same question.
   */
  readonly generations?: LibraryGenerationsLike
}

/**
 * The part of `LibraryGenerations` this module needs.
 *
 * Structural rather than an import of the class, because the class imports the
 * builders from here and a direct edge would close a cycle between two modules
 * that are one concern.
 */
export interface LibraryGenerationsLike {
  index(): LibraryIndex
  refresh(requestId: string, signal: AbortSignal): Promise<unknown>
}

/**
 * Read one JSON file into a record, or nothing.
 *
 * Deliberately total: a malformed file, an unreadable one, or one holding
 * something that is not a record yields no record rather than throwing. One bad
 * file must not stop the whole library being searchable — a corpus is exactly
 * where a single malformed entry is most likely and least excusable as a
 * failure mode.
 */
/**
 * Every string in a record, at any depth.
 *
 * Reading only the top level looked reasonable and was wrong: a citation's
 * text, a check's detail and a revision's transcript all live one or two
 * levels down, so a phrase plainly present in the file returned nothing.
 *
 * Bounded on purpose. A record is data, not a program, so a deeply nested or
 * self-referential one costs a fixed amount of work rather than a stack
 * overflow — and a malformed file is exactly where that would show up.
 */
export function gatherText(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 8) return []
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (typeof value !== 'object' || value === null) return []
  if (seen.has(value)) return []
  seen.add(value)

  const out: string[] = []
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 500)) out.push(...gatherText(entry, depth + 1, seen))
    return out
  }
  for (const [key, entry] of Object.entries(value)) {
    // Digests are matched through their own fields. Folding them into the body
    // would make every record match every hex-looking query.
    if (/^(digest|hash|sha256|contentDigest|inputDigest)$/i.test(key)) continue
    out.push(...gatherText(entry, depth + 1, seen))
  }
  return out
}

/** Correlates one tool-initiated rebuild, so a retried tool call is idempotent. */
let toolRequest = 1

/** `sha256` hex, the one primitive both identity functions are built on. */
const sha256hex = (material: string): string =>
  createHash('sha256').update(material, 'utf8').digest('hex')

/**
 * The digest of a file's bytes.
 *
 * Bytes, not the decoded string. A file is what is on disk, and a record whose
 * identity depended on how it happened to be decoded would change identity for
 * a byte-order mark nobody typed.
 */
export function contentDigest(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex')
}

export function recordFromFile(
  path: string, raw: string | Uint8Array,
): IndexableRecord | null {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const value = parsed as Record<string, unknown>

  const optional = (candidate: unknown): string | null => (typeof candidate === 'string' && candidate !== '' ? candidate : null)

  // The id comes from the file when it names one, and from the file's *content*
  // when it does not. Identity follows bytes.
  //
  // Two earlier answers were both wrong, in opposite directions. The path
  // itself put an absolute host location on the wire and into the browser, and
  // was not even addressable — `libraryGet` validates `recordId` against the
  // identifier grammar, which has no slash and no colon, so a search returned
  // ids that its sibling method refused. A digest of the path fixed the
  // disclosure and kept the deeper error: move byte-identical content and it
  // became a different record; overwrite the bytes and it stayed the same one.
  // That is the exact defect `src/watch_skill/identity.py` was written to end,
  // where a video's id used to be `sha256(source_string)` and overwriting
  // `demo.mp4` returned yesterday's answers for today's file.
  //
  // So the fallback is Core's own content identity, mirrored in
  // `@watchskill/dsh-contracts/identity` and tested against the Python. The
  // same bytes are one record wherever they are read from, and different bytes
  // are two.
  const digest = contentDigest(raw)
  const recordId = optional(value['evidenceId'])
    ?? optional(value['sourceId'])
    ?? optional(value['verificationId'])
    ?? contentIdFor(digest, sha256hex)

  // Body text is every string the record carries, at any depth.
  //
  // Reading only the top level looked reasonable and was wrong: a citation's
  // text, a check's detail and a revision's transcript all live one or two
  // levels down, so searching for a phrase plainly present in the file
  // returned nothing. A record's searchable text is whatever it actually
  // says, wherever it says it.
  const body = gatherText(value).join('\n')

  const tags = Array.isArray(value['tags'])
    ? value['tags'].filter((tag): tag is string => typeof tag === 'string')
    : []

  return {
    recordId,
    // The revision names the version of the content, so it comes from the
    // content too. `identity.revision_id_for`, mirrored: changing the bytes at
    // one path produces a new revision, which is the fact a surface renders as
    // "this is not what you saw before".
    revisionId: optional(value['sourceRevisionId']) ?? revisionIdFor(digest, sha256hex),
    // A digest is an identifier, not something to read. Where the file names
    // no title, the file's own name is what a person can recognise — and it is
    // a name rather than a location, so it carries no directory with it.
    title: optional(value['title']) ?? optional(value['expectation'])
      ?? basename(path).replace(/\.json$/i, ''),
    kind: (optional(value['kind']) ?? 'document') as IndexableRecord['kind'],
    text: body,
    source: optional(value['locator']) ?? optional(value['source']),
    runId: optional(value['runId']) ?? optional(value['sessionId']),
    observedAt: optional(value['observedAt']) ?? optional(value['at']),
    verdict: optional(value['verdict']),
    tags,
    evidenceIds: Array.isArray(value['evidenceRefs'])
      ? value['evidenceRefs'].filter((id): id is string => typeof id === 'string')
      : [],
  }
}

/**
 * Read every record under the configured roots.
 *
 * Returns what it managed to read plus what it refused, because a caller that
 * cannot tell "there is nothing here" from "I was not allowed to look" cannot
 * report either honestly.
 */
export function collectRecords(roots: readonly string[]): {
  readonly records: readonly IndexableRecord[]
  readonly skipped: readonly string[]
} {
  const records: IndexableRecord[] = []
  const listed = recordFiles(roots)

  for (const file of listed.files) {
    const read = readRecord(file, roots)
    if (read.record === null) listed.skipped.push(read.skipped)
    else records.push(read.record)
  }
  return { records, skipped: listed.skipped }
}

/** One candidate file: where it is, and the only part of that a caller may see. */
interface RecordFile {
  readonly path: string
  readonly name: string
}

/**
 * The files worth trying, and the roots that could not be listed.
 *
 * Every skip reason here is a fixed sentence. Interpolating the error, which
 * this used to do, puts the absolute root into a string that reaches the wire
 * through a refresh answer — the one thing the read plane promises it never
 * carries. The host knows where it read; the caller learns only that it could
 * not.
 */
function recordFiles(roots: readonly string[]): {
  readonly files: readonly RecordFile[]
  readonly skipped: string[]
} {
  const files: RecordFile[] = []
  const skipped: string[] = []

  for (const root of roots) {
    if (!existsSync(root)) {
      skipped.push('a configured library root does not exist')
      continue
    }
    let entries: readonly string[]
    try {
      entries = readdirSync(root)
    } catch {
      skipped.push('a configured library root could not be listed')
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      files.push({ path: join(root, entry).replace(/\\/g, '/'), name: entry })
    }
  }
  return { files, skipped }
}

/** Read one candidate, or say — by name, never by path — why it was skipped. */
function readRecord(file: RecordFile, roots: readonly string[]): {
  readonly record: IndexableRecord | null
  readonly skipped: string
} {
  // The boundary check runs on the resolved path, not on the name, so a
  // symlink or a crafted entry cannot walk out of the root.
  if (!isWithinRoots(file.path, roots)) {
    return { record: null, skipped: `${file.name}: outside the configured roots` }
  }
  try {
    if (!statSync(file.path).isFile()) {
      return { record: null, skipped: `${file.name}: not a regular file` }
    }
    const record = recordFromFile(file.path, readFileSync(file.path))
    return record === null
      ? { record: null, skipped: `${file.name}: not a readable record` }
      : { record, skipped: '' }
  } catch {
    // The error message would name the path. The filename is what a person
    // needs to go and look at it.
    return { record: null, skipped: `${file.name}: could not be read` }
  }
}

/** Build a fresh index over the roots. Cheap enough to do on demand. */
export function buildIndex(roots: readonly string[]): {
  readonly index: LibraryIndex
  readonly skipped: readonly string[]
} {
  const { records, skipped } = collectRecords(roots)
  const index = new LibraryIndex()
  index.addAll(records)
  return { index, skipped }
}

/**
 * Build an index, yielding often enough that a caller can stop it.
 *
 * The synchronous builder above is what a tool call uses: it is one pass over
 * a directory and returning a promise would buy nothing. A refresh is
 * different — it is a person waiting, it has a deadline, and it has to be
 * abandonable — so this one checks the signal between files and hands the
 * event loop back so the check can actually fire.
 *
 * It builds into a *new* index. Nothing in service is touched until the caller
 * decides to swap, which is what makes a failed or abandoned rebuild leave the
 * previous generation exactly as it was.
 */
export async function buildIndexCancellable(
  roots: readonly string[], signal: AbortSignal,
): Promise<{
  readonly index: LibraryIndex | null
  readonly skipped: readonly string[]
  readonly sourceCount: number
}> {
  const listed = recordFiles(roots)
  const records: IndexableRecord[] = []

  for (const file of listed.files) {
    if (signal.aborted) return { index: null, skipped: listed.skipped, sourceCount: roots.length }
    // One turn of the loop per file. A directory of evidence records is not
    // large enough for the yield to cost anything measurable, and without it
    // an abort raised during the walk is not observed until the walk is over.
    await Promise.resolve()
    const read = readRecord(file, roots)
    if (read.record === null) listed.skipped.push(read.skipped)
    else records.push(read.record)
  }
  if (signal.aborted) return { index: null, skipped: listed.skipped, sourceCount: roots.length }

  const index = new LibraryIndex()
  index.addAll(records)
  return { index, skipped: listed.skipped, sourceCount: roots.length }
}

/** The same output shape the rest of the Watch tools use. */
const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/**
 * Hand a plain value to the tool runner.
 *
 * `JsonValue` wants an index signature that a named result shape deliberately
 * does not have. The value is already plain JSON, so the conversion is asserted
 * once here rather than at every return.
 */
function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

/**
 * Register the search tool, and hand back the index it holds.
 *
 * The accessor is returned rather than the index itself so the read plane sees
 * a rebuild the moment it happens, without either side holding a reference to
 * an object the other has replaced. One index answers both the agent's tool
 * and the person's surface: two would drift inside a release and disagree
 * about what the library contains.
 */
export function applyLibrarySearch(
  ctx: Context, config: LibrarySearchConfig,
): { readonly index: () => LibraryIndex } {
  // Held rather than rebuilt per query: a search must not re-read the corpus on
  // every keystroke. Where an owner was supplied the index is its index, so a
  // refresh asked for through the surface is visible here immediately and the
  // agent never searches a different corpus from the person.
  let fallback: LibraryIndex | null = null
  let skippedFiles: readonly string[] = []

  const indexNow = (): LibraryIndex => {
    if (config.generations !== undefined) return config.generations.index()
    if (fallback === null) {
      const built = buildIndex(config.roots)
      fallback = built.index
      skippedFiles = built.skipped
    }
    return fallback
  }

  /** The tool's own `rebuild` argument, routed to the one owner of the index. */
  const rebuildNow = async (): Promise<void> => {
    if (config.generations === undefined) {
      const built = buildIndex(config.roots)
      fallback = built.index
      skippedFiles = built.skipped
      return
    }
    // A tool call is its own request. The id is what makes a retried tool call
    // idempotent rather than a second read of the corpus.
    await config.generations.refresh(
      `tool-${String(toolRequest++)}`, new AbortController().signal,
    )
  }

  ;(ctx as unknown as { tools: { register(tool: unknown): void } }).tools.register(defineTool({
    name: 'watch_library_search',
    description:
      'Search the evidence and sources Watch has recorded in this workspace. Matching is lexical '
      + 'and local — every word you give must appear in a record — so it works offline and needs no '
      + 'embedding model. Returns pointers to records, never a verdict: use watch_verify to '
      + 'establish whether a record\'s claim actually holds.',
    parameters: {
      query: {
        type: 'string',
        description: 'Words to find. Every word must appear. Leave empty to list everything the filters allow.',
      },
      verdict: { type: 'string', description: 'Only records with this verification state.' },
      run_id: { type: 'string', description: 'Only records from this run.' },
      from: { type: 'string', description: 'ISO-8601 lower bound on the observation time.' },
      to: { type: 'string', description: 'ISO-8601 upper bound on the observation time.' },
      sort: { type: 'string', description: 'relevance | newest | oldest | title. Defaults to relevance.' },
      offset: { type: 'number', description: 'Results to skip, for paging.' },
      limit: { type: 'number', description: `Maximum results. Capped at ${String(MAX_LIMIT)}.` },
      rebuild: { type: 'boolean', description: 'Rebuild the index before searching. The index is derived and safe to discard.' },
    },
    output: JSON_OUTPUT,
    async execute(rawArgs: unknown): Promise<JsonValue> {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      if (config.roots.length === 0) {
        return asJson({
          ok: false,
          error: 'no_roots_configured',
          message: 'This deployment gave the library no evidence roots, so there is nothing to search.',
          fix: "Set the watch-tools row's `libraryRoots` to the directories holding evidence records.",
          retryable: false,
        })
      }

      if (args['rebuild'] === true) await rebuildNow()
      const index = indexNow()
      const page = index.search({
        text: typeof args['query'] === 'string' ? args['query'] : '',
        ...(typeof args['verdict'] === 'string' ? { verdicts: [args['verdict']] } : {}),
        ...(typeof args['run_id'] === 'string' ? { runIds: [args['run_id']] } : {}),
        ...(typeof args['from'] === 'string' ? { from: args['from'] } : {}),
        ...(typeof args['to'] === 'string' ? { to: args['to'] } : {}),
        ...(typeof args['sort'] === 'string'
          ? { sort: args['sort'] as 'relevance' | 'newest' | 'oldest' | 'title' }
          : {}),
        ...(typeof args['offset'] === 'number' ? { offset: args['offset'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      })

      return asJson({
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          indexHealth: page.health,
          indexedRecords: index.size,
          notes: page.notes,
          // Named so nobody mistakes a search hit for a finding.
          skippedFiles,
          results: page.results.map(result => ({
            recordId: result.sourceId,
            title: result.title,
            kind: result.kind,
            snippets: result.hits.map(hit => hit.text),
            evidenceIds: result.hits.flatMap(hit => hit.evidenceIds),
          })),
      })
    },
  }))

  // The tool and the read plane share this. See the note on the signature.
  return { index: () => indexNow() }
}
