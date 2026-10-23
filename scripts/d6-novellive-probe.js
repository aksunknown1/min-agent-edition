/*
 * R5 / D6 - Novellive challenge-clearance measurement (READ-ONLY).
 *
 * Phase C claimed: fresh Chrome cleared the Cloudflare challenge in ~3s while Min
 * never cleared it in 90s. This re-measures that claim on TODAY's binaries with a
 * fresh profile for each runtime, polling the title until it either leaves the
 * challenge state or the timeout expires.
 *
 * It does NOT solve, click, or bypass anything. If the challenge requires human
 * interaction it stays unsolved and that is recorded honestly.
 *
 * Usage: node scripts/d6-novellive-probe.js [--reps=2] [--timeout=45000]
 */
const { spawn, spawnSync } = require('child_process')
const http = require('http')
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const H = require('./lib/realweb-harness')

const ROOT = path.resolve(__dirname, '..')
const ARGS = process.argv.slice(2)
const REPS = (function () { const m = ARGS.find(a => a.indexOf('--reps=') === 0); return m ? Math.max(1, Math.min(4, parseInt(m.slice(7), 10))) : 2 })()
const TIMEOUT = (function () { const m = ARGS.find(a => a.indexOf('--timeout=') === 0); return m ? Math.max(5000, Math.min(120000, parseInt(m.slice(10), 10))) : 45000 })()
const URL_UNDER_TEST = 'https://novellive.com/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const CHALLENGE_RE = /just a moment|attention required|checking your browser|verifying you are human|enable javascript and cookies/i

function httpJson (port, p) {
  return new Promise(function (resolve) {
    const rq = http.get({ host: '127.0.0.1', port: port, path: p, timeout: 3000 }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', function () { try { resolve(JSON.parse(d)) } catch (e) { resolve(null) } })
    })
    rq.on('error', () => resolve(null))
    rq.on('timeout', () => { rq.destroy(); resolve(null) })
  })
}

function freePort () {
  return new Promise(function (resolve) {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

/* Chrome-family runtime: fresh profile, poll /json/list titles until clear/timeout. */
async function chromiumClearance (exe, label) {
  const port = await freePort()
  const profile = path.join(os.tmpdir(), 'd6-nov-' + label + '-' + Date.now())
  const t0 = Date.now()
  const proc = spawn(exe, [
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync',
    '--remote-debugging-port=' + port,
    '--headless=new',
    URL_UNDER_TEST
  ], { windowsHide: true, stdio: 'ignore' })

  const timeline = []
  let clearedAt = null
  let lastTitle = ''
  let sawChallenge = false
  while (Date.now() - t0 < TIMEOUT) {
    await sleep(500)
    const list = await httpJson(port, '/json/list')
    if (!Array.isArray(list)) continue
    const page = list.find(x => x.type === 'page')
    if (!page) continue
    const title = String(page.title || '')
    const url = String(page.url || '')
    if (title !== lastTitle) {
      timeline.push({ at: Date.now() - t0, title: title.slice(0, 80), url: url.slice(0, 100) })
      lastTitle = title
    }
    if (CHALLENGE_RE.test(title)) { sawChallenge = true; continue }
    if (title && title !== 'about:blank' && !/^chrome/.test(url)) {
      clearedAt = Date.now() - t0
      break
    }
  }
  try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }) } catch (e) {}
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  return { runtime: label, clearedAtMs: clearedAt, sawChallenge: sawChallenge, finalTitle: lastTitle.slice(0, 100), timeline: timeline.slice(0, 12), timeoutMs: TIMEOUT }
}

/* Min through the shipped adapter: poll browser_state.title. */
async function minClearance (session) {
  const t0 = Date.now()
  const nav = await session.call('browser_navigate', { tabId: session.tid, url: URL_UNDER_TEST, stabilityWindowMs: 300 }, 30000)
  const timeline = []
  let clearedAt = null
  let sawChallenge = false
  let lastTitle = ''
  while (Date.now() - t0 < TIMEOUT) {
    await sleep(500)
    const st = await session.call('browser_state', { tabId: session.tid })
    const title = String((st.text && st.text.title) || (nav.text && nav.text.title) || '')
    if (title !== lastTitle) {
      timeline.push({ at: Date.now() - t0, title: title.slice(0, 80) })
      lastTitle = title
    }
    if (CHALLENGE_RE.test(title)) { sawChallenge = true; continue }
    if (title && !/^about:blank$/.test(title)) { clearedAt = Date.now() - t0; break }
  }
  return { runtime: 'min', clearedAtMs: clearedAt, sawChallenge: sawChallenge, finalTitle: lastTitle.slice(0, 100), timeline: timeline.slice(0, 12), timeoutMs: TIMEOUT }
}

async function main () {
  const out = {
    ts: new Date().toISOString(),
    url: URL_UNDER_TEST,
    reps: REPS,
    timeoutMs: TIMEOUT,
    note: 'Read-only observation. No challenge was solved, clicked or bypassed. A challenge that requires human interaction stays unsolved by design.',
    runtimes: {
      min: 'Electron 43.4.1 / Chromium 150.0.7871.224',
      chrome: 'installed Google Chrome 155.0.8059.84'
    },
    results: []
  }
  for (let rep = 1; rep <= REPS; rep++) {
    const session = new H.RealWebSession({ name: 'd6nov', evidenceFile: path.join(os.tmpdir(), 'opencode', 'd6nov.json'), offline: false })
    const ok = await session.start([{ id: 'example', probe: 'https://example.com/', urls: { home: 'https://example.com/' } }])
    if (!ok) { out.error = 'Min failed to start'; await session.stop(); break }
    const m = await minClearance(session)
    out.results.push(Object.assign({ rep: rep }, m))
    console.log('rep ' + rep + ' min   : cleared=' + (m.clearedAtMs === null ? 'NO' : m.clearedAtMs + 'ms') + ' title=' + JSON.stringify(m.finalTitle).slice(0, 60) + ' sawChallenge=' + m.sawChallenge)
    await session.stop()

    if (fs.existsSync(CHROME)) {
      const c = await chromiumClearance(CHROME, 'chrome')
      out.results.push(Object.assign({ rep: rep }, c))
      console.log('rep ' + rep + ' chrome: cleared=' + (c.clearedAtMs === null ? 'NO' : c.clearedAtMs + 'ms') + ' title=' + JSON.stringify(c.finalTitle).slice(0, 60) + ' sawChallenge=' + c.sawChallenge)
    }
    await sleep(500)
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'd6-novellive-probe.json'), JSON.stringify(out, null, 2))
  return 0
}

main().then(c => process.exit(c)).catch(function (e) { console.error(e); process.exit(2) })
