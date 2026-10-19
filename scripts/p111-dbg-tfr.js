#!/usr/bin/env node
/* debug packaged transform restore round-trip */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const ROOT = path.resolve(__dirname, '..')
const PACKAGED_MIN = (function () { const d = path.join(ROOT, 'dist', 'app', 'win-unpacked'); const n = fs.existsSync(path.join(d, 'Min Agent Edition.exe')) ? 'Min Agent Edition.exe' : 'Min.exe'; return path.join(d, n) })()
const SHIPPED_ADAPTER = path.join(ROOT, 'dist', 'app', 'win-unpacked', 'resources', 'app', 'mcp', 'min-agent-mcp.js')
const PROFILE = path.join(os.tmpdir(), 'min-p111-tfr-dbg-' + Date.now())
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main () {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><head><title>Transform Target</title></head><body><h1 id="h">ORIGINAL-TEXT- marker</h1><p>stable paragraph line</p></body></html>')
  })
  await new Promise(r => srv.listen(47345, '127.0.0.1', r))
  const min = spawn(PACKAGED_MIN, ['--user-data-dir=' + PROFILE, '--agent-rpc'], { cwd: path.dirname(PACKAGED_MIN), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  min.stdout.on('data', function () {})
  min.stderr.on('data', function () { /* drain */ })
  let disc = null
  for (let i = 0; i < 60 && !disc; i++) { await sleep(500); try { disc = JSON.parse(fs.readFileSync(path.join(PROFILE, 'agent-rpc.json'), 'utf8')) } catch (e) {} }
  const adapter = spawn(process.execPath, [SHIPPED_ADAPTER, '--profile=' + PROFILE], { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  adapter.stdout.on('data', function (d) { buf += String(d) })
  adapter.stderr.on('data', function (d) { buf += 'ADAPTER-ERR:' + String(d) })
  const send = obj => adapter.stdin.write(JSON.stringify(obj) + '\n')
  const call = async function (id, name, args, waitMs) {
    buf = ''
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    await sleep(waitMs || 2500)
    const lines = buf.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch (e) { return { parseFail: l } } })
    return lines.find(m => m.id === id)
  }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dbg', version: '0' } } })
  await sleep(2500)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const tabsMsg = await call(2, 'browser_tabs', {}, 3000)
  const tabId = JSON.parse(tabsMsg.result.content[0].text).tabs.find(t => t.active).tabId
  await call(3, 'browser_navigate', { tabId, url: 'http://127.0.0.1:47345/transform-page' }, 4000)
  const snap = await call(4, 'browser_snapshot', { tabId }, 3000)
  const snapT = JSON.parse(snap.result.content[0].text)
  const node = snapT.nodes.find(n => n.role === 'heading')
  console.log('SNAPSHOT heading:', JSON.stringify(node))
  const tr = await call(5, 'browser_transform', { tabId, actions: [{ op: 'replace_text', ref: node.ref, text: 'TRANSFORMED-BY-AGENT' }] }, 4000)
  console.log('TRANSFORM RESULT:', tr && tr.result && tr.result.content[0].text.slice(0, 500))
  const st = await call(6, 'browser_transform_status', { tabId }, 2500)
  console.log('STATUS:', st && st.result && st.result.content[0].text.slice(0, 400))
  const re = await call(7, 'browser_transform', { tabId, actions: [{ op: 'restore_target', ref: node.ref }] }, 4000)
  console.log('RESTORE RESULT:', re && re.result && re.result.content[0].text.slice(0, 500))
  const ver = await call(8, 'browser_verify', { tabId, textContains: 'ORIGINAL-TEXT-' }, 2500)
  console.log('VERIFY ORIGINAL:', ver && ver.result && ver.result.content[0].text.slice(0, 300))
  const cnt = await call(9, 'browser_content', { tabId }, 2500)
  console.log('CONTENT after restore:', cnt && cnt.result && cnt.result.content[0].text.slice(0, 300))
  spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(min.pid)], { windowsHide: true })
  adapter.kill(); srv.close()
  process.exit(0)
}
main()
