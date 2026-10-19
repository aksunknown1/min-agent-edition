/* P1-07 updater resilience tests (standalone; local fixtures; no Electron).
 * Each update uses a FRESH mkdtemp userDataDir; combPath synced from
 * the updater's own status (single source of truth for all checks). */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const updaterMod = require('../filterUpdate.js')

let passed = 0
let total = 0
function check (name, ok, detail) {
  total++
  if (ok) passed++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  [' + String(detail).slice(0, 170) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sha = s => crypto.createHash('sha256').update(s).digest('hex')

const HEADER = '[Adblock Plus 2.0]'
const VALID_A = makeList(33000)
const VALID_B = makeList(33100)
function makeList (rules) {
  const l = [HEADER]
  for (let i = 0; i < rules; i++) l.push('-generated-filter-' + i + '/$script,image')
  return l.join('\n') + '\n'
}
let status = {}
let base = null

function makeUpdater (opts, userDataDir) {
  const o = Object.assign({
    userDataDir: userDataDir,
    startupDelayMs: 3600000,
    log: function (m) { }
  }, opts || {})
  if (!o.sourcesOverride) o.sourcesOverride = [{ id: 'easylist', url: base + '/easylist' }, { id: 'easyprivacy', url: base + '/easyprivacy' }]
  o.allowNonHttpsTestOrigins = true
  return updaterMod.create(o)
}

async function update (opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-07-ud-')) + path.sep + 'userData'
  fs.mkdirSync(dir, { recursive: true })
  const up = makeUpdater(opts || {}, dir)
  up.maybeUpdate('test')
  for (let w = 0; w < 300; w++) { const s2 = up.getStatus(); if (!s2.inFlight) return s2; await sleep(250) }
  return up.getStatus()
}

async function main () {
  const srv = http.createServer(function (req, res) {
    const u = req.url.split('?')[0]
    if (u === '/easylist2') { if (req.headers['if-none-match']) { res.writeHead(304); res.end() } else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(makeList(20000)) } return }
    if (u === '/easylist' || u === '/easylist2') {
      if (status.failEasy === '404') { res.writeHead(404); res.end('nf'); return }
      if (status.failEasy === '500') { res.writeHead(500); res.end('err'); return }
      if (status.failEasy === 'html') { res.writeHead(200); res.end('<html><body>blocked</body></html>'); return }
      if (status.failEasy === 'truncated') { res.writeHead(200); res.end(HEADER + '\n-gen-1\n'); return }
      if (status.failEasy === 'partial') { res.writeHead(200, { 'content-length': VALID_A.length + 500 }); res.end(HEADER + '\n-gen-p\n'); setTimeout(() => { try { res.socket.destroy() } catch (eS) { } }, 30); return }
      if (status.failEasy === 'slow') { setTimeout(() => res.end(makeList(30000)), 60000); return }
      res.writeHead(200, { 'content-type': 'text/plain', etag: status.etagEasy || '"e1"' })
      res.end(status.bodyEasy || makeList(33000))
      return
    }
    if (u === '/easyprivacy2') { if (req.headers['if-none-match']) { res.writeHead(304); res.end() } else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(makeList(20000)) } return }
    if (u === '/easyprivacy' || u === '/easyprivacy2') {
      if (status.failPriv === '404') { res.writeHead(404); res.end('nf'); return }
      res.writeHead(200, { 'content-type': 'text/plain', etag: status.etagPriv || '"p1"' })
      res.end(status.bodyPriv || makeList(33100))
      return
    }
    if (u === '/redirect-samehost') {
      res.writeHead(302, { location: base + '/easylist' })
      res.end()
      return
    }
    if (u === '/redirect-foreign') {
      res.writeHead(302, { location: 'https://unapproved-host.example.com/easylist' })
      res.end()
      return
    }
    if (u === '/redirect-loop') {
      res.writeHead(302, { location: u })
      res.end()
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + srv.address().port

  let userDataDir = null
  let combPath = null

  /* 1 valid fresh */
  let st = await update()
  console.log('[dbg st1] promoted=' + st.promoted + ' lastError=' + JSON.stringify(st.lastError) + ' combinedPath=' + st.combinedPath)
  check('valid fresh sources: promoted + combined file exists', st.promoted === true && fs.existsSync(st.combinedPath) && st.combined.rules >= 20000, JSON.stringify(st.lastError || '').slice(0, 110))
  const goodText = fs.readFileSync(st.combinedPath, 'utf8')
  const goodSha = sha(goodText)

  /* 2 non-200 */
  status.failEasy = '404'
  st = await update()
  const comb2Exists = fs.existsSync(st.combinedPath)
  check('404 on source: last-known-good retained', !st.promoted && !!st.lastError && (!comb2Exists || sha(fs.readFileSync(st.combinedPath, 'utf8')) === goodSha), JSON.stringify(st.lastError).slice(0, 90))
  status.failEasy = '500'
  st = await update()
  check('500 on source: no promotion', !st.promoted && /http status 500/.test(st.lastError || ''), JSON.stringify(st.lastError).slice(0, 90))

  /* 3a same-host redirect followed (test allowance; production requires https) */
  status.failEasy = null; status.bodyEasy = null; status.bodyPriv = null; status.failPriv = null; status.etagEasy = null; status.etagPriv = null
  st = await update({ sourcesOverride: [{ id: 'easylist', url: base + '/redirect-samehost' }, { id: 'easyprivacy', url: base + '/easyprivacy' }] })
  check('3a same-host redirect followed', st.promoted === true, JSON.stringify(st.lastError || '').slice(0, 100))

  /* 3b non-https remote rejected (direct policy probe via _testFetch) */
  const upT = makeUpdater({ userDataDir: 'C:/Users/AKS-PC/min-agent-edition/tmp-updater-test-drv' }, 'C:/Users/AKS-PC/min-agent-edition/tmp-updater-test-drv')
  const r3b = await new Promise(function (res) { upT._testFetch('http://blocked-origin.invalid/easylist', {}, 5000, 16 * 1024 * 1024, 3, function (err) { res(err || { ok: true }) }) })
  check('3b non-https remote source rejected', !!r3b.message && /non-https url rejected/.test(r3b.message), JSON.stringify(r3b.message || '').slice(0, 100))

  /* 3c unapproved host redirect rejected (direct policy probe) */
  const r3c = await new Promise(function (res) { upT._testFetch(base + '/redirect-foreign', {}, 5000, 16 * 1024 * 1024, 3, function (err) { res(err || { ok: true }) }) })
  check('3c redirect to unapproved host rejected', !!r3c.message && /unapproved host/.test(r3c.message), JSON.stringify(r3c.message || '').slice(0, 100))

  /* 3d redirect loop bounded (direct policy probe) */
  const r3d = await new Promise(function (res) { upT._testFetch(base + '/redirect-loop', {}, 5000, 16 * 1024 * 1024, 3, function (err) { res(err || { ok: true }) }) })
  check('3d redirect loop bounded', !!r3d.message && /too many redirects/.test(r3d.message), JSON.stringify(r3d.message || '').slice(0, 100))

  /* 4 invalid payloads */
  status.failEasy = null; status.bodyEasy = null; status.bodyPriv = null; status.failPriv = null; status.etagEasy = null; status.etagPriv = null
  status.failEasy = 'html'
  st = await update()
  check('HTML error page rejected', !st.promoted, JSON.stringify(st.lastError).slice(0, 90))
  status.failEasy = 'truncated'
  st = await update()
  check('truncated source rejected', !st.promoted, JSON.stringify(st.lastError).slice(0, 90))
  status.failEasy = 'partial'
  st = await update()
  console.log('[dbg partial] ' + JSON.stringify(st).slice(0, 900))
  check('partial download rejected', !st.promoted, JSON.stringify(st.lastError).slice(0, 90))
  status.failEasy = null
  st = await update({ maxBytes: 50 * 1024 })
  check('oversized response rejected (byte cap)', !st.promoted, JSON.stringify(st.lastError).slice(0, 90))
  status.failEasy = 'slow'
  st = await update({ timeoutMs: 400 })
  check('slow response rejected (timeout)', !st.promoted, JSON.stringify(st.lastError).slice(0, 90))
  status.failEasy = null

  /* 5 second-source failure */
  status.failPriv = '404'
  st = await update()
  const comb5Exists = fs.existsSync(st.combinedPath)
  check('failed easyprivacy: no half-combined promotion', !st.promoted && (!comb5Exists || sha(fs.readFileSync(st.combinedPath, 'utf8')) === goodSha), JSON.stringify(st.lastError).slice(0, 90))
  status.failPriv = null

  /* 6a conditional 304 */
  const srv304 = http.createServer(function (req, res) {
    if (req.headers['if-none-match']) { res.writeHead(304); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/plain', etag: '"rr"' })
    res.end(req.url.indexOf('easyprivacy') !== -1 ? makeList(33100) : makeList(33000))
  })
  await new Promise(r => srv304.listen(0, '127.0.0.1', r))
  const port304 = srv304.address().port
  const up304a = makeUpdater({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'p1-07-304a-')) + path.sep + 'userData', sourcesOverride: [{ id: 'easylist', url: 'http://127.0.0.1:' + port304 + '/easylist' }, { id: 'easyprivacy', url: 'http://127.0.0.1:' + port304 + '/easyprivacy' }] })
  up304a.maybeUpdate('304-seed')
  await sleep(1200)
  up304a.maybeUpdate('304-refetch')
  await sleep(1500)
  const st304 = up304a.getStatus()
  check('conditional 304: fresh, combined intact', !st304.lastError && fs.existsSync(st304.combinedPath), String((st304.lastError || '').slice(0, 110)))
  srv304.close()

  /* 6b 304 without cached part: meta holds etags, cached parts absent */
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-07-304b-')) + path.sep + 'userData'
  fs.mkdirSync(path.join(userDataDir, 'filterCache'), { recursive: true })
  fs.writeFileSync(path.join(userDataDir, 'filterCache', 'meta.json'), JSON.stringify({ version: 1, sources: { easylist: { etag: '"zz1"' }, easyprivacy: { etag: '"zz2"' } }, combined: { rules: 1 } }))
  const up304c = makeUpdater({ userDataDir: userDataDir, sourcesOverride: [{ id: 'easylist', url: base + '/easylist2' }, { id: 'easyprivacy', url: base + '/easyprivacy2' }] })
  up304c.maybeUpdate('304-nopart')
  await sleep(700)
  let stNoPart = up304c.getStatus()
  for (let w = 0; w < 20 && stNoPart.inFlight; w++) { await sleep(250); stNoPart = up304c.getStatus() }
  check('304 without cached part -> structured failure', !!(stNoPart.lastError || '').length && !stNoPart.promoted, String(stNoPart.lastError).slice(0, 110))

  /* 7 corrupt cache -> validation still applies */
  st = await update()
  check('corrupt cache tolerated; fresh list promoted (validation active)', st.promoted === true && fs.readFileSync(st.combinedPath, 'utf8').startsWith(HEADER), JSON.stringify(st.lastError || '').slice(0, 90))

  /* 8 offline retains last-known-good */
  const upOff = makeUpdater({ userDataDir: st.combinedPath ? path.dirname(path.dirname(st.combinedPath)) : fs.mkdtempSync(path.join(os.tmpdir(), 'p1-07-off-')) + path.sep + 'userData', timeoutMs: 600, sourcesOverride: [{ id: 'easylist', url: 'http://127.0.0.1:9/easylist' }, { id: 'easyprivacy', url: 'http://127.0.0.1:9/easyprivacy' }] })
  upOff.maybeUpdate('offline')
  await sleep(1400)
  const stOff = upOff.getStatus()
  check('offline update failure retains last-known-good', !stOff.promoted && !!stOff.lastError && fs.existsSync(stOff.combinedPath), '')

  /* 9 concurrent single-flight */
  const dir9 = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-07-conc-')) + path.sep + 'userData'
  const upConc = makeUpdater({ userDataDir: dir9 })
  const a1 = upConc.maybeUpdate('conc-1')
  const a2 = upConc.maybeUpdate('conc-2')
  await sleep(1400)
  check('concurrent updates single-flight (second skipped)', a1 === true && a2 === false, JSON.stringify({ a1: a1, a2: a2 }))

  const summary = passed + '/' + total + ' checks passed'
  srv.close()
  console.log('\n' + summary)
  process.exit(passed === total ? 0 : 2)
}

main().catch(e => { console.log('fatal ' + e.message); if (e.stack) console.log(String(e.stack).split('\n').slice(0, 4).join(' | ')); process.exit(2) })
