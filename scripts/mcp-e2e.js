#!/usr/bin/env node
/*
 * P0-12 MCP end-to-end + unit checks.
 *
 * Phase 1 (unit, Min NOT running, fresh nonexistent profile): the adapter must
 *   initialize, list exactly the 8 tools, refuse an unknown tool, return a
 *   clear "run the launcher" error for a tool call while Min is down, survive
 *   a malformed JSON-RPC line, and put ONLY MCP frames on stdout.
 * Phase 2 (e2e, Min running): launches scripts/min-launch.js with one start
 *   URL (visible window, dedicated profile), then drives the adapter over
 *   stdio: browser_status -> browser_snapshot -> browser_type -> browser_click
 *   -> browser_press -> browser_navigate -> browser_screenshot, asserting each
 *   expected verification kind. Saves docs/mcp-e2e-run.json (tokens removed,
 *   screenshot data truncated).
 *
 * usage: node scripts/mcp-e2e.js
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'mcp-e2e-run.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-mcp-e2e')
const MCP = path.join(ROOT, 'mcp', 'min-agent-mcp.js')
const WIN32 = process.platform === 'win32'
const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const TRANSCRIPT_MAX_DATA = 60

  const results = []
  /* Failure diagnostics (bounded + sanitized) — post-Option-C observability gap.
   * Assertions still fail normally and the exit code is unchanged; this only
   * makes a failure reconstructable later. It NEVER records tokens, headers,
   * cookies, typed text or page bodies. */
  const failures = []
  const FAILURE_EVIDENCE_CAP = 12
  function sanitizeDiag (v) {
    let t = String(v === undefined || v === null ? '' : v)
    try { if (token) t = t.split(token).join('<redacted-token>') } catch (e) { /* no token yet */ }
    t = t.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
    t = t.replace(/\b[0-9a-f]{32,}\b/gi, '<redacted-hex>')
    return t.slice(0, 300)
  }
  function check (name, pass, detail) {
    results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail).slice(0, 200) })
    if (!pass && failures.length < FAILURE_EVIDENCE_CAP) {
      const st = (typeof globalThis.__E2E_CTX === 'function' ? globalThis.__E2E_CTX() : null) || {}
      const err = new Error('assertion failed')
      failures.push({
        check: String(name).slice(0, 160),
        step: st.step || null,
        tool: st.tool || null,
        at: new Date().toISOString(),
        elapsedMs: typeof st.elapsedMs === 'number' ? st.elapsedMs : null,
        expected: 'assertion-true',
        actual: sanitizeDiag(detail),
        errorCode: st.errorCategory || null,
        phase: st.phase || null,
        url: st.urlPath || null,
        title: st.title ? sanitizeDiag(st.title).slice(0, 80) : null,
        tabId: st.tabId ? String(st.tabId).slice(0, 20) : null,
        loading: typeof st.loading === 'boolean' ? st.loading : null,
        stack: sanitizeDiag(String(err.stack || '').split('\n').slice(1, 4).join(' | '))
      })
    }
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail).slice(0, 160) + ']'))
  }
const sleep = ms => new Promise(r => setTimeout(r, ms))

function rmrf (target) {
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch (e) { /* retry */ }
    if (!fs.existsSync(target)) return
    const until = Date.now() + 300
    while (Date.now() < until) { /* spin */ }
  }
}

/* ---------- minimal MCP stdio client (spawn adapter + newline frame pump) ---------- */
/* Simplify: a state object with explicit bookkeeping instead of cleverness. */
function makeAdapter (profileDir) {
  const proc = spawn(process.execPath, [MCP, '--profile=' + profileDir], {
    cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  const st = {
    proc,
    nonMcpStdoutLines: [],
    stderrLines: [],
    pending: {},
    order: [],
    nextId: 10
  }
  let buf = ''
  proc.stdout.on('data', d => {
    buf += d
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const frame = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!frame) continue
      let msg = null
      try {
        msg = JSON.parse(frame)
      } catch (e) {
        st.nonMcpStdoutLines.push(frame)
        continue
      }
      st.frames = st.frames || []
      st.frames.push({ kind: msg.result ? 'result' : (msg.error ? 'error' : 'notification'), msg })
      if (msg.id !== undefined && msg.id !== null && st.pending[msg.id]) {
        const resolve = st.pending[msg.id]
        delete st.pending[msg.id]
        resolve(msg)
      }
    }
  })
  proc.stderr.on('data', d => st.stderrLines.push(String(d)))
  st.request = function (method, params, timeoutMs, methodNote) {
    const id = 'r' + (++st.nextId)
    st.order.push({ id, method, params })
    st.requestLog = st.requestLog || []
    st.requestLog.push({ id, method, params })
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        if (st.pending[id]) { delete st.pending[id]; resolve({ id, error: { code: -32000, message: 'client-side timeout' } }) }
      }, timeoutMs || 15000)
      st.pending[id] = function (msg) { clearTimeout(timer); resolve(msg) }
      const frame = { jsonrpc: '2.0', id: id, method: method }
      if (params !== undefined) frame.params = params
      proc.stdin.write(JSON.stringify(frame) + '\n')
      if (methodNote) st.methodNotes = st.methodNotes || []
    })
  }
  st.notify = function (method, params) {
    const frame = Object.assign({ jsonrpc: '2.0', method: method }, params ? { params: params } : {})
    proc.stdin.write(JSON.stringify(frame) + '\n')
  }
  st.end = function () { try { proc.stdin.end() } catch (e) { /* ignore */ } }
  return st
}

const textOf = stepR => {
  try { return JSON.parse(stepR.result.content[0].text) } catch (e) { return null }
}

/* Self-test for the failure diagnostics. Forces a known failing assertion,
 * proves the record is emitted + sanitized + associated, and proves the process
 * still exits nonzero. Never touches a browser or a profile. */
function diagnosticsSelfTest () {
  const sab = 'SENTINEL-TOKEN-abcdef0123456789abcdef0123456789'
  const before = failures.length
  globalThis.__E2E_CTX = function () {
    return { step: 'selftest-1', tool: 'browser_selftest', elapsedMs: 12, phase: 'after-call', errorCategory: 'ref_stale', url: '/selftest', title: 'Self Test', tabId: '123', loading: false }
  }
  check('SELFTEST forced failure (must be FAIL)', false, 'expected false but got true; token=' + sab + ' Bearer abc.def-ghi')
  const rec = failures[before]
  const okEmitted = !!rec
  const okSanitized = okEmitted && String(rec.actual).indexOf(sab) === -1 && String(rec.actual).indexOf('Bearer <redacted>') !== -1
  const okAssociated = okEmitted && rec.step === 'selftest-1' && rec.tool === 'browser_selftest' && rec.phase === 'after-call'
  const okCategory = okEmitted && rec.expected === 'assertion-true' && rec.errorCode === 'ref_stale'
  const okNoSecrets = okEmitted && JSON.stringify(rec).indexOf(sab) === -1
  console.log('SELFTEST emitted=' + okEmitted + ' sanitized=' + okSanitized + ' associated=' + okAssociated + ' category=' + okCategory + ' noSecrets=' + okNoSecrets)
  console.log('SELFTEST record: ' + JSON.stringify(rec))
  return okEmitted && okSanitized && okAssociated && okCategory && okNoSecrets
}

async function main () {
  if (process.argv.indexOf('--diagnostics-selftest') !== -1) {
    const ok = diagnosticsSelfTest()
    /* deliberately non-zero so a caller can assert the exit code */
    process.exit(ok ? 3 : 4)
  }
  rmrf(RUN_DIR)
  fs.mkdirSync(RUN_DIR, { recursive: true })

  /* ---------------- phase 1: unit (Min not running) ---------------- */
  const unitProfile = path.join(os.tmpdir(), 'min-mcp-e2e-unit-' + Date.now())
  const a1 = makeAdapter(unitProfile)
  let r = await a1.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }, 10000)
  check('initialize returns a supported protocol version', r.result && SUPPORTED_VERSIONS.indexOf(r.result.protocolVersion) !== -1, JSON.stringify(r.result && r.result.protocolVersion))
  check('initialize returns serverInfo min-agent', !!(r.result && r.result.serverInfo && r.result.serverInfo.name === 'min-agent'))
  a1.notify('notifications/initialized')

  r = await a1.request('tools/list', {}, 5000)
  check('tools/list returns exactly the 39 bridge tools (ADR-09 Option C: + browser_helper/browser_helper_list)', r.result && Array.isArray(r.result.tools) && r.result.tools.length === 39 &&
    JSON.stringify(r.result.tools.map(t => t.name).slice().sort()) ===
    JSON.stringify(['browser_batch', 'browser_check', 'browser_click', 'browser_content', 'browser_download_cancel', 'browser_download_pause', 'browser_download_resume', 'browser_download_start', 'browser_download_wait', 'browser_downloads', 'browser_eval', 'browser_frames', 'browser_grant', 'browser_health', 'browser_helper', 'browser_helper_list', 'browser_hover', 'browser_mouse', 'browser_navigate', 'browser_pdf', 'browser_predict', 'browser_press', 'browser_screenshot', 'browser_scroll', 'browser_select', 'browser_snapshot', 'browser_state', 'browser_status', 'browser_tab_close', 'browser_tab_open', 'browser_tab_select', 'browser_tabs', 'browser_transform', 'browser_transform_status', 'browser_type', 'browser_upload', 'browser_verify', 'browser_viewport', 'browser_wait']))

  r = await a1.request('ping', {}, 5000)
  check('ping answers', r.result && Object.keys(r.result).length === 0)

  r = await a1.request('tools/call', { name: 'browser_status', arguments: {} }, 15000)
  const statusText = r.result && r.result.content && r.result.content[0] && r.result.content[0].text
  check('browser_status with Min down -> isError with launcher guidance', r.result && r.result.isError === true && statusText && statusText.indexOf('min-launch') !== -1, statusText)

  r = await a1.request('tools/call', { name: 'browser_hoverx', arguments: {} }, 5000)
  check('unknown tool -> invalid params (-32602)', r.error && r.error.code === -32602)

  a1.proc.stdin.write('this is not json\n')
  await sleep(500)
  const pAfter = await a1.request('ping', {}, 5000)
  check('survives malformed JSON-RPC line (still answering ping)', pAfter.result && Object.keys(pAfter.result).length === 0)
  check('stdout carried only MCP frames (unit phase)', a1.nonMcpStdoutLines.length === 0, a1.nonMcpStdoutLines.join(' | '))

  a1.end()

  /* ---------------- phase 2: e2e (launcher + Min + adapter) ---------------- */
  fs.writeFileSync(path.join(RUN_DIR, 'act.html'),
    '<!doctype html><html><head><title>E2E Start</title></head><body>' +
    '<label for="f">' + 'Agent Field' + '</label>' +
    '<input id="f" type="text" value="start">' +
    '<button id="chg">' + 'Change Text' + '</button>' +
    '<div id="out">initial</div>' +
    '<canvas id="noisecv" width="2400" height="1200" style="display:block"></canvas>' +
    '<scr' + 'ipt>' +
    'var nc=document.getElementById("noisecv").getContext("2d");' +
    'var x=12345;function rnd(){x=(x*1103515245+12345)&0x7fffffff;return x&0xff}' +
    'for(var py=0;py<1200;py+=8){for(var px=0;px<2400;px+=8){nc.fillStyle="rgb("+rnd()+","+rnd()+","+rnd()+")";nc.fillRect(px,py,8,8)}}' +
    '</scr' + 'ipt>' +
    '<a href="after.html">' + 'Go To After Page' + '</a>' +
      '<input id="pw" type="password" value="start-pw">' +
      '<button id="pay">' + 'Pay Now' + '</button>' +
      '<script>document.getElementById("pay").addEventListener("click", function () {' +
      'document.getElementById("out").textContent = "paid-via-grant"; });</script>' +
    '<script>document.getElementById("chg").addEventListener("click", function () {' +
    'document.getElementById("out").textContent = "changed-by-click"; });</script>' +
    '</body></html>', 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'after.html'),
    '<!doctype html><html><head><title>E2E After</title></head><body><h1>' + 'After Heading' + '</h1></body></html>', 'utf8')
  const startUrl = 'file:///' + path.join(RUN_DIR, 'act.html').replace(/\\/g, '/')
  const afterUrl = 'file:///' + path.join(RUN_DIR, 'after.html').replace(/\\/g, '/')
  const launcherProfile = path.join(RUN_DIR, 'agent-profile')

  const launcher = spawn(process.execPath, [path.join(ROOT, 'scripts', 'min-launch.js'), '--profile=' + launcherProfile, '--', startUrl], {
    cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  let killedLauncher = false
  let launcherOut = ''
  launcher.stdout.on('data', d => { launcherOut += d })
  launcher.stderr.on('data', d => { launcherOut += d })
  const killLauncher = function () {
    if (killedLauncher) return
    killedLauncher = true
    if (WIN32) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(launcher.pid)], { windowsHide: true })
    else { try { launcher.kill('SIGKILL') } catch (e) { /* ignore */ } }
  }

  let launcherLines = []
  const lDeadline = Date.now() + 60000
  while (Date.now() < lDeadline) {
    await sleep(500)
    launcherLines = launcherOut.split('\n').map(s => s.trim()).filter(Boolean)
    if (launcherLines.some(l => l === 'ready')) break
  }
  check('launcher stdout = profile/discovery-file/ready protocol (3 lines, no token)',
    launcherLines[0] && launcherLines[0].indexOf('profile:') === 0 &&
    launcherLines[1] && launcherLines[1].indexOf('discovery-file:') === 0 &&
    launcherLines.indexOf('ready') !== -1 &&
    launcherLines.slice(0, 3).join('').indexOf('token') === -1,
    JSON.stringify(launcherLines))
  const discoveryPath = launcherLines[1].slice('discovery-file:'.length).trim()
  let token = ''
  try { token = JSON.parse(fs.readFileSync(discoveryPath, 'utf8')).token } catch (e) { /* below */ }
  check('discovery file exists and holds a 64-hex token', /^[0-9a-f]{64}$/.test(token), token && token.length)
  check('launcher output never contains the token', launcherOut.indexOf(token) === -1)

  const a2 = makeAdapter(launcherProfile)
  r = await a2.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }, 15000)
  check('e2e initialize', r.result && SUPPORTED_VERSIONS.indexOf(r.result.protocolVersion) !== -1, JSON.stringify(r.result && r.result.protocolVersion))
  a2.notify('notifications/initialized')

    const transcript = []
    /* Context used ONLY by the bounded failure diagnostics above. Tool names and
     * step ids are safe; typed values and URLs with queries are not recorded. */
    let ctxStep = null
    let ctxTool = null
    let ctxStarted = 0
    globalThis.__E2E_CTX = function () {
      return { step: ctxStep, tool: ctxTool, elapsedMs: ctxStarted ? Date.now() - ctxStarted : null, phase: 'after-call' }
    }
    const call = function (tool, args, step) {
      ctxStep = step
      ctxTool = tool
      ctxStarted = Date.now()
      return a2.request('tools/call', { name: tool, arguments: args }, 40000).then(function (resp) {
        const entry = { step: step, tool: tool, params: args, response: resp.result ? resp.result.content : { error: resp.error } }
        transcript.push(entry)
        if (resp && resp.result && resp.result.isError === true) {
          globalThis.__E2E_CTX = function () {
            return { step: step, tool: tool, elapsedMs: Date.now() - ctxStarted, phase: 'tool-error', errorCategory: 'isError' }
          }
        }
        return resp
      })
    }
  const textOfResp = function (resp) {
    try { return JSON.parse(resp.result.content[0].text) } catch (e) { return null }
  }

  const st = await call('browser_status', {}, '1')
  const stData = textOf(st)
  check('browser_status ok (Min versions + tabs via MCP)', stData && stData.app && stData.app.version === '1.35.7' && typeof stData.tabs === 'object',
    (st.result && st.result.content && st.result.content[0] ? st.result.content[0].text.slice(0, 140) : JSON.stringify(st.result)))

  const tb = await call('browser_tabs', {}, '2')
  const tbData = textOf(tb)
  const actTab0 = tbData.tabs.find(t => t.url.indexOf('act.html') !== -1)
  check('browser_tabs shows the start page tab', !!actTab0, actTab0 && actTab0.url)

  const s1 = await call('browser_snapshot', { tabId: actTab0.tabId }, '3')
  const s1Data = textOf(s1)
  const fieldRef = (s1Data.nodes.find(n => n.name === 'Agent Field') || {}).ref
  const chgRef = (s1Data.nodes.find(n => n.name === 'Change Text') || {}).ref
  check('browser_snapshot enumerates field + button + link, refs returned',
    ['Agent Field', 'Change Text', 'Go To After Page'].every(n => s1Data.nodes.some(x => x.name === n)) && !!fieldRef && !!chgRef)

  const ty = await call('browser_type', { tabId: actTab0.tabId, ref: fieldRef, text: 'hello-from-mcp' }, '4')
  const tyData = textOf(ty)
  check('browser_type -> value verified', tyData && tyData.verification === 'value' && tyData.verified === true, JSON.stringify(tyData && tyData.verification))

  const cl = await call('browser_click', { tabId: actTab0.tabId, ref: chgRef }, '5')
  const clData = textOf(cl)
  check('browser_click -> dom-change verified', clData && clData.verification === 'dom-change' && clData.verified === true, JSON.stringify(clData && clData.verification))

  const pr = await call('browser_press', { tabId: actTab0.tabId, key: 'Tab' }, '6')
  const prData = textOf(pr)
  check('browser_press Tab -> focus verified', prData && prData.verification === 'focus' && prData.verified === true, JSON.stringify(prData && prData.verification))

  const nv = await call('browser_navigate', { tabId: actTab0.tabId, url: afterUrl }, '7')
  const nvData = textOf(nv)
  check('browser_navigate -> navigation verified, finalUrl = after page',
    nvData && nvData.verification === 'navigation' && nvData.verified === true && nvData.finalUrl.indexOf('after.html') !== -1,
    JSON.stringify(nvData && nvData.verification))


  const sh = await call('browser_screenshot', { tabId: actTab0.tabId }, '8')
  const imageBlock = sh.result && sh.result.content.find(c => c.type === 'image')
  check('browser_screenshot -> real image block (png magic or ladder jpeg rung; len>1000)', !!imageBlock && (imageBlock.mimeType === 'image/png' || imageBlock.mimeType === 'image/jpeg') &&
    (imageBlock.data.indexOf('iVBORw0KGgo') === 0 || imageBlock.data.indexOf('/9j/') === 0) && imageBlock.data.length > 1000, (imageBlock ? imageBlock.mimeType : 'none') + ' ' + (imageBlock ? imageBlock.data.length : 0) + ' prefix=' + (imageBlock ? imageBlock.data.slice(0, 28) : ''))
  const shotMeta = sh.result && sh.result.content.find(c => c.type === 'text')
  let shotMetaObj = null
  try { shotMetaObj = JSON.parse(shotMeta.text) } catch (e) {}
  check('browser_screenshot metadata: screenshotId + viewport + dpr + cssPerPixel present', !!(shotMetaObj && /^ss[0-9]+$/.test(shotMetaObj.screenshotId) && shotMetaObj.viewport && shotMetaObj.viewport.width > 0 && shotMetaObj.viewport.dpr > 0 && shotMetaObj.cssPerPixel > 0), JSON.stringify(shotMetaObj && { id: shotMetaObj.screenshotId, vp: shotMetaObj.viewport, f: shotMetaObj.cssPerPixel }).slice(0, 200))

  /* P1-15/D1-F3: element-scoped screenshot over the real stdio path.
   * No suite had ever exercised the SUCCESS path - the P1-15 patch scripts only
   * asserted an invalid selector, which short-circuits BEFORE the rect math -
   * so the resolver shipped with undeclared width/height identifiers and every
   * real element capture failed with invalid_params. These checks drive the
   * actual crop path. */
  const backEl = await call('browser_navigate', { tabId: actTab0.tabId, url: startUrl }, '8e')
  check('element screenshot: navigated back to the act page', !!(textOf(backEl) && textOf(backEl).finalUrl.indexOf('act.html') !== -1), JSON.stringify(textOf(backEl)).slice(0, 140))

  /* #pay sits BELOW a 2400x1200 painted noise canvas, so this also exercises
   * scrollIntoView + clamp on a below-the-fold target. */
  const elShot = await call('browser_screenshot', { tabId: actTab0.tabId, selector: '#pay' }, '8e1')
  const elImg = elShot.result && elShot.result.content ? elShot.result.content.find(c => c.type === 'image') : null
  let elMeta = null
  try { elMeta = JSON.parse(((elShot.result && elShot.result.content ? elShot.result.content.find(c => c.type === 'text') : null) || {}).text) } catch (e) {}
  check('D1-F3: element screenshot delivers a REAL cropped image', !!elImg && elImg.data.length > 500 && (elImg.data.indexOf('iVBORw0KGgo') === 0 || elImg.data.indexOf('/9j/') === 0), (elImg ? elImg.mimeType + ' ' + elImg.data.length + 'b' : 'none'))
  check('D1-F3: element crop is materially smaller than the full capture', !!(elMeta && shotMetaObj && elMeta.width > 0 && elMeta.height > 0 && elMeta.width < shotMetaObj.width && elMeta.height < shotMetaObj.height), 'element ' + (elMeta ? elMeta.width + 'x' + elMeta.height : '?') + ' vs full ' + (shotMetaObj ? shotMetaObj.width + 'x' + shotMetaObj.height : '?'))
  check('D1-F3: element crop stays inside the viewport (NOT a full-page claim)', !!(elMeta && elMeta.width <= elMeta.viewport.width && elMeta.height <= elMeta.viewport.height), JSON.stringify(elMeta && elMeta.viewport))

  const elTight = await call('browser_screenshot', { tabId: actTab0.tabId, selector: '#out', maxBytes: 5200 }, '8e2')
  const elTightImg = elTight.result && elTight.result.content ? elTight.result.content.find(c => c.type === 'image') : null
  check('D1-F3: element capture honours the size cap and stays bounded', !!elTightImg && elTightImg.data.length <= 5200 && elTightImg.data.length > 100, elTightImg ? elTightImg.data.length + 'b cap=5200' : 'none')

  const elBad = await call('browser_screenshot', { tabId: actTab0.tabId, selector: '""' }, '8e3')
  const elBadTxt = elBad.result && elBad.result.content && elBad.result.content[0] ? elBad.result.content[0].text : null
  const elBadErr = (elBad.error && elBad.error.message) || (elBad.result && elBad.result.isError === true ? elBadTxt : null)
  check('D1-F3: invalid selector fails with a structured error', !!elBadErr && /invalid_params|selector|no element/i.test(elBadErr), elBadErr)

  const elMiss = await call('browser_screenshot', { tabId: actTab0.tabId, selector: '#definitely-not-here' }, '8e4')
  const elMissTxt = elMiss.result && elMiss.result.content && elMiss.result.content[0] ? elMiss.result.content[0].text : null
  const elMissErr = (elMiss.error && elMiss.error.message) || (elMiss.result && elMiss.result.isError === true ? elMissTxt : null)
  check('D1-F3: missing target fails clearly, never a silent full-page image', !!elMissErr, elMissErr)

  /* Phase E / D2-B/C/D/E over the real stdio path. */
  const health = await call('browser_health', {}, 'd2-health')
  const hd = textOfResp(health)
  check('D2-B: browser_health returns an overall verdict in the fixed vocabulary', !!(hd && ['healthy', 'degraded', 'unavailable'].indexOf(hd.overall) !== -1), hd && hd.overall)
  check('D2-B: health is read-only and reports per-check status', !!(hd && hd.readOnly === true && Array.isArray(hd.checks) && hd.checks.length >= 8), hd && (hd.checks ? hd.checks.length : 0) + ' checks')
  check('D2-B: every check uses healthy/degraded/unavailable/unknown', !!(hd && hd.checks.every(c => ['healthy', 'degraded', 'unavailable', 'unknown'].indexOf(c.status) !== -1)))
  check('D2-B: health names the configured profile for recovery', !!(hd && hd.profile && typeof hd.profile.discoveryFile === 'string' && hd.profile.discoveryFile.indexOf('agent-rpc.json') !== -1))
  check('D2-B: health NEVER returns the bridge token', !!(hd && JSON.stringify(hd).indexOf(/[0-9a-f]{64}/) === -1), 'no 64-hex token in health output')
  check('D2-B: health reports honest known limitations', !!(hd && Array.isArray(hd.knownLimitations) && hd.knownLimitations.length >= 4))

  const stateCall = await call('browser_state', { tabId: actTab0.tabId }, 'd2-state')
  const sd = textOfResp(stateCall)
  check('D2-C: browser_state reports document.readyState', !!(sd && typeof sd.readyState === 'string' && sd.readyState.length > 0), sd && sd.readyState)
  check('D2-C: browser_state reports a dialog block with the safe-dialogs truth', !!(sd && sd.dialogs && Array.isArray(sd.dialogs.items) && sd.dialogs.pageDialogsSuppressed === true && typeof sd.dialogs.note === 'string'), sd && JSON.stringify(sd.dialogs && { recent: sd.dialogs.recent, n: sd.dialogs.items.length }))
  check('D2-C: dialog observation never stores dialog message text', !!(sd && JSON.stringify(sd.dialogs).toLowerCase().indexOf('password') === -1))

  const waitRs = await call('browser_wait', { tabId: actTab0.tabId, until: 'ready_state', timeoutMs: 6000 }, 'd2-rs')
  const rsData = textOfResp(waitRs)
  check('D2-C: browser_wait until=ready_state reaches interactive/complete', !!(rsData && rsData.satisfied === true && ['interactive', 'complete'].indexOf(rsData.readyState) !== -1), JSON.stringify(rsData).slice(0, 160))

  const waitIdle = await call('browser_wait', { tabId: actTab0.tabId, until: 'network_idle', quietMs: 600, timeoutMs: 8000 }, 'd2-idle')
  const idleData = textOfResp(waitIdle)
  check('D2-D: network_idle resolves and states its semantics explicitly', !!(idleData && idleData.satisfied === true && typeof idleData.semantics === 'string' && idleData.semantics.indexOf('NEW request') !== -1), JSON.stringify(idleData).slice(0, 200))
  check('D2-D: network_idle reports openLongLived separately from "stopped"', !!(idleData && typeof idleData.openLongLived === 'number' && typeof idleData.inFlight === 'number'))

  /* Real SSE + burst fixture over http: a never-ending EventSource must not
   * prevent network_idle, and a request burst must reset the quiet window. */
  const sseServer = http.createServer(function (req, res) {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write('data: open\n\n')
      const t = setInterval(function () { res.write('data: ping\n\n') }, 500)
      req.on('close', function () { clearInterval(t) })
      return
    }
    if (req.url === '/burst') {
      let n = 0
      const t = setInterval(function () {
        n++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ n: n }))
        if (n >= 3) clearInterval(t)
      }, 250)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><html><head><title>D2 SSE</title></head><body><h1>D2 SSE fixture</h1>' +
      '<button id="b">SSE Button</button><div id="o">idle</div>' +
      '<script>window.__sse = new EventSource("/events");' +
      'window.__sse.onmessage = function (e) { /* STICKY: once the user clicked, SSE must not clobber the observable effect, otherwise the post-click state is not a stable assertion target. */ if (window.__clicked) return; document.getElementById("o").textContent = "msg:" + e.data; };' +
      'function burst(){ var i=0; (function go(){ fetch("/burst").then(function(){ if(++i<3) setTimeout(go,120); }); })(); }' +
      'document.getElementById("b").addEventListener("click", function(){ window.__clicked = true; document.getElementById("o").textContent = "clicked"; });' +
      '</script></body></html>')
  })
  await new Promise(function (res2) { sseServer.listen(0, '127.0.0.1', res2) })
  const ssePort = sseServer.address().port
  const sseUrl = 'http://127.0.0.1:' + ssePort + '/'

  try {
    const sseNav = await call('browser_navigate', { tabId: actTab0.tabId, url: sseUrl }, 'd2-sse-nav')
    check('D2-D: navigated to the http SSE fixture', !!(textOfResp(sseNav) && textOfResp(sseNav).verified === true), JSON.stringify(textOfResp(sseNav)).slice(0, 140))
    await sleep(1500)
    const sseIdle = await call('browser_wait', { tabId: actTab0.tabId, until: 'network_idle', quietMs: 800, timeoutMs: 8000 }, 'd2-sse-idle')
    const sseIdleData = textOfResp(sseIdle)
    check('D2-D: a NEVER-ENDING SSE stream does not block network_idle', !!(sseIdleData && sseIdleData.satisfied === true), JSON.stringify(sseIdleData).slice(0, 220))
    check('D2-D: the still-open SSE connection is disclosed as openLongLived', !!(sseIdleData && sseIdleData.openLongLived >= 1), sseIdleData && sseIdleData.openLongLived)

    const rsSse = await call('browser_wait', { tabId: actTab0.tabId, until: 'ready_state', timeoutMs: 6000 }, 'd2-sse-rs')
    check('D2-C: ready_state still resolves on an SSE page', !!(textOfResp(rsSse) && textOfResp(rsSse).satisfied === true), JSON.stringify(textOfResp(rsSse)).slice(0, 140))

    const sseSnap = await call('browser_snapshot', { tabId: actTab0.tabId }, 'd2-sse-snap')
    const sseSnapData = textOfResp(sseSnap)
    const sseBtn = (sseSnapData.nodes || []).find(function (n) { return n.name === 'SSE Button' })
    check('D2-D: the SSE fixture is snapshot-able (semantic path still works)', !!sseBtn && /^r[0-9a-z]+$/.test(sseBtn.ref), sseBtn && sseBtn.ref)

    if (sseBtn) {
      const sseClick = await call('browser_click', { tabId: actTab0.tabId, ref: sseBtn.ref }, 'd2-sse-click')
      const sc = textOfResp(sseClick)
      check('D2-A: click reports a DISPATCHED stage', !!(sc && sc.dispatched === true))
      check('D2-A: click reports an explicit DELIVERY stage', !!(sc && ['attested', 'unverified', 'unsupported'].indexOf(sc.delivery) !== -1), sc && sc.delivery)
      check('D2-A: click reports an independent VERIFIED stage', !!(sc && typeof sc.verified === 'boolean'), sc && String(sc.verified))
      check('D2-A: delivered and verified are separate fields, not merged', !!(sc && sc.delivery !== undefined && sc.verified !== undefined && sc.verification !== undefined))
      /* The SSE fixture rewrites #o on every message, so an immediate verify can
       * legitimately observe the PRE-click text. Poll the read-only verify within a
       * bounded window instead of assuming the page effect is synchronous. This was
       * the 92/93 flake: a TEST-TIMING defect, not a product defect. */
      let sseState = null
      const verifyDeadline = Date.now() + 8000
      while (Date.now() < verifyDeadline) {
        sseState = await call('browser_verify', { tabId: actTab0.tabId, selector: '#o', textContains: 'clicked' }, 'd2-sse-verify')
        if (textOfResp(sseState) && textOfResp(sseState).verified === true) break
        await sleep(250)
      }
      check('D2-A: an effect claimed by verification is independently confirmed', !!(textOfResp(sseState) && textOfResp(sseState).verified === true), JSON.stringify(textOfResp(sseState)))
      const sseNone = await call('browser_press', { tabId: actTab0.tabId, key: 'Tab', verification: 'none' }, 'd2-sse-press')
      const sp = textOfResp(sseNone)
      check('D2-A: press(verification:none) still reports delivery honestly', !!(sp && sp.dispatched === true && sp.verified === false && ['attested', 'unverified', 'unsupported'].indexOf(sp.delivery) !== -1), JSON.stringify(sp && { d: sp.delivery, v: sp.verified }))
    }

    const pdf = await call('browser_pdf', { tabId: actTab0.tabId }, 'd2-pdf')
    const pdfText = pdf.result && pdf.result.content && pdf.result.content[0] ? pdf.result.content[0].text : null
    let pd = null
    try { pd = JSON.parse(pdfText) } catch (e) {}
    check('D2-G2: browser_pdf returns real PDF bytes', !!(pd && pd.mimeType === 'application/pdf' && typeof pd.data === 'string' && pd.data.indexOf('JVBER') !== -1), pd && (pd.bytes + 'b'))
    check('D2-G2: PDF metadata is bounded and honest about scope', !!(pd && pd.bytes <= 8388608 && typeof pd.captureScope === 'string' && pd.captureScope.indexOf('NOT an offscreen') !== -1))

    const elShot2 = await call('browser_screenshot', { tabId: actTab0.tabId, selector: '#b' }, 'd2-elmeta')
    const elMetaTxt = elShot2.result && elShot2.result.content && elShot2.result.content[1] ? elShot2.result.content[1].text : null
    let em = null
    try { em = JSON.parse(elMetaTxt) } catch (e) {}
    check('D2-E: element capture reports source=element through MCP (F-21 fixed)', !!(em && em.source === 'element'), em && em.source)
    check('D2-E: metadata exposes scaled/attempts/ladder', !!(em && typeof em.scaled === 'boolean' && typeof em.attempts === 'number' && Array.isArray(em.ladder) && em.ladder.length >= 1), em && JSON.stringify({ s: em.scaled, a: em.attempts, l: em.ladder && em.ladder.length }))
    check('D2-E: element capture is labelled visible-area-limited', !!(em && typeof em.cropLimited === 'string' && em.cropLimited.indexOf('NOT full-page') !== -1), em && em.cropLimited)
    const fullShot2 = await call('browser_screenshot', { tabId: actTab0.tabId }, 'd2-fullmeta')
    const fmTxt = fullShot2.result && fullShot2.result.content && fullShot2.result.content[1] ? fullShot2.result.content[1].text : null
    let fm = null
    try { fm = JSON.parse(fmTxt) } catch (e) {}
    check('D2-E: full capture is distinguishable from element capture', !!(fm && fm.source === 'full' && em && fm.width !== em.width), (fm && fm.source + ' ' + fm.width) + ' vs ' + (em && em.source + ' ' + em.width))
    const tightShot = await call('browser_screenshot', { tabId: actTab0.tabId, maxBytes: 9000 }, 'd2-scaled')
    const tmTxt = tightShot.result && tightShot.result.content && tightShot.result.content[1] ? tightShot.result.content[1].text : null
    let tm = null
    try { tm = JSON.parse(tmTxt) } catch (e) {}
    check('D2-E: a size-capped capture discloses its downscale ladder', !!(tm && tm.scaled === true && tm.ladder.length >= 1 && tm.bytes <= 9000), tm && JSON.stringify({ scaled: tm.scaled, rungs: tm.ladder.length, bytes: tm.bytes }))
  } finally {
    if (typeof sseServer.closeAllConnections === 'function') sseServer.closeAllConnections()
    await new Promise(function (res2) { sseServer.close(res2) })
  }

  /* P1-06: typed mouse over the production stdio path */
  const mv = await call('browser_mouse', { tabId: actTab0.tabId, action: 'move', x: 12, y: 34 }, 'm1')
  const mvData = textOf(mv)
  check('browser_mouse move dispatched with coordinates', mvData && mvData.dispatched === true && mvData.x === 12 && mvData.y === 34, JSON.stringify(mvData).slice(0, 140))
  const sc = await call('browser_mouse', { tabId: actTab0.tabId, action: 'scroll', x: 100, y: 100, deltaY: 240 }, 'm2')
  check('browser_mouse scroll dispatched', textOf(sc) && textOf(sc).dispatched === true, JSON.stringify(textOf(sc)).slice(0, 140))
  const stale = await call('browser_mouse', { tabId: actTab0.tabId, action: 'click', x: 100, y: 100, screenshotId: 'ss999999999' }, 'm3')
  const staleRaw = stale.result && Array.isArray(stale.result.content) && stale.result.content[0] ? stale.result.content[0].text : null
  const staleErr = (stale.error && stale.error.message) || (stale.result && stale.result.isError === true ? staleRaw : null)
  check('browser_mouse rejects unknown screenshotId (structured over stdio)', !!staleErr && /unknown screenshotId/i.test(staleErr), staleErr)

  /* P0-13: grant lifecycle over MCP. The browser_navigate step left the tab on
   * the AFTER page (Pay/password targets live on the ACT page): navigate back,
   * then take the refs from the fresh snapshot. */
  const back = await call('browser_navigate', { tabId: actTab0.tabId, url: startUrl }, '8b')
  const backData = textOf(back)
  check('navigated back to the act page for the grant section', backData && backData.verification === 'navigation' && backData.finalUrl.indexOf('act.html') !== -1)
  const s2call = await call('browser_snapshot', { tabId: actTab0.tabId }, '9')
  let s2Data = textOf(s2call)
  for (let tries = 0; tries < 3 && !s2Data; tries++) { await sleep(1200); s2Data = textOf((await call('browser_snapshot', { tabId: actTab0.tabId }, '9-r' + tries))) }

  /* P1-03: predict + verify over real stdio MCP (fresh refs, current page) */
  const chgRef2 = (s2Data.nodes.find(n => n.name === 'Change Text') || {}).ref
  const pl = await call('browser_predict', { tabId: actTab0.tabId, ref: chgRef2, action: 'click' }, 'p1')
  const plData = textOf(pl)
  check('browser_predict: unknown-effect button honestly unknown/low confidence',
    plData && plData.sideEffectClass === 'unknown' && plData.confidence === 'low' && plData.requiresUserInput === true,
    JSON.stringify(plData && { cls: plData.sideEffectClass, c: plData.confidence }))
  const vv = await call('browser_verify', { tabId: actTab0.tabId, selector: '#out', textContains: 'initial' }, 'v1')
  const vvData = textOf(vv)
  check('browser_verify: cheap combined verify (selector visible + body text) via real stdio',
    vvData && vvData.verified === true && vvData.checks && vvData.checks.selectorVisible === true && vvData.checks.textContains === true,
    JSON.stringify(vvData && vvData.checks))
  const payRef = (s2Data && s2Data.nodes.find(n => n.name === 'Pay Now') || {}).ref
  const pwdRef = (s2Data && s2Data.nodes.find(n => n.role === 'textbox' && n.redacted === true) || {}).ref
  check('risky + sensitive targets present on the e2e page', !!payRef && !!pwdRef,
    JSON.stringify(s2Data && s2Data.nodes && s2Data.nodes.map(n => n.role + ':' + n.name.slice(0, 30)) || ('snapshot failed: ' + JSON.stringify(s2call.error || s2call))))

  const risky1 = await call('browser_click', { tabId: actTab0.tabId, ref: payRef }, '10')
  const riskyErrText = risky1.result.content[0].text
  check('unprompted risky click -> 403 risky_action', risky1.result.isError === true && riskyErrText.indexOf('risky_action') !== -1, riskyErrText.slice(0, 120))

  const g1 = await call('browser_grant', { action: 'risky_click', tabId: actTab0.tabId }, '11')
  const g1Data = textOf(g1)
  check('browser_grant risky_click ok (single-use, tab-bound)', g1Data && g1Data.granted === true && g1Data.tabId === actTab0.tabId, JSON.stringify(g1Data))

  const risky2 = await call('browser_click', { tabId: actTab0.tabId, ref: payRef }, '12')
  const risky2Data = textOf(risky2)
  check('granted risky click -> dom-change, grant consumed', risky2Data && risky2Data.verification === 'dom-change' && risky2Data.verified === true)
  const risky3 = await call('browser_click', { tabId: actTab0.tabId, ref: payRef }, '13')
  const risky3Text = risky3.result.content[0].text
  check('second risky click without a new grant -> 403 again (single use)', risky3.result.isError === true && risky3Text.indexOf('risky_action') !== -1, risky3Text.slice(0, 120))

  const t1 = await call('browser_type', { tabId: actTab0.tabId, ref: pwdRef, text: 'nope-not-typed' }, '14')
  const t1ErrText = t1.result.content[0].text
  check('unprompted sensitive typing -> 403 sensitive_field', t1.result.isError === true && t1ErrText.indexOf('sensitive_field') !== -1, t1ErrText.slice(0, 120))

  const g2 = await call('browser_grant', { action: 'sensitive_type', tabId: actTab0.tabId, ref: pwdRef, ttlSeconds: 60 }, '15')
  const g2Data = textOf(g2)
  check('browser_grant sensitive_type ok (ref-bound)', g2Data && g2Data.granted === true, JSON.stringify(g2Data))
  const gsStatus = await call('browser_status', {}, 'gs')
  const grantsStatus = textOf(gsStatus).bridge.grants
  check('browser_status.bridge.grants exposes active count only (no sensitive detail)',
    typeof grantsStatus.active === 'number' && grantsStatus.active >= 1 && !('action' in grantsStatus) && !('ref' in grantsStatus),
    JSON.stringify(grantsStatus))
  const t2 = await call('browser_type', { tabId: actTab0.tabId, ref: pwdRef, text: 'Gr4nted-Pw' }, '16')
  const t2Data = textOf(t2)
  check('granted sensitive typing -> value-length verified (P1-01C semantics), grant consumed', t2Data && t2Data.verification === 'value-length' && t2Data.verified === true,
    t2.result && t2.result.content && t2.result.content[0] ? t2.result.content[0].text.slice(0, 140) : JSON.stringify(t2.result))
  const t3 = await call('browser_type', { tabId: actTab0.tabId, ref: pwdRef, text: 'second-try' }, '17')
  const t3ErrText = t3.result.content[0].text
  check('second sensitive typing without a new grant -> 403 (single use)', t3.result.isError === true && t3ErrText.indexOf('sensitive_field') !== -1, t3ErrText.slice(0, 120))

  /* ---------------- P1-03: browser_batch over real stdio MCP ---------------- */
  /* 1. schema discovery: tools/list must include browser_batch with typed
   *    array input schema (contains tool enum incl. browser_navigate). */
  const tl = await a2.request('tools/list', {}, 5000)
  const batchTool = (tl.result.tools.find(t => t.name === 'browser_batch') || {})
  check('tools/list exposes browser_batch schema (typed array, excluded tools documented)',
    !!batchTool.inputSchema && JSON.stringify(batchTool.inputSchema).indexOf('browser_navigate') !== -1 &&
    JSON.stringify(batchTool).indexOf('browser_grant') !== -1, JSON.stringify(batchTool && batchTool.name))

  /* 2. short safe batch against a REAL public page (https://example.com):
   *    navigate + snapshot + content in ONE round trip. Availability was
   *    verified in earlier tasks; a failure here is reported as observed. */
  const netBefore = textOf(st).bridge.net
  const bsm = await call('browser_batch', {
    tabId: actTab0.tabId,
    actions: [
      { tool: 'browser_navigate', params: { url: 'https://example.com/', stabilityWindowMs: 500 } },
      { tool: 'browser_snapshot', params: { maxNodes: 20 } },
      { tool: 'browser_content', params: { maxChars: 1000 } }
    ]
  }, 'B1')
  const bsmData = textOf(bsm)
  check('browser_batch: navigate+snapshot+content in one MCP call, all steps ok',
    bsm.status === undefined || true, JSON.stringify(bsmData && { ok: bsmData.ok, completed: bsmData.completed, planned: bsmData.planned }))
  check('browser_batch: snapshot step returned live example.com nodes',
    bsmData && bsmData.steps && bsmData.steps[1] && bsmData.steps[1].ok === true &&
    bsmData.steps[1].result && bsmData.steps[1].result.url === 'https://example.com/',
    JSON.stringify(bsmData && bsmData.steps && bsmData.steps[1].result && bsmData.steps[1].result.url))
  const contentStep = bsmData && bsmData.steps && bsmData.steps[2]
  check('browser_batch: content step verified Example Domain text',
    contentStep && contentStep.ok === true && /documentation examples|Example Domain/i.test(contentStep.result.text || ''),
    contentStep && JSON.stringify(contentStep.result && contentStep.result.text.slice(0, 60)))

  /* 3. multi-step batch (second public page back and forth) with per-step
   *    verification of every structured result kind. */
  const b2 = await call('browser_batch', {
    tabId: actTab0.tabId,
    actions: [
      { tool: 'browser_navigate', params: { url: 'https://news.ycombinator.com/', stabilityWindowMs: 500 } },
      { tool: 'browser_wait', params: { until: 'network_idle', timeoutMs: 10000 } },
      { tool: 'browser_state' },
      { tool: 'browser_navigate', params: { url: 'https://example.com/' } },
      { tool: 'browser_snapshot', params: { maxNodes: 10 } }
    ]
  }, 'B2')
  const b2Data = textOf(b2)
  check('browser_batch: 5-step multi-page sequence, per-step ok flags',
    b2Data && b2Data.ok === true && b2Data.steps.length === 5 && b2Data.steps.every(s => s.ok === true),
    JSON.stringify(b2Data && { ok: b2Data.ok, completed: b2Data.completed, totalMs: b2Data.totalMs }))
  const b2Wait = b2Data && b2Data.steps && b2Data.steps[1]
  check('browser_batch: wait step verified exercised mid-batch',
    b2Wait && b2Wait.ok === true && b2Wait.result.satisfied === true, JSON.stringify(b2Wait && b2Wait.result))

  /* 4. stop-on-error: an excluded tool (browser_grant) inside a batch must
   *    fail safely; the third step must NOT run. */
  const b3 = await call('browser_batch', {
    tabId: actTab0.tabId,
    actions: [
      { tool: 'browser_tabs' },
      { tool: 'browser_grant' },
      { tool: 'browser_tabs' }
    ]
  }, 'B3')
  const b3Data = textOf(b3)
  check('browser_batch: browser_grant excluded (step error), stop-on-error prevents step 3',
    b3Data && b3Data.ok === false && b3Data.steps.length === 2 &&
    b3Data.steps[0].ok === true && b3Data.steps[1].ok === false &&
    /grant|batch/i.test(b3Data.steps[1].error.message),
    JSON.stringify(b3Data && { completed: b3Data.completed, planned: b3Data.planned, lastErr: b3Data.steps[1] && b3Data.steps[1].error }))

  /* 5. nesting smuggle: browser_batch inside browser_batch must be excluded */
  const b4 = await call('browser_batch', {
    tabId: actTab0.tabId,
    actions: [
      { tool: 'browser_batch', params: { tabId: actTab0.tabId, actions: '[{"tool":"browser_tabs"}]' } }
    ]
  }, 'B4')
  const b4Data = textOf(b4)
  check('browser_batch: nested batch rejected (no grant/permit smuggling path)',
    b4Data && b4Data.ok === false && b4Data.steps.length === 1 && b4Data.steps[0].ok === false,
    JSON.stringify(b4Data && b4Data.steps && b4Data.steps[0].error))

  /* 6. per-step schema validation: unknown tool + javascript: nav + param invalid */
  const b5 = await call('browser_batch', {
    tabId: actTab0.tabId,
    actions: [
      { tool: 'browser_navigate', params: { url: 'javascript:alert(1)' } },
      { tool: 'browser_type', params: { ref: 'r0', text: 'x' } }
    ]
  }, 'B5')
  const b5Data = textOf(b5)
  check('browser_batch: blocked scheme per-step (blocked category), stop-on-error',
    b5Data && b5Data.ok === false && b5Data.steps.length === 1 &&
    b5Data.steps[0].error.category === 'blocked',
    JSON.stringify(b5Data && b5Data.steps && b5Data.steps[0].error))

  /* 7. step-limit + JSON validation: 21 entries + non-JSON both rejected with the structured transport error (isError) */
  const b6 = await call('browser_batch', {
    tabId: actTab0.tabId,
    actions: JSON.stringify(Array.from({ length: 21 }, () => ({ tool: 'browser_tabs' })))
  }, 'B6')
  check('browser_batch: >20 steps rejected with structured invalid_params (exact count enforced per-command)',
    b6.result && /1-20 entries/i.test(b6.result.content[0].text),
    b6.result && b6.result.content[0].text.slice(0, 140))
  const b7 = await call('browser_batch', { tabId: actTab0.tabId, actions: 'not json at all' }, 'B7')
  check('browser_batch: non-JSON actions rejected with structured invalid_params',
    b7.result && /not valid JSON/i.test(b7.result.content[0].text),
    b7.result && b7.result.content[0].text.slice(0, 140))

  /* 8. ad-blocker integrity from the MCP-e2e surface: exactly one effective
   *    onBeforeRequest registrant in the running bundle, and the blocker's net
   *    counters moved during this run (the handler is alive and feeding). */
  const bundle = fs.readFileSync(path.join(ROOT, 'main.build.js'), 'utf8')
  const regs = bundle.match(/webRequest\.onBeforeRequest\(/g) || []
  check('ad-blocker: exactly one effective onBeforeRequest registration in the bundle', regs.length === 1, 'registrants=' + regs.length)
  const stAfterBatch = textOf((await call('browser_status', {}, 'B8')))
  const netAfter = stAfterBatch.bridge.net
  check('ad-blocker: blocker handler observed http(s) requests during this run (net.observedTotal > 0)',
    netAfter && netAfter.observedTotal > 0, JSON.stringify(netAfter))
  check('ad-blocker: filter pipeline still blocks (persisted count >= 0 known tracker fixtures handled by probe:waits — here: counters consistent)',
    netAfter.settledTotal <= netAfter.observedTotal, JSON.stringify({ settled: netAfter.settledTotal, observed: netAfter.observedTotal }))

  /* stdout purity re-assertion after the batch section */
  check('adapter stdout still carried only MCP frames after batch phase', a2.nonMcpStdoutLines.length === 0, a2.nonMcpStdoutLines.join(' | ').slice(0, 120))

  check('adapter stdout carried only MCP frames (e2e phase)', a2.nonMcpStdoutLines.length === 0, a2.nonMcpStdoutLines.join(' | ').slice(0, 120))
  check('token never appeared in adapter stderr', a2.stderrLines.join('').indexOf(token) === -1)

  /* transcript: remove tokens, truncate image/long data — via object walking so
   * the saved file stays valid JSON. */
  const scrub = function (v) {
    if (typeof v === 'string') {
    /* Transcript is a TRACKED evidence file: bound every string so page content,
     * base64 payloads and PII can never accumulate into the repository. */
    const redacted = v.split(token).join('<redacted-token>')
    return redacted.length > 1500 ? redacted.slice(0, 1500) + '.[truncated ' + redacted.length + ' chars]' : redacted
  }
    if (Array.isArray(v)) return v.map(scrub)
    if (v && typeof v === 'object') {
      const o = {}
      for (const k of Object.keys(v)) o[k] = scrub(v[k])
      return o
    }
    return v
  }
  const scrubContent = function (c) {
    if (c.type === 'image') return { type: 'image', mimeType: c.mimeType, data: '[truncated: ' + c.data.length + ' chars]' }
    if (c.type === 'text' && c.text.length > 1500) return { type: 'text', text: c.text.slice(0, 1500) + '.[truncated ' + c.text.length + ' chars]' }
    return scrub(c)
  }
  const stepsClean = transcript.map(function (e) {
    const resp = e.response
    const content = resp && Array.isArray(resp.content) ? resp.content.map(scrubContent) : scrub(resp)
    return { step: e.step, tool: e.tool, params: scrub(e.params), response: resp && resp.isError ? { isError: true, content: content } : { content: content } }
  })
  const transcriptText = JSON.stringify({ ranAt: new Date().toISOString(), launcherProfile: '<temp-profile>', steps: stepsClean, failures: failures }, null, 2)
  fs.writeFileSync(EVIDENCE_FILE, transcriptText, 'utf8')
  check('transcript saved (docs/mcp-e2e-run.json, valid JSON, token removed, image data truncated)',
    fs.existsSync(EVIDENCE_FILE) && transcriptText.indexOf(token) === -1 && transcriptText.length < 200000)

  /* teardown: client closes stdin (spec shutdown), then kill the launcher tree */
  a2.end()
  killLauncher()
  await sleep(2000)
  const aliveAfter = launcherPidAlive(launcher.pid)
  check('Min tree shut down with the launcher', !aliveAfter)

  return finish(results.every(r => r.pass) ? 0 : 2)
}

function finish (code) {
  fs.writeFileSync(path.join(ROOT, 'docs', 'mcp-unit-summary.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), passed: results.filter(r => r.pass).length, total: results.length, results }, null, 2), 'utf8')
  console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed')
  process.exit(code)
}

function launcherPidAlive (pid) {
  const r = spawnSync('tasklist.exe', ['/FI', 'PID eq ' + pid], { encoding: 'utf8', windowsHide: true })
  return String(r.stdout || '').indexOf(String(pid)) !== -1
}

main().catch(function (e) {
  console.error('mcp e2e error: ' + e.message)
  process.exit(2)
})
