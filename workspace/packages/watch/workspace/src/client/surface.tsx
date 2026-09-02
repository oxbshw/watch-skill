/**
 * The scaffolding every Watch mode shares.
 *
 * The four Watch modes answer different questions but face the same
 * constraint, and it is worth stating plainly because it shapes all of them.
 *
 * A `conversation.view` entry is handed exactly two props by DSH —
 * `{ inspect, onInspectDone }` — and `ctx.remote` is an event bus
 * (`$on`/`$dispatch`/`$mount`), not a query client. Watch contributes *tools*,
 * so Watch's evidence, verdicts and receipts arrive in the conversation as tool
 * results; there is no client-reachable Watch query route, and inventing one
 * would mean building a second data path beside the one that exists.
 *
 * So each mode renders the supported subset — whatever the person has selected,
 * read through the real contracts — and says precisely, and truthfully, what it
 * cannot show and what would change that. An empty surface that explains itself
 * is a product; an empty surface that looks busy is a lie with a chart on it.
 *
 * @module @deepwatch/dsh-workspace/surface
 */

import type { ReactNode } from 'react'
import { WATCH_MARK_PNG } from '@deepwatch/dsh-client-brand'

/** What DSH hands a `conversation.view` entry. */
export interface ModeViewProps {
  /** The record the person selected by clicking a tool row, if any. */
  readonly inspect?: unknown
  readonly onInspectDone?: () => void
}

const MODE_KICKER: Readonly<Record<string, string>> = {
  Watch: 'Trust layer',
  Live: 'Observation',
  Memory: 'Knowledge',
  Library: 'Evidence library',
  Compare: 'Change analysis',
}

/** Stable global class names; their rules live with the product theme. */
const C = {
  root: 'watch-mode-root',
  hero: 'watch-mode-hero',
  markFrame: 'watch-mode-mark-frame',
  mark: 'watch-mode-mark',
  heroCopy: 'watch-mode-hero-copy',
  eyebrow: 'watch-mode-eyebrow',
  title: 'watch-mode-title',
  lead: 'watch-mode-lead',
  localBadge: 'watch-mode-local-badge',
  body: 'watch-mode-body',
  empty: 'watch-empty',
  emptyCopy: 'watch-empty-copy',
  sectionLabel: 'watch-section-label',
  emptyShows: 'watch-empty-shows',
  emptyWhy: 'watch-empty-why',
  nextBlock: 'watch-next-block',
  nextList: 'watch-next-list',
  panel: 'watch-panel',
  panelHeading: 'watch-panel-heading',
  facts: 'watch-facts',
  factRow: 'watch-fact-row',
  factKey: 'watch-fact-key',
  factValue: 'watch-fact-value',
  note: 'watch-note',
  noteMark: 'watch-note-mark',
  unavailable: 'watch-unavailable',
  unavailableHead: 'watch-unavailable-head',
  unavailableBadge: 'watch-unavailable-badge',
  unavailableBecause: 'watch-unavailable-because',
  requirements: 'watch-requirements',
} as const

/** The frame: a title, one sentence of what this is, then the body. */
export function ModeSurface(
  { title, lead, children }: {
    readonly title: string
    readonly lead: string
    readonly children: ReactNode
  },
): ReactNode {
  return (
    <div className={C.root} data-watch-mode={title.toLowerCase()}>
      <header className={C.hero}>
        <span className={C.markFrame} aria-hidden="true">
          <img className={C.mark} src={WATCH_MARK_PNG} alt="" />
        </span>
        <div className={C.heroCopy}>
          <span className={C.eyebrow}>
            {`DEEPWATCH / ${MODE_KICKER[title] ?? 'Evidence workspace'}`}
          </span>
          <h2 className={C.title}>{title}</h2>
          <p className={C.lead}>{lead}</p>
        </div>
        <span className={C.localBadge}>Local-first</span>
      </header>
      <div className={C.body}>{children}</div>
    </div>
  )
}

/**
 * What this surface would show, why it shows nothing, and what to do.
 *
 * All three parts are required. "No data" on its own teaches people the product
 * is broken; naming the reason and the next action is the difference between an
 * empty state and a dead end.
 */
export function EmptyState(
  { shows, why, next }: {
    readonly shows: string
    readonly why: string
    readonly next: readonly string[]
  },
): ReactNode {
  return (
    <div className={C.empty} data-watch-empty-state="">
      <div className={C.emptyCopy}>
        <span className={C.sectionLabel}>What appears here</span>
        <p className={C.emptyShows}>{shows}</p>
        <p className={C.emptyWhy}>{why}</p>
      </div>
      {next.length === 0
        ? null
        : (
            <div className={C.nextBlock}>
              <span className={C.sectionLabel}>Start here</span>
              <ol className={C.nextList}>
                {next.map(step => <li key={step}>{step}</li>)}
              </ol>
            </div>
          )}
    </div>
  )
}

/** A titled block of content. */
export function Panel(
  { heading, children }: { readonly heading?: string, readonly children: ReactNode },
): ReactNode {
  return (
    <section className={C.panel} data-watch-panel="">
      {heading === undefined ? null : <h3 className={C.panelHeading}>{heading}</h3>}
      {children}
    </section>
  )
}

/** A key/value grid. Long values wrap rather than forcing the page sideways. */
export function Facts(
  { rows }: { readonly rows: readonly (readonly [string, ReactNode])[] },
): ReactNode {
  return (
    <dl className={C.facts}>
      {rows.map(([label, value]) => (
        <div key={label} className={C.factRow}>
          <dt className={C.factKey}>{label}</dt>
          <dd className={C.factValue}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A short aside in the product's own voice, marked by the accent rule. */
export function Note({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <aside className={C.note}>
      <span className={C.noteMark} aria-hidden="true">i</span>
      <p>{children}</p>
    </aside>
  )
}

/**
 * A capability this build cannot reach, said out loud.
 *
 * Distinct from `EmptyState`: empty means nothing has happened yet, unavailable
 * means the surface could not show it even if something had. Conflating the two
 * is how a person concludes a working feature is broken, or a missing one is
 * merely quiet.
 */
export function Unavailable(
  { what, because, wouldNeed }: {
    readonly what: string
    readonly because: string
    readonly wouldNeed: readonly string[]
  },
): ReactNode {
  return (
    <div className={C.unavailable} data-watch-unavailable="">
      <div className={C.unavailableHead}>
        <h3>{what}</h3>
        <span className={C.unavailableBadge}>
          Not available in this build
        </span>
      </div>
      <p className={C.unavailableBecause}>{because}</p>
      {wouldNeed.length === 0 ? null : (
        <>
          <h4 className={C.panelHeading}>What it would take</h4>
          <ul className={C.requirements}>
            {wouldNeed.map(item => <li key={item}>{item}</li>)}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * Read the JSON a Watch tool returned out of whatever DSH handed us.
 *
 * Returns null on anything unexpected — a running call, a failed one, a result
 * that is not JSON, a shape we do not recognise. The caller then renders its
 * empty state, which is the honest outcome: a surface that cannot read its
 * input must not draw a card implying it did.
 */
export function readToolResult(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return null
  const block = value as { kind?: unknown, isError?: unknown, content?: unknown }
  if (!('kind' in block) || block.isError === true) return null
  if (!Array.isArray(block.content)) return null
  const text = block.content
    .filter((part): part is { type: 'text', text: string } =>
      typeof part === 'object' && part !== null
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string')
    .map(part => part.text)
    .join('')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
