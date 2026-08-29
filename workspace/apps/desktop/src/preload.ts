/**
 * The preload: the entire surface the renderer can reach.
 *
 * Nine named operations, and every one of them is a request the main process
 * validates. There is deliberately no `invoke(channel, ...args)` passthrough,
 * because a passthrough is not a bridge — it is an open port with a bridge's
 * name on it, and it turns every future main-process handler into part of the
 * renderer's attack surface whether its author intended that or not.
 *
 * Nothing here touches `fs`, `child_process`, `shell` or `process`. A path
 * never crosses this boundary as a string the renderer chose: file dialogs are
 * opened by the main process, and what comes back is a handle.
 *
 * This file runs in the isolated world. It is written to be read in one
 * sitting, because a preload nobody re-reads is where a convenience gets added.
 *
 * @module @watchskill/watch-desktop/preload
 */

import { PRELOAD_CHANNELS, type PreloadChannel } from './security.js'

/** The shape exposed on `window.watch`. */
export interface WatchBridge {
  readyState(): Promise<unknown>
  openFileDialog(kind: 'video' | 'document' | 'any'): Promise<unknown>
  openFolderDialog(): Promise<unknown>
  capabilities(): Promise<unknown>
  requestCapture(kind: 'screen' | 'window' | 'camera' | 'microphone'): Promise<unknown>
  onDeepLink(handler: (link: unknown) => void): () => void
  openExternal(url: string): Promise<boolean>
  safeMode(): Promise<unknown>
  shutdown(): Promise<void>
}

/** The Electron pieces this module needs, injected so it can be tested. */
export interface PreloadRuntime {
  contextBridge: { exposeInMainWorld(key: string, value: unknown): void }
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
    removeListener(channel: string, listener: (...args: unknown[]) => void): void
  }
}

/**
 * Build the bridge.
 *
 * Every channel is written out as a literal at its call site, and there is no
 * shared `invoke(channel, ...)` helper — not even a typed one. A helper would
 * be safe at compile time and would still be the shape a reviewer has to
 * reason about, and `scripts/verify-desktop-security.mjs` refuses it for
 * exactly that reason. Nine repetitive lines are the price of a preload whose
 * surface can be read off the file without following anything.
 */
export function buildBridge(runtime: PreloadRuntime): WatchBridge {
  const ipc = runtime.ipcRenderer
  return {
    readyState: () => ipc.invoke('watch:ready-state'),
    // The renderer names a kind, never a path. What comes back is whatever the
    // main process decided to hand over.
    openFileDialog: kind => ipc.invoke('watch:open-file-dialog', kind),
    openFolderDialog: () => ipc.invoke('watch:open-folder-dialog'),
    capabilities: () => ipc.invoke('watch:capabilities'),
    requestCapture: kind => ipc.invoke('watch:request-capture', kind),
    onDeepLink: handler => {
      const listener = (_event: unknown, link: unknown): void => { handler(link) }
      ipc.on('watch:deep-link', listener)
      return () => { ipc.removeListener('watch:deep-link', listener) }
    },
    // Returns whether it was opened. The main process decides, using the
    // navigation policy; the renderer learns the outcome and nothing else.
    openExternal: url => ipc.invoke('watch:open-external', url) as Promise<boolean>,
    safeMode: () => ipc.invoke('watch:safe-mode'),
    shutdown: () => ipc.invoke('watch:shutdown') as Promise<void>,
  }
}

/** Expose the bridge. Called once, from the preload entry. */
export function exposeBridge(runtime: PreloadRuntime): void {
  runtime.contextBridge.exposeInMainWorld('watch', buildBridge(runtime))
}

/** The channels this preload uses, for the gate that checks they match. */
export const USED_CHANNELS: readonly PreloadChannel[] = PRELOAD_CHANNELS
