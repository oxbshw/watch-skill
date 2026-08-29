/**
 * The Memory mode body.
 *
 * `MemoryWorkbench` was registered straight into `conversation.view`, and a
 * view entry is handed `{ inspect, onInspectDone }` and nothing else. Every
 * prop the workbench needs was therefore undefined, `props.cards.length` threw,
 * and React unmounted the subtree -- so the Memory tab selected correctly and
 * opened onto a blank panel, which reads as a broken feature rather than an
 * empty one.
 *
 * This adapts the view props to the workbench, supplies the defaults a fresh
 * profile actually has, and states the mode rather than implying content that
 * has not been recorded.
 *
 * @module @watchskill/dsh-client-memory/client/memory-mode
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { EmptyState, ModeSurface, Note } from '@watchskill/dsh-workspace/surface'
import type { ModeViewProps } from '@watchskill/dsh-workspace/surface'
import { MemoryWorkbench } from './components.js'
import type { MemoryEvent } from '@watchskill/dsh-memory'
import type { MemoryCard, MemoryView } from '../views.js'

/** What the Memory body needs beyond the standard view props. */
export interface MemoryModeProps extends ModeViewProps {
  /** The durable memory mode this profile is in. */
  readonly mode?: 'off' | 'session_only' | 'local_personal' | 'workspace_shared'
  readonly cards?: readonly MemoryCard[]
  readonly events?: readonly MemoryEvent[]
  readonly wiki?: string
}

/**
 * The Memory mode: what is remembered, under which rules.
 *
 * The workbench is only mounted once there is something for it to show. With
 * nothing recorded it would render a row of empty view tabs, which suggests the
 * surface is broken rather than that the ledger is empty.
 */
export function MemoryModeView(
  { mode, cards = [], events = [], wiki }: MemoryModeProps = {},
): ReactNode {
  const [view, setView] = useState<MemoryView>('taste')
  const nothingRecorded = cards.length === 0 && events.length === 0

  return (
    <ModeSurface
      title="Memory"
      lead={
        'Durable memory with provenance on every record. What is kept, and under '
        + 'which rules, is a setting rather than a guess.'
      }
    >
      {nothingRecorded
        ? (
            <EmptyState
              shows="Memories this workspace has recorded, with why each one was kept and what it changed."
              why={
                mode === undefined
                  ? 'Nothing has been recorded yet, or this surface has not been given the ledger.'
                  : mode === 'off'
                    ? 'Durable memory is off in this profile, so nothing is being recorded.'
                    : 'Nothing has been recorded yet.'
              }
              next={
                mode === undefined
                  ? [
                      'Settings → Memory shows which mode this profile is in and what each one keeps.',
                      'Ask the agent to remember something durable about how you work.',
                    ]
                  : mode === 'off'
                    ? [
                        'Turn memory on in Settings → Memory. Off is the shipped default.',
                        'Session-only keeps a memory for the session and forgets it afterwards.',
                      ]
                    : [
                        'Ask the agent to remember something durable about how you work.',
                        'Corrections take precedence over what they replace, and Forget removes rather than hides.',
                      ]
              }
            />
          )
        : (
            <MemoryWorkbench
              mode={mode ?? 'off'}
              view={view}
              cards={cards}
              events={events}
              {...wiki === undefined ? {} : { wiki }}
              onView={setView}
              onOperation={() => { /* operations are issued by the tools, not this surface */ }}
            />
          )}

      <Note>
        The ledger is not encrypted at rest. Memory at rest encryption is not
        implemented, and this surface says so rather than implying otherwise.
      </Note>
    </ModeSurface>
  )
}
