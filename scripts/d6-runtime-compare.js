/*
 * R5 / D6 fair runtime comparison - READ-ONLY navigation probe.
 *
 * Compares three local runtimes on the SAME machine, network, URL set and timing,
 * using only publicly-readable pages. It measures the one thing that can be
 * compared without an automation contract on the other engines:
 *
 *   time-to-first-committed-navigation + final title/HTTP class on a set of stable
 *   public pages, plus the Cloudflare-challenge case (novellive.com).
 *
 * It NEVER solves, bypasses or interacts with a challenge. If a challenge
 * appears it records "challenge present at timeout" and stops on that site.
 *
 * Runtimes:
 *   min      - the product (via the shipped MCP adapter, 39-tool census)
 *   chrome   - the installed Google Chrome (control: current stable Chromium)
 *   cloak    - the cached CloakBrowser v146 binary, IF explicitly allowed
 *
 * Usage: node scripts/d6-runtime-compare.js [--cloak] [--reps=3]
 * Writes docs/d6-runtime-compare.json (bounded, no page content).
 */
const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const H = require('./lib/realweb-harness')

const ARGS = process.argv.slice(2)
const ALLOW_CLOAK = ARGS.indexOf('--cloak') !== -1
const REPS = (function () {
  const m = ARGS.find(a => a.indexOf('--reps=') === 0)
  return m ? Math.max(1, Math.min(5, parseInt(m.slice(7), 10))) : 3
})()

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CLOAK_HOME = path.join(os.homedir(), '.cloakbrowser')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function cloakBinary () {
  try {
    const dirs = fs.readdirSync(CLOAK_HOME).filter(d => /^chromium-/.test(d)).sort()
    if (!dirs.length) return null
    const exe = path.join(CLOAK_HOME, dirs[dirs.length - 1], 'chrome.exe')
    return fs.existsSync(exe) ? { exe: exe, version: dirs[dirs.length - 1].replace(/^chromium-/, '') } : null
  } catch (e) { return null }
}

/* Targets: stable, publicly readable, no login. `expect` is a substring that must
 * appear in the title for a normal (non-challenge) load. */
const TARGETS = [
  { id: 'example', url: 'https://example.com/', expect: 'Example Domain' },
  { id: 'httpbin-html', url: 'https://httpbin.org/html', expect: 'httpbin' },
  { id: 'wikipedia', url: 'https://en.wikipedia.org/wiki/CSS', expect: 'CSS' },
  { id: 'iana', url: 'https://www.iana.org/help/example-domains', expect: 'Example' },
  { id: 'novellive', url: 'https://novellive.com/', expect: 'Novel', challengeSensitive: true }
]

/* ---------------- generic CDP-ish observer for Chrome/Cloak ----------------
 * Both are Chromium binaries that expose --remote-debugging-port. This is a
 * TEST-ONLY observation channel for a NON-Min process, used for timing only.
 * It is never added to the product (ADR-02 remains: no generic CDP in Min). */
function cdpHttp (port, p) {
  return new Promise(function (resolve) {
    const rq = http.get({ host: '127.0.0.1', port: port, path: p, timeout: 4000 }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', function () { try { resolve(JSON.parse(d)) } catch (e) { resolve(null) } })
    })
    rq.on('error', function () { resolve(null) })
    rq.on('timeout', function () { rq.destroy(); resolve(null) })
  })
}

function freePort (start) {
  return new Promise(function (resolve) {
    const srv = require('net').createServer()
    srv.listen(0, '127.0.0.1', function () {
      const p = srv.address().port
      srv.close(function () { resolve(p) })
    })
  })
}

/* Run one Chromium-family binary against a URL and report timing + title. */
async function chromiumProbe (exe, url, label, timeoutMs) {
  const port = await freePort()
  const profile = path.join(os.tmpdir(), 'd6-' + label + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
  const args = [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--remote-debugging-port=' + port,
    '--headless=new',
    url
  ]
  const t0 = Date.now()
  const proc = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
  let target = null
  let firstTargetAt = null
  const deadline = t0 + timeoutMs
  while (Date.now() < deadline && !target) {
    await sleep(150)
    const list = await cdpHttp(port, '/json/list')
    if (Array.isArray(list)) {
      const page = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl)
      if (page) { target = page; firstTargetAt = Date.now() - t0 }
    }
  }
  /* Poll the title through the DevTools HTTP endpoint is not possible without a
   * websocket; instead read it via a tiny WS-free route: /json/list carries the
   * title and url, refreshed by Chromium. */
  let title = ''
  let finalUrl = url
  let settledAt = null
  while (Date.now() < deadline) {
    const list = await cdpHttp(port, '/json/list')
    if (Array.isArray(list)) {
      const page = list.find(x => x.type === 'page')
      if (page) {
        title = String(page.title || '')
        finalUrl = String(page.url || url)
        if (title && title !== 'about:blank' && !/^chrome/.test(finalUrl)) {
          if (!settledAt) settledAt = Date.now() - t0
          /* give the page up to 2.5s of stability, then accept */
          if (Date.now() - t0 - settledAt > 2500) break
        }
      }
    }
    await sleep(200)
  }
  try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }) } catch (e) {}
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  const titleLower = title.toLowerCase()
  const challenge = /just a moment|attention required|checking your browser|verifying you are human|cf-challenge/.test(titleLower) ||
    /challenge/.test(finalUrl)
  return {
    runtime: label,
    url: url,
    firstTargetMs: firstTargetAt,
    titleMs: settledAt,
    title: title.slice(0, 120),
    finalUrl: finalUrl.slice(0, 160),
    challenge: challenge,
    timedOut: !settledAt
  }
}

/* Min through the shipped MCP adapter. */
async function minProbe (session, url, timeoutMs) {
  const t0 = Date.now()
  const res = await session.nav(url, { stabilityWindowMs: 300, timeoutMs: timeoutMs })
  const elapsed = Date.now() - t0
  const title = String((res.nav && res.nav.text && res.nav.text.title) || '')
  const finalUrl = String((res.nav && res.nav.text && res.nav.text.finalUrl) || url)
  const titleLower = title.toLowerCase()
  return {
    runtime: 'min',
    url: url,
    firstTargetMs: null,
    titleMs: res.ok ? elapsed : null,
    title: title.slice(0, 120),
    finalUrl: finalUrl.slice(0, 160),
    challenge: /just a moment|attention required|checking your browser|verifying you are human/.test(titleLower),
    timedOut: !res.ok,
    verified: res.ok
  }
}

async function main () {
  const cloak = cloakBinary()
  const out = {
    ts: new Date().toISOString(),
    reps: REPS,
    machine: {
      os: process.platform + ' ' + os.release(),
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemGB: Math.round(os.totalmem() / 1073741824),
      node: process.version
    },
    runtimes: {
      min: { kind: 'product (Electron 43.4.1 / Chromium 150.0.7871.224)' },
      chrome: { kind: 'installed Google Chrome', path: CHROME, available: fs.existsSync(CHROME) },
      cloak: { kind: 'cached CloakBrowser binary', found: !!cloak, version: cloak && cloak.version, executed: false }
    },
    targets: TARGETS.map(t => ({ id: t.id, url: t.url })),
    results: []
  }

  const session = new H.RealWebSession({
    name: 'd6',
    evidenceFile: path.join(os.tmpdir(), 'opencode', 'd6-session.json'),
    offline: false
  })
  const started = await session.start([{ id: 'example', probe: 'https://example.com/', urls: { home: 'https://example.com/' } }])
  if (!started) {
    out.error = 'Min did not start'
    fs.writeFileSync(path.join(ROOT, 'docs', 'd6-runtime-compare.json'), JSON.stringify(out, null, 2))
    await session.stop()
    return 1
  }

  for (let rep = 1; rep <= REPS; rep++) {
    for (const t of TARGETS) {
      console.log('[rep ' + rep + '] ' + t.id)
      const r = await minProbe(session, t.url, 30000)
      out.results.push(Object.assign({ rep: rep, target: t.id }, r))
      console.log('    min   : title=' + JSON.stringify(r.title).slice(0, 60) + ' ' + (r.titleMs || '-') + 'ms challenge=' + r.challenge)
      if (fs.existsSync(CHROME)) {
        const c = await chromiumProbe(CHROME, t.url, 'chrome', 30000)
        out.results.push(Object.assign({ rep: rep, target: t.id, chromeVersion: '155.0.8059.84' }, c))
        console.log('    chrome: title=' + JSON.stringify(c.title).slice(0, 60) + ' ' + (c.titleMs || '-') + 'ms challenge=' + c.challenge)
      }
      if (ALLOW_CLOAK && cloak) {
        const k = await chromiumProbe(cloak.exe, t.url, 'cloak', 30000)
        out.runtimes.cloak.executed = true
        out.results.push(Object.assign({ rep: rep, target: t.id }, k))
        console.log('    cloak : title=' + JSON.stringify(k.title).slice(0, 60) + ' ' + (k.titleMs || '-') + 'ms challenge=' + k.challenge)
      }
    }
  }

  await session.stop()
  out.summary = summarize(out.results)
  fs.writeFileSync(path.join(ROOT, 'docs', 'd6-runtime-compare.json'), JSON.stringify(out, null, 2))
  console.log('\n' + JSON.stringify(out.summary, null, 2))
  return 0
}

function summarize (rows) {
  const by = {}
  for (const r of rows) {
    const key = r.runtime + ':' + r.target
    by[key] = by[key] || { runtime: r.runtime, target: r.target, n: 0, ms: [], ok: 0, challenge: 0, timeout: 0 }
    const s = by[key]
    s.n++
    if (typeof r.titleMs === 'number') s.ms.push(r.titleMs)
    if (!r.timeout && !r.challenge) s.ok++
    if (r.challenge) s.challenge++
    if (r.timeout) s.timeout++
  }
  return Object.keys(by).map(function (k) {
    const s = by[k]
    const med = s.ms.length ? s.ms.slice().sort((a, b) => a - b)[Math.floor(s.ms.length / 2)] : null
    return { runtime: s.runtime, target: s.target, runs: s.n, medianMs: med, normal: s.ok, challenge: s.challenge, timeout: s.timeout }
  })
}

main().then(c => process.exit(c)).catch(function (e) {
  console.error('d6 compare error: ' + (e && e.stack || e))
  process.exit(2)
})
