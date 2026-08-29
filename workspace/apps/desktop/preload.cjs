/**
 * The sandboxed preload entry.
 *
 * CommonJS, and hand-written rather than bundled, because a sandboxed preload
 * runs in a restricted context where only `electron` and a few builtins are
 * requirable. That restriction is the point — it is what makes `sandbox: true`
 * meaningful — so this file is deliberately small enough to read in full.
 *
 * The typed contract lives in `src/preload.ts`, which is what the unit tests
 * exercise. `scripts/verify-desktop-security.mjs` asserts the two agree on the
 * channel set, so this file cannot quietly grow a tenth channel.
 *
 * Nothing here reaches `fs`, `child_process`, `shell` or `process`. A path
 * never crosses this boundary as a string the renderer chose.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('watch', {
  readyState: () => ipcRenderer.invoke('watch:ready-state'),
  openFileDialog: kind => ipcRenderer.invoke('watch:open-file-dialog', kind),
  openFolderDialog: () => ipcRenderer.invoke('watch:open-folder-dialog'),
  capabilities: () => ipcRenderer.invoke('watch:capabilities'),
  requestCapture: kind => ipcRenderer.invoke('watch:request-capture', kind),
  onDeepLink: handler => {
    const listener = (_event, link) => { handler(link) }
    ipcRenderer.on('watch:deep-link', listener)
    return () => { ipcRenderer.removeListener('watch:deep-link', listener) }
  },
  openExternal: url => ipcRenderer.invoke('watch:open-external', url),
  safeMode: () => ipcRenderer.invoke('watch:safe-mode'),
  shutdown: () => ipcRenderer.invoke('watch:shutdown'),
})
