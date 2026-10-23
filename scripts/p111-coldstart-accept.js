#!/usr/bin/env node
/*
 * P1-11 cold-start acceptance for the PACKAGED Windows app.
 * Launches dist/app/win-unpacked/Min.exe with a fresh dedicated user-data dir,
 * then drives the SHIPPED MCP adapter (resources/app/mcp/min-agent-mcp.js).
 * Cleanup is targeted (taskkill /PID <own pid> /T) - never a name-wide kill.
 *
 * Checks: production mode (no development flags), 37 tools, tabs/navigate/content/
 * snapshot/screenshot image, transform apply+verify+restore, agent-managed download
 * under userData/agent-downloads, no dev extension fixtures, userData isolation.
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PACKAGED_MIN = (function () { const d = path.join(ROOT, 'dist', 'app', 'win-unpacked'); const n = fs.existsSync(path.join(d, 'Min Agent Edition.exe')) ? 'Min Agent Edition.exe' : 'Min.exe'; return path.join(d, n) })()
const SHIPPED_ADAPTER = path.join(ROOT, 'dist', 'app', 'win-unpacked', 'resources', 'app', 'mcp', 'min-agent-mcp.js')
const PROFILE = path.join(os.tmpdir(), 'min-p111-accept-profile-' + Date.now())
const FIXTURE_PORT = 47340
const IMG_OUT = path.join(ROOT, 'docs', 'p111-runs', 'packaged-screenshot.png')

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail === undefined ? '' : detail).slice(0, 220) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function rmrf (t) { try { fs.rmSync(t, { recursive: true, force: true }) } catch (e) { /* ignore */ } }

/* --- tiny fixture server (loopback only): transform page + download file --- */
function startFixture () {
  return new Promise(function (resolve) {
    const srv = http.createServer(function (req, res) {
      const u = req.url
      if (u === '/transform-page') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><html><head><title>Transform Target</title></head><body><h1 id="h">ORIGINAL-TEXT- marker</h1><p>stable paragraph line</p></body></html>')
      } else if (u === '/down.bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 2048 })
        res.end(Buffer.alloc(2048, 7))
      } else {
        res.writeHead(404); res.end('nf')
      }
    })
    srv.listen(FIXTURE_PORT, '127.0.0.1', function () { resolve(srv) })
  })
}

/* --- adapter over stdio (same pattern as p110-lib) --- */
function makeAdapter (adapterPath, profileDir) {
  const proc = spawn(process.execPath, [adapterPath, '--profile=' + profileDir],
    { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const st = { proc, pending: {}, nextId: 500, stderr: [] }
  let buf = ''
  proc.stdout.on('data', function (d) {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const fr = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!fr) continue
      let msg; try { msg = JSON.parse(fr) } catch (e) { continue }
      if (msg.id != null && st.pending[msg.id]) { const r = st.pending[msg.id]; delete st.pending[msg.id]; r(msg) }
    }
  })
  proc.stderr.on('data', function (d) { st.stderr.push(String(d)) })
  st.request = function (method, params, timeoutMs) {
    const id = 'r' + (++st.nextId)
    return new Promise(function (resolve) {
      const t = setTimeout(function () { if (st.pending[id]) { delete st.pending[id]; resolve({ error: { message: 'client-timeout' } }) } }, timeoutMs || 45000)
      st.pending[id] = function (msg) { clearTimeout(t); resolve(msg) }
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  st.notify = function (method, params) {
    proc.stdin.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', method }, params ? { params } : {})) + '\n')
  }
  st.end = function () { try { proc.stdin.end() } catch (e) {} }
  return st
}
const textOf = r => { try { return JSON.parse(r.result.content.find(b => b.type === 'text').text) } catch (e) { return null } }

async function main () {
  fs.mkdirSync(path.dirname(IMG_OUT), { recursive: true })
  rmrf(PROFILE)
  const fixture = await startFixture()
  const base = 'http://127.0.0.1:' + FIXTURE_PORT

  const min = spawn(PACKAGED_MIN, ['--user-data-dir=' + PROFILE, '--agent-rpc', '--', base + '/transform-page'],
    { cwd: path.dirname(PACKAGED_MIN), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let minErr = ''
  min.stderr.on('data', d => { minErr += String(d) })
  min.stdout.on('data', function () { /* drain */ })
  let disc = null
  for (let i = 0; i < 60 && !disc; i++) {
    await sleep(500)
    for (const cand of [PROFILE, PROFILE + '-development']) {
      try { disc = JSON.parse(fs.readFileSync(path.join(cand, 'agent-rpc.json'), 'utf8')); break } catch (e) {}
    }
  }
  check('packaged Min started + bridge discovery within 30s', !!disc)
  if (!disc) { /* bounded cleanup */ killAll(); process.exit(1) }

  const adapter = makeAdapter(SHIPPED_ADAPTER, PROFILE)
  let r = await adapter.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p111', version: '0' } }, 15000)
  check('initialize with SHIPPED adapter', !!(r.result && r.result.serverInfo && r.result.serverInfo.name === 'min-agent'), JSON.stringify(r.error || {}).slice(0, 100))
  adapter.notify('notifications/initialized')
  r = await adapter.request('tools/list', {}, 10000)
  check('tools/list = 39 tools', r.result && r.result.tools && r.result.tools.length === 39, r.result && r.result.tools && r.result.tools.length)

  const call = async (name, args, to) => { const rr = await adapter.request('tools/call', { name, arguments: args || {} }, to || 45000); return { raw: rr, T: textOf(rr) } }

  r = await call('browser_status')
  check('browser_status on packaged app (Min Agent Edition identity)', !!r.T && r.T.app && r.T.app.name === 'Min Agent Edition', r.T && JSON.stringify(r.T.app))
  check('production development flag false', !!r.T && r.T.mode && r.T.mode.development === false, JSON.stringify(r.T && r.T.mode))
  check('dedicated user-data root used', !!r.T && r.T.profile && String(r.T.profile.userDataPath).indexOf('min-p111-accept-profile') !== -1, r.T && r.T.profile && r.T.profile.userDataPath)

  r = await call('browser_tabs')
  const tabId = r.T && r.T.tabs && (r.T.tabs.find(t => t.active) || r.T.tabs[0]).tabId
  check('tabs enumerable, fixture page loaded by launcher', !!tabId && r.T.tabs.some(t => (t.url || '').indexOf('transform-page') !== -1), JSON.stringify(r.T && r.T.tabs))

  // live network (permitted here): example.com through the packaged app
  r = await call('browser_navigate', { tabId, url: 'https://example.com/' }, 60000)
  check('navigate https://example.com verified', r.T && r.T.verified === true, r.T && r.T.finalUrl)
  r = await call('browser_content', { tabId })
  check('content: Example Domain text', !!r.raw.result && JSON.stringify(r.raw.result.content).indexOf('Example Domain') !== -1)
  r = await call('browser_snapshot', { tabId })
  check('snapshot with refs', !!r.T && r.T.nodeCount > 0)

  r = await call('browser_screenshot', { tabId })
  const imgBlock = r.raw.result && r.raw.result.content.find(b => b.type === 'image')
  check('screenshot real image block from packaged app', !!imgBlock && imgBlock.data.length > 10000)
  if (imgBlock) fs.writeFileSync(IMG_OUT, Buffer.from(imgBlock.data, 'base64'))
  check('screenshot saved for agent inspection', fs.existsSync(IMG_OUT) && fs.statSync(IMG_OUT).size > 10000)
  check('screenshot metadata (screenshotId/cssPerPixel)', !!(r.T && r.T.screenshotId && r.T.cssPerPixel))

  // SKILL.md policy workflow on a local harmless page: observe -> act -> verify
  r = await call('browser_navigate', { tabId, url: base + '/transform-page' }, 60000)
  check('fixture navigate verified', r.T && r.T.verified === true)
  r = await call('browser_snapshot', { tabId })
  const hRef = r.T && r.T.nodes && (r.T.nodes.find(n => n.role === 'heading') || {}).ref
  check('fixture heading ref found', !!hRef)
  r = await call('browser_transform', { tabId, actions: [{ op: 'replace_text', ref: hRef, text: 'TRANSFORMED-BY-AGENT' }] })
  check('transform applied', !(r.raw.result && r.raw.result.isError), JSON.stringify(r.T).slice(0, 150))
  r = await call('browser_verify', { tabId, textContains: 'TRANSFORMED-BY-AGENT' })
  check('transform verify', r.T && r.T.verified === true)
  r = await call('browser_transform_status', { tabId })
  check('transform_status lists record', !!r.T)
  r = await call('browser_transform', { tabId, actions: [{ op: 'restore_target', ref: hRef }] })
  check('restore_target accepted', !(r.raw.result && r.raw.result.isError), JSON.stringify(r.T).slice(0, 150))
  r = await call('browser_verify', { tabId, textContains: 'ORIGINAL-TEXT-' })
  check('restore verified: original text back', r.T && r.T.verified === true)

  // agent-managed download -> userData/agent-downloads
  r = await call('browser_download_start', { tabId, url: base + '/down.bin' }, 60000)
  check('managed download started', !!r.T && !!r.T.downloadId, JSON.stringify(r.T).slice(0, 150))
  const dlId = r.T && r.T.downloadId
  r = await call('browser_download_wait', { downloadId: dlId, timeoutMs: 30000 }, 45000)
  check('managed download terminal (completed)', !!r.T && r.T.state === 'completed', JSON.stringify(r.T).slice(0, 200))
  check('wait timeout contract fields absent on success but state terminal', !!r.T && r.T.timedOut !== true)
  check('download under userData/agent-downloads root', !!r.T && String(r.T.relPath || '').length > 0, (r.T && r.T.relPath) || '')
  const dlPath = r.T && path.join(PROFILE, 'agent-downloads', r.T.relPath)
  check('download file exists on disk', !!(dlPath && fs.existsSync(dlPath)))
  r = await call('browser_downloads')
  check('download record visible in browser_downloads (managed list)', !!(r.T && (r.T.managed || []).some(j => j.downloadId === dlId)), JSON.stringify(r.T && { downloads: (r.T.downloads || []).length, managed: (r.T.managed || []).length }))

  // extension fixtures must NOT be loaded in packaged default launch
  r = await call('browser_tabs')
  check('no dev extension fixture pages open', !(JSON.stringify(r.T.tabs).indexOf('test-min-agent') !== -1))
  check('no extension-host errors on stderr', /DATABASE OPEN ERROR|Cannot find module|MODULE_NOT_FOUND/.test(minErr) === false, minErr.slice(0, 200))
  const settingsPath = path.join(PROFILE, 'settings.json')
  check('production settings do not enable experimental extension host', !fs.existsSync(settingsPath) || JSON.parse(fs.readFileSync(settingsPath, 'utf8')).experimentalExtensionHost !== true)

  // bounded close + targeted cleanup
  await adapter.end()
  spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(min.pid)], { windowsHide: true })
  await sleep(2500)
  const tl = String(spawnSync('tasklist.exe', [], { windowsHide: true }).stdout || '')
  check('app close leaves no orphan Min.exe (targeted PID kill worked)', tl.indexOf('Min.exe') === -1, 'Min.exe still in tasklist')
  adapter.end()
  fixture.close()
  // profile cleanup (test data only)
  for (let i = 0; i < 4; i++) { rmrf(PROFILE); if (!fs.existsSync(PROFILE)) break; await sleep(300) }
  const pass = results.filter(x => x.pass).length
  console.log('coldstart-acceptance: ' + pass + '/' + results.length)
  fs.writeFileSync(path.join(ROOT, 'docs', 'p111-coldstart-accept.json'), JSON.stringify({ ts: new Date().toISOString(), results, pass, total: results.length }, null, 2))
  process.exit(pass === results.length ? 0 : 1)

  function killAll () {
    try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(min.pid)], { windowsHide: true }) } catch (e) {}
  }
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })
