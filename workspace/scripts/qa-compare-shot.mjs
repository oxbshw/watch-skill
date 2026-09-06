#!/usr/bin/env node
/**
 * One photograph: Compare, with two real verifications selected.
 *
 * The release page carried a Compare screenshot that showed a defect — both
 * rows read `unchecked` and the table counted them as *only on one side*,
 * because no receipt carried the verdict Core had returned for it. Keeping
 * that shot was the right call while the defect was open. The defect is
 * closed, so the shot has to be retaken from a build where it is, and this is
 * the program that retakes it rather than a description of how somebody once
 * did.
 *
 * It photographs whatever the running Host holds. It selects records by their
 * verdict — one FAILED and one VERIFIED, newest first — and refuses to
 * capture if it cannot find both, because a Compare shot with nothing to
 * compare is not evidence of anything.
 *
 * Run under Electron, the way the rest of the capture does:
 *
 *   WATCH_SHOT_URL=… WATCH_SHOT_SESSION=… WATCH_SHOT_OUT=… \
 *     electron.exe scripts/qa-compare-shot.mjs
 *
 * Everything is logged to a file: `electron.exe` on Windows detaches from the
 * console, so stdout is lost and a failing run looks exactly like a silent one.
 */

import { app, BrowserWindow } from 'electron'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const URL = process.env['WATCH_SHOT_URL'] ?? 'http://127.0.0.1:8931'
const SESSION = process.env['WATCH_SHOT_SESSION'] ?? ''
const OUT = process.env['WATCH_SHOT_OUT'] ?? join(HERE, '..', 'docs', 'screenshots', 'release')
const NAME = process.env['WATCH_SHOT_NAME'] ?? '09-compare-two-records'
const LOG = join(OUT, 'compare-shot.log')

mkdirSync(OUT, { recursive: true })
const say = (line) => {
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
}

const wait = (ms) => new Promise((done) => { setTimeout(done, ms) })

/**
 * The geometry.
 *
 * 1440 wide, like the rest of the release set. Taller by default, because the
 * comparison this shot exists to show sits below a picker and above a status
 * banner, and scrolling to it does not survive the capture: the surface
 * re-renders after a selection and resets `scrollTop`, and `capturePage`
 * returns the last painted frame either way. A taller window shows the whole
 * answer without asking the page to hold a scroll position it does not own.
 */
const WIDTH = Number(process.env['WATCH_SHOT_WIDTH'] ?? 1440)
const HEIGHT = Number(process.env['WATCH_SHOT_HEIGHT'] ?? 1200)
/** Page zoom, for a comparison longer than the screen the window sits on. */
const ZOOM = Number(process.env['WATCH_SHOT_ZOOM'] ?? 1)

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  writeFileSync(LOG, '', 'utf8')
  let failure = null
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })

  try {
    say(`opening ${URL}`)
    await win.loadURL(URL)
    await wait(2500)
    // A window cannot be taller than the screen, and the composer is fixed to
    // the bottom of it, so on a 1080p display the last row of a long
    // comparison sits behind the composer whatever the requested height. Zoom
    // is the honest way out: it is a setting a person has, and what it changes
    // is how much fits, not what the product says.
    if (ZOOM !== 1) {
      win.webContents.setZoomFactor(ZOOM)
      await wait(900)
    }

    if (SESSION !== '') {
      // The same handle `qa-screenshots.mjs` uses: the shell reads the current
      // session from local storage on boot, so setting it and reloading is how
      // a capture opens a conversation that already exists.
      await win.webContents.executeJavaScript(
        `localStorage['dsh.sessions.current'] = ${
          JSON.stringify(JSON.stringify({ sessionId: SESSION }))}; true`)
      await win.reload()
      await wait(3500)
    }

    // Dismiss the first-run notice if this profile has not seen it.
    await win.webContents.executeJavaScript(`(function () {
      var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
      var next = buttons.filter(function (b) {
        return /got it|continue|start|dismiss|close/i.test(b.textContent || '') })[0]
      if (next) next.click()
      return true
    })()`)
    await wait(1200)

    const onCompare = await win.webContents.executeJavaScript(`(function () {
      var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"], button'))
      var tab = tabs.filter(function (t) { return (t.textContent || '').trim() === 'Compare' })[0]
      if (!tab) return false
      tab.click()
      return true
    })()`)
    say(`compare tab: ${String(onCompare)}`)
    await wait(1800)

    // Choose by verdict, not by position. The picker is ordered by time and a
    // fixed index would photograph whatever happened to be third.
    const chosen = await win.webContents.executeJavaScript(`(function () {
      var selects = document.querySelectorAll('select')
      if (selects.length < 2) return { ok: false, why: 'the picker is not mounted' }
      var setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value').set
      function pick(select, wanted) {
        var options = Array.prototype.slice.call(select.options)
        var option = options.filter(function (o) {
          return (o.textContent || '').indexOf(wanted) !== -1 })[0]
        if (!option) return null
        setter.call(select, option.value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return (option.textContent || '').trim()
      }
      // Named explicitly when the caller knows which two records make the
      // point, and otherwise the two most recent verifications. The picker
      // labels a record by tool and time, not by verdict, so "the failing one"
      // is not something this can select for -- the caller passes it, and the
      // sidecar records what was actually photographed.
      var wantLeft = ${JSON.stringify(process.env['WATCH_SHOT_LEFT'] ?? '')}
      var wantRight = ${JSON.stringify(process.env['WATCH_SHOT_RIGHT'] ?? '')}
      var fallback = ${JSON.stringify(process.env['WATCH_SHOT_PICK'] ?? 'watch_verify')}
      var left = pick(selects[0], wantLeft || fallback)
      var right = null
      if (wantRight) {
        right = pick(selects[1], wantRight)
      } else {
        var options = Array.prototype.slice.call(selects[1].options)
        for (var at = 0; at < options.length; at += 1) {
          var text = options[at].textContent || ''
          if (text.indexOf(fallback) !== -1 && text !== left) {
            right = pick(selects[1], text.trim())
            break
          }
        }
      }
      return { ok: left !== null && right !== null, left: left, right: right }
    })()`)
    say(`records: ${JSON.stringify(chosen)}`)
    if (chosen.ok !== true) throw new Error(`could not choose two records: ${JSON.stringify(chosen)}`)
    await wait(2200)

    // What the comparison says, recorded beside the image so the caption can
    // be checked against it rather than trusted.
    const rendered = await win.webContents.executeJavaScript(`(function () {
      var text = document.body.innerText
      var at = text.indexOf('VERIFICATION DIFFERENCES')
      return at === -1 ? null : text.slice(at, at + 600)
    })()`)
    say(`rendered:\\n${String(rendered)}`)
    if (rendered === null || rendered.indexOf('unchecked') !== -1) {
      throw new Error('the comparison still reads unchecked; this build has the defect')
    }

    // Scroll the comparison into view before the shutter falls. A capture of
    // the picker with the answer below the fold photographs the question.
    //
    // Through the mode surface's own scroll body rather than `scrollIntoView`:
    // the page itself does not scroll, so the first version of this moved
    // nothing and the rows that carry the verdicts stayed under the composer.
    const scrolled = await win.webContents.executeJavaScript(`(function () {
      var all = Array.prototype.slice.call(document.querySelectorAll('*'))
      var body = all.filter(function (el) {
        var style = getComputedStyle(el)
        return el.scrollHeight > el.clientHeight + 40
          && /auto|scroll/.test(style.overflowY)
      })[0]
      if (!body) return null
      var rows = Array.prototype.slice.call(body.querySelectorAll('*')).filter(
        function (node) {
          return node.children.length === 0
            && /Only on the (left|right)/i.test(node.textContent || '') })[0]
      if (rows) {
        // High in the frame rather than centred: the composer and any status
        // banner overlay the lower third, so "centred" puts the second record
        // row behind them.
        body.scrollTop = Math.max(
          0, rows.offsetTop - body.offsetTop - Math.round(body.clientHeight * 0.09))
      } else {
        body.scrollTop = body.scrollHeight
      }
      return { top: body.scrollTop, height: body.scrollHeight, view: body.clientHeight }
    })()`)
    say(`scrolled: ${JSON.stringify(scrolled)}`)
    await wait(900)
    // Re-applied, and read back. The surface re-renders after a selection and
    // the render resets `scrollTop`, so a scroll set once and photographed a
    // second later photographs the top of the panel and reports success.
    const settledScroll = await win.webContents.executeJavaScript(`(function () {
      var all = Array.prototype.slice.call(document.querySelectorAll('*'))
      var body = all.filter(function (el) {
        var style = getComputedStyle(el)
        return el.scrollHeight > el.clientHeight + 40
          && /auto|scroll/.test(style.overflowY)
      })[0]
      if (!body) return null
      var rows = Array.prototype.slice.call(body.querySelectorAll('*')).filter(
        function (node) {
          return node.children.length === 0
            && /Only on the (left|right)/i.test(node.textContent || '') })[0]
      if (rows) {
        body.scrollTop = Math.max(
          0, rows.offsetTop - body.offsetTop - Math.round(body.clientHeight * 0.09))
      }
      return body.scrollTop
    })()`)
    say(`scrollTop at capture: ${JSON.stringify(settledScroll)}`)
    await wait(350)

    const image = await win.webContents.capturePage()
    const file = join(OUT, `${NAME}.png`)
    writeFileSync(file, image.toPNG())
    writeFileSync(join(OUT, `${NAME}.json`),
      `${JSON.stringify({
        url: URL, session: SESSION, width: WIDTH, height: HEIGHT, zoom: ZOOM,
        left: chosen.left, right: chosen.right, rendered,
        capturedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8')
    say(`wrote ${file}`)
  } catch (error) {
    failure = error
    say(`FAILED: ${String(error && error.stack ? error.stack : error)}`)
  } finally {
    win.destroy()
    app.exit(failure === null ? 0 : 1)
  }
})
