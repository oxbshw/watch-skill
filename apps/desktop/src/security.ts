/**
 * The desktop's security posture, written down as data.
 *
 * Electron's defaults are unsafe for an application that renders content it
 * did not author, and every one of the unsafe defaults is a single property
 * somebody can flip while debugging and forget. Writing the posture as a value
 * — rather than as arguments spread through `new BrowserWindow(...)` — means a
 * test can assert it, and a static gate can prove the main process uses this
 * object rather than a hand-written one.
 *
 * The shape of the threat: a Watch renderer displays observed pages, OCR text,
 * transcripts and imported Markdown. All of that is content authored by
 * somebody else. A renderer with Node integration would turn a line of OCR
 * into a filesystem call, which is not a hypothetical for a product whose
 * entire job is looking at things it did not write.
 *
 * So the renderer gets no Node, no remote module, a sandbox, a strict CSP, a
 * navigation allowlist and a preload surface small enough to read in one
 * sitting. Native permissions are denied by default, and each one is granted
 * only in response to a capability the person actually invoked.
 *
 * @module @watchskill/watch-desktop/security
 */

/**
 * The renderer's web preferences.
 *
 * Frozen, so a caller cannot mutate the shared object and change the posture
 * for every window created afterwards.
 */
export const RENDERER_PREFERENCES = Object.freeze({
  /** No `require` in the renderer. Non-negotiable. */
  nodeIntegration: false,
  /** No Node in a worker either, which is the one people forget. */
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  /** The preload runs in its own world; page script cannot reach its scope. */
  contextIsolation: true,
  /** OS-level sandbox. */
  sandbox: true,
  /** No `@electron/remote`. */
  enableRemoteModule: false,
  /** Same-origin policy stays on; nothing here needs it off. */
  webSecurity: true,
  allowRunningInsecureContent: false,
  /** No `<webview>`: a second renderer with its own settings to get wrong. */
  webviewTag: false,
  /** Spellcheck sends text to a service in some configurations. */
  spellcheck: false,
  /** Background throttling off: a live observation must not stall when hidden. */
  backgroundThrottling: false,
} as const)

/**
 * The Content-Security-Policy the renderer is served under.
 *
 * `'unsafe-inline'` appears for styles only, because the workspace components
 * use inline style objects, and a style attribute cannot execute. No script
 * source is inline, no source is remote, and `connect-src` is loopback only —
 * which is what makes the offline guarantee visible in the renderer as well as
 * in the engine.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Origins the renderer may navigate to.
 *
 * Loopback and the app's own file origin. Everything else opens in the
 * person's browser, if it opens at all — a renderer that can be navigated
 * somewhere is a renderer whose CSP applies to somebody else's page.
 */
export interface NavigationPolicy {
  readonly allowedOrigins: readonly string[]
  /** Schemes an external open may use. */
  readonly externalSchemes: readonly string[]
}

/** The shipped navigation policy. */
export function navigationPolicy(hostOrigin: string): NavigationPolicy {
  return {
    allowedOrigins: [hostOrigin, 'file://'],
    // No `file:` and no custom scheme. Handing a custom scheme to the OS is
    // how a link in observed content becomes a program launch.
    externalSchemes: ['https:'],
  }
}

/** Whether the renderer may navigate to a URL. */
export function mayNavigate(url: string, policy: NavigationPolicy): boolean {
  for (const allowed of policy.allowedOrigins) {
    if (allowed === 'file://' && url.startsWith('file://')) return true
    if (allowed !== 'file://' && url.startsWith(allowed)) return true
  }
  return false
}

/**
 * Whether a URL may be opened outside the app.
 *
 * https only, and never a loopback address. Opening loopback externally would
 * let a page aim the person's browser at a local service — including the DSH
 * Host, whose bootstrap secret is in the URL of nothing, precisely so that
 * cannot matter.
 */
export function mayOpenExternally(url: string, policy: NavigationPolicy): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!policy.externalSchemes.includes(parsed.protocol)) return false
  const host = parsed.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false
  return true
}

/** Native permissions Electron can be asked for. */
export type NativePermission =
  | 'media'
  | 'display-capture'
  | 'geolocation'
  | 'notifications'
  | 'midi'
  | 'midiSysex'
  | 'pointerLock'
  | 'fullscreen'
  | 'openExternal'
  | 'clipboard-read'
  | 'clipboard-sanitized-write'
  | 'hid'
  | 'serial'
  | 'usb'

/**
 * Permissions the app may ever ask the OS for.
 *
 * Everything else is refused without asking. The list is short on purpose: a
 * permission the product never uses is a permission whose prompt would only
 * ever be a surprise, and a surprise prompt is one people click through.
 */
export const REQUESTABLE_PERMISSIONS: readonly NativePermission[] = [
  'media',
  'display-capture',
  'fullscreen',
]

/**
 * A capability the person actually invoked, which is what opens the gate.
 *
 * The important half. Electron's permission handler is asked by the *page*,
 * and a handler that answered from a static allowlist would let observed
 * content trigger a camera prompt. So a request is granted only when it
 * matches something the main process is currently doing on the person's
 * behalf, and the pending intent expires.
 */
export interface PendingIntent {
  readonly permission: NativePermission
  /** Epoch milliseconds after which the intent no longer grants anything. */
  readonly expiresAtMs: number
}

/** Decide one native permission request. */
export function decidePermission(
  permission: string,
  intents: readonly PendingIntent[],
  nowMs: number,
): { readonly granted: boolean; readonly reason: string } {
  if (!REQUESTABLE_PERMISSIONS.includes(permission as NativePermission)) {
    return { granted: false, reason: `${permission} is never requested by this application.` }
  }
  const intent = intents.find(
    candidate => candidate.permission === permission && candidate.expiresAtMs > nowMs)
  if (intent === undefined) {
    return {
      granted: false,
      reason: `${permission} was requested without anyone asking for it in the app.`,
    }
  }
  return { granted: true, reason: `${permission} was requested for an action in progress.` }
}

/**
 * The channels the preload exposes, and nothing else.
 *
 * Enumerated so the gate can assert that the preload's surface is exactly
 * this. Note what is absent: no `invoke(channel, ...)` passthrough, no path
 * argument that reaches `fs`, no command that reaches a shell. Every channel
 * is a named operation whose arguments the main process validates.
 */
export const PRELOAD_CHANNELS = Object.freeze([
  'watch:ready-state',
  'watch:open-file-dialog',
  'watch:open-folder-dialog',
  'watch:capabilities',
  'watch:request-capture',
  'watch:deep-link',
  'watch:open-external',
  'watch:safe-mode',
  'watch:shutdown',
] as const)

/** One channel the preload may carry. */
export type PreloadChannel = typeof PRELOAD_CHANNELS[number]

/** Whether a channel name is one the preload carries. */
export function isPreloadChannel(channel: string): channel is PreloadChannel {
  return (PRELOAD_CHANNELS as readonly string[]).includes(channel)
}

/**
 * Whether an IPC message came from a window this app created.
 *
 * Electron delivers IPC with a sender, and a handler that does not check it
 * will happily serve a frame that was navigated somewhere else. Checking the
 * sender's id against the windows the main process owns is cheap and is the
 * difference between a bridge and an open port.
 */
export function isTrustedSender(
  senderId: number,
  ownedWindowIds: readonly number[],
): boolean {
  return ownedWindowIds.includes(senderId)
}

/** The complete posture, as one value a test can read. */
export interface SecurityPosture {
  readonly preferences: typeof RENDERER_PREFERENCES
  readonly csp: string
  readonly navigation: NavigationPolicy
  readonly requestablePermissions: readonly NativePermission[]
  readonly preloadChannels: readonly PreloadChannel[]
}

/** Build the posture for one host origin. */
export function securityPosture(hostOrigin: string): SecurityPosture {
  return {
    preferences: RENDERER_PREFERENCES,
    csp: CONTENT_SECURITY_POLICY,
    navigation: navigationPolicy(hostOrigin),
    requestablePermissions: REQUESTABLE_PERMISSIONS,
    preloadChannels: PRELOAD_CHANNELS,
  }
}
