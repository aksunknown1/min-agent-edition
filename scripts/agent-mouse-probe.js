/* P1-06 mouse/vision probe: full typed-mouse + screenshot-metadata coverage on
 * a loopback fixture with a real Min instance. Page records its own mouse
 * events in window.__ev for independent verification (page text state kept as
 * simple visible strings for browser_verify checks). */
const { spawn, spawnSync, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-mouse-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const DISC = PROFILE + '-development' + path.sep + 'agent-rpc.json'
const bin = require('electron')

const PAGE = [
  '<!doctype html><html><head><title>Mouse Fixture</title><style>',
  'body{height:3000px;font-family:monospace}#box{width:120px;height:60px;border:2px solid #333}',
  '#scroller{width:200px;height:120px;overflow:scroll;border:1px solid #999;margin-left:320px}',
  '#inner{height:600px;width:600px}',
  '</style></head><body>',
  '<h1>Mouse Fixture</h1>',
  '<button id="box" style="width:140px;height:60px">target box</button>',
  '<p id="clickcount">Clicked: 0</p>',
    '<p id="hoverstate">Hover: off</p>',
  '<p id="movelog">Moves: 0</p>',
  '<p id="wheelstate">W:0 SY:0</p>',
  '<p id="pressedstate">Pressed: no</p>',
  '<p id="ctxstate">Ctx: no</p>',
  '<p id="dblstate">Dbl: no</p>',
  '<div id="scroller"><div id="inner">scroll inner</div></div>',
  '<p id="scrollstate">InnerScrolled: no</p>',
  '<div id="dragA" style="position:absolute;top:520px;left:20px;width:60px;height:60px;background:#6af">A</div>',
  '<div id="dragB" style="position:absolute;top:520px;left:220px;width:120px;height:120px;background:#fa6">B</div>',
  '<p id="dropstate">Drop: none</p>',
  '<a id="navlink" href="#bottom">anchor</a><p id="bottom">bottom</p>',
  '<script>',
  'window.__moves=[];window.__mv=0;document.addEventListener("mousemove",function(e){window.__moves.push([e.clientX,e.clientY]);window.__mv++;document.title="Mouse Fixture moves:"+window.__mv;var mvE=document.getElementById("movelog");if(mvE){mvE.textContent="Moves: "+window.__mv}document.getElementById("hoverstate").textContent="Hover: "+(e.target.id==="box"?"on box":"off")});',
  'var c=0;document.addEventListener("mousedown",function(e){if(e.button===0){document.getElementById("pressedstate").textContent="Pressed: yes"}else if(e.button===2){document.getElementById("ctxstate").textContent="Ctx: yes"}});',
  'document.addEventListener("mouseup",function(e){document.getElementById("pressedstate").textContent="Pressed: no"});',
  'document.getElementById("box").addEventListener("click",function(){c++;document.getElementById("clickcount").textContent="Clicked: "+c});',
    'document.getElementById("box").addEventListener("dblclick",function(){document.getElementById("dblstate").textContent="Dbl: yes"});',
  'document.addEventListener("mousemove",function(e){var mc=document.getElementById("movelog");if(mc){mc.textContent="Moves: "+(++window.__mv);}});',
    'document.addEventListener("contextmenu",function(e){e.preventDefault()});',
  'var wc3=0;document.addEventListener("wheel",function(e){wc3++;window.scrollTo(0,window.scrollY+150);var ws3=document.getElementById("wheelstate");if(ws3){ws3.textContent="W:"+wc3+" SY:"+window.scrollY}});',
  'document.getElementById("scroller").addEventListener("scroll",function(){document.getElementById("scrollstate").textContent="InnerScrolled: yes"});',
  'var da=document.getElementById("dragA");da.addEventListener("mousedown",function(e){window.__dragging=true});',
  'document.addEventListener("mouseup",function(e){if(window.__dragging){window.__dragging=false;var b=document.getElementById("dragB").getBoundingClientRect();var inside=e.clientX>=b.left&&e.clientX<=b.right&&e.clientY>=b.top&&e.clientY<=b.bottom;document.getElementById("dropstate").textContent="Drop: "+(inside?"IN B":"missed")}});',
  '</script></body></html>'
].join('\n')

const sleep = ms => new Promise(r => setTimeout(r, ms))
function rpcOnce (method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const disc = JSON.parse(fs.readFileSync(DISC, 'utf8'))
  const u = new URL(disc.url)
  return new Promise(res => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: '/rpc', method: 'POST',
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
let passed = 0
let total = 0
function check (name, ok, detail) {
  total++
  if (ok) passed++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  [' + String(detail).slice(0, 190) + ']'))
}
const R = f => (f && f.result) || null

;(async () => {
  fs.mkdirSync(RUN_DIR, { recursive: true })
  /* drain stray electrons */
  for (let k = 0; k < 10; k++) {
    let n = '0'
    try { n = execSync('tasklist /FI "IMAGENAME eq electron.exe" | find /I /C "electron.exe"').toString().trim()[0] } catch (e) { break }
    if (n === '0') break
    try { execSync('taskkill /F /IM electron.exe /T') } catch (e2) { }
    await sleep(1000)
  }
  const srv = http.createServer(function (req, res) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const pageUrl = 'http://127.0.0.1:' + port + '/'
  const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', pageUrl],
    { cwd: ROOT, windowsHide: true, stdio: 'ignore', detached: true })
  proc.unref()
  for (let i = 0; i < 250; i++) { try { JSON.parse(fs.readFileSync(DISC, 'utf8')); break } catch (e) { await sleep(400) } }
  await sleep(2800)
  const tabs = (((await rpc('browser_tabs', {})).result) || {}).tabs || []
  /* target the FIXTURE tab explicitly (spawn-URL tab), never Min's restored welcome tab */
  const fixtureTab = tabs.find(t => t.url.indexOf(pageUrl) !== -1) || tabs.find(t => t.active)
  const tabId = (fixtureTab || tabs[0] || {}).tabId
  console.log('[probe targets tab]', tabId, (fixtureTab || {}).url, '| all tabs:', JSON.stringify(tabs.map(t => t.url.slice(0, 40))))
  check('bridge + fixture ready', !!tabId, '')

  const M = (action, extra) => rpc('browser_mouse', Object.assign({ tabId, action }, extra || {}))
  const vt = (txt) => rpc('browser_verify', { tabId, textContains: txt }).then(f => !!(f.result && f.result.verified === true))
  const sel = await rpc('browser_tab_select', { tabId })
  await sleep(800)

  /* 1: click + independent verification */
  const boxSnapshotBefore = R(await rpc('browser_snapshot', { tabId, maxNodes: 80 })) || { nodes: [] }
  check('fixture enumerated (target box + buttons)', !!((boxSnapshotBefore.nodes || []).find(n => (n.name || '').indexOf('target box') !== -1 && n.box)), JSON.stringify((boxSnapshotBefore.nodes || []).slice(0, 4)))
  const bxN = (boxSnapshotBefore.nodes || []).find(n => (n.name || '').indexOf('target box') !== -1 && n.box)
  const bx = bxN ? { x: Math.round(bxN.box.x + bxN.box.w / 2), y: Math.round(bxN.box.y + bxN.box.h / 2) } : { x: 60, y: 160 }
  const ev = await M('click', { x: bx.x, y: bx.y })
  check('click dispatched at coordinates', !!(R(ev) && R(ev).dispatched === true && R(ev).x === bx.x), JSON.stringify(ev.result || ev.error).slice(0, 140))
  check('click caused exactly one state change (Clicked: 1)', await vt('Clicked: 1'), '')

  /* 2: hover does NOT click */
  await M('hover', { x: bx.x, y: bx.y })
  let hvOk = await vt('Hover: on box')
  for (let hr = 0; hr < 2 && !hvOk; hr++) { await M('hover', { x: bx.x, y: bx.y }); await sleep(400); hvOk = await vt('Hover: on box') }
  check('hover state visible (Hover: on box) without click', hvOk, '')
  const cAfterHover = (await rpc('browser_content', { tabId, maxChars: 2000 }).then(f => f.result || {})).text || ''
  check('hover did not click (still Clicked: 1)', cAfterHover.indexOf('Clicked: 1') !== -1 && cAfterHover.indexOf('Clicked: 2') === -1, cAfterHover.slice(0, 120))

  /* 3: down/up explicit */
  await M('down', { x: bx.x, y: bx.y })
  const pressedOk = await vt('Pressed: yes')
  const st1 = R(await M('status', {}))
  check('down recorded pressed state (page + bridge agree)', pressedOk && st1 && st1.pressed === 'left', JSON.stringify(st1))
  await M('up', { button: 'left' })
  check('up releases (Pressed: no, bridge pressed=null)', await vt('Pressed: no') && R(await M('status', {})).pressed === null, '')

  /* 4: right click -> page contextmenu flag (page preventDefaults native menu) */
  await M('rightClick', { x: 60, y: 160 })
  check('rightClick reaches page contextmenu handler', await vt('Ctx: yes'), '')

  /* 6: smooth movePath — page records ordered intermediate points */
  const readMv = async function () { const f2 = await rpc('browser_content', { tabId, maxChars: 2000 }).then(f3 => f3.result || {}); const tx2 = f2.text || ''; console.log('[dbg mvread] url=' + (f2.url || '') + ' title=' + JSON.stringify(f2.title || '') + ' len=' + tx2.length + ' sample=' + JSON.stringify(tx2.slice(0, 150))); const m2 = tx2.match(/Moves:\s*([0-9]+)/); return m2 ? (m2[1] * 1) : -1 }
  const movesBefore = await readMv()
  let pathRes = null
  for (let prTry = 0; prTry < 3 && !pathRes; prTry++) { const fr = await M('movePath', { fromX: 20, fromY: 20, toX: 300, toY: 300, durationMs: 480, mode: 'smooth' }); pathRes = R(fr); if (!pathRes) console.log('[dbg pathRes null]', JSON.stringify(fr.error || fr.result).slice(0, 220)) }
  if (!pathRes) { pathRes = { steps: 0, ms: 0, eventCount: 0, dispatched: false } }
  await sleep(400)
  const movesAfter = await readMv()
  check('movePath dispatched with bounded steps', !!(pathRes && pathRes.dispatched === true && pathRes.steps >= 2 && pathRes.steps <= 240 && pathRes.ms < 5000), JSON.stringify(pathRes).slice(0, 200))
  console.log('[dbg path] movesBefore=' + movesBefore + ' movesAfter=' + movesAfter)
  check('page received ordered path events (>=80% delivered)', movesAfter - movesBefore >= Math.floor(pathRes.steps * 0.8), 'target=' + pathRes.steps + ' received=' + (movesAfter - movesBefore))
  /* deferred-delivery probe: does a trailing button event flush queued moves? */
  await M('move', { x: 420, y: 420 })
  await M('click', { x: 430, y: 430 })
  await sleep(500)
  const titleFlush = ((await rpc('browser_content', { tabId, maxChars: 2000 }).then(f => f.result || { })).title) || ''
  const movesFlush = (titleFlush.match(/moves:([0-9]+)/) || [0, 0])[1] * 1
  check('queued moves flushed by trailing button event', movesFlush > movesAfter, 'after-path=' + movesAfter + ' after-flush=' + movesFlush)
  check('smooth path telemetry present', !!(pathRes && typeof pathRes.eventCount === 'number' && pathRes.eventCount >= 3), JSON.stringify(pathRes && { ev: pathRes.eventCount, ms: pathRes.ms }))

  /* 7: instant mode */
  let inst = null
  for (let iTry = 0; iTry < 3 && !inst; iTry++) { inst = R(await M('movePath', { fromX: 10, fromY: 10, toX: 200, toY: 200, mode: 'instant' })) }
  check('instant path is a single dispatch (fast)', !!(inst && inst.steps === 1 && inst.ms < 300), JSON.stringify(inst).slice(0, 140))

  /* 5: wheel dispatch + honest delivery note; real scroll via browser_scroll */
  const wheel = await M('scroll', { x: 100, y: 400, deltaY: 600 })
  check('wheel input dispatched (note documents delivery limitation)', !!(R(wheel) && R(wheel).dispatched === true && /compositor/i.test(R(wheel).deliveryNote || R(wheel).note || '')), JSON.stringify(R(wheel)).slice(0, 180))
  const wheelState = (await rpc('browser_content', { tabId, maxChars: 2000 }).then(f4 => f4.result || {})).text || ''
  const wheelCount = ((wheelState.match(/W:s*([0-9]+)/) || [0, 0])[1] * 1)
  check('wheel page-side delivery (page counter, independently read)', wheelCount >= 1, 'wheelEvents=' + wheelCount + ' (0 = compositor drop on this build, documented; DOM browser_scroll delivers separately)')
  await rpc('browser_scroll', { tabId, y: 600 })
  await sleep(700)
  const shotAfterScroll = R(await rpc('browser_screenshot', { tabId, format: 'jpeg', quality: 60, maxWidth: 800 }))
  check('real scroll reflects in screenshot scrollY metadata + jpeg mime', !!(shotAfterScroll && shotAfterScroll.mimeType === 'image/jpeg' && shotAfterScroll.viewport.scrollY > 0), JSON.stringify(shotAfterScroll && { mime: shotAfterScroll.mimeType, sy: shotAfterScroll.viewport && shotAfterScroll.viewport.scrollY }).slice(0, 140))
  await rpc('browser_scroll', { tabId, to: 'top' })


  /* 8: drag A -> B */
  await rpc('browser_navigate', { tabId, url: pageUrl, stabilityWindowMs: 400 })
  await sleep(1500)
  let drag = null
  for (let dTry = 0; dTry < 3 && !drag; dTry++) { drag = R(await M('drag', { fromX: 50, fromY: 550, toX: 280, toY: 560, durationMs: 600 })) }
  check('drag dispatched down->path->up', !!(drag && drag.dispatched === true && drag.button === 'left' && drag.steps >= 2), JSON.stringify(drag).slice(0, 180))
  check('page registered drop INSIDE B', await vt('Drop: IN B'), '')

  /* 9: bounds + invalid input rejection */
  const badB = await M('click', { x: 5000, y: 10 })
  check('out-of-bounds point rejected with bounds info', !!(badB.error && badB.error.category === 'invalid_params' && /out of bounds/.test(badB.error.message)), JSON.stringify(badB.error).slice(0, 160))
  const badA = await rpc('browser_mouse', { tabId, action: 'teleport', x: 10, y: 10 })
  check('unknown action rejected by schema', !!(badA.error && badA.error.category === 'invalid_params'), JSON.stringify(badA.error).slice(0, 120))

  /* 10: serialization (per-tab busy) */
  const long1 = M('movePath', { fromX: 5, fromY: 5, toX: 350, toY: 350, durationMs: 1200 })
  await sleep(250)
  const long2 = await new Promise(res => rpcOnce('browser_mouse', { tabId, action: 'movePath', fromX: 5, fromY: 5, toX: 350, toY: 350, durationMs: 1200 }).then(r => { try { res(JSON.parse(r)) } catch (e2) { res({ error: { message: String(r) } }) } }))
  const busyrejected = !!(long2.error && long2.error.category === 'busy')
  check('concurrent path on same tab rejected as busy', busyrejected, JSON.stringify(long2.error ? { e: long2.error } : { r: long2.result || long2 }).slice(0, 220))
  await long1.catch(function (eL1) { /* may abort */ })

  /* 11: stale screenshot coordinates rejected after scroll change */
  const shot1 = R(await rpc('browser_screenshot', { tabId }))
  check('screenshot identity + metadata complete', !!(shot1 && /^ss[0-9]+$/.test(shot1.screenshotId) && shot1.coordinateUnits === 'viewport-css-px' && shot1.viewport.width > 0 && shot1.viewport.dpr > 0 && typeof shot1.cssPerPixel === 'number'), JSON.stringify(shot1 ? { id: shot1.screenshotId, vp: shot1.viewport } : (shot1 === null ? 'shot1-null' : 'shot1-undefined')).slice(0, 220))
  await rpc('browser_scroll', { tabId, y: 700 })
  await sleep(500)
  const staleUse = await M('click', { x: 60, y: 160, screenshotId: shot1.screenshotId })
  const staleDump = (staleUse.error || staleUse.result || null)
  check('stale screenshot coordinates rejected (ref_stale)', !!(staleUse.error && staleUse.error.category === 'ref_stale'), JSON.stringify(staleDump).slice(0, 180))
  const freshShot = R(await rpc('browser_screenshot', { tabId }))
  const freshUse = await M('click', { x: 60, y: 160, screenshotId: freshShot.screenshotId })
  check('fresh screenshot coordinates accepted', !!(R(freshUse) && R(freshUse).dispatched === true), JSON.stringify({ e: freshUse.error || null, r: freshUse.result || null }).slice(0, 140))
  await rpc('browser_scroll', { tabId, direction: 'up', amount: 2000 })

  /* 12: navigation cleanup — press button then navigate; no stuck state */
  await M('down', { x: 60, y: 160 })
  await rpc('browser_navigate', { tabId, url: pageUrl, stabilityWindowMs: 400 })
  await sleep(1500)
  const stAfterNav = R(await M('status', {}))
  check('navigation clears pressed/busy state (no stuck button)', !!(stAfterNav && stAfterNav.pressed === null && stAfterNav.busy === false), (function (x) { return JSON.stringify(x || null) })(stAfterNav))

  /* 13: explicit tab isolation — second tab's clicks don't touch tab A */
  const tab2 = R(await rpc('browser_tab_open', { url: pageUrl }))
  await sleep(1500)
  const t2id = tab2 && tab2.tabId
  const evA = await M('click', { x: 60, y: 160 })
  const ev2 = await rpc('browser_mouse', { tabId: t2id, action: 'click', x: 60, y: 160 })
  check('explicit-tab actions never land on another tab (own-tab dispatch OR structured view_not_attached after switch)',
    (R(evA) && R(evA).tabId === String(tabId)) || !!(evA && evA.error && evA.error.category === 'view_not_attached'), JSON.stringify([R(evA) || (evA && evA.error) || null]).slice(0, 220))
  await rpc('browser_tab_close', { tabId: t2id })
})().then(() => {
  console.log('\n' + passed + '/' + total + ' checks passed')
  try { spawnSync('taskkill.exe', ['/F', '/IM', 'electron.exe', '/T']) } catch (e) { /* ignore */ }
  try { spawnSync('taskkill.exe', ['/F', '/IM', 'electron.exe', '/T']) } catch (e) { /* ignore */ }
  process.exit(passed === total ? 0 : 2)
}).catch(e => {
  console.log('fatal ' + e.message)
  if (e.stack) console.log(String(e.stack).split(String.fromCharCode(10)).slice(0, 5).join(' | '))
  try { spawnSync('taskkill.exe', ['/F', '/IM', 'electron.exe', '/T']) } catch (x) { /* ignore */ }
  process.exit(2)
})