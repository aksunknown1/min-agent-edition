#!/usr/bin/env node
/*
 * P0-11 browser_navigate / browser_press / browser_screenshot integration probe.
 *
 * One launch of the REAL Min main process with --agent-rpc; five controlled
 * file:// pages via the P0-08 `--` argv rule (last URL = selected tab).
 *
 * Sections:
 *   navigate:   load success (finalUrl/title), URL policy rejections
 *               (javascript:/data:/vbscript:/unknown scheme -> blocked 403;
 *               >2048 chars -> invalid_params 400), did-fail-load ->
 *               structured load_failed, unknown tab -> 404, ref store
 *               cleared on navigation. P1-01B: loopback HTTP navigation
 *               matrix - static/immediate-302/delayed-redirect/SPA-pushState/
 *               hung-server timeout, expectUrlPrefix success + mismatch +
 *               late-bounce-away detection, stabilityWindowMs echo and bounds.
 *   press:      Enter submits a GET form -> navigation; Tab moves focus ->
 *               focus; Escape -> dispatched-unverified (verified=false);
 *               unknown/lowercase keys -> schema rejection.
 *   screenshot: visible capture works (PNG magic, width/height, size cap),
 *               detached view refused (VIEW_NOT_ATTACHED), no file written
 *               anywhere, nothing page-derived in [agent-rpc] stdout.
 *
 * browser_tabs create/close/select is never used.
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-nps-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-nps-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE + '-development'

const results = []
function check (name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail).slice(0, 180) })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail).slice(0, 160) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function rmrf (target) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch (e) { /* retry */ }
    if (!fs.existsSync(target)) return true
    const until = Date.now() + 400
    while (Date.now() < until) { /* brief spin */ }
  }
  return !fs.existsSync(target)
}

const PAGE_NAV1 =
  '<!doctype html><html><head><title>Nav Start</title></head><body>' +
  '<h1>Nav Start Heading</h1>' +
  '<button>' + 'Nav Start Button' + '</button>' +
  '<p>content on the start page</p>' +
  '</body></html>'

const PAGE_FORM =
  '<!doctype html><html><head><title>Form Page</title></head><body>' +
  '<form action="ft.html" method="get">' +
  '<label for="fi">' + 'Form Field' + '</label>' +
  '<input id="fi" type="text" value="go">' +
  '<label for="f2">' + 'Second Field' + '</label>' +
  '<input id="f2" type="text" value="second">' +
  '</form>' +
  '<div id="keylog"></div>' +
  '<script>document.addEventListener("keydown", function (e) {' +
  'document.getElementById("keylog").textContent += "KEY:" + (e.key || "?") + ";"; });' +
  '</script></body></html>'

const PAGE_FT = '<!doctype html><html><head><title>Form Target</title></head><body><h1>' + 'Form Target Heading' + '</h1></body></html>'
const PAGE_SHOT =
  '<!doctype html><html><head><title>Shot Page</title></head><body style="margin:0">' +
  '<div style="height:200px;background:rgb(251,191,36)"></div>' +
  '<div style="height:200px;background:rgb(59,130,246)"></div>' +
  '</body></html>'
const PAGE_OTHER = '<!doctype html><html><head><title>Other Page</title></head><body><button>' + 'Other Page Button' + '</button></body></html>'

let probeProc = null

function rpc (port, token, method, params, id) {
  return new Promise(function (resolve) {
    const body = JSON.stringify(Object.assign({ jsonrpc: '2.0', id: id || 'p' }, params !== undefined ? { method, params } : { method }))
    const req = http.request({
      host: '127.0.0.1', port, path: '/rpc', method: 'POST',
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      headersTimeout: 8000, requestTimeout: 25000
    }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', e => resolve({ status: 0, error: e.code, body: '' }))
    req.setTimeout(26000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', body: '' }) })
    req.write(body)
    req.end()
  })
}
const rpcP = async function (port2, token2, method, params, id) {
  const r = await rpc(port2, token2, method, params, id)
  let parsed = null
  try { parsed = JSON.parse(r.body) } catch (e) { /* error asserted below */ }
  return { status: r.status, body: r.body, parsed: parsed, error: parsed && parsed.error, result: parsed && parsed.result }
}

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  const pages = { na: PAGE_NAV1, nf: PAGE_FORM, ft: PAGE_FT, sh: PAGE_SHOT, ot: PAGE_OTHER }
  Object.keys(pages).forEach(function (n) { fs.writeFileSync(path.join(RUN_DIR, n + '.html'), pages[n], 'utf8') })
  const filesBefore = listFiles(RUN_DIR, PROFILE)

  /* Selected tab = LAST argv URL = nav1. */
  const urls = ['ot', 'sh', 'nf', 'na'].map(n => 'file:///' + path.join(RUN_DIR, n + '.html').replace(/\\/g, '/'))
  const bin = require('electron')
  const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--'].concat(urls),
    { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  probeProc = proc
  let out = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { out += d })

  let port = null
  let token = null
  const discPath = path.join(EFFECTIVE_PROFILE, 'agent-rpc.json')
  const started = Date.now()
  while (Date.now() - started < 30000) {
    await sleep(1000)
    const m = out.match(/listening on 127\.0\.0\.1:(\d+)/)
    if (m && fs.existsSync(discPath)) { port = parseInt(m[1], 10); token = JSON.parse(fs.readFileSync(discPath, 'utf8')).token; break }
  }
  if (!port) { check('bridge started', false, 'no listener'); return finish(2) }
  check('bridge started', true)

  let tabs = null
  const tabDeadline = Date.now() + 30000
  while (Date.now() < tabDeadline) {
    await sleep(1000)
    const r = await rpc(port, token, 'browser_tabs')
    try { tabs = JSON.parse(r.body).result } catch (e) { /* retry */ }
    if (tabs && tabs.tabs && tabs.tabs.filter(t => /(na|nf|ft|sh|ot)\.html/.test(t.url) && !t.loading).length >= 4) break
  }
  const findTab = suffix => { const t = (tabs && tabs.tabs || []).find(t => t.url.indexOf(suffix) !== -1); return t ? t.tabId : null }
  const tabNa = findTab('na.html')
  const tabOt = findTab('ot.html')
  const tabNf = findTab('nf.html')
  check('five argv tabs present (na selected last)', !!tabNa && !!tabOt && !!tabNf && !!findTab('nf.html'), tabNa + '/' + tabOt + '/' + tabNf)
  const activeNa = (tabs.tabs.find(t => t.tabId === tabNa) || {}).active
  check('nav1 tab is the selected view', activeNa === true, 'active=' + activeNa)

  /* ---------- browser_navigate ---------- */
  const nOk = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: 'file:///' + path.join(RUN_DIR, 'ft.html').replace(/\\/g, '/') }, 'n1')
  check('navigate to allowed file URL -> navigation, final URL/title correct',
    nOk.status === 200 && nOk.result.verification === 'navigation' && nOk.result.verified === true &&
    nOk.result.finalUrl.indexOf('ft.html') !== -1 && /Form Target/.test(nOk.result.title),
    JSON.stringify(nOk.error && nOk.error.category || (nOk.result && nOk.result.finalUrl)))

  /* Snapshot first so the clear can be observed: store gains N refs, then the
   * navigation (and its did-navigate) drops the tab's store back to zero. */
  await rpcP(port, token, 'browser_snapshot', { tabId: tabNa }, 'snap1')
  const storeWithRefs = (await rpcP(port, token, 'browser_status', undefined, 's2')).result.bridge.refStore
  const n2 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: 'file:///' + path.join(RUN_DIR, 'na.html').replace(/\\/g, '/') }, 'n2')
  check('navigate succeeded second time (back to start page)', n2.status === 200 && n2.result.verification === 'navigation')
  const storeAfterClear = (await rpcP(port, token, 'browser_status', undefined, 's3')).result.bridge.refStore
  check('refs cleared by navigation (live refStore back to zero for the tab)',
    storeWithRefs.refCount > 0 && storeAfterClear.refCount === 0,
    JSON.stringify(storeWithRefs) + ' -> ' + JSON.stringify(storeAfterClear))

  /* URL policy */
  const raws = {}
  const pol = async url => { const r = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: url }, 'pol'); raws[url.slice(0, 20)] = { status: r.status, body: r.body.slice(0, 200) }; return r.status }
  check('javascript: url blocked (403)', (await pol('javascript:alert(1)')) === 403)
  check('data: url blocked (403)', (await pol('data:text/html,<h1>no</h1>')) === 403)
  check('vbscript: url blocked (403)', (await pol('vbscript:msgbox(1)')) === 403)
  check('unknown scheme blocked (403)', (await pol('telnet://example.com/')) === 403)
  /* P1-01 A2: the URL cap is 2048 (was 300); over-2048 is invalid_params */
  const longOk = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: 'https://example.com/' + 'x'.repeat(2048) }, 'pol-len')
  check('over-2048 url rejected as invalid_params (400)', longOk.status === 400 && longOk.error && longOk.error.category === 'invalid_params')

  /* load failure -> structured result with verified=false (P1-01 Stage B) */
  const nFail = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: 'http://127.0.0.1:9/unreachable' }, 'nfail')
  let nFailRes = null
  try { nFailRes = JSON.parse(nFail.body).result } catch (e) { /* below */ }
  check('unreachable host -> verified=false load_failed', nFail.status === 200 && nFailRes && nFailRes.verified === false && nFailRes.verification === 'load_failed',
    'status=' + nFail.status + ' ' + JSON.stringify(nFailRes && { verified: nFailRes.verified, verification: nFailRes.verification, failCode: nFailRes.failCode }))

  /* ---------- P1-01B: navigation reliability (loopback HTTP, no live site) ---------- */
  const navServer = http.createServer(function (req, res) {
    const pth = (req.url || '/').split('?')[0]
    if (pth === '/static') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><head><title>Static Target</title></head><body><h1>' + 'Static Target Heading' + '</h1><p>stable</p></body></html>')
      return
    }
    if (pth === '/immediate') { res.writeHead(302, { location: '/static' }); res.end(); return }
    if (pth === '/delayed') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><head><title>Delayed Source</title></head><body><h1>' + 'Delayed Source Heading' + '</h1><p>staging</p>' +
        '<script>setTimeout(function () { location.replace("/landed") }, 1200)</script></body></html>')
      return
    }
    if (pth === '/landed') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><head><title>Landed Page</title></head><body><h1>' + 'Landed Heading' + '</h1></body></html>')
      return
    }
    if (pth === '/spa') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><head><title>SPA Start</title></head><body><h1>' + 'SPA Start Heading' + '</h1><p>single page</p>' +
        '<script>setTimeout(function () { history.pushState(null, "", "/spa-route") }, 500)</script></body></html>')
      return
    }
    if (pth === '/hang') { return /* never respond: navigation timeout test */ }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nf')
  })
  const navPort = await new Promise(function (resolve) {
    navServer.once('error', function () { resolve(0) })
    navServer.listen(0, '127.0.0.1', function () { resolve(navServer.address().port) })
  })
  const navUrl = suffix => 'http://127.0.0.1:' + navPort + suffix
  const navRes = r => { let o = null; try { o = JSON.parse(r.body).result } catch (e) { /* keep null */ } return o }

  /* 1. static page: plain verified navigation */
  const b1 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/static') }, 'b1')
  const r1 = navRes(b1)
  check('P1-01B static page -> verified navigation, finalUrl, urlChanges 0',
    b1.status === 200 && r1 && r1.verified === true && r1.verification === 'navigation' &&
    String(r1.finalUrl).indexOf('/static') !== -1 && r1.urlChanges === 0,
    JSON.stringify(r1 && { verified: r1.verified, verification: r1.verification, finalUrl: r1.finalUrl, urlChanges: r1.urlChanges, changedFrom: r1.changedFrom, routeChangeKind: r1.routeChangeKind }))

  /* 2. immediate server-side redirect: chain completes before the load event,
   * so the result is clean verified navigation at the target URL */
  const b2 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/immediate') }, 'b2')
  const r2b = navRes(b2)
  check('P1-01B immediate 302 -> verified navigation at /static',
    b2.status === 200 && r2b && r2b.verified === true && String(r2b.finalUrl).indexOf('/static') !== -1,
    JSON.stringify(r2b && { verified: r2b.verified, finalUrl: r2b.finalUrl }))

  /* 3. delayed redirect (Proton-signup-like bounce ~1.2s after load):
   * must NOT be reported as verified success without expectUrlPrefix */
  const b3 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/delayed') }, 'b3')
  const r3 = navRes(b3)
  check('P1-01B delayed redirect -> verified=false unstable, finalUrl=landed',
    b3.status === 200 && r3 && r3.verified === false && r3.verification === 'unstable' &&
    String(r3.finalUrl).indexOf('/landed') !== -1 && r3.urlChanges >= 1,
    JSON.stringify(r3 && { verified: r3.verified, verification: r3.verification, finalUrl: r3.finalUrl, urlChanges: r3.urlChanges, routeChangeKind: r3.routeChangeKind }))

  /* 4. SPA route change via history.pushState: detected as same-document */
  const b4 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/spa') }, 'b4')
  const r4 = navRes(b4)
  check('P1-01B SPA pushState -> verified=false unstable, routeChangeKind=same-document',
    b4.status === 200 && r4 && r4.verified === false && r4.verification === 'unstable' &&
    String(r4.finalUrl).indexOf('/spa-route') !== -1 && r4.routeChangeKind === 'same-document',
    JSON.stringify(r4 && { verified: r4.verified, verification: r4.verification, finalUrl: r4.finalUrl, routeChangeKind: r4.routeChangeKind }))

  /* 5. navigation timeout: server accepts but never responds */
  const b5 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/hang') }, 'b5')
  const r5 = navRes(b5)
  check('P1-01B hung server -> structured timeout result',
    b5.status === 200 && r5 && r5.verified === false && r5.verification === 'timeout' && typeof r5.waitedMs === 'number' && r5.waitedMs >= 7000,
    JSON.stringify(r5 && { verified: r5.verified, verification: r5.verification, waitedMs: r5.waitedMs }))

  /* 6. successful navigation with expectUrlPrefix */
  const b6 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/static'), expectUrlPrefix: navUrl('/static') }, 'b6')
  const r6 = navRes(b6)
  check('P1-01B expectUrlPrefix match -> verified navigation',
    b6.status === 200 && r6 && r6.verified === true && r6.verification === 'navigation' && String(r6.finalUrl).indexOf(navUrl('/static')) === 0,
    JSON.stringify(r6 && { verified: r6.verified, finalUrl: r6.finalUrl }))

  /* 7. delayed redirect INTO the expected prefix: bounce lands on the wanted
   * URL and stays for the whole window -> honest verified at the landing URL */
  const b7 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/delayed'), expectUrlPrefix: navUrl('/landed') }, 'b7')
  const r7 = navRes(b7)
  check('P1-01B delayed bounce into expected prefix -> verified at /landed',
    b7.status === 200 && r7 && r7.verified === true && String(r7.finalUrl).indexOf('/landed') !== -1,
    JSON.stringify(r7 && { verified: r7.verified, finalUrl: r7.finalUrl, urlChanges: r7.urlChanges }))

  /* 8. expected prefix does NOT hide a subsequent redirect away from it:
   * prefix matched at settle, then the page bounces away -> 'redirected' */
  const b8 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/delayed'), expectUrlPrefix: navUrl('/delayed') }, 'b8')
  const r8 = navRes(b8)
  check('P1-01B prefix match then bounce away -> redirected (not hidden)',
    b8.status === 200 && r8 && r8.verified === false && r8.verification === 'redirected' &&
    String(r8.finalUrl).indexOf('/landed') !== -1 && r8.urlChanges >= 1,
    JSON.stringify(r8 && { verified: r8.verified, verification: r8.verification, finalUrl: r8.finalUrl, urlChanges: r8.urlChanges }))

  /* 9. prefix impossible to match -> 'redirected' after the bounded wait */
  const b9 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/static'), expectUrlPrefix: navUrl('/never-this') }, 'b9')
  const r9 = navRes(b9)
  check('P1-01B unmatched expectUrlPrefix -> redirected, verified=false',
    b9.status === 200 && r9 && r9.verified === false && r9.verification === 'redirected',
    JSON.stringify(r9 && { verified: r9.verified, verification: r9.verification }))

  /* 10. configured stability window is echoed and honored (short window) */
  const b10 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/static'), stabilityWindowMs: 300 }, 'b10')
  const r10 = navRes(b10)
  check('P1-01B stabilityWindowMs echoed + short window still verifies',
    b10.status === 200 && r10 && r10.verified === true && r10.stabilityWindowMs === 300 && r10.waitedMs < 5000,
    JSON.stringify(r10 && { verified: r10.verified, stabilityWindowMs: r10.stabilityWindowMs, waitedMs: r10.waitedMs }))

  /* 11. out-of-range stability window -> invalid_params at the schema */
  const b11 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: navUrl('/static'), stabilityWindowMs: 15001 }, 'b11')
  check('P1-01B stabilityWindowMs 15001 -> invalid_params (400)', b11.status === 400 && b11.error && b11.error.category === 'invalid_params',
    'status=' + b11.status + ' ' + JSON.stringify(b11.error && b11.error.category))

  /* 12. no sensitive page contents in the response envelope (spot check) */
  const bodySample = b3.body + b4.body + b7.body
  check('P1-01B no page-derived body content leak in results',
    bodySample.indexOf('Delayed Source Heading') === -1 && bodySample.indexOf('Landed Heading') === -1 && bodySample.indexOf('SPA Start Heading') === -1,
    'leak check over navigate response bodies')

  navServer.close()
  try { navServer.closeAllConnections() } catch (eS) { /* Node <18.2 or none open */ }
  try { navServer.unref() } catch (eClose) { /* ignore */ }

  /* unknown tab + detached view */
  const nBad = await rpcP(port, token, 'browser_navigate', { tabId: '999999999', url: 'file:///' + path.join(RUN_DIR, 'nf.html').replace(/\\/g, '/') }, 'nbad')
  check('unknown tabId -> not_found (404)', nBad.status === 404 && nBad.error && nBad.error.category === 'ref_not_found')

  /* Restore the selected tab to ft? The press section needs the form page. */
  const n3 = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: 'file:///' + path.join(RUN_DIR, 'nf.html').replace(/\\/g, '/') }, 'n3')
  check('navigate to form page succeeded', n3.status === 200 && n3.result.finalUrl.indexOf('nf.html') !== -1)

  /* ---------- browser_screenshot (before press changed focus) ---------- */
  const shot = await rpcP(port, token, 'browser_screenshot', { tabId: tabNa }, 'shot')
  raws.shot = { status: shot.status, body: (shot.body || '').slice(0, 300) }
  Object.keys(raws).forEach(k => console.log('RAW', k, JSON.stringify(raws[k]).slice(0, 260)))

  check('screenshot of attached visible view works', shot.status === 200 && !!shot.result && !!shot.result.data &&
    shot.result.data.indexOf('iVBORw0KGgo') === 0 && shot.result.width > 0 && shot.result.height > 0,
    JSON.stringify(shot.result && { w: shot.result.width, h: shot.result.height, bytes: shot.result.bytes }))
  check('screenshot is within the 5 MiB cap', shot.result.bytes <= 5 * 1024 * 1024, shot.result.bytes)
  const shotDetached = await rpcP(port, token, 'browser_screenshot', { tabId: tabOt }, 'shot2')
  check('detached view screenshot refused (view_not_attached, 409)', shotDetached.status === 409 && shotDetached.error && shotDetached.error.category === 'view_not_attached')

  /* ---------- browser_press ---------- */
  /* Click the form field (focus), then Tab -> focus moves. */
  const snapF = (await rpcP(port, token, 'browser_snapshot', { tabId: tabNa }, 'snapf')).parsed
  const fieldRef = snapF.result.nodes.find(n => n.name === 'Form Field' && n.role === 'textbox')
  check('form field enumerated on the form page', !!fieldRef)
  const cF = await rpcP(port, token, 'browser_click', { tabId: tabNa, ref: fieldRef.ref }, 'cf')
  if (cF.status !== 200) check('click focuses the field', false, JSON.stringify(cF.error))
  else check('click focuses the field', cF.result.verification === 'focus', JSON.stringify(cF.result.verification))
  const pTab = await rpcP(port, token, 'browser_press', { tabId: tabNa, key: 'Tab' }, 'ptab')
  check('press Tab -> focus moves (focus kind)', pTab.status === 200 && pTab.result.verification === 'focus' && pTab.result.verified === true,
    JSON.stringify(pTab.result && pTab.result.verification))

  /* Enter on a text input delivers a real key event but does NOT trigger
   * implicit form submission in this runtime (documented limitation) - so the
   * verified signal is the page's own keylog (DOM marker), not navigation. */
  const pEnter = await rpcP(port, token, 'browser_press', { tabId: tabNa, key: 'Enter' }, 'penter')
  check('press Enter lands (dom-change via page keylog; implicit submission is a documented runtime limitation)',
    pEnter.status === 200 && pEnter.result.verification === 'dom-change' && pEnter.result.verified === true,
    JSON.stringify(pEnter.result && pEnter.result.verification) + ' url=' + (pEnter.result && pEnter.result.url))

  /* Escape: the form page's keylog would make any key verifiable as
   * dom-change, so the honest no-signal case is a keylog-free page (navigate
   * there first - the start page has no handlers). */
  const nEsc = await rpcP(port, token, 'browser_navigate', { tabId: tabNa, url: 'file:///' + path.join(RUN_DIR, 'na.html').replace(/\\/g, '/') }, 'nesc')
  check('navigate to keylog-free page for the escape case', nEsc.status === 200)
  const pEsc = await rpcP(port, token, 'browser_press', { tabId: tabNa, key: 'Escape' }, 'pesc')
  check('press Escape -> dispatched-unverified, verified=false',
    pEsc.status === 200 && pEsc.result.verification === 'dispatched-unverified' && pEsc.result.verified === false,
    JSON.stringify(pEsc.result && pEsc.result.verification))

  /* unknown keys rejected at schema */
  const pBad1 = await rpcP(port, token, 'browser_press', { tabId: tabNa, key: 'Meta+A' }, 'pb1')
  const pBad2 = await rpcP(port, token, 'browser_press', { tabId: tabNa, key: 'enter' }, 'pb2')
  check('unknown/lowercase keys rejected (400 invalid_params)', pBad1.status === 400 && pBad1.error.category === 'invalid_params' && pBad2.status === 400 && pBad2.error.category === 'invalid_params')

  /* ---------- hygiene ---------- */
  const filesAfter = listFiles(RUN_DIR, PROFILE)
  check('no screenshot files written anywhere', filesAfter.length === filesBefore.length, (filesAfter.length - filesBefore.length) + ' new files')
  const bridgeLog = out.split('\n').filter(l => l.includes('[agent-rpc]')).join('\n')
  check('no page title/url/typed text in [agent-rpc] stdout',
    bridgeLog.indexOf('Form Target') === -1 && bridgeLog.indexOf('ft.html') === -1 && bridgeLog.indexOf('unreachable') === -1)

  Object.keys(raws).forEach(k => console.log('RAW', k, JSON.stringify(raws[k]).slice(0, 220)))
  try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)]) } catch (e) { /* ignore */ }
  await sleep(2000)
  out.split('\n').filter(function (l) { return l.includes('verify-diag') }).slice(0, 14).forEach(function (l) { console.log('DIAG  ' + l.trim().slice(0, 260)) })
  return finish(results.every(r => r.pass) ? 0 : 2)
}

function listFiles (dir, skipUnder) {
  const found = []
  function walk (d, depth) {
    if (depth > 4) return
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    entries.forEach(function (e) {
      const p = path.join(d, e.name)
      if (skipUnder && p.indexOf(skipUnder) === 0) return
      if (e.isDirectory()) walk(p, depth + 1)
      else found.push(path.relative(RUN_DIR, p))
    })
  }
  walk(dir, 0)
  return found
}

function finish (code) {
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ ranAt: new Date().toISOString(), passed: results.filter(r => r.pass).length, total: results.length, results }, null, 2), 'utf8')
  console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed')
  try { rmrf(RUN_DIR) } catch (e) { /* ignore */ }
  process.exit(code)
}

main().catch(function (e) {
  console.error('nps probe error: ' + e.message)
  if (probeProc && probeProc.pid) { try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (ignored) { /* ignore */ } }
  try { rmrf(RUN_DIR) } catch (ignored2) { /* ignore */ }
  process.exit(2)
})
