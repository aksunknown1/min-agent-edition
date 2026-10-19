#!/usr/bin/env node
/*
 * P1-01C inputs + Shadow DOM probe.
 *
 * One launch of the REAL Min main process with --agent-rpc (P0-08 single-URL
 * argv rule). Fixtures are local file:// pages; no live sites, no forms
 * submitted to any server except nothing (submission is JS-local).
 *
 * Sections:
 *   react:      controlled React-emulation input - typed value is verified by
 *               read-back (verification 'value', strategy native-insert), the
 *               framework STATE is proven via a JS-local submit writing
 *               SUBMIT-STATE:<len> which browser_content reads back;
 *               ordinary non-controlled input still verifies without fallback.
 *   hostile:    input that blocks trusted beforeinput (insertText fails) ->
 *               one bounded fallback retry with the native value setter +
 *               input/change events -> verified value with
 *               strategy=native-setter-fallback.
 *   reject:     controlled input that resets every change -> after both
 *               strategies -> verified=false, verification=rejected-input.
 *   shadow:     nested OPEN shadow roots - discover (incl. depth-2), refs
 *               usable for click + type, shadowPath recorded, closed shadow
 *               root content NOT inspectable, deterministic ordering across
 *               two snapshots.
 *   stale:      element removed after snapshot -> browser_type on the old ref
 *               fails with ref_stale (clear failure, never a wrong element).
 *
 * Durations (ms) of every snapshot/type/click call are recorded in the
 * evidence file. No fixed sleeps beyond the verification windows themselves.
 */

const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-inputs-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-inputs-probe')
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

/* Controlled React-emulation form: the input listener reads the DOM value,
 * updates state, then re-writes el.value from state (what React's controlled
 * render does). Submission is JS-local and records the STATE (not the DOM),
 * which is what "the framework's state actually updates" means. */
const PAGE_REACT =
  '<!doctype html><html><head><title>Controlled Form</title></head><body>' +
  '<h1>Controlled Form Heading</h1>' +
  '<form id="f">' +
  '<label for="ci">Controlled Field</label>' +
  '<input id="ci" type="text" value="">' +
  '<label for="plain">Plain Field</label>' +
  '<input id="plain" type="text" value="">' +
  '<button id="rm" type="button">Remove Input</button>' +
  '<button id="go" type="button">Submit State</button>' +
  '</form>' +
  '<div id="out">initial</div>' +
  '<script>' +
  'var state = { ci: "", plain: "" };' +
  'var ci = document.getElementById("ci");' +
  'ci.addEventListener("input", function () {' +
  '  state.ci = ci.value;' +
  '  ci.value = state.ci; /* controlled reset from state */' +
  '});' +
  'var plain = document.getElementById("plain");' +
  'document.getElementById("go").addEventListener("click", function () {' +
  '  document.getElementById("out").textContent = "SUBMIT-STATE-ci-len:" + state.ci.length + "|plain-len:" + state.plain.length;' +
  '});' +
  'document.getElementById("rm").addEventListener("click", function () {' +
  '  plain.remove();' +
  '});' +
  '</script></body></html>'

/* Blocks trusted insertText via beforeinput preventDefault, but keeps a
 * controlled 'input' handler; the native-setter fallback must win here. */
const PAGE_HOSTILE =
  '<!doctype html><html><head><title>Hostile Input</title></head><body>' +
  '<h1>Hostile Input Heading</h1>' +
  '<label for="hi">Hostile Field</label>' +
  '<input id="hi" type="text" value="">' +
  '<script>' +
  'var hi = document.getElementById("hi");' +
  'hi.addEventListener("beforeinput", function (e) { e.preventDefault(); });' +
  'hi.addEventListener("input", function () { document.title = "state:" + hi.value.length; });' +
  '</script></body></html>'

/* Controlled input that rejects ALL changes: state stays "" and the render
 * resets the DOM value - both strategies must end as rejected-input. */
const PAGE_REJECT =
  '<!doctype html><html><head><title>Rejecting Form</title></head><body>' +
  '<h1>Rejecting Form Heading</h1>' +
  '<label for="rj">Rejecting Field</label>' +
  '<input id="rj" type="text" value="">' +
  '<script>' +
  'var rj = document.getElementById("rj");' +
  'rj.addEventListener("input", function () { rj.value = ""; });' +
  '</script></body></html>'

/* Nested OPEN shadow roots + a CLOSED root that must stay invisible. */
const PAGE_SHADOW =
  '<!doctype html><html><head><title>Shadow Host Page</title></head><body>' +
  '<h1>Shadow Host Heading</h1>' +
  '<div id="host1"></div>' +
  '<div id="clossed"></div>' +
  '<script>' +
  'var host1 = document.getElementById("host1");' +
  'var r1 = host1.attachShadow({ mode: "open" });' +
  'r1.innerHTML = "<div id=host2></div><button id=b1>Shadow Deep Button</button>";' +
  'var host2 = r1.getElementById("host2");' +
  'var r2 = host2.attachShadow({ mode: "open" });' +
  'r2.innerHTML = "<button id=b2>Shadow Nested Button</button><label for=s2in>Shadow Field</label><input id=s2in type=text value=>";' +
  'var r2in = r2.getElementById("s2in");' +
  'r2in.addEventListener("input", function () { r2.getElementById("b2").textContent = "Shadow Nested Button (" + r2in.value.length + ")"; });' +
  'var closedHost = document.getElementById("clossed");' +
  'closedHost.attachShadow({ mode: "closed" }).innerHTML = "<button>Closed Secret Button</button>";' +
  'var deepMark = document.createElement("div"); deepMark.id = "deepmark"; deepMark.textContent = "not-clicked"; document.body.appendChild(deepMark); r1.getElementById("b1").addEventListener("click", function () { deepMark.textContent = "deep-clicked-now"; });' +
  '</script></body></html>'

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
  const t0 = Date.now()
  const r = await rpc(port, token, method, params, id)
  const dur = Date.now() - t0
  let result = null
  let error = null
  try {
    const frame = JSON.parse(r.body)
    result = frame.result !== undefined ? frame.result : null
    error = frame.error !== undefined ? frame.error : null
  } catch (e) { /* raw via detail */ }
  if (method === 'browser_snapshot' || method === 'browser_type' || method === 'browser_click' || method === 'browser_content') {
    timings.push({ method, ms: dur, status: r.status })
  }
  return { status: r.status, rawBody: r.body, result, error, ms: dur }
}

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  try { fs.rmSync(path.join(EFFECTIVE_PROFILE, 'policy.json'), { force: true }) } catch (e) { /* ignore */ }
  ;['react', 'hostile', 'reject', 'shadow'].forEach(function (n) {
    fs.writeFileSync(path.join(RUN_DIR, n + '.html'), { react: PAGE_REACT, hostile: PAGE_HOSTILE, reject: PAGE_REJECT, shadow: PAGE_SHADOW }[n], 'utf8')
  })
  const fileUrl = n => 'file:///' + path.join(RUN_DIR, n + '.html').replace(/\\/g, '/')
  const urls = ['shadow', 'hostile', 'reject', 'react'].map(fileUrl) /* last = selected */

  const bin = require('electron')
  const args = ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--'].concat(urls)
  const proc = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  probeProc = proc
  let out = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { out += d })
  let killedByUs = false
  proc.on('exit', function () { /* handled via taskkill at end */ })

  const discPath = path.join(EFFECTIVE_PROFILE, 'agent-rpc.json')
  let disc = null
  const started = Date.now()
  while (Date.now() - started < 60000) {
    await sleep(500)
    try { disc = JSON.parse(fs.readFileSync(discPath, 'utf8')); break } catch (e) { /* wait */ }
  }
  if (!disc) {
    check('bridge discovery appeared', false, 'no agent-rpc.json within 60s')
    printSummary(2)
    try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (e) { /* ignore */ }
    process.exit(2)
  }
  check('bridge discovery appeared', true)
  const u = new URL(disc.url)
  const port = u.port
  const token = disc.token

  /* settle the initial load */
  await sleep(2500)

  const tabsR = await rpcJ(port, token, 'browser_tabs', {}, 't0')
  const tabMain = (tabsR.result.tabs.find(t => t.active === true) || tabsR.result.tabs[0] || {}).tabId
  check('startup tab enumerated', !!tabMain)
  const navTo = async (name, id) => {
    const r = await rpcJ(port, token, 'browser_navigate', { tabId: tabMain, url: fileUrl(name), stabilityWindowMs: 300 }, id)
    return r.result
  }

  /* ---------- react: controlled input verified by read-back + state proof ---------- */
  const nReact = await navTo('react', 'nreact')
  check('navigate to controlled form -> verified', nReact && nReact.verified === true, JSON.stringify(nReact && { verification: nReact.verification, finalUrl: nReact.finalUrl }))
  await sleep(600)
  const sR = await rpcJ(port, token, 'browser_snapshot', { tabId: tabMain }, 'sreact')
  const nodesR = (sR.result && sR.result.nodes) || []
  const ciRef = (nodesR.find(n => n.role === 'textbox' && n.name === 'Controlled Field') || {}).ref
  const plainRef = (nodesR.find(n => n.role === 'textbox' && n.name === 'Plain Field') || {}).ref
  const goRef = (nodesR.find(n => n.role === 'button' && n.name === 'Submit State') || {}).ref
  const rmRef = (nodesR.find(n => n.role === 'button' && n.name === 'Remove Input') || {}).ref
  check('controlled + plain inputs enumerated', !!ciRef && !!plainRef && !!goRef && !!rmRef, 'ci=' + !!ciRef + ' plain=' + !!plainRef)

  const typed = 'controlled-17'
  const tR = await rpcJ(port, token, 'browser_type', { tabId: tabMain, ref: ciRef, text: typed }, 'treact')
  const tRd = tR.result || {}
  check('controlled input typed -> verified value WITHOUT fallback', tR.status === 200 && tRd.verified === true && tRd.verification === 'value' && tRd.strategy === 'native-insert',
    JSON.stringify(tRd && { verification: tRd.verification, strategy: tRd.strategy }))

  /* framework STATE proof: JS-local submit writes state lengths; content read-back */
  const cGo = await rpcJ(port, token, 'browser_click', { tabId: tabMain, ref: goRef }, 'cgo')
  await sleep(600)
  const cOut = await rpcJ(port, token, 'browser_content', { tabId: tabMain }, 'cout')
  const outText = (cOut.result && cOut.result.text) || ''
  check('framework STATE received the typed value (submit -> content proof)', outText.indexOf('SUBMIT-STATE-ci-len:' + typed.length) !== -1,
    'content has SUBMIT-STATE-ci-len:' + typed.length + ' -> ' + outText.indexOf('SUBMIT-STATE-ci-len:' + typed.length) !== -1)

  /* ordinary uncontrolled input verifies without fallback too */
  const tP = await rpcJ(port, token, 'browser_type', { tabId: tabMain, ref: plainRef, text: 'plain-123' }, 'tplain')
  const tPd = tP.result || {}
  check('ordinary input typed -> verified value, no fallback', tP.status === 200 && tPd.verified === true && tPd.verification === 'value' && tPd.strategy === 'native-insert',
    JSON.stringify(tPd && { verification: tPd.verification, strategy: tPd.strategy }))

  /* ---------- hostile: insertText blocked -> native-setter fallback wins ---------- */
  await navTo('hostile', 'nhost')
  await sleep(600)
  const sH = await rpcJ(port, token, 'browser_snapshot', { tabId: tabMain }, 'shost')
  const hiRef = (((sH.result || {}).nodes) || []).find(n => n.role === 'textbox' && n.name === 'Hostile Field')
  check('hostile input enumerated', !!hiRef)
  const tH = await rpcJ(port, token, 'browser_type', { tabId: tabMain, ref: hiRef.ref, text: 'fallback-9' }, 'thost')
  const tHd = tH.result || {}
  check('hostile input -> fallback engaged and verified value', tH.status === 200 && tHd.verified === true && tHd.verification === 'value' && tHd.strategy === 'native-setter-fallback',
    JSON.stringify(tHd && { verification: tHd.verification, strategy: tHd.strategy, failReason: tHd.failReason }))

  /* ---------- reject: framework rejects -> rejected-input, verified=false ---------- */
  await navTo('reject', 'nrej')
  await sleep(600)
  const sJ = await rpcJ(port, token, 'browser_snapshot', { tabId: tabMain }, 'srej')
  const rjRef = (((sJ.result || {}).nodes) || []).find(n => n.role === 'textbox' && n.name === 'Rejecting Field')
  check('rejecting input enumerated', !!rjRef)
  const tJ = await rpcJ(port, token, 'browser_type', { tabId: tabMain, ref: rjRef.ref, text: 'nope' }, 'trej')
  const tJd = tJ.result || {}
  check('rejecting controlled input -> rejected-input, verified=false, no throw',
    tJ.status === 200 && tJd.verified === false && tJd.verification === 'rejected-input',
    JSON.stringify(tJd && { verification: tJd.verification, strategy: tJd.strategy }))

  /* ---------- shadow: nested open roots, closed root invisible ---------- */
  await navTo('shadow', 'nshadow')
  await sleep(800)
  const sS1 = await rpcJ(port, token, 'browser_snapshot', { tabId: tabMain }, 'sshadow1')
  const nodesS = (sS1.result && sS1.result.nodes) || []
  const namesS = nodesS.map(n => n.role + ':' + n.name)
  check('open shadow depth-1 button discovered', namesS.some(x => x.indexOf('Shadow Deep Button') !== -1), JSON.stringify(namesS).slice(0, 200))
  check('open shadow nested depth-2 button + field discovered',
    namesS.some(x => x.indexOf('Shadow Nested Button') !== -1) && nodesS.some(n => n.name === 'Shadow Field' && n.role === 'textbox'))
  const deepNode = nodesS.find(n => n.name === 'Shadow Deep Button')
  const nestedField = nodesS.find(n => n.name === 'Shadow Field')
  check('shadow nodes carry shadowPath locator context', !!deepNode && typeof deepNode.shadowPath === 'string' && deepNode.shadowPath.indexOf('::shadow') !== -1 &&
    !!nestedField && typeof nestedField.shadowPath === 'string' && (nestedField.shadowPath.match(/::shadow/g) || []).length >= 1,
    'deep=' + JSON.stringify(deepNode && deepNode.shadowPath) + ' field=' + JSON.stringify(nestedField && nestedField.shadowPath))
  check('closed shadow root content NOT inspectable', !namesS.some(x => x.indexOf('Closed Secret Button') !== -1),
    'closed content in snapshot: ' + namesS.some(x => x.indexOf('Closed Secret') !== -1))
  const sS2 = await rpcJ(port, token, 'browser_snapshot', { tabId: tabMain }, 'sshadow2')
  const nodesS2 = (sS2.result && sS2.result.nodes) || []
  const namesS2 = nodesS2.map(n => n.role + ':' + n.name)
  check('shadow enumeration deterministic (two snapshots identical order)', JSON.stringify(namesS) === JSON.stringify(namesS2), 'differs')

  /* shadow refs are usable: type into the nested shadow field. Refs act on
   * the LATEST snapshot's store (each snapshot replaces the store). */
  const nestedField2 = nodesS2.find(n => n.name === 'Shadow Field' && n.role === 'textbox')
  const tS = await rpcJ(port, token, 'browser_type', { tabId: tabMain, ref: (nestedField2 || nestedField).ref, text: 'shadow-7' }, 'tshadow')
  const tSd = tS.result || {}
  check('type into nested shadow field -> verified value', tS.status === 200 && tSd.verified === true && tSd.verification === 'value',
    JSON.stringify({ status: tS.status, error: tS.error && tS.error.category, result: tS.result, ms: tS.ms }))
  /* click the deep shadow button (native event, composed path reaches listener) */
  const deepNode2 = nodesS2.find(n => n.name === 'Shadow Deep Button' && n.role === 'button')
  const cS = await rpcJ(port, token, 'browser_click', { tabId: tabMain, ref: (deepNode2 || deepNode).ref }, 'cshadow')
  check('click deep shadow button dispatched+verified', cS.status === 200 && (cS.result || {}).verified === true, JSON.stringify((cS.result && cS.result.verification) || (cS.error && cS.error.category) || cS.status))

  /* ---------- stale reference: element removed -> ref_stale, clear failure ---------- */
  await navTo('react', 'nstale')
  await sleep(600)
  const sSt = await rpcJ(port, token, 'browser_snapshot', { tabId: tabMain }, 'sstale')
  const stPlain = (((sSt.result || {}).nodes) || []).find(n => n.name === 'Plain Field' && n.role === 'textbox')
  const stRm = (((sSt.result || {}).nodes) || []).find(n => n.name === 'Remove Input' && n.role === 'button')
  check('stale fixture enumerated', !!stPlain && !!stRm)
  await rpcJ(port, token, 'browser_click', { tabId: tabMain, ref: stRm.ref }, 'crm')
  await sleep(500)
  const tSt = await rpcJ(port, token, 'browser_type', { tabId: tabMain, ref: stPlain.ref, text: 'gone' }, 'tstale')
  check('typing with stale ref -> ref_stale (clear failure, no wrong-element action)',
    tSt.error && tSt.error.category === 'ref_stale', JSON.stringify(tSt.error && { category: tSt.error.category, code: tSt.error.code }))
}

function printSummary (code) {
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({
    ranAt: new Date().toISOString(),
    passed: results.filter(r => r.pass).length,
    total: results.length,
    timings: timings,
    results
  }, null, 2), 'utf8')
  console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed')
  console.log('timings: ' + JSON.stringify(timings))
  return code
}

process.on('exit', function () { try { rmrf(RUN_DIR) } catch (e) { /* ignore */ } })

main().then(function (end) {
  const code = printSummary(0)
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (e) { /* ignore */ }
  process.exit(code)
}).catch(function (e) {
  console.error('inputs probe error: ' + e.message)
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (ignored) { /* ignore */ }
  printSummary(2)
  process.exit(2)
})
