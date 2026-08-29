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
import type { WatchQueryRemote } from './read-plane.js'

/** What the Library body needs beyond the standard view props. */
export interface LibraryModeProps extends ModeViewProps {
  /**
   * Records to index.
   *
   * The evidence store stays the source of truth; the index is derived from
   * this and can be thrown away at any time.
   */
  readonly records?: readonly IndexableRecord[]
  /**
   * The mounted `ctx.remote.watchQuery` namespace, when there is one.
   *
   * Bound by the registration in `./index.tsx`, because a `conversation.view`
   * entry receives only `{ inspect, onInspectDone }` and cannot reach a
   * service itself. Absent when this body is rendered outside a profile — in a
   * test, or a story — and the search then answers from the local index.
   */
  readonly reads?: WatchQueryRemote | undefined
}

/** The Library mode: everything recorded, and searchable. */
export function LibraryModeView(
  { inspect, records = [], reads }: LibraryModeProps = {},
): ReactNode {
  const selected = parseVerdict(readToolResult(inspect))

  return (
    <ModeSurface
      title="Library"
      lead={
        reads === undefined
          ? 'Every source and every piece of evidence this workspace has recorded. '
          + 'Search runs on this machine — no service, no model, nothing leaves it.'
          : 'Every source and every piece of evidence this workspace has recorded. '
          + 'Search runs on this workspace’s own host — no service, no model, '
          + 'nothing leaves the machine it runs on.'
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

      <LibrarySearch records={records} reads={reads} />
    </ModeSurface>
  )
}
