#!/usr/bin/env node
/*
 * P1-01D waits + ad-blocker-integrity probe.
 *
 * Sections:
 *   waits:    selector_visible for a delayed element (900ms), selector
 *             timeout (never-appearing selector), network_idle across a
 *             delayed XHR (starts 4s post-load, server holds 800ms),
 *             network_idle on an idle page, and bridge responsiveness DURING
 *             a running wait (status round-trip concurrent with a pending
 *             browser_wait).
 *   blocker:  ad-blocker integrity - loading a fixture that requests
 *             https://www.google-analytics.com/analytics.js (a URL in the
 *             vendored EasyList+EasyPrivacy file, third-party from file://)
 *             must increase both settings' persisted filteringBlockedCount
 *             and the bridge's observed request total. Structural check: the
 *             built bundle registers exactly ONE onBeforeRequest handler
 *             (main/filtering.js).
 *
 * No live pages are contacted except google-analytics.com URLs which are
 * expected to be BLOCKED before any network activity happens.
 */

const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-waits-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-waits-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE + '-development'

const results = []
const timings = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail).slice(0, 220) })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail).slice(0, 170) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function rmrf (target) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch (e) { /* retry */ }
    if (!fs.existsSync(target)) return true
    const until = Date.now() + 400
    while (Date.now() < until) { /* spin */ }
  }
  return !fs.existsSync(target)
}

const PAGE_WAIT =
  '<!doctype html><html><head><title>Wait Page</title></head><body>' +
  '<h1>Wait Page Heading</h1>' +
  '<button id="instant">Instant Button</button>' +
  '<div id="latehost"></div>' +
  '<script>' +
  'setTimeout(function () {' +
  '  var b = document.createElement("button");' +
  '  b.id = "latebtn"; b.textContent = "Late Button";' +
  '  document.getElementById("latehost").appendChild(b);' +
  '}, 900);' +
  'setTimeout(function () {' +
  '  fetch("/slowdata").then(function (r) { return r.text(); }).then(function (t) {' +
  '    var d = document.createElement("div"); d.id = "datahost"; d.textContent = "len:" + t.length;' +
  '    document.body.appendChild(d);' +
  '  });' +
  '}, 4000);' +
  '</script></body></html>'

const PAGE_NONE =
  '<!doctype html><html><head><title>None Page</title></head><body>' +
  '<h1>None Page Heading</h1><div id="static">nothing late here</div></body></html>'

const PAGE_TRACKER =
  '<!doctype html><html><head><title>Tracker Probe Page</title></head><body>' +
  '<h1>Tracker Probe Heading</h1>' +
  '<img src="https://www.google-analytics.com/analytics.js" alt="tracker probe">' +
  '<script src="https://ssl.google-analytics.com/ga.js"></script>' +
  '</body></html>'

let probeProc = null

function rpc (port, token, method, params, id) {
  return new Promise(function (resolve) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: id || 'p', method, params })
    const t0 = Date.now()
    const req = http.request({
      host: '127.0.0.1', port, path: '/rpc', method: 'POST',
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      headersTimeout: 8000, requestTimeout: 40000
    }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d, ms: Date.now() - t0 }))
    })
    req.on('error', e => resolve({ status: 0, error: e.code, body: '', ms: Date.now() - t0 }))
    req.setTimeout(42000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', body: '', ms: Date.now() - t0 }) })
    req.write(body)
    req.end()
  })
}
async function rpcJ (port, token, method, params, id) {
  const r = await rpc(port, token, method, params, id)
  let result = null
  let error = null
  try { const f = JSON.parse(r.body); result = f.result !== undefined ? f.result : null; error = f.error || null } catch (e) { /* raw */ }
  timings.push({ method, ms: r.ms, status: r.status })
  return { status: r.status, rawBody: r.body, result, error, ms: r.ms }
}

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  try { fs.rmSync(path.join(EFFECTIVE_PROFILE, 'policy.json'), { force: true }) } catch (e) { /* ignore */ }
  fs.writeFileSync(path.join(RUN_DIR, 'wait.html'), PAGE_WAIT, 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'none.html'), PAGE_NONE, 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'tracker.html'), PAGE_TRACKER, 'utf8')
  const fileUrl = n => 'file:///' + path.join(RUN_DIR, n + '.html').replace(/\\/g, '/')

  /* loopback server with a deliberately slow JSON endpoint + wait fixtures */
  const WAITPAGE_HTTP =
    '<!doctype html><html><head><title>Wait Page HTTP</title></head><body>' +
    '<h1>Wait Page Heading</h1><div id="latehost"></div>' +
    '<script>' +
    'setTimeout(function () {' +
    '  var b = document.createElement("button");' +
    '  b.id = "latebtn"; b.textContent = "Late Button";' +
    '  document.getElementById("latehost").appendChild(b);' +
    '}, 900);' +
    'setTimeout(function () {' +
    '  fetch("/slowdata").then(function (r) { return r.text(); }).then(function (t) {' +
    '    var d = document.createElement("div"); d.id = "datahost"; d.textContent = "len:" + t.length;' +
    '    document.body.appendChild(d);' +
    '  });' +
    '}, 1200);' +
    '</script></body></html>'
  const server = http.createServer(function (req, res) {
    const p = (req.url || '/').split('?')[0]
    if (p === '/slowdata') {
      setTimeout(function () {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('x'.repeat(64))
      }, 800)
      return
    }
    if (p === '/waitpage') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(WAITPAGE_HTTP)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><head><title>Idle Page</title></head><body><h1>Idle Heading</h1></body></html>')
  })
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
  const lport = server.address().port

  const bin = require('electron')
  const args = ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', fileUrl('wait')]
  const proc = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  probeProc = proc
  const discPath = path.join(EFFECTIVE_PROFILE, 'agent-rpc.json')
  let disc = null
  const started = Date.now()
  while (Date.now() - started < 60000) {
    await sleep(400)
    try { disc = JSON.parse(fs.readFileSync(discPath, 'utf8')); break } catch (e) { /* wait */ }
  }
  if (!disc) {
    check('bridge discovery appeared', false, 'no agent-rpc.json within 60s')
    printSummary(2)
    try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)]) } catch (e) { /* ignore */ }
    process.exit(2)
  }
  check('bridge discovery appeared', true)
  const u = new URL(disc.url)
  const port = u.port
  const token = disc.token
  await sleep(2500) /* settle the initial load */

  const tabsR = await rpcJ(port, token, 'browser_tabs', {}, 't0')
  const tabId = (tabsR.result.tabs.find(t => t.active) || tabsR.result.tabs[0]).tabId
  check('startup tab enumerated', !!tabId)
  /* deterministic start: navigate the ACTIVE tab to the wait fixture */
  const nav0 = await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('wait'), stabilityWindowMs: 200 }, 'n0')
  check('initial navigation to wait fixture verified', nav0.status === 200 && nav0.result && nav0.result.verified === true, JSON.stringify(nav0.result && { v: nav0.result.verified, url: nav0.result.finalUrl }))

  /* 1. selector_visible for the delayed button */
  const w1 = await rpcJ(port, token, 'browser_wait', { tabId, until: 'selector_visible', selector: '#latebtn', timeoutMs: 8000 }, 'w1')
  check('selector_visible: delayed element satisfied with honest waitedMs',
    w1.status === 200 && w1.result && w1.result.satisfied === true && w1.result.waitedMs >= 600 && w1.result.waitedMs <= 7500,
    JSON.stringify(w1.result))

  /* 2. selector timeout */
  const w2 = await rpcJ(port, token, 'browser_wait', { tabId, until: 'selector_visible', selector: '#never-in-page', timeoutMs: 2000 }, 'w2')
  check('selector_visible: timeout -> satisfied=false with reason',
    w2.status === 200 && w2.result && w2.result.satisfied === false && w2.result.waitedMs >= 1900 && typeof w2.result.reason === 'string',
    JSON.stringify(w2.result))

  /* 3. network_idle across a delayed XHR on an HTTP page (fetch starts 1.2s
   * post-load; server holds 800ms): the wait must NOT report idle until the
   * XHR finished, and observedTotal must grow (blocker handler integration). */
  const netBeforeXHR = (await rpcJ(port, token, 'browser_status', {}, 'nbx')).result.bridge.net
  const nav2 = await rpcJ(port, token, 'browser_navigate', { tabId, url: 'http://127.0.0.1:' + lport + '/waitpage', stabilityWindowMs: 200 }, 'n2')
  check('re-navigated to http wait page', nav2.status === 200 && nav2.result && nav2.result.verified === true, JSON.stringify(nav2.result && { verified: nav2.result.verified, url: nav2.result.finalUrl }))
  const w3 = await rpcJ(port, token, 'browser_wait', { tabId, until: 'network_idle', timeoutMs: 15000 }, 'w3')
  const netAfterXHR = (await rpcJ(port, token, 'browser_status', {}, 'nax')).result.bridge.net
  check('network_idle: delayed XHR covered (satisfied after in-flight window, not instantly)',
    w3.status === 200 && w3.result && w3.result.satisfied === true && w3.result.waitedMs >= 1000,
    JSON.stringify({ r: w3.result, observed: netBeforeXHR.observedTotal + '->' + netAfterXHR.observedTotal }))
  check('network_idle: blocker handler observed the HTTP requests (integration proof)',
    netAfterXHR.observedTotal > netBeforeXHR.observedTotal,
    netBeforeXHR.observedTotal + '->' + netAfterXHR.observedTotal)

  /* 4. network_idle on an idle http page returns promptly */
  const navIdle = await rpcJ(port, token, 'browser_navigate', { tabId, url: 'http://127.0.0.1:' + lport + '/idle', stabilityWindowMs: 200 }, 'n3')
  check('idle http page navigated', navIdle.status === 200 && navIdle.result && navIdle.result.verified === true, JSON.stringify(navIdle.result && { v: navIdle.result.verified, url: navIdle.result.finalUrl }))
  const w4 = await rpcJ(port, token, 'browser_wait', { tabId, until: 'network_idle', timeoutMs: 8000 }, 'w4')
  check('network_idle: idle page satisfied promptly (<3500ms)',
    w4.status === 200 && w4.result && w4.result.satisfied === true && w4.result.waitedMs < 3500,
    JSON.stringify(w4.result))

  /* 5. bridge responsiveness DURING a pending wait */
  const w5P = rpcJ(port, token, 'browser_wait', { tabId, until: 'selector_visible', selector: '#never-in-page', timeoutMs: 6000 }, 'w5')
  await sleep(1200)
  const statusDuring = await rpcJ(port, token, 'browser_status', {}, 'st5')
  check('bridge responsive during pending wait (status answers while wait pending)',
    statusDuring.status === 200 && statusDuring.ms < 1500, 'statusMs=' + statusDuring.ms)
  const w5 = await w5P
  check('pending wait still completes honestly after concurrency check',
    w5.status === 200 && w5.result && w5.result.satisfied === false, JSON.stringify(w5.result))

  /* ---------- ad-blocker integrity ---------- */
  const stBefore = await rpcJ(port, token, 'browser_status', {}, 'stb')
  const nbBefore = stBefore.result.bridge.net
  const blockedBefore = nbBefore.blockedTotal
  check('pre-check: only one onBeforeRequest registrant in the bundle',
    (function () {
      const bundle = fs.readFileSync(path.join(ROOT, 'main.build.js'), 'utf8')
      const matches = bundle.match(/webRequest\.onBeforeRequest\(/g) || []
      return matches.length === 1
    })(), 'registrants must be exactly 1')
  check('pre-check: bridge net counters initialized', typeof nbBefore.inflight === 'number' && nbBefore.observedTotal > 0,
    JSON.stringify(nbBefore))

  const navTr = await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('tracker'), stabilityWindowMs: 300 }, 'ntr')
  await sleep(1500)
  const stAfter = await rpcJ(port, token, 'browser_status', {}, 'sta')
  const nbAfter = stAfter.result.bridge.net
  check('ad-blocker integrity: blocked count INCREASED after tracker URLs (filtering pipeline alive)',
    typeof blockedBefore === 'number' && typeof nbAfter.blockedTotal === 'number' && nbAfter.blockedTotal > blockedBefore,
    'before=' + blockedBefore + ' after=' + nbAfter.blockedTotal)
  check('ad-blocker integrity: observed request total grew (handler still sees requests)',
    nbAfter.observedTotal > nbBefore.observedTotal, 'before=' + nbBefore.observedTotal + ' after=' + nbAfter.observedTotal)

  server.close()
  try { server.closeAllConnections() } catch (e) { /* ignore */ }
}

function printSummary (code) {
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ ranAt: new Date().toISOString(), passed: results.filter(r => r.pass).length, total: results.length, timings, results }, null, 2), 'utf8')
  console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed')
  console.log('timings: ' + JSON.stringify(timings))
  return code
}
process.on('exit', function () { try { rmrf(RUN_DIR) } catch (e) { /* ignore */ } })
main().then(function () {
  const code = printSummary(0)
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (e) { /* ignore */ }
  process.exit(code)
}).catch(function (e) {
  console.error('waits probe error: ' + e.message)
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (ignored) { /* ignore */ }
  printSummary(2)
  process.exit(2)
})
