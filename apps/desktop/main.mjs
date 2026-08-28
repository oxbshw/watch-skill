/**
 * Watch Desktop — the real application entry.
 *
 * The architecture is §10.1's, unchanged: a sandboxed renderer talking to a
 * local DSH Host over loopback, an Electron main process that owns lifecycle
 * and supervises children, and Watch Core as a child of the Host over stdio
 * (§11.1). There is no second UI. The renderer loads the same DSH Web app the
 * browser does, with the same Watch bundle composed into it — §10.1 is explicit
 * that Desktop is "نفس الـWorkspace، لا UI ثانية".
 *
 * Everything this file decides, it decides by calling the modules the unit
 * tests already cover: `security.js` for the posture and the policies,
 * `supervisor.js` for the child, `startup.js` for the sequence and the
 * preflight, `capabilities.js` for detection and deep links. What is left here
 * is wiring, and the wiring is what `scripts/verify-desktop-security.mjs`
 * checks.
 *
 * One deliberate difference from the shipped renderer: the Content-Security-
 * Policy header is **not** overridden for the Host origin. The DSH web app
 * bootstraps through an inline script in its own HTML, so imposing
 * `script-src 'self'` would stop the application starting. The origin is
 * loopback-only, served by a process this application started and supervises,
 * and every other boundary — sandbox, context isolation, no Node integration,
 * the navigation allowlist, the window-open handler, deny-by-default
 * permissions and IPC sender validation — is enforced exactly as tested. That
 * trade is recorded in docs/release-candidate-audit.md rather than left
 * implicit here.
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'

/**
 * The product name, restated here rather than imported.
 *
 * `main.mjs` runs in the Electron main process before any workspace package is
 * resolvable, so it cannot import the brand module the renderer uses. The
 * value is asserted identical by a test, which is the part that keeps two
 * copies from drifting.
 */
const PRODUCT_NAME = 'Watch Workspace'

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'

import {
  RENDERER_PREFERENCES,
  decidePermission,
  isPreloadChannel,
  isTrustedSender,
  mayNavigate,
  mayOpenExternally,
  navigationPolicy,
} from './lib/security.js'
import { SupervisedChild, safeModeReason, shouldEnterSafeMode } from './lib/supervisor.js'
import {
  advance,
  describeReadiness,
  halt,
  initialReadiness,
  migrationPreflight,
  prepareAppData,
  stampSchemaVersion,
} from './lib/startup.js'
import { detectCapabilities, isDeepLink, parseDeepLink, permissionFor } from './lib/capabilities.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The window and taskbar icon.
 *
 * Resolved from the brand package's derived assets rather than copied into
 * this app, so a change to the master reaches the Desktop window through the
 * same generator as every other surface. Missing is survivable — Electron
 * falls back to its default — so a broken path must not stop the app booting.
 */
const WINDOW_ICON = (() => {
  const candidate = join(
    HERE, '..', '..', 'packages', 'watch', 'brand', 'assets', 'watch-orca.ico',
  )
  return existsSync(candidate) ? candidate : undefined
})()

/**
 * Where the profile lives, where to log, and where state is kept.
 *
 * Derived from Electron's own paths rather than written down. These used to
 * default to a directory on the machine this was developed on, which worked
 * perfectly here and would have sent the app looking for a drive that does not
 * exist on anybody else's computer — the worst place for a defect to first
 * appear.
 *
 * `app.getPath` gives the right location per platform: AppData on Windows,
 * ~/Library on macOS, ~/.config on Linux. The environment still overrides all
 * three, which is what the manual-test profile uses.
 */
const APP_DATA = process.env.WATCH_APP_DATA ?? join(app.getPath('userData'), 'workspace')
const DSH_HOME = process.env.WATCH_DSH_HOME ?? join(APP_DATA, 'dsh-home')
const LOG_DIR = process.env.WATCH_LOG_DIR ?? app.getPath('logs')

/** How long a capability the person invoked keeps its permission open. */
const INTENT_TTL_MS = 30_000

const runtime = {
  readiness: initialReadiness(),
  children: [],
  ownedWindowIds: [],
  intents: [],
  hostOrigin: '',
  hostUrl: '',
  window: null,
}

mkdirSync(LOG_DIR, { recursive: true })
const MAIN_LOG = join(LOG_DIR, 'desktop-main.log')

/** One line to the main log, timestamped. */
function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`
  try {
    appendFileSync(MAIN_LOG, entry)
  } catch {
    // A log that cannot be written must not take the application down.
  }
  process.stdout.write(entry)
}

/**
 * The Node that runs the DSH Host.
 *
 * Not `process.execPath`. Inside Electron that is electron.exe, and running the
 * Host through it — even with ELECTRON_RUN_AS_NODE — puts it on Electron's
 * bundled Node 20, which resolves pnpm's symlinked layout differently from the
 * Node 22 the profile was installed with and fails with ERR_MODULE_NOT_FOUND
 * for packages that are plainly present on disk.
 *
 * A shipped build would carry its own Node alongside the Host. For a
 * development and release-candidate launch the system Node is the honest
 * choice, and `WATCH_NODE` overrides it for anyone whose Node is somewhere
 * unusual.
 */
function findNode() {
  const configured = process.env.WATCH_NODE
  if (configured !== undefined && existsSync(configured)) return configured
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    const candidate = join(dir, `node${suffix}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Locate the DSH CLI this build supervises. */
function findCli() {
  for (const dir of [
    join(HERE, '..', '..', 'node_modules', '@deepseek-ai', 'dsh'),
    join(HERE, '..', '..', '..', 'watch-smoke', 'node_modules', '@deepseek-ai', 'dsh'),
  ]) {
    const entry = join(dir, 'lib', 'bin.js')
    if (existsSync(entry)) return entry
  }
  return null
}

/**
 * Start the DSH Host and wait for it to say it is serving.
 *
 * Supervised by the same `SupervisedChild` the tests drive: an owner token in
 * the environment rather than on the command line, a bounded restart budget,
 * and a stop that terminates by handle. The ready pattern is the Host's own
 * "dsh web: <url>" line, which is what it prints once it is listening — not a
 * sleep, and not a port probe that could find somebody else's server.
 */
async function startHost() {
  const cli = findCli()
  if (cli === null) return { ok: false, detail: 'the DSH CLI was not found' }

  const node = findNode()
  if (node === null) {
    return {
      ok: false,
      detail: 'no Node runtime was found on PATH; set WATCH_NODE to one',
    }
  }

  const overlay = join(DSH_HOME, 'watch-manual.patch.yml')
  const args = [
    cli, '--profile', 'web',
    ...(existsSync(overlay) ? ['--patch', overlay] : []),
    '--no-open', '--host', '127.0.0.1',
    // The OS picks the port, per §10.3. A fixed one is a port something else
    // on the machine can already be listening on.
    '--port', '0',
  ]

  let hostUrl = ''
  const child = new SupervisedChild({
    role: 'dsh-host',
    command: node,
    args,
    env: { DSH_HOME },
    // The profile directory, so Node resolves `@watchskill/*` from the
    // packages the profile actually installed rather than from whatever tree
    // the parent happened to be started in. Getting this wrong resolves the
    // plugins from the development workspace when run there, and from nothing
    // at all when run anywhere else.
    cwd: join(DSH_HOME, 'profiles', 'web'),
    readyPattern: /dsh web:\s*http:\/\//,
    startTimeoutMs: 120_000,
    maxRestarts: 2,
    stopGraceMs: 5_000,
  }, {
    onState: status => { log(`host ${status.state}${status.detail === '' ? '' : `: ${status.detail}`}`) },
    onLog: (_role, line) => {
      const match = /dsh web:\s*(http:\/\/\S+)/.exec(line)
      if (match) hostUrl = match[1]
      try {
        appendFileSync(join(LOG_DIR, 'desktop-host.log'), `${line}\n`)
      } catch {
        // See log() above.
      }
    },
  })

  runtime.children.push(child)
  const started = await child.start()
  if (!started.ok) return started
  if (hostUrl === '') return { ok: false, detail: 'the Host reported ready without a URL' }

  runtime.hostUrl = hostUrl
  runtime.hostOrigin = new URL(hostUrl).origin
  return { ok: true, detail: '' }
}

/** Register the IPC handlers, all of which validate their sender. */
function registerIpc() {
  const handle = (channel, handler) => {
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
    hostUrl: runtime.hostUrl,
  }))

  handle('watch:capabilities', () => detectCapabilities())

  handle('watch:open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    return result.canceled ? null : result.filePaths
  })

  handle('watch:open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // The only way a native permission is ever granted: a person did something.
  handle('watch:request-capture', kind => {
    const permission = permissionFor(kind)
    if (permission === null) return { ok: false, error: `Unknown capture kind ${String(kind)}.` }
    runtime.intents.push({ permission, expiresAtMs: Date.now() + INTENT_TTL_MS })
    return { ok: true, permission }
  })

  handle('watch:open-external', async url => {
    if (typeof url !== 'string') return false
    if (!mayOpenExternally(url, navigationPolicy(runtime.hostOrigin))) return false
    await shell.openExternal(url)
    return true
  })

  handle('watch:safe-mode', () => ({
    active: runtime.readiness.mode === 'safe_mode',
    reason: safeModeReason(runtime.children.map(child => child.state())),
  }))

  handle('watch:shutdown', async () => {
    for (const child of runtime.children) await child.stop()
    app.quit()
  })
}

/** Create the one window, with the shipped posture. */
function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: PRODUCT_NAME,
    // The orca, from the brand master. `.ico` rather than a PNG because this is
    // the Windows window and taskbar icon, and Windows wants the multi-size
    // container so it can pick 16px for the taskbar and 256px for Alt-Tab
    // instead of scaling one bitmap badly for both.
    icon: WINDOW_ICON,
    webPreferences: {
      ...RENDERER_PREFERENCES,
      preload: join(HERE, 'preload.cjs'),
    },
  })
  runtime.window = window
  runtime.ownedWindowIds.push(window.webContents.id)

  // Hold the product name against the page.
  //
  // `loadURL` hands the window title to the document, and DSH's built HTML
  // shell carries `<title>DeepSeek Harness</title>` until the Watch brand
  // plugin claims it. Without this the window is briefly, and on a slow start
  // not so briefly, titled after the foundation rather than the product.
  //
  // `setTitle` in the handler would recurse, so the event is simply prevented
  // and the title reasserted only when the page proposes something that is not
  // already a Watch title.
  window.webContents.on('page-title-updated', (event, title) => {
    if (title === PRODUCT_NAME || title.endsWith(` · ${PRODUCT_NAME}`)) return
    event.preventDefault()
    window.setTitle(PRODUCT_NAME)
  })

  const policy = navigationPolicy(runtime.hostOrigin)

  window.webContents.on('will-navigate', (event, url) => {
    if (!mayNavigate(url, policy)) {
      log(`navigation refused: ${url}`)
      event.preventDefault()
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (mayOpenExternally(url, policy)) {
      log(`opening externally: ${url}`)
      void shell.openExternal(url)
    } else {
      log(`window-open refused: ${url}`)
    }
    return { action: 'deny' }
  })

  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    const decision = decidePermission(permission, runtime.intents, Date.now())
    log(`permission ${permission}: ${decision.granted ? 'granted' : 'denied'} — ${decision.reason}`)
    callback(decision.granted)
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer gone: ${details.reason}`)
  })

  window.once('ready-to-show', () => { window.show() })
  return window
}

/** Handle a deep link, refusing anything that is not a lookup. */
function handleDeepLink(raw) {
  const parsed = parseDeepLink(raw)
  if (!isDeepLink(parsed)) {
    log(`deep link refused: ${parsed.reason}`)
    return
  }
  log(`deep link ${parsed.intent} for workspace ${parsed.workspaceId}`)
  runtime.window?.webContents.send('watch:deep-link', parsed)
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    log('another instance holds the lock; exiting')
    app.quit()
    return
  }
  app.on('second-instance', (_event, argv) => {
    const link = argv.find(argument => argument.startsWith('watch://'))
    if (link !== undefined) handleDeepLink(link)
    runtime.window?.focus()
  })

  app.setAsDefaultProtocolClient('watch')
  app.on('open-url', (event, url) => { event.preventDefault(); handleDeepLink(url) })

  await app.whenReady()
  log('electron ready')

  runtime.readiness = advance(runtime.readiness, 'app_data')
  prepareAppData(APP_DATA)

  runtime.readiness = advance(runtime.readiness, 'migration_preflight')
  const migration = migrationPreflight(APP_DATA)
  log(`migration preflight: ${migration.action}${migration.detail === '' ? '' : ` — ${migration.detail}`}`)
  if (migration.action === 'refuse_newer') {
    runtime.readiness = halt(
      runtime.readiness, 'read_only_replay', migration.detail,
      'Update Watch to open this workspace normally. Nothing will be written.',
    )
  } else {
    stampSchemaVersion(APP_DATA)
  }

  runtime.readiness = advance(runtime.readiness, 'bootstrap_secret')
  runtime.readiness = advance(runtime.readiness, 'dsh_host')

  log('starting the DSH Host')
  const host = await startHost()
  if (!host.ok) {
    runtime.readiness = halt(
      runtime.readiness, 'safe_mode', host.detail,
      'Check desktop-host.log, or reinstall the profile with npm run profile:manual.',
    )
    log(`SAFE MODE: ${host.detail}`)
  } else {
    log(`host ready at ${runtime.hostUrl}`)
    runtime.readiness = advance(runtime.readiness, 'watch_core')
    runtime.readiness = advance(runtime.readiness, 'bridge_handshake')
  }

  if (shouldEnterSafeMode(runtime.children.map(child => child.state()))) {
    runtime.readiness = halt(
      runtime.readiness, 'safe_mode',
      safeModeReason(runtime.children.map(child => child.state())),
      'Watch opened with the engine disconnected.',
    )
  }

  registerIpc()
  runtime.readiness = advance(runtime.readiness, 'window')
  const window = createWindow()

  if (runtime.readiness.mode === 'safe_mode' || runtime.hostUrl === '') {
    // Safe mode shows the shipped local renderer, which explains the failure
    // rather than opening onto nothing.
    await window.loadFile(join(HERE, 'renderer', 'index.html'))
  } else {
    await window.loadURL(runtime.hostUrl)
    runtime.readiness = advance(runtime.readiness, 'ready')
  }

  log(`WATCH_DESKTOP_READY ${JSON.stringify({
    mode: runtime.readiness.mode,
    step: runtime.readiness.step,
    hostUrl: runtime.hostUrl,
    pid: process.pid,
    appData: APP_DATA,
  })}`)

  const link = process.argv.find(argument => argument.startsWith('watch://'))
  if (link !== undefined) handleDeepLink(link)
}

// Windows and Linux quit with the last window; the children go with it.
app.on('window-all-closed', () => {
  void (async () => {
    for (const child of runtime.children) await child.stop()
    app.quit()
  })()
})

app.on('before-quit', () => { log('shutting down') })

main().catch(error => {
  log(`FATAL ${String(error?.stack ?? error)}`)
  app.exit(1)
})
