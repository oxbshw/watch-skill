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

/**
 * A record identifier for a file that names none of its own.
 *
 * Derived from the full path so two files never collide, digested so nothing
 * of that path survives into the answer, and shaped to the identifier grammar
 * `@watchskill/dsh-contracts` enforces — `[A-Za-z0-9][A-Za-z0-9._-]*` — so the
 * id a search returns is one `libraryGet` will accept.
 *
 * Sixteen hex characters. A collision needs two paths agreeing in 64 bits of
 * SHA-256, which is not a thing a directory of evidence records does by
 * accident, and the alternative is an identifier nobody can read at all.
 */
function identifierForFile(path: string): string {
  return `file-${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16)}`
}

export function recordFromFile(path: string, raw: string): IndexableRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const value = parsed as Record<string, unknown>

  const optional = (candidate: unknown): string | null => (typeof candidate === 'string' && candidate !== '' ? candidate : null)

  // The id comes from the file when it has one, and from a digest of the path
  // when it does not.
  //
  // It used to be the path itself, and that was wrong twice over. It put an
  // absolute host path on the wire and into the browser, where a Library row
  // rendered `D:/watch-manual/dsh-home/watch-fixtures/05-unverified.json` as
  // both the identifier and the title — the read plane's own rule is that a
  // record never carries a filesystem location. And it was not addressable, in
  // contradiction of the comment that used to stand here: `libraryGet`
  // validates `recordId` against the identifier grammar, which has no slash and
  // no colon, so every record whose file named no id came back from a search
  // and was then refused with `identifier_invalid` when fetched by it.
  //
  // A digest of the path keeps both properties the path was chosen for — one
  // id per file, stable across runs — and satisfies the grammar.
  const recordId = optional(value['evidenceId'])
    ?? optional(value['sourceId'])
    ?? optional(value['verificationId'])
    ?? identifierForFile(path)

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
    revisionId: optional(value['sourceRevisionId']) ?? `${recordId}@1`,
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
  const skipped: string[] = []

  for (const root of roots) {
    if (!existsSync(root)) {
      skipped.push(`${root}: does not exist`)
      continue
    }
    let entries: readonly string[]
    try {
      entries = readdirSync(root)
    } catch (error) {
      skipped.push(`${root}: ${String(error)}`)
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const path = join(root, entry).replace(/\\/g, '/')
      // The boundary check runs on the resolved path, not on the name, so a
      // symlink or a crafted entry cannot walk out of the root.
      if (!isWithinRoots(path, roots)) {
        skipped.push(`${entry}: outside the configured roots`)
        continue
      }
      try {
        if (!statSync(path).isFile()) continue
        const record = recordFromFile(path, readFileSync(path, 'utf8'))
        if (record === null) {
          skipped.push(`${entry}: not a readable record`)
          continue
        }
        records.push(record)
      } catch (error) {
        skipped.push(`${entry}: ${String(error)}`)
      }
    }
  }
  return { records, skipped }
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
  // Built once and rebuilt on request. Holding it means a search does not
  // re-read the corpus on every keystroke; rebuilding on request means a
  // person is never stuck with an index that has fallen behind.
  let cached: LibraryIndex | null = null
  let skippedFiles: readonly string[] = []

  const indexNow = (rebuild: boolean): LibraryIndex => {
    if (cached === null || rebuild) {
      const built = buildIndex(config.roots)
      cached = built.index
      skippedFiles = built.skipped
    }
    return cached
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
    // Async because the tool runner expects a promise. The work itself is
    // synchronous: an in-memory index over files already read.
    // eslint-disable-next-line @typescript-eslint/require-await
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

      const index = indexNow(args['rebuild'] === true)
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
  return { index: () => indexNow(false) }
}
