/* P0-11 key-translation fixture: send candidate keyCodes via sendInputEvent to
 * a page with a form + keydown listener, report received e.key and URL. */
const { app, BrowserWindow, WebContentsView } = require('electron')

const PAGE = 'data:text/html,' + encodeURIComponent(
  '<!doctype html><html><head><title>KEYDIAG</title></head><body>' +
  '<form action="#"><input id="a" type="text"><input id="b" type="text"><button type="submit">S</button></form>' +
  '<select id="sel"><option>1</option><option>2</option></select>' +
  '<script>document.addEventListener("keydown", function (e) {' +
  'document.title = "K:" + (e.key || "?") + ":" + e.keyCode; });' +
  'document.querySelector("form").addEventListener("submit", function (e) {' +
  'e.preventDefault(); document.title = "SUBMITTED"; });' +
  '</script></body></html>'
)

const CANDIDATES = ['Enter', 'Return', 'ArrowDown', 'Down', 'ArrowUp', 'Up', 'ArrowLeft', 'Left', 'Escape', 'Esc', 'Tab', 'PageUp', 'Home', 'Delete', 'Backspace']

const sleep = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async function () {
  const win = new BrowserWindow({ width: 900, height: 700, show: false })
  const view = new WebContentsView({ webPreferences: { sandbox: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 })
  await view.webContents.loadURL(PAGE)
  await sleep(800)
  view.webContents.focus()  /* real focus so key events land */
  await sleep(300)

  const out = []
  for (const c of CANDIDATES) {
    try {
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: c })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: c })
    } catch (e) { out.push({ sent: c, error: String(e.message).slice(0, 80) }); continue }
    await sleep(350)
    out.push({ sent: c, title: view.webContents.getTitle(), url: view.webContents.getURL().slice(0, 60) })
  }
  /* focused-element moves for arrows inside the form's text field: click field first */
  try {
    view.webContents.sendInputEvent({ type: 'mouseDown', x: 60, y: 12, button: 'left', clickCount: 1 })
    view.webContents.sendInputEvent({ type: 'mouseUp', x: 60, y: 12, button: 'left', clickCount: 1 })
    await sleep(300)
    const pre = view.webContents.executeJavaScript('document.activeElement.id').then(v => v)
    await sleep(200)
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ArrowDown' })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ArrowDown' })
    await sleep(350)
    const postId = await view.webContents.executeJavaScript('document.activeElement.id')
    out.push({ sent: 'ArrowDown-after-focus', focusedId: await pre, post: postId, title: view.webContents.getTitle() })
  } catch (e) { out.push({ sent: 'ArrowDown-after-focus', error: String(e.message).slice(0, 80) }) }

  console.log(JSON.stringify(out, null, 1))
  app.exit(0)
})
