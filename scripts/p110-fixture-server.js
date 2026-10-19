#!/usr/bin/env node
/*
 * P1-10 fixture server: benign local pages for the 7 workflow scenarios.
 *
 * Routes (all on 127.0.0.1):
 *   /                    index (sparse)
 *   /gate?v=1|2          visual gate: control present in render, aria-hidden in accessibility tree;
 *                        click reveals hidden content with marker GATE-UNLOCKED-vN.
 *                        v1: bottom-right, 200x48   v2: top-left, 150x40 (variation so coordinates
 *                        cannot be memorized; agents must recompute from the CURRENT screenshot)
 *   /gate2?v=N           second-state marker page (GATE-TWO-OPEN-vN)
 *   /redirect-start      302 redirect to /gate2?v=RED (Scenario 4: unexpected redirect)
 *   /form                labeled form (Scenario 2: semantic). Submits via GET to /form-result
 *   /form-result         marker FORM-RECEIVED name=<v> topic=<v>
 *   /delayed             empty body; injects marker DELAYED-CONTENT-READY after 1500ms (Scenario 3)
 *   /known               obvious semantic page (Scenario 5 efficiency control), link to /known2
 *   /known2              marker KNOWN2-VERIFIED
 *   /captcha             simulated state using selector markers Min detects
 *                        (cf-turnstile/data-sitekey class markers only - NO provider code), plus a
 *                        local button that simulates the USER completing the challenge, revealing
 *                        marker CAPTCHA-CLEARED (Scenario 6)
 *
 * usage: node scripts/p110-fixture-server.js --port=47310
 *   prints "fixture-ready <port>" on listening; /shutdown exits cleanly.
 */

const http = require('http')
const url = require('url')

const args = process.argv.slice(2)
let port = 47310
for (const a of args) if (a.indexOf('--port=') === 0) port = parseInt(a.slice(7), 10) || 47310

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')

function page (title, body, extra) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    '<style>body{font:14px sans-serif;margin:24px}</style>' + (extra || '') + '</head><body>' + body + '</body></html>'
}

function gatePage (variant) {
  // Control deliberately aria-hidden: rendered/visible, absent from accessibility tree.
  const pos = variant === 2
    ? 'position:fixed;top:12%;left:8%;padding:10px 18px;font-size:14px'
    : 'position:fixed;bottom:8%;right:5%;padding:14px 34px;font-size:16px'
  const label = variant === 2 ? '⤢ open' : '⤢ View Full Site'
  return page('Gate ' + variant,
    '<h1 id="h1">Limited preview</h1>' +
    '<p>Only a short preview is available in this view.</p>' +
    '<div id="fullgate" aria-hidden="true" style="cursor:pointer;background:#2255aa;color:#fff;border-radius:6px;' + pos + '" ' +
    'data-variant="' + variant + '">' + label + '</div>' +
    '<div id="hidden-content" style="display:none"><h2 id="marker">GATE-UNLOCKED-v' + variant + '</h2>' +
    '<p>Full content is now available for variant ' + variant + '.</p></div>' +
    '<script>document.getElementById("fullgate").addEventListener("click",function(){' +
    'document.getElementById("hidden-content").style.display="block";this.style.display="none";});</script>')
}

const routes = {
  '/': q => page('P1-10 fixtures', '<h1>index</h1><ul><li>gate v1: <a href="/gate?v=1">/gate?v=1</a></li><li>form: <a href="/form">/form</a></li></ul>'),
  '/gate': q => gatePage(q.v === '2' ? 2 : 1),
  '/gate2': q => page('Gate two', '<h1 id="marker2">GATE-TWO-OPEN-' + esc(q.v || 'RED') + '</h1><p>This is the second content state.</p>'),
  '/form': () => page('Feedback form',
    '<h1>Feedback</h1><form method="GET" action="/form-result">' +
    '<label for="name">Your name</label> <input id="name" name="name" type="text">' +
    '<label for="topic">Topic</label> <select id="topic" name="topic"><option value="general">General</option><option value="bug">Bug</option></select>' +
    '<label><input type="checkbox" name="ok" value="yes" checked> OK to contact</label>' +
    '<button id="send" type="submit">Send feedback</button></form>'),
  '/form-result': q => page('Form result', '<h1 id="fres">FORM-RECEIVED name=' + esc(q.name || '') + ' topic=' + esc(q.topic || '') + '</h1>'),
  '/delayed': () => page('Loading', '<div id="late"></div><script>setTimeout(function(){' +
    'document.getElementById("late").innerHTML="<h2 id=\\"dmark\\">DELAYED-CONTENT-READY</h2><p>Content loaded after delay.</p>";},1500);</script>' +
    '<noscript>noscript</noscript>'),
  '/known': () => page('Docs home', '<h1>Docs home</h1><p>Welcome. Docs index below.</p><a id="docs-link" href="/known2">Open quick start</a>'),
  '/linkpage': () => page('Continue', '<h1>Continue</h1><a id="go" href="/redirect-start">Continue to next page</a>'),
  '/known2': () => page('Quick start', '<h1 id="k2">KNOWN2-VERIFIED</h1><p>Quick start content.</p>'),
  '/captcha': () => page('Verification required',
    '<h1>Confirm you are human</h1>' +
    '<div class="cf-turnstile" data-sitekey="LOCAL-FIXTURE-NOT-REAL" style="width:300px;height:65px;border:1px solid #ccc;padding:6px">simulated widget' +
    '<button id="fake-solve" type="button" style="display:block;margin-top:4px">Solve challenge</button></div>' +
    '<div id="captcha-clear" style="display:none"><h2>CAPTCHA-CLEARED</h2><p>Thanks, access restored.</p></div>' +
    '<button id="simulate-user-done" type="button">I completed the challenge</button>' +
    '<script>/* simulate-user-done proxies the USER having completed the challenge manually: */' +
    'document.getElementById("simulate-user-done").addEventListener("click",function(){' +
    'var w=document.querySelector(".cf-turnstile"); if (w) w.remove();' +
    'document.getElementById("captcha-clear").style.display="block";this.disabled=true;});</script>')
}

const server = http.createServer(function (req, res) {
  const u = url.parse(req.url, true)
  if (u.pathname === '/redirect-start') {
    res.writeHead(302, { Location: '/gate2?v=RED' }); res.end(); return
  }
  if (u.pathname === '/shutdown') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('bye'); setTimeout(function () { process.exit(0) }, 100); return }
  const fn = routes[u.pathname]
  if (!fn) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
  const body = fn(u.query || {})
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
})

server.listen(port, '127.0.0.1', function () { console.log('fixture-ready ' + port) })
server.on('error', function (e) { console.error('fixture-error ' + e.message); process.exit(1) })
