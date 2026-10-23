#!/usr/bin/env node
/*
 * Final-audit runtime check: the PACKAGED app enforces the corrected CAPTCHA
 * policy (detection != interaction lock; challenge-control click not refused;
 * detection alone not clearance). Uses the shipped MCP adapter + local fixture.
 * Cleanup: targeted /PID of its own spawn only.
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const ROOT = path.resolve(__dirname, '..')
const APPDIR = path.join(ROOT, 'dist', 'app', 'win-unpacked')
const EXE = fs.existsSync(path.join(APPDIR, 'Min Agent Edition.exe')) ? 'Min Agent Edition.exe' : 'Min.exe'
const SHIPPED = path.join(APPDIR, 'resources', 'app', 'mcp', 'min-agent-mcp.js')
const PROFILE = path.join(os.tmpdir(), 'min-p113-capchk-' + Date.now())
const FIXPORT = 47360
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main () {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><head><title>CaptchaPolicyCheck</title></head><body>' +
      '<h1>CP Heading</h1>' +
      '<div class="cf-turnstile" data-sitekey="LOCAL-FIXTURE-NOT-REAL" style="width:300px;height:70px;border:1px solid #ccc">' +
      '<button id="challenge-btn" type="button">Solve challenge</button></div>' +
      '<button id="plain-btn" type="button">Plain action</button>' +
      '<div id="plain-out">pending</div>' +
      '<script>document.getElementById("plain-btn").addEventListener("click",function(){' +
      'document.getElementById("plain-out").textContent="PLAIN-CLICK-LANDED";});</script></body></html>')
  })
  await new Promise(r => srv.listen(FIXPORT, '127.0.0.1', r))
  let minErr = ''
  const min = spawn(path.join(APPDIR, EXE), ['--user-data-dir=' + PROFILE, '--agent-rpc', '--', 'http://127.0.0.1:' + FIXPORT + '/'],
    { cwd: APPDIR, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  min.stdout.on('data', () => {})
  min.stderr.on('data', d => { minErr += String(d) })
  let disc = null
  for (let i = 0; i < 60 && !disc; i++) { await sleep(500); try { disc = JSON.parse(fs.readFileSync(path.join(PROFILE, 'agent-rpc.json'), 'utf8')) } catch (e) {} }
  const results = []
  const check = (n, p, d) => { results.push({ n, p }); console.log((p ? 'PASS  ' : 'FAIL  ') + n + (p ? '' : ' [' + String(d).slice(0, 180) + ']')) }
  const adapter = spawn(process.execPath, [SHIPPED, '--profile=' + PROFILE], { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  adapter.stdout.on('data', d => { buf += String(d) })
  adapter.stderr.on('data', d => { minErr += 'ADAPTER:' + String(d) })
  const send = o => adapter.stdin.write(JSON.stringify(o) + '\n')
  const call = async (id, name, args, wait) => {
    buf = ''
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    await sleep(wait || 3000)
    const lines = buf.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
    return lines.find(m => m.id === id)
  }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p113chk', version: '0' } } })
  await sleep(2500)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const tabsMsg = await call(2, 'browser_tabs', {})
  const tabId = (JSON.parse(tabsMsg.result.content[0].text).tabs.find(t => t.active) || {}).tabId
  check('packaged app reachable through shipped adapter', !!tabId)
  await call(3, 'browser_navigate', { tabId, url: 'http://127.0.0.1:' + FIXPORT + '/' }, 4000)
  const st = await call(4, 'browser_state', { tabId })
  const stT = JSON.parse(st.result.content[0].text)
  check('captcha detected in PACKAGED app (informational reporting intact)', stT.captcha && stT.captcha.detected === true, JSON.stringify(stT.captcha).slice(0, 150))
  const snap = await call(5, 'browser_snapshot', { tabId }, 3000)
  const nodes = JSON.parse(snap.result.content[0].text).nodes
  const solveRef = (nodes.find(n => /solve challenge/i.test(n.name || '')) || {}).ref
  const plainRef = (nodes.find(n => /plain action/i.test(n.name || '')) || {}).ref
  check('challenge + ordinary controls enumerated', !!solveRef && !!plainRef)
  const cl = await call(6, 'browser_click', { tabId, ref: solveRef }, 8000)
  const clTxt = cl && cl.result && cl.result.content && cl.result.content[0] ? cl.result.content[0].text : JSON.stringify(cl || {}).slice(0, 160)
  check('challenge-control click NOT refused by blanket guard (packaged runtime)', !cl.result.isError && clTxt.indexOf('captcha_handoff_required') === -1, clTxt.slice(0, 160))
  const st2 = await call(7, 'browser_state', { tabId }, 6000)
  let stDetectedPersist = false
  try { stDetectedPersist = JSON.parse(st2.result.content[0].text).captcha.detected === true } catch (e) {}
  check('challenge click did NOT count as clearance (detection persists in packaged app)', stDetectedPersist, JSON.stringify(st2.result && st2.result.content).slice(0, 120))
  const cp = await call(8, 'browser_click', { tabId, ref: plainRef }, 6000)
  const ver = await call(9, 'browser_verify', { tabId, textContains: 'PLAIN-CLICK-LANDED' }, 4000)
  let plainVerified = false
  try { plainVerified = JSON.parse(ver.result.content[0].text).verified === true } catch (e) {}
  check('ordinary control clickable + independently verified while widget present', cp && cp.result && !cp.result.isError && plainVerified, JSON.stringify(ver && ver.result && ver.result.content).slice(0, 120))
  try { adapter.kill() } catch (e) {}
  spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(min.pid)], { windowsHide: true })
  try { adapter.kill() } catch (e) {}
  srv.close()
  setTimeout(() => process.exit(results.every(r => r.p) ? 0 : 1), 1200)
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })
