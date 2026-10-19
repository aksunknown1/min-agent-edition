/* P0-08 Part A bisect step 1: does ANY Electron app die with two positional
 * file:// URL args, or is it Min-specific?
 * Minimal app: one window loading an internal data page. Prints a line at each
 * lifecycle point so a silent early death is obvious. */
const { app, BrowserWindow } = require('electron')

/* Written synchronously: survives a native crash, unlike pipe-buffered console
 * output. Absence after a crash proves death before application JS. */
try {
  require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'min-argv-reached-app-js.txt'), String(process.argv.length))
} catch (e) { /* ignore */ }

console.log('MINIMAL-APP module-load ok, argv=' + JSON.stringify(process.argv.slice(1)))

app.on('uncaughtException', function (e) {
  console.log('MINIMAL-APP uncaughtException: ' + (e && e.message))
})
process.on('unhandledRejection', function (r) {
  console.log('MINIMAL-APP unhandledRejection: ' + r)
})

app.on('web-contents-created', function (e, wc) {
  wc.on('render-process-gone', function (e2, details) {
    console.log('MINIMAL-APP render-process-gone: ' + JSON.stringify(details))
  })
})
app.on('child-process-gone', function (e, details) {
  console.log('MINIMAL-APP child-process-gone: ' + JSON.stringify(details))
})

app.whenReady().then(function () {
  console.log('MINIMAL-APP ready, creating window')
  const win = new BrowserWindow({ width: 500, height: 400, show: true })
  win.webContents.on('render-process-gone', function (e, d) {
    console.log('MINIMAL-APP win render-process-gone: ' + JSON.stringify(d))
  })
  win.loadURL('data:text/html,<title>minimal</title><p style="background:#fbbf24">minimal app</p>')
  console.log('MINIMAL-APP window created and loading')
})
