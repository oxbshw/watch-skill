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
import './theme.css'

export * from '../identity.js'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/**
 * The Watch mark.
 *
 * An inline SVG rather than an image: it inherits `currentColor`, so it
 * follows the theme and high-contrast mode without a second asset, and it
 * carries no network request.
 */
function WatchMark(): ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      role="img"
      aria-label={PRODUCT_NAME}
      style={{ color: 'var(--watch-accent)' }}
    >
      {/* An aperture: the product watches, and the ring is what closes on a
          moment. */}
      <circle cx="9" cy="9" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="2.5" fill="currentColor" />
    </svg>
  )
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
        <WatchMark />
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
 * The Watch aperture, as a data URI, for the browser tab.
 *
 * Inline for the same reason the mark is inline: it must be correct on the
 * first paint of an offline profile, and a favicon that needs a network fetch
 * is a favicon that is sometimes the old one.
 */
const FAVICON
  = 'data:image/svg+xml,'
  + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">'
    + '<circle cx="9" cy="9" r="7.25" fill="none" stroke="%234C8DFF" stroke-width="1.6"/>'
    + '<circle cx="9" cy="9" r="2.6" fill="%234C8DFF"/>'
    + '</svg>',
  ).replace(/%23/g, '#').replace(/#/g, '%23')

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
  icon.setAttribute('type', 'image/svg+xml')
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

  occupy('sidebar.brand.mark', 'watch-mark', WatchMark)
  occupy('sidebar.brand.name', 'watch-name', WatchName)
  occupy('conversation.hero.brand.mark', 'watch-hero-mark', WatchMark)
  // The footer is where attribution belongs: present on every screen, and not
  // competing with the work.
  occupy('sidebar.footer.action', 'watch-attribution', WatchAttribution)
}

export { PRODUCT_SHORT_NAME }
