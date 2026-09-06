/**
 * The workspace layout, as a contract rather than as markup.
 *
 * Three regions, and each one exists for a reason that is easy to lose:
 *
 * **The sidebar** carries everything that is not about the current session —
 * workspaces, sessions, live, memory, library, saved verification, search —
 * *and DSH's own rows*, which are listed here explicitly rather than left to
 * whatever survives a refactor. Jobs, schedules, plugins and settings are
 * upstream product capabilities the parity register promises to preserve; a
 * shell that quietly dropped them would break that promise in the one place
 * nobody writes a test for.
 *
 * **The session header** answers "what am I looking at, and can I trust it"
 * without scrolling. Model, role bindings, both connections, privacy mode,
 * execution state, verification state, run and cost. The two states are
 * separate fields on purpose: the agent finishing and the world having
 * actually changed are different facts, and a header that showed one number
 * for both would be the product contradicting itself in its own chrome.
 *
 * **The inspector** is where a selection resolves. It never fetches on its own
 * initiative — it renders what the current selection points at — so a panel
 * cannot show a different evidence record than the one that is selected.
 *
 * Keeping all of this as data means the composition is assertable: a test can
 * say "the sidebar still contains DSH's jobs row" without rendering anything.
 *
 * @module @deepwatch/dsh-workspace/shell
 */

import type {
  AgentExecutionState,
  MemoryMode,
  PolicySummary,
  Verdict,
  WatchCoreHealth,
} from '@deepwatch/dsh-contracts'
import type { WorkspaceMode } from './modes.js'

// ── sidebar ─────────────────────────────────────────────────────────────────

/** Where a sidebar row came from, which decides who may remove it. */
export type RowOrigin = 'watch' | 'dsh'

/** One navigable row in the global sidebar. */
export interface SidebarRow {
  readonly id: string
  readonly label: string
  readonly origin: RowOrigin
  /** The mode this row opens, when it opens one. */
  readonly mode: WorkspaceMode | null
  /** Grouping header this row sits under. */
  readonly group: 'workspace' | 'observation' | 'knowledge' | 'operations'
}

/**
 * The rows Watch contributes.
 *
 * Ordered as presented. `saved-verification` is its own row rather than a
 * filter inside Trajectory because a verification somebody chose to keep is a
 * different thing from one that happened to scroll past.
 */
export const WATCH_SIDEBAR_ROWS: readonly SidebarRow[] = [
  { id: 'workspaces', label: 'Workspaces', origin: 'watch', mode: null, group: 'workspace' },
  { id: 'sessions', label: 'Sessions', origin: 'watch', mode: 'agent', group: 'workspace' },
  { id: 'live', label: 'Live', origin: 'watch', mode: 'live', group: 'observation' },
  { id: 'library', label: 'Library', origin: 'watch', mode: 'library', group: 'observation' },
  { id: 'saved-verification', label: 'Saved verification', origin: 'watch', mode: 'trajectory', group: 'observation' },
  { id: 'memory', label: 'Memory', origin: 'watch', mode: 'memory', group: 'knowledge' },
  { id: 'search', label: 'Search', origin: 'watch', mode: 'library', group: 'knowledge' },
]

/**
 * The rows inherited from DeepSeek Harness.
 *
 * Named here so the composition is checkable. These are not re-implemented —
 * the shell renders upstream's own surfaces into these slots — but a shell
 * that stopped offering a way to reach them would have replaced a capability
 * without saying so, which `inventory/parity.yml` exists to forbid.
 */
export const DSH_SIDEBAR_ROWS: readonly SidebarRow[] = [
  { id: 'jobs', label: 'Jobs', origin: 'dsh', mode: null, group: 'operations' },
  { id: 'schedules', label: 'Schedules', origin: 'dsh', mode: null, group: 'operations' },
  { id: 'plugins', label: 'Plugins', origin: 'dsh', mode: null, group: 'operations' },
  { id: 'settings', label: 'Settings', origin: 'dsh', mode: null, group: 'operations' },
]

/** The full sidebar, Watch rows first and upstream's operations last. */
export function sidebarRows(): readonly SidebarRow[] {
  return [...WATCH_SIDEBAR_ROWS, ...DSH_SIDEBAR_ROWS]
}

// ── session header ──────────────────────────────────────────────────────────

/** One binding of a Watch role onto a DSH provider connection. */
export interface RoleBindingSummary {
  readonly role: string
  /** The DSH connection id. Watch never holds a credential of its own. */
  readonly connectionId: string | null
  readonly modelId: string | null
  /** Human-readable, for the header chip. */
  readonly label: string
}

/** Everything the header renders, derived and never stored. */
export interface SessionHeaderState {
  readonly sessionId: string
  /** The agent model DSH is running this session on. */
  readonly agentModel: string | null
  readonly roleBindings: readonly RoleBindingSummary[]
  /** Whether the DSH Host connection is live. */
  readonly dshConnected: boolean
  readonly corePhase: WatchCoreHealth['phase'] | 'not configured'
  readonly privacy: PrivacyChip
  readonly execution: AgentExecutionState
  /**
   * The strongest verdict this session has reached, or null.
   *
   * "Strongest" is not "latest": a FAILED that happened before a later
   * UNVERIFIED still governs, because a proven failure does not stop being one
   * when something else was inconclusive afterwards.
   */
  readonly verification: Verdict | null
  readonly runId: string | null
  /** Cost as DSH reports it. Watch does not compute money. */
  readonly costLabel: string | null
  /**
   * Capabilities that are degraded, by id.
   *
   * Rendered as a single chip rather than seven. A header full of warnings is
   * a header people stop reading.
   */
  readonly degraded: readonly string[]
}

/** The privacy summary the header shows, in the words the policy uses. */
export interface PrivacyChip {
  readonly offlineOnly: boolean
  readonly cloudPerceptionOptIn: boolean
  readonly memoryMode: MemoryMode
  readonly label: string
}

/** Verdict precedence: a proven failure outranks every honest non-answer. */
const VERDICT_RANK: Readonly<Record<Verdict, number>> = {
  FAILED: 5,
  VERIFIED: 4,
  INCONCLUSIVE: 3,
  STALE: 2,
  UNVERIFIED: 1,
  BLOCKED: 0,
}

/**
 * Reduce a session's verdicts to the one the header shows.
 *
 * FAILED wins over VERIFIED deliberately. A session where one thing was proven
 * to have worked and another was proven to have failed is not a session in
 * good standing, and a green header would say it was.
 */
export function headlineVerdict(verdicts: readonly Verdict[]): Verdict | null {
  let best: Verdict | null = null
  for (const verdict of verdicts) {
    if (best === null || VERDICT_RANK[verdict] > VERDICT_RANK[best]) best = verdict
  }
  return best
}

/** Render the privacy policy summary into the header's one line. */
export function privacyChip(policy: PolicySummary | null): PrivacyChip {
  if (policy === null) {
    return {
      offlineOnly: false,
      cloudPerceptionOptIn: false,
      memoryMode: 'off',
      label: 'Privacy unknown — no engine connected',
    }
  }
  const parts: string[] = []
  parts.push(policy.offlineOnly ? 'Offline only' : 'Network permitted')
  if (policy.cloudPerceptionOptIn) parts.push('cloud perception on')
  parts.push(`memory ${policy.memoryMode.replace(/_/g, ' ')}`)
  return {
    offlineOnly: policy.offlineOnly,
    cloudPerceptionOptIn: policy.cloudPerceptionOptIn,
    memoryMode: policy.memoryMode,
    label: parts.join(' · '),
  }
}

/** What the header is built from. */
export interface HeaderInput {
  readonly sessionId: string
  readonly agentModel: string | null
  readonly roleBindings: readonly RoleBindingSummary[]
  readonly dshConnected: boolean
  readonly health: WatchCoreHealth | null
  readonly execution: AgentExecutionState
  readonly verdicts: readonly Verdict[]
  readonly runId: string | null
  readonly costLabel: string | null
  readonly degraded: readonly string[]
}

/** Derive the header. Pure, so the same session always renders the same chrome. */
export function sessionHeader(input: HeaderInput): SessionHeaderState {
  return {
    sessionId: input.sessionId,
    agentModel: input.agentModel,
    roleBindings: input.roleBindings,
    dshConnected: input.dshConnected,
    corePhase: input.health?.phase ?? 'not configured',
    privacy: privacyChip(input.health?.handshake?.policy ?? null),
    execution: input.execution,
    verification: headlineVerdict(input.verdicts),
    runId: input.runId,
    costLabel: input.costLabel,
    degraded: input.degraded,
  }
}

// ── inspector ───────────────────────────────────────────────────────────────

/** The inspector panels, in tab order. */
export type InspectorPanel =
  | 'evidence'
  | 'verification'
  | 'memory'
  | 'tools'
  | 'files'
  | 'browser'
  | 'network'
  | 'console'
  | 'run'

/** Every inspector panel, in tab order. */
export const INSPECTOR_PANELS: readonly InspectorPanel[] = [
  'evidence', 'verification', 'memory', 'tools', 'files',
  'browser', 'network', 'console', 'run',
]

/** One panel's identity and where its content comes from. */
export interface PanelDescriptor {
  readonly id: InspectorPanel
  readonly label: string
  /**
   * Who owns the data this panel renders.
   *
   * `dsh` panels are upstream's own inspectors, rendered in place. Watch does
   * not reimplement them, and this field is what stops someone doing so by
   * accident and creating a second, subtly different console.
   */
  readonly owner: 'watch' | 'dsh'
}

/** The shipped panel table. */
export const PANEL_DESCRIPTORS: Readonly<Record<InspectorPanel, PanelDescriptor>> = {
  evidence: { id: 'evidence', label: 'Evidence', owner: 'watch' },
  verification: { id: 'verification', label: 'Verification', owner: 'watch' },
  memory: { id: 'memory', label: 'Memory', owner: 'watch' },
  tools: { id: 'tools', label: 'Tools', owner: 'dsh' },
  files: { id: 'files', label: 'Files', owner: 'dsh' },
  browser: { id: 'browser', label: 'Browser', owner: 'watch' },
  network: { id: 'network', label: 'Network', owner: 'dsh' },
  console: { id: 'console', label: 'Console', owner: 'dsh' },
  run: { id: 'run', label: 'Run', owner: 'dsh' },
}

/**
 * Which panel a mode opens on.
 *
 * A default rather than a constraint — every panel stays reachable from every
 * mode, because a selection made in one mode is frequently about something
 * another mode owns.
 */
export function defaultPanel(mode: WorkspaceMode): InspectorPanel {
  switch (mode) {
    case 'watch':
    case 'library':
      return 'evidence'
    case 'memory':
      return 'memory'
    case 'live':
      return 'browser'
    case 'compare':
    case 'trajectory':
      return 'verification'
    case 'agent':
      return 'tools'
  }
}
