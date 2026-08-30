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

/** What DSH hands a `conversation.view` entry. */
export interface ModeViewProps {
  /** The record the person selected by clicking a tool row, if any. */
  readonly inspect?: unknown
  readonly onInspectDone?: () => void
}

const S = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    minHeight: 0,
    overflowY: 'auto' as const,
    padding: '20px 24px 32px',
    gap: '18px',
  },
  head: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  title: { fontSize: '15px', fontWeight: 600, margin: 0, letterSpacing: '-0.005em' },
  lead: {
    fontSize: '13px', lineHeight: 1.6, margin: 0, maxWidth: '68ch',
    color: 'var(--dsw-alias-label-secondary)',
  },
  panel: {
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '10px',
    padding: '16px 18px',
    background: 'var(--dsw-alias-bg-base)',
  },
  dashed: {
    border: '1px dashed var(--dsw-alias-border-l2)',
    borderRadius: '10px',
    padding: '20px 22px',
    background: 'transparent',
  },
  h: {
    fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: 'var(--dsw-alias-label-tertiary)', margin: '0 0 8px',
  },
  meta: {
    display: 'grid', gridTemplateColumns: 'max-content 1fr',
    columnGap: '16px', rowGap: '5px', fontSize: '12px', margin: 0,
  },
  key: { color: 'var(--dsw-alias-label-tertiary)' },
  value: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' as const },
  note: {
    fontSize: '12px', lineHeight: 1.55, margin: '14px 0 0',
    color: 'var(--dsw-alias-label-tertiary)',
    borderInlineStart: '2px solid var(--watch-accent)',
    paddingInlineStart: '10px',
  },
}

/** The frame: a title, one sentence of what this is, then the body. */
export function ModeSurface(
  { title, lead, children }: {
    readonly title: string
    readonly lead: string
    readonly children: ReactNode
  },
): ReactNode {
  return (
    <div style={S.root} data-watch-mode={title.toLowerCase()}>
      <header style={S.head}>
        <h2 style={S.title}>{title}</h2>
        <p style={S.lead}>{lead}</p>
      </header>
      {children}
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
    <div style={S.dashed}>
      <p style={{ ...S.lead, marginBottom: '10px' }}>{shows}</p>
      <p style={{ ...S.lead, color: 'var(--dsw-alias-label-tertiary)', margin: 0 }}>{why}</p>
      {next.length === 0 ? null : (
        <ul style={{
          margin: '12px 0 0', paddingInlineStart: '18px',
          fontSize: '12px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)',
        }}
        >
          {next.map(step => <li key={step}>{step}</li>)}
        </ul>
      )}
    </div>
  )
}

/** A titled block of content. */
export function Panel(
  { heading, children }: { readonly heading?: string, readonly children: ReactNode },
): ReactNode {
  return (
    <section style={S.panel}>
      {heading === undefined ? null : <h3 style={S.h}>{heading}</h3>}
      {children}
    </section>
  )
}

/** A key/value grid. Long values wrap rather than forcing the page sideways. */
export function Facts(
  { rows }: { readonly rows: readonly (readonly [string, ReactNode])[] },
): ReactNode {
  return (
    <dl style={S.meta}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt style={S.key}>{label}</dt>
          <dd style={{ ...S.value, margin: 0 }}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A short aside in the product's own voice, marked by the accent rule. */
export function Note({ children }: { readonly children: ReactNode }): ReactNode {
  return <p style={S.note}>{children}</p>
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
    <div style={S.dashed}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <h3 style={{ ...S.title, fontSize: '13px' }}>{what}</h3>
        <span style={{
          fontSize: '11px', padding: '2px 8px', borderRadius: '999px',
          border: '1px solid var(--watch-tone-neutral)', color: 'var(--watch-tone-neutral)',
        }}
        >
          Not available in this build
        </span>
      </div>
      <p style={{ ...S.lead, margin: '8px 0 0' }}>{because}</p>
      {wouldNeed.length === 0 ? null : (
        <>
          <h4 style={{ ...S.h, margin: '14px 0 6px' }}>What it would take</h4>
          <ul style={{
            margin: 0, paddingInlineStart: '18px',
            fontSize: '12px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)',
          }}
          >
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
