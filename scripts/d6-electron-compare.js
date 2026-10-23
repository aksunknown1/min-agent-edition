/*
 * R5 / D6 - controlled engine comparison for the Novellive case.
 *
 * Tests the HYPOTHESIS directly: is the Electron/Chromium gap the cause, or is it
 * Electron-specific behaviour independent of Chromium version?
 *
 * Three Electron builds, identical minimal main process, fresh profile, headed,
 * read-only navigation to novellive.com, polling the window title until the
 * Cloudflare challenge clears or the timeout expires.
 *
 *   Electron 43.4.1 -> Chromium 150.0.7871.224   (current product runtime)
 *   Electron 44.9.1 -> Chromium 152.0.7977.167   (upgrade candidate)
 *
 * No challenge is solved, clicked or bypassed. If it does not clear, that is the
 * result. Nothing in the project is modified: the 44 probe is a throwaway install
 * under the OS temp directory.
 *
 * Usage: node scripts/d6-electron-compare.js [--reps=3] [--timeout=30000]
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ARGS = process.argv.slice(2)
const REPS = (function () { const m = ARGS.find(a => a.indexOf('--reps=') === 0); return m ? Math.max(1, Math.min(5, parseInt(m.slice(7), 10))) : 3 })()
const TIMEOUT = (function () { const m = ARGS.find(a => a.indexOf('--timeout=') === 0); return m ? Math.max(5000, Math.min(120000, parseInt(m.slice(10), 10))) : 30000 })()
const URL_UNDER_TEST = 'https://novellive.com/'
const CHALLENGE_RE = /just a moment|attention required|checking your browser|verifying you are human|enable javascript and cookies/i
const sleep = ms => new Promise(r => setTimeout(r, ms))

const E44_DIR = path.join(os.tmpdir(), 'opencode', 'e44probe')

function electronBinary (pkgRoot) {
  try {
    const p = require.resolve('electron', { paths: [pkgRoot] })
    const loader = require(p)
    return typeof loader === 'string' ? loader : null
  } catch (e) { return null }
}

const MAIN_JS = [
  "const { app, BrowserWindow } = require('electron')",
  "app.commandLine.appendSwitch('disable-background-networking')",
  "app.whenReady().then(function () {",
  "  var win = new BrowserWindow({ width: 1200, height: 900, show: true })",
  "  win.loadURL(" + JSON.stringify(URL_UNDER_TEST) + ")",
  "  setInterval(function () {",
  "    try {",
  "      var t = win.webContents.getTitle()",
  "      var u = win.webContents.getURL()",
  "      process.stdout.write('TITLE=' + JSON.stringify(String(t || '')) + ' URL=' + JSON.stringify(String(u || '')) + '\\n')",
  "    } catch (e) { process.stdout.write('TITLE= ERROR=' + JSON.stringify(String(e && e.message)) + '\\n') }",
  "  }, 400)",
  "})"
].join('\n')

async function probe (bin, label, profileDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-el-' + label + '-'))
  fs.writeFileSync(path.join(dir, 'main.js'), MAIN_JS, 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'd6-' + label, version: '1.0.0', main: 'main.js'
  }), 'utf8')

  const t0 = Date.now()
  const proc = spawn(bin, ['.', '--user-data-dir=' + profileDir, '--no-first-run'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  proc.stdout.on('data', function (d) { stdout += String(d) })
  let clearedAt = null
  let sawChallenge = false
  let lastTitle = ''
  const timeline = []
  while (Date.now() - t0 < TIMEOUT) {
    await sleep(500)
    /* Last TITLE= line reported by the probe's own main process. */
    const lines = stdout.split(/\r?\n/).filter(function (l) { return l.indexOf('TITLE=') === 0 })
    let title = ''
    if (lines.length) {
      const last = lines[lines.length - 1]
      const m = last.match(/^TITLE=(.*?) URL=/)
      if (m) { try { title = JSON.parse(m[1]) } catch (e) { title = m[1] } }
    }
    if (title && title !== lastTitle) {
      timeline.push({ at: Date.now() - t0, title: title.slice(0, 90) })
      lastTitle = title
    }
    if (CHALLENGE_RE.test(title)) { sawChallenge = true; continue }
    if (title && !/^$/.test(title)) { clearedAt = Date.now() - t0; break }
  }
  try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }) } catch (e) {}
  await sleep(400)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch (e) {}
  return { runtime: label, clearedAtMs: clearedAt, sawChallenge: sawChallenge, finalTitle: lastTitle.slice(0, 100), timeline: timeline.slice(0, 10) }
}

async function main () {
  const e43 = require('electron') /* the project's own devDependency */
  const e44 = electronBinary(E44_DIR)
  const out = {
    ts: new Date().toISOString(),
    url: URL_UNDER_TEST,
    reps: REPS,
    timeoutMs: TIMEOUT,
    note: 'Read-only. No challenge solved, clicked or bypassed. Same minimal Electron main, fresh profile per run, headed, same machine/network. The Electron 44 probe is a throwaway install under the OS temp dir; the project dependency is untouched.',
    builds: {
      e43: { electron: '43.4.1', chromium: '150.0.7871.224', binary: String(e43).slice(0, 120) },
      e44: { electron: '44.9.1', chromium: '152.0.7977.167', binary: e44 ? String(e44).slice(0, 120) : null }
    },
    results: []
  }
  console.log('e43 binary:', e43)
  console.log('e44 binary:', e44)

  for (let rep = 1; rep <= REPS; rep++) {
    const p43 = path.join(os.tmpdir(), 'd6-e43-profile-' + rep + '-' + Date.now())
    const r43 = await probe(e43, 'e43-c150', p43)
    out.results.push(Object.assign({ rep: rep }, r43))
    console.log('rep ' + rep + ' e43/c150: cleared=' + r43.clearedAtMs + ' title=' + JSON.stringify(r43.finalTitle).slice(0, 55))

    if (e44) {
      const p44 = path.join(os.tmpdir(), 'd6-e44-profile-' + rep + '-' + Date.now())
      const r44 = await probe(e44, 'e44-c152', p44)
      out.results.push(Object.assign({ rep: rep }, r44))
      console.log('rep ' + rep + ' e44/c152: cleared=' + r44.clearedAtMs + ' title=' + JSON.stringify(r44.finalTitle).slice(0, 55))
    }
    await sleep(500)
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'd6-electron-compare.json'), JSON.stringify(out, null, 2))
  return 0
}

main().then(c => process.exit(c)).catch(function (e) { console.error(e); process.exit(2) })
