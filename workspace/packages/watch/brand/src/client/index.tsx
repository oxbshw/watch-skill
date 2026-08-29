/**
 * The Watch brand, occupying DSH's generic brand slots.
 *
 * `ui-brand-official` is the one entry in the parity register marked
 * `intentionally_replaced`, and this is the replacement. The slots it fills are
 * upstream's own, declared generic precisely so a distribution can supply its
 * own identity; nothing is patched.
 *
 * Attribution and the independence disclosure travel with the mark rather than
 * being left to whoever assembles a footer. They are legal statements, and a
 * legal statement that depends on being remembered will eventually not be.
 *
 * @module @watchskill/dsh-client-brand/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { ATTRIBUTION, INDEPENDENCE, PRODUCT_NAME, PRODUCT_SHORT_NAME } from '../identity.js'
import { WATCH_MARK_PNG } from '../mark.js'
import './theme.css'

export * from '../identity.js'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/**
 * The Watch mark: the orca, from the brand master.
 *
 * The artwork is the source of truth and is not redrawn, recoloured or
 * reproportioned here. It is inlined as a data URI by `scripts/brand-assets.mjs`
 * rather than fetched, because a mark that needs a second request is a mark
 * that is sometimes missing — on first paint, on a cold offline profile, or
 * behind a slow loopback.
 *
 * `size` drives both the box and the rendered dimensions. The inlined source is
 * 64px, so a 32px slot still has a full 2x of detail; below that the mark is
 * simply the same artwork smaller, never a different drawing.
 *
 * Two accessibility rules, and the difference between them matters:
 *
 *   - Where the mark stands alone, it carries the product name.
 *   - Where the name is already beside it — the sidebar sets mark and name in
 *     adjacent slots — the mark is decorative, and announcing "Watch Workspace"
 *     twice is worse than announcing it once.
 */
function WatchMark({ size = 18, decorative = false }: {
  readonly size?: number
  readonly decorative?: boolean
}): ReactNode {
  return (
    <img
      src={WATCH_MARK_PNG}
      width={size}
      height={size}
      alt={decorative ? '' : PRODUCT_NAME}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img' })}
      style={{
        // Square box, and `contain` so a container that is not square cannot
        // stretch the artwork. The master is 1:1 and stays 1:1.
        width: `${String(size)}px`,
        height: `${String(size)}px`,
        objectFit: 'contain',
        display: 'block',
        flexShrink: 0,
      }}
    />
  )
}

/** The mark, standing alone beside the product name in the sidebar. */
function WatchSidebarMark({ size }: { readonly size?: number }): ReactNode {
  // The name occupies `sidebar.brand.name` right next to this, so the mark here
  // is decoration and must not be announced a second time.
  return <WatchMark size={size ?? 22} decorative />
}

/** The mark on the conversation hero, where it carries the identity alone. */
function WatchHeroMark({ size }: { readonly size?: number }): ReactNode {
  return <WatchMark size={size ?? 28} />
}

/** The sidebar and hero name. */
function WatchName(): ReactNode {
  return <span title={ATTRIBUTION}>{PRODUCT_NAME}</span>
}

/**
 * The footer attribution.
 *
 * DSH renders `sidebar.footer.action` with a `wide` flag, because the sidebar
 * collapses to a narrow rail. Ignoring it is not a cosmetic mistake: sixty
 * words of legal text reflowed into a 40px column is unreadable, and
 * unreadable attribution is not attribution.
 *
 * So the collapsed rail carries the mark with the full text as its accessible
 * name and tooltip, and the expanded sidebar carries both lines in full. The
 * second line is never dropped — it is what keeps the first from reading as an
 * endorsement that was never given.
 */
function WatchAttribution({ wide }: { readonly wide?: boolean }): ReactNode {
  const full = `${ATTRIBUTION}. ${INDEPENDENCE}`
  if (wide !== true) {
    return (
      <div
        title={full}
        aria-label={full}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '100%', padding: '6px 0', opacity: 0.55,
        }}
      >
        <WatchMark size={18} decorative />
      </div>
    )
  }
  return (
    <div style={{
      fontSize: '11px',
      lineHeight: 1.45,
      color: 'var(--dsw-alias-label-tertiary)',
      padding: '8px 10px',
      // The sidebar is a flex column; without this the text can force the
      // whole rail wider than the layout intends.
      maxWidth: '100%',
      overflowWrap: 'break-word',
    }}
    >
      <div>{ATTRIBUTION}</div>
      <div style={{ marginTop: '2px', opacity: 0.85 }}>{INDEPENDENCE}</div>
    </div>
  )
}

/**
 * The tab icon: the same orca, from the same master.
 *
 * One asset, not a second drawing — a favicon that diverges from the product
 * mark is how a brand ends up with two slightly different logos. Inline for
 * the same reason the mark is inline: it must be right on the first paint of
 * an offline profile, and an icon that needs a fetch is an icon that is
 * sometimes the previous one.
 */
const FAVICON = WATCH_MARK_PNG

/**
 * Claim the document's identity: the tab title and the icon.
 *
 * These cannot be reached the way the visual slots are. The `<title>` and the
 * icon link live in DSH's built HTML shell, which is a published artifact this
 * distribution does not fork — so the product takes its name at runtime, the
 * moment the brand plugin loads. The static title is only ever the value
 * before hydration.
 *
 * The title is re-asserted on mutation because DSH's session layer writes the
 * document title too. Without that, opening a session would quietly hand the
 * tab back to the foundation's name.
 */
function claimDocumentIdentity(): () => void {
  if (typeof document === 'undefined') return () => {}

  const restoreTitle = document.title
  const apply = (): void => {
    if (document.title !== PRODUCT_NAME && !document.title.endsWith(` · ${PRODUCT_NAME}`)) {
      document.title = document.title === '' || document.title === restoreTitle
        ? PRODUCT_NAME
        : `${document.title} · ${PRODUCT_NAME}`
    }
  }
  apply()

  const observer = new MutationObserver(apply)
  const titleElement = document.querySelector('title')
  if (titleElement !== null) observer.observe(titleElement, { childList: true })

  let icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  const previousHref = icon?.getAttribute('href') ?? null
  if (icon === null) {
    icon = document.createElement('link')
    icon.setAttribute('rel', 'icon')
    document.head.append(icon)
  }
  // The master is a PNG. Declaring svg+xml here would have the browser
  // refuse the icon it was just handed.
  icon.setAttribute('type', 'image/png')
  icon.setAttribute('href', FAVICON)

  return () => {
    observer.disconnect()
    document.title = restoreTitle
    if (previousHref !== null) icon?.setAttribute('href', previousHref)
  }
}

/** Occupy the generic brand slots with the Watch identity. */
export function apply(ctx: Context): void {
  ctx.effect(claimDocumentIdentity)

  const slots = (ctx as unknown as {
    slots: {
      inject(name: string, register: () => void): void
      register(entry: Record<string, unknown>, component: unknown): void
    }
  }).slots

  const occupy = (name: string, id: string, component: unknown): void => {
    slots.inject(name, () => { slots.register({ name, id, order: 10 }, component); })
  }

  occupy('sidebar.brand.mark', 'watch-mark', WatchSidebarMark)
  occupy('sidebar.brand.name', 'watch-name', WatchName)
  occupy('conversation.hero.brand.mark', 'watch-hero-mark', WatchHeroMark)
  // The footer is where attribution belongs: present on every screen, and not
  // competing with the work.
  occupy('sidebar.footer.action', 'watch-attribution', WatchAttribution)
}

export { WATCH_MARK_PNG }
export { PRODUCT_SHORT_NAME }
