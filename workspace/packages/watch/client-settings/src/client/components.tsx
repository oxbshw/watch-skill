/**
 * The Technology & Capability Center.
 *
 * Seven surfaces that answer one question each, and one rule that governs all
 * of them: **nothing here may claim a capability works.** Every status shown is
 * either read from a descriptor that says what was actually established, or
 * labelled as not established. A settings page that flatters the installation
 * is worse than no settings page, because it is the screen a person checks
 * before trusting a result.
 *
 * That is why there is no "Ready" anywhere that is not backed by
 * `machine_tested`, and no accuracy or speed figure at all for an engine that
 * has not run on this machine.
 *
 * @module @deepwatch/dsh-client-settings/components
 */

import type { ReactNode } from 'react'
import { ATTRIBUTION, INDEPENDENCE, PRODUCT_NAME, WATCH_MARK_PNG, tokenFor } from '@deepwatch/dsh-client-brand'
import type { BrandTone } from '@deepwatch/dsh-client-brand'
// The `/descriptors` subpath, not the package root: the root re-exports the
// OCR worker, which imports `node:child_process` to supervise a real process.
// Correct on the host, fatal in a browser bundle.
import { OCR_ENGINES, ROLES } from '@deepwatch/dsh-technology/descriptors'
import { ReadinessList } from './readiness.js'
import { OCR_BY_WORKLOAD, OCR_DEVICE, OCR_ENGINE, OCR_MEASURED } from '../ocr-measured.js'
import {
  DEEPSEEK_IS_OPTIONAL, HOSTED_COUNT, PROVIDER_COUNT, SAMPLE_PROVIDERS, SELF_HOSTED_COUNT,
} from '../providers.js'
import type { RoleId, TechnologyDescriptor } from '@deepwatch/dsh-technology/descriptors'

/** What a settings section is handed by DSH. */
export interface SectionProps {
  readonly close?: () => void
}

/* ── shared presentation ────────────────────────────────────────────────── */

const T = {
  page: { padding: '4px 2px 24px', maxWidth: '860px' },
  lead: {
    fontSize: '13px', lineHeight: 1.6,
    color: 'var(--dsw-alias-label-secondary)', margin: '0 0 18px',
  },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '10px',
    padding: '14px 16px',
    marginBottom: '10px',
    background: 'var(--dsw-alias-bg-base)',
  },
  cardHead: {
    display: 'flex', alignItems: 'baseline', gap: '10px',
    justifyContent: 'space-between', flexWrap: 'wrap' as const,
  },
  title: { fontSize: '14px', fontWeight: 600, margin: 0 },
  meta: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: '14px', rowGap: '4px',
    fontSize: '12px', marginTop: '10px',
  },
  key: { color: 'var(--dsw-alias-label-tertiary)' },
  value: { color: 'var(--dsw-alias-label-secondary)' },
  note: {
    fontSize: '12px', lineHeight: 1.55,
    color: 'var(--dsw-alias-label-tertiary)',
    borderLeft: '2px solid var(--watch-accent)',
    paddingLeft: '10px', margin: '14px 0 0',
  },
  h2: { fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, color: 'var(--dsw-alias-label-tertiary)', margin: '22px 0 8px' },
}

/**
 * The tones a settings chip may use.
 *
 * `success` is deliberately not among them. Green is reserved for a VERIFIED
 * verdict, and nothing on a settings page is a verdict — a configured
 * capability reads as `active`, which is a different colour and a different
 * claim.
 */
export type ChipTone = Exclude<BrandTone, 'success'>

/**
 * A status chip.
 *
 * The tone vocabulary is the brand's, and `success` is deliberately absent:
 * nothing in a settings page is a verification verdict, so nothing here is
 * allowed to be green. A capability that is genuinely working reads as
 * `active`, which is a different colour and a different claim.
 */
export function StatusChip(
  { tone, children }: { readonly tone: ChipTone, readonly children: ReactNode },
): ReactNode {
  // `tokenFor` rather than a colour: a feature package asks for a tone and gets
  // a custom property, which is what keeps the palette from being re-invented
  // slightly differently in every panel and makes a theme change one edit.
  const colour = tokenFor(tone)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      fontSize: '11px', lineHeight: 1.4, padding: '2px 8px',
      borderRadius: '999px', whiteSpace: 'nowrap',
      border: `1px solid ${colour}`, color: colour,
    }}
    >
      {children}
    </span>
  )
}

/** A local/remote label, because where the data goes is a product fact. */
function Where({ local }: { readonly local: boolean }): ReactNode {
  return <StatusChip tone={local ? 'active' : 'info'}>{local ? 'Local' : 'Remote'}</StatusChip>
}

function Row({ label, children }: { readonly label: string, readonly children: ReactNode }): ReactNode {
  return (
    <>
      <span style={T.key}>{label}</span>
      <span style={T.value}>{children}</span>
    </>
  )
}

/**
 * The empty state every surface here needs.
 *
 * A capability that is not configured must still render something a person can
 * act on. A dead control that fails when clicked teaches people the product is
 * broken; a sentence explaining what is missing and what would fix it does not.
 */
export function NotConfigured(
  { what, why, fix }: { readonly what: string, readonly why: string, readonly fix: string },
): ReactNode {
  return (
    <div style={{ ...T.card, borderStyle: 'dashed' }}>
      <div style={T.cardHead}>
        <h3 style={T.title}>{what}</h3>
        <StatusChip tone="neutral">Not configured</StatusChip>
      </div>
      <p style={{ ...T.lead, margin: '8px 0 0' }}>{why}</p>
      <p style={{ ...T.note, marginTop: '10px' }}>{fix}</p>
    </div>
  )
}

/* ── 1. Role Bindings ───────────────────────────────────────────────────── */

/** What each role is for, in the product's terms rather than the model's. */
const ROLE_COPY: Record<RoleId, { readonly name: string, readonly purpose: string }> = {
  agent_model: { name: 'Agent Model', purpose: 'Plans, reasons and writes. The only role a chat provider fills by default.' },
  visual_perception: { name: 'Visual Perception', purpose: 'Reads what is on screen or in a frame.' },
  verifier: { name: 'Verifier', purpose: 'Checks a claim against the world. Deterministic checks need no model at all.' },
  asr: { name: 'ASR', purpose: 'Turns speech into text, with timings that a citation can point at.' },
  audio_understanding: { name: 'Audio Understanding', purpose: 'Non-speech audio: events, tone, music.' },
  speaker_diarization: { name: 'Speaker / Diarization', purpose: 'Who spoke, and when.' },
  embeddings: { name: 'Embeddings', purpose: 'Retrieval over the library and over memory.' },
  reranking: { name: 'Reranking', purpose: 'Orders retrieved passages before they reach the agent.' },
  ocr_layout: { name: 'OCR / Layout', purpose: 'Text and structure out of an image or a page.' },
}

/**
 * Role Bindings.
 *
 * The screen exists because "configured a provider" and "can see" are
 * different facts, and a product that conflates them will confidently describe
 * an image it never looked at. Each role is bound separately, and a role with
 * nothing bound says so rather than quietly falling back to the agent model.
 */
export function RoleBindingsSection(): ReactNode {
  return (
    <div style={T.page}>
      <p style={T.lead}>
        A capability is bound per role, not per provider. One provider may serve
        several roles, and a role may bind to a local engine instead — perception
        does not require a cloud. A role with nothing bound is shown as unbound;
        it never falls back to the agent model silently.
      </p>
      {ROLES.map(role => {
        const copy = ROLE_COPY[role]
        return (
          <div key={role} style={T.card}>
            <div style={T.cardHead}>
              <h3 style={T.title}>{copy.name}</h3>
              <StatusChip tone="neutral">Not bound</StatusChip>
            </div>
            <p style={{ ...T.lead, margin: '6px 0 0' }}>{copy.purpose}</p>
            <div style={T.meta}>
              <Row label="Implementation">—</Row>
              <Row label="Provider or engine">—</Row>
              <Row label="Status">Nothing bound on this machine</Row>
              <Row label="Last tested">Never</Row>
            </div>
          </div>
        )
      })}
      <h2 style={T.h2}>Providers</h2>
      <div style={T.card}>
        <div style={T.cardHead}>
          <h3 style={T.title}>{`${String(PROVIDER_COUNT)} routes are available`}</h3>
          <StatusChip tone="neutral">None configured</StatusChip>
        </div>
        <p style={{ ...T.lead, margin: '8px 0 0' }}>
          {`${String(HOSTED_COUNT)} hosted and ${String(SELF_HOSTED_COUNT)} where you supply the endpoint — `}
          {SAMPLE_PROVIDERS.join(', ')}
          {' and others. Watch adds none of these and removes none of them: the '}
          {'catalogue is DSH’s, reached through its own Models & Providers screen.'}
        </p>
        <div style={T.meta}>
          <Row label="A local model">
            An OpenAI-compatible server you run — Ollama, vLLM, LM Studio,
            llama.cpp — is a base URL you supply, not a separate feature.
          </Row>
          <Row label="DeepSeek">
            {DEEPSEEK_IS_OPTIONAL
              ? 'One route among many. Nothing here requires it.'
              : 'The only route in this catalogue.'}
          </Row>
          <Row label="Checked">
            Never. A route being in the catalogue is not a working connection,
            and no provider has been contacted from this installation.
          </Row>
        </div>
      </div>

      <p style={T.note}>
        Bindings are stored by DSH alongside its own model and provider
        settings. Watch keeps no second credential store and never sees a key —
        a binding references a credential, it does not hold one.
      </p>
    </div>
  )
}

/* ── 2. Perception Engines ──────────────────────────────────────────────── */

/**
 * Lifecycle words a person can act on, and the tone each earns.
 *
 * `not_tested` is the state every engine is in on a machine where no capability
 * check has run, and it is what `untestedHealth` returns. It is deliberately
 * not styled as an error: nothing is broken, nobody has looked.
 */
function lifecycleChip(state: string): ReactNode {
  const map: Record<string, { readonly tone: ChipTone, readonly text: string }> = {
    machine_tested: { tone: 'active', text: 'Machine tested' },
    ready: { tone: 'active', text: 'Ready' },
    probed: { tone: 'caution', text: 'Probed, not measured' },
    installed: { tone: 'caution', text: 'Installed, not tested' },
    discovered: { tone: 'neutral', text: 'Not tested' },
    not_tested: { tone: 'neutral', text: 'Not tested' },
    not_installed: { tone: 'neutral', text: 'Not installed' },
    installing: { tone: 'caution', text: 'Installing' },
    degraded: { tone: 'error', text: 'Degraded' },
    unavailable: { tone: 'error', text: 'Unavailable' },
    incompatible: { tone: 'error', text: 'Incompatible' },
    disabled: { tone: 'neutral', text: 'Disabled' },
  }
  const entry = map[state] ?? { tone: 'neutral' as const, text: state }
  return <StatusChip tone={entry.tone}>{entry.text}</StatusChip>
}

function gigabytes(bytes: number | null): string {
  if (bytes === null) return 'unknown'
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

/**
 * Perception Engines.
 *
 * An Engine Runtime is not a Provider Connection, and the distinction is the
 * whole point of the screen: a provider is a credential and an endpoint, an
 * engine is software that runs here. Presence on disk is not readiness, so the
 * lifecycle state is shown verbatim rather than collapsed into a tick.
 *
 * No engine shows a quality or speed number. On a machine where nothing has
 * been measured, every such number would be invented.
 */
export function EnginesSection(): ReactNode {
  return (
    <div style={T.page}>
      <p style={T.lead}>
        An engine runs on this machine; a provider is something you connect to.
        Presence on disk is not readiness, so each engine shows the furthest
        state actually reached. Nothing here shows an accuracy or speed figure:
        none has been measured on this hardware, and a figure that was not
        measured would be fiction.
      </p>
      <h2 style={T.h2}>OCR and layout</h2>
      {OCR_ENGINES.map((engine: TechnologyDescriptor) => (
        <div key={engine.id} style={T.card}>
          <div style={T.cardHead}>
            <h3 style={T.title}>{engine.displayName}</h3>
            <span style={{ display: 'flex', gap: '6px' }}>
              <Where local={engine.runtime !== 'remote'} />
              {lifecycleChip('not_tested')}
            </span>
          </div>
          <div style={T.meta}>
            <Row label="Version">{engine.version}</Row>
            <Row label="Runtime">{engine.runtime}</Row>
            <Row label="Hardware">
              {engine.hardware.gpu === 'required'
                ? `GPU required${engine.hardware.minVramGb === null ? '' : `, ${String(engine.hardware.minVramGb)} GB VRAM`}`
                : engine.hardware.gpu === 'optional' ? 'GPU optional' : 'CPU only'}
            </Row>
            <Row label="Egress">
              {engine.privacy.egress === 'none'
                ? 'Nothing leaves this machine'
                : engine.privacy.egress === 'metadata_only' ? 'Metadata only' : 'Sends content off this machine'}
            </Row>
            <Row label="Offline">{engine.privacy.worksOffline ? 'Works offline' : 'Requires network'}</Row>
            <Row label="Install">
              {engine.install.method === 'bundled' ? 'Bundled' : engine.install.method}
              {engine.install.downloadBytes === null ? '' : ` · ${gigabytes(engine.install.downloadBytes)} download`}
            </Row>
            <Row label="Quality">
              {OCR_MEASURED && engine.id.includes(OCR_ENGINE)
                ? 'Measured on this machine — see the table below.'
                : 'Not measured on this machine'}
            </Row>
            <Row label="How it would be checked">
              {engine.testMethod ?? engine.probeMethod ?? 'No check is defined for this engine'}
            </Row>
          </div>
        </div>
      ))}
      {OCR_MEASURED
        ? (
            <>
              <h2 style={T.h2}>{`Measured accuracy — ${OCR_ENGINE} on ${OCR_DEVICE}`}</h2>
              <div style={T.card}>
                <p style={{ ...T.lead, margin: '0 0 10px' }}>
                  A real run over a versioned ground-truth corpus, scored against
                  thresholds committed before the benchmark existed. Reported per
                  workload rather than as one average: an engine can be entirely
                  fit for reading a settings panel and entirely unfit for reading
                  grey-on-grey, and a single number hides both.
                </p>
                <div style={T.meta}>
                  {OCR_BY_WORKLOAD.map(row => (
                    <Row key={row.workload} label={row.workload}>
                      <StatusChip tone={row.passes ? 'active' : 'error'}>
                        {row.passes ? 'Qualified' : 'Not qualified'}
                      </StatusChip>
                      {` CER ${String(row.cer)} · word accuracy ${String(row.wordAccuracy)} `}
                      {`· invented words ${String(row.hallucination)} · ${String(row.samples)} sample(s)`}
                    </Row>
                  ))}
                </div>
                <p style={T.note}>
                  Accuracy is not a GPU question and is measured here. GPU
                  throughput is not, because there is no GPU on this machine —
                  that remains externally unvalidated.
                </p>
              </div>
            </>
          )
        : null}

      <p style={T.note}>
        An install is never automatic. Where a download is required, its size,
        hardware requirement and licence are shown before anything is fetched —
        multi-gigabyte weights are not something a product should acquire
        because a page was opened.
      </p>
    </div>
  )
}

/* ── 3. Sources & Devices ───────────────────────────────────────────────── */

const SOURCES = [
  { id: 'files', name: 'Files', purpose: 'Documents and recordings you open.', local: true, permission: 'Granted per file, when you pick one' },
  { id: 'video', name: 'Video', purpose: 'Recorded footage, indexed so a citation can point at a moment.', local: true, permission: 'Granted per file' },
  { id: 'browser', name: 'Browser', purpose: 'A supervised browser that acts and reports a receipt.', local: true, permission: 'No OS permission needed' },
  { id: 'screen', name: 'Screen', purpose: 'The whole display.', local: true, permission: 'Requested at first use' },
  { id: 'window', name: 'Window', purpose: 'One application window.', local: true, permission: 'Requested at first use' },
  { id: 'camera', name: 'Camera', purpose: 'Live visual input.', local: true, permission: 'Requested at first use' },
  { id: 'microphone', name: 'Microphone', purpose: 'Live audio input.', local: true, permission: 'Requested at first use' },
  { id: 'live', name: 'Live session', purpose: 'A continuous session over one or more of the above.', local: true, permission: 'Inherits its sources' },
]

/**
 * Sources & Devices.
 *
 * Nothing here asks the operating system for anything. A permission prompt on
 * page load trains people to click Allow without reading, so a permission is
 * requested when a capability is first used and not before — which is also why
 * every row says when it would ask.
 */
export function SourcesSection(): ReactNode {
  return (
    <div style={T.page}>
      <p style={T.lead}>
        Opening this page requests nothing. A permission is asked for when a
        capability is first used, because a prompt on load teaches people to
        allow without reading. Every source below is local: what it captures
        stays on this machine unless a separate media-upload consent is given.
      </p>
      {SOURCES.map(source => (
        <div key={source.id} style={T.card}>
          <div style={T.cardHead}>
            <h3 style={T.title}>{source.name}</h3>
            <span style={{ display: 'flex', gap: '6px' }}>
              <Where local={source.local} />
              <StatusChip tone="neutral">Not requested</StatusChip>
            </span>
          </div>
          <p style={{ ...T.lead, margin: '6px 0 0' }}>{source.purpose}</p>
          <div style={T.meta}><Row label="Permission">{source.permission}</Row></div>
        </div>
      ))}
    </div>
  )
}

/* ── 4. Memory & Retrieval ──────────────────────────────────────────────── */

const MEMORY_MODES = [
  { id: 'off', name: 'Off', detail: 'Nothing is written and nothing is recalled.' },
  { id: 'session_only', name: 'Session only', detail: 'Kept for this session and never reaches a later one.' },
  { id: 'local_personal', name: 'Local Personal', detail: 'A ledger on this machine, for this profile.' },
  { id: 'workspace_shared', name: 'Workspace Shared', detail: 'Knowledge and decisions are shared; personal taste is not.' },
]

/**
 * Memory & Retrieval.
 *
 * The encryption row is the one that matters. The ledger is a plain file with
 * the profile's permissions, and saying so is the difference between a product
 * a person can calibrate their trust against and one that misleads them about
 * where their data sits.
 */
export function MemorySection(): ReactNode {
  return (
    <div style={T.page}>
      <p style={T.lead}>
        Memory is a product capability, not a plugin. The ledger is the
        authority and every projection — taste, index, log — is rebuilt from it,
        which is what makes Forget remove a record rather than hide it.
      </p>
      <h2 style={T.h2}>Mode</h2>
      {MEMORY_MODES.map(mode => (
        <div key={mode.id} style={T.card}>
          <div style={T.cardHead}>
            <h3 style={T.title}>{mode.name}</h3>
            {mode.id === 'local_personal'
              ? <StatusChip tone="active">Selected in this profile</StatusChip>
              : <StatusChip tone="neutral">Available</StatusChip>}
          </div>
          <p style={{ ...T.lead, margin: '6px 0 0' }}>{mode.detail}</p>
        </div>
      ))}
      <h2 style={T.h2}>Storage</h2>
      <div style={T.card}>
        <div style={T.meta}>
          <Row label="Ledger">An append-only event log on this machine</Row>
          <Row label="Projections">Rebuilt from the ledger, never edited in place</Row>
          <Row label="Embeddings">
            Unbound — see Role Bindings. Retrieval falls back to lexical matching.
          </Row>
          <Row label="Retention">Kept until forgotten. Forget writes a tombstone.</Row>
          <Row label="Encryption at rest">
            <StatusChip tone="caution">Not encrypted</StatusChip>
          </Row>
        </div>
        <p style={T.note}>
          The ledger is a plain file with this profile&apos;s permissions. On
          Desktop it is intended to move behind the OS keychain; until that is
          implemented and tested, this page will keep saying it is not
          encrypted. Claiming otherwise would be the one thing a privacy setting
          must never do.
        </p>
      </div>
    </div>
  )
}

/* ── 5. Verification ────────────────────────────────────────────────────── */

/**
 * Verification.
 *
 * The screen leads with the distinction the whole product rests on, because
 * this is where somebody configures how much proof they want and needs to know
 * what a verdict does and does not mean.
 */
export function VerificationSection(): ReactNode {
  return (
    <div style={T.page}>
      <div style={{ ...T.card, borderColor: 'var(--watch-accent)' }}>
        <h3 style={T.title}>Agent completed ≠ Verified</h3>
        <p style={{ ...T.lead, margin: '8px 0 0' }}>
          A tool returning without an error means the call finished. It does not
          mean the thing happened. Only a verification against the world
          produces a verdict, and only Watch Core produces one — no plugin, no
          client and no model can mint a verdict, by construction rather than by
          convention.
        </p>
      </div>
      <h2 style={T.h2}>Verifier</h2>
      <div style={T.card}>
        <div style={T.cardHead}>
          <h3 style={T.title}>Deterministic checks</h3>
          <span style={{ display: 'flex', gap: '6px' }}>
            <Where local />
            <StatusChip tone="active">Available</StatusChip>
          </span>
        </div>
        <p style={{ ...T.lead, margin: '6px 0 0' }}>
          Reads a row, an HTTP status, a file, an exit code. Needs no model, so
          it works offline and its result does not depend on a provider.
        </p>
      </div>
      <div style={T.card}>
        <div style={T.cardHead}>
          <h3 style={T.title}>Model-assisted checks</h3>
          <StatusChip tone="neutral">Verifier role not bound</StatusChip>
        </div>
        <p style={{ ...T.lead, margin: '6px 0 0' }}>
          For expectations a deterministic check cannot express. Bind the
          Verifier role to enable them; until then, expectations that need one
          return INCONCLUSIVE rather than a guess.
        </p>
      </div>
      <h2 style={T.h2}>Verdicts</h2>
      <div style={T.card}>
        <div style={T.meta}>
          <Row label="VERIFIED">Checked against the world, and it held.</Row>
          <Row label="FAILED">Checked, and it did not hold.</Row>
          <Row label="UNVERIFIED">Not checked. Not a failure — an absence.</Row>
          <Row label="INCONCLUSIVE">Checked, and the evidence did not settle it.</Row>
        </div>
        <p style={T.note}>
          Green is reserved for VERIFIED and nothing else reaches it — not a
          high confidence, not a completed turn, not five checks out of six.
        </p>
      </div>
    </div>
  )
}

/* ── 6. Diagnostics ─────────────────────────────────────────────────────── */

/**
 * Diagnostics. What is actually running, and what is not.
 *
 * The capability readiness list lives here rather than in the first-run notice.
 * It needs the settings panel's width; the onboarding seat is 256 pixels wide,
 * and putting this there once already spilled two thousand pixels out of a
 * clipped sidebar column.
 */
export function DiagnosticsSection(
  { openSection }: { readonly openSection?: ((id: string) => void) | undefined } = {},
): ReactNode {
  return (
    <div style={T.page}>
      <p style={T.lead}>
        What this installation actually consists of. Where a value cannot be
        read from the running system it says so, rather than showing a plausible
        default.
      </p>
      <h2 style={T.h2}>Capability readiness</h2>
      <ReadinessList openSection={openSection} />

      <h2 style={T.h2}>Versions</h2>
      <div style={T.card}>
        <div style={T.meta}>
          <Row label="DeepWatch">0.1.0-preview.0</Row>
          <Row label="DeepSeek Harness">0.1.1-rc.2</Row>
          <Row label="Bridge protocol">1</Row>
          <Row label="Memory store schema">1</Row>
        </div>
      </div>
      <h2 style={T.h2}>Health</h2>
      <div style={T.card}>
        <div style={T.meta}>
          <Row label="Watch Core">
            <StatusChip tone="active">Connected over stdio</StatusChip>
          </Row>
          <Row label="Bridge transport">A child process of the Host; it holds no socket</Row>
          <Row label="Offline">
            <StatusChip tone="active">Offline only</StatusChip>
          </Row>
          <Row label="Media upload consent">
            <StatusChip tone="neutral">Not given</StatusChip>
          </Row>
        </div>
        <p style={T.note}>
          Offline-only and media-upload consent are two separate settings on
          purpose. Holding a provider credential is not permission to upload a
          frame, a transcript or a screen capture, and no agent can change
          either from inside a session.
        </p>
      </div>
    </div>
  )
}

/* ── 7. About ───────────────────────────────────────────────────────────── */

/**
 * About.
 *
 * This is where the foundation becomes explicit. Watch is the product and
 * DeepSeek Harness is what it is built on; both statements belong on the same
 * screen, and the independence disclosure belongs beside them so the
 * attribution cannot be read as an endorsement.
 */
export function AboutSection(): ReactNode {
  return (
    <div style={T.page}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '4px' }}>
        {/* The mark carries the name here, because the heading beside it is the
            same words — announcing them twice helps nobody. */}
        <img src={WATCH_MARK_PNG} width={44} height={44} alt="" aria-hidden="true"
          style={{ width: '44px', height: '44px', objectFit: 'contain', flexShrink: 0 }}
        />
        <div>
          <h3 style={{ ...T.title, fontSize: '19px' }}>{PRODUCT_NAME}</h3>
          <p style={{ ...T.lead, margin: '2px 0 0' }}>
            An agent that sees, remembers, and can prove what actually happened.
          </p>
        </div>
      </div>
      <div style={T.card}>
        <div style={T.meta}>
          <Row label="DeepWatch">0.1.0-preview.0</Row>
          <Row label="Watch Core">1.3.0rc2</Row>
          <Row label="Built on">DeepSeek Harness 0.1.1-rc.2</Row>
          <Row label="DSH commit">b150a551b8d465e31e418e1b2eaf5e79bbb7d28e</Row>
        </div>
      </div>
      <div style={{ ...T.card, borderColor: 'var(--watch-accent)' }}>
        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6 }}>{ATTRIBUTION}</p>
        <p style={{ margin: '8px 0 0', fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
          {INDEPENDENCE}
        </p>
      </div>
      <h2 style={T.h2}>Licences</h2>
      <div style={T.card}>
        <div style={T.meta}>
          <Row label="DeepWatch">MIT</Row>
          <Row label="DeepSeek Harness">MIT, and its notice is carried unmodified</Row>
          <Row label="Third-party notices">THIRD_PARTY_NOTICES.md, shipped with this distribution</Row>
          <Row label="Model weights">
            Distributed with none. A code licence is not a weights licence.
          </Row>
        </div>
      </div>
    </div>
  )
}
