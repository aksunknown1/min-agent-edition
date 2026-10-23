/* P1-04.2 transform probe (corrected): package.json probe:transform target.
 *
 * History reconciliation: two earlier intermediate probe scripts reported
 * 11/16 and 13/20; both were non-runnable on the current build (missing
 * fixture constant, no Min launch, undefined variables — the script that
 * package.json pointed at crashed with "PAGE is not defined" before doing
 * anything). This corrected version reuses the proven launch flow verified in
 * scripts/p1-04-transformdiag.js. Assertions are held strict — nothing is
 * skipped or weakened to manufacture a pass.
 *
 * 18 checks: 2 boot + 16 transform-engine/lifecycle checks, CSS-selector
 * targeting for apply cases, one genuine-snapshot ref for the stale-ref case.
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-transform-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const DISC = PROFILE + '-development/agent-rpc.json'
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-transform-probe.json')
const bin = require('electron')
const fileUrl = 'file:///' + path.join(RUN_DIR, 'tf.html').replace(/\\/g, '/')

const PAGE = [
  '<!doctype html><html><head><title>T Page</title></head><body>',
  '<h1 id="h1">Page Heading</h1>',
  '<p id="p1">Original paragraph one</p>',
  '<p id="p2">Original paragraph two</p>',
  /* R1 regression: a paragraph LONGER than the 1200-char transform text cap.
   * Restoring a replace_text on this element must be faithful, not truncated. */
  '<p id="plong">' + ('LONGTEXT-' + 'x'.repeat(3000)) + '</p>',
  '<div id="clutter">Clutter block for highlight</div>',
  '<div id="shadowhost"></div>',
  '<button id="btn" onclick="document.getElementById(\'p1\').textContent=\'JS-MUTATED-TEXT\'">JS Button</button>',
  '<script>document.getElementById(\'shadowhost\').attachShadow({ mode: \'open\' }).innerHTML = \'<p id="shp">Shadow Original Text</p>\'</script>',
  '</body></html>'
].join('\n')

const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', fileUrl],
  { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

const sleep = ms => new Promise(r => setTimeout(r, ms))
function rpcOnce (method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const disc = JSON.parse(fs.readFileSync(DISC, 'utf8'))
  const u = new URL(disc.url)
  return new Promise(res => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + disc.token }, timeout: 30000 },
      r2 => { let b = ''; r2.on('data', c => { b += c }); r2.on('end', () => res(b)) })
    req.on('error', e => res('ERR ' + e.message))
    req.on('timeout', () => { req.destroy(); res('ERR timeout') })
    req.end(body)
  })
}
/* Bounded retry ONLY for documented transient conditions: 429 busy (-32007)
 * rate-limit backoff and unparseable transport failures. Never retries a
 * structured business error — those surfaces are returned as-is. */
async function rpc (method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = await rpcOnce(method, params)
    let frame = null
    try { frame = JSON.parse(raw) } catch (e) { /* transport retry */ }
    if (frame && frame.error && frame.error.code === -32007) { await sleep(2500); continue }
    if (frame) return frame
    await sleep(800)
  }
  return { error: { code: -1, category: 'no_response', message: 'unparseable or failed after bounded retries' } }
}

let tabId = null
const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail).slice(0, 300) })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail).slice(0, 220) + ']'))
}
async function T (actions) {
  await sleep(1200)
  const f = await rpc('browser_transform', { tabId, actions: JSON.stringify(actions) })
  return f
}
async function ST () {
  await sleep(900)
  return await rpc('browser_transform_status', { tabId })
}
async function vText (txt) {
  await sleep(900)
  const f = await rpc('browser_verify', { tabId, textContains: txt })
  return !!(f.result && f.result.verified === true)
}
async function nav (url) {
  await sleep(1200)
  const f = await rpc('browser_navigate', { tabId, url, stabilityWindowMs: 500 })
  await sleep(2500)
  return f
}

;(async () => {
  fs.mkdirSync(RUN_DIR, { recursive: true })
  fs.writeFileSync(path.join(RUN_DIR, 'tf.html'), PAGE, 'utf8')
  for (let i = 0; i < 250; i++) { try { JSON.parse(fs.readFileSync(DISC, 'utf8')); break } catch (e) { await sleep(400) } }
  await sleep(2500)

  const tabsFrame = await rpc('browser_tabs', {})
  const tabs = tabsFrame.result && tabsFrame.result.tabs
  check('boot. bridge ready (browser_tabs resolves)', !!Array.isArray(tabs) && tabs.length >= 1, JSON.stringify(tabsFrame.error || 'no tabs').slice(0, 200))
  if (!tabs) throw new Error('bridge not ready: ' + JSON.stringify(tabsFrame).slice(0, 200))
  tabId = (tabs.find(t => t.active) || tabs[0]).tabId
  check('boot. fixture loaded (Page Heading verified)', await vText('Page Heading'))

  /* 1-4 replace_text lifecycle */
  const r1 = await T([{ op: 'replace_text', selector: '#p1', text: 'TRANSFORMED-XYZ' }])
  check('1. replace_text applied (ok, applied=1)', !!(r1.result && r1.result.ok === true && r1.result.applied === 1) && await vText('TRANSFORMED-XYZ'), JSON.stringify(r1.result || r1.error).slice(0, 200))
  check('2. original text no longer rendered', !(await vText('Original paragraph one')))
  const r3 = await T([{ op: 'restore_target', selector: '#p1' }])
  check('3. restore_target brings original back', !!(r3.result && r3.result.ok === true) && await vText('Original paragraph one'), JSON.stringify(r3.result || r3.error).slice(0, 200))
  check('4. transformed text gone after restore', !(await vText('TRANSFORMED-XYZ')))

  /* 5-6 batch apply + restore_all */
  const rb = await T([
    { op: 'replace_text', selector: '#p1', text: 'BATCH-A-TEXT' },
    { op: 'replace_text', selector: '#p2', text: 'BATCH-B-TEXT' }
  ])
  check('5. batch apply: both targets verified', !!(rb.result && rb.result.ok === true && rb.result.applied === 2) && await vText('BATCH-A-TEXT') && await vText('BATCH-B-TEXT'), JSON.stringify(rb.result || rb.error).slice(0, 220))
  const ra = await T([{ op: 'restore_all' }])
  check('6. restore_all restores the batch', !!(ra.result && ra.result.ok === true) && await vText('Original paragraph one') && await vText('Original paragraph two'), JSON.stringify(ra.result || ra.error).slice(0, 200))

  /* 7 highlight → status active, restore clears */
  await T([{ op: 'highlight', selector: '#clutter' }])
  const stH = await ST()
  const hiActive = !!(stH.result && typeof stH.result.active === 'number' && stH.result.active >= 1)
  await T([{ op: 'restore_target', selector: '#clutter' }])
  const stH2 = await ST()
  check('7. highlight recorded in status then restore clears it', hiActive && !!(stH2.result && stH2.result.active === 0), JSON.stringify({ st1: stH.result && stH.result.active, st2: stH2.result && stH2.result.active }))

  /* 8-9 style allowlist + unsafe value */
  const okS = await T([{ op: 'set_style', selector: '#p1', style: { fontSize: '20px' } }])
  check('8. allowlisted set_style accepted', !!(okS.result && okS.result.ok === true) && !okS.error, JSON.stringify(okS.result || okS.error).slice(0, 200))
  const bad = await T([{ op: 'set_style', selector: '#p1', style: { backgroundColor: 'url(http://x/y.png)' } }])
  check('9. unsafe url() style value rejected', !!(bad.error && bad.error.category === 'invalid_params'), JSON.stringify(bad.error || bad.result).slice(0, 200))
  await T([{ op: 'restore_target', selector: '#p1' }])

  /* 10 hide → innerText excludes target → restore brings it back */
  await T([{ op: 'hide', selector: '#p2' }])
  const hiddenGone = !(await vText('Original paragraph two'))
  await T([{ op: 'restore_target', selector: '#p2' }])
  check('10. hide then restore target', hiddenGone && await vText('Original paragraph two'), JSON.stringify({ hiddenGone }))

  /* 11 restore_all idempotent (no active records) */
  const ra2 = await T([{ op: 'restore_all' }])
  check('11. restore_all idempotent (structured result, ok)', !!(ra2.result && ra2.result.ok === true) && !ra2.error, JSON.stringify(ra2.result || ra2.error).slice(0, 200))

  /* 12-13 genuine navigation: clears active records + stale per-snapshot ref */
  await sleep(900)
  const snap = await rpc('browser_snapshot', { tabId, maxNodes: 100 })
  const nodes = (snap.result && snap.result.nodes) || []
  const btn = nodes.find(n => n.name === 'JS Button')
  await T([{ op: 'highlight', selector: '#p2' }]) /* make records ACTIVE before navigation */
  await nav('about:blank')
  const stNav = await ST()
  check('12. genuine navigation clears active transform records', !!(stNav.result && stNav.result.active === 0 && stNav.result.cleared === true), JSON.stringify(stNav.result || stNav.error).slice(0, 220))
  const staleF = btn
    ? await T([{ op: 'replace_text', ref: btn.ref, text: 'x' }])
    : { result: { ok: false, error: { category: 'snap_fail' } } }
  const staleR = staleF.result
  const staleErr = staleR && ((staleR.error && staleR.error.category === 'ref_stale') ||
    (Array.isArray(staleR.results) && staleR.results[0] && staleR.results[0].error && staleR.results[0].error.category === 'ref_stale'))
  check('13. stale snapshot ref → ok:false + category ref_stale', !!(staleR && staleR.ok === false && staleErr), JSON.stringify(staleR || staleF.error).slice(0, 220))

  /* 14 open shadow text visible in browser_content */
  await nav(fileUrl)
  const cf = await rpc('browser_content', { tabId, maxChars: 4000 })
  const cr = cf.result || {}
  const ctext = typeof cr.text === 'string' ? cr.text : (typeof cr.content === 'string' ? cr.content : JSON.stringify(cr))
  check('14. open shadow-root text present in browser_content', ctext.indexOf('Shadow Original Text') !== -1, JSON.stringify({ len: ctext.length }).slice(0, 120))

  /* 15 framework re-render → drift reported */
  await T([{ op: 'replace_text', selector: '#p1', text: 'PRE-DRIFT' }])
  const snap2 = await rpc('browser_snapshot', { tabId, maxNodes: 100 })
  const btn2 = ((snap2.result && snap2.result.nodes) || []).find(n => n.name === 'JS Button')
  if (btn2) { await rpc('browser_click', { tabId, ref: btn2.ref }); await sleep(2000) }
  const stD = await ST()
  check('15. framework re-render detected as drift', !!(stD.result && Array.isArray(stD.result.drift) && stD.result.drift.length >= 1), JSON.stringify(stD.result && { drift: stD.result.drift, active: stD.result.active }).slice(0, 220))

  /* 16 partial batch: per-target failure + valid target still applied */
  const pv = await T([
    { op: 'replace_text', selector: '#zzz-does-not-exist', text: 'nope' },
    { op: 'replace_text', selector: '#p1', text: 'VALID-AFTER-ALL' }
  ])
  const pr = pv.result
    /* R1: restoring a replace_text on a paragraph LONGER than the transform
     * text cap must be faithful. Regression for the 1200-char truncation of
     * the saved original text (previous behaviour restored only 1200 chars). */
    const LONG_LEN = ('LONGTEXT-' + 'x'.repeat(3000)).length
    const rLong = await T([{ op: 'replace_text', selector: '#plong', text: 'SHORT-REPLACEMENT' }])
    const longApplied = !!(rLong.result && rLong.result.ok === true)
    await T([{ op: 'restore_target', selector: '#plong' }])
    await sleep(400)
    /* Read the restored element through browser_content (already used above) so
     * this check does not depend on the eval result shape. */
    const longNow = await rpc('browser_content', { tabId, maxChars: 50000 })
    const longBody = String((longNow.result && (longNow.result.text || longNow.result.content)) || '')
    const longLen = longBody.indexOf('LONGTEXT-') !== -1 ? longBody.length : 0
    check('17. long-text restore is FAITHFUL (no 1200-char truncation)', longApplied && longLen >= LONG_LEN, JSON.stringify({ applied: longApplied, expected: LONG_LEN, actual: longLen }))

  check('16. per-target outcomes on mixed batch', !!(pr && pr.ok === false && Array.isArray(pr.results) && pr.results.length === 2 && pr.results[1].ok === true) && await vText('VALID-AFTER-ALL'), JSON.stringify(pr && { ok: pr.ok, steps: pr.results && pr.results.map(s => s.ok) }).slice(0, 200))
})().then(async () => {
  const passed = results.filter(r => r.pass).length
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true })
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ ranAt: new Date().toISOString(), script: 'scripts/agent-transform-probe.js', passed, total: results.length, results }, null, 2), 'utf8')
  console.log('\n' + passed + '/' + results.length + ' checks passed')
  try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)]) } catch (e) { /* ignore */ }
  process.exit(results.every(r => r.pass) ? 0 : 2)
}).catch(e => {
  console.log('fatal ' + e.message)
  try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)]) } catch (x) { /* ignore */ }
  process.exit(2)
})
