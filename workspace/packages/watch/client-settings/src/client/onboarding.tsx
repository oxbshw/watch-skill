/**
 * DeepWatch's first-run product surface.
 *
 * The settings.onboarding slot renders from a narrow sidebar seat, so this
 * component owns a real modal. DSH's Modal keeps the focus, Escape and mask
 * behavior; this component only owns the product layout inside it.
 *
 * Both counts come from the same normalized runtime snapshot as Diagnostics.
 * Nothing is shown ready while it loads, and a saved credential is not a
 * successful provider test.
 *
 * @module @deepwatch/dsh-client-settings/onboarding
 */

import type { ReactNode } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconRightUpOutline16,
  IconSettingsOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { PRODUCT_NAME, WATCH_MARK_PNG } from '@deepwatch/dsh-client-brand'
import type { CoreHealthReport } from '@deepwatch/dsh-contracts/query/wire'
import { deriveReadiness } from './readiness.js'
import type { RoleRow } from './binding-state.js'
import css from './onboarding.module.css'

/** What DSH hands an onboarding step. */
export interface OnboardingProps {
  readonly stepId?: string
  readonly complete?: () => void
  readonly openSection?: (id: string) => void
  readonly roles?: readonly RoleRow[]
  readonly health?: CoreHealthReport | null
  readonly reading?: boolean
}

/** A human list that stays useful at zero, one and many items. */
function names(items: readonly { readonly name: string }[]): string {
  if (items.length === 0) return 'None yet'
  if (items.length <= 3) return items.map(item => item.name).join(' · ')
  return items.slice(0, 2).map(item => item.name).join(' · ')
    + ' · +' + String(items.length - 2) + ' more'
}

/** The truthful, intentional first impression of DeepWatch. */
export function WatchOnboarding(
  { complete, openSection, roles, health, reading }: OnboardingProps,
): ReactNode {
  const readiness = deriveReadiness({ roles, health, reading })
  const ready = readiness.filter(item => item.status === 'ready')
  const pending = readiness.filter(item => item.status !== 'ready')
  const finish = (): void => { complete?.() }
  const go = (section: string): void => {
    openSection?.(section)
    finish()
  }

  return (
    <Modal
      open
      title={'Welcome to ' + PRODUCT_NAME}
      onClose={finish}
      headless
      className={css.dialog ?? ''}
    >
      <section className={css.card} aria-labelledby="watch-welcome-title">
        <header className={css.hero}>
          <div className={css.identity}>
            <div className={css.markFrame} aria-hidden="true">
              <img src={WATCH_MARK_PNG} width={58} height={58} alt="" className={css.mark} />
            </div>
            <div className={css.titleBlock}>
              <span className={css.eyebrow}>DEEPWATCH / INTO THE KNOW</span>
              <h2 id="watch-welcome-title" className={css.title}>
                See what happened.<br />
                Prove what worked.
              </h2>
              <p className={css.tagline}>See · Remember · Act · Verify</p>
            </div>
          </div>
          <p className={css.lead}>
            Your local evidence workspace is ready to begin. Connect a model
            when you want conversation; local capabilities need no provider
            and no network.
          </p>
        </header>

        <div className={css.statusSection}>
          <div className={css.statusHeading}>
            <span className={css.eyebrow}>INSTALLATION STATUS</span>
            <span className={css.liveLabel} aria-live="polite">
              <span
                className={[css.liveDot, reading === true ? css.checkingDot : '']
                  .filter(Boolean).join(' ')}
                aria-hidden="true"
              />
              {reading === true ? 'Checking runtime' : 'Runtime checked'}
            </span>
          </div>

          <div className={css.statusGrid} role="group" aria-label="What is ready now">
            <article
              className={[css.metricCard, css.readyCard].filter(Boolean).join(' ')}
              data-watch-readiness="ready"
            >
              <div className={css.metricTop}>
                <span className={css.metricLabel}>
                  <IconCheckOutline16 size={16} />
                  Ready now
                </span>
                <strong className={css.metricValue} data-watch-count>
                  {reading === true ? '—' : ready.length}
                </strong>
              </div>
              <p className={css.metricCopy}>
                {reading === true
                  ? 'Checking this installation. Nothing is assumed ready.'
                  : names(ready) + ' passed ' + (ready.length === 1 ? 'its' : 'their')
                    + ' runtime gates.'}
              </p>
            </article>

            <article className={css.metricCard} data-watch-readiness="pending">
              <div className={css.metricTop}>
                <span className={css.metricLabel}>
                  <IconSettingsOutline16 size={16} />
                  Needs setup
                </span>
                <strong className={css.metricValue} data-watch-count>{pending.length}</strong>
              </div>
              <p className={css.metricCopy}>
                Configure, test or repair these when you need them. Saved is
                never presented as tested.
              </p>
            </article>
          </div>
        </div>

        <div className={css.consent}>
          <span className={css.consentIcon} aria-hidden="true">
            <IconCheckOutline16 size={14} />
          </span>
          <div>
            <strong>Private by default</strong>
            <p>
              Connecting a model does not permit uploading frames, audio,
              transcripts or evidence. Media access is separate and stays off.
            </p>
          </div>
        </div>

        <footer className={css.footer}>
          <Button
            variant="ghost"
            icon={<IconRightUpOutline16 size={16} />}
            onClick={() => { go('watch-diagnostics') }}
          >
            View diagnostics
          </Button>
          <div className={css.primaryActions}>
            <Button variant="outline" onClick={finish}>Explore offline</Button>
            <Button variant="primary" onClick={() => { go('watch-roles') }}>
              Finish setup
            </Button>
          </div>
        </footer>
      </section>
    </Modal>
  )
}
