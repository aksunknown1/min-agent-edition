/* P0-06 background-screenshot measurement fixture.

 * A throwaway Electron app - NOT Min - that reproduces the exact API combination
 * Min uses for tabs: a BrowserWindow with a WebContentsView attached through
 * win.contentView. It measures whether webContents.capturePage() returns usable
 * pixels when the window is hidden, which is the open question in
 * docs/PHASE1-DESIGN.md section 10.

 * Prints one JSON object on stdout. Loads no remote content. Exits by itself.
 */

const { app, BrowserWindow, WebContentsView } = require('electron')

/* P0-07: record any unhandled rejection explicitly instead of letting it pass
 * as a console warning, so "hidden capture no longer causes an unhandled
 * rejection" is a measured result rather than an absence of noise. */
const unhandledRejections = []
process.on('unhandledRejection', function (reason) {
  unhandledRejections.push(String((reason && reason.message) || reason))
})

const PAGE = 'data:text/html,' + encodeURIComponent(
  '<!doctype html><html><head><title>capture probe</title></head>' +
  '<body style="margin:0"><div style="width:600px;height:400px;background:rgb(251,191,36)"></div></body></html>'
)

function describeImage (img) {
  if (!img) {
    return { returned: false }
  }
  const size = img.getSize()
  let distinct = null
  let empty = null
  try {
    const bmp = img.getBitmap()
    const seen = new Set()
    for (let i = 0; i < bmp.length; i += 4) {
      seen.add(bmp[i] + ',' + bmp[i + 1] + ',' + bmp[i + 2] + ',' + bmp[i + 3])
      if (seen.size > 8) break
    }
    distinct = seen.size
    /* Min's own guard is a zero-size image (main/viewManager.js:449). */
    empty = (size.width === 0 && size.height === 0)
  } catch (e) {
    distinct = 'bitmap-error:' + e.message
  }
  return {
    returned: true,
    width: size.width,
    height: size.height,
    zeroSized: empty,
    distinctColorsSampled: distinct,
    dataUrlBytes: img.toDataURL().length
  }
}

async function capture (win, view, label) {
  try {
    const img = await view.webContents.capturePage()
    return Object.assign({ case: label, ok: true }, describeImage(img))
  } catch (e) {
    return { case: label, ok: false, error: String(e && e.message ? e.message : e) }
  }
}

async function makeWindow (opts) {
  const win = new BrowserWindow(Object.assign({ width: 1280, height: 800, show: false }, opts))
  const view = new WebContentsView({ webPreferences: { sandbox: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
  await view.webContents.loadURL(PAGE)
  return { win: win, view: view }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async function () {
  const out = { electron: process.versions.electron, chromium: process.versions.chrome, cases: [] }

  /* A: hidden window, view attached (the naive "background mode" setup) */
  let m = await makeWindow({ show: false })
  await sleep(1200)
  out.cases.push(await capture(m.win, m.view, 'A hidden window, view attached'))
  out.cases.push({ case: 'A window state', visible: m.win.isVisible(), minimized: m.win.isMinimized(), occluded: (typeof m.win.isOccluded === "function") ? m.win.isOccluded() : null })

  /* B: hidden window + backgroundThrottling disabled */
  m.win.close()
  m = await makeWindow({ show: false, backgroundThrottling: false })
  await sleep(1200)
  out.cases.push(await capture(m.win, m.view, 'B hidden window, backgroundThrottling false'))

  /* C: detached view (removed from the window's view tree) */
  m.win.contentView.removeChildView(m.view)
  await sleep(600)
  out.cases.push(await capture(m.win, m.view, 'C view removed from view tree'))
  m.win.close()

  /* D: control - visible window. One retry: on cold starts the compositor can
   * fail the first capture of a freshly shown window (UnknownVizError was
   * observed once); a retry after settle is what tab previews effectively do. */
  m = await makeWindow({ show: true })
  m.win.show()
  await sleep(1500)
  let d = await capture(m.win, m.view, 'D visible window (control)')
  if (!d.ok) {
    const firstError = d.error
    await sleep(2500)
    d = await capture(m.win, m.view, 'D visible window (control, retry)')
    if (!d.ok) {
      d.firstAttemptError = firstError
    }
  }
  out.cases.push(d)
  out.cases.push({ case: 'D window state', visible: m.win.isVisible(), minimized: m.win.isMinimized(), occluded: (typeof m.win.isOccluded === "function") ? m.win.isOccluded() : null })

  /* E: visible then minimized (occluded) */
  m.win.minimize()
  await sleep(1500)
  out.cases.push(await capture(m.win, m.view, 'E visible window minimized'))
  out.cases.push({ case: 'E window state', visible: m.win.isVisible(), minimized: m.win.isMinimized(), occluded: (typeof m.win.isOccluded === "function") ? m.win.isOccluded() : null })
  m.win.close()

  out.unhandledRejections = unhandledRejections
  console.log(JSON.stringify(out))
  app.exit(0)
})
