/**
 * A launch smoke test for the real Electron runtime.
 *
 * It is not a second application. It creates one window with the *shipped*
 * security posture, loads the *shipped* renderer, and then asks the renderer
 * three questions that can only be answered correctly if the sandbox, the
 * context isolation and the preload all actually took effect:
 *
 *   - is `window.watch` there, with exactly the nine operations;
 *   - is `window.require` absent;
 *   - is `window.process` absent.
 *
 * A unit test can assert that `nodeIntegration` is false in an object. Only a
 * real launch can tell you Electron agreed.
 *
 * Usage: node scripts/desktop-smoke.mjs
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')

/** Print one line the runner parses, then leave. */
function finish(result) {
  process.stdout.write(`WATCH_SMOKE ${JSON.stringify(result)}\n`)
  app.exit(result.ok ? 0 : 1)
}

app.on('window-all-closed', () => { app.quit() })

app.whenReady().then(async () => {
  const security = await import(
    new URL('./lib/security.js', `file://${join(__dirname, '/')}`).href
  )

  ipcMain.handle('watch:ready-state', () => ({
    step: 'ready',
    mode: 'normal',
    message: 'Ready.',
  }))

  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      ...security.RENDERER_PREFERENCES,
      preload: join(__dirname, 'preload.cjs'),
    },
  })

  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [security.CONTENT_SECURITY_POLICY],
      },
    })
  })

  const timeout = setTimeout(() => {
    finish({ ok: false, reason: 'the renderer did not answer within 20s' })
  }, 20_000)
  timeout.unref?.()

  try {
    await window.loadFile(join(__dirname, 'renderer', 'index.html'))
    const probe = await window.webContents.executeJavaScript(`(() => ({
      bridge: typeof window.watch,
      operations: window.watch === undefined ? [] : Object.keys(window.watch).sort(),
      hasRequire: typeof window.require !== 'undefined',
      hasProcess: typeof window.process !== 'undefined',
      hasModule: typeof window.module !== 'undefined',
      readyStep: document.querySelector('[data-watch-ready-step]')?.dataset.watchReadyStep ?? null,
    }))()`)

    clearTimeout(timeout)
    const expected = [
      'capabilities', 'onDeepLink', 'openExternal', 'openFileDialog',
      'openFolderDialog', 'readyState', 'requestCapture', 'safeMode', 'shutdown',
    ]
    const problems = []
    if (probe.bridge !== 'object') problems.push('window.watch is not exposed')
    if (JSON.stringify(probe.operations) !== JSON.stringify(expected)) {
      problems.push(`bridge operations are ${JSON.stringify(probe.operations)}`)
    }
    if (probe.hasRequire) problems.push('window.require is reachable from the renderer')
    if (probe.hasProcess) problems.push('window.process is reachable from the renderer')
    if (probe.hasModule) problems.push('window.module is reachable from the renderer')

    finish({
      ok: problems.length === 0,
      problems,
      probe,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    })
  } catch (error) {
    clearTimeout(timeout)
    finish({ ok: false, reason: String(error && error.message ? error.message : error) })
  }
})
