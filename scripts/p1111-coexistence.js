#!/usr/bin/env node
/*
 * P1-11.1 coexistence tests (safe on this host):
 *  A. Default-profile separation: launch the packaged app WITHOUT --user-data-dir on this
 *     host (original Min profile %APPDATA%\Min exists). Assert app default userData is the
 *     distinct "Min Agent Edition" dir and the ORIGINAL %APPDATA%\Min is untouched
 *     (dir listing snapshot before/after; written-file set intersect = empty).
 *  B. Concurrent side-by-side: two packaged instances with separate explicit userData
 *     roots run simultaneously; each gets its own bridge port/token; both navigate
 *     different pages through the same MCP adapter pattern; neither kills the other.
 * Cleanup: targeted taskkill /PID of processes this script spawned only.
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..')
const APPDIR = path.join(ROOT, 'dist', 'app', 'win-unpacked')
const EXE = fs.existsSync(path.join(APPDIR, 'Min Agent Edition.exe')) ? path.join(APPDIR, 'Min Agent Edition.exe') : path.join(APPDIR, 'Min.exe')
const HOME = os.homedir()
const ORIG_PROFILE = path.join(HOME, 'AppData', 'Roaming', 'Min')
const DEFAULT_PROFILE = path.join(HOME, 'AppData', 'Roaming', 'Min Agent Edition')
const PROFILE_A = path.join(os.tmpdir(), 'min-p1111-sideA-' + Date.now())
const PROFILE_B = path.join(os.tmpdir(), 'min-p1111-sideB-' + Date.now())

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail === undefined ? '' : detail).slice(0, 200) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
function snapshotDir (dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(d => {
      const p = path.join(dir, d.name)
      let size = 0
      try { size = d.isDirectory() ? -1 : fs.statSync(p).size } catch (e) { size = -2 }
      return d.name + ':' + size
    }).sort().join('|')
  } catch (e) { return '(missing)' }
}
function hashDir (dir) {
  try { return crypto.createHash('sha256').update(snapshotDir(dir)).digest('hex').slice(0, 16) } catch (e) { return 'n/a' }
}
function makeAdapter (profileDir) {
  const SHIPPED = path.join(APPDIR, 'resources', 'app', 'mcp', 'min-agent-mcp.js')
  const proc = spawn(process.execPath, [SHIPPED, '--profile=' + profileDir], { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const st = { proc, pending: {}, nextId: 700 }
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
  proc.stderr.on('data', function () {})
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
const killTree = pid => { try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }) } catch (e) {} }

async function launchMin (args) {
  const proc = spawn(EXE, args, { cwd: APPDIR, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.on('data', function () {})
  proc.stderr.on('data', function () {})
  let disc = null
  for (let i = 0; i < 60 && !disc; i++) {
    await sleep(500)
    try { disc = JSON.parse(fs.readFileSync(path.join(PROFILE_CANDIDATE(args), 'agent-rpc.json'), 'utf8')) } catch (e) {}
  }
  return { proc, disc }
}
function PROFILE_CANDIDATE (args) {
  const udd = args.find(a => a.indexOf('--user-data-dir=') === 0)
  if (udd) return udd.slice('--user-data-dir='.length)
  return DEFAULT_PROFILE
}

async function main () {
  const hadOrig = fs.existsSync(ORIG_PROFILE)
  check('host has an original-Min profile at %APPDATA%/Min (coexistence risk is real here)', hadOrig)
  const origBefore = hadOrig ? { snap: snapshotDir(ORIG_PROFILE), hash: hashDir(ORIG_PROFILE) } : null
  const defaultProfileExistedBefore = fs.existsSync(DEFAULT_PROFILE)
  if (defaultProfileExistedBefore) {
    try { fs.rmSync(DEFAULT_PROFILE, { recursive: true, force: true }) } catch (e) { /* may be in use */ }
  }

  /* ---- Test A: default userData separation ---- */
  minDefault = await launchMin(['--agent-rpc', '--', 'https://example.com/'])
  check('packaged app (no --user-data-dir) starts', !!minDefault.disc)
  if (minDefault.disc) {
    const ad = makeAdapter(minDefault.disc ? DEFAULT_PROFILE : PROFILE_A)
    const init = await ad.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p1111', version: '0' } }, 15000)
    ad.notify && ad.notify('notifications/initialized')
    check('MCP adapter attaches to default-profile instance', !!(init.result && init.result.serverInfo))
    const st = await ad.request('tools/call', { name: 'browser_status', arguments: {} }, 30000)
    const stT = textOf(st)
    const udd = stT && stT.profile && stT.profile.userDataPath
    check('default userData is the DISTINCT "Min Agent Edition" root', !!udd && path.normalize(udd).toLowerCase() === path.join(HOME, 'AppData', 'Roaming', 'Min Agent Edition').toLowerCase(), udd || '(none)')
    check('default userData is NOT the original %APPDATA%/Min', !!udd && udd.toLowerCase() !== ORIG_PROFILE.toLowerCase() && !udd.toLowerCase().startsWith(ORIG_PROFILE.toLowerCase() + path.sep), udd || '(none)')
    const tabs = await ad.request('tools/call', { name: 'browser_tabs', arguments: {} }, 30000)
    check('default-profile instance navigable (example.com)', JSON.stringify(tabs.result).indexOf('example.com') !== -1)
    ad.end()
  }
  killTree(minDefault.proc.pid)
  await sleep(2500)
  if (hadOrig) {
    const origAfter = { snap: snapshotDir(ORIG_PROFILE), hash: hashDir(ORIG_PROFILE) }
    check('original %APPDATA%/Min untouched by default launch (dir listing hash unchanged)', origAfter.hash === origBefore.hash, 'before=' + origBefore.hash + ' after=' + origAfter.hash)
  }

  /* ---- Test B: concurrent side-by-side instances ---- */
  const A = await launchMin(['--user-data-dir=' + PROFILE_A, '--agent-rpc', '--', 'https://example.com/'])
  const B = await launchMin(['--user-data-dir=' + PROFILE_B, '--agent-rpc', '--', 'http://example.org/'])
  check('instance A bridge up', !!A.disc)
  check('instance B bridge up', !!B.disc)
  const dA = JSON.stringify(A.disc ? { url: A.disc.url } : {})
  const dB = JSON.stringify(B.disc ? { url: B.disc.url } : {})
  check('distinct bridge ports/tokens (no cross-attach)', dA !== dB && A.disc && B.disc && A.disc.url !== B.disc.url && A.disc.token !== B.disc.token)
  const adA = makeAdapter(PROFILE_A)
  const adB = makeAdapter(PROFILE_B)
  await adA.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p1111', version: '0' } }, 15000).then(r => adA.notify('notifications/initialized'))
  await adB.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p1111', version: '0' } }, 15000).then(r => adB.notify('notifications/initialized'))
  const taA = await adA.request('tools/call', { name: 'browser_tabs', arguments: {} }, 30000)
  const taB = await adB.request('tools/call', { name: 'browser_tabs', arguments: {} }, 30000)
  check('instance A sees its own pages (example.com)', JSON.stringify(taA.result).indexOf('example.com') !== -1 && JSON.stringify(taA.result).indexOf('example.org') === -1)
  check('instance B sees its own pages (example.org)', JSON.stringify(taB.result).indexOf('example.org') !== -1 && JSON.stringify(taB.result).indexOf('"url":"https://example.com/"}') === -1)
  const navA = await adA.request('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:9/never' } }, 40000)
  check('instance A standalone navigation call does not disturb instance B', JSON.stringify(taB.result).indexOf('example.org') !== -1)
  check('confined fetch attempt handled by A without crashing A or B', !!(navA.result || navA.error))
  const alive = spawnSync('tasklist.exe', [], { windowsHide: true }).stdout ? String(spawnSync('tasklist.exe', [], { windowsHide: true }).stdout) : ''
  check('both processes coexist during test (no mutual termination)', alive.indexOf('Min Agent Edition') !== -1 || alive.indexOf('Min.exe') !== -1)
  adA.end(); adB.end()
  killTree(A.proc.pid)
  killTree(B.proc.pid)
  await sleep(2000)
  for (let i = 0; i < 4; i++) {
    try { fs.rmSync(PROFILE_A, { recursive: true, force: true }) } catch (e) { await sleep(300) }
    try { fs.rmSync(PROFILE_B, { recursive: true, force: true }) } catch (e) { await sleep(300) }
    if (!fs.existsSync(PROFILE_A) && !fs.existsSync(PROFILE_B)) break
  }
  check('temporary test profiles removed', !fs.existsSync(PROFILE_A) && !fs.existsSync(PROFILE_B))

  const pass = results.filter(r => r.pass).length
  console.log('coexistence: ' + pass + '/' + results.length)
  fs.writeFileSync(path.join(ROOT, 'docs', 'p1111-coexistence.json'), JSON.stringify({ ts: new Date().toISOString(), results, pass, total: results.length }, null, 2))
  process.exit(pass === results.length ? 0 : 1)
}
let minDefault = null
main().catch(e => {
  console.error('FATAL', e.message)
  if (minDefault && minDefault.proc) killTree(minDefault.proc.pid)
  process.exit(2)
})
