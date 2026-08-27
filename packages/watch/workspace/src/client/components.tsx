/**
 * The workspace shell, as components.
 *
 * Kept apart from `index.tsx` — which does the slot registration — so that
 * every one of these renders from props alone. That is not tidiness: it is
 * what makes them testable without a browser. `tests/workspace.test.mjs`
 * renders them with `react-dom/server` and asserts on the markup, which is the
 * only gate that catches a degraded mode being drawn as if it worked.
 *
 * Two rendering rules run through all of it.
 *
 * Colour is never the only signal. Every verdict, availability state and gap
 * carries a glyph and a word as well as a tone, because a timeline read on a
 * monochrome screen, at 200% zoom, or by someone who does not distinguish red
 * from green has to say the same thing.
 *
 * Tones come from the brand package's semantic tokens. No hex value appears
 * below. A colour written out here is a colour that gets written out slightly
 * differently in the next panel, and then a theme change misses one of them.
 *
 * @module @watchskill/dsh-workspace/components
 */

import type { ReactNode } from 'react'
import { toneFor, tokenFor } from '@watchskill/dsh-client-brand'
import { needsDirectionIsolation } from '@watchskill/dsh-contracts'
import {
  MODE_DESCRIPTORS,
  WORKSPACE_MODES,
  type ModeState,
  type WorkspaceMode,
} from '../modes.js'
import {
  INSPECTOR_PANELS,
  PANEL_DESCRIPTORS,
  type InspectorPanel,
  type SessionHeaderState,
  type SidebarRow,
} from '../shell.js'
import {
  TIMELINE_LANES,
  type Timeline,
  type TimelineDensity,
  type TimelineEntry,
  type TimelineLane,
} from '../timeline.js'
import {
  GUARDED_AXES,
  describeComposer,
  validate,
  type ComposerConfig,
  type ComposerRefusal,
} from '../composer.js'

/** A tone's colour, as a token reference. */
function colorFor(status: string): string {
  return tokenFor(toneFor(status))
}

/**
 * The non-colour half of a status.
 *
 * Every one is a distinct shape as well as a distinct word, so the difference
 * survives a screenshot in grayscale.
 */
const STATUS_GLYPH: Readonly<Record<string, string>> = {
  VERIFIED: '✓',
  FAILED: '✗',
  UNVERIFIED: '?',
  INCONCLUSIVE: '≈',
  STALE: '⌛',
  BLOCKED: '⊘',
  available: '●',
  degraded: '▲',
  unavailable: '⊘',
}

/** A status badge: glyph, word, tone. Never tone alone. */
export function StatusBadge({ status, label }: {
  readonly status: string
  readonly label?: string
}): ReactNode {
  return (
    <span
      data-watch-status={status}
      style={{
        color: colorFor(status),
        display: 'inline-flex',
        gap: '4px',
        alignItems: 'baseline',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span aria-hidden="true">{STATUS_GLYPH[status] ?? '·'}</span>
      <span>{label ?? status}</span>
    </span>
  )
}

/** Props for {@link Isolated}. */
export interface IsolatedProps {
  /** What kind of thing this is: `path`, `url`, `identifier`, `timestamp`… */
  readonly kind: string
  readonly children: ReactNode
}

/**
 * A span that keeps its own direction inside a paragraph that has another.
 *
 * `needsDirectionIsolation` has existed in the contracts since the i18n work
 * and nothing rendered it, which meant the rule was documented and not
 * enforced. This is the enforcement.
 *
 * The failure it prevents is specific and easy to miss if you do not read the
 * language in question: inside an Arabic sentence, an unisolated `12:30` is
 * reordered by the bidi algorithm into `30:12`, and an unisolated path has its
 * segments reversed. Both look like plausible values. Neither is the value.
 */
export function Isolated({ kind, children }: IsolatedProps): ReactNode {
  if (!needsDirectionIsolation(kind)) {
    return <span dir="auto" data-watch-auto="" data-watch-kind={kind}>{children}</span>
  }
  return (
    <span dir="ltr" data-watch-ltr="" data-watch-kind={kind}>
      {children}
    </span>
  )
}

// ── mode switcher ───────────────────────────────────────────────────────────

/** Props for {@link ModeSwitcher}. */
export interface ModeSwitcherProps {
  readonly active: WorkspaceMode
  readonly states: readonly ModeState[]
  readonly onSelect: (mode: WorkspaceMode) => void
}

/**
 * The mode tabs.
 *
 * An unavailable mode is still rendered and still focusable. It is disabled
 * for activation, carries `aria-disabled` and its reason as the accessible
 * description, and says the reason on the tab. Hiding it would remove the only
 * place a person could learn why the product they were promised is not there.
 */
export function ModeSwitcher({ active, states, onSelect }: ModeSwitcherProps): ReactNode {
  const byId = new Map(states.map(state => [state.id, state]))
  return (
    <div role="tablist" aria-label="Workspace mode" style={{ display: 'flex', gap: '2px' }}>
      {WORKSPACE_MODES.map(mode => {
        const descriptor = MODE_DESCRIPTORS[mode]
        const state = byId.get(mode)
        const availability = state?.availability ?? 'available'
        const blocked = availability === 'unavailable'
        const reasonId = `watch-mode-reason-${mode}`
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            id={`watch-mode-${mode}`}
            aria-selected={active === mode}
            aria-disabled={blocked}
            aria-describedby={state !== undefined && state.reason !== '' ? reasonId : undefined}
            data-watch-mode={mode}
            data-watch-availability={availability}
            onClick={() => { if (!blocked) onSelect(mode) }}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: active === mode
                ? '2px solid var(--watch-amber)'
                : '2px solid transparent',
              color: blocked ? 'var(--watch-tone-neutral)' : 'inherit',
              cursor: blocked ? 'not-allowed' : 'pointer',
              padding: '6px 10px',
              font: 'inherit',
            }}
          >
            <span>{descriptor.label}</span>
            {availability !== 'available' && (
              <span style={{ marginInlineStart: '6px' }}>
                <StatusBadge status={availability} label={availability} />
              </span>
            )}
            {state !== undefined && state.reason !== '' && (
              <span id={reasonId} hidden>{`${state.reason} ${state.fix}`.trim()}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── sidebar ─────────────────────────────────────────────────────────────────

/** Props for {@link Sidebar}. */
export interface SidebarProps {
  readonly rows: readonly SidebarRow[]
  readonly activeRow: string | null
  readonly onSelect: (row: SidebarRow) => void
}

/** The global sidebar, Watch rows and DSH's own operations rows together. */
export function Sidebar({ rows, activeRow, onSelect }: SidebarProps): ReactNode {
  const groups: readonly SidebarRow['group'][] = ['workspace', 'observation', 'knowledge', 'operations']
  const heading: Readonly<Record<SidebarRow['group'], string>> = {
    workspace: 'Workspace',
    observation: 'Observation',
    knowledge: 'Knowledge',
    operations: 'Operations',
  }
  return (
    <nav aria-label="Workspace navigation" data-watch-sidebar="">
      {groups.map(group => {
        const inGroup = rows.filter(row => row.group === group)
        if (inGroup.length === 0) return null
        return (
          <section key={group} aria-labelledby={`watch-sidebar-${group}`}>
            <h2
              id={`watch-sidebar-${group}`}
              style={{ font: 'inherit', fontSize: '11px', color: 'var(--watch-tone-neutral)' }}
            >
              {heading[group]}
            </h2>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {inGroup.map(row => (
                <li key={row.id}>
                  <button
                    type="button"
                    data-watch-row={row.id}
                    data-watch-origin={row.origin}
                    aria-current={activeRow === row.id ? 'page' : undefined}
                    onClick={() => { onSelect(row) }}
                    style={{
                      background: 'none',
                      border: 'none',
                      font: 'inherit',
                      color: 'inherit',
                      cursor: 'pointer',
                      padding: '4px 8px',
                      width: '100%',
                      textAlign: 'start',
                    }}
                  >
                    {row.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </nav>
  )
}

// ── session header ──────────────────────────────────────────────────────────

/** Props for {@link SessionHeaderBar}. */
export interface SessionHeaderProps {
  readonly state: SessionHeaderState
}

/**
 * The session header.
 *
 * Execution state and verification state are two separate chips with two
 * separate labels, and neither is ever rendered in the other's tone. That is
 * the whole point of the row: "the agent finished" and "the world changed"
 * must not be able to look like one fact.
 */
export function SessionHeaderBar({ state }: SessionHeaderProps): ReactNode {
  return (
    <header
      data-watch-session-header=""
      data-watch-session={state.sessionId}
      style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}
    >
      <span data-watch-field="model">
        <Isolated kind="identifier">{state.agentModel ?? 'no model selected'}</Isolated>
      </span>
      <span data-watch-field="roles">
        {state.roleBindings.length === 0
          ? 'no Watch roles bound'
          : state.roleBindings.map(binding => binding.label).join(' · ')}
      </span>
      <span data-watch-field="dsh">
        <StatusBadge
          status={state.dshConnected ? 'current' : 'unavailable'}
          label={state.dshConnected ? 'Host connected' : 'Host disconnected'}
        />
      </span>
      <span data-watch-field="core">
        <StatusBadge
          status={state.corePhase === 'ready' ? 'current' : 'unavailable'}
          label={`Core ${state.corePhase}`}
        />
      </span>
      <span data-watch-field="privacy">{state.privacy.label}</span>
      <span data-watch-field="execution">
        <StatusBadge status={state.execution} label={`agent ${state.execution}`} />
      </span>
      <span data-watch-field="verification">
        {state.verification === null
          ? <StatusBadge status="UNVERIFIED" label="nothing verified" />
          : <StatusBadge status={state.verification} />}
      </span>
      {state.runId !== null && (
        <span data-watch-field="run">
          {'run '}<Isolated kind="identifier">{state.runId}</Isolated>
        </span>
      )}
      {state.costLabel !== null && <span data-watch-field="cost">{state.costLabel}</span>}
      {state.degraded.length > 0 && (
        <span data-watch-field="degraded">
          <StatusBadge
            status="degraded"
            label={`${String(state.degraded.length)} capability degraded`}
          />
        </span>
      )}
    </header>
  )
}

// ── inspector ───────────────────────────────────────────────────────────────

/** Props for {@link InspectorTabs}. */
export interface InspectorTabsProps {
  readonly active: InspectorPanel
  readonly onSelect: (panel: InspectorPanel) => void
  /** Rendered body for the active panel; the shell supplies it. */
  readonly children?: ReactNode
}

/** The right inspector's tab strip and panel region. */
export function InspectorTabs({ active, onSelect, children }: InspectorTabsProps): ReactNode {
  return (
    <aside data-watch-inspector="" aria-label="Inspector">
      <div role="tablist" aria-label="Inspector panel" style={{ display: 'flex', flexWrap: 'wrap' }}>
        {INSPECTOR_PANELS.map(panel => (
          <button
            key={panel}
            type="button"
            role="tab"
            aria-selected={active === panel}
            data-watch-panel={panel}
            data-watch-panel-owner={PANEL_DESCRIPTORS[panel].owner}
            onClick={() => { onSelect(panel) }}
            style={{
              background: 'none',
              border: 'none',
              font: 'inherit',
              color: 'inherit',
              cursor: 'pointer',
              padding: '4px 8px',
              borderBottom: active === panel
                ? '2px solid var(--watch-amber)'
                : '2px solid transparent',
            }}
          >
            {PANEL_DESCRIPTORS[panel].label}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-watch-panel-body={active}>{children}</div>
    </aside>
  )
}

// ── sensory timeline ────────────────────────────────────────────────────────

/** What one lane is called in the interface. */
const LANE_LABEL: Readonly<Record<TimelineLane, string>> = {
  media: 'Media',
  speech: 'Speech',
  ocr: 'On-screen text',
  actions: 'Actions',
  tools: 'Tools',
  network: 'Network',
  errors: 'Errors',
  verdicts: 'Verdicts',
}

/** Props for {@link SensoryTimelineStrip}. */
export interface SensoryTimelineProps {
  readonly timeline: Timeline
  readonly onDensity: (density: TimelineDensity) => void
  readonly onSelect: (entry: TimelineEntry) => void
}

/**
 * The bottom timeline.
 *
 * The accessible alternative is not an afterthought here — the whole thing is
 * a list of lanes, each a list of entries, each a button with a text label.
 * The visual layout is applied over that, rather than the text being generated
 * from a canvas after the fact.
 */
export function SensoryTimelineStrip(
  { timeline, onDensity, onSelect }: SensoryTimelineProps,
): ReactNode {
  const densities: readonly TimelineDensity[] = ['collapsed', 'compact', 'analysis']
  return (
    <section data-watch-timeline="" aria-label="Sensory timeline">
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        {densities.map(density => (
          <button
            key={density}
            type="button"
            aria-pressed={timeline.density === density}
            data-watch-density={density}
            onClick={() => { onDensity(density) }}
            style={{ background: 'none', border: 'none', font: 'inherit', color: 'inherit', cursor: 'pointer' }}
          >
            {density}
          </button>
        ))}
        {timeline.hidden > 0 && (
          <span data-watch-hidden={String(timeline.hidden)}>
            {`${String(timeline.hidden)} hidden at this density`}
          </span>
        )}
      </div>
      {TIMELINE_LANES.filter(lane => timeline.populated.includes(lane)).map(lane => (
        <div key={lane} data-watch-lane={lane}>
          <span style={{ fontSize: '11px', color: 'var(--watch-tone-neutral)' }}>
            {LANE_LABEL[lane]}
          </span>
          <ul style={{ listStyle: 'none', display: 'flex', gap: '4px', margin: 0, padding: 0 }}>
            {timeline.entries.filter(entry => entry.lane === lane).map(entry => (
              <li key={entry.entryId}>
                <button
                  type="button"
                  data-watch-entry={entry.entryId}
                  data-watch-kind={entry.kind}
                  onClick={() => { onSelect(entry) }}
                  style={{
                    background: entry.kind === 'gap' ? 'var(--watch-wash-caution)' : 'none',
                    border: entry.kind === 'gap'
                      ? '1px dashed var(--watch-tone-caution)'
                      : '1px solid transparent',
                    font: 'inherit',
                    color: entry.verdict === null ? 'inherit' : colorFor(entry.verdict),
                    cursor: 'pointer',
                  }}
                >
                  {entry.kind === 'gap' && <span aria-hidden="true">⌇ </span>}
                  {entry.range !== null && (
                    <Isolated kind="timestamp">{`${String(entry.range.startMs)}ms `}</Isolated>
                  )}
                  <span dir="auto" data-watch-auto="">{entry.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

// ── composer ────────────────────────────────────────────────────────────────

/** Props for {@link ComposerPanel}. */
export interface ComposerPanelProps {
  readonly config: ComposerConfig
  /** Refusals from the last agent proposal, when there were any. */
  readonly refusals?: readonly ComposerRefusal[]
}

/**
 * The composer summary and its refusals.
 *
 * A refused agent proposal is *shown*, not swallowed. If the agent asked for
 * the camera and did not get it, the person needs to know that is why the
 * answer is thin — and the refusal is also the fastest path to granting it
 * deliberately.
 */
export function ComposerPanel({ config, refusals }: ComposerPanelProps): ReactNode {
  const problems = validate(config)
  return (
    <section data-watch-composer="" aria-label="Turn configuration">
      <p data-watch-composer-summary="">{describeComposer(config)}</p>
      {problems.length > 0 && (
        <ul data-watch-composer-problems="">
          {problems.map(problem => <li key={problem}>{problem}</li>)}
        </ul>
      )}
      {refusals !== undefined && refusals.length > 0 && (
        <ul data-watch-composer-refusals="" aria-label="Refused agent requests">
          {refusals.map(refusal => (
            <li key={refusal.axis} data-watch-axis={refusal.axis}>
              <StatusBadge status="BLOCKED" label={refusal.message} />
              <span>{` ${refusal.fix}`}</span>
            </li>
          ))}
        </ul>
      )}
      <p hidden data-watch-guarded-axes={GUARDED_AXES.join(',')} />
    </section>
  )
}

// ── the shell ───────────────────────────────────────────────────────────────

/** Props for {@link WorkspaceShell}. */
export interface WorkspaceShellProps {
  readonly sessionId: string
  readonly mode: WorkspaceMode
  readonly modeStates: readonly ModeState[]
  readonly header: SessionHeaderState
  readonly rows: readonly SidebarRow[]
  readonly panel: InspectorPanel
  readonly timeline: Timeline
  readonly composer: ComposerConfig
  readonly onMode: (mode: WorkspaceMode) => void
  readonly onPanel: (panel: InspectorPanel) => void
  readonly onDensity: (density: TimelineDensity) => void
  readonly onEntry: (entry: TimelineEntry) => void
  readonly onRow: (row: SidebarRow) => void
  /** The active mode's own surface. */
  readonly children?: ReactNode
}

/**
 * The whole product, composed.
 *
 * One `data-watch-session` attribute at the root, carrying the session id, and
 * every region inside it. That attribute is not decoration: the test asserts
 * there is exactly one of it, which is the cheapest possible statement of the
 * invariant that the seven modes share one session.
 */
export function WorkspaceShell(props: WorkspaceShellProps): ReactNode {
  return (
    <div data-watch-shell="" data-watch-session={props.sessionId} data-watch-mode={props.mode}>
      <Sidebar
        rows={props.rows}
        activeRow={null}
        onSelect={props.onRow}
      />
      <div>
        <SessionHeaderBar state={props.header} />
        <ModeSwitcher active={props.mode} states={props.modeStates} onSelect={props.onMode} />
        <main data-watch-mode-body={props.mode}>{props.children}</main>
        <ComposerPanel config={props.composer} />
        <SensoryTimelineStrip
          timeline={props.timeline}
          onDensity={props.onDensity}
          onSelect={props.onEntry}
        />
      </div>
      <InspectorTabs active={props.panel} onSelect={props.onPanel} />
    </div>
  )
}
