#!/usr/bin/env node
/* debug: replicate agent-pav-probe launch args; list tabs after ready. */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const RUN_DIR = path.join(os.tmpdir(), 'min-agent-pav-debug')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE = PROFILE + '-development'

for (let i = 0; i < 5; i++) { try { fs.rmSync(RUN_DIR, { recursive: true, force: true }) } catch (e) {}; if (!fs.existsSync(RUN_DIR)) break }
fs.mkdirSync(EFFECTIVE, { recursive: true })
fs.writeFileSync(path.join(EFFECTIVE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
fs.writeFileSync(path.join(RUN_DIR, 'pav.html'), '<!doctype html><html><head><title>PAV Fixture</title></head><body><h1>Predict Act Verify Heading</h1><a id="lnk" href="after.html">Go</a></body></html>', 'utf8')
fs.writeFileSync(path.join(RUN_DIR, 'after.html'), '<!doctype html><html><head><title>after</title></head><body><h1>After Heading</h1></body></html>', 'utf8')
const fileUrl = n => 'file:///' + path.join(RUN_DIR, n + '.html').replace(/\\/g, '/')
const startUrl = fileUrl('pav')

const bin = require('electron')
const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', startUrl],
  { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let err = ''
proc.stderr.on('data', d => { err += String(d) })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function rpcJ (port, token, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'd', method, params })
  return new Promise(function (resolve) {
    const req = http.request({ host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, function (res) {
      let d = ''; res.on('data', c => { d += c }); res.on('end', () => resolve(d))
    })
    req.on('error', e => resolve('{}'))
    req.end(body)
  })
}

async function main () {
  let disc = null
  for (let i = 0; i < 100; i++) { await sleep(400); try { disc = JSON.parse(fs.readFileSync(path.join(EFFECTIVE, 'agent-rpc.json'), 'utf8')); break } catch (e) {} }
  if (!disc) { console.log('NO-DISCOVERY; stderr tail:', err.slice(-400)); process.exit(2) }
  const u = new URL(disc.url)
  await sleep(3000)
  const rJsonRaw = await rpcJ(u.port, disc.token, 'browser_tabs', {})
  let r = null; try { r = JSON.parse(rJsonRaw); r = r.result !== undefined ? r.result : r } catch (e) { r = { raw: rJsonRaw } }
  console.log('tabs after start:')
  for (const t of r.tabs) console.log('  tabId=' + t.tabId, 'active=' + t.active, 'url=' + t.url, 'title=' + t.title)
  // capture startup args visible to Min via process dump in agent status
  const st = JSON.parse(await rpcJ(u.port, disc.token, 'browser_status', {}))
  console.log('profile path:', st.profile && st.profile.userDataPath)
  proc.kill()
  // targeted tree cleanup
  if (process.platform === 'win32') { try { require('child_process').spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }) } catch (e) {} }
  process.exit(0)
}
main()
