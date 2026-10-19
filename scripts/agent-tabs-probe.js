#!/usr/bin/env node
/*
 * P1-00 Stage A probe: tab management.
 *   open (plain)          -> attached:true, snapshot works
 *   open (url)            -> attached:true, tab content navigated
 *   open (background)     -> attached:false
 *   select                -> previously failing startup tab becomes usable
 *   close                 -> gone from browser_tabs, refs cleared
 *   close last tab        -> structured 409 last_tab error
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-tabs-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE + '-development'

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail).slice(0, 200) })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail).slice(0, 160) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rmrf = t => { try { fs.rmSync(t, { recursive: true, force: true }) } catch (e) { /* ignore */ } }

const PAGE_TARGET = '<!doctype html><html><head><title>Tab Target Page</title></head><body><button>Target Button</button><input type="text" value="x"></body></html>'
const PAGE_OTHER = '<!doctype html><html><head><title>Startup Tab (Other)</title></head><body><p>other content</p></body></html>'

const http = require('http')
let launcher = null
let adapter = null

function rpc (method, params, id) {
  return new Promise(function (resolve) {
    const discPath = path.join(EFFECTIVE_PROFILE, 'agent-rpc.json')
    let disc = null
    try { disc = JSON.parse(fs.readFileSync(discPath, 'utf8')) } catch (e) { return resolve({ status: 0, body: 'discovery missing' }) }
    const u = new URL(disc.url)
    const body = JSON.stringify(Object.assign({ jsonrpc: '2.0', id: id || 'p' }, params !== undefined ? { method, params } : { method }))
    const req = http.request({ host: '127.0.0.1', port: Number(u.port), path: '/rpc', method: 'POST',
      headers: { host: u.host, authorization: 'Bearer ' + disc.token, 'content-type': 'application/json' },
      headersTimeout: 8000, requestTimeout: 40000 }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', e => resolve({ status: 0, body: String(e) }))
    req.setTimeout(42000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }) })
    req.write(body)
    req.end()
  })
}
const resultOf = r => JSON.parse(r.body).result
const textOf = r => { try { return JSON.parse(resultOf(r).content[0].text) } catch (e) { return null } }

async function main () {
  try { spawnSync('taskkill.exe', ['/IM', 'electron.exe', '/F'], { windowsHide: true }) } catch (e) { /* ignore */ }
  await sleep(2000)
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'target.html'), PAGE_TARGET, 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'other.html'), PAGE_OTHER, 'utf8')
  const targetUrl = 'file:///' + path.join(RUN_DIR, 'target.html').replace(/\\/g, '/')
  const otherUrl = 'file:///' + path.join(RUN_DIR, 'other.html').replace(/\\/g, '/')

  /* the launcher starts Min with a single startup tab (the same startup-tab
   * shape that previously failed with view_not_attached). */
  launcher = spawn(process.execPath, [path.join(ROOT, 'scripts', 'min-launch.js'), '--profile=' + PROFILE, '--', otherUrl],
    { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let lOut = ''
  launcher.stdout.on('data', d => { lOut += d })
  let launcherLines = []
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    await sleep(500)
    launcherLines = lOut.split('\n').map(s => s.trim()).filter(Boolean)
    if (launcherLines.some(l => l === 'ready')) break
  }
  check('launcher reached ready with one startup tab', launcherLines.some(l => l === 'ready'), JSON.stringify(launcherLines))

  adapter = spawn(process.execPath, [path.join(ROOT, 'mcp', 'min-agent-mcp.js'), '--profile=' + PROFILE],
    { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let aBuf = ''
  const pending = {}
  let aNext = 10
  adapter.stdout.on('data', d => {
    aBuf += d
    let i
    while ((i = aBuf.indexOf('\n')) !== -1) {
      const frame = aBuf.slice(0, i).trim(); aBuf = aBuf.slice(i + 1)
      if (!frame) continue
      let msg = null
      try { msg = JSON.parse(frame) } catch (e) { continue }
      if (msg.id && pending[msg.id]) { const fn = pending[msg.id]; delete pending[msg.id]; fn(msg) }
    }
  })
  adapter.notify = function (method, params) {
    const frame = Object.assign({ jsonrpc: '2.0', method: method }, params ? { params: params } : {})
    adapter.stdin.write(JSON.stringify(frame) + '\n')
  }
  const acall = function (tool, args) {
    const id = 'a' + (++aNext)
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        if (pending[id]) { delete pending[id]; resolve({ result: { content: [{ type: 'text', text: '{"error":"client timeout"}' }], isError: true } }) }
      }, 45000)
      pending[id] = function (msg) { clearTimeout(timer); resolve(msg) }
      adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n')
    })
  }
  const textMcp = r => { try { return JSON.parse(r.result.content[0].text) } catch (e) { return null } }
  const errMcp = r => { try { return r.result.content[0].text } catch (e) { return '' } }

  await acall('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tabs-probe', version: '0' } })
  adapter.notify('notifications/initialized')

  /* discover the startup tab (other.html) */
  const tabs1 = textMcp(await acall('browser_tabs', {}))
  const startupTab = tabs1.tabs.find(t => t.url.indexOf('other.html') !== -1)
  check('startup tab enumerated via browser_tabs', !!startupTab)

  /* 1. open a plain tab -> attached + snapshot works */
  const open1 = textMcp(await acall('browser_tab_open', {}))
  check('tab_open (plain) returns tabId with attached:true', open1 && open1.tabId && open1.attached === true, JSON.stringify(open1))
  await sleep(1200) /* let the new tab page render */
  const snapNew = textMcp(await acall('browser_snapshot', { tabId: open1.tabId }))
  check('snapshot works on the newly opened tab', snapNew && typeof snapNew.nodeCount === 'number' && snapNew.truncated !== undefined, JSON.stringify(snapNew && snapNew.url))

  /* 2. open a tab with a URL -> attached, content loaded */
  const open2 = textMcp(await acall('browser_tab_open', { url: targetUrl }))
  check('tab_open (url) returns tabId attached', open2 && open2.tabId && open2.attached === true, JSON.stringify(open2))
  await sleep(2500) /* let the page load */
  const tabsNow = textMcp(await acall('browser_tabs', {}))
  const targetTab = tabsNow.tabs.find(t => t.url.indexOf('target.html') !== -1)
  check('target URL tab is open and loaded', !!targetTab && !targetTab.loading, targetTab && targetTab.url)
  const snapTarget = textMcp(await acall('browser_snapshot', { tabId: open2.tabId }))
  check('snapshot on the new URL tab finds content', snapTarget && snapTarget.nodes.some(n => n.name === 'Target Button'), JSON.stringify(snapTarget && snapTarget.url))

  /* 3. background tab -> attached:false */
  const open3 = textMcp(await acall('browser_tab_open', { url: otherUrl, background: true }))
  check('tab_open background -> attached:false', open3 && open3.attached === false && open3.background === true, JSON.stringify(open3))

  /* 4. select the startup tab -> previously view_not_attached, now usable */
  const sel = textMcp(await acall('browser_tab_select', { tabId: startupTab.tabId }))
  check('tab_select startup tab -> attached:true', sel && sel.attached === true, JSON.stringify(sel))
  await sleep(1200)
  const snapStartup = textMcp(await acall('browser_snapshot', { tabId: startupTab.tabId }))
  check('snapshot works on the previously failing startup tab after select', snapStartup && typeof snapStartup.nodeCount === 'number', JSON.stringify(snapStartup && snapStartup.url))

  /* 5. ID-based close semantics (P1-00A.1): close the three bridge-opened tabs
   * BY ID first, verifying ABSENCE BY ID after each close — never by position
   * (Min's own first-run tour/newtab pages share the inventory and must not be
   * misidentified). Then drain Min's own extra tabs the same ID-based way.
   * Policy: the last remaining tab is refused with a structured last_tab error. */
  await sleep(1100)
  const bridgeOpenedIds = [open1.tabId, open2.tabId, open3.tabId]
  let idGoneChecks = 0
  let idGonePass = 0
  let responsiveChecks = 0
  let responsivePass = 0
  /* 5a. close every bridge-opened tab BY ID, regardless of inventory order */
  for (const victimId of bridgeOpenedIds) {
    const victimInfo = (textMcp(await acall('browser_tabs', {})) || { tabs: [] }).tabs.find(t => t.tabId === victimId)
    if (!victimInfo) { /* already gone; count as absent */ idGoneChecks++; idGonePass++; continue }
    const c = textMcp(await acall('browser_tab_close', { tabId: victimId }))
    console.log('  closed bridge-opened ' + victimInfo.url.slice(0, 42) + ' (id=' + victimId + ') -> ' + (c && c.closed ? 'ok' : 'error'))
    await sleep(1100)
    const after = textMcp(await acall('browser_tabs', {}))
    if (!after) break
    idGoneChecks++
    if (!after.tabs.some(t => t.tabId === victimId)) idGonePass++
    else check('closed tab ' + victimId + ' absent from inventory', false, '')
    const stAfter = textMcp(await acall('browser_status', {}))
    responsiveChecks++
    if (stAfter && stAfter.bridge && typeof stAfter.bridge.grants.active === 'number') responsivePass++
  }
  /* 5b. drain Min's own extra tabs until exactly one remains (same ID-based discipline) */
  let remain = textMcp(await acall('browser_tabs', {}))
  let closedCount = 0
  while (remain && remain.tabs.length > 1 && closedCount < 8) {
    closedCount++
    const victim = remain.tabs[remain.tabs.length - 1]
    const victimId = victim.tabId
    const c = textMcp(await acall('browser_tab_close', { tabId: victimId }))
    console.log('  closed own-tab ' + victim.url.slice(0, 42) + ' (id=' + victimId + ') -> ' + (c && c.closed ? 'ok' : 'error'))
    await sleep(1100)
    remain = textMcp(await acall('browser_tabs', {}))
    if (!remain) break
    idGoneChecks++
    if (!remain.tabs.some(t => t.tabId === victimId)) idGonePass++
    else check('closed tab ' + victimId + ' absent from inventory', false, '')
    const stAfter = textMcp(await acall('browser_status', {}))
    responsiveChecks++
    if (stAfter && stAfter.bridge && typeof stAfter.bridge.grants.active === 'number') responsivePass++
  }
  check('each closed tab is absent from the inventory by its tabId', idGoneChecks > 0 && idGonePass === idGoneChecks, idGonePass + '/' + idGoneChecks)
  check('bridge responsive after each serial close', responsiveChecks > 0 && responsivePass === responsiveChecks, responsivePass + '/' + responsiveChecks)
  check('closing tabs reduces the visible tabs to exactly one', remain && remain.tabs.length === 1, remain && JSON.stringify(remain.tabs && remain.tabs.map(t => t.url.slice(0, 40))))
  const stEnd = textMcp(await acall('browser_status', {}))
  check('bridge healthy after serial closes', !!stEnd && !!stEnd.bridge && typeof stEnd.bridge.grants.active === 'number')

  /* 6. refuse closing the final remaining tab (structured 409 last_tab, no hang) */
  const lastTabId = remain.tabs[0].tabId
  const lastErr = await acall('browser_tab_close', { tabId: lastTabId })
  const lastText = errMcp(lastErr)
  check('closing the last tab -> structured last_tab error (refused, no hang)', lastErr.result && lastErr.result.isError === true && lastText.indexOf('last_tab') !== -1, lastText.slice(0, 160))
  const stillThere = textMcp(await acall('browser_tabs', {}))
  check('the last tab was NOT closed', stillThere && stillThere.tabs.length === 1 && stillThere.tabs[0].tabId === lastTabId)

  const end = results.every(r => r.pass) ? 0 : 2
  printSummary(end)
  return end
}
function printSummary (code) {
  /* dump bridge-side lifecycle diagnostics captured from the launcher output */
  try {
    const lines = (launcherOut || '').split('\n').filter(function (l) { return l.indexOf('[agent-rpc') !== -1 }).slice(-30)
    lines.forEach(function (l) { console.log('BRIDGE ' + l.trim().slice(0, 150)) })
  } catch (diagErr) { /* launcher maybe undefined */ }

  fs.writeFileSync(path.join(ROOT, 'docs', 'tabs-probe.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), passed: results.filter(r => r.pass).length, total: results.length, results }, null, 2), 'utf8')
  console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed')
}
process.on('exit', function () { try { rmrf(RUN_DIR) } catch (e) { /* ignore */ } })
main().then(function (end) {
  /* kill the launcher tree and exit with the probe verdict (Windows keeps the
   * child's stdio handles open, which would otherwise hold the loop alive) */
  try { if (launcher && launcher.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(launcher.pid)]) } catch (ignored) { /* ignore */ }
  process.exit(end || 0)
}).catch(function (e) {
  console.error('tabs probe error: ' + e.message)
  try { if (launcher && launcher.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(launcher.pid)]) } catch (ignored) { /* ignore */ }
  process.exit(2)
})
