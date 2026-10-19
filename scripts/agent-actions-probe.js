#!/usr/bin/env node
/*
 * P0-10/P0-13 actions probe (REBUILT in P1-00A after this file was clobbered
 * during the Stage-A edit — the original had no backup; see baseline notes).
 *
 * Sections:
 *   L1  (default policy): click/dom-change, link/navigation, value typing,
 *        password refusal, disabled refusal, risky refusal (no grant present)
 *   L1b: P0-13 grants: risky grant -> click allowed -> consumed -> refused;
 *        sensitive grant -> typing allowed -> consumed -> refused;
 *        wrong-tab grant, wrong-action grant, expired grant (ttl 30 + 31s)
 *   L2  (profile policy.json): risky + sensitive allowed with NO grant;
 *        allowedSchemes restriction; removed-flag absence check.
 */

const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-actions-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-actions-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE + '-development'
const WIN32 = process.platform === 'win32'

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail).slice(0, 220) })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail).slice(0, 160) + ']'))
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

const PAGE_ACT =
  '<!doctype html><html><head><title>Actions Page</title></head><body>' +
  '<h1>Actions Heading</h1>' +
  '<button id="chg">' + 'Change Text' + '</button>' +
  '<div id="mutable">marker-zero-state</div>' +
  '<button id="add">' + 'Add Ambiguous' + '</button>' +
  '<button id="amb">' + 'Ambiguous' + '</button>' +
  '<a id="navlink" href="/after">' + 'Go to Next Page' + '</a>' +
  '<label for="fld">' + 'Field Label' + '</label>' +
  '<input id="fld" type="text" value="initial">' +
  '<input id="pwd" type="password" value="field-secret">' +
  '<button id="dis" disabled>' + 'Disabled Button' + '</button>' +
  '<button id="none">' + 'No Effect Button' + '</button>' +
  '<button id="pay">' + 'Pay Now' + '</button>' +
  '<script>' +
  'document.getElementById("chg").addEventListener("click", function () {' +
  '  document.getElementById("mutable").textContent = "changed at runtime"; });' +
  'document.getElementById("add").addEventListener("click", function () {' +
  '  var b = document.createElement("button"); b.textContent = "Ambiguous";' +
  '  document.body.insertBefore(b, document.getElementById("amb")); });' +
  'document.getElementById("pay").addEventListener("click", function () {' +
  '  document.getElementById("mutable").textContent = "paid-via-grant"; });' +
  '</script></body></html>'

const PAGE_AFTER = '<!doctype html><html><head><title>After Page</title></head><body><p>after</p></body></html>'
const PAGE_OTHER = '<!doctype html><html><head><title>Other Page</title></head><body><button>' + 'Other Page Button' + '</button></body></html>'

let probeProc = null

function rpc (port, token, method, params, id) {
  return new Promise(function (resolve) {
    const body = JSON.stringify(Object.assign({ jsonrpc: '2.0', id: id || 'p' }, params !== undefined ? { method, params } : { method }))
    const req = http.request({
      host: '127.0.0.1', port, path: '/rpc', method: 'POST',
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      headersTimeout: 8000, requestTimeout: 40000
    }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', e => resolve({ status: 0, error: e.code, body: '' }))
    req.setTimeout(42000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', body: '' }) })
    req.write(body)
    req.end()
  })
}
async function rpcJ (port, token, method, params, id) {
  const r = await rpc(port, token, method, params, id)
  let result = null
  let error = null
  try {
    const frame = JSON.parse(r.body)
    result = frame.result !== undefined ? frame.result : null
    error = frame.error !== undefined ? frame.error : null
  } catch (e) { /* raw path via detail */ }
  return { status: r.status, rawBody: r.body, result, error }
}

async function launch (bin, policySetup) {
  rmrf(EFFECTIVE_PROFILE)
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  /* P0-13: durable per-profile policy replaces the removed launch-flag bypass. */
  if (policySetup) {
    fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'policy.json'), JSON.stringify(policySetup), 'utf8')
  } else {
    try { fs.rmSync(path.join(EFFECTIVE_PROFILE, 'policy.json'), { force: true }) } catch (e) { /* ignore */ }
  }
  ;['act', 'after', 'other'].forEach(function (n) {
    const content = n === 'act' ? PAGE_ACT : n === 'after' ? PAGE_AFTER : PAGE_OTHER
    fs.writeFileSync(path.join(RUN_DIR, n + '.html'), content, 'utf8')
  })
  /* Min selects the LAST argv tab, so the act page goes last: actions require
   * the target view to be attached to the live window (single-window scope). */
  const urls = ['other', 'after', 'act'].map(n => 'file:///' + path.join(RUN_DIR, n + '.html').replace(/\\/g, '/'))
  const args = ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc']
  args.push('--')
  args.push.apply(args, urls)

  const proc = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  probeProc = proc
  let out = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { out += d })
  let killedByUs = false
  let selfExit = null
  proc.on('exit', function (code) { if (!killedByUs) selfExit = code })

  let port = null
  let token = null
  const discPath = path.join(EFFECTIVE_PROFILE, 'agent-rpc.json')
  const started = Date.now()
  while (Date.now() - started < 60000) {
    await sleep(1000)
    const m = out.match(/listening on 127\.0\.0\.1:(\d+)/)
    if (m && fs.existsSync(discPath)) { port = parseInt(m[1], 10); token = JSON.parse(fs.readFileSync(discPath, 'utf8')).token; break }
  }
  if (!port) { return { dead: true, selfExit, out } }

  let tabs = null
  const tabDeadline = Date.now() + 60000
  while (Date.now() < tabDeadline) {
    await sleep(1000)
    const r = await rpc(port, token, 'browser_tabs')
    try { tabs = JSON.parse(r.body).result } catch (e) { /* retry */ }
    if (tabs && tabs.tabs && tabs.tabs.filter(t => /(act|after|other)\.html/.test(t.url) && !t.loading).length === 3) break
  }
  const finish = async function () {
    let killExit = null
    if (!killedByUs) {
      killedByUs = true
      killExit = WIN32
        ? spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { encoding: 'utf8', windowsHide: true }).status
        : null
      await sleep(2000)
    }
    return { selfExit, killExit }
  }
  return { port, token, out, tabs, selfExit, finish }
}

const findTab = (tabs, suffix) => { const t = (tabs && tabs.tabs || []).find(t => t.url.indexOf(suffix) !== -1); return t ? t.tabId : null }

async function main () {
  fs.mkdirSync(RUN_DIR, { recursive: true })
  const bin = require('electron')

  /* ---------- L1: default policy (nothing allowed without grants) ---------- */
  const L1 = await launch(bin, null)
  check('L1 bridge started (default policy)', !L1.dead && !!L1.port, 'selfExit=' + L1.selfExit)
  if (L1.dead) return finish(2)
  const port = L1.port, token = L1.token

  const tabAct = findTab(L1.tabs, 'act.html')
  const tabOther = findTab(L1.tabs, 'other.html')
  check('argv tabs present (act/after/other)', !!tabAct && !!tabOther && !!findTab(L1.tabs, 'after.html'))
  const actSelected = (L1.tabs.tabs.find(t => t.tabId === tabAct) || {}).active
  check('act tab selected (single-window scope precondition)', actSelected === true, 'active=' + actSelected)

  const sA = await rpcJ(port, token, 'browser_snapshot', { tabId: tabAct }, 'sa')
  const byName = name => sA.result.nodes.filter(n => n.name === name)
  const refOf = name => { const n = byName(name)[0]; return n ? n.ref : null }
  check('snapshot has the action targets', ['Change Text', 'Go to Next Page', 'Field Label', 'Pay Now', 'Disabled Button'].every(n => byName(n).length >= 1))

  const fieldNode = sA.result.nodes.find(n => n.locator.kind === 'label' && n.name === 'Field Label')
  check('text field located by label with initial value', !!fieldNode && fieldNode.role === 'textbox' && fieldNode.value === 'initial')

  /* 1. click changing button -> dom-change */
  const c1 = await rpcJ(port, token, 'browser_click', { tabId: tabAct, ref: refOf('Change Text') }, 'c1')
  const c1Data = c1.result || {}
  check('click changing button -> dom-change', c1.status === 200 && c1Data.verification === 'dom-change' && c1Data.verified === true, JSON.stringify(c1Data.verification))

  /* 2. click link -> navigation */
  const c2 = await rpcJ(port, token, 'browser_click', { tabId: tabAct, ref: refOf('Go to Next Page') }, 'c2')
  const c2Data = c2.result || {}
  check('click link -> navigation', c2.status === 200 && c2Data.verification === 'navigation' && c2Data.verified === true, JSON.stringify(c2Data.verification))

  await L1.finish()

  /* ---------- L1b: fresh /act for the grant lifecycle + expiry ---------- */
  const L1b = await launch(bin, null)
  check('L1b bridge started', !L1b.dead && !!L1b.port, 'selfExit=' + L1b.selfExit)
  const port2 = L1b.port, token2 = L1b.token
  const tabAct2 = findTab(L1b.tabs, 'act.html')
  const tabOther2 = findTab(L1b.tabs, 'other.html')

  const sB = await rpcJ(port2, token2, 'browser_snapshot', { tabId: tabAct2 }, 'sb')
  const refB = name => { const n = sB.result.nodes.find(n => n.name === name); return n ? n.ref : null }
  const fieldRef = sB.result.nodes.find(n => n.name === 'Field Label' && n.role === 'textbox').ref
  const pwdRef = sB.result.nodes.find(n => n.role === 'textbox' && n.redacted === true && n.valueLength > 0).ref

  const typed = 'typed-value-123'
  const t1 = await rpcJ(port2, token2, 'browser_type', { tabId: tabAct2, ref: fieldRef, text: typed }, 't1')
  const t1Data = t1.result || {}
  check('type into text field -> value match', t1.status === 200 && t1Data.verification === 'value' && t1Data.verified === true, JSON.stringify(t1Data.verification))

  /* 4. type into password -> refused before dispatch */
  const t2 = await rpcJ(port2, token2, 'browser_type', { tabId: tabAct2, ref: pwdRef, text: 'nope-123' }, 't2')
  const t2Err = t2.error || {}
  check('type into password refused (sensitive_field, 403)', t2.status === 403 && t2Err.category === 'sensitive_field', JSON.stringify(t2Err))

  /* 4b. P0-13 wrong-tab bound grant must NOT unlock another tab. */
  const gWrong = await rpcJ(port2, token2, 'browser_grant', { action: 'risky_click', tabId: tabOther2, ref: refB('Pay Now') }, 'gw')
  check('browser_grant issues for the other tab too', gWrong.status === 200 && gWrong.result && gWrong.result.granted === true, JSON.stringify(gWrong.result))
  const cWrong = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Pay Now') }, 'cw')
  const cWrongErr = cWrong.error || {}
  check('wrong-tab grant does NOT unlock this tab (403, unconsumed)', cWrong.status === 403 && cWrongErr.category === 'risky_action', JSON.stringify(cWrongErr))

  /* 4c. wrong-ACTION grant: sensitive_type cannot unlock a risky click. */
  const gWrongAction = await rpcJ(port2, token2, 'browser_grant', { action: 'sensitive_type', tabId: tabAct2, ref: refB('Pay Now') }, 'gwa')
  check('sensitive_type grant issues (bound to the ref)', gWrongAction.status === 200 && gWrongAction.result && gWrongAction.result.granted === true, JSON.stringify(gWrongAction.result))
  const cWrongAction = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Pay Now') }, 'cwa')
  const cWrongActionErr = cWrongAction.error || {}
  check('sensitive_type grant does NOT unlock a risky click (403)', cWrongAction.status === 403 && cWrongActionErr.category === 'risky_action', JSON.stringify(cWrongActionErr))

  /* 5. click disabled -> clear error */
  const c3 = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Disabled Button') }, 'c3')
  const c3Err = c3.error || {}
  check('click disabled refused (disabled, 409)', c3.status === 409 && c3Err.category === 'disabled', JSON.stringify(c3Err))

  /* 6. risky click refused by default (no grant) */
  const c4 = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Pay Now') }, 'c4')
  const c4Err = c4.error || {}
  check('risky click refused by default (risky_action, 403)', c4.status === 403 && c4Err.category === 'risky_action', JSON.stringify(c4Err))

  /* 6b. P0-13 grant then risky click -> allowed, grant consumed, second -> 403. */
  const g1 = await rpcJ(port2, token2, 'browser_grant', { action: 'risky_click', tabId: tabAct2, ref: refB('Pay Now'), ttlSeconds: 120 }, 'g1')
  const g1Data = g1.result || {}
  check('browser_grant risky_click ok (single-use, tab+ref bound)', g1.status === 200 && g1Data.granted === true, JSON.stringify(g1Data))
  const stG = await rpcJ(port2, token2, 'browser_status', {}, 'sg')
  const grantsStatus = (stG.result && stG.result.bridge && stG.result.bridge.grants) || {}
  check('browser_status.bridge.grants exposes active count only', typeof grantsStatus.active === 'number' && !('action' in grantsStatus) && !('ref' in grantsStatus) && grantsStatus.active >= 1, JSON.stringify(grantsStatus))
  const c4b = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Pay Now') }, 'c4b')
  const c4bData = c4b.result || {}
  check('granted risky click -> dom-change (grant consumed)', c4b.status === 200 && c4bData.verification === 'dom-change', JSON.stringify(c4bData.verification))
  const c4c = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Pay Now') }, 'c4c')
  const c4cErr = c4c.error || {}
  check('second risky click without a new grant -> 403 (single use)', c4c.status === 403 && c4cErr.category === 'risky_action', JSON.stringify(c4cErr))

  /* 6c. sensitive grant then typing -> allowed once (length-only verification). */
  const g2 = await rpcJ(port2, token2, 'browser_grant', { action: 'sensitive_type', tabId: tabAct2, ref: pwdRef, ttlSeconds: 120 }, 'g2')
  const g2Data = g2.result || {}
  check('browser_grant sensitive_type ok', g2.status === 200 && g2Data.granted === true, JSON.stringify(g2Data))
  const GRANTED_PW = 'Gr4nted-Pw'
  const t2b = await rpcJ(port2, token2, 'browser_type', { tabId: tabAct2, ref: pwdRef, text: GRANTED_PW }, 't2b')
  const t2bData = t2b.result || {}
  check('granted sensitive typing -> value-length (length-only verify), consumed', t2b.status === 200 && t2bData.verification === 'value-length' && t2bData.valueLength === GRANTED_PW.length, JSON.stringify(t2bData.verification))
  const t2c = await rpcJ(port2, token2, 'browser_type', { tabId: tabAct2, ref: pwdRef, text: 'second-try' }, 't2c')
  const t2cErr = t2c.error || {}
  check('second sensitive typing without a new grant -> 403 (single use)', t2c.status === 403 && t2cErr.category === 'sensitive_field', JSON.stringify(t2cErr))

  /* 6d. expired grant -> 403 (ttlSeconds 30 + 31s wait). */
  const g3 = await rpcJ(port2, token2, 'browser_grant', { action: 'risky_click', tabId: tabAct2, ref: refB('Pay Now'), ttlSeconds: 30 }, 'g3')
  check('expired-test grant issued', g3.status === 200 && g3.result && g3.result.granted === true)
  console.log('  waiting 31s for the 30s grant TTL to expire...')
  await sleep(31500)
  const c4d = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Pay Now') }, 'c4d')
  const c4dErr = c4d.error || {}
  check('expired grant -> 403 (not accepted after TTL)', c4d.status === 403 && (c4dErr.category === 'risky_action' || c4dErr.category === 'ref_expired'), JSON.stringify(c4dErr))

  /* 7. ambiguous: click Add Ambiguous (dom-change mutation), then the old ref */
  const c5 = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Add Ambiguous') }, 'c5')
  const c5Data = c5.result || {}
  check('mutation click -> dom-change', c5.status === 200 && c5Data.verification === 'dom-change')
  const c6 = await rpcJ(port2, token2, 'browser_click', { tabId: tabAct2, ref: refB('Ambiguous') }, 'c6')
  const c6Err = c6.error || {}
  check('stale-after-mutation ref -> AMBIGUOUS (409, no guess)', c6.status === 409 && c6Err.category === 'ambiguous', JSON.stringify(c6Err))

  /* hydration: no page content in bridge stdout */
  const bridgeLog = L1b.out.split('\n').filter(l => l.includes('[agent-rpc]')).join('\n')
  check('no page content in [agent-rpc] stdout', bridgeLog.indexOf(typed) === -1 && bridgeLog.indexOf('field-secret') === -1 && bridgeLog.indexOf('Pay Now') === -1)

  const end1 = await L1b.finish()

  /* ---------- L2: profile policy.json pre-authorization (no grant) ---------- */
  const L2 = await launch(bin, { allowRiskyClicks: true, allowSensitiveTyping: true, allowedSchemes: ['https'] })
  check('L2 bridge started (profile policy)', !L2.dead && !!L2.port, 'selfExit=' + L2.selfExit)
  let tabs3 = null
  const d3 = Date.now() + 60000
  while (Date.now() < d3) {
    await sleep(1000)
    const r = await rpc(L2.port, L2.token, 'browser_tabs')
    try { tabs3 = JSON.parse(r.body).result } catch (e) { /* retry */ }
    if (tabs3 && tabs3.tabs && tabs3.tabs.filter(t => /(act|after|other)\.html/.test(t.url) && !t.loading).length === 3) break
  }
  const tabAct3 = findTab(tabs3, 'act.html')
  const sC = await rpcJ(L2.port, L2.token, 'browser_snapshot', { tabId: tabAct3 }, 'sc')
  const payRef = (sC.result.nodes.find(n => n.name === 'Pay Now') || {}).ref
  const c12 = await rpcJ(L2.port, L2.token, 'browser_click', { tabId: tabAct3, ref: payRef }, 'c12')
  const c12Data = c12.result || {}
  check('risky click allowed via policy.json (no grant) -> dom-change', c12.status === 200 && c12Data.verification === 'dom-change', JSON.stringify(c12Data.verification))
  const sD = await rpcJ(L2.port, L2.token, 'browser_snapshot', { tabId: tabAct3 }, 'sd')
  const pwdRefD = (sD.result.nodes.find(n => n.role === 'textbox' && n.redacted === true) || {}).ref
  const t12 = await rpcJ(L2.port, L2.token, 'browser_type', { tabId: tabAct3, ref: pwdRefD, text: 'PolicyPw-1' }, 't12')
  const t12Data = t12.result || {}
  check('sensitive typing allowed via policy.json -> value-length (length-only verify)', t12.status === 200 && t12Data.verification === 'value-length', JSON.stringify(t12Data.verification))
  const nPol = await rpcJ(L2.port, L2.token, 'browser_navigate', { tabId: tabAct3, url: 'file:///' + path.join(RUN_DIR, 'after.html').replace(/\\/g, '/') }, 'npol')
  const nPolErr = nPol.error || {}
  check('policy allowedSchemes restricts file:// -> blocked (403)', nPol.status === 403 && nPolErr.category === 'blocked', JSON.stringify(nPolErr))
  const end2 = await L2.finish()

  /* removed-flag absence: no launch used --agent-rpc-allow-risky */
  const allBridgeLogs = L1.out + L1b.out + L2.out
  check('the removed launch flag was never used', allBridgeLogs.indexOf('--agent-rpc-allow-risky') === -1)

  return finish(results.every(r => r.pass) ? 0 : 2)
}

function finish (code) {
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ ranAt: new Date().toISOString(), passed: results.filter(r => r.pass).length, total: results.length, results }, null, 2), 'utf8')
  console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed')
  try { rmrf(RUN_DIR) } catch (e) { /* ignore */ }
  process.exit(code)
}

main().catch(function (e) {
  console.error('actions probe error: ' + e.message)
  if (probeProc && probeProc.pid) { try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (ignored) { /* ignore */ } }
  try { rmrf(RUN_DIR) } catch (ignored2) { /* ignore */ }
  process.exit(2)
})
