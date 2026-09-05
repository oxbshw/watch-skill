/**
 * The Obsidian adapter: optional, one-directional about authority, and inert.
 *
 * Obsidian is a good place to read a workspace wiki and a terrible place to
 * keep the record of what an agent believes. It is a folder of Markdown that
 * anything can write to — a sync client, a plugin, a shared drive, another
 * person — and the thing that makes it pleasant is exactly the thing that
 * makes it unsuitable as an authority.
 *
 * So this adapter does two things and refuses a third.
 *
 * It **exports** a vault: the generated wiki, plus the frontmatter and
 * wikilinks that make Obsidian's graph and backlinks work. It **imports** an
 * edit as a *proposal*, through the same validation a hand-edited wiki page
 * goes through. It never lets vault content become authority — not evidence,
 * not a verdict, not `explicit_user`, not a permission, not a scope change.
 *
 * Nothing in Watch Core depends on this module, and nothing here imports
 * Obsidian. There is no Obsidian API to import; the integration surface is a
 * folder and a URI scheme, which is why the adapter can be tested completely
 * against a filesystem-shaped fixture. What cannot be tested here is whether a
 * real Obsidian installation opens the URI, and that is reported as
 * NOT MACHINE TESTED rather than assumed.
 *
 * @module @deepwatch/dsh-adapters/obsidian
 */

import type { MemoryRecord } from '@deepwatch/dsh-memory'
import type { WikiPage, WikiProjection, ValidatedEdit } from '@deepwatch/dsh-wiki'
import { diffUserEdit, validateUserEdit } from '@deepwatch/dsh-wiki'

/** One file as it would sit in a vault. */
export interface VaultFile {
  /** Path relative to the vault root. */
  readonly path: string
  readonly content: string
  /** Tags in the frontmatter, without the leading hash. */
  readonly tags: readonly string[]
  /** Pages this one links to, by vault path. */
  readonly links: readonly string[]
}

/** A whole exported vault. */
export interface Vault {
  readonly name: string
  readonly files: readonly VaultFile[]
  /**
   * The note that travels with the export.
   *
   * Present as data rather than as a README somebody might not open: the
   * export writes it into the vault, so a person who arrives at these files
   * from a sync client rather than from Watch still learns what they are.
   */
  readonly readme: string
}

/** How the export should be shaped. */
export interface VaultOptions {
  readonly name: string
  /** Prefix inside the vault, so a Watch export can live beside other notes. */
  readonly folder?: string
  /** Include the log page. Off by default: it is long and rarely read here. */
  readonly includeLog?: boolean
}

/** Escape a YAML scalar the crude, safe way. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Derive tags from a page's path and provenance. */
function tagsFor(page: WikiPage): readonly string[] {
  const section = page.path.includes('/') ? page.path.split('/')[0] ?? '' : 'index'
  const tags = ['watch', `watch/${section}`]
  if (page.provenance.length === 0) tags.push('watch/generated-index')
  return tags
}

/**
 * Rewrite a generated page's Markdown links as Obsidian wikilinks.
 *
 * Deliberately conservative: only links that resolve to a page in the same
 * projection are rewritten. A rewritten link that goes nowhere is worse than a
 * plain one, because Obsidian will offer to create the missing note — and a
 * note created that way is a file with no provenance sitting in a folder full
 * of files that have some.
 */
function toWikilinks(page: WikiPage, known: ReadonlySet<string>): {
  readonly content: string
  readonly links: readonly string[]
} {
  const links: string[] = []
  const folder = page.path.includes('/') ? `${page.path.split('/')[0] ?? ''}/` : ''
  const content = page.content.replace(
    /\[([^\]]+)\]\(([^)]+\.md)\)/g,
    (whole, label: string, target: string) => {
      const resolved = target.startsWith('.') || target.includes('/')
        ? target.replace(/^\.\//, '')
        : `${folder}${target}`
      if (!known.has(resolved)) return whole
      links.push(resolved)
      const stem = resolved.replace(/\.md$/, '')
      return `[[${stem}|${label}]]`
    },
  )
  return { content, links }
}

/** The note that ships inside every exported vault. */
const VAULT_README = `# Watch export

These notes are **generated** from the Watch memory ledger. They are a
projection, not the record.

- Editing a note here does not change what Watch believes. An edit is imported
  as a *proposal*, validated, and then the note is regenerated from the ledger.
- Nothing in this vault is evidence, and nothing here can make something
  verified.
- A note added by hand — or by a sync client, a plugin, or another person — is
  imported at the weakest origin there is. It cannot grant a permission, change
  a memory's scope, or claim that you said something.

If this folder and Watch disagree, Watch is right and this folder is stale.
Re-export to fix it.
`

/**
 * Export the wiki as an Obsidian vault.
 *
 * Frontmatter carries tags and the provenance ids, so a person browsing in
 * Obsidian can still see where a statement came from — the graph view is
 * pleasant and it is also a place where provenance is very easy to lose.
 */
export function toVault(projection: WikiProjection, options: VaultOptions): Vault {
  const folder = options.folder === undefined || options.folder === ''
    ? ''
    : `${options.folder.replace(/\/+$/, '')}/`
  const included = projection.pages.filter(
    page => options.includeLog === true || page.path !== 'log.md')
  const known = new Set(included.map(page => page.path))

  const files = included.map(page => {
    const { content, links } = toWikilinks(page, known)
    const tags = tagsFor(page)
    const frontmatter = [
      '---',
      `title: ${yamlString(page.title)}`,
      `tags: [${tags.map(tag => yamlString(tag)).join(', ')}]`,
      'watch_generated: true',
      `watch_provenance: [${page.provenance.map(id => yamlString(id)).join(', ')}]`,
      '---',
      '',
    ].join('\n')
    return {
      path: `${folder}${page.path}`,
      content: `${frontmatter}${content}`,
      tags,
      links: links.map(link => `${folder}${link}`),
    }
  })

  return {
    name: options.name,
    files: [
      { path: `${folder}README.md`, content: VAULT_README, tags: ['watch'], links: [] },
      ...files,
    ],
    readme: VAULT_README,
  }
}

/**
 * Backlinks, computed from the export rather than read from Obsidian.
 *
 * Computing them here means the export can be checked for a dangling link
 * before anybody opens it, and means the adapter does not need Obsidian to
 * answer a question about its own output.
 */
export function backlinks(vault: Vault): ReadonlyMap<string, readonly string[]> {
  const incoming = new Map<string, string[]>()
  for (const file of vault.files) {
    for (const link of file.links) {
      const list = incoming.get(link) ?? []
      list.push(file.path)
      incoming.set(link, list)
    }
  }
  return new Map([...incoming].map(([path, sources]) => [path, [...sources].sort()]))
}

/** Links that point at a file the export does not contain. */
export function danglingLinks(vault: Vault): readonly string[] {
  const known = new Set(vault.files.map(file => file.path))
  const dangling = new Set<string>()
  for (const file of vault.files) {
    for (const link of file.links) if (!known.has(link)) dangling.add(link)
  }
  return [...dangling].sort()
}

/**
 * The URI that opens one page in Obsidian.
 *
 * Constructed, never executed. Handing a URI to the shell is the desktop
 * layer's job and is gated there; an adapter that could launch things would be
 * an adapter that a generated page could aim.
 */
export function pageUri(vaultName: string, path: string): string {
  const file = path.replace(/\.md$/, '')
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`
}

/** The URI that opens the vault itself. */
export function vaultUri(vaultName: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}`
}

/**
 * Strip the frontmatter an export added, so a diff compares like with like.
 *
 * Without this, every imported file would appear to have removed the entire
 * generated page and added an entire new one.
 */
export function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content)
  return match === null ? content : content.slice(match[0].length)
}

/**
 * Import an edited vault file as a proposal.
 *
 * Runs through the wiki's own diff and validation, which is the point: there
 * is one place that decides what an edited file may assert, and an adapter
 * that had its own copy of those rules would be a second place for them to
 * drift.
 */
export function importVaultFile(
  file: { readonly path: string; readonly content: string },
  generated: WikiPage,
): ValidatedEdit {
  const body = stripFrontmatter(file.content)
  return validateUserEdit(diffUserEdit(generated, body), generated)
}

/**
 * What this adapter can and cannot claim on this machine.
 *
 * Stated as a value so the Settings surface renders the truth rather than a
 * checkmark. Export, backlinks, URI construction and import are all pure and
 * are gated by tests. Whether a real Obsidian installation opens the URI is
 * not something this machine can answer, and it says so.
 */
export interface AdapterAvailability {
  readonly adapterId: string
  readonly optional: true
  readonly proven: readonly string[]
  readonly notMachineTested: readonly string[]
}

/** The Obsidian adapter's honest self-description. */
export function obsidianAvailability(): AdapterAvailability {
  return {
    adapterId: 'adapter.obsidian',
    optional: true,
    proven: [
      'Vault export, including frontmatter, tags and wikilinks.',
      'Backlink and dangling-link computation over the export.',
      'URI construction for a vault and for one page.',
      'Import of an edited file as a proposal, through the wiki’s own validation.',
    ],
    notMachineTested: [
      'Opening an obsidian:// URI. No Obsidian installation is present here, so '
      + 'whether it launches and resolves the page has not been observed.',
      'Round-tripping through Obsidian’s own editor, which may normalise Markdown '
      + 'in ways this adapter has not seen.',
    ],
  }
}

/**
 * Whether a memory record may be written into a shared vault.
 *
 * An export is a copy that leaves the product, and once it is in a synced
 * folder it is wherever that folder goes. Personal taste and anything
 * sensitive stay out by default, and the caller has to say otherwise per
 * export rather than once in a setting.
 */
export function mayExport(
  record: MemoryRecord,
  options: { readonly includePersonal?: boolean } = {},
): boolean {
  if (record.sensitivity === 'sensitive' || record.sensitivity === 'restricted') return false
  if (record.kind === 'preference' && options.includePersonal !== true) return false
  if (record.subjectScope === 'user' && options.includePersonal !== true) return false
  return true
}
