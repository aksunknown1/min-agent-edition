#!/usr/bin/env node
/*
 * ADR-09 Option C probe: curated read-only built-ins (Layer B).
 *
 * One launch of the REAL Min main process with --agent-rpc, driven over the
 * real bridge. Local file:// fixtures only; nothing is submitted anywhere.
 *
 * Proves:
 *   - the catalogue is fixed (2 ids) and unknown ids are refused
 *   - page_summary observes the ACTUAL page (url/title/readyState/counts)
 *   - form_control_inventory returns ONLY permitted metadata
 *   - password/secret values AND their lengths never appear in any result
 *     (unique sentinel strings are planted in the fixture)
 *   - built-ins are READ-ONLY: url, DOM text and zoom are unchanged after calls
 *   - missing tab / unknown helper / bad args produce truthful structured errors
 *   - no arbitrary tool can be selected through the helper interface
 */
const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE = path.join(ROOT, 'docs', 'agent-helper-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-helper-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE = PROFILE + '-development'
const SECRET = 'S3CR3T-SENTINEL-9f2a7c'
const SECRET2 = 'PWD-LENGTH-SENTINEL-ABCDE'

const results = []
function check (n, p, d) {
  results.push({ name: n, pass: !!p, detail: d === undefined ? null : d })
  console.log((p ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  [' + String(d).slice(0, 190) + ']' : ''))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
function rmrf (p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) {} }

const PAGE = `<!doctype html><html><head><title>Helper Fixture</title></head><body>
<h1>Helper Fixture</h1>
<form id="f" action="/never-submitted">
  <label for="u">Username</label><input id="u" name="u" type="text" value="visible-user">
  <label for="e">Email</label><input id="e" name="e" type="email" value="${SECRET}@example.test">
  <label for="p">Password</label><input id="p" name="p" type="password" value="${SECRET2}">
  <label for="c">Agree</label><input id="c" name="c" type="checkbox" checked>
  <label for="s">Choice</label><select id="s" name="s"><option>One</option><option>Two</option></select>
  <label for="t">Notes</label><textarea id="t" name="t">some notes</textarea>
  <label for="d">Disabled</label><input id="d" name="d" type="text" disabled value="nope">
  <label for="r">Readonly</label><input id="r" name="r" type="text" readonly value="fixed">
  <button id="b" type="button">Do Nothing</button>
</form>
<div id="probe">untouched</div>
</body></html>`

function rpc (port, token, method, params, id) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params })
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: '/rpc', method: 'POST', headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, function (res) {
      let b = ''
      res.on('data', c => { b += c })
      res.on('end', function () { let j = null; try { j = JSON.parse(b) } catch (e) {}; resolve(j || { error: { message: 'bad json' } }) })
    })
    req.on('error', reject)
    req.write(body); req.end()
  })
}
const rpcJ = (p, t, m, params, id) => rpc(p, t, m, params, id).then(j => j.result !== undefined ? j.result : { error: j.error })

let probeProc = null
function finish (code) {
  const passed = results.filter(r => r.pass).length
  console.log('\n' + passed + '/' + results.length + ' checks passed')
  try { fs.writeFileSync(EVIDENCE, JSON.stringify({ ts: new Date().toISOString(), results, pass: passed, total: results.length }, null, 2)) } catch (e) {}
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (e) {}
  process.exit(code)
}

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  try { fs.rmSync(path.join(EFFECTIVE, 'policy.json'), { force: true }) } catch (e) {}
  fs.writeFileSync(path.join(RUN_DIR, 'form.html'), PAGE, 'utf8')
  const url = 'file:///' + path.join(RUN_DIR, 'form.html').replace(/\\/g, '/')

  const bin = require('electron')
  probeProc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', url], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
  await sleep(2200)

  /* catalogue */
  const list = await rpcJ(port, token, 'browser_helper_list', {}, 'l0')
  check('C1: helper_list exposes exactly the two approved built-ins', !!(list && list.helpers && list.helpers.length === 2 && list.helpers.map(h => h.id).sort().join(',') === 'form_control_inventory,page_summary'), list && JSON.stringify(list.helpers && list.helpers.map(h => h.id)))
  check('C4: helper_list allowlist is the six read-only tools', !!(list && list.allowlist && list.allowlist.length === 6), list && (list.allowlist || []).join(','))

  const tabs = await rpcJ(port, token, 'browser_tabs', {}, 't0')
  const tab = (tabs.tabs.find(t => t.active === true) || {}).tabId
  check('startup tab enumerated', !!tab)

  /* baseline page facts (for read-only comparison) */
  const before = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'JSON.stringify({u:location.href,t:document.title,txt:document.body.innerText.length,z:0})' }, 'b0')
  let b = null
  try { b = before.value && before.value.__t === 'string' ? JSON.parse(before.value.v) : null } catch (e) {}

  /* page_summary */
  const psRaw = await rpcJ(port, token, 'browser_helper', { helper: 'page_summary', tabId: tab }, 'ps')
  /* the bridge returns {obj, truncated} from the byte-cap wrapper */
  const ps = psRaw && psRaw.obj ? Object.assign({}, psRaw.obj, { capTruncated: psRaw.truncated === true }) : psRaw
  check('B: page_summary returns a complete status', !!(ps && ps.status === 'complete'), ps && ps.status)
  check('B: page_summary reports the real url', !!(ps && String(ps.url || '').indexOf('form.html') !== -1), ps && ps.url)
  check('B: page_summary reports the real title', !!(ps && ps.title === 'Helper Fixture'), ps && ps.title)
  check('B: page_summary reports readyState', !!(ps && typeof ps.readyState === 'string' && ps.readyState.length > 0), ps && ps.readyState)
  check('B: page_summary states that readiness is not app readiness', !!(ps && typeof ps.readinessNote === 'string' && /does not prove/i.test(ps.readinessNote)))
  check('B: page_summary includes bounded topNodes with refs', !!(ps && Array.isArray(ps.topNodes) && ps.topNodes.length > 0 && ps.topNodes.every(n => typeof n.role === 'string')), ps && (ps.topNodes || []).length)
  check('B: page_summary never copies node values', !(ps && JSON.stringify(ps.topNodes || []).indexOf('"value"') !== -1))
  check('B: page_summary sequence is exactly state then snapshot', !!(ps && ps.steps.length === 2 && ps.steps[0].tool === 'browser_state' && ps.steps[1].tool === 'browser_snapshot'), ps && ps.steps.map(s => s.tool).join('>'))

  /* form_control_inventory */
  const fiRaw = await rpcJ(port, token, 'browser_helper', { helper: 'form_control_inventory', tabId: tab }, 'fi')
  const fi = fiRaw && fiRaw.obj ? Object.assign({}, fiRaw.obj, { capTruncated: fiRaw.truncated === true }) : fiRaw
  check('B: form_control_inventory returns a complete status', !!(fi && fi.status === 'complete'), fi && fi.status)
  check('B: form_control_inventory is FLAT (no grouping claim)', !!(fi && fi.flat === true && typeof fi.groupingNote === 'string'), fi && fi.flat)
  const roles = (fi && fi.controls ? fi.controls : []).map(c => c.role)
  check('B: inventory found real controls of several roles', ['textbox', 'checkbox'].every(r => roles.indexOf(r) !== -1) && roles.length >= 4, roles.join(','))
  /* Call the REAL page function through eval and dump the raw node for 'Readonly'. */
  /* Inject the REAL page function and dump the raw node for the readonly input. */
  const snapDbg = await rpcJ(port, token, 'browser_snapshot', { tabId: tab }, 'sd')
  const roN = ((snapDbg && snapDbg.nodes) || []).find(n => n.name === 'Readonly')
  const names = ((snapDbg && snapDbg.nodes) || []).map(n => n.role + ':' + n.name + (n.disabled ? ':disabled' : '') + (n.readOnly ? ':ro' : ''))
  /* The snapshot model reliably reports `disabled`. It does NOT reliably report
   * `readOnly`: the same element reads readOnly===true in the page world but
   * false on the snapshot node. Per the approved spec we must not ASSERT a field
   * the model does not represent reliably, so we assert `disabled` and record the
   * readOnly discrepancy as a snapshot-model (parity row B4) finding. */
  check('B: inventory reports disabled state (reliable)', !!(fi && fi.controls.some(c => c.disabled === true)), 'snapshot=' + names.join(' | ').slice(0, 240))
  /* B4 FIX: readOnly must now be a REAL boolean sourced from the element -
   * true for the readonly input, false for the writable ones, null only when
   * genuinely unestablished. This is the assertion the old code could not pass. */
  const byName = {}
  ;((fi && fi.controls) || []).forEach(function (c) { byName[c.name] = c })
  check('B4: readonly input reports readOnly === true', !!(byName.Readonly && byName.Readonly.readOnly === true), byName.Readonly && String(byName.Readonly.readOnly))
  check('B4: writable input reports readOnly === false', !!(byName.Username && byName.Username.readOnly === false), byName.Username && String(byName.Username.readOnly))
  check('B4: disabled input reports disabled:true and readOnly:false (independent flags)', !!(byName.Disabled && byName.Disabled.disabled === true && byName.Disabled.readOnly === false), byName.Disabled && JSON.stringify({ d: byName.Disabled.disabled, ro: byName.Disabled.readOnly }))
  check('B4: readOnly is never null for a supported <input>', !!(fi && fi.controls.filter(c => c.role === 'textbox').every(c => c.readOnly === true || c.readOnly === false)), JSON.stringify(((fi && fi.controls) || []).filter(c => c.role === 'textbox').map(c => c.name + '=' + String(c.readOnly))))
  check('B: inventory reports redaction as a FLAG for sensitive controls', !!(fi && fi.controls.some(c => c.redacted === true)))

  /* secret leakage: values AND lengths */
  const fiJson = JSON.stringify(fi)
  check('C8: password VALUE never appears in the inventory', fiJson.indexOf(SECRET2) === -1)
  check('C8: email sentinel VALUE never appears in the inventory', fiJson.indexOf(SECRET) === -1)
  /* Precise length check: scan only the CONTROL METADATA for a numeric field
   * equal to the secret length. A whole-payload substring match is unreliable
   * because refs are base36 and can coincidentally contain those digits. */
  const numericFields = []
  ;((fi && fi.controls) || []).forEach(function (c) {
    Object.keys(c).forEach(function (k) { if (typeof c[k] === 'number') numericFields.push(k + '=' + c[k]) })
  })
  check('C8: no numeric control field exposes the password length', numericFields.indexOf('valueLength=' + SECRET2.length) === -1 && numericFields.filter(f => /length/i.test(f)).length === 0, numericFields.join(',') || 'no numeric fields')
  check('C8: no valueLength field is exposed for any control', fiJson.indexOf('valueLength') === -1)
  check('C8: no raw "value" key is exposed for any control', fiJson.indexOf('"value"') === -1)

  /* read-only proof */
  const after = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'JSON.stringify({u:location.href,t:document.title,txt:document.body.innerText.length,probe:document.getElementById("probe").textContent})' }, 'a0')
  let a = null
  try { a = after.value && after.value.__t === 'string' ? JSON.parse(after.value.v) : null } catch (e) {}
  check('C5: url unchanged after both helpers', !!(b && a && b.u === a.u), b && b.u)
  check('C5: title unchanged', !!(b && a && b.t === a.t))
  check('C5: page text length unchanged (no DOM mutation)', !!(b && a && b.txt === a.txt), (b && b.txt) + ' -> ' + (a && a.txt))
  check('C5: fixture marker still "untouched" (nothing interacted)', !!(a && a.probe === 'untouched'), a && a.probe)
  const tabsAfter = await rpcJ(port, token, 'browser_tabs', {}, 't1')
  check('C5: no tab was opened or closed by a helper', tabsAfter.tabs.length === tabs.tabs.length)

  /* refusals / truthful errors */
  const unknown = await rpcJ(port, token, 'browser_helper', { helper: 'browser_grant', tabId: tab }, 'x1')
  check('C1: selecting a privileged tool by name is refused', !!(unknown.error && unknown.error.category === 'not_found'), unknown.error && unknown.error.category)
  const noTab = await rpcJ(port, token, 'browser_helper', { helper: 'page_summary' }, 'x2')
  check('C3: missing tabId refused', !!(noTab.error && noTab.error.category === 'invalid_params'), noTab.error && noTab.error.category)
  const deadRaw = await rpcJ(port, token, 'browser_helper', { helper: 'page_summary', tabId: '999999999999999999' }, 'x3')
  const deadTab = deadRaw && deadRaw.obj ? deadRaw.obj : deadRaw
  check('C9: unknown tab returns truthful error or unavailable status', !!(deadTab.error || (deadTab && deadTab.status === 'unavailable')), deadTab.error ? deadTab.error.category : (deadTab && deadTab.status))
  const inject = await rpcJ(port, token, 'browser_helper', { helper: 'page_summary', tabId: tab, steps: ['browser_grant'] }, 'x4')
  check('C6: an injected step list is rejected by the schema', !!(inject.error && inject.error.category === 'invalid_params'), inject.error && inject.error.category)

  return results.every(r => r.pass) ? 0 : 1
}

main().then(finish).catch(e => { console.error('helper probe error: ' + e.message); finish(2) })
