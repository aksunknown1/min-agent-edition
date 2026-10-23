/*
 * R5 / D6 - does stripping the product token fix it?
 *
 * Verification only. This does NOT modify the product: it reuses the exact minimal
 * Electron 43 app and removes the product token from the UA, reproducing what
 * UASwitcher WOULD produce if it also stripped the edition's own token.
 *
 * Variants, all identical Electron 43.4.1 / Chromium 150.0.7871.224, headed,
 * fresh profile, read-only navigation to novellive.com:
 *   A  UA exactly as Min sends it today        (MinAgentEdition/x + Chrome/150.0.0.0)
 *   B  Min UA minus the product token          (Chrome/150.0.0.0 only)
 *   C  Min UA minus product token, real minor  (Chrome/150.0.7871.224)
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const URL_UNDER_TEST = 'https://novellive.com/'
const CHALLENGE_RE = /just a moment|attention required|checking your browser|verifying you are human/i
const TIMEOUT = 28000
const REPS = 2

const VARIANTS = [
  { id: 'A-min-today', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MinAgentEdition/1.35.7 Chrome/150.0.0.0 Safari/537.36' },
  { id: 'B-no-token', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36' },
  { id: 'C-no-token-fullver', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36' }
]

function mainJs (ua) {
  return [
    "const { app, BrowserWindow } = require('electron')",
    "app.commandLine.appendSwitch('disable-background-networking')",
    "app.userAgentFallback = " + JSON.stringify(ua),
    "app.whenReady().then(function () {",
    "  var win = new BrowserWindow({ width: 1200, height: 900, show: true })",
    "  win.loadURL(" + JSON.stringify(URL_UNDER_TEST) + ")",
    "  setInterval(function () {",
    "    try { process.stdout.write('TITLE=' + JSON.stringify(String(win.webContents.getTitle() || '')) + String.fromCharCode(10)) } catch (e) {}",
    "  }, 400)",
    "})"
  ].join('\n')
}

async function run (variant) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd6fix-' + variant.id + '-'))
  fs.writeFileSync(path.join(dir, 'main.js'), mainJs(variant.ua), 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'd6fix', version: '1.0.0', main: 'main.js' }), 'utf8')
  const profile = path.join(os.tmpdir(), 'd6fix-prof-' + variant.id + '-' + Date.now())
  const t0 = Date.now()
  const proc = spawn(require('electron'), ['.', '--user-data-dir=' + profile, '--no-first-run'], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  proc.stdout.on('data', d => { stdout += String(d) })
  let cleared = null
  let sawChallenge = false
  let last = ''
  while (Date.now() - t0 < TIMEOUT) {
    await sleep(500)
    const lines = stdout.split(/\r?\n/).filter(function (l) { return l.indexOf('TITLE=') === 0 })
    if (!lines.length) continue
    const m = lines[lines.length - 1].match(/^TITLE=(.*)$/)
    let title = ''
    if (m) { try { title = JSON.parse(m[1]) } catch (e) { title = m[1] } }
    last = title
    if (CHALLENGE_RE.test(title)) { sawChallenge = true; continue }
    if (title) { cleared = Date.now() - t0; break }
  }
  try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }) } catch (e) {}
  await sleep(300)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  return { variant: variant.id, ua: variant.ua, clearedAtMs: cleared, sawChallenge, finalTitle: last.slice(0, 90) }
}

;(async () => {
  const out = {
    ts: new Date().toISOString(),
    url: URL_UNDER_TEST,
    timeoutMs: TIMEOUT,
    reps: REPS,
    runtime: 'Electron 43.4.1 / Chromium 150.0.7871.224 for every variant',
    note: 'Read-only. No challenge solved or bypassed. Each variant differs only in the User-Agent string.',
    results: []
  }
  for (let rep = 1; rep <= REPS; rep++) {
    for (const v of VARIANTS) {
      const r = await run(v)
      out.results.push(Object.assign({ rep }, r))
      console.log('rep ' + rep + ' ' + v.id.padEnd(22) + ' cleared=' + r.clearedAtMs + ' title=' + JSON.stringify(r.finalTitle).slice(0, 48))
    }
    await sleep(400)
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'd6-ua-fix-verify.json'), JSON.stringify(out, null, 2))
  process.exit(0)
})().catch(e => { console.error(e); process.exit(2) })
