/**
 * The Watch product identity, and the one colour rule that matters.
 *
 * Kept as data rather than as markup so the same strings reach the sidebar,
 * the conversation hero, the About panel, the window title and the release
 * notes without four copies drifting apart. Attribution in particular has to
 * be identical everywhere it appears, because it is a legal statement rather
 * than a design element.
 *
 * @module @deepwatch/dsh-client-brand/identity
 */

/** What the product is called. Never "DeepSeek" anything. */
export const PRODUCT_NAME = 'DeepWatch'

/** The short form, for a tab title or a cramped header. */
export const PRODUCT_SHORT_NAME = 'Watch'

/**
 * The document title this product should be showing.
 *
 * The `<title>` belongs to DSH's built HTML shell, which this distribution
 * does not fork, and DSH's session layer rewrites it on every navigation as
 * `<session> — <foundation>`. Left alone that reads
 * `Say hello — DeepSeek Harness · DeepWatch`: two products named in one tab,
 * and the wrong one first.
 *
 * So both names come off before ours goes back on, and ours comes off *first*
 * — the observer that calls this fires on the change this makes, and a version
 * that stripped only the foundation appended a second `· DeepWatch` each time.
 *
 * @param current - the title as it stands right now.
 * @param foundation - the shell's own title, from before hydration.
 */
export function productTitle(current: string, foundation: string): string {
  const ours = ` · ${PRODUCT_NAME}`
  let text = current
  while (text.endsWith(ours)) text = text.slice(0, -ours.length)
  if (foundation !== '') {
    for (const separator of [' — ', ' · ', ' - ', ' | ']) {
      const suffix = `${separator}${foundation}`
      if (text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length)
        break
      }
    }
  }
  return text === '' || text === foundation || text === PRODUCT_NAME
    ? PRODUCT_NAME
    : `${text} · ${PRODUCT_NAME}`
}

/**
 * Attribution to the upstream project.
 *
 * Required, and required to be visible. Watch is built on DeepSeek Harness and
 * says so; the alternative — quietly shipping someone else's foundation — is
 * both wrong and against the MIT notice this distribution inherits.
 */
export const ATTRIBUTION = 'Built on DeepSeek Harness · Powered by Watch Skill'

/**
 * The independence disclosure.
 *
 * Equally required, and for the opposite reason: attribution without it could
 * read as endorsement, and no such endorsement exists.
 */
export const INDEPENDENCE =
  'DeepWatch and Watch Skill are independent projects and are not affiliated with or endorsed by DeepSeek.'

/** One line for a tooltip or an empty state. */
export const TAGLINE =
  'An agent that sees, remembers, and can prove what actually happened.'

/**
 * The status vocabulary, and the tone each one is allowed.
 *
 * This table is the visual half of ADR-002. `success` appears exactly once, on
 * `VERIFIED`, and nothing else in the product may reach it — not a high
 * confidence, not a completed agent turn, not five checks out of six.
 *
 * `caution` covers the honest non-answers. They are deliberately not `error`:
 * styling an unproven result as a failure teaches people to dismiss it, which
 * is how "not proven" quietly becomes "proven".
 */
export type BrandTone = 'success' | 'error' | 'caution' | 'info' | 'active' | 'neutral'

/** Every status the product renders, and the tone it is permitted. */
export const STATUS_TONE = {
  // Verification — the only place `success` is reachable.
  VERIFIED: 'success',
  FAILED: 'error',
  UNVERIFIED: 'caution',
  INCONCLUSIVE: 'caution',
  STALE: 'caution',
  BLOCKED: 'caution',

  // Agent execution — deliberately never `success`. A completed turn is a
  // statement about the agent, not about the world.
  queued: 'neutral',
  running: 'active',
  completed: 'info',
  failed: 'error',
  cancelled: 'neutral',

  // Evidence health.
  current: 'neutral',
  gap: 'caution',
  expired: 'caution',
  unavailable: 'caution',
} as const satisfies Record<string, BrandTone>

/** A status this product knows how to render. */
export type BrandStatus = keyof typeof STATUS_TONE

/**
 * The tone one status is allowed.
 *
 * Anything unrecognized is `neutral`, never `success`. A new status added
 * elsewhere and not registered here renders as unremarkable rather than
 * accidentally as a win.
 */
export function toneFor(status: string): BrandTone {
  return (STATUS_TONE as Record<string, BrandTone>)[status] ?? 'neutral'
}

/** Whether a status may be rendered with the success affordance. */
export function isSuccessTone(status: string): boolean {
  return toneFor(status) === 'success'
}

/**
 * The semantic token a tone maps to.
 *
 * Feature packages ask for a tone and get a CSS variable. They never write a
 * hex value, which is what stops the palette from being re-invented slightly
 * differently in every panel — and what makes a theme change one edit.
 */
export function tokenFor(tone: BrandTone): string {
  return `var(--watch-tone-${tone})`
}
