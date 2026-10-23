/* Phase C Novellive diagnosis — Chrome side (sanitized, fresh temp profile). */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'min-chrome-novellive-' + Date.now())
const CDP_PORT = 9333
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []

function check (name, pass, detail) {
  results.push({ name: name, pass: !!pass })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail === undefined ? '' : detail).slice(0, 160) + ']'))
}

function httpJson (port, urlPath) {
  return new Promise(function (resolve) {
    const rq = http.get('http://127.0.0.1:' + port + urlPath, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', function () { try { resolve(JSON.parse(d)) } catch (e) { resolve(null) } })
    })
    rq.on('error', function () { resolve(null) })
    rq.end()
  })
}

async function main () {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch (e) { /* new dir */ }
  console.log('[chrome] launching fresh temp profile: ' + PROFILE)
  const proc = spawn(CHROME_PATH, [
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    'https://novellive.com/'
  ], { windowsHide: false, stdio: 'ignore' })

  let cdpReady = false
  for (let i = 0; i < 40 && !cdpReady; i++) {
    await sleep(750)
    const v = await httpJson(CDP_PORT, '/json/version')
    if (v && v.webSocketDebuggerUrl) cdpReady = true
  }
  check('Chrome launched (fresh temp profile)', cdpReady)
  if (!cdpReady) return finish(2)

  let novTab = null
  for (let i = 0; i < 10 && !novTab; i++) {
    const targets = await httpJson(CDP_PORT, '/json/list')
    novTab = (targets || []).find(t => (t.url || '').indexOf('novellive') !== -1)
    if (!novTab) await sleep(1000)
  }
  check('novellive tab enumerated in Chrome', !!novTab, novTab ? String(novTab.url).slice(0, 70) : '')

  const started = Date.now()
  let cleared = false
  let lastTitle = ''
  for (let i = 0; i < 20; i++) {
    await sleep(3000)
    const targets = await httpJson(CDP_PORT, '/json/list')
    const tab = (targets || []).find(t => (t.url || '').indexOf('novellive') !== -1)
    if (!tab) continue
    const title = String(tab.title || '')
    const url = String(tab.url || '')
    const nowChecking = title.indexOf('Just a moment') !== -1
    const titleChanged = title !== lastTitle
    if (titleChanged || !nowChecking) {
      console.log('[poll ' + (i + 1) + '] title=' + title.slice(0, 80) + ' | url=' + url.slice(0, 70))
      lastTitle = title
    }
    if (!nowChecking && title.length > 0) {
      cleared = true
      console.log('RESULT: challenge CLEARED in Chrome (fresh profile) after ' + Math.round((Date.now() - started) / 1000) + 's')
      break
    }
  }
  if (!cleared) {
    console.log('RESULT: challenge did NOT clear in Chrome (fresh profile) within 60 s — user observed gap may come from pre-existing cookies/profile state')
    check('novellive challenge resolved in Chrome (fresh temp profile)', false, 'never cleared')
  } else {
    check('novellive challenge resolved in Chrome (fresh temp profile)', true)
  }
  finish(cleared ? 0 : 1)

  function finish (code) {
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'novellive-chrome-result.json'), JSON.stringify({
      ts: new Date().toISOString(),
      target: 'https://novellive.com/',
      clearedInChrome: cleared,
      results: results
    }, null, 2), 'utf8')
    console.log('novellive-chrome checks: ' + results.filter(function (r) { return r.pass }).length + '/' + results.length)
    try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }) } catch (e) { /* ignore */ }
    try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch (e) { /* ignore */ }
    process.exit(code)
  }
}
main().catch(function (e) { console.error('FATAL ' + (e && e.message || e)); process.exit(2) })
