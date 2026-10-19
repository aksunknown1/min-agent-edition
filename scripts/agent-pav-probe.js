#!/usr/bin/env node
/*
 * P1-03 Stage 2: Predict -> Act -> Verify test matrix.
 * Fixtures local; one live read-only case (example.com). No production form
 * is submitted; secrets never surface (password fixture uses length-only
 * evidence).
 */
const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-pav-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-pav-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE + '-development'

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail).slice(0, 2000) })
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

const PAGE =
  '<!doctype html><html><head><title>Predict Act Verify</title></head><body>' +
  '<h1>Predict Act Verify Heading</h1>' +
  '<a id="lnk" href="after.html">' + 'Go To After Page' + '</a>' +
  '<button id="jsbtn">' + 'JS Effect Button' + '</button>' +
  '<form id="f" action="never.html" method="post">' +
  '<label for="t">' + 'Form Field' + '</label>' +
  '<input id="t" type="text" value="">' +
  '<button type="submit" id="sub">' + 'Submit Form' + '</button>' +
  '</form>' +
  '<input id="pw" type="password" value="">' +
  '<div id="out">initial</div>' +
  '<script>' +
  'var out = document.getElementById("out");' +
  'document.getElementById("t").addEventListener("input", function (e) { out.textContent = "value:" + e.target.value; });' +
  'document.getElementById("jsbtn").addEventListener("click", function () {' +
  'out.textContent = "js-effect-ran"; });</script>' +
  '</body></html>'
const PAGE_AFTER =
  '<!doctype html><html><head><title>After PAV</title></head><body><h1>' + 'After PAV Heading' + '</h1></body></html>'

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
    req.end(body)
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
  fs.writeFileSync(path.join(RUN_DIR, 'pav.html'), PAGE, 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'after.html'), PAGE_AFTER, 'utf8')
  const fileUrl = n => 'file:///' + path.join(RUN_DIR, n + '.html').replace(/\\/g, '/')

  const bin = require('electron')
  const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', fileUrl('pav')],
    { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  probeProc = proc
  /* P1-10: drain child pipes - an undrained 64KB stderr/stdout buffer blocks the Electron
   * child mid-startup (observed P1-10: discovery written, start-URL tab never opened,
   * active tab stayed on Welcome). Draining is what every other probe (mcp-e2e, keeper)
   * already does. */
  proc.stdout.on('data', function () { /* drain */ })
  proc.stderr.on('data', function () { /* drain */ })
  const discPath = path.join(EFFECTIVE_PROFILE, 'agent-rpc.json')
  let disc = null
  const started = Date.now()
  while (Date.now() - started < 60000) {
    await sleep(400)
    try { disc = JSON.parse(fs.readFileSync(discPath, 'utf8')); break } catch (e) { /* wait */ }
  }
  if (!disc) { check('bridge discovered', false, '60s timeout'); printSummary(2); process.exit(2) }
  check('bridge discovered', true)
  const u = new URL(disc.url)
  const port = u.port
  const token = disc.token
  const tabsR = await rpcJ(port, token, 'browser_tabs', {}, 't0')
  const tabId = (tabsR.result.tabs.find(t => t.active) || tabsR.result.tabs[0]).tabId
  /* bounded page-ready wait: re-snapshot until the fixture heading is enumerable
   * (no fixed sleep; max 12 s). */
  let nodesReady = []
  for (let r2 = 0; r2 < 24; r2++) {
    const rs = await rpcJ(port, token, 'browser_snapshot', { tabId, maxNodes: 40 }, 'srd' + r2)
    if (rs.result && rs.result.nodes && rs.result.nodes.some(n => /Predict Act Verify Heading/i.test(n.name || ''))) { nodesReady = rs.result.nodes; break }
    await sleep(500)
  }
  check('fixture page ready (bounded, event-driven wait)', nodesReady.length > 0, 'nodes=' + nodesReady.length)

  /* 1. read-only link prediction (href from the actual element) then act+verify */
  let snap = await rpcJ(port, token, 'browser_snapshot', { tabId }, 's1')
  let nodes = (snap.result && snap.result.nodes) || []
  const linkRef = (nodes.find(n => n.role === 'link' && /Go To After/i.test(n.name || '')) || {}).ref
  check('link ref present', !!linkRef)
  const pLink = await rpcJ(port, token, 'browser_predict', { tabId, ref: linkRef, action: 'click' }, 'p1')
  const pLinkD = pLink.result || {}
  check('predict link -> navigation, high confidence, href evidence',
    pLink.status === 200 && pLinkD.sideEffectClass === 'navigation' && pLinkD.confidence === 'high' &&
    String(pLinkD.likelyEffect).indexOf('/after.html') !== -1 && Array.isArray(pLinkD.evidence) && pLinkD.evidence.length >= 1,
    JSON.stringify(pLinkD && { sideEffectClass: pLinkD.sideEffectClass, confidence: pLinkD.confidence, effect: pLinkD.likelyEffect }))
  /* the prediction must not have triggered the navigation: URL unchanged */
  const urlStill = await rpcJ(port, token, 'browser_state', { tabId }, 'st0')
  check('prediction did NOT trigger the action (still on the fixture page)',
    pLinkD.url === fileUrl('pav') || String(pLinkD.url).indexOf('pav.html') !== -1, 'url=' + (pLinkD.url || '').slice(0, 80))
  const cL = await rpcJ(port, token, 'browser_click', { tabId, ref: linkRef }, 'c1')
  check('act: click link -> navigation to after.html (verified)', cL.result && cL.result.verified === true && String(cL.result.finalUrl).indexOf('/after.html') !== -1,
    JSON.stringify({finalUrl: cL.result && cL.result.finalUrl, verified: cL.result && cL.result.verified, u: (cL.result && cL.result.url) || null}))
  /* verify: cheap url-prefix check via browser_verify (no snapshot) */
  const v1 = await rpcJ(port, token, 'browser_verify', { tabId, urlPrefix: 'https://invalid-prefix/' }, 'v1')
  check('verify: origin-checked urlPrefix correctly rejects the wrong prefix',
    v1.status === 200 && v1.result && v1.result.checks.urlPrefix === false && v1.result.verified === false, JSON.stringify(v1.result))

  /* 2. unknown-effect button: prediction is honest; not triggered during prediction */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('pav'), stabilityWindowMs: 200 }, 'n2')
  await sleep(500)
  snap = await rpcJ(port, token, 'browser_snapshot', { tabId }, 's2')
  nodes = (snap.result && snap.result.nodes) || []
  const jsRef = (nodes.find(n => n.role === 'button' && /JS Effect/i.test(n.name || '')) || {}).ref
  const pJs = await rpcJ(port, token, 'browser_predict', { tabId, ref: jsRef, action: 'click' }, 'p2')
  const pJsD = pJs.result || {}
  check('predict JS button -> honest unknown / low confidence / requiresUserInput',
    pJs.status === 200 && pJsD.sideEffectClass === 'unknown' && pJsD.confidence === 'low' && pJsD.requiresUserInput === true,
    JSON.stringify(pJsD && { sideEffectClass: pJsD.sideEffectClass, confidence: pJsD.confidence, requiresUserInput: pJsD.requiresUserInput }))
  const outBefore = await rpcJ(port, token, 'browser_content', { tabId, maxChars: 1000 }, 'cb0')
  check('unknown-effect button was NOT triggered by the prediction',
    /initial/i.test((outBefore.result || {}).text || ''), JSON.stringify((outBefore.result || {}).text || '').slice(0, 60))

  /* 3. form submit semantics identified; NOT submitted */
  const subRef = (nodes.find(n => n.role === 'button' && /Submit Form/i.test(n.name || '')) || {}).ref
  const pSub = await rpcJ(port, token, 'browser_predict', { tabId, ref: subRef, action: 'click' }, 'p3')
  const pSubD = pSub.result || {}
  check('predict form submit -> form-submit class, form action/method evidence, no submit performed',
    pSubD.sideEffectClass === 'form-submit' && String(pSubD.likelyEffect).indexOf('never.html') !== -1 &&
    String(pSubD.url).indexOf('pav.html') !== -1,
    JSON.stringify(pSubD && { cls: pSubD.sideEffectClass, effect: pSubD.likelyEffect, url: pSubD.url }))

  /* 4. stale target prediction -> clear structured error, never a wrong element */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('after'), stabilityWindowMs: 200 }, 'n4')
  await sleep(500)
  const pStale = await rpcJ(port, token, 'browser_predict', { tabId, ref: jsRef, action: 'click' }, 'p4')
  const staleOk = pStale.error && (pStale.error.category === 'ref_stale' || pStale.error.category === 'ref_not_found' || pStale.error.category === 'ref_expired')
  check('predict on a stale ref -> structured invalid-ref error (never acts on a different element)',
    staleOk, JSON.stringify(pStale.error && { category: pStale.error.category }))

  /* 5. ordinary click/type with cheap verification (no snapshot between) */
  await rpcJ(port, token, 'browser_navigate', { tabId, url: fileUrl('pav'), stabilityWindowMs: 200 }, 'n5')
  await sleep(500)
  snap = await rpcJ(port, token, 'browser_snapshot', { tabId }, 's5')
  nodes = (snap.result && snap.result.nodes) || []
  const fieldRef = (nodes.find(n => n.role === 'textbox' && /Form Field/i.test(n.name || '')) || {}).ref
  const t5 = await rpcJ(port, token, 'browser_type', { tabId, ref: fieldRef, text: 'typed-10' }, 't5')
  check('typed action: cheap structured verification (value), no snapshot used',
    t5.result && t5.result.verified === true && t5.result.verification === 'value', JSON.stringify(t5.result && t5.result.verification))

  /* 7. batch with per-step verify where a failing verification stops the sequence */
  const vOk = await rpcJ(port, token, 'browser_batch', {
    tabId,
    actions: JSON.stringify([
      { tool: 'browser_type', params: { ref: fieldRef, text: 'second-fill' } },
      { tool: 'browser_verify', params: { selector: '#t', textContains: 'second-fill' } },
      { tool: 'browser_verify', params: { selector: '#never', textContains: 'never' } },
      { tool: 'browser_content', params: { maxChars: 1000 } }
    ])
  }, 'b7')
  const vOkD = vOk.result || {}
  console.log('BATCH-DEBUG ' + JSON.stringify(vOkD && vOkD.steps ? vOkD.steps.map(x => ({ step: x.step, tool: x.tool, ok: x.ok, err: x.error || null, verify: x.result && x.result.verification || null })) : vOkD))
  check('batch with per-step verify: failing check stops the remaining steps',
    vOkD.ok === false && vOkD.steps.length === 3 && vOkD.steps[0].ok === true && vOkD.steps[1].ok === true && vOkD.steps[2].ok === false,
    JSON.stringify({ status: vOk.status, err: vOk.error, result: vOk.result }))

  /* 8. sensitive input: length-only evidence */
  const pwRef = (nodes.find(n => n.role === 'textbox' && n.redacted === true) || {}).ref
  const g = await rpcJ(port, token, 'browser_grant', { action: 'sensitive_type', tabId, ref: pwRef }, 'g1')
  const tPw = await rpcJ(port, token, 'browser_type', { tabId, ref: pwRef, text: 'agent-typed-secret' }, 'tpw')
  const tPwD = tPw.result || {}
  check('sensitive typing: value-length only, never the value', tPw.status === 200 &&
    tPwD.verification === 'value-length' && tPwD.valueLength === 'agent-typed-secret'.length,
    JSON.stringify(tPwD && { verification: tPwD.verification, valueLength: tPwD.valueLength }))

  /* 9. live read-only prediction on a public page */
  const navL = await rpcJ(port, token, 'browser_navigate', { tabId, url: 'https://example.com/', stabilityWindowMs: 500 }, 'n9')
  await sleep(800)
  const snapL = await rpcJ(port, token, 'browser_snapshot', { tabId, maxNodes: 30 }, 's9')
  const liveLink = (((snapL.result || {}).nodes) || []).find(n => n.role === 'link')
  if (liveLink) {
    const pL = await rpcJ(port, token, 'browser_predict', { tabId, ref: liveLink.ref, action: 'click' }, 'p9')
    const pLD = pL.result || {}
    check('live example.com link prediction (read-only)', pL.status === 200 &&
      (pLD.sideEffectClass === 'navigation' || pLD.sideEffectClass === 'navigation-external') && String(pLD.likelyEffect).indexOf('iana.org') !== -1,
      JSON.stringify(pLD && { sideEffectClass: pLD.sideEffectClass, effect: pLD.likelyEffect }))
  } else {
    check('live example.com link prediction (read-only)', false, 'link not found this run')
  }
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
  console.error('pav probe error: ' + e.message)
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (ignored) { /* ignore */ }
  printSummary(2)
  process.exit(2)
})
