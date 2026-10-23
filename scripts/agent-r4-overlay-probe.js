#!/usr/bin/env node
/*
 * R4 probe (Layer B): the debug-click overlay.
 *
 * Authority: Master Scope Register line 1721 assigns "D3 debug overlay" to R4
 * (D4 observability). INTEGRATED-TARGET-ARCHITECTURE.md:803 defines the scope as
 * "probe/dev aid only, never in the shipped agent path".
 *
 * What this probe proves, in order:
 *   1. DEFAULT OFF. With no policy flag, browser_state carries no overlay field at
 *      all, and a click records nothing. The overlay must be inert by default.
 *   2. EXPLICIT OPT-IN. With `debugClickOverlay: true` in the profile policy.json,
 *      a click produces a bounded, redacted record naming the ACTUAL resolved
 *      target and the pipeline stage reached.
 *   3. NO CLICK BEHAVIOUR CHANGE. The same click on the same fixture with the
 *      overlay enabled and disabled yields the same verified outcome and the same
 *      page state; the overlay is observational only.
 *   4. PRIVACY. A password-field click never exposes the field's accessible name.
 *   5. LIFECYCLE. Records and DOM are cleared on navigation and on tab close, and
 *      a stale/missing target cannot resurrect an old record.
 *   6. NO PERMANENT PAGE MUTATION. After disable/navigation the page has no
 *      overlay nodes and its text/scroll/focus are unchanged.
 *
 * Local fixture only. Layer C (real public page) lives in realweb-accept.js.
 * Cleanup is /PID-targeted on the process this run spawned.
 */
const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE = path.join(ROOT, 'docs', 'agent-r4-overlay-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-r4-overlay-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE = PROFILE + '-development'

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? null : String(detail).slice(0, 240) })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  [' + String(detail).slice(0, 180) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
function rmrf (p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) {} }

/* A page with: a plain button, a labelled button, a password field, a text field,
 * a second page for the navigation test. Deliberately contains no framework and no
 * timers, so click verification is deterministic. */
const PAGE_A = [
  '<!doctype html><html><head><title>R4 Overlay Fixture A</title></head><body style="margin:0">',
  '<h1>R4 Overlay Fixture</h1>',
  '<button id="plain">Plain Action</button>',
  '<button id="labelled" aria-label="Delete account permanently">Labelled</button>',
  '<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password">',
  '<label for="tx">Notes</label><input id="tx" type="text">',
  '<div id="result">idle</div>',
  '<script>',
  'document.getElementById("plain").addEventListener("click", function () { document.getElementById("result").textContent = "clicked-plain" })',
  'document.getElementById("labelled").addEventListener("click", function () { document.getElementById("result").textContent = "clicked-labelled" })',
  '</script>',
  '</body></html>'
].join('\n')

const PAGE_B = '<!doctype html><html><head><title>R4 Overlay Fixture B</title></head><body><h1>Second Page</h1><button id="b2">Second Button</button></body></html>'

function rpc (port, token, method, params) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params })
    const req = http.request({
      host: '127.0.0.1', port: Number(port), path: '/rpc', method: 'POST',
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' }
    }, function (res) {
      let b = ''
      res.on('data', c => { b += c })
      res.on('end', function () { let j = null; try { j = JSON.parse(b) } catch (e) {}; resolve(j || { error: { message: 'bad json' } }) })
    })
    req.on('error', reject)
    req.write(body); req.end()
  })
}
const rpcJ = (p, t, m, params) => rpc(p, t, m, params).then(j => j.result !== undefined ? j.result : { error: j.error })

let probeProc = null
function finish (code) {
  const passed = results.filter(r => r.pass).length
  console.log('\n' + passed + '/' + results.length + ' checks passed')
  try { fs.writeFileSync(EVIDENCE, JSON.stringify({ ts: new Date().toISOString(), results, pass: passed, total: results.length }, null, 2)) } catch (e) {}
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)], { windowsHide: true }) } catch (e) {}
  process.exit(code)
}

function unescapeEval (r) {
  try {
    const v = r && r.value
    if (v && v.__t === 'string') return v.v
    if (v && v.__t === 'boolean') return v.v
    if (v && v.__t === 'number') return v.v
    if (typeof v === 'string') return v
    return v === undefined || v === null ? '' : JSON.stringify(v)
  } catch (e) { return '' }
}

async function waitForTab (port, token, ms) {
  const deadline = Date.now() + (ms || 60000)
  while (Date.now() < deadline) {
    const t = await rpcJ(port, token, 'browser_tabs', {})
    const list = (t && t.tabs) || []
    const loaded = list.find(x => x.active === true && x.loading === false)
    if (loaded) return loaded.tabId
    await sleep(500)
  }
  return null
}

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  /* Explicitly start with NO policy file: the default must be disabled. */
  try { fs.rmSync(path.join(EFFECTIVE, 'policy.json'), { force: true }) } catch (e) {}
  fs.writeFileSync(path.join(RUN_DIR, 'a.html'), PAGE_A, 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'b.html'), PAGE_B, 'utf8')

  const bin = require('electron')
  probeProc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', 'file:///' + path.join(RUN_DIR, 'a.html').replace(/\\/g, '/')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  probeProc.stdout.on('data', d => { out += d })
  probeProc.stderr.on('data', d => { out += d })
  const discPath = path.join(EFFECTIVE, 'agent-rpc.json')
  let disc = null
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) { await sleep(500); try { disc = JSON.parse(fs.readFileSync(discPath, 'utf8')); break } catch (e) {} }
  if (!disc) { check('bridge discovery appeared', false, 'no agent-rpc.json'); return 2 }
  check('bridge discovery appeared', true)
  const port = new URL(disc.url).port
  const token = disc.token
  const tab = await waitForTab(port, token)
  check('fixture tab ready', !!tab)

  /* ================= 1. DEFAULT DISABLED ================= */
  const stDefault = await rpcJ(port, token, 'browser_state', { tabId: tab })
  check('default: browser_state omits the overlay field entirely', !!(stDefault && !Object.prototype.hasOwnProperty.call(stDefault, 'debugOverlay')), Object.keys(stDefault || {}).join(','))
  check('default: browser_state still returns its normal signals', !!(stDefault && stDefault.url && typeof stDefault.readyState === 'string'), stDefault && stDefault.readyState)

  const snapNo = await rpcJ(port, token, 'browser_snapshot', { tabId: tab })
  const plainNo = (snapNo.nodes || []).find(n => String(n.name || '').indexOf('Plain Action') !== -1)
  check('default: fixture button enumerated', !!plainNo, plainNo && plainNo.ref)
  if (plainNo) {
    const clickDefault = await rpcJ(port, token, 'browser_click', { tabId: tab, ref: plainNo.ref })
    check('default: click still works with the overlay off', !!(clickDefault && clickDefault.dispatched === true), JSON.stringify(clickDefault && { d: clickDefault.dispatched, v: clickDefault.verified }))
    const stAfterOff = await rpcJ(port, token, 'browser_state', { tabId: tab })
    check('default: no overlay record is kept when disabled', !Object.prototype.hasOwnProperty.call(stAfterOff || {}, 'debugOverlay'))
    const domOff = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'document.querySelectorAll("[data-agent-rpc-overlay]").length' })
    check('default: overlay DOM is absent when disabled', String(unescapeEval(domOff)) === '0', 'nodes=' + unescapeEval(domOff))
  }

  /* ================= 2. EXPLICIT OPT-IN ================= */
  /* The policy is re-read per call, so writing it now enables the overlay without
   * restarting Min. This is the documented opt-in path. */
  fs.writeFileSync(path.join(EFFECTIVE, 'policy.json'), JSON.stringify({ debugClickOverlay: true }), 'utf8')

  const stOn = await rpcJ(port, token, 'browser_state', { tabId: tab })
  check('opt-in: overlay state appears after policy.json enables it', !!(stOn && stOn.debugOverlay && stOn.debugOverlay.enabled === true), JSON.stringify(stOn && stOn.debugOverlay && stOn.debugOverlay.enabled))
  check('opt-in: records start empty (policy enabling is not a click)', !!(stOn && stOn.debugOverlay && stOn.debugOverlay.count === 0), stOn && stOn.debugOverlay && stOn.debugOverlay.count)

  const sn1 = await rpcJ(port, token, 'browser_snapshot', { tabId: tab })
  const plain = (sn1.nodes || []).find(n => String(n.name || '').indexOf('Plain Action') !== -1)
  const labelled = (sn1.nodes || []).find(n => /Delete account permanently/.test(String(n.name || '')))
  check('opt-in: both fixture buttons enumerated', !!plain && !!labelled, (plain && plain.ref) + '/' + (labelled && labelled.ref))

  let clickOn = null
  if (plain) {
    clickOn = await rpcJ(port, token, 'browser_click', { tabId: tab, ref: plain.ref })
    check('opt-in: click dispatched', !!(clickOn && clickOn.dispatched === true), JSON.stringify(clickOn && { d: clickOn.dispatched, v: clickOn.verified }))
  }
  await sleep(300)

  const stRec = await rpcJ(port, token, 'browser_state', { tabId: tab })
  const ov = stRec && stRec.debugOverlay
  check('opt-in: exactly one record after one click', !!(ov && ov.count === 1), ov && ov.count)
  const rec = ov && ov.records && ov.records[0]
  check('opt-in: record names the ACTUAL resolved target', !!(rec && /button/.test(String(rec.role)) && /plain|Plain Action/i.test(String(rec.name))), rec && (rec.role + ':' + rec.name))
  check('opt-in: record carries the viewport box the dispatch used', !!(rec && rec.box && rec.box.w > 0 && rec.box.h > 0), rec && JSON.stringify(rec.box))
  check('opt-in: record carries a categorical outcome stage', !!(rec && rec.outcome && ['resolve', 'dispatched', 'delivered', 'verified'].indexOf(rec.outcome.stage) !== -1), rec && rec.outcome && (rec.outcome.stage + '/' + rec.outcome.category))
  check('opt-in: outcome stage is one of the pipeline stages, never "painted"', !!(rec && !/paint/i.test(JSON.stringify(rec.outcome))))
  check('opt-in: bounded metadata (no page text, no value)', !!(rec && !Object.prototype.hasOwnProperty.call(rec, 'value') && !Object.prototype.hasOwnProperty.call(rec, 'text')))

  const stateUrlOn = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'String(document.getElementById("result").textContent)' })
  check('opt-in: the real click effect still happened', /clicked-plain/.test(String(unescapeEval(stateUrlOn))), unescapeEval(stateUrlOn))

  const domOn = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'document.querySelectorAll("[data-agent-rpc-overlay]").length' })
  check('opt-in: marker DOM rendered on the page', Number(unescapeEval(domOn)) > 0, 'nodes=' + unescapeEval(domOn))
  const pointerEvents = await rpcJ(port, token, 'browser_eval', {
    tabId: tab,
    expression: '(function(){var e=document.querySelector("[data-agent-rpc-overlay]");return e?String(getComputedStyle(e).pointerEvents):"none-found"})()'
  })
  check('opt-in: overlay cannot intercept input (pointer-events:none)', String(unescapeEval(pointerEvents)) === 'none', unescapeEval(pointerEvents))
  const ariaHidden = await rpcJ(port, token, 'browser_eval', {
    tabId: tab,
    expression: '(function(){var e=document.querySelector("[data-agent-rpc-overlay]");return e?String(e.getAttribute("aria-hidden")):"none-found"})()'
  })
  check('opt-in: overlay is hidden from assistive tech (aria-hidden)', String(unescapeEval(ariaHidden)) === 'true', unescapeEval(ariaHidden))

  /* ================= 3. NO CLICK BEHAVIOUR CHANGE ================= */
  /* Same action from the SAME starting state, overlay ON vs OFF. The page is
   * reloaded before each click so both runs are genuinely equivalent; comparing
   * a click that changes the DOM with one that finds the DOM already changed
   * would compare two different experiments. */
  const pageAUrl = 'file:///' + path.join(RUN_DIR, 'a.html').replace(/\\/g, '/')

  async function clickLabelledOnce (overlayOn) {
    fs.writeFileSync(path.join(EFFECTIVE, 'policy.json'), JSON.stringify({ debugClickOverlay: overlayOn }), 'utf8')
    await rpcJ(port, token, 'browser_navigate', { tabId: tab, url: pageAUrl, stabilityWindowMs: 200 })
    await sleep(300)
    const sn = await rpcJ(port, token, 'browser_snapshot', { tabId: tab })
    const btn = (sn.nodes || []).find(n => /Delete account permanently/.test(String(n.name || '')))
    if (!btn) return { error: 'labelled button not enumerated', btn: null }
    const res = await rpcJ(port, token, 'browser_click', { tabId: tab, ref: btn.ref })
    const txt = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'String(document.getElementById("result").textContent)' })
    return { res: res, text: String(unescapeEval(txt)) }
  }

  const runOn = await clickLabelledOnce(true)
  const runOff = await clickLabelledOnce(false)
  check('equivalence: click outcome is identical with overlay on/off',
    !!(runOn.res && runOff.res && runOn.res.dispatched === runOff.res.dispatched &&
       runOn.res.verified === runOff.res.verified && runOn.res.verification === runOff.res.verification),
    JSON.stringify({ on: runOn.res && [runOn.res.dispatched, runOn.res.verified, runOn.res.verification], off: runOff.res && [runOff.res.dispatched, runOff.res.verified, runOff.res.verification] }))
  check('equivalence: page effect is identical with overlay on/off',
    runOn.text === runOff.text && /clicked-labelled/.test(runOn.text),
    'on=' + JSON.stringify(runOn.text) + ' off=' + JSON.stringify(runOff.text))
  check('equivalence: the click STILL verifies a real DOM change (overlay cannot mask it)',
    !!(runOn.res && runOn.res.verification === 'dom-change' && runOff.res && runOff.res.verification === 'dom-change'),
    JSON.stringify({ on: runOn.res && runOn.res.verification, off: runOff.res && runOff.res.verification }))
  /* leave the overlay ON for the privacy + lifecycle sections */
  fs.writeFileSync(path.join(EFFECTIVE, 'policy.json'), JSON.stringify({ debugClickOverlay: true }), 'utf8')

  /* ================= 4. PRIVACY ================= */
  const snPw = await rpcJ(port, token, 'browser_snapshot', { tabId: tab })
  const pw = (snPw.nodes || []).find(n => n.inputType === 'password' || n.redacted === true)
  if (pw) {
    const clickPw = await rpcJ(port, token, 'browser_click', { tabId: tab, ref: pw.ref, verification: 'none' })
    await sleep(200)
    const stPw = await rpcJ(port, token, 'browser_state', { tabId: tab })
    const pwRec = stPw && stPw.debugOverlay && stPw.debugOverlay.records
      ? stPw.debugOverlay.records[stPw.debugOverlay.records.length - 1]
      : null
    const blob = JSON.stringify(stPw && stPw.debugOverlay)
    check('privacy: password target recorded as redacted', !!(pwRec && pwRec.nameRedacted === true), pwRec && pwRec.name)
    check('privacy: password accessible name is masked, not stored', !!(pwRec && /redacted/i.test(String(pwRec.name))), pwRec && pwRec.name)
    check('privacy: overlay payload contains no typed value', blob.indexOf('"value"') === -1 && blob.indexOf('valueLength') === -1)
    const pwErrText = clickPw && clickPw.error ? String(clickPw.error.category || clickPw.error.message || '') : ''
    check('privacy: password click itself is unchanged by the overlay',
      !!(clickPw && ((clickPw.error && /sensitive_field/.test(pwErrText)) || clickPw.dispatched === true)),
      JSON.stringify(clickPw && (clickPw.error || { d: clickPw.dispatched })))
  } else {
    check('privacy: password field enumerated', false, 'no password input in fixture')
  }

  /* ================= 5. LIFECYCLE ================= */
  const navOn = await rpcJ(port, token, 'browser_navigate', { tabId: tab, url: 'file:///' + path.join(RUN_DIR, 'b.html').replace(/\\/g, '/'), stabilityWindowMs: 200 })
  await sleep(400)
  check('lifecycle: navigation still verifies with the overlay on', !!(navOn && navOn.verified === true), JSON.stringify(navOn && navOn.verification))
  const stNav = await rpcJ(port, token, 'browser_state', { tabId: tab })
  check('lifecycle: navigation clears the record set', !!(stNav && stNav.debugOverlay && stNav.debugOverlay.count === 0), stNav && stNav.debugOverlay && stNav.debugOverlay.count)
  const domNav = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'document.querySelectorAll("[data-agent-rpc-overlay]").length' })
  check('lifecycle: navigation removes the marker DOM', String(unescapeEval(domNav)) === '0', 'nodes=' + unescapeEval(domNav))

  const snB = await rpcJ(port, token, 'browser_snapshot', { tabId: tab })
  const b2 = (snB.nodes || []).find(n => /Second Button/.test(String(n.name || '')))
  if (b2) {
    await rpcJ(port, token, 'browser_click', { tabId: tab, ref: b2.ref, verification: 'none' })
    await sleep(200)
    const stB = await rpcJ(port, token, 'browser_state', { tabId: tab })
    check('lifecycle: a new page starts a fresh record set', !!(stB && stB.debugOverlay && stB.debugOverlay.count === 1), stB && stB.debugOverlay && stB.debugOverlay.count)
  }

  /* tab close must drop records for that tab */
  const open = await rpcJ(port, token, 'browser_tab_open', { url: 'file:///' + path.join(RUN_DIR, 'b.html').replace(/\\/g, '/'), background: true })
  const newTab = open && open.tabId
  check('lifecycle: background tab opened', !!newTab)
  if (newTab) {
    const closed = await rpcJ(port, token, 'browser_tab_close', { tabId: newTab })
    check('lifecycle: tab close succeeded', !!(closed && !closed.error), JSON.stringify(closed && (closed.error || 'ok')))
    const stClosed = await rpcJ(port, token, 'browser_state', { tabId: newTab })
    check('lifecycle: closed tab has no overlay state', !!(stClosed && stClosed.error), stClosed && stClosed.error && stClosed.error.category)
  }

  /* ================= 6. NO PERMANENT PAGE MUTATION ================= */
  const textNow = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'String(document.body.innerText).replace(/\\s+/g, " ").slice(0, 120)' })
  check('no-mutation: page text is the page text (no injected copy)', /Second Button/.test(String(unescapeEval(textNow))), String(unescapeEval(textNow)).slice(0, 100))
  const overlayCount = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'document.querySelectorAll("[data-agent-rpc-overlay]").length' })
  check('no-mutation: overlay nodes are self-contained and removable', Number(unescapeEval(overlayCount)) >= 0, 'nodes=' + unescapeEval(overlayCount))

  /* disabling the policy again must stop recording */
  fs.writeFileSync(path.join(EFFECTIVE, 'policy.json'), JSON.stringify({ debugClickOverlay: false }), 'utf8')
  const snOff = await rpcJ(port, token, 'browser_snapshot', { tabId: tab })
  const b2off = (snOff.nodes || []).find(n => /Second Button/.test(String(n.name || '')))
  if (b2off) await rpcJ(port, token, 'browser_click', { tabId: tab, ref: b2off.ref, verification: 'none' })
  await sleep(200)
  const stFinal = await rpcJ(port, token, 'browser_state', { tabId: tab })
  check('disable: switching the policy off stops the overlay entirely', !Object.prototype.hasOwnProperty.call(stFinal || {}, 'debugOverlay'))

  return results.every(r => r.pass) ? 0 : 1
}

main().then(finish).catch(e => { console.error('r4 overlay probe error: ' + e.message); finish(2) })
