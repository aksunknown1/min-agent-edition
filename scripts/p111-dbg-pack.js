#!/usr/bin/env node
/* debug one tool call against the packaged app; print raw result */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const PACKAGED_MIN = (function () { const d = path.join(ROOT, 'dist', 'app', 'win-unpacked'); const n = fs.existsSync(path.join(d, 'Min Agent Edition.exe')) ? 'Min Agent Edition.exe' : 'Min.exe'; return path.join(d, n) })()
const SHIPPED_ADAPTER = path.join(ROOT, 'dist', 'app', 'win-unpacked', 'resources', 'app', 'mcp', 'min-agent-mcp.js')
const PROFILE = path.join(os.tmpdir(), 'min-p111-dbg-profile-' + Date.now())
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main () {
  const min = spawn(PACKAGED_MIN, ['--user-data-dir=' + PROFILE, '--agent-rpc'], { cwd: path.dirname(PACKAGED_MIN), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  min.stdout.on('data', function () {})
  min.stderr.on('data', function (d) { minErr += String(d) })
  let minErr = ''
  let disc = null
  for (let i = 0; i < 60 && !disc; i++) { await sleep(500); try { disc = JSON.parse(fs.readFileSync(path.join(PROFILE, 'agent-rpc.json'), 'utf8')) } catch (e) {} }
  const adapter = spawn(process.execPath, [SHIPPED_ADAPTER, '--profile=' + PROFILE], { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  adapter.stdout.on('data', function (d) { buf += String(d) })
  adapter.stderr.on('data', function (d) { minErr += 'ADAPTER:' + String(d) })
  const send = function (obj) { adapter.stdin.write(JSON.stringify(obj) + '\n') }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dbg', version: '0' } } })
  await sleep(2500)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } })
  await sleep(3000)
  let msgs = buf.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
  const tabsMsg = msgs.find(m => m.id === 2)
  const tabs = JSON.parse(tabsMsg.result.content[0].text)
  const tabId = tabs.tabs.find(t => t.active).tabId
  buf = ''
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_content', arguments: { tabId } } })
  await sleep(4000)
  msgs = buf.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
  const c = msgs.find(m => m.id === 3)
  console.log('RAW browser_content:', JSON.stringify(c, null, 1).slice(0, 900))
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_transform', arguments: { tabId, kind: 'replace_text', selector: 'h1', text: 'XX' } } })
  await sleep(3000)
  const t = msgs.find(m => m.id === 4) || null
  console.log('RAW browser_transform: (see id4 in buf)')
  console.log(buf.split('\n').filter(Boolean).slice(-1)[0] && buf.split('\n').filter(Boolean).slice(-1)[0].slice(0, 900))
  spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(min.pid)], { windowsHide: true })
  adapter.kill()
  process.exit(0)
}
main()
