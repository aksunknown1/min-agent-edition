/*
 * Shared REAL-WEB harness for Min Agent Edition probes.
 *
 * WHY THIS EXISTS
 *   A capability is only proven when it works on the actual web. Local
 *   fixtures remain the deterministic authority for edge cases, but every
 *   probe built on this module drives public pages through the REAL product
 *   path:
 *
 *     scripts/min-launch.js  ->  Min / Electron  ->  bridge  ->
 *     mcp/min-agent-mcp.js (stdio JSON-RPC)  ->  tools/call
 *
 *   Probes never reach into Electron internals and never call the loopback
 *   bridge HTTP endpoint directly: if the shipped adapter cannot reach a
 *   capability, the capability is not shipped.
 *
 * SAFETY
 *   - One Min instance per probe, fresh temp profile, PIDs tracked here;
 *     cleanup is /PID-targeted only (never /IM, never name-wide).
 *   - Third parties are READ-ONLY: navigate, read, screenshot. The only
 *     mutation performed on a public page is typing into a public test form
 *     that is never submitted.
 *   - browser_eval, browser_transform and browser_upload run only on pages
 *     that are either (a) a public test form we do not submit or (b) a
 *     deterministic LOOPBACK stand-in. Nothing is posted, signed up,
 *     purchased or messaged, and no third-party server is asked to accept a
 *     mutation.
 *
 * STAND-IN FIDELITY (why the comment inside each script matters)
 *   A servable top-level navigation needs a certificate Chromium accepts. The
 *   local stand-in therefore serves over plain LOOPBACK http and the harness
 *   navigates to `http://127.0.0.1:PORT/<host>/<path>` while pinning the
 *   logical URL `https://<host>/<path>` for every assertion.
 *
 *   The harness reports the stand-in under a SEPARATE verdict key
 *   (`standinVerdict`). It is proof that the capability works on a
 *   document of the same shape; it is NOT counted as a real-web pass.
 *
 * DETERMINISM
 *   Real sites drift, rate-limit and go offline. The recorded network
 *   preflight decides `network.mode`:
 *     LIVE     the pinned origin answers -> assertions run on the real page
 *     OFFLINE  the origin is unreachable -> stand-in assertions still run and
 *              are labelled `mode:'standin'`; they never inflate the LIVE
 *              verdict, and `verdict.ok` stays false until a LIVE run is green.
 *
 * STATUS VOCABULARY: PASS / FAIL / BLOCKED / DRIFT (see
 * docs/audit/TEST-STRATEGY-AND-COVERAGE.md).
 */

const { spawn, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const MCP = path.join(ROOT, 'mcp', 'min-agent-mcp.js')
const LAUNCHER = path.join(ROOT, 'scripts', 'min-launch.js')
const WIN32 = process.platform === 'win32'
const CANONICAL_TOOL_COUNT = 39

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* Network preflight: one cheap request, never a page load            */
/* ------------------------------------------------------------------ */

function requestOnce (url, timeoutMs) {
  return new Promise(function (resolve) {
    let settled = false
    const finish = function (v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    let req = null
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return finish({ ok: false, error: 'unsupported scheme' })
      req = (u.protocol === 'https:' ? require('https') : http).request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; MinRealWebAccept/1.0)', accept: '*/*' }
      }, function (res) {
        try { res.resume() } catch (e) {}
        finish({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, error: null })
      })
    } catch (e) { return finish({ ok: false, error: String(e && e.message).slice(0, 120) }) }
    const timer = setTimeout(function () {
      try { req.destroy() } catch (e) {}
      finish({ ok: false, error: 'timeout after ' + timeoutMs + 'ms' })
    }, timeoutMs || 8000)
    req.on('error', function (e) { finish({ ok: false, error: String(e && e.message).slice(0, 120) }) })
    req.end()
  })
}

/* ------------------------------------------------------------------ */
/* Stand-in web: loopback pages for the endpoints a suite pins        */
/* ------------------------------------------------------------------ */

function listenOnce (server) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', function () { resolve(server.address().port) })
  })
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
)

function noteInstrumentation () {
  return '<script>window.__delivered={mouse:[],key:[],pointer:[],wheel:[]};window.__trusted={mouse:true,key:true,pointer:true,wheel:true};' +
    'function __note(kind,e){var d=window.__delivered[kind];if(!d)return;d.push({t:!!e.isTrusted,x:(e.clientX||0),y:(e.clientY||0),k:(e.key||null),type:e.type});if(!e.isTrusted)window.__trusted[kind]=false;}' +
    'document.addEventListener("mousemove",function(e){__note("mouse",e)},true);' +
    'document.addEventListener("mousedown",function(e){__note("mouse",e)},true);' +
    'document.addEventListener("mouseup",function(e){__note("mouse",e)},true);' +
    'document.addEventListener("click",function(e){__note("mouse",e)},true);' +
    'document.addEventListener("pointerdown",function(e){__note("pointer",e)},true);' +
    'document.addEventListener("wheel",function(e){__note("wheel",e)},{capture:true,passive:true});' +
    'document.addEventListener("keydown",function(e){__note("key",e)},true);' +
    'document.addEventListener("beforeinput",function(e){window.__delivered.key.push({t:!!e.isTrusted,k:"beforeinput",x:0,y:0,type:e.inputType});if(!e.isTrusted)window.__trusted.key=false;},true);' +
    '</script>'
}

function genericPage (host, opts) {
  const o = opts || {}
  const tall = o.tall ? '<div id="spacer" style="height:2600px;background:linear-gradient(180deg,#fff,#dde)">spacer</div><div id="bottom" style="height:320px;background:#2b6cb0;color:#fff;font-size:40px">BOTTOM MARKER</div>' : ''
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + (o.title || (host + ' stand-in')) + '</title>' + (o.instrument ? noteInstrumentation() : '') + '</head><body style="margin:0;font-family:sans-serif">' +
    '<h1 id="h1">' + (o.heading || (host + ' stand-in')) + '</h1>' +
    (o.searchQuery ? '<p id="qout">You searched for: ' + o.searchQuery + '</p>' : '') +
    '<div id="pad" style="position:relative;width:900px;height:700px;background:linear-gradient(90deg,#eef,#bbc)">' +
    '<div id="target" style="position:absolute;left:40px;top:40px;width:220px;height:60px;background:#2b6cb0;color:#fff;font-size:18px">Target</div>' +
    '<input id="field" type="text" style="position:absolute;left:40px;top:140px;width:240px">' +
    '<iframe id="frame1" src="' + (o.frameSrc || 'about:blank') + '" width="360" height="200" style="position:absolute;left:40px;top:220px"></iframe>' +
    '</div>' + tall + (o.extra || '') + '</body></html>'
}

const PAGES = {
  '/': function (host, q) { return genericPage(host, { searchQuery: q }) },
  '/html': function () {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Herman Melville - Moby-Dick</title></head><body>' +
      '<h1>Herman Melville - Moby-Dick</h1><div>' +
      '<p>Call me Ishmael. Some years ago - never mind how long precisely - having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.</p>' +
      '<p>It is a way I have of driving off the spleen and regulating the circulation.</p></div></body></html>'
  },
  '/forms/post': function () {
    return '<!doctype html><html><head><meta charset="utf-8"><title>httpbin.org forms</title></head><body>' +
      '<h1>Form Test</h1><form method="post" action="/post">' +
      '<label for="custname">Customer name:</label><input type="text" name="custname" id="custname">' +
      '<label for="custemail">E-mail address:</label><input type="email" name="custemail" id="custemail">' +
      '<label for="size">Pizza Size:</label><input type="radio" name="size" value="small" checked> Small <input type="radio" name="size" value="medium"> Medium' +
      '<label for="topping">Pizza toppings:</label><input type="checkbox" name="topping" value="bacon"> Bacon <input type="checkbox" name="topping" value="cheese"> Cheese' +
      '<label for="delivery">Preferred delivery time:</label><input type="time" name="delivery">' +
      '<label for="comments">Delivery instructions:</label><textarea name="comments" rows="4" cols="40"></textarea>' +
      '<button type="submit">Submit order</button></form></body></html>'
  },
  '/web/web-form.html': function (host, q) {
    const tall = '?tall=1'
    return '<!doctype html><html><head><meta charset="utf-8"><title>Web form</title>' + (q ? '' : '') + '</head><body>' +
      '<form><input type="text" id="my-text-id" name="my-text" class="form-control">' +
      '<input type="password" name="my-password" class="form-control">' +
      '<textarea name="my-textarea" class="form-control" rows="3"></textarea>' +
      '<input type="text" name="my-disabled" class="form-control" disabled>' +
      '<input type="text" name="my-readonly" class="form-control" value="Readonly input" readonly>' +
      '<select name="my-select" class="form-select"><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></select>' +
      '<input type="file" name="my-file" class="form-control">' +
      '<input type="checkbox" name="my-check" id="my-check-1" class="form-check-input" checked>' +
      '<input type="checkbox" name="my-check" id="my-check-2" class="form-check-input">' +
      '<input type="radio" name="my-radio" id="my-radio-1" class="form-check-input" checked>' +
      '<input type="radio" name="my-radio" id="my-radio-2" class="form-check-input">' +
      '<input type="color" name="my-colors" class="form-control" value="#563d7c">' +
      '<input type="range" name="my-range" class="form-range" min="0" max="10" step="1" value="5">' +
      '<input type="hidden" name="my-hidden">' +
      '<button type="submit">Submit</button></form>' +
      '<img src="/web/pr.svg" alt="Min Canvas" width="320" height="200">' +
      (tall ? '<div style="height:2600px;background:linear-gradient(180deg,#fff,#dde)">spacer</div><div id="bottom" style="height:320px;background:#2b6cb0;color:#fff;font-size:40px">BOTTOM MARKER</div>' : '') +
      '</body></html>'
  },
  '/tags/att_input_readonly.asp': function () {
    return '<!doctype html><html><head><meta charset="utf-8"><title>HTML input readonly Attribute</title></head><body>' +
      '<h1>HTML input readonly Attribute</h1><p>A page with a REAL readonly input (not a code sample):</p>' +
      '<form><p>Country:</p><input type="text" id="country" name="country" value="Norway" readonly>' +
      '<p>Editable sibling:</p><input type="text" id="city" name="city" value="Oslo"></form></body></html>'
  },
  '/html/html5_canvas.asp': function () {
    return '<!doctype html><html><head><meta charset="utf-8"><title>HTML Canvas</title></head><body><h1>HTML Canvas</h1>' +
      '<canvas id="c1" width="240" height="120"></canvas>' +
      '<script>var c=document.getElementById("c1");var x=c.getContext("2d");x.fillStyle="#2b6cb0";x.fillRect(0,0,240,120);x.fillStyle="#fff";x.fillRect(4,4,8,8);</script></body></html>'
  },
  '/__page/blank': function () { return genericPage('blank', {}) },
  '/__page/echo': function () { return genericPage('Echo Lab', { title: 'Echo Lab', heading: 'Echo Lab', instrument: true, tall: true }) },
  '/__page/readonly': function () {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Readonly Lab</title></head><body><h1>Readonly Lab</h1>' +
      '<form><input id="ro" type="text" value="locked" readonly><input id="dis" type="text" value="disabled" disabled><input id="free" type="text" value=""></form></body></html>'
  },
  '/__page/inner': function () {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Inner Frame</title></head><body><h1 id="inner-h">Inner Frame</h1>' +
      '<button id="inner-btn">Inner Button</button><input id="inner-input" type="text"></body></html>'
  },
  '/__page/svg': function () {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#2b6cb0"/><text x="16" y="104" fill="#fff" font-size="20">Min stand-in</text></svg>'
  }
}

/* Map a logical public URL onto the loopback stand-in. The FIRST path
 * segment is the pinned host, so a pinned page's own fetch('/x') stays on the
 * stand-in under the same prefix and never reaches the real origin. */
function standInKey (url) {
  const u = new URL(url)
  return u.hostname + (u.port ? '_' + u.port : '')
}

class OfflineWeb {
  constructor () {
    this.server = null
    this.port = null
    this.pins = new Map()
    this.leakViolations = []
  }

  start () {
    const self = this
    this.server = http.createServer(function (req, res) {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const parts = u.pathname.split('/').filter(Boolean)
      const hostKey = parts.shift() || ''
      const p = '/' + parts.join('/')
      const q = u.searchParams.get('q')
      const send = function (code, type, body, extra) {
        res.writeHead(code, Object.assign({ 'content-type': type, 'cache-control': 'no-store' }, extra || {}))
        res.end(body)
      }
      /* Leak guard: a stand-in page trying to reach a real third party is
       * RECORDED so the run fails loudly instead of silently succeeding. */
      if (p === '/__leak') {
        self.leakViolations.push({ host: hostKey, target: String(u.searchParams.get('to') || '').slice(0, 160) })
        send(200, 'text/plain', 'recorded')
        return
      }
      if (p === '/redirect/2') { res.writeHead(302, { location: '/' + hostKey + '/redirect/1' }); res.end(); return }
      if (p === '/redirect/1') { res.writeHead(302, { location: '/' + hostKey + '/get' }); res.end(); return }
      if (p === '/delay/1' || p === '/delay/2') {
        setTimeout(function () {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ args: {}, url: 'https://' + hostKey + p }))
        }, p === '/delay/2' ? 2000 : 1000)
        return
      }
      if (p === '/get') {
        send(200, 'application/json; charset=utf-8', JSON.stringify({ args: {}, origin: '127.0.0.1', url: 'https://' + hostKey + '/get' }))
        return
      }
      if (p === '/bytes/2048') {
        const buf = Buffer.alloc(2048)
        for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff
        send(200, 'application/octet-stream', buf, { 'content-disposition': 'attachment; filename="bytes-2048.bin"', 'content-length': buf.length })
        return
      }
      if (p === '/image/png') { send(200, 'image/png', PNG_1PX, { 'content-length': PNG_1PX.length }); return }
      if (p === '/image/jpeg') { send(200, 'image/jpeg', JPEG_1PX, { 'content-length': JPEG_1PX.length }); return }
      if (p === '/image/svg' || p === '/web/pr.svg') {
        send(200, 'image/svg+xml', PAGES['/__page/svg']())
        return
      }
      if (p === '/__page/top') {
        const src = '/' + hostKey + '/__page/inner'
        send(200, 'text/html; charset=utf-8', genericPage(hostKey, { title: 'Frame Lab', heading: 'Frame Lab', frameSrc: src }))
        return
      }
      if (p === '/__page/nested') {
        const mid = '/' + hostKey + '/__page/top'
        send(200, 'text/html; charset=utf-8', genericPage(hostKey, { title: 'Nested Lab', heading: 'Nested Lab', frameSrc: mid }))
        return
      }
      const page = PAGES[p]
      if (page) { send(200, p.indexOf('/__page/svg') === 0 ? 'image/svg+xml' : 'text/html; charset=utf-8', page(hostKey, q)); return }
      if (p.indexOf('/html/') === 0 || p.indexOf('/tags/') === 0 || p.indexOf('/web/') === 0) {
        send(200, 'text/html; charset=utf-8', genericPage(hostKey + p, {}))
        return
      }
      send(200, 'text/html; charset=utf-8', genericPage(hostKey + p, { searchQuery: q }))
    })
    return listenOnce(this.server).then(function (port) { self.port = port; return self })
  }

  pin (url) {
    const key = standInKey(url)
    if (!this.pins.has(key)) this.pins.set(key, url)
    return 'http://127.0.0.1:' + this.port + '/' + key
  }

  /* logical https URL -> served loopback URL */
  rewrite (url) {
    const key = standInKey(url)
    if (!this.pins.has(key)) return url
    const u = new URL(url)
    return 'http://127.0.0.1:' + this.port + '/' + key + (u.pathname === '/' ? '/' : u.pathname) + u.search + u.hash
  }

  stop () { try { if (this.server) this.server.close() } catch (e) {} }
}

/* ------------------------------------------------------------------ */
/* MCP stdio client                                                   */
/* ------------------------------------------------------------------ */

function killTree (pid) {
  if (!pid) return
  try {
    if (WIN32) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true })
    else process.kill(-pid, 'SIGKILL')
  } catch (e) { /* already gone */ }
}

function makeAdapter (profileDir) {
  const proc = spawn(process.execPath, [MCP, '--profile=' + profileDir], {
    cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  const st = { proc: proc, pending: {}, nextId: 10, nonMcpStdout: [], stderr: '' }
  let buf = ''
  proc.stdout.on('data', function (d) {
    buf += d
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const frame = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!frame) continue
      let msg = null
      try { msg = JSON.parse(frame) } catch (e) { st.nonMcpStdout.push(frame); continue }
      if (msg.id !== undefined && msg.id !== null && st.pending[msg.id]) {
        const resolve = st.pending[msg.id]
        delete st.pending[msg.id]
        resolve(msg)
      }
    }
  })
  proc.stderr.on('data', function (d) { st.stderr += String(d) })
  st.request = function (method, params, timeoutMs) {
    const id = 'r' + (++st.nextId)
    return new Promise(function (resolve) {
      const timer = setTimeout(function () { delete st.pending[id]; resolve({ error: { message: 'client timeout' } }) }, timeoutMs || 45000)
      st.pending[id] = function (msg) { clearTimeout(timer); resolve(msg) }
      try {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }) + '\n')
      } catch (e) { clearTimeout(timer); resolve({ error: { message: 'stdin closed: ' + e.message } }) }
    })
  }
  st.notify = function (method) { try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method }) + '\n') } catch (e) {} }
  st.stop = function () { try { proc.stdin.end() } catch (e) {} ; killTree(proc.pid) }
  return st
}

/* browser_eval returns a typed envelope ({__t:"string",v:...}); unwrap it. */
function unwrap (n) {
  if (n === null || typeof n !== 'object') return n
  if (n.__t === 'undefined') return undefined
  if (n.__t === 'null') return null
  if (n.__t === 'string' || n.__t === 'number' || n.__t === 'boolean') return n.v
  if (n.__t === 'array') return Array.isArray(n.v) ? n.v.map(unwrap) : []
  if (n.__t === 'object') {
    const o = {}
    Object.keys(n).forEach(function (k) { if (k !== '__t' && k !== 'ctor') o[k] = unwrap(n[k]) })
    return o
  }
  return n
}

/* ------------------------------------------------------------------ */
/* RealWebSession                                                     */
/* ------------------------------------------------------------------ */

class RealWebSession {
  constructor (options) {
    const o = options || {}
    this.name = o.name || 'realweb'
    this.layer = o.layer || 'C'
    this.prefix = o.prefix || ('min-rw-' + this.name + '-' + Date.now())
    this.offline = o.offline === undefined ? true : !!o.offline
    this.runDir = path.join(os.tmpdir(), this.prefix)
    this.profile = path.join(this.runDir, 'profile')
    this.evidenceFile = o.evidenceFile || path.join(ROOT, 'docs', o.evidence || (this.name + '-realweb.json'))
    this.results = []
    this.sites = []
    this.launcher = null
    this.adapter = null
    this.tid = null
    this.web = null
    this.network = { mode: 'UNKNOWN', live: false, checks: [] }
    this.startedAt = null
  }

  /* ---------------- recording ---------------- */

  record (id, site, mode, status, detail, observed) {
    const r = {
      id: id,
      site: site,
      mode: mode,
      status: status,
      detail: detail === undefined ? null : detail,
      observed: observed === undefined ? null : observed,
      at: new Date().toISOString()
    }
    this.results.push(r)
    const tag = status === 'PASS' ? 'PASS   ' : status.padEnd(7)
    console.log(tag + '[' + (mode === 'standin' ? 'stand-in' : 'live') + '] [' + id + '] ' + (r.detail === null ? '' : String(r.detail).slice(0, 240)))
    return r
  }

  livePass (id, site, detail, observed) { return this.record(id, site, 'live', 'PASS', detail, observed) }
  liveFail (id, site, detail, observed) { return this.record(id, site, 'live', 'FAIL', detail, observed) }
  liveBlocked (id, site, detail, observed) { return this.record(id, site, 'live', 'BLOCKED', detail, observed) }
  liveDrift (id, site, detail, observed) { return this.record(id, site, 'live', 'DRIFT', detail, observed) }
  standInPass (id, detail, observed) { return this.record(id, 'standin', 'standin', 'PASS', detail, observed) }
  standInFail (id, detail, observed) { return this.record(id, 'standin', 'standin', 'FAIL', detail, observed) }
  standInBlocked (id, detail, observed) { return this.record(id, 'standin', 'standin', 'BLOCKED', detail, observed) }

  liveCheck (id, site, ok, detail, observed) {
    return ok ? this.livePass(id, site, detail, observed) : this.liveFail(id, site, detail, observed)
  }

  /* ---------------- preflight ---------------- */

  async preflight (sites) {
    const checks = []
    for (const s of sites) {
      const url = s.probe || null
      if (!url) continue
      const r = await requestOnce(url, 8000)
      checks.push({ site: s.id, url: url, ok: r.ok, status: r.status || 0, error: r.error || null })
      if (!r.ok) break
    }
    const live = checks.length > 0 && checks.every(c => c.ok)
    this.network = {
      mode: live ? 'LIVE' : 'OFFLINE',
      live: live,
      checks: checks,
      why: live
        ? 'every pinned origin answered from this machine'
        : ('origin unreachable: ' + (checks.filter(c => !c.ok).map(c => c.url + ' -> ' + (c.error || ('HTTP ' + c.status))).join('; ') || 'no probe'))
    }
    this.sites = sites
    return this.network
  }

  modeFor (siteId) {
    const s = this.sites.find(x => x.id === siteId)
    if (s && s.probe) {
      const c = this.network.checks.find(x => x.site === siteId)
      if (c && c.ok) return 'live'
      return 'standin'
    }
    return 'live'
  }

  /* ---------------- launch ---------------- */

  async start (sites) {
    this.startedAt = Date.now()
    fs.mkdirSync(this.profile, { recursive: true })
    const want = sites || []
    await this.preflight(want)

    if (this.offline) {
      this.web = await new OfflineWeb().start()
      for (const s of want) {
        for (const url of Object.values(s.urls || {})) {
          if (/^https?:\/\//.test(String(url))) this.web.pin(url)
        }
        if (s.probe) this.web.pin(s.probe)
      }
    }

    const startRaw = (want[0] && (want[0].startUrl || (want[0].urls && want[0].urls.home) || want[0].probe)) || 'https://example.com/'
    let firstUrl = this.url(startRaw)
    if (firstUrl === startRaw && !this.network.live) firstUrl = 'about:blank'

    this.launcher = spawn(process.execPath, [LAUNCHER, '--profile=' + this.profile, '--', firstUrl], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let errOut = ''
    this.launcher.stdout.on('data', function (d) { out += d })
    this.launcher.stderr.on('data', function (d) { errOut += d })
    const deadline = Date.now() + 90000
    while (Date.now() < deadline && out.indexOf('ready') === -1) await sleep(400)
    if (out.indexOf('ready') === -1) {
      const why = 'Min did not become ready within 90s; launcher said: ' +
        (out.split('\n').filter(Boolean).slice(0, 3).join(' | ') || '(nothing)') +
        (errOut ? ' stderr: ' + errOut.split('\n').filter(Boolean).slice(-2).join(' | ') : '')
      this.record('harness.launch', 'local', 'live', 'BLOCKED', why)
      return false
    }

    this.adapter = makeAdapter(this.profile)
    const init = await this.adapter.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: this.name, version: '0' } }, 20000)
    if (!init || !init.result) {
      this.record('harness.initialize', 'local', 'live', 'BLOCKED', JSON.stringify(init).slice(0, 200))
      return false
    }
    this.adapter.notify('notifications/initialized')

    const list = await this.adapter.request('tools/list', {}, 20000)
    const names = ((list.result && list.result.tools) || []).map(t => t.name)
    if (names.length !== CANONICAL_TOOL_COUNT) {
      this.record('harness.census', 'local', 'live', 'FAIL', 'adapter exposes ' + names.length + ' tools, expected ' + CANONICAL_TOOL_COUNT)
      return false
    }

    const tabs = await this.call('browser_tabs', {})
    const tl = (tabs.text && tabs.text.tabs) || []
    const tab = tl.find(t => t.active === true && t.windowId) || tl.find(t => t.focused === true && t.windowId) || tl.find(t => t.windowId) || null
    if (!tab) {
      this.record('harness.tab', 'local', 'live', 'BLOCKED', 'no attached tab enumerated (tabs=' + tl.length + ')',
        { tabs: tl.map(t => ({ u: String(t.url || '').slice(0, 60), w: t.windowId })) })
      return false
    }
    this.tid = tab.tabId
    this.livePass('harness.launch', 'local', 'Min ready; ' + names.length + '-tool adapter census; attached tab ' + this.tid)
    return true
  }

  /* enquireNet: does this site answer right now? Used by cases whose site was
   * not part of the preflight list. Results are cached for the run. */
  async siteLive (siteId) {
    const s = this.sites.find(x => x.id === siteId)
    if (!s || !s.probe) return true
    const cached = this.network.checks.find(c => c.site === siteId)
    if (cached) return cached.ok
    const r = await requestOnce(s.probe, 8000)
    this.network.checks.push({ site: siteId, url: s.probe, ok: r.ok, status: r.status || 0, error: r.error || null })
    return r.ok
  }

  /* ---------------- URLs ---------------- */

  /* Logical URL for the mode this site is in this run. */
  url (logical, siteId) {
    if (!this.offline || !this.web) return logical
    const mode = siteId ? this.modeFor(siteId) : (this.network.live ? 'live' : 'standin')
    if (mode === 'live') return logical
    return this.web.rewrite(logical)
  }

  /* ---------------- tool calls ---------------- */

  call (tool, args, optsOrTimeout) {
    if (!this.adapter) return Promise.resolve({ text: null, error: 'not started', resp: null })
    const timeoutMs = typeof optsOrTimeout === 'number' ? optsOrTimeout : ((optsOrTimeout && optsOrTimeout.timeoutMs) || 45000)
    return this.adapter.request('tools/call', { name: tool, arguments: args || {} }, timeoutMs).then(function (resp) {
      let text = null
      let raw = null
      let isError = false
      try {
        isError = !!(resp && resp.result && resp.result.isError === true)
        raw = resp && resp.result && resp.result.content && resp.result.content[0] ? String(resp.result.content[0].text || '') : null
        if (raw && !isError) text = JSON.parse(raw)
      } catch (e) { text = null }
      const content = (resp && resp.result && resp.result.content) || []
      return {
        resp: resp,
        text: text,
        raw: raw,
        error: resp && resp.error ? resp.error : (isError ? raw : null),
        image: content.find(c => c.type === 'image') || null,
        meta: content[1] ? (function () { try { return JSON.parse(content[1].text) } catch (e) { return null } })() : null
      }
    })
  }

  /* navigate (converting through the stand-in when needed) + ready_state */
  async nav (url, opts) {
    const o = opts || {}
    const target = o.raw ? url : this.url(url, o.site)
    const nav = await this.call('browser_navigate', {
      tabId: this.tid,
      url: target,
      stabilityWindowMs: o.stabilityWindowMs === undefined ? 300 : o.stabilityWindowMs
    }, o.timeoutMs || 60000)
    if (!(nav.text && nav.text.verified === true)) return { ok: false, nav: nav, url: target, logicalUrl: url, mode: o.site ? this.modeFor(o.site) : 'live' }
    const ready = await this.call('browser_wait', { tabId: this.tid, until: 'ready_state', timeoutMs: o.readyTimeoutMs || 20000 })
    return {
      ok: true, nav: nav, ready: ready, url: target, logicalUrl: url,
      finalUrl: nav.text.finalUrl, title: nav.text.title,
      mode: o.site ? this.modeFor(o.site) : 'live'
    }
  }

  async snap (opts) {
    const s = await this.call('browser_snapshot', Object.assign({ tabId: this.tid }, opts || {}))
    return { nodes: (s.text && s.text.nodes) || [], text: s.text, error: s.error }
  }

  async evalValue (expression, opts) {
    const r = await this.call('browser_eval', { tabId: this.tid, expression: expression }, opts || {})
    if (!r.text) return { ok: false, error: r.error || 'no result', value: undefined }
    const isErr = r.text.error !== undefined && r.text.error !== null
    return { ok: !isErr, error: r.text.error || null, value: unwrap(r.text.value), raw: r.text }
  }

  /* One run/assertion pair that picks the right recorder for the site's mode. */
  assert (id, site, ok, detail, observed) {
    const mode = this.modeFor(site)
    if (mode === 'live') return this.liveCheck(id, site, ok, detail, observed)
    return ok ? this.standInPass(id, site + '/stand-in', detail, observed) : this.standInFail(id, site + '/stand-in', detail, observed)
  }

  assertBlocked (id, site, detail, observed) {
    if (this.modeFor(site) === 'live') return this.liveBlocked(id, site, detail, observed)
    return this.standInBlocked(id, site + '/stand-in', detail, observed)
  }

  /* ---------------- results ---------------- */

  summary () {
    const count = list => {
      const c = { pass: 0, fail: 0, blocked: 0, drift: 0, total: list.length }
      list.forEach(r => {
        if (r.status === 'PASS') c.pass++
        else if (r.status === 'FAIL') c.fail++
        else if (r.status === 'DRIFT') c.drift++
        else c.blocked++
      })
      return c
    }
    const live = this.results.filter(r => r.mode === 'live')
    const standin = this.results.filter(r => r.mode === 'standin')
    const lc = count(live)
    const sc = count(standin)
    return {
      probe: this.name,
      layer: this.layer,
      ranAt: new Date().toISOString(),
      network: this.network,
      canonicalToolCount: CANONICAL_TOOL_COUNT,
      standin: this.web ? { base: 'http://127.0.0.1:' + this.web.port, pinnedOrigins: Array.from(this.web.pins.keys()), leakViolations: this.web.leakViolations } : null,
      live: { counts: lc, results: live },
      standinEvidence: { counts: sc, results: standin },
      verdict: {
        /* A capability task is only closed on LIVE evidence. */
        ok: lc.fail === 0 && lc.blocked === 0 && lc.pass > 0 && this.network.live && (!this.web || !this.web.leakViolations.length),
        livePass: lc.pass,
        liveFail: lc.fail,
        liveBlocked: lc.blocked,
        standinPass: sc.pass,
        standinFail: sc.fail,
        reason: this.network.live
          ? (lc.fail ? 'live assertion(s) failed' : (lc.blocked ? 'live assertion(s) blocked' : (lc.pass > 0 ? 'live evidence green' : 'no live assertion ran')))
          : 'network OFFLINE: stand-in evidence does not close a real-web task'
      }
    }
  }

  writeEvidence () {
    const s = this.summary()
    try {
      fs.mkdirSync(path.dirname(this.evidenceFile), { recursive: true })
      fs.writeFileSync(this.evidenceFile, JSON.stringify(s, null, 2))
    } catch (e) { /* evidence is advisory */ }
    return s
  }

  async stop () {
    if (this.adapter) { try { this.adapter.stop() } catch (e) {} }
    if (this.launcher) killTree(this.launcher.pid)
    if (this.web) this.web.stop()
    await sleep(1200)
    try { fs.rmSync(this.runDir, { recursive: true, force: true }) } catch (e) {}
  }
}

function token (n) {
  return crypto.randomBytes(n || 6).toString('hex')
}

function finish (session) {
  const s = session.writeEvidence()
  const L = s.live.counts
  const S = s.standinEvidence.counts
  console.log('\n' + s.probe + ' [' + s.network.mode + '] live: ' + L.pass + ' pass, ' + L.fail + ' fail, ' + L.blocked +
    ' blocked, ' + L.drift + ' drift of ' + L.total +
    ' | stand-in: ' + S.pass + ' pass, ' + S.fail + ' fail, ' + S.blocked + ' blocked of ' + S.total)
  console.log('verdict: ' + (s.verdict.ok ? 'PASS (real-web)' : 'NOT CLOSED — ' + s.verdict.reason))
  if (s.network.mode !== 'LIVE') console.log('network: ' + s.network.why)
  if (s.standin && s.standin.leakViolations.length) console.log('FAIL leak: stand-in page attempted real third-party contact: ' + JSON.stringify(s.standin.leakViolations).slice(0, 300))
  console.log('evidence: ' + path.relative(ROOT, session.evidenceFile).replace(/\\/g, '/'))
  return s.verdict.ok ? 0 : 1
}

module.exports = {
  ROOT,
  MCP,
  LAUNCHER,
  CANONICAL_TOOL_COUNT,
  OfflineWeb,
  RealWebSession,
  makeAdapter,
  killTree,
  probeUrl: requestOnce,
  requestOnce,
  unwrap,
  sleep,
  token,
  finish
}
