/*
 * R5 / D6 - what does each runtime actually send as User-Agent?
 *
 * Min's UASwitcher rewrites the UA to Chrome-like with the minor/patch zeroed:
 *   process.versions.chrome.split('.').map((v, i) => i === 0 ? v : '0').join('.')
 * which turns 150.0.7871.224 into 150.0.0.0. A CDN fingerprinting on version
 * coherence (UA major/minor/patch vs real TLS/JS surface) would see a mismatch.
 *
 * This probe reads the UA each runtime reports, locally, with no third-party call.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const H = require('./lib/realweb-harness')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main () {
  const out = { ts: new Date().toISOString(), ua: {} }

  /* Min */
  const s = new H.RealWebSession({ name: 'd6ua', evidenceFile: path.join(os.tmpdir(), 'opencode', 'd6ua.json'), offline: false })
  const ok = await s.start([{ id: 'example', probe: 'https://example.com/', urls: { home: 'https://example.com/' } }])
  if (ok) {
    const r = await s.evalValue('JSON.stringify({ua: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands : null, platform: navigator.platform, vendor: navigator.vendor})')
    try { out.ua.min = JSON.parse(String(r.value)) } catch (e) { out.ua.min = { raw: r.value } }
    await s.stop()
  }

  /* Chrome */
  out.ua.chrome = await chromiumUA('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'chrome')
  /* CloakBrowser v146 */
  const cloak = path.join(os.homedir(), '.cloakbrowser', 'chromium-146.0.7680.177.5', 'chrome.exe')
  if (fs.existsSync(cloak)) out.ua.cloak146 = await chromiumUA(cloak, 'cloak')

  console.log(JSON.stringify(out, null, 2))
  fs.writeFileSync(path.join(path.resolve(__dirname, '..'), 'docs', 'd6-useragent.json'), JSON.stringify(out, null, 2))
  return 0
}

async function chromiumUA (exe, label) {
  const http = require('http')
  const net = require('net')
  const port = await new Promise(function (resolve) {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', function () { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
  const profile = path.join(os.tmpdir(), 'd6ua-' + label + '-' + Date.now())
  const proc = spawn(exe, ['--user-data-dir=' + profile, '--no-first-run', '--remote-debugging-port=' + port, 'data:text/html,<title>ua</title>'], { windowsHide: true, stdio: 'ignore' })
  const get = p => new Promise(function (resolve) {
    const rq = http.get({ host: '127.0.0.1', port: port, path: p, timeout: 3000 }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', function () { try { resolve(JSON.parse(d)) } catch (e) { resolve(null) } })
    })
    rq.on('error', () => resolve(null)); rq.on('timeout', () => { rq.destroy(); resolve(null) })
  })
  let info = null
  for (let i = 0; i < 30 && !info; i++) {
    await sleep(200)
    const v = await get('/json/version')
    if (v) info = v
  }
  try { require('child_process').spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }) } catch (e) {}
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  return info ? { ua: info['User-Agent'] || null, protocol: info['Protocol-Version'] || null, browser: info.Browser || null } : { error: 'no cdp' }
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(2) })
