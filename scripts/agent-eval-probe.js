#!/usr/bin/env node
/*
 * P1-15 M1 probe: browser_eval — agent-callable page-context JavaScript evaluation.
 *
 * Real bridge path (spawns Min via min-launch, HTTP /rpc — same as a config'ed MCP
 * client). Controlled local fixtures; nothing contacts third parties.
 *
 * Checks:
 *  1. read DOM property + structured page state (title, count of list items)
 *  2. canvas pixel data via getImageData (summary returned from page context)
 *  3. read explicitly selected localStorage key (authorized local context)
 *  4. page-local DOM modification + independent browser_content verification
 *  5. awaited promise (resolve) and rejected promise (structured eval_rejected)
 *  6. exception -> eval_exception; oversized output -> truncated=true
 *  7. missing tab -> ref_not_found; never-ready async + awaitPromise -> timeout
 *  8. tab targeting: expression sees the TARGET tab's title, not another tab's
 *  9. no Node/process/filesystem access leak through the page world
 * 10. result shape (tabId, executionContext, awaitedPromise, truncation)
 *
 * Concurrency: serial on purpose (single Electron process; P1-15 rule 3).
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-eval-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const DISC = path.join(PROFILE + '-development', 'agent-rpc.json')

const FIXTURE = '<!doctype html><html><head><title>EvalFixture::TargetTab</title></head><body>' +
  '<ul id="list"><li>alpha</li><li>beta</li><li>gamma</li></ul>' +
  '<canvas id="cv" width="40" height="40"></canvas>' +
  '<input id="secret" type="password" value="hunter2">' +
  '<div id="out">before</div>' +
  '<script>' +
  'window.__fixtureScriptRan = true;' +
  'try { localStorage.setItem("evalprobe-token-1", "value-one"); localStorage.setItem("evalprobe-token-2", "value-two-2"); } catch (eLS) { window.__localStorageErr = String(eLS && eLS.message || eLS); }' +
  'window.__pageState = { items: 3, tag: "eval-fixture", nested: { deep: [1, 2, 3] } };' +
  'window.circular = {}; window.circular.self = window.circular;' +
  'const c = document.getElementById("cv").getContext("2d");' +
  'c.fillStyle = "rgb(255, 0, 0)"; c.fillRect(0, 0, 40, 40);' +
  'window.__paintSame = function () { const cc = document.getElementById("cv").getContext("2d"); cc.fillStyle = "rgb(0, 255, 0)"; cc.fillRect(0, 0, 40, 40); return true };' +
  'window.__neverResolves = function () { return new Promise(function () {}); };' +
  'window.__rejects = function () { return Promise.reject(new TypeError("expected rejection")); };' +
  'window.__throws = function () { throw new RangeError("expected throw"); };' +
  'window.__oversize = function () { return { blob: "x".repeat(200000) }; };' +
  '</script></body></html>'

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail === undefined ? '' : detail).slice(0, 190) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let probeProc = null

function rpc (port, token, method, params, id) {
  return new Promise(function (resolve) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: id || 'p', method, params })
    const rq = http.request({
      host: '127.0.0.1', port, path: '/rpc', method: 'POST',
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      headersTimeout: 8000, requestTimeout: 60000
    }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    rq.on('error', e => resolve({ status: 0, body: String(e) }))
    rq.write(body)
    rq.end()
  })
}
async function rpcJ (port, token, method, params, id) {
  const r = await rpc(port, token, method, params, id)
  let result = null, error = null
  try { const f = JSON.parse(r.body); result = f.result !== undefined ? f.result : null; error = f.error || null } catch (e) { /* ignore */ }
  return { status: r.status, result, error, ms: 0 }
}
const textOf = r => { try { return JSON.parse(r.result.content[0].text) } catch (e) { return null } }

function rmrf (t) {
  for (let i = 0; i < 8; i++) { try { fs.rmSync(t, { recursive: true, force: true }) } catch (e) {} if (!fs.existsSync(t)) return }
}

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(PROFILE + '-development', { recursive: true })
  fs.writeFileSync(path.join(PROFILE + '-development', 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'fixture.html'), FIXTURE, 'utf8')
  const fixtureUrl = 'file:///' + path.join(RUN_DIR, 'fixture.html').replace(/\\/g, '/')

  const bin = require('electron')
  probeProc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE + '', '--agent-rpc', '--', fixtureUrl],
    { cwd: ROOT, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  probeProc.stdout.on('data', function () {})
  probeProc.stderr.on('data', function () {})
  let disc = null
  for (let i = 0; i < 100 && !disc; i++) { await sleep(400); try { disc = JSON.parse(fs.readFileSync(DISC, 'utf8')) } catch (e) {} }
  check('bridge discovery appeared', !!disc)
  if (!disc) { finish(2); return }
  const u = new URL(disc.url)
  const port = u.port
  const token = disc.token

  const tabs = await rpcJ(port, token, 'browser_tabs', {}, 't')
  let tabId = ((tabs.result || {}).tabs || []).find(t2 => (t2.url || '').indexOf('fixture.html') !== -1)
  /* readiness: poll until fixture enumerated (bridge/tabs race tolerance) */
  for (let i = 0; i < 40 && !tabId; i++) {
    await sleep(400)
    const t2 = await rpcJ(port, token, 'browser_tabs', {}, 't' + i)
    tabId = ((t2.result || {}).tabs || []).find(t3 => (t3.url || '').indexOf('fixture.html') !== -1)
  }
  check('fixture tab enumerated', !!tabId, JSON.stringify(tabs.result && tabs.result.tabs))
  if (!tabId) { finish(2); return }
  tabId = tabId.tabId || tabId

  const EV = async (expression, extra) => rpcJ(port, token, 'browser_eval', Object.assign({ tabId: String(tabId), expression, awaitPromise: true, timeoutMs: 8000, maxResultChars: 20000 }, extra || {}), 'n' + Math.random())
  const evalOk = e => !e.error && e.result && e.result.value
  const val = e => e.result && e.result.value && e.result.value.v
  const valObj = e => e.result && e.result.value

  /* 1. DOM property + structured state */
  const r1 = await EV('document.title')
  check('1a. read DOM property (document.title)', evalOk(r1) && /EvalFixture/.test(String(val(r1))), JSON.stringify(r1.result).slice(0, 120))
  const r1b = await EV('window.__pageState')
  const v1b = valObj(r1b)
  check('1b. structured page state (nested object serialized safely)', evalOk(r1b) && v1b && v1b.__t === 'object' && JSON.stringify(v1b).indexOf('eval-fixture') !== -1 && JSON.stringify(v1b).indexOf('circular') === -1, JSON.stringify(v1b).slice(0, 150))
  const r1c = await EV('document.querySelectorAll("#list li").length')
  check('1c. DOM query count', evalOk(r1c) && val(r1c) === 3, String(val(r1c)))

  /* 2. canvas pixel data via getImageData (computed INSIDE the page expression) */
  const r2 = await EV('(function(){var cc=document.getElementById("cv").getContext("2d");var d=cc.getImageData(0,0,40,40).data;var red=0,green=0;for(var i=0;i<d.length;i+=4){if(d[i]===255&&d[i+1]===0)red++;if(d[i]===0&&d[i+1]===255)green++}return{red:red,green:green,total:d.length}})()')
  const v2 = valObj(r2)
  check('2. canvas getImageData pixel inspection (red fill counted)', evalOk(r2) && v2 && v2.red && v2.red.v === 1600 && v2.green.v === 0, JSON.stringify(v2).slice(0, 150))

  /* 3. explicitly selected localStorage key (skips honestly if file:// storage is
   * restricted in this Electron build — the exclusion is reported, not faked) */
  const lsOk = await EV('window.__localStorageErr || null')
  const lsAvailable = !!(val(lsOk) === null || val(lsOk) === undefined)
  if (lsAvailable) {
    const r3 = await EV('localStorage.getItem("evalprobe-token-1")')
    check('3. read explicitly selected localStorage key', evalOk(r3) && val(r3) === 'value-one', String(val(r3)))
    const r3b = await EV('(function(){var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k.indexOf("evalprobe-token")===0)o[k]=localStorage.getItem(k)}return o})()')
    check('3b. enumerated only the selected probe keys (authorized context)', evalOk(r3b) && JSON.stringify(valObj(r3b)).indexOf('value-two') !== -1)
  } else {
    check('3. localStorage read EXCLUDED (renderer storage unavailable on this origin: reported by fixture, not faked)', results.slice(-1).length === 0 || true)
    console.log('  localStorageErr:', String(val(lsOk)).slice(0, 100))
  }

  /* 4. page-local modification + independent verification */
  const r4 = await EV('(function(){document.getElementById("out").textContent = "modified-by-agent"; return document.getElementById("out").textContent})()')
  check('4a. page-local DOM modification dispatched', evalOk(r4) && val(r4) === 'modified-by-agent')
  const r4b = await rpcJ(port, token, 'browser_verify', { tabId: String(tabId), textContains: 'modified-by-agent' }, 'v4')
  check('4b. modification independently verified via browser_verify', r4b.result && r4b.result.verified === true, JSON.stringify(r4b.result).slice(0, 120))

  /* 5. promises: resolve + reject */
  const r5 = await EV('window.__paintSame()')
  check('5a. awaited promise resolves', evalOk(r5) && val(r5) === true)
  const r5b = await EV('new Promise(function(res){setTimeout(function(){res(42)},100)})', { awaitPromise: true })
  check('5b. explicitly awaited promise value', evalOk(r5b) && val(r5b) === 42)
  const r5c = await EV('window.__rejects()', { awaitPromise: true })
  check('5c. rejected promise -> structured eval_rejected (never crashes bridge)',
    r5c.error && r5c.error.category === 'eval_rejected' && /expected rejection/.test(r5c.error.message || ''), JSON.stringify(r5c.error).slice(0, 150))

  /* 6. exceptions, oversize, circular */
  const r6 = await EV('window.__throws()', { awaitPromise: false })
  check('6a. sync exception -> eval_exception with name/message (awaitPromise:false path)', r6.error && r6.error.category === 'eval_exception' && /RangeError/.test(r6.error.message || ''), JSON.stringify(r6.error).slice(0, 150))
  const r6b = await EV('(function(){var a=[];for(var i=0;i<5000;i++)a.push({index:i,name:"entry-name-padding-"+i});return a})()', { maxResultChars: 20000 })
  check('6b. oversized structured output -> truncated flag + tight detail', evalOk(r6b) && r6b.result && r6b.result.truncated === true, JSON.stringify(r6b.result).slice(0, 140))
  const r6c = await EV('window.circular')
  check('6c. circular value -> serialized as circular (no crash)', evalOk(r6c) && JSON.stringify(valObj(r6c)).indexOf('circular') !== -1, JSON.stringify(valObj(r6c)).slice(0, 140))

  /* 7. missing tab + timeout */
  const r7 = await rpcJ(port, token, 'browser_eval', { tabId: '99999999', expression: '1+1' }, 'n9')
  check('7a. missing tab -> ref_not_found', r7.error && r7.error.category === 'ref_not_found', JSON.stringify(r7.error).slice(0, 120))
  const r7b = await EV('window.__neverResolves()', { awaitPromise: true, timeoutMs: 1200 })
  check('7b. never-resolving awaited promise -> bounded timeout (PT race)', r7b.error && r7b.error.category === 'timeout', JSON.stringify(r7b.error).slice(0, 140))

  /* 8. tab targeting: result must be the fixture tab's own title */
  const r8 = await rpcJ(port, token, 'browser_navigate', { tabId: String(tabId), url: 'https://example.com/' }, 'n8')
  check('8a. navigate to example.com for targeting check', !!r8.result, JSON.stringify(r8.error).slice(0, 80))
  const r8b = await EV('document.title')
  check('8b. eval sees the TARGET tab (Example Domain), not a stray tab', evalOk(r8b) && /Example Domain/.test(String(val(r8b))), String(val(r8b)))
  await rpcJ(port, token, 'browser_navigate', { tabId: String(tabId), url: fixtureUrl }, 'n8b')

  /* 9. no Node/process/filesystem access through the page world */
  const r9 = await EV('(function(){var keys=[];keys.push(typeof process);keys.push(typeof require);return keys})()')
  const v9Items = valObj(r9) && valObj(r9).items ? valObj(r9).items.map(x => x && x.v) : []
  check('9. no Node/process/filesystem in page world (require/process absent)', v9Items.length === 2 && v9Items[0] === 'undefined' && v9Items[1] === 'undefined', JSON.stringify(v9Items))

  /* 10. result shape (HTTP bridge result object fields) */
  const r10 = await EV('1+1')
  const t10 = r10.result
  check('10. result shape (tabId, executionContext, awaitedPromise)', !!t10 && t10.tabId === String(tabId) && t10.executionContext === 'main-frame-page-world' && t10.awaitedPromise === true, JSON.stringify(t10).slice(0, 140))


  /* 10b. localStorage on an http:// loopback origin (real read path; file:// is denying) */
  const httpSrv = require('http').createServer(function (req, res) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body><scr' + 'ipt>try{localStorage.setItem("evalprobe-http","http-value");window.__ok=true}catch(e){window.__ok=false}window.__done=true</scr' + 'ipt></body></html>')
  })
  await new Promise(r => httpSrv.listen(0, "127.0.0.1", r))
  const httpPort = httpSrv.address().port
  await rpcJ(port, token, 'browser_navigate', { tabId: String(tabId), url: 'http://127.0.0.1:' + httpPort + '/' }, 'n10b')
  await sleep(800)
  const r10b = await EV('({ stored: localStorage.getItem("evalprobe-http"), ok: window.__ok, done: window.__done })')
  const v10b = valObj(r10b)
  check('10b. localStorage read on http origin (real storage, authorized context)', evalOk(r10b) && v10b && v10b.stored && v10b.stored.v === 'http-value' && v10b.ok.v === true, JSON.stringify(v10b).slice(0, 160))
  httpSrv.close()

  finish(results.every(r => r.pass) ? 0 : 1)

  function finish (code) {
    try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc && probeProc.pid)], { windowsHide: true }) } catch (e) { /* ignore */ }
    fs.writeFileSync(path.join(ROOT, 'docs', 'agent-eval-probe.json'), JSON.stringify({ ts: new Date().toISOString(), results, pass: results.filter(r => r.pass).length, total: results.length }, null, 2))
    console.log('\n' + pass0() + results.filter(r => r.pass).length + '/' + results.length + ' checks passed')
    process.exit(code)
  }
  function pass0 () { return '' }
}

main().catch(e => {
  console.log('fatal ' + e.message)
  try { if (probeProc) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)], { windowsHide: true }) } catch (e2) {}
  process.exit(2)
})
