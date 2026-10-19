#!/usr/bin/env node
/*
 * P1-01E CAPTCHA detection + human-handoff probe.
 *
 * Fixtures (local file:// only; nothing contacts any CAPTCHA provider):
 *   hcaptcha page : <div class="h-captcha" data-sitekey=...>  (hcaptcha, high)
 *   recaptcha page: <div class="g-recaptcha" data-sitekey=..> (recaptcha, high)
 *   turnstile page: <div class="cf-turnstile" data-sitekey=>  (turnstile, high)
 *   generic page  : <div data-sitekey=...>                    (unknown, low)
 *   plain page    : ordinary form (must NOT be flagged)
 *
 * Checks:
 *   1. browser_state detects each fixture's challenge kind + confidence/basis.
 *   2. click/type on a field positioned over/near the widget -> structured
 *      captcha_handoff_required (HTTP 409), never an attempt to solve.
 *   3. unrelated safe inspection (snapshot/content/status) remains available
 *      on the captcha page.
 *   4. navigating away (widget removed) -> browser_state reports cleared.
 *   5. no false positives on ordinary pages (local fixture + live example.com
 *      read-only navigation).
 *   6. blocked/apparently signal: after an unreachable-host navigation,
 *      browser_state reports the last failed navigation.
 */

const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-captcha-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-captcha-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE + '-development'

const results = []
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

const captchaPage = (cls, kind) =>
  '<!doctype html><html><head><title>' + kind + ' Challenge Page</title></head><body>' +
  '<h1>' + kind + ' Challenge Heading</h1>' +
  '<form id="f">' +
  '<label for="email">' + 'Email Field Near Challenge' + '</label>' +
  '<input id="email" type="text" value="">' +
  '<div class="' + cls + '" data-sitekey="00000000-0000-0000-0000-000000000000" style="width:300px;height:80px"></div>' +
  '<button id="go" type="button">' + 'Submit Now' + '</button>' +
  '</form>' +
  '<div id="marker">pre</div>' +
  '<script>document.getElementById("go").addEventListener("click", function () { document.getElementById("marker").textContent = "clicked"; });</script>' +
  '</body></html>'

const PAGE_PLAIN =
  '<!doctype html><html><head><title>Plain Form Page</title></head><body>' +
  '<h1>Plain Form Heading</h1>' +
  '<label for="u">' + 'Plain Field' + '</label>' +
  '<input id="u" type="text" value="">' +
  '<button id="b" type="button">' + 'Plain Button' + '</button>' +
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
  let result = null, error = null
  try { const f = JSON.parse(r.body); result = f.result !== undefined ? f.result : null; error = f.error || null } catch (e) { /* raw */ }
  return { status: r.status, rawBody: r.body, result, error, ms: r.ms }
}

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  try { fs.rmSync(path.join(EFFECTIVE_PROFILE, 'policy.json'), { force: true }) } catch (e) { /* ignore */ }
  fs.writeFileSync(path.join(RUN_DIR, 'hcaptcha.html'), captchaPage('h-captcha', 'HCaptcha'), 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'recaptcha.html'), captchaPage('g-recaptcha', 'ReCaptcha'), 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'turnstile.html'), captchaPage('cf-turnstile', 'Turnstile'), 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'generic.html'), captchaPage('generic-challenge', 'Generic'), 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'plain.html'), PAGE_PLAIN, 'utf8')
  const fileUrl = n => 'file:///' + path.join(RUN_DIR, n + '.html').replace(/\\/g, '/')

  const bin = require('electron')
  const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', fileUrl('plain')],
    { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
  await sleep(2500)
  const tabsR = await rpcJ(port, token, 'browser_tabs', {}, 't0')
  const tabId = (tabsR.result.tabs.find(t => t.active) || tabsR.result.tabs[0]).tabId
  check('startup tab enumerated', !!tabId)

  /* 5. no false positive on the plain page */
  const stPlain = await rpcJ(port, token, 'browser_state', { tabId }, 'st0')
  const stPlainR = stPlain.result || {}
  check('browser_state: plain fixture NOT flagged', stPlain.status === 200 && stPlainR.captcha && stPlainR.captcha.detected === false,
    JSON.stringify(stPlainR.captcha))

  /* 1. hcaptcha detection */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('hcaptcha'), stabilityWindowMs: 200 }, 'n1')
  await sleep(600)
  const stH = await rpcJ(port, token, 'browser_state', { tabId }, 'st1')
  const stHR = stH.result || {}
  check('browser_state: hcaptcha detected with kind/confidence/basis',
    stH.status === 200 && stHR.captcha && stHR.captcha.detected === true && stHR.captcha.kind === 'hcaptcha' &&
      stHR.captcha.confidence === 'high' && typeof stHR.captcha.basis === 'string' && stHR.captcha.basis.indexOf('locator') === 0,
    JSON.stringify(stHR.captcha))

  /* 1b. recaptcha + turnstile + generic classifications */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('recaptcha'), stabilityWindowMs: 200 }, 'n2')
  await sleep(500)
  const stR = (await rpcJ(port, token, 'browser_state', { tabId }, 'st2')).result || {}
  check('browser_state: recaptcha kind detected', stR.captcha && stR.captcha.detected === true && stR.captcha.kind === 'recaptcha', JSON.stringify(stR.captcha))
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('turnstile'), stabilityWindowMs: 200 }, 'n3')
  await sleep(500)
  const stT = (await rpcJ(port, token, 'browser_state', { tabId }, 'st3')).result || {}
  check('browser_state: turnstile kind detected', stT.captcha && stT.captcha.detected === true && stT.captcha.kind === 'turnstile', JSON.stringify(stT.captcha))
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('generic'), stabilityWindowMs: 200 }, 'n4')
  await sleep(500)
  const stG = (await rpcJ(port, token, 'browser_state', { tabId }, 'st4')).result || {}
  check('browser_state: generic sitekey -> unknown kind / low confidence (honest)',
    stG.captcha && stG.captcha.detected === true && stG.captcha.kind === 'unknown' && stG.captcha.confidence === 'low', JSON.stringify(stG.captcha))

  /* 2. action targeting the challenge-adjacent field -> structured 409 handoff */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('hcaptcha'), stabilityWindowMs: 200 }, 'n5')
  await sleep(600)
  const snapH = await rpcJ(port, token, 'browser_snapshot', { tabId }, 'snapH')
  const emailRef = (((snapH.result || {}).nodes) || []).find(n => n.role === 'textbox')
  check('captcha page: safe inspection still available (snapshot works)', !!emailRef, 'textbox found=' + !!emailRef)
  const tH = await rpcJ(port, token, 'browser_type', { tabId, ref: emailRef.ref, text: 'user@example.com' }, 'tH')
  const tHErr = tH.error || {}
  check('type at/over challenge widget -> 409 captcha_handoff_required', tH.status === 409 && tHErr.category === 'captcha_handoff_required',
    JSON.stringify({ status: tH.status, cat: tHErr.category, handled: tHErr.code }))

  /* 3. unrelated SAFE page inspection remains available while captcha present */
  const contH = await rpcJ(port, token, 'browser_content', { tabId, maxChars: 1000 }, 'cH')
  check('content still readable on the captcha page (no blanket block)',
    contH.status === 200 && /Challenge Heading/i.test((contH.result || {}).text || ''), JSON.stringify(contH.error && contH.error.category))
  const stDuring = await rpcJ(port, token, 'browser_status', {}, 'stD')
  check('bridge status/managers still available during captcha', stDuring.status === 200, 'status=' + stDuring.status)

  /* 4. navigation away -> cleared */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('plain'), stabilityWindowMs: 200 }, 'n6')
  await sleep(600)
  const stCleared = await rpcJ(port, token, 'browser_state', { tabId }, 'stC')
  check('challenge cleared state after navigating away (poll-for-continue flow)',
    stCleared.status === 200 && (stCleared.result || {}).captcha && stCleared.result.captcha.detected === false,
    JSON.stringify(stCleared.result && stCleared.result.captcha))

  /* 6. blocked/apparently signal from last failed navigation */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: 'http://127.0.0.1:9/unreachable', stabilityWindowMs: 200 }, 'nB')
  await sleep(400)
  const stB = await rpcJ(port, token, 'browser_state', { tabId }, 'stB')
  const stBR = stB.result || {}
  check('browser_state: apparent block reported after failed navigation',
    stB.status === 200 && stBR.blocked && stBR.blocked.apparently === true && stBR.blocked.signals.length > 0 && stBR.lastNavigation && stBR.lastNavigation.verified === false,
    JSON.stringify(stBR.blocked))

  /* 5b. no false positive on a live public page (read-only) */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: 'https://example.com/', stabilityWindowMs: 300 }, 'nL')
  await sleep(800)
  const stL = await rpcJ(port, token, 'browser_state', { tabId }, 'stL')
  check('live example.com NOT flagged as captcha/blocked',
    stL.status === 200 && stL.result && stL.result.captcha && stL.result.captcha.detected === false && stL.result.blocked.apparently === false,
    JSON.stringify((stL.result || {}).captcha))
}

function printSummary (code) {
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ ranAt: new Date().toISOString(), passed: results.filter(r => r.pass).length, total: results.length, results }, null, 2), 'utf8')
  console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed')
  return code
}
process.on('exit', function () { try { rmrf(RUN_DIR) } catch (e) { /* ignore */ } })
main().then(function () {
  const code = printSummary(0)
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (e) { /* ignore */ }
  process.exit(code)
}).catch(function (e) {
  console.error('captcha probe error: ' + e.message)
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (ignored) { /* ignore */ }
  printSummary(2)
  process.exit(2)
})
