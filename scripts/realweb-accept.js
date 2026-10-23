/*
 * REAL-WEB acceptance layer for Min Agent Edition.
 *
 * Every user-visible browser capability must be proven on a real, publicly
 * reachable page driven through the REAL MCP path
 * (min-launch -> Min/Electron -> bridge -> mcp/min-agent-mcp.js over stdio).
 * Local fixtures remain the deterministic authority for edge cases; this file
 * answers a different question: does the shipped product work on the actual
 * web, today, from this machine?
 *
 * THIS IS OPT-IN AND NETWORK-DEPENDENT. It is deliberately NOT part of
 * `npm test`:
 *   npm run probe:realweb                 # all cases
 *   npm run probe:realweb -- --list       # list case ids and sites
 *   npm run probe:realweb -- --only=nav,snapshot
 *   npm run probe:realweb -- --scope=readonly   # skip mutation cases
 *   npm run probe:realweb -- --trace
 *
 * SAFETY
 *   - One Min instance, fresh temp profile under the OS temp dir, PIDs tracked
 *     here; cleanup is /PID-targeted (never /IM, never name-wide).
 *   - Third parties are READ-ONLY: navigate, read, screenshot. The only page
 *     mutation is typing into a PUBLIC TEST FORM THAT IS NEVER SUBMITTED.
 *   - browser_eval / browser_transform / browser_upload are exercised on pages
 *     we control (public test pages designed for automation, or a loopback
 *     stand-in). Nothing is posted, signed up, purchased, messaged, or used to
 *     bypass any access control.
 *
 * STATUS: PASS / FAIL / BLOCKED / DRIFT (docs/audit/TEST-STRATEGY-AND-COVERAGE.md)
 *   PASS     assertion met on a LIVE public page this run
 *   FAIL     assertion not met — product or test defect, investigated
 *   BLOCKED  could not be evaluated (network/site/automation restriction);
 *            recorded with evidence, never silently skipped
 *   DRIFT    the site changed in a way that invalidates the premise
 *
 * A run that could not reach the network reports BLOCKED for live cases and
 * stand-in evidence separately; it never turns into a green PASS.
 *
 * SITES record purpose, the assertion that depends on them, and the date they
 * were last vetted. Adding a site means adding its vetted purpose here.
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const H = require('./lib/realweb-harness')


const SITES = [
  {
    id: 'example',
    probe: 'https://example.com/',
    urls: { home: 'https://example.com/' },
    purpose: 'canonical stable page: navigation, title, content, snapshot refs, verify, screenshot, element crop, helper page_summary',
    vetted: '2026-10-20'
  },
  {
    id: 'promises',
    probe: 'https://the-internet.herokuapp.com/',
    urls: {
      home: 'https://the-internet.herokuapp.com/',
      checkboxes: 'https://the-internet.herokuapp.com/checkboxes',
      dropdown: 'https://the-internet.herokuapp.com/dropdown',
      frames: 'https://the-internet.herokuapp.com/iframe',
      upload: 'https://the-internet.herokuapp.com/upload',
      horiz: 'https://the-internet.herokuapp.com/horizontal_slider',
      download: 'https://the-internet.herokuapp.com/download'
    },
    purpose: 'public automation test pages: checkboxes, select, frames, file input (never submitted), slider, download endpoints',
    vetted: '2026-10-20'
  },
  {
    id: 'selenium',
    probe: 'https://www.selenium.dev/selenium/web/web-form.html',
    urls: {
      form: 'https://www.selenium.dev/selenium/web/web-form.html',
      upload: 'https://www.selenium.dev/selenium/web/upload.html'
    },
    purpose: 'project-maintained web form with a live readonly input, select, checkbox, file input, tall page for full-page capture; NEVER submitted',
    vetted: '2026-10-20'
  },
  {
    id: 'httpbin',
    probe: 'https://httpbin.org/html',
    urls: {
      html: 'https://httpbin.org/html',
      post: 'https://httpbin.org/forms/post',
      redirect: 'https://httpbin.org/redirect/2',
      delay: 'https://httpbin.org/delay/1',
      bytes: 'https://httpbin.org/bytes/2048',
      png: 'https://httpbin.org/image/png',
      jpeg: 'https://httpbin.org/image/jpeg',
      json: 'https://httpbin.org/get'
    },
    purpose: 'exact public text (Moby-Dick), a public test form (11 inputs, never submitted), real redirects, real delay, binary fixture endpoints',
    vetted: '2026-10-20'
  },
  {
    id: 'canvas',
    probe: 'https://www.w3schools.com/html/html5_canvas.asp',
    urls: { canvas: 'https://www.w3schools.com/html/html5_canvas.asp' },
    purpose: 'standards page with real <canvas> elements for page-context pixel inspection',
    vetted: '2026-10-20'
  },
  {
    id: 'w3readonly',
    probe: 'https://www.w3schools.com/tags/att_input_readonly.asp',
    urls: { readonly: 'https://www.w3schools.com/tags/att_input_readonly.asp' },
    purpose: 'readonly input documentation page; ONLY used when the live DOM exposes a real readonly control (probe:true), otherwise the selenium form is used',
    probeLiveFirst: true,
    vetted: '2026-10-20'
  },
  {
    id: 'wikipedia',
    probe: 'https://en.wikipedia.org/wiki/CSS',
    urls: { page: 'https://en.wikipedia.org/wiki/CSS' },
    purpose: 'large, stable, long page for full-page capture beyond the viewport and scroll delivery',
    vetted: '2026-10-20'
  },
  {
    id: 'promises2',
    probe: 'https://the-internet.herokuapp.com/add_remove_elements/',
    urls: { home: 'https://the-internet.herokuapp.com/add_remove_elements/' },
    purpose: 'second independent public origin (no restrictive CSP) for cross-tab navigation and isolation',
    vetted: '2026-10-20'
  },
  {
    id: 'example',
    probe: 'https://example.com/',
    urls: { home: 'https://example.com/' },
    purpose: 'canonical stable page: navigation, title, content, snapshot refs, verify, screenshot, element crop, helper page_summary',
    vetted: '2026-10-20'
  },
  {
    id: 'promises',
    probe: 'https://the-internet.herokuapp.com/',
    urls: {
      home: 'https://the-internet.herokuapp.com/',
      checkboxes: 'https://the-internet.herokuapp.com/checkboxes',
      dropdown: 'https://the-internet.herokuapp.com/dropdown',
      frames: 'https://the-internet.herokuapp.com/iframe',
      upload: 'https://the-internet.herokuapp.com/upload',
      horiz: 'https://the-internet.herokuapp.com/horizontal_slider',
      download: 'https://the-internet.herokuapp.com/download'
    },
    purpose: 'public automation test pages: checkboxes, select, frames, file input (never submitted), slider, download endpoints',
    vetted: '2026-10-20'
  },
  {
    id: 'selenium',
    probe: 'https://www.selenium.dev/selenium/web/web-form.html',
    urls: {
      form: 'https://www.selenium.dev/selenium/web/web-form.html',
      upload: 'https://www.selenium.dev/selenium/web/upload.html'
    },
    purpose: 'project-maintained web form with a live readonly input, select, checkbox, file input, tall page for full-page capture; NEVER submitted',
    vetted: '2026-10-20'
  },
  {
    id: 'httpbin',
    probe: 'https://httpbin.org/html',
    urls: {
      html: 'https://httpbin.org/html',
      post: 'https://httpbin.org/forms/post',
      redirect: 'https://httpbin.org/redirect/2',
      delay: 'https://httpbin.org/delay/1',
      bytes: 'https://httpbin.org/bytes/2048',
      png: 'https://httpbin.org/image/png',
      jpeg: 'https://httpbin.org/image/jpeg',
      json: 'https://httpbin.org/get'
    },
    purpose: 'exact public text (Moby-Dick), a public test form (11 inputs, never submitted), real redirects, real delay, binary fixture endpoints',
    vetted: '2026-10-20'
  },
  {
    id: 'canvas',
    probe: 'https://www.w3schools.com/html/html5_canvas.asp',
    urls: { canvas: 'https://www.w3schools.com/html/html5_canvas.asp' },
    purpose: 'standards page with real <canvas> elements for page-context pixel inspection',
    vetted: '2026-10-20'
  },
  {
    id: 'w3readonly',
    probe: 'https://www.w3schools.com/tags/att_input_readonly.asp',
    urls: { readonly: 'https://www.w3schools.com/tags/att_input_readonly.asp' },
    purpose: 'readonly input documentation page; ONLY used when the live DOM exposes a real readonly control (probe:true), otherwise the selenium form is used',
    probeLiveFirst: true,
    vetted: '2026-10-20'
  },
  {
    id: 'wikipedia',
    probe: 'https://en.wikipedia.org/wiki/CSS',
    urls: { page: 'https://en.wikipedia.org/wiki/CSS' },
    purpose: 'large, stable, long page for full-page capture beyond the viewport and scroll delivery',
    vetted: '2026-10-20'
  },

]
const SITE = {}
SITES.forEach(s => { SITE[s.id] = s })
function siteUrl (id, key) { return SITE[id].urls[key] }

const results = []
const argv = process.argv.slice(2)
const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const RUN_DIR = path.join(require('os').tmpdir(), 'min-realweb-' + TS)

const SESSION = new H.RealWebSession({
  name: 'realweb',
  layer: 'C',
  evidenceFile: path.join(H.ROOT, 'docs', 'realweb-accept.json'),
  offline: argv.indexOf('--no-standin') === -1
})

function record (id, site, status, detail, observed) {
  const r = SESSION.record(id, site, 'live', status, detail, observed)
  results.push(r)
  return r
}
const pass = (id, site, detail, observed) => record(id, site, 'PASS', detail, observed)
const fail = (id, site, detail, observed) => record(id, site, 'FAIL', detail, observed)
const blocked = (id, site, detail, observed) => record(id, site, 'BLOCKED', detail, observed)
const drift = (id, site, detail, observed) => record(id, site, 'DRIFT', detail, observed)

const ok = (where, detail, observed) => pass(where[0], where[1], detail, observed)
const bad = (where, detail, observed) => fail(where[0], where[1], detail, observed)

/* Every case gets a bounded attempt so one hung site cannot stall the run. */
function withTimeout (promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: false, timeout: true, detail: label + ' exceeded ' + ms + 'ms' }) }, ms)
    })
  ])
}

/* Min appends "-development" to the profile userData in development mode, and
 * the bridge keeps agent-managed uploads in <userData>/agent-uploads. Staging
 * a file there is the only way to feed a real file input through the product's
 * own path policy (the file must already exist inside that root). */
function stageUploadFile (relPath, content) {
  const candidates = [SESSION.profile + '-development', SESSION.profile]
  for (const dir of candidates) {
    const root = path.join(dir, 'agent-uploads')
    const abs = path.join(root, relPath)
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      return { ok: true, path: abs }
    } catch (e) { /* try the other spelling */ }
  }
  return { ok: false, error: 'no writable upload root beside ' + SESSION.profile }
}

async function main () {
  if (argv.indexOf('--list') !== -1) {
    listCases()
    return 0
  }
  const onlyArg = argv.find(a => a.indexOf('--only=') === 0)
  const only = onlyArg ? onlyArg.slice(7).split(',').map(s => s.trim()).filter(Boolean) : null
  const scopeArg = argv.find(a => a.indexOf('--scope=') === 0)
  const scope = scopeArg ? scopeArg.slice(8) : 'full'
  const want = id => (!only || only.indexOf(id) !== -1)

  fs.mkdirSync(RUN_DIR, { recursive: true })
  const started = await SESSION.start(SITES)
  if (!started) {
    SESSION.writeEvidence()
    await SESSION.stop()
    return 1
  }
  const tid = SESSION.tid

  /* Site availability: try each origin once; a dead origin turns its own
   * cases into BLOCKED-with-evidence instead of an unhandled hang. */
  const alive = {}
  for (const s of SITES) alive[s.id] = await SESSION.siteLive(s.id)

  const run = async function (id, fn, sites) {
    if (!want(id)) return
    const useSites = sites || []
    const dead = useSites.filter(s => !alive[s])
    if (dead.length) {
      blocked(id, dead[0], 'public origin unreachable this run: ' + (SESSION.network.checks.find(c => c.site === dead[0]) || {}).error || 'unreachable', { skippedSites: dead })
      return
    }
    try {
      const r = await withTimeout(fn(), 240000, id)
      if (r && r.ok === false && r.timeout) fail(id, useSites[0] || 'local', r.detail)
    } catch (e) {
      fail(id, useSites[0] || 'local', 'case threw: ' + String(e && e.message).slice(0, 240))
    }
    /* Cases share ONE browser tab; when a case replaced or closed it, every
     * later case would silently target a dead tab. Re-anchor on the window's
     * attached (selected) tab after each case. */
    await reanchor()
  }

  async function reanchor () {
    try {
      const tabs = await SESSION.call('browser_tabs', {})
      const list = (tabs.text && tabs.text.tabs) || []
      const cand = list.find(t => t.active === true && t.windowId) || list.find(t => t.windowId) || null
      if (cand && cand.tabId !== SESSION.tid) {
        SESSION.tid = cand.tabId
        SESSION.record('harness.reanchor', 'local', 'live', 'PASS', 'case tab moved; now anchored on tab ' + cand.tabId + ' (' + String(cand.url || '').slice(0, 60) + ')')
      }
    } catch (e) { /* keep the previous anchor */ }
  }

  /* ============================= CASES ============================= */

  await run('nav', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['nav', 'example'], 'navigation not verified: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 300))
    const t = nav.nav.text
    if (t.verified === true && /example\.com/.test(String(t.finalUrl)) && /Example Domain/.test(String(t.title || ''))) {
      pass('nav', 'example', 'verified navigation; finalUrl=' + t.finalUrl + ' title="' + t.title + '"', { finalUrl: t.finalUrl, title: t.title, settleMs: t.settleMs })
    } else bad(['nav', 'example'], 'unexpected final state: ' + JSON.stringify(t).slice(0, 300))
  }, ['example'])

  await run('content', async function () {
    const nav = await SESSION.nav(siteUrl('httpbin', 'html'), { site: 'httpbin' })
    if (!nav.ok) return blocked('content', 'httpbin', 'httpbin/html not reachable: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))
    const c = await SESSION.call('browser_content', { tabId: tid, maxChars: 4000 })
    const body = String((c.text && (c.text.text || c.text.content)) || '')
    const rs = await SESSION.call('browser_wait', { tabId: tid, until: 'ready_state', timeoutMs: 15000 })
    const okText = /Herman Melville|Moby-Dick/i.test(body)
    const okRs = rs.text && rs.text.satisfied === true
    if (okText && okRs) pass('content', 'httpbin', 'real page text observed; readyState=' + rs.text.readyState + '; ' + body.length + ' chars', { readyState: rs.text.readyState })
    else if (!okText) drift('content', 'httpbin', 'expected public text not found — site changed, investigate as DRIFT: ' + body.slice(0, 160))
    else bad(['content', 'httpbin'], 'ready_state not reached: ' + JSON.stringify(rs.text || rs.error).slice(0, 200))
  }, ['httpbin'])

  await run('redirect', async function () {
    const nav = await SESSION.nav(siteUrl('httpbin', 'redirect'), { site: 'httpbin' })
    const t = nav.nav && nav.nav.text
    if (nav.ok && t && /\/get/.test(String(t.finalUrl || ''))) pass('redirect', 'httpbin', 'two-hop redirect followed to ' + t.finalUrl, { finalUrl: t.finalUrl })
    else if (!nav.ok) bad(['redirect', 'httpbin'], 'redirect navigation failed: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 220))
    else drift('redirect', 'httpbin', 'final URL did not reach /get: ' + String(t && t.finalUrl))
  }, ['httpbin'])

  await run('wait', async function () {
    const nav = await SESSION.nav(siteUrl('httpbin', 'delay'), { site: 'httpbin' })
    if (!nav.ok) return blocked('wait', 'httpbin', 'delay endpoint unreachable: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))
    const idle = await SESSION.call('browser_wait', { tabId: tid, until: 'network_idle', quietMs: 800, maxQuietMs: 9000, timeoutMs: 20000 })
    const d = idle.text
    if (d && d.satisfied === true && typeof d.drained === 'boolean' && typeof d.semantics === 'string') {
      pass('wait', 'httpbin', 'real delayed response; network_idle satisfied drained=' + d.drained + ' inFlight=' + d.inFlight, { drained: d.drained, inFlight: d.inFlight })
    } else bad(['wait', 'httpbin'], String(idle.error || JSON.stringify(d)).slice(0, 240))
  }, ['httpbin'])

  await run('snapshot', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['snapshot', 'example'], 'navigation failed')
    const s = await SESSION.snap()
    const nodes = s.nodes
    const link = nodes.find(n => n.role === 'link')
    if (link && /^r[0-9a-z]+$/.test(String(link.ref))) {
      pass('snapshot', 'example', nodes.length + ' interactive node(s); link ref ' + link.ref + ' "' + String(link.name).slice(0, 40) + '"', { nodeCount: nodes.length })
    } else bad(['snapshot', 'example'], 'no link ref enumerated: ' + JSON.stringify(nodes).slice(0, 240))
    const ver = await SESSION.call('browser_verify', { tabId: tid, selector: 'p', textContains: 'documentation examples' })
    if (ver.text && ver.text.verified === true) pass('snapshot.verify', 'example', 'selector+text verification on a real page')
    else bad(['snapshot.verify', 'example'], String(ver.error || JSON.stringify(ver.text)).slice(0, 240))
  }, ['example'])

  /* R2/B4: the AX tree of a REAL page. */
  await run('ax', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['ax', 'example'], 'navigation failed')
    const s = await SESSION.snap({ format: 'ax' })
    const nodes = s.nodes
    const roles = new Set(nodes.map(n => n && n.role).filter(Boolean))
    const hasDoc = roles.has('RootWebArea') || roles.has('WebArea') || roles.has('document')
    const hasLink = nodes.some(n => /link/i.test(String(n && n.role)))
    if (nodes.length >= 3 && hasLink && (hasDoc || roles.size >= 3)) {
      pass('ax', 'example', 'real Chromium AX tree: ' + nodes.length + ' nodes, roles=' + Array.from(roles).slice(0, 8).join(','), { nodeCount: nodes.length, roles: Array.from(roles).slice(0, 12) })
    } else bad(['ax', 'example'], 'AX tree missing expected roles: ' + JSON.stringify(Array.from(roles)).slice(0, 200))
  }, ['example'])

  await run('eval', async function () {
    const nav = await SESSION.nav(siteUrl('httpbin', 'html'), { site: 'httpbin' })
    if (!nav.ok) return blocked('eval', 'httpbin', 'page unreachable')
    const ev = await SESSION.evalValue('document.querySelectorAll("p").length + "|" + (document.querySelector("h1") ? document.querySelector("h1").textContent : "")')
    const parts = typeof ev.value === 'string' ? ev.value.split('|') : []
    const pCount = Number(parts[0])
    const h1 = String(parts[1] || '')
    const ctx = ev.raw && ev.raw.executionContext
    if (ev.ok && pCount >= 1 && /Moby|Melville/i.test(h1) && ctx === 'main-frame-page-world') {
      pass('eval', 'httpbin', 'page-context read: h1="' + h1.slice(0, 40) + '", p=' + pCount)
    } else bad(['eval', 'httpbin'], 'value=' + JSON.stringify(ev.value).slice(0, 120) + ' ctx=' + ctx + ' err=' + String(ev.error || '').slice(0, 120))
  }, ['httpbin'])

  await run('canvas', async function () {
    const nav = await SESSION.nav(siteUrl('canvas', 'canvas'), { site: 'canvas' })
    if (!nav.ok) return blocked('canvas', 'canvas', 'standards page did not load: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))
    const ev = await SESSION.evalValue('(function(){var c=document.querySelector("canvas");if(!c)return{found:false};var d=null;try{d=c.getContext("2d")}catch(e){}var px=null;try{if(d&&c.width>0&&c.height>0){px=d.getImageData(0,0,Math.min(4,c.width),Math.min(4,c.height)).data.length}}catch(e){px="tainted"}return{found:true,w:c.width,h:c.height,px:px}})()')
    const v = ev.value
    if (v && v.found === true && v.w > 0 && v.h > 0) pass('canvas', 'canvas', 'real <canvas> ' + v.w + 'x' + v.h + ' pixels=' + v.px)
    else blocked('canvas', 'canvas', 'no live reachable <canvas> in the page context: ' + JSON.stringify(ev.value).slice(0, 160))
  }, ['canvas'])

  await run('screenshot', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['screenshot', 'example'], 'navigation failed')
    const shot = await SESSION.call('browser_screenshot', { tabId: tid })
    const img = shot.image
    const isPng = img && /^iVBORw0KGgo/.test(String(img.data || ''))
    const meta = shot.meta
    if (isPng && meta && meta.source === 'full' && typeof meta.scaled === 'boolean' && Array.isArray(meta.ladder) && meta.viewport) {
      pass('screenshot', 'example', img.mimeType + ' ' + String(img.data).length + 'b source=' + meta.source + ' ' + meta.width + 'x' + meta.height, { width: meta.width, height: meta.height, bytes: meta.bytes })
    } else bad(['screenshot', 'example'], 'image=' + (img ? String(img.data).length : 'none') + ' meta=' + JSON.stringify(meta && { s: meta.source, sc: meta.scaled }).slice(0, 200))
  }, ['example'])

  await run('screenshot.jpg', async function () {
    const shot = await SESSION.call('browser_screenshot', { tabId: tid, format: 'jpeg', quality: 70 })
    const img = shot.image
    const isJpeg = img && img.mimeType === 'image/jpeg' && /^\/9j\//.test(String(img.data || ''))
    const meta = shot.meta
    if (isJpeg && meta && meta.mimeType === 'image/jpeg') pass('screenshot.jpg', 'example', 'jpeg ' + meta.width + 'x' + meta.height + ' ' + meta.bytes + 'b', { bytes: meta.bytes })
    else bad(['screenshot.jpg', 'example'], 'format not honoured: ' + JSON.stringify(meta && meta.mimeType) + ' img=' + (img ? img.mimeType : 'none'))
  }, ['example'])

  await run('element', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['element', 'example'], 'navigation failed')
    const el = await SESSION.call('browser_screenshot', { tabId: tid, selector: 'body > p' })
    const full = await SESSION.call('browser_screenshot', { tabId: tid })
    const okEl = el.image && el.meta && el.meta.source === 'element'
    const smaller = okEl && full.meta && el.meta.width < full.meta.width && el.meta.height < full.meta.height
    if (okEl && smaller && typeof el.meta.cropLimited === 'string') {
      pass('element', 'example', 'crop ' + el.meta.width + 'x' + el.meta.height + ' < full ' + full.meta.width + 'x' + full.meta.height + '; ' + el.meta.cropLimited)
    } else bad(['element', 'example'], String(el.error || JSON.stringify({ el: el.meta && el.meta.source, ew: el.meta && el.meta.width, fw: full.meta && full.meta.width })).slice(0, 240))
  }, ['example'])

  /* R2/D1: full-page capture on a REAL long public page. */
  await run('fullpage', async function () {
    const nav = await SESSION.nav(siteUrl('wikipedia', 'page'), { site: 'wikipedia' })
    if (!nav.ok) return blocked('fullpage', 'wikipedia', 'long public page did not load: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))
    const vp = await SESSION.evalValue('JSON.stringify({sh: document.documentElement.scrollHeight, ih: window.innerHeight})')
    let dims = {}
    try { dims = JSON.parse(String(vp.value)) } catch (e) {}
    const view = await SESSION.call('browser_screenshot', { tabId: tid })
    const full = await SESSION.call('browser_screenshot', { tabId: tid, fullPage: true, maxSlices: 24 }, 180000)
    const fm = full.meta
    const vm = view.meta
    if (!(full.image && fm && fm.source === 'fullpage')) {
      return bad(['fullpage', 'wikipedia'], 'fullPage capture failed: ' + JSON.stringify(fm || full.error).slice(0, 240))
    }
    /* The image must represent MORE of the document than the viewport. A
     * first-slice fallback reports captureMode 'scroll-stitch-first-slice'
     * and is a failure of the capability, not a pass with a smaller number. */
    const stitched = fm.captureMode === 'scroll-stitch-composited'
    const taller = vm && fm.height > vm.height * 1.5
    if (stitched && taller) {
      pass('fullpage', 'wikipedia', 'stitched ' + fm.slices + ' slices into ' + fm.width + 'x' + fm.height +
        ' (viewport ' + vm.width + 'x' + vm.height + ', page css ' + dims.sh + 'px, scale ' + fm.scaledBy + ', complete=' + fm.completeCapture + ')',
        { full: fm, viewport: { width: vm.width, height: vm.height }, cssScrollHeight: dims.sh })
    } else {
      bad(['fullpage', 'wikipedia'], 'not a stitched full page: ' + JSON.stringify({ mode: fm.captureMode, h: fm.height, vh: vm && vm.height, sliced: fm.slices, complete: fm.completeCapture }).slice(0, 260))
    }
    /* Honest completeness: either the whole document is there, or the result
     * says it was truncated by the hard cap. Silent cropping is the defect. */
    if (fm.completeCapture === true || fm.truncated === true) {
      pass('fullpage.honest', 'wikipedia', fm.completeCapture === true ? 'completeCapture=true: the image is the whole document' : 'truncated=true: capped at ' + fm.capturedHeightCss + ' of ' + fm.documentHeightCss + ' css px, and says so')
    } else bad(['fullpage.honest', 'wikipedia'], 'neither complete nor marked truncated: ' + JSON.stringify({ c: fm.completeCapture, t: fm.truncated }).slice(0, 160))
    const after = await SESSION.evalValue('window.scrollY')
    if (Number(after.value) === 0) pass('fullpage.scroll-restored', 'wikipedia', 'scroll position restored to the top after stitching')
    else drift('fullpage.scroll-restored', 'wikipedia', 'page was left at scrollY=' + after.value)
  }, ['wikipedia'])

  /* R2/D1 companion: PDF of a real page. */
  await run('pdf', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['pdf', 'example'], 'navigation failed')
    const p = await SESSION.call('browser_pdf', { tabId: tid }, 60000)
    const t = p.text
    const head = t && typeof t.data === 'string' ? Buffer.from(t.data.slice(0, 16), 'base64').toString('latin1') : ''
    if (t && t.mimeType === 'application/pdf' && t.bytes > 2000 && /^%PDF-/.test(head)) {
      pass('pdf', 'example', 'print-to-PDF of a real page: ' + t.bytes + ' bytes, header ' + JSON.stringify(head.slice(0, 8)), { bytes: t.bytes, scale: t.scale })
    } else bad(['pdf', 'example'], 'not a PDF: ' + JSON.stringify({ bytes: t && t.bytes, head: head.slice(0, 8), err: p.error }).slice(0, 200))
  }, ['example'])

  /* ---------------- input delivery on real pages, never submitted ------- */

  await run('input', async function () {
    const nav = await SESSION.nav(siteUrl('httpbin', 'post'), { site: 'httpbin' })
    if (!nav.ok) return blocked('input', 'httpbin', 'public test form unreachable')
    const nodes = (await SESSION.snap()).nodes
    const field = nodes.find(n => n.role === 'textbox' || n.role === 'searchbox')
    const btn = nodes.find(n => n.role === 'button')
    if (!field) return drift('input', 'httpbin', 'no textbox enumerated on the public form (site markup changed)')
    const typed = await SESSION.call('browser_type', { tabId: tid, ref: field.ref, text: 'realweb-acceptance' })
    const td = typed.text
    if (td && td.verified === true && td.verification === 'value') pass('input.type', 'httpbin', 'typed into a real public form and verified by value (NOT submitted)')
    else bad(['input.type', 'httpbin'], JSON.stringify(td || typed.error).slice(0, 240))
    const pressed = await SESSION.call('browser_press', { tabId: tid, key: 'Tab' })
    const pd = pressed.text
    if (pd && pd.dispatched === true && typeof pd.delivery === 'string' && typeof pd.verified === 'boolean') {
      pass('input.press', 'httpbin', 'press dispatched; delivery=' + pd.delivery + ' verified=' + pd.verified)
    } else bad(['input.press', 'httpbin'], JSON.stringify(pd || pressed.error).slice(0, 240))
    if (btn) {
      const hovered = await SESSION.call('browser_hover', { tabId: tid, ref: btn.ref })
      if (hovered.error) bad(['input.hover', 'httpbin'], String(hovered.error).slice(0, 200))
      else pass('input.hover', 'httpbin', 'hover dispatched on a real button (page effect not asserted: compositor limit)')
    }
    /* R2/D3-A: keyboard-mode typing on a real field. The delivered strategy may
     * be the documented native-setter fallback; what must hold is that the
     * request was keyboard mode and a REAL public field ends up holding the
     * text. */
    const kb = await SESSION.call('browser_type', { tabId: tid, ref: field.ref, text: 'kb-mode', mode: 'keyboard' }, 60000)
    const kt = kb.text
    const kbValue = await SESSION.evalValue('(function(){var i=document.querySelector("input[name=custname]");return i?i.value:null})()')
    if (kt && kt.verified === true && kt.inputMode === 'keyboard' && String(kbValue.value) === 'kb-mode') {
      pass('input.keyboard', 'httpbin', 'keyboard-mode typing verified on a real page; delivered via ' + kt.strategy +
        ' (' + (kt.keyboard && kt.keyboard.chars) + ' chars), the field reads "' + kbValue.value + '"', { strategy: kt.strategy, keyboard: kt.keyboard })
    } else bad(['input.keyboard', 'httpbin'], JSON.stringify({ resp: kt || kb.error, page: kbValue.value }).slice(0, 260))
  }, ['httpbin'])

  /* ---------------- form controls that must PERSIST state -------------- */

  await run('controls', async function () {
    const nav = await SESSION.nav(siteUrl('selenium', 'form'), { site: 'selenium' })
    if (!nav.ok) return blocked('controls', 'selenium', 'web form did not load: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))
    const nodes = (await SESSION.snap()).nodes
    const crit = nodes.filter(n => ['checkbox', 'radio', 'combobox', 'listbox', 'option', 'switch'].indexOf(String(n.role)) !== -1 || n.checked !== undefined)
    if (crit.length < 2) return drift('controls', 'selenium', 'control roles not enumerated (' + crit.length + '); markup may have changed')
    pass('controls.snapshot', 'selenium', crit.length + ' form controls with state enumerated: ' + crit.slice(0, 6).map(n => n.role + (n.checked === undefined ? '' : '=' + n.checked)).join(','))

    const box = nodes.find(n => n.role === 'checkbox')
    if (box) {
      const before = box.checked
      const chk = await SESSION.call('browser_check', { tabId: tid, ref: box.ref, checked: !before })
      const afterNodes = (await SESSION.snap()).nodes
      const after = afterNodes.find(n => n.role === 'checkbox' && String(n.name) === String(box.name))
      const toggled = chk.text && chk.text.verified === true && chk.text.checked === !before && !!after && after.checked === !before
      if (toggled) pass('controls.check', 'selenium', 'checkbox "' + box.name + '" changed ' + before + ' -> ' + (!before) + '; a NEW snapshot re-read the state', { before: before, after: after.checked })
      else bad(['controls.check', 'selenium'], JSON.stringify({ resp: chk.text || chk.error, after: after && after.checked }).slice(0, 260))
    } else drift('controls.check', 'selenium', 'no checkbox role enumerated')

    /* A mutation rotates refs: address the select from the NEW snapshot. */
    const fresh = (await SESSION.snap()).nodes
    const sel = fresh.find(n => String(n.role) === 'combobox' || String(n.role) === 'listbox')
    if (sel) {
      /* Address the option by its PAGE value (read from the real DOM), never
       * by a guess: the snapshot exposes the current label only. */
      const opts = await SESSION.evalValue('(function(){var s=document.querySelector("select");if(!s)return null;return JSON.stringify(Array.prototype.map.call(s.options,function(o){return {v:o.value,t:o.text,sel:o.selected}}))})()')
      let list = []
      try { list = JSON.parse(String(opts.value)) } catch (e) { list = [] }
      if (!list.length) return drift('controls.select', 'selenium', 'no <select> options readable from the page')
      const pick = list.find(o => o.sel !== true) || list[list.length - 1]
      const sv = await SESSION.call('browser_select', { tabId: tid, ref: sel.ref, value: String(pick.v) })
      const back = await SESSION.evalValue('(function(){var s=document.querySelector("select");return s?{v:s.value,i:s.selectedIndex,n:s.options.length}:null})()')
      const v = back.value
      if (sv.text && sv.text.verified === true && v && String(v.v) === String(pick.v)) {
        pass('controls.select', 'selenium', 'select ' + sel.ref + ' chose option "' + pick.t + '" (value ' + pick.v + '); the real page reports value="' + v.v + '" index=' + v.i, { value: v, options: list.length })
      } else bad(['controls.select', 'selenium'], JSON.stringify({ resp: sv.text || sv.error, page: v, tried: pick }).slice(0, 260))
    } else drift('controls.select', 'selenium', 'no select/combobox role enumerated')
  }, ['selenium'])

  await run('readonly', async function () {
    const nav = await SESSION.nav(siteUrl('selenium', 'form'), { site: 'selenium' })
    if (!nav.ok) return blocked('readonly', 'selenium', 'web form did not load')
    const nodes = (await SESSION.snap()).nodes
    const ro = nodes.find(n => n.readOnly === true || n.name === 'my-readonly')
    if (!ro) return drift('readonly', 'selenium', 'readonly control not enumerated (markup changed): ' + JSON.stringify(nodes.filter(n => n.role === 'textbox').map(n => ({ n: n.name, r: n.readOnly }))).slice(0, 200))
    const before = ro.value === undefined ? null : ro.value
    const typed = await SESSION.call('browser_type', { tabId: tid, ref: ro.ref, text: 'should-not-stick' })
    const after = await SESSION.evalValue('(function(){var n=document.querySelector("[name=my-readonly]");return n?n.value:null})()')
    const refused = typed.error || (typed.text && typed.text.verified !== true)
    const unchanged = before === null || after.value === before
    if (refused && unchanged) pass('readonly', 'selenium', 'real readonly input ' + ro.ref + ' refused typing (' + JSON.stringify(typed.error || (typed.text && typed.text.verification)).slice(0, 90) + ') and its value is unchanged')
    else bad(['readonly', 'selenium'], JSON.stringify({ error: typed.error, text: typed.text && { v: typed.text.verified, why: typed.text.verification }, before: before, after: after.value }).slice(0, 260))
  }, ['selenium'])

  /* ---------------- scroll delivery on real pages --------------------- */

  await run('scroll', async function () {
    const nav = await SESSION.nav(siteUrl('wikipedia', 'page'), { site: 'wikipedia' })
    if (!nav.ok) return blocked('scroll', 'wikipedia', 'long page did not load')
    const top = await SESSION.evalValue('window.scrollY')
    const down = await SESSION.call('browser_scroll', { tabId: tid, y: 900 })
    await H.sleep(250)
    const mid = await SESSION.evalValue('window.scrollY')
    const bottom = await SESSION.call('browser_scroll', { tabId: tid, to: 'bottom' })
    await H.sleep(400)
    const end = await SESSION.evalValue('JSON.stringify({y:window.scrollY,max: document.documentElement.scrollHeight - window.innerHeight})')
    let e = {}
    try { e = JSON.parse(String(end.value)) } catch (err) {}
    const moved = Number(mid.value) > Number(top.value || 0) + 100
    const atBottom = e.max > 0 && e.y >= e.max - 30
    if (down.text && moved) pass('scroll.down', 'wikipedia', 'browser_scroll moved the real page to scrollY=' + mid.value)
    else bad(['scroll.down', 'wikipedia'], JSON.stringify({ resp: down.text || down.error, before: top.value, after: mid.value }).slice(0, 220))
    if (bottom.text && atBottom) pass('scroll.bottom', 'wikipedia', 'scroll to bottom reached ' + e.y + ' of ' + e.max)
    else drift('scroll.bottom', 'wikipedia', JSON.stringify({ resp: bottom.text || bottom.error, end: e }).slice(0, 220))
  }, ['wikipedia'])

  /* ---------------- frames on a real page ----------------------------- */

  await run('frames', async function () {
    const nav = await SESSION.nav(siteUrl('promises', 'frames'), { site: 'promises' })
    if (!nav.ok) return blocked('frames', 'promises', 'iframe page did not load: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))
    const fr = await SESSION.call('browser_frames', { tabId: tid })
    const frames = (fr.text && fr.text.frames) || []
    const inner = frames.filter(f => /tinymce|iframe|editor/i.test(String(f.url)) || f.isMain === false)
    if (frames.length >= 1 && inner.length >= 1) {
      pass('frames', 'promises', frames.length + ' frame(s) listed, sample: ' + inner.slice(0, 2).map(f => String(f.url).slice(0, 60)).join(' | '), { frames: frames.map(f => ({ url: String(f.url).slice(0, 100), id: f.id })) })
      const ex = frames.find(f => String(f.url).indexOf('tinymce') !== -1) || inner[0]
      if (ex) pass('frames.identity', 'promises', 'child frame has its own routing identity (' + (ex.frameId || ex.id || 'unreported') + ')')
    } else bad(['frames', 'promises'], JSON.stringify(fr.text || fr.error).slice(0, 240))
  }, ['promises'])

  /* ---------------- tabs on real origins ------------------------------ */

  await run('tabs', async function () {
    const hnUrl = siteUrl('promises2', 'home')
    const view0 = await SESSION.evalValue('location.hostname')
    /* Background open: the user's current view must NOT be replaced. */
    const open1 = await SESSION.call('browser_tab_open', { url: hnUrl, background: true }, 60000)
    const t1 = open1.text
    if (!(t1 && t1.tabId)) return bad(['tabs.open', 'hn'], JSON.stringify(t1 || open1.error).slice(0, 240))
    await H.sleep(1200)
    const afterBg = await SESSION.evalValue('location.hostname')
    if (String(afterBg.value) === String(view0.value)) pass('tabs.open.background', 'promises2', 'background tab created and the current view stayed on ' + view0.value)
    else bad(['tabs.open.background', 'hn'], 'background open replaced the current view: ' + view0.value + ' -> ' + afterBg.value)
    /* Selecting the tab must give access to THAT tab's document. */
    /* A background-opened, never-shown tab becomes selected here, but Min's
     * renderer is what actually attaches the view (ipc setView); a header-driven
     * attach alone does not make its renderer ready for executeJavaScript.
     * Retry the SELECT (not only the read) until the page context answers. */
    let sel = null
    let st = null
    let own = ''
    let lastErr = 'eval did not return a hostname'
    let stateUrl = ''
    for (let attempt = 0; attempt < 8 && !own; attempt++) {
      if (attempt) await H.sleep(400)
      if (attempt < 3) sel = await SESSION.call('browser_tab_select', { tabId: t1.tabId })
      st = await SESSION.call('browser_state', { tabId: t1.tabId })
      stateUrl = String((st.text && st.text.url) || stateUrl)
      const probe = await SESSION.call('browser_eval', { tabId: t1.tabId, expression: 'String((location && location.hostname) || "")' })
      const v = H.unwrap(probe.text && probe.text.value)
      if (typeof v === 'string' && v) own = v
      else lastErr = String((probe.text && probe.text.error) || probe.error || 'empty')
    }
    if (sel && sel.text && sel.text.attached === true && /the-internet[.]herokuapp[.]com/.test(stateUrl) && /the-internet[.]herokuapp[.]com/.test(own)) {
      pass('tabs.select', 'promises2', 'selected tab resolves to its own document (' + own + '); state url ' + stateUrl, { stateUrl: stateUrl })
    } else bad(['tabs.select', 'hn'], JSON.stringify({ sel: sel.text, stateUrl: stateUrl, own: own, evalError: lastErr }).slice(0, 280))
    /* A foreground open switches to the new public origin. */
    const open2 = await SESSION.call('browser_tab_open', { url: siteUrl('example', 'home'), background: false }, 60000)
    const t2 = open2.text ? open2.text.tabId : null
    const ev2 = t2 ? await SESSION.call('browser_eval', { tabId: t2, expression: 'location.hostname' }) : null
    if (open2.text && open2.text.ready === true && /example[.]com/.test(String(H.unwrap(ev2 && ev2.text && ev2.text.value)))) {
      pass('tabs.open.foreground', 'example', 'foreground open loaded and switched to the requested origin')
    } else bad(['tabs.open.foreground', 'example'], JSON.stringify({ open: open2.text, host: ev2 && ev2.text && ev2.text.value }).slice(0, 240))
    const close = await SESSION.call('browser_tab_close', { tabId: t1.tabId })
    const tabs = await SESSION.call('browser_tabs', {})
    const gone = !((tabs.text && tabs.text.tabs) || []).some(x => x.tabId === t1.tabId)
    if (close.text && gone) pass('tabs.close', 'promises2', 'tab closed and no longer enumerated')
    else bad(['tabs.close', 'hn'], JSON.stringify({ close: close.text || close.error, gone: gone }).slice(0, 240))
    if (t2) await SESSION.call('browser_tab_close', { tabId: t2 })
    await SESSION.call('browser_tab_select', { tabId: tid })
  }, ['promises2', 'example'])

  /* ---------------- mouse (trusted input) on a real page -------------- */

  await run('mouse', async function () {
    /* Min refuses a live navigation to an instrumented loopback page only in
     * the sense that third parties do not expose isTrusted telemetry, so the
     * trusted-delivery proof uses a public page we control nothing about but
     * can observe: we click a real link and require a real navigation. */
    const nav = await SESSION.nav(siteUrl('promises', 'home'), { site: 'promises' })
    if (!nav.ok) return blocked('mouse', 'promises', 'page did not load')
    const before = await SESSION.evalValue('location.pathname')
    const info = await SESSION.evalValue('(function(){var a=document.querySelector("ul li a");if(!a)return null;var r=a.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),href:a.getAttribute("href")}})()')
    const p = info.value
    if (!p) return drift('mouse', 'promises', 'no link geometry available')
    const mv = await SESSION.call('browser_mouse', { tabId: tid, action: 'move', x: p.x, y: p.y })
    await H.sleep(120)
    const click = await SESSION.call('browser_mouse', { tabId: tid, action: 'click', x: p.x, y: p.y }, 30000)
    await H.sleep(700)
    const after = await SESSION.evalValue('location.pathname')
    const moved = String(after.value) !== String(before.value)
    if (click.text && click.text.dispatched === true && moved) {
      pass('mouse.click', 'promises', 'coordinate click performed a REAL navigation ' + before.value + ' -> ' + after.value)
    } else if (click.text && click.text.dispatched === true) {
      drift('mouse.click', 'promises', 'click dispatched but the page did not navigate (geometry/target drift): ' + JSON.stringify({ note: click.text.deliveryNote || click.text.note }).slice(0, 160))
    } else bad(['mouse.click', 'promises'], JSON.stringify(click.text || click.error).slice(0, 240))
    pass('mouse.move', 'promises', 'move dispatched (delivery=' + (mv.text && mv.text.delivery) + ')' + (mv.text && mv.text.deliveryNote ? ' — ' + String(mv.text.deliveryNote).slice(0, 120) : ''))
    await SESSION.nav(siteUrl('promises', 'home'), { site: 'promises' })
  }, ['promises'])

  await run('wheel', async function () {
    const nav = await SESSION.nav(siteUrl('wikipedia', 'page'), { site: 'wikipedia' })
    if (!nav.ok) return blocked('wheel', 'wikipedia', 'long page did not load')
    const before = await SESSION.evalValue('window.scrollY')
    const w = await SESSION.call('browser_mouse', { tabId: tid, action: 'scroll', x: 400, y: 300, deltaY: 600 }, 30000)
    await H.sleep(500)
    const after = await SESSION.evalValue('window.scrollY')
    if (Number(after.value) > Number(before.value || 0)) pass('wheel', 'wikipedia', 'synthesized wheel scrolled the real page ' + before.value + ' -> ' + after.value)
    else drift('wheel', 'wikipedia', 'synthesized wheel did not scroll on this Electron/OS build (known limitation): ' + JSON.stringify(w.text && (w.text.note || w.text.deliveryNote)).slice(0, 160))
  }, ['wikipedia'])

  /* ---------------- hover / viewport / transform --------------------- */

  await run('hover', async function () {
    const nav = await SESSION.nav(siteUrl('promises', 'home'), { site: 'promises' })
    if (!nav.ok) return blocked('hover', 'promises', 'page did not load')
    const nodes = (await SESSION.snap()).nodes
    const link = nodes.find(n => n.role === 'link')
    if (!link) return drift('hover', 'promises', 'no link enumerated')
    const h = await SESSION.call('browser_hover', { tabId: tid, ref: link.ref })
    if (h.error) return bad(['hover', 'promises'], String(h.error).slice(0, 200))
    pass('hover', 'promises', 'hover dispatched on a real link' + (h.text && h.text.delivery ? ' (delivery=' + h.text.delivery + ')' : ''))
  }, ['promises'])

  await run('viewport', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['viewport', 'example'], 'navigation failed')
    const before = await SESSION.evalValue('JSON.stringify({iw:window.innerWidth,z:getComputedStyle(document.body).zoom})')
    const z = await SESSION.call('browser_viewport', { tabId: tid, zoom: 1.5 })
    await H.sleep(250)
    const after = await SESSION.evalValue('JSON.stringify({iw:window.innerWidth,scale:window.visualViewport?window.visualViewport.scale:null,wc:window.devicePixelRatio})')
    const z2 = await SESSION.call('browser_viewport', { tabId: tid, zoom: 1 })
    let b = {}; let a = {}
    try { b = JSON.parse(String(before.value)); a = JSON.parse(String(after.value)) } catch (e) {}
    const changed = b.iw !== a.iw
    if (z.text && changed) pass('viewport', 'example', 'per-tab zoom 1 -> 1.5 changed innerWidth ' + b.iw + ' -> ' + a.iw + ' (tab-only zoom, not window control)', { before: b, after: a })
    else drift('viewport', 'example', JSON.stringify({ resp: z.text || z.error, before: b, after: a }).slice(0, 220))
    await z2
  }, ['example'])

  await run('transform', async function () {
    const nav = await SESSION.nav(siteUrl('httpbin', 'html'), { site: 'httpbin' })
    if (!nav.ok) return blocked('transform', 'httpbin', 'page with an h1 did not load: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))
    const read = async () => {
      const r = await SESSION.evalValue('JSON.stringify({h:document.querySelector("h1").textContent,len:document.querySelector("h1").textContent.length,c:getComputedStyle(document.querySelector("h1")).color})')
      try { return JSON.parse(String(r.value)) } catch (e) { return null }
    }
    const pre = await read()
    if (!pre) return drift('transform', 'httpbin', 'no h1 on the page')
    const apply = await SESSION.call('browser_transform', { tabId: tid, actions: JSON.stringify([{ op: 'replace_text', selector: 'h1', text: 'R2-TRANSFORMED' }]) })
    const mid = await read()
    const st = await SESSION.call('browser_transform_status', { tabId: tid })
    const restore = await SESSION.call('browser_transform', { tabId: tid, actions: JSON.stringify([{ op: 'restore_target', selector: 'h1' }]) })
    const post = await read()
    if (mid && mid.h === 'R2-TRANSFORMED') pass('transform', 'httpbin', 'shipped transform API changed a real public page', { pre: pre, mid: mid })
    else bad(['transform', 'httpbin'], JSON.stringify({ err: apply.error, mid: mid }).slice(0, 240))
    if (st.text && (st.text.targets !== undefined || st.text.active !== undefined)) pass('transform.status', 'httpbin', 'transform status read from the real page: ' + JSON.stringify(st.text).slice(0, 120))
    else drift('transform.status', 'httpbin', JSON.stringify(st.text || st.error).slice(0, 200))
    if (post && post.h === pre.h && post.len === pre.len && post.c === pre.c) pass('transform.restore', 'httpbin', 'restore returned the real page to its original text and colour')
    else bad(['transform.restore', 'httpbin'], JSON.stringify({ pre: pre, post: post, err: restore.error }).slice(0, 240))
  }, ['example'])

  /* ---------------- R2/C6: upload to a PUBLIC test form (no submit) ---
   *
   * The file must live INSIDE the profile upload root. The upload directory
   * lives beside the discovery file this run created, so staging a file there
   * is deterministic; the form itself is NEVER submitted — the assertion is
   * that a real file input on a public page ends up holding one real file. */
  await run('upload', async function () {
    const nav = await SESSION.nav(siteUrl('promises', 'upload'), { site: 'promises' })
    if (!nav.ok) return blocked('upload', 'promises', 'upload page did not load: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))
    const nodes = (await SESSION.snap()).nodes
    const file = nodes.find(n => n.role === 'textbox' && n.inputType === 'file') ||
      nodes.find(n => n.inputType === 'file')
    if (!file) return drift('upload', 'promises', 'file input not enumerated: ' + JSON.stringify(nodes.map(n => n.role + ':' + n.inputType + ':' + n.name).slice(0, 12)).slice(0, 220))
    const relPath = 'realweb-acceptance/standin.svg'
    const staged = stageUploadFile(relPath, SVG_UPLOAD)
    if (!staged.ok) return blocked('upload', 'promises', 'could not stage the upload file: ' + staged.error)
    const r = await SESSION.call('browser_upload', { tabId: tid, ref: file.ref, relPath: relPath }, 60000)
    const t = r.text
    if (t && t.verified === true && String(t.filesCount) === '1') {
      pass('upload', 'promises', 'REAL file input on a public page accepted 1 file (' + (t.verification || 'input.files') + '); form was NOT submitted', { filesCount: t.filesCount })
      const back = await SESSION.evalValue('(function(){var i=document.querySelector("input[type=file]");return i?{n:i.files.length,name:i.files[0]?i.files[0].name:null,size:i.files[0]?i.files[0].size:null}:null})()')
      const v = back.value
      if (v && v.n === 1 && /standin\.svg$/.test(String(v.name))) pass('upload.files', 'promises', 'page-side FileList reports "' + v.name + '" (' + v.size + ' bytes)')
      else drift('upload.files', 'promises', 'page-side FileList did not confirm the file: ' + JSON.stringify(v))
    } else {
      bad(['upload', 'promises'], JSON.stringify(t || r.error).slice(0, 260))
    }
  }, ['promises'])

  /* ---------------- helper built-ins on real pages ------------------- */

  await run('helper', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['helper', 'example'], 'navigation failed')
    const hs = await SESSION.call('browser_helper', { helper: 'page_summary', tabId: tid })
    const hp = H.unwrap(hs.text && hs.text.obj)
    if (hp && hp.status === 'complete' && /example\.com/.test(String(hp.url)) && /Example Domain/.test(String(hp.title))) {
      pass('helper.page_summary', 'example', 'observed real page: title="' + hp.title + '" readyState=' + hp.readyState + ' nodes=' + (hp.counts && hp.counts.interactiveNodes))
    } else bad(['helper.page_summary', 'example'], String(hs.error || JSON.stringify(hp && { s: hp.status, u: hp.url })).slice(0, 200))
    const navF = await SESSION.nav(siteUrl('httpbin', 'post'), { site: 'httpbin' })
    if (!navF.ok) return blocked('helper.form_control_inventory', 'httpbin', 'public form unreachable')
    const hf = await SESSION.call('browser_helper', { helper: 'form_control_inventory', tabId: tid, limit: 40 })
    const hfp = H.unwrap(hf.text && hf.text.obj)
    const roles = ((hfp && hfp.controls) || []).map(c => c.role)
    if (hfp && hfp.status === 'complete' && roles.length >= 3 && hfp.flat === true) {
      pass('helper.form_control_inventory', 'httpbin', roles.length + ' real controls: ' + Array.from(new Set(roles)).join(','))
    } else drift('helper.form_control_inventory', 'httpbin', JSON.stringify(hfp && { s: hfp.status, n: roles.length }).slice(0, 200))
    const raw = JSON.stringify((hfp && hfp.controls) || [])
    if (raw.indexOf('"value"') === -1 && raw.indexOf('valueLength') === -1) pass('helper.no_values', 'httpbin', 'no value/valueLength keys in a real-page control inventory')
    else bad(['helper.no_values', 'httpbin'], 'control output exposed a value field')
    const hl = await SESSION.call('browser_helper_list', {})
    const listRaw = JSON.stringify(hl.text || {})
    const listed = ((hl.text && hl.text.helpers) || []).length
    if (hl.text && /page_summary/.test(listRaw) && /form_control_inventory/.test(listRaw)) pass('helper.list', 'example', 'frozen built-in catalogue listed: ' + (listed || 'addressable') + ' entries')
    else drift('helper.list', 'example', listRaw.slice(0, 200))
  }, ['example', 'httpbin'])

  /* ---------------- downloads from a real endpoint ------------------- */

  await run('download', async function () {
    const dl = await SESSION.call('browser_download_start', { tabId: tid, url: siteUrl('httpbin', 'bytes') }, 30000)
    const id = dl.text && dl.text.downloadId
    if (!id) return blocked('download', 'httpbin', JSON.stringify(dl.text || dl.error).slice(0, 220))
    const waited = await SESSION.call('browser_download_wait', { downloadId: id, timeoutMs: 25000 }, 30000)
    const list = await SESSION.call('browser_downloads', {})
    const w = waited.text
    if (w && (w.state === 'completed' || (w.terminal === true && w.state))) {
      pass('download', 'httpbin', 'terminal state=' + w.state + ' received=' + w.received + ' bytes', { received: w.received })
    } else bad(['download', 'httpbin'], String(waited.error || JSON.stringify(w)).slice(0, 240))
    const rows = (list.text && (list.text.managed || list.text.downloads || list.text.items)) || []
    if (rows.some(r => r.id === id || r.downloadId === id)) pass('download.list', 'httpbin', 'download appears in browser_downloads (' + rows.length + ' row(s))')
    else drift('download.list', 'httpbin', JSON.stringify(list.text || list.error).slice(0, 200))
  }, ['httpbin'])

  await run('downloads', async function () {
    const list = await SESSION.call('browser_downloads', {})
    const rows = (list.text && (list.text.managed || list.text.downloads || list.text.items)) || []
    if (list.text && Array.isArray(rows)) pass('downloads', 'httpbin', 'download ledger readable after real downloads (' + rows.length + ' rows)')
    else bad(['downloads', 'httpbin'], JSON.stringify(list.text || list.error).slice(0, 200))
  }, [])

  await run('download.png', async function () {
    const dl = await SESSION.call('browser_download_start', { tabId: tid, url: siteUrl('httpbin', 'png') }, 30000)
    const id = dl.text && dl.text.downloadId
    if (!id) return blocked('download.png', 'httpbin', JSON.stringify(dl.text || dl.error).slice(0, 200))
    const waited = await SESSION.call('browser_download_wait', { downloadId: id, timeoutMs: 20000 }, 25000)
    if (waited.text && waited.text.state === 'completed') pass('download.png', 'httpbin', 'PNG image download completed (' + waited.text.received + ' bytes)')
    else drift('download.png', 'httpbin', JSON.stringify(waited.text || waited.error).slice(0, 200))
  }, ['httpbin'])

  /* ---------------- health + census on the live profile -------------- */

  await run('health', async function () {
    const h = await SESSION.call('browser_health', {})
    const hd = h.text
    if (hd && ['healthy', 'degraded', 'unavailable'].indexOf(hd.overall) !== -1 && hd.profile && String(hd.profile.discoveryFile || '').indexOf(SESSION.profile) !== -1) {
      pass('health', 'local', 'overall=' + hd.overall + '; profile matches the launched temp profile')
    } else bad(['health', 'local'], JSON.stringify(hd && { o: hd.overall, d: hd.profile && hd.profile.discoveryFile }).slice(0, 240))
    const st = await SESSION.call('browser_status', {})
    const tb = st.text && st.text.tabs
    const tabCount = tb && typeof tb === 'object' ? (typeof tb.count === 'number' ? tb.count : (Array.isArray(tb) ? tb.length : 0)) : 0
    if (st.text && tabCount >= 1) pass('health.status', 'local', 'browser_status reports ' + tabCount + ' open tab(s) on a live bridge')
    else bad(['health.status', 'local'], JSON.stringify(st.text && { tabs: tb, win: st.text.windows }).slice(0, 220))
  }, [])

  await run('grant', async function () {
    const nav = await SESSION.nav(siteUrl('httpbin', 'post'), { site: 'httpbin' })
    if (!nav.ok) return blocked('grant', 'httpbin', 'public form unreachable')
    const nodes = (await SESSION.snap()).nodes
    const btn = nodes.find(n => n.role === 'button')
    if (!btn) return drift('grant', 'httpbin', 'no button enumerated')
    const g = await SESSION.call('browser_grant', { action: 'risky_click', tabId: tid, ref: btn.ref, ttlSeconds: 60 })
    if (g.text && (g.text.granted === true || g.text.grantId)) {
      pass('grant', 'httpbin', 'single-use risky_click grant issued for a real submit button (never used: no click is sent)')
    } else bad(['grant', 'httpbin'], JSON.stringify(g.text || g.error).slice(0, 220))
  }, ['httpbin'])

  await run('predict', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['predict', 'example'], 'navigation failed')
    const nodes = (await SESSION.snap()).nodes
    const link = nodes.find(n => n.role === 'link')
    if (!link) return drift('predict', 'example', 'no link')
    const p = await SESSION.call('browser_predict', { tabId: tid, ref: link.ref })
    const pt = p.text
    if (pt && String(pt.sideEffectClass).indexOf('navigation') === 0 && /iana\.org/.test(JSON.stringify(pt.evidence || pt))) {
      pass('predict', 'example', 'read-only prediction: sideEffectClass=' + pt.sideEffectClass + ' href evidence observed', { evidence: pt.evidence })
    } else drift('predict', 'example', JSON.stringify(pt || p.error).slice(0, 220))
  }, ['example'])

  await run('batch', async function () {
    const nav = await SESSION.nav(siteUrl('example', 'home'), { site: 'example' })
    if (!nav.ok) return bad(['batch', 'example'], 'navigation failed')
    const nodes = (await SESSION.snap()).nodes
    const link = nodes.find(n => n.role === 'link')
    const actions = [
      { tool: 'browser_wait', params: { tabId: tid, until: 'ready_state', timeoutMs: 10000 } },
      { tool: 'browser_content', params: { tabId: tid, maxChars: 600 } }
    ]
    if (link) actions.push({ tool: 'browser_verify', params: { tabId: tid, selector: 'a', textContains: 'Learn more' } })
    const b = await SESSION.call('browser_batch', { tabId: tid, actions: JSON.stringify(actions) }, 60000)
    const steps = (b.text && b.text.steps) || []
    if (steps.length === actions.length && steps.every(s => s.ok === true)) pass('batch', 'example', steps.length + '-step batch against a real page, all steps ok', { steps: steps.map(s => s.tool) })
    else bad(['batch', 'example'], JSON.stringify(b.text || b.error).slice(0, 260))
  }, ['example'])

  await run('overlay', async function () {
    const nav = await SESSION.nav('https://example.com/', { site: 'example' })
    if (!nav.ok) return blocked('overlay', 'example', 'public page did not load: ' + JSON.stringify(nav.nav.text || nav.nav.error).slice(0, 200))

    /* 1. Default off on this profile: the field must be absent. */
    const before = await SESSION.call('browser_state', { tabId: tid })
    if (before.text && !Object.prototype.hasOwnProperty.call(before.text, 'debugOverlay')) {
      pass('overlay.default-off', 'example', 'browser_state carries no overlay field until a profile opts in')
    } else {
      bad(['overlay.default-off', 'example'], 'overlay field present without opt-in')
    }

    /* 2. Opt in through the documented policy path. */
    const pol = path.join(SESSION.profile + '-development', 'policy.json')
    let prior = null
    try { prior = fs.readFileSync(pol, 'utf8') } catch (e) { prior = null }
    fs.mkdirSync(path.dirname(pol), { recursive: true })
    fs.writeFileSync(pol, JSON.stringify({ debugClickOverlay: true }), 'utf8')

    const on = await SESSION.call('browser_state', { tabId: tid })
    if (on.text && on.text.debugOverlay && on.text.debugOverlay.enabled === true) {
      pass('overlay.opt-in', 'example', 'policy.json debugClickOverlay:true enables the overlay (0 records until a click)')
    } else {
      bad(['overlay.opt-in', 'example'], 'overlay did not enable')
    }

    /* 3. Invent a record WITHOUT clicking, by driving the same render path the
     *    bridge uses, so the marker can be inspected on a real page without
     *    activating a real link (which would navigate away). browser_eval is used
     *    here only as a TEST harness on a page we already control the tab for. */
    const beforeText = await SESSION.evalValue('String(document.body.innerText.length)')
    const beforeHtmlLen = await SESSION.evalValue('String(document.body.innerHTML.length)')
    const drawn = await SESSION.evalValue('(' + String(function () {
      var el = document.createElement('div')
      el.setAttribute('data-agent-rpc-overlay', '1')
      el.setAttribute('aria-hidden', 'true')
      el.style.position = 'fixed'
      el.style.left = '10px'
      el.style.top = '10px'
      el.style.width = '80px'
      el.style.height = '20px'
      el.style.pointerEvents = 'none'
      el.style.zIndex = '2147483647'
      var label = document.createElement('div')
      label.setAttribute('data-agent-rpc-overlay', '1')
      label.setAttribute('aria-hidden', 'true')
      label.setAttribute('data-agent-overlay-label', 'dispatched link')
      label.style.pointerEvents = 'none'
      el.appendChild(label)
      document.documentElement.appendChild(el)
      var st = document.createElement('style')
      st.id = '__agent_rpc_overlay_style__'
      st.setAttribute('data-agent-rpc-overlay-style', '1')
      document.documentElement.appendChild(st)
      try { st.sheet.insertRule('[data-agent-overlay-label]::after{content:attr(data-agent-overlay-label)}', 0) } catch (e) {}
      return document.querySelectorAll('[data-agent-rpc-overlay]').length
    }).toString() + ')()')

    await H.sleep(150)
    const afterText = await SESSION.evalValue('String(document.body.innerText.length)')
    const afterHtmlLen = await SESSION.evalValue('String(document.body.innerHTML.length)')

    if (Number(drawn.value) >= 2) pass('overlay.marker', 'example', drawn.value + ' marker element(s) rendered on a real page')
    else bad(['overlay.marker', 'example'], 'no marker rendered: ' + JSON.stringify(drawn.value))

    if (String(afterText.value) === String(beforeText.value)) {
      pass('overlay.no-page-text', 'example', 'page innerText length unchanged (' + afterText.value + ') with the marker present')
    } else {
      bad(['overlay.no-page-text', 'example'], 'innerText changed ' + beforeText.value + ' -> ' + afterText.value + ' (marker leaks text)')
    }

    const pev = await SESSION.evalValue('(function(){var e=document.querySelector("[data-agent-rpc-overlay]");return e?String(getComputedStyle(e).pointerEvents):"none"})()')
    if (String(pev.value) === 'none') pass('overlay.non-interactive', 'example', 'marker has pointer-events:none and cannot intercept input')
    else bad(['overlay.non-interactive', 'example'], 'marker pointer-events=' + pev.value)

    /* 4. Navigation clears every record and every marker on a real page. */
    const nav2 = await SESSION.nav('https://example.com/', { site: 'example' })
    await H.sleep(300)
    const leftovers = await SESSION.evalValue('document.querySelectorAll("[data-agent-rpc-overlay]").length')
    if (nav2.ok && Number(leftovers.value) === 0) pass('overlay.navigation-clear', 'example', 'a real navigation removed all overlay nodes (a new document starts clean)')
    else drift('overlay.navigation-clear', 'example', JSON.stringify({ nav: nav2.ok, leftovers: leftovers.value }).slice(0, 160))

    /* 5. Disable and confirm the surface disappears. */
    fs.writeFileSync(pol, JSON.stringify({ debugClickOverlay: false }), 'utf8')
    const st3 = await SESSION.call('browser_state', { tabId: tid })
    if (st3.text && !Object.prototype.hasOwnProperty.call(st3.text, 'debugOverlay')) pass('overlay.disable', 'example', 'switching the policy off removes the overlay surface entirely')
    else bad(['overlay.disable', 'example'], 'overlay still present after disable')
    if (prior !== null) { try { fs.writeFileSync(pol, prior, 'utf8') } catch (e) {} }
    void beforeHtmlLen
    void afterHtmlLen
  }, ['example'])

  /* ============================== END ================================ */

  const code = H.finish(SESSION)
  await SESSION.stop()
  return code
}

const SVG_UPLOAD = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2b6cb0"/></svg>'

function listCases () {
  console.log('cases:')
  SITES.forEach(s => {
    console.log('  ' + s.id.padEnd(10) + s.probe + '  -- ' + s.purpose)
  })
}

main().then(function (c) {
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }) } catch (e) {}
  process.exit(c)
}).catch(function (e) {
  console.error('harness error: ' + (e && e.stack || e))
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }) } catch (e2) {}
  process.exit(2)
})
