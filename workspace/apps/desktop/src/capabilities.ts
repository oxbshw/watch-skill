/**
 * Native capabilities, and deep links, which are the same problem twice.
 *
 * Both are places where something outside the application asks it to do
 * something. A deep link arrives from the operating system, which got it from
 * a browser, which got it from a page. A permission request arrives from a
 * renderer, which is rendering content somebody else wrote. In both cases the
 * question is the same: did a person ask for this, or did content ask for it?
 *
 * So deep links are parsed into a small closed set of intents and nothing
 * else, capture is requested only in response to something the person invoked,
 * and detection is separated from permission: knowing a camera exists is not
 * the same as being allowed to open it, and asking the OS on startup for every
 * permission the app might one day need is how people learn to click through
 * prompts.
 *
 * @module @deepwatch/desktop/capabilities
 */

import { spawnSync } from 'node:child_process'

// ── deep links ──────────────────────────────────────────────────────────────

/** The scheme the OS routes to this application. */
export const DEEP_LINK_SCHEME = 'watch'

/** What a deep link may ask for. Deliberately short. */
export type DeepLinkIntent =
  /** Open a selection: a record, an evidence id, a moment. */
  | 'open_selection'
  /** Open one library source. */
  | 'open_source'
  /** Open a memory. */
  | 'open_memory'
  /** Open a comparison. */
  | 'open_comparison'

/** A parsed, validated deep link. */
export interface DeepLink {
  readonly intent: DeepLinkIntent
  readonly workspaceId: string
  readonly sessionId: string | null
  readonly params: Readonly<Record<string, string>>
}

/** Why a deep link was refused. */
export interface DeepLinkRefusal {
  readonly reason: string
}

/** Identifiers are opaque and bounded; anything else is not an identifier. */
const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/

/**
 * Parse a deep link, or refuse it.
 *
 * Everything here is a refusal by default. The scheme must match, the intent
 * must be one of four, every identifier must look like an identifier, and
 * nothing is passed through uninspected — because a deep link is a string a
 * web page chose, and the only safe way to treat one is as a request to look
 * something up.
 *
 * Note what a deep link cannot express: no file path, no command, no URL, no
 * setting. An intent set that could carry any of those would be an intent set
 * a page could aim.
 */
export function parseDeepLink(raw: string): DeepLink | DeepLinkRefusal {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { reason: 'Not a URL.' }
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return { reason: `Only ${DEEP_LINK_SCHEME}: links are handled.` }
  }

  const intent = url.hostname === '' ? url.pathname.replace(/^\/+/, '') : url.hostname
  const known: readonly DeepLinkIntent[] = [
    'open_selection', 'open_source', 'open_memory', 'open_comparison',
  ]
  if (!known.includes(intent as DeepLinkIntent)) {
    return { reason: `Unknown intent ${JSON.stringify(intent)}.` }
  }

  const params: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    if (!ID_PATTERN.test(key)) return { reason: `Malformed parameter name ${JSON.stringify(key)}.` }
    if (!ID_PATTERN.test(value)) {
      return { reason: `Parameter ${key} is not an identifier.` }
    }
    params[key] = value
  }

  const workspaceId = params['workspace']
  if (workspaceId === undefined) return { reason: 'No workspace named.' }

  return {
    intent: intent as DeepLinkIntent,
    workspaceId,
    sessionId: params['session'] ?? null,
    params,
  }
}

/** Whether a parse produced a link. */
export function isDeepLink(value: DeepLink | DeepLinkRefusal): value is DeepLink {
  return 'intent' in value
}

// ── capability detection ────────────────────────────────────────────────────

/** Something the machine may or may not be able to do. */
export type CapabilityId =
  | 'screen_capture'
  | 'window_capture'
  | 'camera'
  | 'microphone'
  | 'browser'
  | 'ffmpeg'
  | 'ocr_engine'
  | 'file_dialog'

/** What was found, and how. */
export interface CapabilityReport {
  readonly id: CapabilityId
  /**
   * Present, absent, or unknown.
   *
   * `unknown` is a real answer and is kept distinct from `absent`: a camera
   * that cannot be enumerated without asking the OS for permission is not a
   * camera that is missing, and reporting it as missing would be a lie the
   * person can disprove by looking at their laptop.
   */
  readonly present: 'yes' | 'no' | 'unknown'
  /** How this was established. Never "detected". */
  readonly method: string
  /** Version or path, when one was found. */
  readonly detail: string
  /** Whether using it will prompt the operating system. */
  readonly promptsOnUse: boolean
}

/** Run a version probe without a shell, and never throw. */
function probe(command: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync(command, [...args], {
      shell: false,
      encoding: 'utf8',
      timeout: 4_000,
      windowsHide: true,
    })
    if (result.status !== 0) return null
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.split(/\r?\n/)[0] ?? ''
  } catch {
    return null
  }
}

/** Detect ffmpeg, which is what most capture actually depends on. */
export function detectFfmpeg(): CapabilityReport {
  const version = probe('ffmpeg', ['-version'])
  return {
    id: 'ffmpeg',
    present: version === null ? 'no' : 'yes',
    method: 'ffmpeg -version',
    detail: version ?? 'not on PATH',
    promptsOnUse: false,
  }
}

/** Detect a browser Watch could drive. */
export function detectBrowser(): CapabilityReport {
  for (const [command, args] of [
    ['chrome', ['--version']],
    ['google-chrome', ['--version']],
    ['chromium', ['--version']],
    ['msedge', ['--version']],
  ] as const) {
    const version = probe(command, [...args])
    if (version !== null) {
      return {
        id: 'browser',
        present: 'yes',
        method: `${command} --version`,
        detail: version,
        promptsOnUse: false,
      }
    }
  }
  return {
    id: 'browser',
    present: 'no',
    method: 'version probe of chrome, chromium and edge',
    detail: 'no browser found on PATH',
    promptsOnUse: false,
  }
}

/**
 * Report the media capabilities without asking for them.
 *
 * Always `unknown`. Enumerating devices requires the permission this is trying
 * to avoid asking for, so the honest answer before the person invokes capture
 * is that nobody looked — which is exactly what `unknown` means.
 */
export function mediaCapabilities(): readonly CapabilityReport[] {
  return (['camera', 'microphone', 'screen_capture', 'window_capture'] as const).map(id => ({
    id,
    present: 'unknown' as const,
    method: 'not probed — enumerating devices requires the permission itself',
    detail: 'Will be established the first time you use it.',
    promptsOnUse: true,
  }))
}

/**
 * Detect a local OCR engine.
 *
 * Probes only the lightweight routes, and deliberately does not probe the
 * DeepSeek engines. Loading one of those executes code fetched from a model
 * repository, which is the entire reason they run in a worker — a startup
 * detector that imported them to see whether they were there would be running
 * the thing the isolation exists to contain.
 *
 * So the answer for a heavy engine is `unknown` until somebody starts its
 * worker deliberately, which is what `OcrWorker.start()` is for.
 */
export function detectOcrEngine(): CapabilityReport {
  const tesseract = probe('tesseract', ['--version'])
  if (tesseract !== null) {
    return {
      id: 'ocr_engine',
      present: 'yes',
      method: 'tesseract --version',
      detail: tesseract,
      promptsOnUse: false,
    }
  }
  // RapidOCR is a Python library rather than a binary, so its presence is a
  // question for the engine rather than for this process.
  return {
    id: 'ocr_engine',
    present: 'unknown',
    method: 'no local OCR binary on PATH; library routes are the engine’s to report',
    detail:
      'Heavier engines are not probed here: loading one executes code from a '
      + 'model repository, which is what the worker exists to contain.',
    promptsOnUse: false,
  }
}

/** Everything the desktop can say about this machine without asking for anything. */
export function detectCapabilities(): readonly CapabilityReport[] {
  return [
    detectFfmpeg(),
    detectBrowser(),
    detectOcrEngine(),
    {
      id: 'file_dialog',
      present: 'yes',
      method: 'provided by the desktop shell',
      detail: '',
      promptsOnUse: false,
    },
    ...mediaCapabilities(),
  ]
}

/**
 * The permission a capability needs, if it needs one.
 *
 * Used to mint the pending intent that the security module's permission
 * handler checks. A capability with no entry here is one that never causes a
 * prompt, and a prompt with no capability behind it is one that gets refused.
 */
export function permissionFor(id: CapabilityId): string | null {
  switch (id) {
    case 'camera':
    case 'microphone':
      return 'media'
    case 'screen_capture':
    case 'window_capture':
      return 'display-capture'
    case 'browser':
    case 'ffmpeg':
    case 'ocr_engine':
    case 'file_dialog':
      return null
  }
}
