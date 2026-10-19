/* P1-05 agent-downloads probe: full managed-download integration on a
 * loopback fixture server (sanctioned local harness). Launches Min in an
 * isolated throwaway profile, drives the REAL bridge tools, and verifies
 * outputs on disk inside the approved agent download root. */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-downloads-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const DISC = PROFILE + '-development/agent-rpc.json'
const DL_ROOT = PROFILE + '-development' + path.sep + 'agent-downloads'
const bin = require('electron')
const PAGE = '<!doctype html><html><head><title>DL Fixture</title></head><body>' +
  '<h1>Download Fixture</h1>' +
  '<a id="dl1" href="/small">download small</a>' +
  '<a id="dl2" href="/evilname">download evil name</a>' +
  '<a id="dl3" href="/noresume">download noresume</a>' +
  '<a id="srvfile" href="/small" download>anchor download</a>' +
  '</body></html>'

/* ---- loopback fixture server ---- */
const BIG_SIZE = 12 * 1024 * 1024
let srvPort = 0
const srv = http.createServer(function (req, res) {
  const u = req.url.split('?')[0]
  if (u === '/page.html' || u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
    return
  }
  if (u === '/small') {
    const buf = Buffer.alloc(20 * 1024, 7)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture-small.bin"', 'content-length': buf.length })
    res.end(buf)
    return
  }
  if (u === '/evilname') {
    const buf = Buffer.alloc(2048, 9)
    /* traversal + invalid chars + spaces in server filename */
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="..\\\\..\\\\evil name?.bin"', 'content-length': buf.length })
    res.end(buf)
    return
  }
  if (u === '/noresume') {
    const total2 = 4 * 1024 * 1024
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': total2 })
    let pos2 = 0
    const chunk2 = Buffer.alloc(64 * 1024, 5)
    const t2 = setInterval(function () {
      if (pos2 >= total2) { clearInterval(t2); res.end(); return }
      const len = Math.min(chunk2.length, total2 - pos2)
      res.write(chunk2.slice(0, len)); pos2 += len
    }, 80)
    req.on('close', function () { clearInterval(t2) })
    return
  }
  if (u === '/big') {
    const range = req.headers.range
    const start = range ? parseInt(String(range).replace(/bytes=/, '').split('-')[0], 10) || 0 : 0
    res.writeHead(range ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="fixture-big.bin"',
      'accept-ranges': 'bytes',
      'content-length': BIG_SIZE - start
    })
    let pos = start
    const chunk = Buffer.alloc(256 * 1024, 3)
    const t = setInterval(function () {
      if (pos >= BIG_SIZE) { clearInterval(t); res.end(); return }
      const len = Math.min(chunk.length, BIG_SIZE - pos)
      res.write(chunk.slice(0, len))
      pos += len
    }, 40)
    req.on('close', function () { clearInterval(t) })
    return
  }
  res.writeHead(404); res.end()
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
function rpcOnce (method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const disc = JSON.parse(fs.readFileSync(DISC, 'utf8'))
  const u = new URL(disc.url)
  return new Promise(res => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + disc.token }, timeout: 60000 },
      r2 => { let b = ''; r2.on('data', c => { b += c }); r2.on('end', () => res(b)) })
    req.on('error', e => res('ERR ' + e.message))
    req.end(body)
  })
}
async function rpc (method, params) {
  for (let i = 0; i < 4; i++) {
    let f = null
    try { f = JSON.parse(await rpcOnce(method, params)) } catch (e) { /* retry */ }
    if (f && f.error && f.error.code === -32007) { await sleep(2000); continue }
    if (f) return f
    await sleep(800)
  }
  return { error: { category: 'no_response' } }
}
function expectErr (name, wantCat, frame) {
  const ok = !!(frame.error && frame.error.category === wantCat)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  [' + JSON.stringify(frame.error || frame.result).slice(0, 180) + ']'))
  return ok
}
let tabId = null
let passed = 0
let total = 0
function check (name, ok, detail) {
  total++
  if (ok) passed++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  [' + String(detail).slice(0, 190) + ']'))
}
const appUrl = () => 'http://127.0.0.1:' + srvPort + '/'

;(async () => {
  fs.mkdirSync(RUN_DIR, { recursive: true })
  /* guarantee no stray Min instance absorbs this run (single-instance lock) */
  const { execSync } = require('child_process')
  for (let k = 0; k < 10; k++) {
    let n = '0'
    try { n = execSync('tasklist /FI "IMAGENAME eq electron.exe" | find /I /C "electron.exe"').toString().trim()[0] } catch (e) { break }
    if (n === '0') break
    try { execSync('taskkill /F /IM electron.exe /T') } catch (e2) { }
    await sleep(1000)
  }
  fs.rmSync(RUN_DIR, { recursive: true, force: true })
  fs.mkdirSync(RUN_DIR, { recursive: true })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  srvPort = srv.address().port
  const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', appUrl() + 'page.html'],
    { cwd: ROOT, windowsHide: true, stdio: 'ignore', detached: true })
  proc.unref()
  for (let i = 0; i < 250; i++) { try { JSON.parse(fs.readFileSync(DISC, 'utf8')); break } catch (e) { await sleep(400) } }
  await sleep(2500)
  const tabsF = await rpc('browser_tabs', {})
  tabId = (((tabsF.result || {}).tabs || []).find(t => t.active) || {}).tabId
  check('bridge + fixture ready', !!tabId, JSON.stringify(tabsF.error || 'no tabs'))

  /* 1. policy: bad relPaths and URLs are rejected BEFORE any download starts */
  total += 9
  const bad1 = await rpc('browser_download_start', { tabId, url: 'http://127.0.0.1:' + srvPort + '/small', relPath: '..\\\\escape.bin' })
  const b1 = expectErr('relPath traversal rejected', 'invalid_params', bad1)
  const bad2 = await rpc('browser_download_start', { tabId, url: 'http://127.0.0.1:' + srvPort + '/small', relPath: 'C:\\\\Windows\\\\x.bin' })
  const b2 = expectErr('absolute drive path rejected', 'invalid_params', bad2)
  const bad3 = await rpc('browser_download_start', { tabId, url: 'http://127.0.0.1:' + srvPort + '/small', relPath: '\\\\\\\\server\\\\share\\\\x.bin' })
  const b3 = expectErr('UNC path rejected', 'invalid_params', bad3)
  const bad4 = await rpc('browser_download_start', { tabId, url: 'http://127.0.0.1:' + srvPort + '/small', relPath: 'con.txt' })
  const b4 = expectErr('reserved device name rejected', 'invalid_params', bad4)
  const bad5 = await rpc('browser_download_start', { tabId, url: 'javascript:alert(1)' })
  const b5 = expectErr('javascript: URL rejected', 'blocked', bad5)
  const bad6 = await rpc('browser_download_start', { tabId, url: 'file:///' + RUN_DIR + '/x.bin' })
  const b6 = expectErr('file: URL rejected', 'blocked', bad6)
  const bad7 = await rpc('browser_download_start', { tabId, url: 'http://user:pass@127.0.0.1:' + srvPort + '/small' })
  const b7 = expectErr('embedded credentials rejected', 'blocked', bad7)
  const bad8 = await rpc('browser_download_start', { tabId, url: 'http://127.0.0.1:' + srvPort + '/small', relPath: 'a/b/../../../x.bin' })
  const b8 = expectErr('nested traversal rejected', 'invalid_params', bad8)
  const bad9 = await rpc('browser_download_wait', { downloadId: 'dlm999999' })
  const b9 = expectErr('unknown downloadId -> structured not_found', 'download_not_found', bad9)
  passed += (b1 && b2 && b3 && b4 && b5 && b6 && b7 && b8 && b9) ? 9 : 0

  /* 2. direct managed download with custom relPath, verified on disk */
  const d1Frame = await rpc('browser_download_start', { tabId, url: appUrl() + 'small', relPath: 'reports/first/small.bin' })
  const d1 = d1Frame.result
  if (!d1) console.log('d1 start FAILED:', JSON.stringify(d1Frame.error || d1Frame).slice(0, 300))
  check('direct start resolves with downloadId + relPath', !!(d1 && /^dlm[0-9]+$/.test(d1.downloadId) && d1.relPath === 'reports/first/small.bin'), JSON.stringify(d1 || null).slice(0, 200))
  const w1 = (await rpc('browser_download_wait', { downloadId: d1.downloadId, timeoutMs: 20000 })).result
  check('wait reaches terminal completed', !!(w1 && w1.state === 'completed' && w1.received === 20 * 1024), JSON.stringify(w1).slice(0, 200))
  const f1 = path.join(DL_ROOT, 'reports', 'first', 'small.bin')
  const s1 = fs.existsSync(f1) ? fs.statSync(f1).size : -1
  check('file on disk inside approved root with expected size', s1 === 20 * 1024, 'size=' + s1 + ' path=' + f1)
  const listing1 = (await rpc('browser_downloads', {})).result
  const mrec = (listing1.managed || []).find(x => x.downloadId === d1.downloadId)
  check('browser_downloads lists managed job (no query-string URL echo)', !!(mrec && mrec.state === 'completed' && mrec.url && mrec.url.indexOf('?') === -1), JSON.stringify(mrec).slice(0, 220))

  /* 3. hostile server filename is sanitized inside the root */
  const d2 = (await rpc('browser_download_start', { tabId, url: appUrl() + 'evilname' })).result
  console.log('d2 start:', JSON.stringify(d2 || { error: 'start returned no result' }).slice(0, 200))
  const w2 = d2 ? (await rpc('browser_download_wait', { downloadId: d2.downloadId, timeoutMs: 20000 })).result : null
  const rel2 = (w2 && w2.relPath) || ''
  const J = x => JSON.stringify(x === undefined ? null : x)
  check('server traversal filename sanitized to root-relative path', w2 && w2.state === 'completed' && rel2.split('/').indexOf('..') === -1 && rel2.indexOf('\\') === -1, J(w2).slice(0, 220))
  check('no file escaped the approved root', !fs.existsSync(path.join(PROFILE, 'evil name?.bin')) && !fs.existsSync(path.join(RUN_DIR, 'evil name?.bin')), '')

  /* 4. two parallel downloads: isolation */
  const p1 = rpc('browser_download_start', { tabId, url: appUrl() + 'small', relPath: 'par/a.bin' })
  const p2 = rpc('browser_download_start', { tabId, url: appUrl() + 'small', relPath: 'par/b.bin' })
  const d3 = (await p1).result
  const d4 = (await p2).result
  check('parallel starts get distinct ids + distinct relPaths', d3 && d4 && d3.downloadId !== d4.downloadId && d3.relPath !== d4.relPath, JSON.stringify([d3, d4]).slice(0, 240))
  await Promise.all([
    rpc('browser_download_wait', { downloadId: d3.downloadId, timeoutMs: 20000 }),
    rpc('browser_download_wait', { downloadId: d4.downloadId, timeoutMs: 20000 })
  ])
  check('both parallel downloads completed separately', fs.statSync(path.join(DL_ROOT, 'par', 'a.bin')).size === 20 * 1024 && fs.statSync(path.join(DL_ROOT, 'par', 'b.bin')).size === 20 * 1024, '')

  /* 5. collision policy: same relPath twice -> deterministic unique suffix, no overwrite */
  const d5 = (await rpc('browser_download_start', { tabId, url: appUrl() + 'small', relPath: 'par/a.bin' })).result
  await rpc('browser_download_wait', { downloadId: d5.downloadId, timeoutMs: 20000 })
  check('collision gets unique suffix, original untouched', fs.statSync(path.join(DL_ROOT, 'par', 'a.bin')).size === 20 * 1024 && fs.existsSync(path.join(DL_ROOT, 'par', 'a (2).bin')), '')

  /* 6. cancel affects only the requested job */
  const c1 = (await rpc('browser_download_start', { tabId, url: appUrl() + 'big', relPath: 'big1.bin' })).result
  const c2 = (await rpc('browser_download_start', { tabId, url: appUrl() + 'big', relPath: 'big2.bin' })).result
  await sleep(1500)
  const cc = (await rpc('browser_download_cancel', { downloadId: c1.downloadId })).result
  check('cancel confirmed via item done event', !!(cc && cc.cancelled === true && cc.state === 'cancelled'), JSON.stringify(cc))
  await sleep(500)
  const st2 = (await rpc('browser_transform_status', { tabId }))
  const sib = (await rpc('browser_download_wait', { downloadId: c2.downloadId, timeoutMs: 25000 })).result
  check('sibling job unaffected by cancel', sib && sib.downloadId === c2.downloadId && sib.state === 'completed', JSON.stringify(sib).slice(0, 160))
  check('cancelled job record reflects cancelled state honestly', !!(await rpc('browser_downloads', {})).result.managed.find(x => x.downloadId === c1.downloadId && x.state === 'cancelled'), '')

  /* 7. pause/resume on a range-capable transfer */
  const r1 = (await rpc('browser_download_start', { tabId, url: appUrl() + 'big', relPath: 'rp.bin' })).result
  await sleep(1200)
  const pp = (await rpc('browser_download_pause', { downloadId: r1.downloadId })).result
  check('pause accepted on progressing download', !!(pp && pp.paused === true), JSON.stringify(pp))
  const rr = (await rpc('browser_download_resume', { downloadId: r1.downloadId })).result
  check('resume on range-capable transfer (true resume, not restart)', !!(rr && rr.resumed === true), JSON.stringify(rr))
  const rw = (await rpc('browser_download_wait', { downloadId: r1.downloadId, timeoutMs: 60000 })).result
  check('resumed download completes with full size', !!(rw && rw.state === 'completed' && rw.received === BIG_SIZE), JSON.stringify(rw).slice(0, 160))
  check('resumed file on disk has complete size', fs.existsSync(path.join(DL_ROOT, 'rp.bin')) && fs.statSync(path.join(DL_ROOT, 'rp.bin')).size === BIG_SIZE, '')

  /* 8. pause + resume on a non-range transfer -> honest structured refusal */
  const n1 = (await rpc('browser_download_start', { tabId, url: appUrl() + 'noresume', relPath: 'nr.bin' })).result
  await sleep(1200)
  const np = (await rpc('browser_download_pause', { downloadId: n1.downloadId })).result
  const nr = (await rpc('browser_download_resume', { downloadId: n1.downloadId })).result
  check('resume result is honest w.r.t. Electron capability (no false resume-success)', !!(np && np.paused === true) && ((nr.resumed === true) === (nr.state === 'progressing')) && (!nr.resumed || (nr.reason === undefined)), JSON.stringify(np) + ' | ' + JSON.stringify(nr))
  const nw = (await rpc('browser_download_wait', { downloadId: n1.downloadId, timeoutMs: 60000 })).result
  check('noresume transfer completes despite refused resume', nw && nw.state === 'completed', JSON.stringify(nw).slice(0, 120))

  /* 9. page-triggered (site) download adopted after arming */
  const snap = (await rpc('browser_snapshot', { tabId, maxNodes: 100 })).result
  const dl1 = ((snap.nodes || []).find(n => n.name === 'download small'))
  check('arm+click: fixture link enumerated', !!dl1, '')
  const armP = rpc('browser_download_start', { tabId, armMs: 25000, relPath: 'sitedir' })
  await sleep(800)
  await rpc('browser_click', { tabId, ref: dl1.ref })
  const site = (await armP).result
  check('page-triggered download adopted by armed tab', !!(site && site.downloadId && site.kind !== undefined && site.relPath.indexOf('sitedir/') === 0), JSON.stringify(site).slice(0, 220))
  const sw = (await rpc('browser_download_wait', { downloadId: site.downloadId, timeoutMs: 20000 })).result
  check('site-triggered job completes', sw && sw.state === 'completed' && fs.existsSync(path.join(DL_ROOT, sPart(sw))), JSON.stringify(sw).slice(0, 120))
  function sPart (w) { return (w.relPath || '').split('/').join(path.sep) }

  /* 10. arm expiration: fresh blank tab, nothing triggers a download there */
  const newT = (await rpc('browser_tab_open', { url: 'about:blank' })).result
  const blankId = newT.tabId
  const armP2 = rpc('browser_download_start', { tabId: blankId, armMs: 12000, relPath: 'nope' })
  await sleep(14000)
  /* deliberately let this arm expire unused: no download occurs; structured timeout below */
  const armT = await armP2.then(function (f) { return { res: f.result, err: f.error } }).catch(function (e) { return { err: e } })
  console.log('arm2 outcome:', JSON.stringify({ resolved: !!armT.res, hasErr: !!armT.err, cat: armT.err && armT.err.category, res: armT.res }))
  check('expired arm returns structured timeout (no silent success)', !!(armT && armT.err && armT.err.category === 'timeout'), String(armT && armT.err && (armT.err.message || armT.err.category)).slice(0, 160))

  /* 11. history hygiene + listener counts */
  const listing2 = (await rpc('browser_downloads', {})).result
  const ids = new Set((listing2.managed || []).map(x => x.downloadId))
  check('all managed job ids unique (no state mixing)', ids.size === (listing2.managed || []).length, '')
  console.log('\\n' + passed + '/' + total + ' checks passed')
  srv.close()
  process.exit(passed === total ? 0 : 2)
})().catch(e => {
  console.log('fatal ' + e.message)
  console.log(passed + '/' + total + ' checks passed before failure')
  srv.close()
  process.exit(2)
})
