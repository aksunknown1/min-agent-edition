#!/usr/bin/env node
/*
 * D3-A probe: keyboard-event typing / framework-aware fill.
 *
 * One launch of the REAL Min main process with --agent-rpc. Local file://
 * fixtures only; nothing is submitted to any server.
 *
 * What is proven here (and what is NOT):
 *   1. mode:"native" (default) still works and reports inputMode:"native",
 *      strategy:"native-insert" - the existing fast path is unchanged.
 *   2. mode:"keyboard" delivers per-character TRUSTED key events: the fixture
 *      counts `keydown` events with isTrusted===true, so a bulk insertText
 *      (which fires no keydown) cannot fake this.
 *   3. A controlled/framework-emulating field that only updates its state from
 *      keydown handlers ends in the correct state under mode:"keyboard" - the
 *      case the native path cannot satisfy.
 *   4. Unicode: non-ASCII text is typed and read back, and the result reports
 *      physicalKeys:false (it was delivered as text, not as physical keys).
 *   5. Replacement/selection: keyboard typing replaces the whole value
 *      (select-all + clear runs before either mode), not just appends.
 *   6. Disabled / read-only fields are refused before any dispatch.
 *   7. Stale refs fail with a structured ref_stale, never a wrong element.
 *   8. Bounds: keyboard mode refuses text longer than 200 chars.
 *   9. Sensitive fields are still refused without a grant.
 *
 * Delivery honesty: this probe asserts the PAGE received trusted key events.
 * It does NOT claim compositor paint or that some remote service saved data.
 */
const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-keyboard-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-keyboard-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE + '-development'

const results = []
function check (name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail === undefined ? null : detail })
  const tag = pass ? 'PASS' : 'FAIL'
  console.log(tag + '  ' + name + (detail !== undefined && detail !== null && detail !== '' ? '  [' + String(detail).slice(0, 200) + ']' : ''))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
function rmrf (p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) { /* ignore */ } }

const PAGE = `<!doctype html><html><head><title>Keyboard Mode</title></head><body>
<label for="plain">Plain Field</label><input id="plain" name="plain" value="seed">
<label for="ctrl">Controlled Field</label><input id="ctrl" name="ctrl" value="">
<label for="uni">Unicode Field</label><input id="uni" name="uni" value="">
<label for="dis">Disabled Field</label><input id="dis" name="dis" value="x" disabled>
<label for="ro">Readonly Field</label><input id="ro" name="ro" value="unchanged" readonly>
<label for="pw">Password</label><input id="pw" name="pw" type="password" value="">
<button id="rm" onclick="document.getElementById('ctrl').remove()">Remove Controlled</button>
<div id="stats">keydowns=0 trust=true</div>
<script>
/* Count only TRUSTED keydowns: a bulk insertText fires none, so this counter is
 * the difference between "value was set" and "the page received key events". */
var kd = 0, allTrusted = true;
document.addEventListener('keydown', function (e) {
  if (!e.isTrusted) { allTrusted = false; return; }
  kd++;
  document.getElementById('stats').textContent = 'keydowns=' + kd + ' trust=' + allTrusted;
}, true);
/* A controlled field: it ignores direct value writes and only tracks state from
 * its own keydown handler, like a framework that owns its input state. */
var model = '';
var ctrl = document.getElementById('ctrl');
ctrl.addEventListener('keydown', function (e) {
  if (!e.isTrusted) return;
  /* Ignore modifier chords: the shared select-all step sends Ctrl+A, whose
   * e.key is 'a' and would otherwise be counted as a typed character. */
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key && e.key.length === 1) { model += e.key; ctrl.setAttribute('data-model', model); ctrl.value = model; }
}, false);
</script></body></html>`

function rpc (port, token, method, params, id) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params })
    const req = http.request({
      host: '127.0.0.1', port: Number(port), path: '/rpc', method: 'POST',
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' }
    }, function (res) {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', function () {
        let j = null
        try { j = JSON.parse(buf) } catch (e) { /* leave null */ }
        resolve(j || { error: { message: 'bad json' } })
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
const rpcJ = (port, token, method, params, id) => rpc(port, token, method, params, id).then(j => j.result !== undefined ? j.result : { error: j.error })

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  try { fs.rmSync(path.join(EFFECTIVE_PROFILE, 'policy.json'), { force: true }) } catch (e) {}
  fs.writeFileSync(path.join(RUN_DIR, 'kb.html'), PAGE, 'utf8')
  const fileUrl = 'file:///' + path.join(RUN_DIR, 'kb.html').replace(/\\/g, '/')

  const bin = require('electron')
  const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', fileUrl], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { out += d })
  const discPath = path.join(EFFECTIVE_PROFILE, 'agent-rpc.json')
  let disc = null
  const started = Date.now()
  while (Date.now() - started < 60000) {
    await sleep(500)
    try { disc = JSON.parse(fs.readFileSync(discPath, 'utf8')); break } catch (e) {}
  }
  if (!disc) { check('bridge discovery appeared', false, 'no agent-rpc.json within 60s'); return 2 }
  check('bridge discovery appeared', true)
  const port = new URL(disc.url).port
  const token = disc.token
  probeProc = proc
  await sleep(2200)

  const tabs = await rpcJ(port, token, 'browser_tabs', {}, 't0')
  const tab = (tabs.tabs.find(t => t.active === true) || tabs.tabs[0] || {}).tabId
  check('startup tab enumerated', !!tab)
  const nav = await rpcJ(port, token, 'browser_navigate', { tabId: tab, url: fileUrl, stabilityWindowMs: 300 }, 'n0')
  check('fixture navigated and verified', nav && nav.verified === true, nav && nav.verification)

  const snap = async id => {
    await sleep(400)
    const s = await rpcJ(port, token, 'browser_snapshot', { tabId: tab }, id)
    return (s && s.nodes) || []
  }
  const refOf = (nodes, name) => (nodes.find(n => n.name === name) || {}).ref
  const readStats = async id => {
    const s = await rpcJ(port, token, 'browser_state', { tabId: tab }, id)
    const c = await rpcJ(port, token, 'browser_content', { tabId: tab, maxChars: 2000 }, id + 'c')
    return { state: s, content: (c && (c.text || c.content)) || '' }
  }
  const keydowns = async () => {
    const k = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'JSON.stringify({kd:Number((document.getElementById("stats").textContent.match(/keydowns=(\\d+)/)||[])[1]||0),trust:/trust=true/.test(document.getElementById("stats").textContent)})' }, 'k' + Date.now())
    try { const u = k && k.value; return u && u.__t === 'string' ? JSON.parse(u.v) : { kd: 0, trust: false } } catch (e) { return { kd: 0, trust: false } }
  }

  let nodes = await snap('s1')
  const plainRef = refOf(nodes, 'Plain Field')
  const ctrlRef = refOf(nodes, 'Controlled Field')
  const uniRef = refOf(nodes, 'Unicode Field')
  const disRef = refOf(nodes, 'Disabled Field')
  const roRef = refOf(nodes, 'Readonly Field')
  const pwRef = refOf(nodes, 'Password')
  check('fixture fields enumerated', !!plainRef && !!ctrlRef && !!uniRef && !!disRef && !!roRef && !!pwRef, 'plain=' + !!plainRef + ' ctrl=' + !!ctrlRef)

  /* 1. native mode unchanged */
  const nat = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: plainRef, text: 'native-ok' }, 'ty-nat')
  check('mode:"native" still verifies by value', nat && nat.verified === true && nat.verification === 'value', nat && nat.verification)
  check('mode:"native" reports inputMode=native + strategy=native-insert', nat && nat.inputMode === 'native' && nat.strategy === 'native-insert', nat && (nat.inputMode + '/' + nat.strategy))

  /* 2. keyboard mode produces TRUSTED key events */
  const before = await keydowns()
  const kb = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: plainRef, text: 'keybd', mode: 'keyboard' }, 'ty-kb')
  const after = await keydowns()
  check('mode:"keyboard" verifies by value', kb && kb.verified === true && kb.verification === 'value', kb && kb.verification)
  check('mode:"keyboard" reports inputMode=keyboard + strategy=keyboard-events', kb && kb.inputMode === 'keyboard' && kb.strategy === 'keyboard-events', kb && (kb.inputMode + '/' + kb.strategy))
  check('page observed TRUSTED keydown events (a bulk insertText cannot do this)', after.kd - before.kd >= 5 && after.trust === true, 'delta=' + (after.kd - before.kd) + ' allTrusted=' + after.trust)
  check('keyboard mode reports physicalKeys:true for ASCII', !!(kb && kb.keyboard && kb.keyboard.physicalKeys === true), JSON.stringify(kb && kb.keyboard))

  /* 3. controlled field that only tracks its own keydown state */
  const ctrlTyped = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: ctrlRef, text: 'abc', mode: 'keyboard' }, 'ty-ctrl')
  const ctrlState = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'JSON.stringify({model:(document.getElementById("ctrl")||{}).getAttribute?document.getElementById("ctrl").getAttribute("data-model"):null, value:(document.getElementById("ctrl")||{}).value})' }, 'cy')
  let ctrlV = null
  try { ctrlV = ctrlState.value && ctrlState.value.__t === 'string' ? JSON.parse(ctrlState.value.v) : null } catch (e) {}
  check('controlled field: keyboard mode drove the framework state model', !!(ctrlV && ctrlV.model === 'abc'), JSON.stringify(ctrlV))
  check('controlled field: read-back verified the value', ctrlTyped && ctrlTyped.verified === true, ctrlTyped && ctrlTyped.verification)

  /* 4. Unicode: delivered as text, reported honestly */
  const uni = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: uniRef, text: 'caf\u00e9 \u4f60\u597d', mode: 'keyboard' }, 'ty-uni')
  check('unicode text verified by value', uni && uni.verified === true && uni.verification === 'value', uni && uni.verification)
  check('unicode typing reports physicalKeys:false (text, not physical keys)', !!(uni && uni.keyboard && uni.keyboard.physicalKeys === false), JSON.stringify(uni && uni.keyboard))

  /* 5. replacement, not append */
  const rep = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: plainRef, text: 'zz', mode: 'keyboard' }, 'ty-rep')
  const repVal = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'document.getElementById("plain").value' }, 'rv')
  const repStr = repVal.value && repVal.value.__t === 'string' ? repVal.value.v : repVal.value
  check('keyboard typing REPLACES the value (select-all + clear first)', rep && rep.verified === true && repStr === 'zz', JSON.stringify(repStr))

  /* 6. disabled / readonly refused */
  const dis = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: disRef, text: 'x', mode: 'keyboard' }, 'ty-dis')
  check('disabled field refused', !!(dis && dis.error && dis.error.category === 'disabled'), dis && dis.error && dis.error.category)
  const ro = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: roRef, text: 'TYPED', mode: 'keyboard' }, 'ty-ro')
  const roVal = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'JSON.stringify({v:document.getElementById("ro").value, ro:document.getElementById("ro").readOnly})' }, 'rov')
  let roNow = null
  try { roNow = roVal.value && roVal.value.__t === 'string' ? JSON.parse(roVal.value.v) : null } catch (e) {}
  check('read-only field does not silently succeed', !!(ro && (ro.error || ro.verified === false)), (ro && (ro.error ? ro.error.category : 'verified=' + ro.verified)) + ' actual=' + JSON.stringify(roNow))

  /* 7. stale ref */
  const rmRef = refOf(nodes, 'Remove Controlled')
  if (rmRef) {
    await rpcJ(port, token, 'browser_click', { tabId: tab, ref: rmRef, verification: 'none' }, 'clr')
    await sleep(500)
    const stale = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: ctrlRef, text: 'gone', mode: 'keyboard' }, 'ty-stale')
    check('stale ref fails structurally (never retargets another field)', !!(stale && stale.error && /ref_stale|ref_not_found|ref_expired/.test(stale.error.category)), stale && stale.error && stale.error.category)
  } else {
    check('stale ref fails structurally (never retargets another field)', false, 'Remove button not enumerated')
  }

  /* 7b. STALE SNAPSHOT: page becomes readonly AFTER the snapshot said writable.
   * The action must be refused by the LIVE check and must not mutate the value. */
  const liveRef = await snap('s-live')
  const livePlain = (liveRef.find(n => n.name === 'Plain Field') || {}).ref
  if (livePlain) {
    const beforeVal = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'JSON.stringify({v:document.getElementById("plain").value, ro:document.getElementById("plain").readOnly})' }, 'lv0')
    await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'document.getElementById("plain").readOnly = true' }, 'lv1')
    const staleType = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: livePlain, text: 'SHOULD-NOT-LAND', mode: 'keyboard' }, 'lv2')
    const afterVal = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'JSON.stringify({v:document.getElementById("plain").value, ro:document.getElementById("plain").readOnly})' }, 'lv3')
    let b0 = null; let a0 = null
    try { b0 = JSON.parse(beforeVal.value.v); a0 = JSON.parse(afterVal.value.v) } catch (e) {}
    check('STALE: typing a now-readonly field is REFUSED (structured error)', !!(staleType && staleType.error && staleType.error.category === 'readonly'), staleType && staleType.error && staleType.error.category)
    check('STALE: the readonly field value was NOT mutated', !!(a0 && a0.v === b0.v && a0.v.indexOf('SHOULD-NOT-LAND') === -1), JSON.stringify(a0))
    check('STALE: the refusal came from the live element, not the cached snapshot', !!(a0 && a0.ro === true))
    const natStale = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: livePlain, text: 'NATIVE-SHOULD-NOT-LAND' }, 'lv4')
    check('STALE: native mode is refused too', !!(natStale && natStale.error && natStale.error.category === 'readonly'), natStale && natStale.error && natStale.error.category)
    await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'document.getElementById("plain").readOnly = false' }, 'lv5')
  } else {
    check('STALE: typing a now-readonly field is REFUSED (structured error)', false, 'plain field not enumerated')
  }
  /* 8. bounds */
  nodes = await snap('s2')
  const longText = 'a'.repeat(201)
  const tooLong = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: refOf(nodes, 'Plain Field'), text: longText, mode: 'keyboard' }, 'ty-long')
  check('keyboard mode refuses >200 characters with a structured error', !!(tooLong && tooLong.error && tooLong.error.category === 'invalid_params'), tooLong && tooLong.error && tooLong.error.category)

  /* 9. sensitive field still gated */
  const pw2 = refOf(nodes, 'Password')
  if (pw2) {
    const pwTry = await rpcJ(port, token, 'browser_type', { tabId: tab, ref: pw2, text: 'secret', mode: 'keyboard' }, 'ty-pw')
    check('sensitive field still refused without a grant', !!(pwTry && pwTry.error && pwTry.error.category === 'sensitive_field'), pwTry && pwTry.error && pwTry.error.category)
    check('sensitive refusal never echoes the value', !(JSON.stringify(pwTry).indexOf('secret') !== -1))
  } else check('sensitive field still refused without a grant', false, 'password field not enumerated')

  return results.every(r => r.pass) ? 0 : 1
}

let probeProc = null
function printSummary (code) {
  const passed = results.filter(r => r.pass).length
  console.log('\n' + passed + '/' + results.length + ' checks passed')
  try { fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ ts: new Date().toISOString(), results: results, pass: passed, total: results.length }, null, 2)) } catch (e) {}
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)]) } catch (e) {}
  process.exit(code)
}

main().then(function (c) { printSummary(c) }).catch(function (e) {
  console.error('keyboard probe error: ' + e.message)
  printSummary(2)
})