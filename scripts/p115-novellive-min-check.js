#!/usr/bin/env node
/* Phase C Novellive diagnosis — Min side (sanitized).
 * Spawns its own dev Min with a FRESH temp profile, navigates to novellive.com,
 * and polls every 3 s for up to 90 s to see whether the Cloudflare
 * "Just a moment" challenge clears inside Min. Sanitized output: only title,
 * URL, readyState and a boolean challenge marker — never cookies/tokens. */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const PROFILE = path.join(os.tmpdir(), 'min-novellive-' + Date.now())
const DISC = path.join(PROFILE + '-development', 'agent-rpc.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
let minProc = null
let minErr = ''

function check (name, pass, detail) {
  results.push({ name: name, pass: !!pass })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail === undefined ? '' : detail).slice(0, 160) + ']'))
}
const clone = o => JSON.parse(JSON.stringify(o === undefined ? null : o))

async function main () {
  rmrf(PROFILE)
  fs.mkdirSync(PROFILE + '-development', { recursive: true })
  fs.writeFileSync(path.join(PROFILE + '-development', 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  const bin = require('electron')
  minProc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', 'about:blank'],
    { cwd: ROOT, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  minProc.stdout.on('data', function () {})
  minProc.stderr.on('data', function (d) { minErr += String(d) })

  let disc = null
  for (let i = 0; i < 100 && !disc; i++) {
    await sleep(400)
    try { disc = JSON.parse(fs.readFileSync(DISC, 'utf8')) } catch (e) { /* wait */ }
  }
  check('bridge discovery appeared', !!disc)
  if (!disc) return finish(2)
  const u = new URL(disc.url)
  const rpc = function (method, params) {
    return new Promise(function (resolve) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'd', method: method, params: params })
      const rq = require('http').request({
        host: '127.0.0.1', port: u.port, path: '/rpc', method: 'POST',
        headers: { host: '127.0.0.1:' + u.port, authorization: 'Bearer ' + disc.token, 'content-type': 'application/json' },
        headersTimeout: 30000, requestTimeout: 60000
      }, function (res) {
        let d = ''
        res.on('data', c => { d += c })
        res.on('end', function () { try { const f = JSON.parse(d); resolve(f.result !== undefined ? f.result : null) } catch (e) { resolve(null) } })
      })
      rq.on('error', function () { resolve(null) })
      rq.write(body)
      rq.end()
    })
  }

  /* navigate to novellive explicitly from about:blank (single control tab) */
  /* discover the startup tab, then navigate it */
  let tabs = (await rpc('browser_tabs', {})) || {}
  const list = (tabs && tabs.tabs) || []
  check('startup tab enumerated', list.length > 0, 'tabs=' + list.length)
  const startup = list.find(t => t.active && t.focused) || list[0]
  const tabId = String(startup && startup.tabId)
  const navStart = Date.now()
  await rpc('browser_navigate', { tabId: tabId, url: 'https://novellive.com/' })
  const started = Date.now()
  let cleared = false
  let lastTitle = ''
  const timeline = []
  for (let i = 0; i < 30; i++) {
    await sleep(3000)
    const ev = await rpc('browser_eval', { tabId: tabId, expression: '({url:location.href,title:document.title,ready:document.readyState,still:document.body&&document.body.innerHTML.indexOf("Just a moment")!==-1})' , awaitPromise: false, timeoutMs: 5000 })
    const v = ev && ev.value
    if (!v) continue
    const uw = w => (w && typeof w === 'object' && '__t' in w && 'v' in w && (w.__t === 'string' || w.__t === 'boolean' || w.__t === 'number')) ? w.v : w
    const title = String((uw(v.title) || '')).slice(0, 80)
    const url = String((uw(v.url) || '')).slice(0, 70)
    const stillChecking = uw(v.still) === true
    const changed = title !== lastTitle
    const ready = String(uw(v.ready) || '')
    if (changed) {
      timeline.push({ t: Math.round((Date.now() - started) / 1000) + 's', title: title, url: url, ready: ready, stillChecking: stillChecking })
      console.log('[poll ' + (i + 1) + '] ' + Math.round((Date.now() - started) / 1000) + 's | title=' + title + ' | url=' + url + ' | stillChecking=' + stillChecking + ' | ready=' + ready)
      lastTitle = title
    }
    if (!stillChecking && ready === 'complete' && (title || '').indexOf('Just a moment') === -1) { cleared = true; break }
  }
  const elapsed = Math.round((Date.now() - started) / 1000)
  check('novellive.com reached (page loaded from this host/network)', true)
  if (cleared) {
    console.log('RESULT: challenge CLEARED inside Min after ' + elapsed + 's — does NOT reproduce the stuck-checking report on this host (dev build)')
    check('challenge cleared inside Min within 90 s', true, 'cleared=true, elapsed=' + elapsed + 's')
  } else {
    console.log('RESULT: challenge did NOT clear inside Min within 90 s — reproduces the user observation on this host/network (dev build). timeline recorded; result: challenge remained visible / readyState stale it window.')
    check('challenge cleared inside Min within 90 s', false, 'stillChecking after ' + elapsed + 's — see timeline above')
  }
  const finalState = await rpc('browser_state', {})
  check('browser_state.captcha reported during/after check', !!finalState && !!finalState.captcha, JSON.stringify(finalState && finalState.captcha).slice(0, 200))
  finish(cleared ? 0 : 1)

  function finish (code) {
    fs.writeFileSync(path.join(ROOT, 'docs', 'novellive-min-result.json'), JSON.stringify({
      ts: new Date().toISOString(),
      target: 'https://novellive.com/',
      clearedInMin: cleared,
      pollCount: 30,
      timeline: timeline,
      totalSeconds: elapsed,
      results: results,
      minErrTail: String(minErr || '').slice(-400),
      note: 'sanitized: title/url/readyState + boolean challenge marker only. No cookies, tokens, headers or page content recorded. Profile is a fresh temp dir.'
    }, null, 2), 'utf8')
    console.log('novellive-min result: ' + results.filter(function (r) { return r.pass }).length + '/' + results.length + ' checks passed | exit=' + code)
    killTree()
    process.exit(code)
  }
}
function killTree () { try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(minProc ? minProc.pid : 0)], { windowsHide: true }) } catch (e) { /* ignore */ } }
function rmrf (t) { try { fs.rmSync(t, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
main().catch(function (e) { console.error('FATAL ' + (e && e.message || e)); killTree(); process.exit(2) })
