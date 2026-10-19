#!/usr/bin/env node
/*
 * P1-11 Phase 5: filtering + updater evidence from the PACKAGED app.
 * 1. fresh profile cold start on the P1-07 block-fixture page
 * 2. assert known-harmless request blocked via bundled list while a benign image loads
 * 3. wait > startupDelayMs (30s) for the runtime updater, then hash/size userData/filterCache
 * Cleanup is targeted (taskkill /PID this-spawn /T only).
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..')
const PACKAGED_MIN = (function () { const d = path.join(ROOT, 'dist', 'app', 'win-unpacked'); const n = fs.existsSync(path.join(d, 'Min Agent Edition.exe')) ? 'Min Agent Edition.exe' : 'Min.exe'; return path.join(d, n) })()
const PROFILE = path.join(os.tmpdir(), 'min-p111-filter-profile-' + Date.now())
const sleep = ms => new Promise(r => setTimeout(r, ms))

const PAGE = '<html><head><title>P111PackagedFilter</title></head><body>' +
  '<img id="ad1" src="https://doubleclick.example.net/pixel.js" width=1 height=1>' +
  '<img id="ok1" src="/benign-1x1.png" width=1 height=1>' +
  '<p id="r1">ad1:pending</p><p id="r3">ok1:pending</p>' +
  '<script>' +
  'document.getElementById("ad1").addEventListener("error",function(){document.getElementById("r1").textContent="ad1:ERROR(blocked)"},true);' +
  'document.getElementById("ad1").addEventListener("load",function(){document.getElementById("r1").textContent="ad1:LOADED"},true);' +
  'document.getElementById("ok1").addEventListener("load",function(){document.getElementById("r3").textContent="ok1:LOADED"},true);' +
  '</script></body></html>'

async function main () {
  let srvPort = 0
  const srv = http.createServer((req, res) => {
    if (req.url === '/benign-1x1.png') {
      const px = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d3e0000000049454e44ae426082', 'hex')
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': px.length }); res.end(px); return
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE)
  })
  await new Promise(r => { srv.listen(0, '127.0.0.1', () => { srvPort = srv.address().port; r() }) })
  const min = spawn(PACKAGED_MIN, ['--user-data-dir=' + PROFILE, '--agent-rpc', '--', 'http://127.0.0.1:' + srvPort + '/'], { cwd: path.dirname(PACKAGED_MIN), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  min.stdout.on('data', function () {})
  min.stderr.on('data', function () {})
  let disc = null
  for (let i = 0; i < 60 && !disc; i++) { await sleep(500); try { disc = JSON.parse(fs.readFileSync(path.join(PROFILE, 'agent-rpc.json'), 'utf8')) } catch (e) {} }
  if (!disc) { console.log('FAIL discovery'); spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(min.pid)], { windowsHide: true }); process.exit(2) }
  const u = new URL(disc.url)
  const rpc = (m, p) => new Promise(res => {
    const b = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p })
    const rq = http.request({ host: '127.0.0.1', port: u.port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), authorization: 'Bearer ' + disc.token } }, r2 => { let x = ''; r2.on('data', c => { x += c }); r2.on('end', () => { try { res(JSON.parse(x)) } catch (e) { res({}) } }) })
    rq.on('error', () => res({})); rq.end(b)
  })
  const tabs = (await rpc('browser_tabs', {})).result.tabs
  const tabId = (tabs.find(t => t.url.indexOf(String(srvPort)) !== -1) || tabs[0]).tabId
  await sleep(6000)
  const cF = await rpc('browser_content', { tabId })
  const c = ((cF.result || {}).text) || '[content unavailable]'
  const blocked = c.indexOf('ad1:ERROR(blocked)') !== -1
  const benignOk = c.indexOf('ok1:LOADED') !== -1
  console.log((blocked ? 'PASS' : 'FAIL') + '  known-harmless test image blocked (bundled list, packaged app)')
  console.log((benignOk ? 'PASS' : 'FAIL') + '  benign image loads (blocking scoped, not a full net kill)')
  // pre-update cache snapshot (bundled seed)
  const cacheDir = path.join(PROFILE, 'filterCache')
  const dump = dir => { try { return fs.readdirSync(dir).map(f => { const st = fs.statSync(path.join(dir, f)); const h = st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex').slice(0, 16) : '-'; return f + ' ' + st.size + 'B ' + h }) } catch (e) { return ['(absent)'] } }
  console.log('filterCache BEFORE startup update:', JSON.stringify(dump(cacheDir)))
  // wait past startupDelayMs (30s) for the packaged runtime updater (real HTTPS)
  console.log('waiting 45s for packaged runtime updater (startupDelayMs=30000)...')
  await sleep(45000)
  console.log('filterCache AFTER startup update:', JSON.stringify(dump(cacheDir)))
  // bundled fallback still shipped in the app
  const bundled = path.join(ROOT, 'dist', 'app', 'win-unpacked', 'resources', 'app', 'ext', 'filterLists')
  console.log('bundled lists in package:', fs.readdirSync(bundled).join(', '))
  const rules = (() => { try { const t = fs.readFileSync(path.join(bundled, 'easylist+easyprivacy-noelementhiding.txt'), 'utf8'); return t.split('\n').filter(l => l.trim() && l[0] !== '!').length } catch (e) { return -1 } })()
  console.log('bundled combined list non-comment rules: ' + rules)
  spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(min.pid)], { windowsHide: true })
  await sleep(2000)
  srv.close()
  for (let i = 0; i < 3; i++) { try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch (e) { await sleep(300) } }
  console.log('packaged-filter-test: ' + (blocked && benignOk ? 'PASS' : 'FAIL'))
  process.exit(blocked && benignOk ? 0 : 1)
}
main().catch(e => { console.error('FATAL', e.message); spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(require('child_process') && 0)], { windowsHide: true }); process.exit(2) })
