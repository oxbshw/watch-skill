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
      style={{ color: 'var(--watch-amber)' }}
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
 * Both lines, always. The second is what keeps the first from reading as an
 * endorsement that was never given.
 */
function WatchAttribution(): ReactNode {
  return (
    <div style={{ fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }}>
      <div>{ATTRIBUTION}</div>
      <div>{INDEPENDENCE}</div>
    </div>
  )
}

/** Occupy the generic brand slots with the Watch identity. */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as {
    slots: {
      inject(name: string, register: () => void): void
      register(entry: Record<string, unknown>, component: unknown): void
    }
  }).slots

  const occupy = (name: string, id: string, component: unknown): void => {
    slots.inject(name, () => slots.register({ name, id, order: 10 }, component))
  }

  occupy('sidebar.brand.mark', 'watch-mark', WatchMark)
  occupy('sidebar.brand.name', 'watch-name', WatchName)
  occupy('conversation.hero.brand.mark', 'watch-hero-mark', WatchMark)
  // The footer is where attribution belongs: present on every screen, and not
  // competing with the work.
  occupy('sidebar.footer.action', 'watch-attribution', WatchAttribution)
}

export { PRODUCT_SHORT_NAME }
