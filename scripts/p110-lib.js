#!/usr/bin/env node
/*
 * P1-10 shared library: launch fixture server + Min (via min-launch.js) + the real
 * MCP stdio adapter, and expose a call() helper. Reuses the mcp-e2e.js patterns
 * (newline-framed JSON-RPC, ready-line handshake, targeted PID cleanup).
 *
 * Every cleanup action targets ONLY processes this module spawned
 * (taskkill /PID <pid> /T - never a process-name-wide kill).
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const WIN32 = process.platform === 'win32'

function rmrf (target) {
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch (e) { /* retry */ }
    if (!fs.existsSync(target)) return
    const until = Date.now() + 300
    while (Date.now() < until) { /* spin */ }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function startFixtureServer (port) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'p110-fixture-server.js'), '--port=' + port],
    { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error('fixture server did not become ready')) }, 8000)
    proc.stdout.on('data', function (d) {
      out += String(d)
      if (out.indexOf('fixture-ready ' + port) !== -1) { clearTimeout(timer); resolve(proc) }
    })
    proc.stderr.on('data', function (d) { out += String(d) })
    proc.on('exit', function (c) { clearTimeout(timer); reject(new Error('fixture server exited early rc=' + c + ' ' + out)) })
  })
}

function killPidTree (pid) {
  if (!pid) return
  if (WIN32) { try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }) } catch (e) { /* ignore */ } } else { try { process.kill(pid, 'SIGKILL') } catch (e) { /* ignore */ } }
}

/* Launch Min via min-launch.js. Resolves {launcher, kill, discoveryPath, profileDir}. */
async function launchMin (profileDir, startUrl) {
  const launcher = spawn(process.execPath, [path.join(ROOT, 'scripts', 'min-launch.js'), '--profile=' + profileDir, '--', startUrl],
    { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  launcher.stdout.on('data', d => { out += String(d) })
  launcher.stderr.on('data', d => { out += String(d) })
  let lines = []
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    await sleep(500)
    lines = out.split('\n').map(s => s.trim()).filter(Boolean)
    if (lines.indexOf('ready') !== -1) break
  }
  if (lines.indexOf('ready') === -1) throw new Error('min-launch not ready: ' + out.slice(0, 400))
  const discoveryPath = lines[1].slice('discovery-file:'.length).trim()
  return {
    launcher,
    discoveryPath,
    profileDir,
    kill: function () { killPidTree(launcher.pid) }
  }
}

/* Spawn the real MCP adapter for a profile (same as mcp-e2e makeAdapter). */
function makeAdapter (profileDir) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'mcp', 'min-agent-mcp.js'), '--profile=' + profileDir],
    { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const st = { proc, stderrLines: [], pending: {}, nextId: 100 }
  let buf = ''
  proc.stdout.on('data', function (d) {
    buf += d
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const frame = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!frame) continue
      let msg = null
      try { msg = JSON.parse(frame) } catch (e) { continue }
      if (msg.id !== undefined && msg.id !== null && st.pending[msg.id]) {
        const resolve = st.pending[msg.id]
        delete st.pending[msg.id]
        resolve(msg)
      }
    }
  })
  proc.stderr.on('data', function (d) { st.stderrLines.push(String(d)) })
  st.request = function (method, params, timeoutMs) {
    const id = 'r' + (++st.nextId)
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        if (st.pending[id]) { delete st.pending[id]; resolve({ id, error: { code: -32000, message: 'client-side timeout' } }) }
      }, timeoutMs || 30000)
      st.pending[id] = function (msg) { clearTimeout(timer); resolve(msg) }
      const frame = { jsonrpc: '2.0', id, method }
      if (params !== undefined) frame.params = params
      proc.stdin.write(JSON.stringify(frame) + '\n')
    })
  }
  st.notify = function (method, params) {
    const frame = Object.assign({ jsonrpc: '2.0', method }, params ? { params } : {})
    proc.stdin.write(JSON.stringify(frame) + '\n')
  }
  st.end = function () { try { proc.stdin.end() } catch (e) { /* ignore */ } }
  return st
}

/* Full stack: fixture server + Min + MCP adapter. */
async function launchStack (opts) {
  const o = Object.assign({ fixturePort: 47310, controlPort: 0, profileBase: null, startPath: '/' }, opts)
  const runId = 'p110-' + Date.now()
  const profileDir = o.profileBase || path.join(os.tmpdir(), 'min-p110-profile-' + runId)
  const fixture = await startFixtureServer(o.fixturePort)
  const fixtureBase = 'http://127.0.0.1:' + o.fixturePort
  const min = await launchMin(profileDir, fixtureBase + o.startPath)
  const adapter = makeAdapter(profileDir)
  const init = await adapter.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p110', version: '0' } }, 15000)
  adapter.notify('notifications/initialized')
  if (!init.result || !init.result.serverInfo) { throw new Error('MCP initialize failed: ' + JSON.stringify(init).slice(0, 200)) }

  const trace = []
  /* callTool: tools/call with per-call latency + trace record. Screenshot image data is
     extracted and saved to a PNG file so the driving agent can genuinely inspect it. */
  async function callTool (name, args, opts2) {
    const o2 = Object.assign({ timeoutMs: 60000, label: '', shotPrefix: null }, opts2)
    const t0 = Date.now()
    const r = await adapter.request('tools/call', { name, arguments: args || {} }, o2.timeoutMs)
    const latency = Date.now() - t0
    let summary = ''
    let isError = false
    let imageFile = null
    if (r.error) { isError = true; summary = 'rpc-error ' + r.error.code + ' ' + (r.error.message || '') }
    else if (r.result) {
      isError = r.result.isError === true
      const blocks = (r.result.content || [])
      const img = blocks.find(b => b.type === 'image')
      const texts = blocks.filter(b => b.type === 'text').map(b => b.text)
      if (img) {
        imageFile = path.join(ROOT, 'docs', 'p110-runs', (o2.shotPrefix || name) + '-' + Date.now() + '.png')
        try { fs.mkdirSync(path.dirname(imageFile), { recursive: true }); fs.writeFileSync(imageFile, Buffer.from(img.data, 'base64')) } catch (e) { imageFile = null }
        summary = 'image ' + (img.mimeType || '') + ' ' + (img.data ? img.data.length : 0) + 'b64chars -> ' + (imageFile ? path.basename(imageFile) : 'SAVE-FAILED')
      }
      if (texts.length) {
        let parsed = null
        try { parsed = JSON.parse(texts[0]) } catch (e) { /* plain text */ }
        summary += (summary ? ' | ' : '') + (parsed ? JSON.stringify(parsed).slice(0, 4000) : texts[0].slice(0, 4000))
      }
    }
    trace.push({ ts: Date.now(), tool: name, label: o2.label, latencyMs: latency, isError, imageFile, args: sanitiseArgs(args), summary })
    return { isError, imageFile, latency, raw: r, summary }
  }

  function sanitiseArgs (a) {
    try {
      const s = JSON.parse(JSON.stringify(a || {}))
      return s
    } catch (e) { return {} }
  }

  return {
    runId, profileDir, fixtureBase, fixture, min, adapter, callTool, trace,
    shutdown: async function () {
      adapter.end()
      min.kill()
      killPidTree(fixture.pid)
      await sleep(400)
      for (let i = 0; i < 5; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch (e) { await sleep(300) } }
    }
  }
}

/* tiny fetch-free POST helper for the keeper client */
function httpPost (port, obj, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify(obj)
    const req = http.request({ host: '127.0.0.1', port, path: '/call', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs || 60000 }, function (res) {
      let b = ''
      res.on('data', d => { b += d })
      res.on('end', function () { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.on('timeout', function () { req.destroy(new Error('client timeout')) })
    req.end(body)
  })
}

module.exports = { ROOT, launchStack, startFixtureServer, makeAdapter, launchMin, killPidTree, rmrf, sleep, httpPost }
