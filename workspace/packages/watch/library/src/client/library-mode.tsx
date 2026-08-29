/**
 * The Library mode body.
 *
 * It lives in the package that owns the capability rather than in the workspace
 * shell — the shell provides the scaffold every mode shares, and a mode that
 * also needed something back from its own package made the two depend on each
 * other. TypeScript refused the circular project reference, which was the right
 * answer to the wrong arrangement.
 *
 * @module @watchskill/dsh-library/client/library-mode
 */

import type { ReactNode } from 'react'
import { parseVerdict } from '@watchskill/dsh-contracts'
import { Facts, ModeSurface, Panel, readToolResult } from '@watchskill/dsh-workspace/surface'
import type { ModeViewProps } from '@watchskill/dsh-workspace/surface'
import { LibrarySearch } from './search-view.js'
import type { IndexableRecord } from '../index-store.js'

/** What the Library body needs beyond the standard view props. */
export interface LibraryModeProps extends ModeViewProps {
  /**
   * Records to index.
   *
   * The evidence store stays the source of truth; the index is derived from
   * this and can be thrown away at any time.
   */
  readonly records?: readonly IndexableRecord[]
}

/** The Library mode: everything recorded, searchable locally. */
export function LibraryModeView({ inspect, records = [] }: LibraryModeProps = {}): ReactNode {
  const selected = parseVerdict(readToolResult(inspect))

  return (
    <ModeSurface
      title="Library"
      lead={
        'Every source and every piece of evidence this workspace has recorded. '
        + 'Search runs on this machine — no service, no model, nothing leaves it.'
      }
    >
      {selected === null
        ? null
        : (
            <Panel heading="Selected record">
              <Facts
                rows={[
                  ['Verdict', selected.verdict],
                  ['Reason', selected.reason],
                  ['Checks', String(selected.checks.length)],
                ]}
              />
            </Panel>
          )}

      <LibrarySearch records={records} />
    </ModeSurface>
  )
}
