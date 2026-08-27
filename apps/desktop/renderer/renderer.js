/**
 * The desktop renderer.
 *
 * It mounts the same Workspace packages the web build uses. There is no
 * desktop-specific UI here and there is deliberately nowhere to put one: a
 * second implementation of the shell would drift from the first, and the two
 * would disagree about what a session contains — which is the failure the whole
 * product is built to make impossible.
 *
 * Everything native goes through `window.watch`, the preload's nine named
 * operations. This file has no access to anything else, by construction.
 */

const root = document.getElementById('watch-root')

/** Render the startup state until the shell can take over. */
async function boot() {
  const bridge = window.watch
  if (bridge === undefined) {
    root.textContent = 'Watch could not reach its own bridge. This build is broken.'
    return
  }

  const ready = await bridge.readyState()
  const line = document.createElement('p')
  line.dataset.watchReadyStep = ready.step
  line.dataset.watchReadyMode = ready.mode
  line.textContent = ready.message
  root.append(line)

  // The Workspace packages mount here once the Host reports ready. They are the
  // same modules the web build loads; the desktop supplies the process tree
  // around them and nothing else.
  if (ready.mode === 'normal') {
    root.dataset.watchShell = 'mounting'
  }
}

void boot()
