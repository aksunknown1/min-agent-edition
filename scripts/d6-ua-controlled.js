/*
 * R5 / D6 - controlled test of the ONE variable that differs between the runtimes
 * that clear Novellive (bare Electron, Chrome, CloakBrowser) and the one that does
 * not (Min): the User-Agent string.
 *
 * Min's UA is:
 *   ... Chrome/150.0.0.0 ... with an extra  MinAgentEdition/1.35.5  product token
 * (from app.userAgentFallback), which no real Chrome sends. Bare Electron on the
 * SAME engine (43.4.1 / Chromium 150) clears the challenge in ~3s.
 *
 * This runs the SAME minimal Electron 43 app twice, headed, fresh profile:
 *   A: default Electron UA (control)
 *   B: default UA + the Min product token (treatment)
 * If B fails where A clears, the UA token - not the Chromium version - is the
 * operative difference for this site.
 *
 * Read-only. Nothing is solved or bypassed; a challenge that does not clear is
 * reported as such.
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const URL_UNDER_TEST = 'https://novellive.com/'
const CHALLENGE_RE = /just a moment|attention required|checking your browser|verifying you are human/i
const TIMEOUT = 30000
const REPS = 2

function mainJs (extraUA) {
  return [
    "const { app, BrowserWindow } = require('electron')",
    "app.commandLine.appendSwitch('disable-background-networking')",
    extraUA
      ? "app.userAgentFallback = app.userAgentFallback + ' " + extraUA + "'"
      : "/* control: unmodified Electron UA */",
    "app.whenReady().then(function () {",
    "  var win = new BrowserWindow({ width: 1200, height: 900, show: true })",
    "  win.loadURL(" + JSON.stringify(URL_UNDER_TEST) + ")",
    "  setInterval(function () {",
    "    try { process.stdout.write('TITLE=' + JSON.stringify(String(win.webContents.getTitle() || '')) + String.fromCharCode(10)) } catch (e) {}",
    "  }, 400)",
    "})"
  ].join('\n')
}

async function run (label, extraUA) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd6ua-' + label + '-'))
  fs.writeFileSync(path.join(dir, 'main.js'), mainJs(extraUA), 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'd6ua', version: '1.0.0', main: 'main.js' }), 'utf8')
  const profile = path.join(os.tmpdir(), 'd6ua-prof-' + label + '-' + Date.now())
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
  return { variant: label, extraUA: extraUA || null, clearedAtMs: cleared, sawChallenge, finalTitle: last.slice(0, 90) }
}

;(async () => {
  const out = {
    ts: new Date().toISOString(),
    url: URL_UNDER_TEST,
    timeoutMs: TIMEOUT,
    reps: REPS,
    runtime: 'Electron 43.4.1 / Chromium 150.0.7871.224 (identical binary for both variants)',
    note: 'Read-only. Only the User-Agent product token differs. No challenge solved or bypassed.',
    results: []
  }
  for (let rep = 1; rep <= REPS; rep++) {
    const a = await run('control-default-UA', null)
    out.results.push(Object.assign({ rep }, a))
    console.log('rep ' + rep + ' control (default UA) : cleared=' + a.clearedAtMs + ' title=' + JSON.stringify(a.finalTitle).slice(0, 50))
    const b = await run('treatment-min-token', 'MinAgentEdition/1.35.7')
    out.results.push(Object.assign({ rep }, b))
    console.log('rep ' + rep + ' treatment (Min token): cleared=' + b.clearedAtMs + ' title=' + JSON.stringify(b.finalTitle).slice(0, 50))
    await sleep(500)
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'd6-ua-controlled.json'), JSON.stringify(out, null, 2))
  process.exit(0)
})().catch(e => { console.error(e); process.exit(2) })
