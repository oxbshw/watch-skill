/**
 * Visual QA evidence, captured from the real running application.
 *
 * Run under Electron, which the Desktop app already depends on, so this adds no
 * install and reaches nothing off this machine:
 *
 *   WATCH_QA_URL=… WATCH_QA_OUT=… electron.exe scripts/qa-screenshots.mjs
 *
 * It drives the same loopback Web application a person would open, at two
 * viewport widths, and writes PNGs with `webContents.capturePage()`. Each shot
 * is named for the claim it supports, because a screenshot nobody can tie to an
 * assertion is decoration rather than evidence.
 *
 * Everything is logged to a file rather than stdout. `electron.exe` on Windows
 * is a GUI-subsystem binary: it detaches from the console, so stdout is lost and
 * a failing run looks exactly like a silent one. The log file is the record.
 *
 * Two things it deliberately does not do. It never types a credential, so no
 * capture can leak one. And it never grants a permission — the surfaces that
 * would prompt are photographed in their un-prompted state, which is the state
 * being claimed.
 */

import { app, BrowserWindow } from 'electron'
import { writeFileSync, mkdirSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Configuration comes through the environment, not argv.
//
// Passing extra arguments to `electron.exe` stops it resolving the entry at
// all — the module never parses, nothing is written, and the run is
// indistinguishable from a silent success. Proven with a one-line probe: the
// same script loads with no arguments and does not load with two.
const URL = process.env.WATCH_QA_URL ?? 'http://127.0.0.1:8931'
const OUT = process.env.WATCH_QA_OUT ?? 'G:/watch-manual/qa/screenshots'

/**
 * A session with history, so the mode tabs are actually mounted.
 *
 * Overridable because the id belongs to the manual-test profile rather than to
 * this script; without one the run still captures everything else and simply
 * reports no tabs.
 */
const SESSION_ID = process.env.WATCH_QA_SESSION ?? ''

/** Desktop, and a narrower desktop window — both sizes the product supports. */
const VIEWPORTS = [
  { name: 'wide', width: 1440, height: 900 },
  { name: 'narrow', width: 1024, height: 720 },
]

/**
 * A private Electron profile, claimed before anything else runs.
 *
 * This is the whole fix for a real defect: running the capture used to take the
 * normal Desktop application down with it. Electron implements its
 * single-instance lock as a socket and lock file inside `userData`, and two
 * processes of the same app share that path by default — so a second Electron
 * starting up disturbs the first one's singleton, and quitting the second
 * released state the first still needed.
 *
 * Isolating `userData`, `sessionData` and `cache` gives the capture its own
 * singleton, its own cache and its own storage. It cannot see, signal or
 * disturb the running Desktop, and the running Desktop cannot see it.
 *
 * These must be set before `whenReady`; afterwards Electron has already
 * resolved the paths and the call is silently too late.
 */
const QA_PROFILE = process.env.WATCH_QA_PROFILE
  ?? join(tmpdir(), 'watch-qa-capture-profile')

mkdirSync(QA_PROFILE, { recursive: true })
app.setPath('userData', QA_PROFILE)
app.setPath('sessionData', join(QA_PROFILE, 'session'))
app.setPath('cache', join(QA_PROFILE, 'cache'))

// Deliberately no `requestSingleInstanceLock()`. The capture is not the
// application; it must neither claim the lock nor hand a `second-instance`
// signal to whoever holds it.

const shots = []

function say(line) {
  try {
    mkdirSync(OUT, { recursive: true })
    appendFileSync(join(OUT, 'capture.log'), line + '\n', 'utf8')
  } catch { /* nothing useful to do */ }
}

const wait = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/** Click the first element whose trimmed text matches, and say whether it hit. */
const CLICK_BY_TEXT = `(function (selector, want) {
  var nodes = Array.prototype.slice.call(document.querySelectorAll(selector))
  var hit = nodes.filter(function (n) { return n.textContent.trim() === want })[0]
    || nodes.filter(function (n) { return n.textContent.trim().indexOf(want) === 0 })[0]
  if (hit) { hit.click(); return true }
  return false
})`

/** Geometry that the report can cite, measured rather than eyeballed. */
const MEASURE = `(function () {
  var side = document.querySelector('[class*=sidebarCol]')
  var dialog = document.querySelector('[role="dialog"]')
  var body = document.body
  var cs = getComputedStyle(body)
  var tone = function (n) { return cs.getPropertyValue(n).trim() || '(EMPTY)' }
  return {
    title: document.title,
    docScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    sidebar: side ? {
      w: Math.round(side.getBoundingClientRect().width),
      h: Math.round(side.getBoundingClientRect().height),
      scrollH: side.scrollHeight, clientH: side.clientHeight
    } : null,
    dialog: dialog ? {
      w: Math.round(dialog.getBoundingClientRect().width),
      h: Math.round(dialog.getBoundingClientRect().height)
    } : null,
    tabs: Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'))
      .map(function (t) { return t.textContent.trim() }),
    tokens: {
      accent: tone('--watch-accent'),
      active: tone('--watch-tone-active'),
      success: tone('--watch-tone-success'),
      error: tone('--watch-tone-error'),
      caution: tone('--watch-tone-caution'),
      info: tone('--watch-tone-info'),
      neutral: tone('--watch-tone-neutral')
    },
    marks: Array.prototype.slice.call(document.querySelectorAll('img'))
      .filter(function (i) { return (i.src || '').indexOf('data:image/png') === 0 })
      .map(function (i) {
        var r = i.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height), natural: i.naturalWidth, alt: i.alt }
      })
  }
})()`

async function capture(win, name, note) {
  const image = await win.webContents.capturePage()
  const file = join(OUT, name + '.png')
  writeFileSync(file, image.toPNG())
  shots.push({ name, file, note })
  say('  ' + name.padEnd(38) + ' ' + note)
}

async function measure(win, label) {
  const data = await win.webContents.executeJavaScript(MEASURE)
  say('  [measure] ' + label + ' ' + JSON.stringify(data))
  return data
}

/** What the shipped onboarding steps offer as a way past themselves. */
const DISMISS = ['Continue', 'Configure later', 'Got it', 'Skip', 'Dismiss']

/**
 * Clear every onboarding step, whatever it is called.
 *
 * The steps are a queue — upstream's testing notice, the Watch notice, then
 * DeepSeek's key dialog — and each has its own wording for "not now". Clicking
 * one fixed label leaves the next one on screen, which is how an earlier run
 * photographed the same dialog three times and reported the mode tabs missing
 * when they were merely behind it.
 */
async function clearOnboarding(win, limit = 6) {
  for (let step = 0; step < limit; step += 1) {
    const present = await win.webContents.executeJavaScript(
      "!!document.querySelector('[role=\"dialog\"]')",
    )
    if (!present) return step
    let clicked = false
    for (const label of DISMISS) {
      clicked = await win.webContents.executeJavaScript(
        CLICK_BY_TEXT + "('button', " + JSON.stringify(label) + ')',
      )
      if (clicked) break
    }
    if (!clicked) return step
    await wait(1300)
  }
  return limit
}

async function run(win, viewport) {
  const p = suffix => viewport.name + '-' + suffix

  // One retry: the host is on loopback and a cold profile can be slow enough
  // that the first navigation loses the race.
  try {
    await win.loadURL(URL)
  } catch (error) {
    say('  load retry after: ' + String(error))
    await wait(2500)
    await win.loadURL(URL)
  }
  await wait(4000)

  await capture(win, p('01-onboarding'), 'the Watch first-run notice: orca mark, honest readiness, two ways out')
  await measure(win, 'onboarding')

  const cleared = await clearOnboarding(win)
  say('  cleared ' + String(cleared) + ' onboarding step(s)')
  await wait(1200)
  await capture(win, p('03-workspace'), 'the workspace, entered without configuring any provider')
  await measure(win, 'workspace')

  // Open a session that actually has content.
  //
  // The mode tabs live in the session header, and DSH hides that chrome while
  // the session is blank — `blank && composerPhase === 'blank'`. Clicking a
  // sidebar row that happens to be a fresh empty session therefore produces no
  // tabs and looks exactly like the registrations having failed, which is what
  // an earlier run reported. Selecting a seeded session with history and
  // reloading is deterministic, and the reload is what makes DSH pick it up.
  const opened = await win.webContents.executeJavaScript(`(function () {
    var seeded = ${JSON.stringify(SESSION_ID)}
    if (seeded) {
      localStorage['dsh.sessions.current'] = JSON.stringify({ sessionId: seeded })
      return seeded
    }
    return null
  })()`)
  say('  session: ' + String(opened))
  await win.reload()
  await wait(3200)
  await clearOnboarding(win)
  await wait(2400)
  const session = await measure(win, 'session')
  say('  tabs: ' + JSON.stringify(session.tabs))
  await capture(win, p('04-session-tabs'), 'the seven modes as a native DSH tablist')

  for (const mode of ['Chat', 'Trajectory', 'Watch', 'Live', 'Memory', 'Library', 'Compare']) {
    const ok = await win.webContents.executeJavaScript(
      CLICK_BY_TEXT + "('[role=\"tab\"]', " + JSON.stringify(mode) + ')',
    )
    await wait(1200)
    await capture(win, p('05-mode-' + mode.toLowerCase()), ok ? mode + ' mode' : mode + ' tab NOT FOUND')
  }

  // Settings, and every Watch section in it.
  await win.webContents.executeJavaScript(CLICK_BY_TEXT + "('button', 'Settings')")
  await wait(1600)
  await capture(win, p('06-settings-general'), 'DSH General kept above the Watch sections')

  const sections = [
    ['Role Bindings', 'roles'],
    ['Perception Engi', 'engines'],
    ['Sources & Devic', 'sources'],
    ['Memory & Retrie', 'memory-settings'],
    ['Verification', 'verification'],
    ['Diagnostics', 'diagnostics'],
    ['About', 'about'],
  ]
  for (const [label, slug] of sections) {
    const ok = await win.webContents.executeJavaScript(
      CLICK_BY_TEXT + "('button', " + JSON.stringify(label) + ')',
    )
    await wait(1000)
    await capture(win, p('07-settings-' + slug), ok ? label.trim() + ' section' : label + ' NOT FOUND')
  }

  // Close settings, then collapse the sidebar to photograph the rail.
  await win.webContents.executeJavaScript(`(function () {
    var b = Array.prototype.slice.call(document.querySelectorAll('button'))
      .filter(function (x) { return /close/i.test(x.getAttribute('aria-label') || '') })[0]
    if (b) b.click()
    return !!b
  })()`)
  await wait(900)
  await win.webContents.executeJavaScript(`(function () {
    var b = Array.prototype.slice.call(document.querySelectorAll('button'))
      .filter(function (x) { return /collapse sidebar/i.test(x.getAttribute('aria-label') || '') })[0]
    if (b) b.click()
    return !!b
  })()`)
  await wait(1000)
  await capture(win, p('08-sidebar-collapsed'), 'the collapsed rail: mark visible, attribution not reflowed')
  await measure(win, 'collapsed')
}

// Anything thrown before the window exists would otherwise vanish with stdout.
process.on('uncaughtException', error => {
  say('FATAL ' + String(error && error.stack ? error.stack : error))
  app.exit(1)
})

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'capture.log'), '', 'utf8')
  say('capturing ' + URL + ' -> ' + OUT)

  // One window, resized between passes.
  //
  // Creating a second BrowserWindow after destroying the first reliably failed
  // the next navigation with ERR_FAILED (-2) while the host was demonstrably
  // still serving 200. Resizing sidesteps it and is closer to what a person
  // does anyway.
  const win = new BrowserWindow({
    width: VIEWPORTS[0].width,
    height: VIEWPORTS[0].height,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })

  for (const viewport of VIEWPORTS) {
    say('[' + viewport.name + '] ' + String(viewport.width) + 'x' + String(viewport.height))
    win.setContentSize(viewport.width, viewport.height)
    await wait(600)
    try {
      await run(win, viewport)
    } catch (error) {
      say('  capture FAILED: ' + String(error && error.stack ? error.stack : error))
    }
  }
  win.destroy()

  writeFileSync(join(OUT, 'index.json'), JSON.stringify(shots, null, 2) + '\n', 'utf8')
  say(String(shots.length) + ' shot(s) written')
  say('qa profile: ' + QA_PROFILE)

  // Removed on exit unless asked otherwise. A profile that survives between
  // runs is how a capture stops being reproducible — the second run inherits
  // the first one's storage and quietly photographs a different state.
  if (process.env.WATCH_QA_KEEP_PROFILE !== '1') {
    app.once('will-quit', () => {
      try { rmSync(QA_PROFILE, { recursive: true, force: true }) } catch { /* best effort */ }
    })
  }
  app.quit()
})
