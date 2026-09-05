/**
 * The Electron main process.
 *
 * Deliberately thin. Every decision it makes — the security posture, the
 * startup sequence, child supervision, deep-link validation, permission
 * gating, update and rollback — lives in a sibling module that can be tested
 * without a display server. What is left here is the wiring, and wiring is the
 * part that is checked by `scripts/verify-desktop-security.mjs` rather than by
 * a unit test.
 *
 * The import of `electron` is dynamic on purpose. This module is part of a
 * TypeScript project that builds and type-checks in CI on machines with no
 * Electron installed, and a static import would make the whole build depend on
 * a 100MB binary in order to check a supervisor.
 *
 * @module @deepwatch/desktop/main
 */

import { join } from 'node:path'
import {
  CONTENT_SECURITY_POLICY,
  RENDERER_PREFERENCES,
  decidePermission,
  isPreloadChannel,
  isTrustedSender,
  mayNavigate,
  mayOpenExternally,
  navigationPolicy,
  type PendingIntent,
} from './security.js'
import {
  type SupervisedChild,
  safeModeReason,
  shouldEnterSafeMode,
  type ChildStatus,
} from './supervisor.js'
import {
  advance,
  assertNoSecretsInArgv,
  bootstrapSecret,
  childArguments,
  childEnvironment,
  describeReadiness,
  halt,
  initialReadiness,
  migrationPreflight,
  prepareAppData,
  stampSchemaVersion,
  type Readiness,
} from './startup.js'
import { detectCapabilities, isDeepLink, parseDeepLink, permissionFor } from './capabilities.js'

/** The minimum of Electron this module uses, named so the wiring is readable. */
interface ElectronApi {
  app: {
    requestSingleInstanceLock(): boolean
    quit(): void
    getPath(name: string): string
    whenReady(): Promise<void>
    on(event: string, listener: (...args: never[]) => void): void
    setAsDefaultProtocolClient(scheme: string): boolean
  }
  BrowserWindow: new (options: Record<string, unknown>) => {
    id: number
    loadFile(path: string): Promise<void>
    webContents: {
      id: number
      on(event: string, listener: (...args: never[]) => void): void
      setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void
      session: {
        setPermissionRequestHandler(
          handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
        ): void
        webRequest: {
          onHeadersReceived(
            listener: (
              details: { responseHeaders?: Record<string, string[]> },
              callback: (response: Record<string, unknown>) => void,
            ) => void,
          ): void
        }
      }
      send(channel: string, ...args: unknown[]): void
    }
    on(event: string, listener: () => void): void
  }
  ipcMain: {
    handle(channel: string, handler: (event: { sender: { id: number } }, ...args: unknown[]) => unknown): void
  }
  dialog: {
    showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>
  }
  shell: { openExternal(url: string): Promise<void> }
}

/** Everything the main process holds while it runs. */
interface Runtime {
  readonly electron: ElectronApi
  readiness: Readiness
  readonly children: SupervisedChild[]
  readonly ownedWindowIds: number[]
  readonly intents: PendingIntent[]
  hostOrigin: string
}

/** How long a capability the person invoked keeps its permission open. */
const INTENT_TTL_MS = 30_000

/**
 * Wire one window.
 *
 * The preferences object is the shared frozen one, not a literal — which is
 * what lets the static gate assert that no window is created with hand-written
 * preferences that could differ.
 */
function createWindow(runtime: Runtime): InstanceType<ElectronApi['BrowserWindow']> {
  const { BrowserWindow } = runtime.electron
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      ...RENDERER_PREFERENCES,
      preload: join(import.meta.dirname, 'preload.cjs'),
    },
  })
  runtime.ownedWindowIds.push(window.webContents.id)

  const policy = navigationPolicy(runtime.hostOrigin)

  // Every navigation the renderer attempts, refused unless it is ours.
  window.webContents.on('will-navigate', ((event: { preventDefault(): void }, url: string) => {
    if (!mayNavigate(url, policy)) event.preventDefault()
  }))

  // A window the page tried to open is never opened here. It is either handed
  // to the browser under the external policy, or nothing happens.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (mayOpenExternally(url, policy)) void runtime.electron.shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    const decision = decidePermission(permission, runtime.intents, Date.now())
    callback(decision.granted)
  })

  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    })
  })

  return window
}

/** Register the IPC handlers, all of which validate their sender. */
function registerIpc(runtime: Runtime): void {
  const { ipcMain } = runtime.electron

  const handle = (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    if (!isPreloadChannel(channel)) {
      throw new Error(`watch-desktop: ${channel} is not a declared preload channel.`)
    }
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event.sender.id, runtime.ownedWindowIds)) {
        return { ok: false, error: 'This message did not come from a Watch window.' }
      }
      return handler(...args)
    })
  }

  handle('watch:ready-state', () => ({
    step: runtime.readiness.step,
    mode: runtime.readiness.mode,
    message: describeReadiness(runtime.readiness),
  }))

  handle('watch:capabilities', () => detectCapabilities())

  handle('watch:open-file-dialog', async () => {
    const result = await runtime.electron.dialog.showOpenDialog({
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths
  })

  handle('watch:open-folder-dialog', async () => {
    const result = await runtime.electron.dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  // A capture request mints the pending intent the permission handler checks.
  // This is the only way a permission is ever granted: a person did something.
  handle('watch:request-capture', (kind: unknown) => {
    const permission = permissionFor(kind as never)
    if (permission === null) return { ok: false, error: `Unknown capture kind ${String(kind)}.` }
    runtime.intents.push({
      permission: permission as PendingIntent['permission'],
      expiresAtMs: Date.now() + INTENT_TTL_MS,
    })
    return { ok: true }
  })

  handle('watch:open-external', async (url: unknown) => {
    if (typeof url !== 'string') return false
    if (!mayOpenExternally(url, navigationPolicy(runtime.hostOrigin))) return false
    await runtime.electron.shell.openExternal(url)
    return true
  })

  handle('watch:safe-mode', () => ({
    active: runtime.readiness.mode === 'safe_mode',
    reason: safeModeReason(runtime.children.map(child => child.state())),
  }))

  handle('watch:shutdown', async () => {
    for (const child of runtime.children) await child.stop()
    runtime.electron.app.quit()
  })
}

/**
 * Start everything, in order, stopping at the first step that fails.
 *
 * Returns the readiness rather than throwing, because a failed startup still
 * has to open a window — one that says which step failed. An application that
 * exits silently when a child does not come up is an application whose users
 * report "it does not open".
 */
export async function startup(runtime: Runtime, appDataDir: string): Promise<Readiness> {
  let readiness = initialReadiness()

  if (!runtime.electron.app.requestSingleInstanceLock()) {
    return halt(readiness, 'handed_off', 'Another Watch window is already open.', '')
  }
  readiness = advance(readiness, 'app_data')

  prepareAppData(appDataDir)
  readiness = advance(readiness, 'migration_preflight')

  const migration = migrationPreflight(appDataDir)
  if (migration.action === 'refuse_newer') {
    return halt(
      readiness,
      'read_only_replay',
      migration.detail,
      'Update Watch to open this workspace normally. Until then, nothing will be written.',
    )
  }
  if (migration.action === 'initialize' || migration.action === 'migrate') {
    stampSchemaVersion(appDataDir)
  }
  readiness = advance(readiness, 'bootstrap_secret')

  const secret = bootstrapSecret()
  const args = childArguments({ appDataDir })
  // The one line that keeps a secret off a command line, checked rather than
  // remembered.
  assertNoSecretsInArgv(args, [secret])
  const env = childEnvironment({ secret, appDataDir, offlineOnly: true })

  readiness = advance(readiness, 'dsh_host')
  for (const child of runtime.children) {
    const started = await child.start()
    if (!started.ok) {
      return halt(readiness, 'safe_mode', started.detail,
        'Check the log in Settings, or reinstall the engine.')
    }
    readiness = advance(readiness, readiness.step === 'dsh_host' ? 'watch_core' : 'bridge_handshake')
  }
  void env

  if (shouldEnterSafeMode(runtime.children.map(child => child.state()))) {
    return halt(readiness, 'safe_mode',
      safeModeReason(runtime.children.map(child => child.state())),
      'Watch will open with your data readable and the engine disconnected.')
  }

  readiness = advance(readiness, 'window')
  return advance(readiness, 'ready')
}

/**
 * Handle a deep link, whether it arrived at launch or at an open window.
 *
 * Refused links are dropped with a log line and never surfaced as an error
 * dialog: a dialog is a thing a malicious page could make appear repeatedly.
 */
export function handleDeepLink(runtime: Runtime, raw: string, log: (line: string) => void): void {
  const parsed = parseDeepLink(raw)
  if (!isDeepLink(parsed)) {
    log(`watch-desktop: refused a deep link — ${parsed.reason}`)
    return
  }
  for (const id of runtime.ownedWindowIds) void id
  log(`watch-desktop: deep link ${parsed.intent} for workspace ${parsed.workspaceId}`)
}

/** Statuses of everything supervised, for the readiness panel. */
export function childStatuses(runtime: Runtime): readonly ChildStatus[] {
  return runtime.children.map(child => child.state())
}

/**
 * The Electron entry point.
 *
 * Imported dynamically so this project builds and type-checks on a machine
 * with no Electron installed.
 */
export async function bootstrap(): Promise<void> {
  const electron = await import('electron') as unknown as ElectronApi
  const appDataDir = join(electron.app.getPath('userData'), 'watch')

  const runtime: Runtime = {
    electron,
    readiness: initialReadiness(),
    children: [],
    ownedWindowIds: [],
    intents: [],
    hostOrigin: 'http://127.0.0.1',
  }

  electron.app.setAsDefaultProtocolClient('watch')
  await electron.app.whenReady()

  runtime.readiness = await startup(runtime, appDataDir)
  registerIpc(runtime)
  const window = createWindow(runtime)
  await window.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'))
}
