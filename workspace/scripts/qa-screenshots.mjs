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

// See `qa-e2e.mjs`: a hosted Linux runner has no usable setuid sandbox helper,
// and Electron exits rather than starting without one.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}
import { writeFileSync, mkdirSync, appendFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { manualPath } from './lib/manual-paths.mjs'

// Configuration comes through the environment, not argv.
//
// Passing extra arguments to `electron.exe` stops it resolving the entry at
// all — the module never parses, nothing is written, and the run is
// indistinguishable from a silent success. Proven with a one-line probe: the
// same script loads with no arguments and does not load with two.
/** The repository this script lives in, so it can read what it photographs. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A path a reader on another machine can resolve.
 *
 * Shots written inside the repository are recorded relative to its root, so
 * the index can be committed. Anything outside keeps its absolute path,
 * because a relative one would be meaningless.
 */
const portablePath = (absolute) => {
  const inside = relative(REPO, absolute)
  return inside.startsWith('..') ? absolute : inside.split(sep).join('/')
}

const URL = process.env.WATCH_QA_URL ?? 'http://127.0.0.1:8931'
const OUT = manualPath('WATCH_QA_OUT', ['qa', 'screenshots'])
const SCENARIO_REPORT_PATH = process.env.WATCH_QA_SCENARIO_REPORT ?? ''

/**
 * Only non-secret, reviewer-useful fields cross from the E2E report into the
 * screenshot evidence. In particular, URLs, filesystem paths, credentials and
 * raw provider responses are never copied.
 */
function safeScenario() {
  if (SCENARIO_REPORT_PATH === '' || !existsSync(SCENARIO_REPORT_PATH)) return null
  const report = JSON.parse(readFileSync(SCENARIO_REPORT_PATH, 'utf8'))
  return {
    schemaVersion: report.schemaVersion,
    scenario: report.scenario,
    result: report.result,
    provider: report.provider,
    providerLabel: report.providerLabel
      ?? (report.provider === 'openrouter-e2e' ? 'OpenRouter QA (local stub)' : null),
    model: report.model,
    modelLabel: report.modelLabel
      ?? (report.model === 'stub/echo-small' ? 'Stub Echo Small' : null),
    // Copied, never defaulted. `?? 'connected'` here meant a report that had
    // not observed the engine still described a connected one, and the
    // Diagnostics verdict downstream is decided by exactly this field.
    core: report.core ?? null,
    coreTransport: report.coreTransport ?? null,
    coreVersion: report.coreVersion ?? null,
    requestClassification: report.requestClassification,
    failureScenarios: report.failureScenarios,
  }
}

const SCENARIO = safeScenario()

/**
 * A session with history, so the mode tabs are actually mounted.
 *
 * Overridable because the id belongs to the manual-test profile rather than to
 * this script; without one the run still captures everything else and simply
 * reports no tabs.
 */
const SESSION_ID = process.env.WATCH_QA_SESSION ?? ''
/** The directory a created session adopts. Any real directory will do. */
const SESSION_CWD = process.env.WATCH_QA_CWD ?? process.cwd()

/** Desktop, and a narrower desktop window — both sizes the product supports. */
/**
 * The widths this product is claimed to work at, and why these three.
 *
 * 1440 is the desktop case. The other two sit on the breakpoints the
 * stylesheets actually declare — the mode surfaces reflow at 760px and the
 * first-run card goes single-column at 620px — so a capture at 1024 was
 * evidence for neither. A responsive claim is only as good as the width it
 * was photographed at.
 */
const VIEWPORTS = [
  { name: 'wide', width: 1440, height: 900 },
  { name: 'narrow', width: 768, height: 1024 },
  { name: 'compact', width: 600, height: 900 },
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

// Removed before it is created, not only after it is used. Whether the
// first-run notice appears at all is decided by this directory: a run that
// did not exit cleanly leaves it behind, and the next capture then reports
// "already dismissed in this profile" about a profile nobody dismissed
// anything in — and photographs nothing for the first screen of the product.
rmSync(QA_PROFILE, { recursive: true, force: true })
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

/**
 * Every Watch settings section, read from the module that registers them.
 *
 * Returns [label, slug] pairs, where the slug is the section id without its
 * `watch-` prefix — the name the shot files already use.
 */
function settingsSections() {
  const source = readFileSync(
    join(REPO, 'packages', 'watch', 'client-settings', 'src', 'client', 'index.tsx'),
    'utf8',
  )
  const found = []
  const pattern = /section\('watch-([a-z-]+)', '([^']+)'/g
  let match = pattern.exec(source)
  while (match !== null) {
    found.push([match[2], match[1] === 'memory' ? 'memory-settings' : match[1]])
    match = pattern.exec(source)
  }
  if (found.length === 0) throw new Error('watch: no settings sections found to photograph')
  return found
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

/**
 * Photograph the screen, or record why there was nothing to photograph.
 *
 * `reached` is the precondition: whether the tool actually got to the thing
 * the shot is named after. When it is false no PNG is written at all.
 *
 * That matters more than it sounds. An earlier run produced sixteen shots of
 * an empty workspace — every mode, both viewports — each saved under the name
 * of a mode nobody had reached. In a directory listing they were
 * indistinguishable from real captures, and a reviewer scrolling past would
 * have counted thirty-eight successes. A missing file cannot be mistaken for
 * evidence; a duplicate one can.
 */
/**
 * Wait for the compositor, not for the clock.
 *
 * `capturePage` returns the last frame that was actually painted, and a window
 * this size can be throttled enough that a mode which has already changed in
 * the DOM has not yet been drawn. The result is two files with one image in
 * them — and, because the tab really was selected when it was checked, every
 * assertion about reaching the state passes while the picture shows the
 * previous one. Two animation frames is the browser saying it has drawn,
 * rather than this script assuming it by now.
 */
async function repainted(win) {
  await win.webContents.executeJavaScript(
    'new Promise(function (done) { requestAnimationFrame(function () {'
    + ' requestAnimationFrame(function () { done(true) }) }) })',
  )
}

/**
 * Small, structured facts from the frame that was photographed.
 *
 * This is intentionally not a DOM dump. It records only named product claims
 * and exact matches against the sanitized E2E scenario, so the committed
 * evidence cannot contain a credential, host path or arbitrary conversation.
 */
async function captureFacts(win) {
  return win.webContents.executeJavaScript(`(function (expected) {
    var bodyText = document.body ? document.body.innerText : ''
    var dialog = document.querySelector('[role="dialog"]')
    var text = dialog ? dialog.innerText : bodyText
    var exact = function (value) {
      return typeof value === 'string' && value.length > 0 ? text.indexOf(value) !== -1 : null
    }
    var countLines = function (label) {
      return text.split(/\\r?\\n/).filter(function (line) {
        return line.trim().toLowerCase() === label
      }).length
    }
    var settings = ['General', 'Models', 'Role Bindings', 'Perception', 'Sources',
      'Memory', 'Verification', 'Diagnostics', 'About']
    var activeSettings = Array.prototype.slice.call(document.querySelectorAll('button'))
      .filter(function (button) {
        var label = button.textContent.trim()
        var signal = [button.getAttribute('aria-selected'), button.getAttribute('aria-current'),
          button.getAttribute('data-state'), button.className].join(' ').toLowerCase()
        return settings.indexOf(label) !== -1 && /true|page|active|selected/.test(signal)
      })
      .map(function (button) { return button.textContent.trim() })[0] || null
    var selected = document.querySelector('[role="tab"][aria-selected="true"]')
    var readinessSummary = text.match(/(\\d+)\\s+of\\s+(\\d+)\\s+capabilities\\s+are\\s+ready/i)
    var readinessPassed = text.match(/(\\d+)\\s+capabilities?\\s+passed\\s+their\\s+readiness\\s+gates/i)
    var readinessNeeds = text.match(/(\\d+)\\s+capabilities?\\s+still\\s+need/i)
    var readyMetric = document.querySelector('[data-watch-readiness="ready"] [data-watch-count]')
    var pendingMetric = document.querySelector('[data-watch-readiness="pending"] [data-watch-count]')
    var metricReady = readyMetric && /^\\d+$/.test(readyMetric.textContent.trim())
      ? Number(readyMetric.textContent.trim()) : null
    var metricPending = pendingMetric && /^\\d+$/.test(pendingMetric.textContent.trim())
      ? Number(pendingMetric.textContent.trim()) : null
    var summaryReady = readinessSummary ? Number(readinessSummary[1])
      : readinessPassed ? Number(readinessPassed[1]) : metricReady
    var summaryTotal = readinessSummary ? Number(readinessSummary[2])
      : readinessPassed && readinessNeeds
        ? Number(readinessPassed[1]) + Number(readinessNeeds[1])
        : metricReady !== null && metricPending !== null ? metricReady + metricPending : null
    return {
      dialogOpen: !!dialog,
      watchOnboarding: /Welcome to DeepWatch|Meet Watch|Watch can observe, act, remember/i.test(text),
      selectedMode: selected ? selected.textContent.trim() : null,
      settingsSection: activeSettings,
      providerMatch: exact(expected && expected.providerLabel),
      providerIdMatch: exact(expected && expected.provider),
      modelMatch: exact(expected && expected.model) === true
        || exact(expected && expected.modelLabel) === true,
      stubReplyVisible: text.indexOf('The stub provider answered.') !== -1,
      coreConnected: /Core[\\s\\S]{0,80}Connected/i.test(text)
        || /Connected[\\s\\S]{0,80}Core/i.test(text),
      completedNotVerified: /Agent completed\\s*(?:≠|!=|is not)\\s*Verified/i.test(text),
      libraryIndexVisible: /record\\(s\\) indexed/i.test(text) && /Rebuild index/i.test(text),
      memoryLedgerVisible: /memory ledger/i.test(text) || /correctable/i.test(text),
      compareBoundaryVisible: /computed, not reasoned about/i.test(text),
      readiness: {
        summaryReady: summaryReady,
        summaryTotal: summaryTotal,
        ready: countLines('ready'),
        degraded: countLines('degraded'),
        unconfigured: countLines('not configured'),
        unavailable: countLines('unavailable'),
        notTested: countLines('not tested'),
        error: countLines('error')
      }
    }
  })(${JSON.stringify(SCENARIO)})`)
}

async function capture(win, name, note, reached = true) {
  if (!reached) {
    shots.push({ name, file: null, note, captured: false })
    say('  ' + name.padEnd(38) + ' NOT CAPTURED — ' + note)
    return false
  }
  await repainted(win)
  const image = await win.webContents.capturePage()
  const file = join(OUT, name + '.png')
  writeFileSync(file, image.toPNG())
  const facts = await captureFacts(win)
  shots.push({ name, file: portablePath(file), note, captured: true, facts })
  say('  ' + name.padEnd(38) + ' ' + note)
  return true
}

/**
 * Photograph the first-run notice at every width, before it is dismissed.
 *
 * Nothing else may run first: the notice is on screen exactly once per
 * profile, and the pass that clears it is the pass that makes every later
 * width report "already dismissed".
 */
async function captureOnboarding(win) {
  try {
    await win.loadURL(URL)
  } catch (error) {
    say('  load retry after: ' + String(error))
    await wait(2500)
    await win.loadURL(URL)
  }
  await wait(4000)
  for (const viewport of VIEWPORTS) {
    win.setContentSize(viewport.width, viewport.height)
    await wait(1200)
    const firstDialog = await win.webContents.executeJavaScript(
      "(function(){var d=document.querySelector('[role=\"dialog\"]');"
      + " return d ? d.innerText.split('\\n')[0].slice(0,60) : ''})()",
    )
    await capture(win, viewport.name + '-01-onboarding',
      firstDialog === ''
        ? 'no first-run dialog: already dismissed in this profile'
        : 'first-run dialog: ' + firstDialog,
      firstDialog !== '')
  }
}

/**
 * Open the sidebar, and wait until it is.
 *
 * A pass *ends* by collapsing the rail to photograph it, and the next viewport
 * inherits that through the browser's own stored state. With the rail
 * collapsed there is no Settings button at all, so every section shot in the
 * second and third passes came back "not reachable" — and the two that did not
 * check their own precondition filed photographs of the workspace and of the
 * Memory *mode* under the names of settings sections.
 *
 * Polled rather than clicked once: at 600px the shell mounts the rail after
 * the first paint, and a single click landed before the button existed.
 */
async function ensureSidebar(win, tries = 10) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const state = await win.webContents.executeJavaScript(`(function () {
      var bs = Array.prototype.slice.call(document.querySelectorAll('button'))
      if (bs.some(function (b) { return b.textContent.trim() === 'Settings' })) return 'open'
      var t = bs.filter(function (b) {
        return /open sidebar/i.test(b.getAttribute('aria-label') || '')
      })[0]
      if (t) { t.click(); return 'clicked' }
      return 'absent'
    })()`)
    if (state === 'open') return true
    await wait(700)
  }
  return false
}

async function measure(win, label) {
  const data = await win.webContents.executeJavaScript(MEASURE)
  say('  [measure] ' + label + ' ' + JSON.stringify(data))
  return data
}

/** Which mode tab is actually selected, by the attribute the shell sets. */
const SELECTED_TAB = "(function(){"
  + "var t=document.querySelector('[role=\"tab\"][aria-selected=\"true\"]');"
  + " return t ? t.innerText.trim() : ''})()"

/**
 * What the shipped onboarding steps offer as a way past themselves.
 *
 * `Explore offline` is the Welcome dialog's, and it is the one that matches
 * what the next shot is captioned: entering the workspace without configuring
 * a provider. `Finish setup` would configure one and `View diagnostics` goes
 * somewhere else entirely, so neither belongs here.
 *
 * This list going stale is not hypothetical. Every label here was once
 * sufficient, the Welcome dialog was then given its own three, and the next
 * capture cleared nothing and photographed the dialog under the name of the
 * workspace behind it — which is the failure the comment below already
 * described from the time before that.
 */
const DISMISS = [
  'Explore offline', 'Continue', 'Configure later', 'Got it', 'Skip', 'Dismiss',
]

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

  // Name the notice that is actually on screen. This claimed the Watch
  // first-run notice unconditionally and photographed whichever dialog the
  // queue happened to be showing — usually DSH's own testing notice, since
  // Watch's comes after it.
  // Only a shot of the notice if the notice is there. The second viewport
  // runs in the same Electron profile, so the first pass has already
  // dismissed it -- writing the file anyway produced a second copy of the
  // plain workspace under the name of the first-run notice.
  const sidebar = await ensureSidebar(win)
  if (!sidebar) say('  sidebar: could not be opened; settings shots will report unreachable')

  const cleared = await clearOnboarding(win)
  say('  cleared ' + String(cleared) + ' onboarding step(s)')
  await wait(1200)

  // Whether anything is still on top, rather than how many were dismissed.
  //
  // The count was printed and nothing read it. When the Welcome dialog grew
  // labels this list did not have, `clearOnboarding` truthfully reported zero
  // and the run continued, capturing the dialog under the name of the
  // workspace: two files, byte-identical, one of them evidence for a claim it
  // did not show. A count of zero is not by itself wrong — a profile that has
  // already dismissed everything also clears nothing — so the count cannot be
  // the check. What is on screen can.
  // The second viewport pass inherits the first one's session.
  //
  // DSH restores the last session on load, so by the time the narrow pass runs
  // there is one open, on whatever mode the wide pass left it. The shot named
  // for the workspace then showed a session — and, being whatever mode came
  // last, was byte-identical to one of the mode shots that followed.
  //
  // Starting a new session puts the shell back in the state this shot is named
  // after: DSH hides the session header while a session is blank, which is the
  // same empty workspace the first pass photographs before any session exists.
  const openSession = await win.webContents.executeJavaScript(
    "document.querySelectorAll('[role=\"tab\"]').length")
  if (openSession > 0) {
    await win.webContents.executeJavaScript(CLICK_BY_TEXT + "('button', 'New Session')")
    await wait(1600)
    // Starting a session with no provider configured brings the first-run
    // notice back, so the queue has to be cleared again. Found by the check
    // below refusing to photograph the dialog as the workspace, which is the
    // whole reason that check exists.
    await clearOnboarding(win)
    await wait(800)
  }

  const stillOpen = await win.webContents.executeJavaScript(
    "(function(){var d=document.querySelector('[role=\"dialog\"]');"
    + " return d ? d.innerText.split('\\n')[0].slice(0,60) : ''})()",
  )
  await capture(win, p('03-workspace'),
    stillOpen === ''
      ? 'the workspace, entered without configuring any provider'
      : 'a dialog is still on screen and would be photographed as the '
        + 'workspace: ' + stillOpen,
    stillOpen === '')
  await measure(win, 'workspace')

  // Open a session that actually has content.
  //
  // The mode tabs live in the session header, and DSH hides that chrome while
  // the session is blank — `blank && composerPhase === 'blank'`. Clicking a
  // sidebar row that happens to be a fresh empty session therefore produces no
  // tabs and looks exactly like the registrations having failed, which is what
  // an earlier run reported. Selecting a seeded session with history and
  // reloading is deterministic, and the reload is what makes DSH pick it up.
  // Create a real session through DSH's own API.
  //
  // This used to read a session id out of an environment variable, and when
  // nobody set one it silently opened nothing — which is how sixteen shots of
  // an empty workspace came to be labelled as seven modes.
  //
  // `session.create` accepts a `cwd` directly, so no workspace is needed. That
  // matters because adding a workspace goes through a native directory picker,
  // which no automated capture can drive.
  const opened = await win.webContents.executeJavaScript(`(async function () {
    function rpc (method, payload) {
      return fetch('/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'qa-' + String(Date.now()) + '-' + String(Math.random()).slice(2, 8),
          method: method,
          payload: payload
        })
      }).then(function (r) { return r.json() })
    }

    var seeded = ${JSON.stringify(SESSION_ID)}
    if (seeded) {
      localStorage['dsh.sessions.current'] = JSON.stringify({ sessionId: seeded })
      return seeded
    }
    try {
      var created = await rpc('session.create', { cwd: ${JSON.stringify(SESSION_CWD)} })
      var id = created && created.result && created.result.ok && created.result.value.sessionId
      if (!id) return null

      // Send one turn. DSH hides the session header while a session is blank,
      // so without this the mode tabs never mount and there is nothing to
      // photograph. The turn goes through the real agent loop; whether the
      // model behind it is a paid provider or the QA stub is decided by the
      // profile, not here.
      await rpc('session.prompt', {
        sessionId: id,
        mode: 'queue',
        content: [{ type: 'text', text: 'Say hello so this session is no longer blank.' }]
      })

      // Wait for it to land, up to a minute.
      var deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        var listed = await rpc('session.list', {})
        var mine = (listed.result.value.items || []).filter(function (s) { return s.sessionId === id })[0]
        if (mine && mine.blank === false && mine.running === false) break
        await new Promise(function (r) { setTimeout(r, 500) })
      }

      localStorage['dsh.sessions.current'] = JSON.stringify({ sessionId: id })
      return id
    } catch (error) {
      return 'error: ' + String(error)
    }
  })()`)
  say('  session: ' + String(opened))
  await win.reload()
  await wait(3200)
  await clearOnboarding(win)
  await wait(2400)
  const session = await measure(win, 'session')
  say('  tabs: ' + JSON.stringify(session.tabs))
  // No separate tablist shot.
  //
  // Chat is the tab DSH opens on, so photographing "the tablist" and then
  // photographing Chat produced two identical files. The tablist is visible
  // in all seven mode shots, and `session.tabs` below is the assertion that
  // it mounted, so a shot of its own adds a duplicate and nothing else.
  if (session.tabs.length === 0) {
    say('  tablist absent -- the mode shots will record why')
  }

  for (const mode of ['Chat', 'Trajectory', 'Watch', 'Live', 'Memory', 'Library', 'Compare']) {
    // Click, then read back which tab is selected.
    //
    // A click that lands on the right element is not the same as a mode that
    // changed, and the difference is invisible in the resulting PNG unless
    // somebody opens it and knows what each mode looks like. The first click
    // of a pass is the one that misses: the tablist has just been re-rendered
    // around a restored session, and the event arrives before it is live. That
    // produced three files with one image in them — a workspace, a Chat and a
    // Compare that were all Compare — and every one of them looked like a
    // screenshot of something.
    let selected = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await win.webContents.executeJavaScript(
        CLICK_BY_TEXT + "('[role=\"tab\"]', " + JSON.stringify(mode) + ')',
      )
      await wait(1200)
      selected = await win.webContents.executeJavaScript(SELECTED_TAB)
      if (selected === mode) break
    }
    await capture(win, p('05-mode-' + mode.toLowerCase()),
      selected === mode
        ? mode + ' mode'
        : 'the ' + mode + ' tab did not become active'
          + (selected === '' ? ' and no tab is selected' : ', ' + selected + ' is')
          + ', so nothing was photographed',
      selected === mode)
  }

  // Settings, and every Watch section in it.
  //
  // The sidebar is reopened *here* as well as at the top of the pass. Below
  // 768px the shell treats it as an overlay and closes it as soon as anything
  // in the main area is touched — and the seven mode tabs above are exactly
  // that. Opening it once per pass was enough at 1440 and reported "Settings
  // was not reachable" for every section at the two widths that matter most.
  await ensureSidebar(win)
  const settingsOpened = await win.webContents.executeJavaScript(
    CLICK_BY_TEXT + "('button', 'Settings')",
  )
  await wait(1600)
  await capture(win, p('06-settings-general'),
    settingsOpened
      ? 'DSH General kept above the Watch sections'
      : 'Settings was not reachable, so nothing was photographed',
    settingsOpened)

  // Scoped to the dialog, because the labels are not unique on the page.
  // "Memory" is a settings section *and* a mode tab, and the unscoped click
  // photographed the Memory mode under the name of the settings section on
  // every pass where the dialog had not opened.
  const modelsOpened = await win.webContents.executeJavaScript(
    CLICK_BY_TEXT + "('[role=\"dialog\"] button', 'Models')",
  )
  await wait(1200)
  await capture(win, p('06-settings-models'),
    modelsOpened
      ? 'upstream Models with the configured deterministic provider'
      : 'Models was not reachable, so nothing was photographed',
    modelsOpened)

  // Read the sections out of the module that registers them.
  //
  // This was a hand-written list and it drifted the moment the labels
  // changed. Deriving it means a renamed or added section is photographed
  // without anyone remembering to edit this file.
  const sections = settingsSections()
  for (const [label, slug] of sections) {
    const ok = await win.webContents.executeJavaScript(
      CLICK_BY_TEXT + "('[role=\"dialog\"] button', " + JSON.stringify(label) + ')',
    )
    await wait(1000)
    // `ok` is the precondition here too: a section that was never opened must
    // not be photographed under its name. This is the same defect as the
    // modes, in a second place — the list below held the *truncated* labels
    // ("Perception Engi"), a workaround for a nav that ellipsised. Fixing the
    // labels broke the clicks, and without this the tool would have saved the
    // previously open section three times over.
    await capture(win, p('07-settings-' + slug),
      ok ? label + ' section' : label + ' was not reachable, so nothing was photographed', ok)
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
  say('capturing ' + URL + ' -> ' + portablePath(OUT))

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

  // The first-run notice, at every width, before anything dismisses it.
  //
  // It is a one-shot: completing the step is recorded in the profile, so the
  // second viewport pass finds no dialog and the shot named for it was a
  // second photograph of the workspace behind it. Photographing it for every
  // width up front needs no reset and no second profile, and it is the only
  // way the surface a person meets first has responsive evidence at all.
  await captureOnboarding(win)

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
  if (SCENARIO !== null) {
    writeFileSync(join(OUT, 'scenario.json'), JSON.stringify(SCENARIO, null, 2) + '\n', 'utf8')
  }
  say(String(shots.length) + ' shot(s) written')
  say('qa profile: isolated, outside the repository')

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
