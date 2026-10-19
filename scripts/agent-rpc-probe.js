#!/usr/bin/env node
/*
 * P0-06 end-to-end probe: launch the real Min main process with --agent-rpc and
 * drive it with real loopback HTTP requests.
 *
 * Two launches:
 *   1. WITHOUT --agent-rpc  -> proves no listener and no discovery file appear.
 *   2. WITH    --agent-rpc  -> discovery file appears, commands answer, and every
 *                              auth/host/origin tampering attempt is rejected.
 *
 * Uses a throwaway profile under the OS temp dir, never the everyday profile.
 * Dev mode is on, so Min appends "-development" to userData (main/main.js:59-61).
 *
 * Safety: fixed argv, no shell, throwaway profile, kill scoped to the spawned
 * PID, temp dir removed at the end. The token is read from the discovery file
 * and never printed.
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'agent-rpc-probe.json')
const WIN32 = process.platform === 'win32'

const RUN_DIR = path.join(os.tmpdir(), 'min-agent-rpc-probe')
const PROFILE_DIR = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE_DIR + '-development'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function rmrf (target) {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch (e) { /* retry */ }
    if (!fs.existsSync(target)) return true
    const until = Date.now() + 500
    while (Date.now() < until) { /* brief spin */ }
  }
  return !fs.existsSync(target)
}

function electronBinary () {
  const resolved = require('electron')
  if (typeof resolved !== 'string') throw new Error('electron did not resolve to a binary')
  return resolved
}

function launch (bin, extraArgs) {
  const args = ['.', '--development-mode', '--user-data-dir=' + PROFILE_DIR].concat(extraArgs).concat(['file:///' + path.join(RUN_DIR, 'tab.html').replace(/\\/g, '/')])
  const proc = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = []
  proc.stdout.on('data', d => out.push(String(d)))
  proc.stderr.on('data', d => out.push(String(d)))
  return { proc: proc, out: out }
}

function killTree (proc) {
  if (WIN32) {
    return spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { encoding: 'utf8', windowsHide: true }).status
  }
  proc.kill('SIGTERM')
  return null
}

function waitForFile (file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise(function (resolve) {
    const t = setInterval(function () {
      if (fs.existsSync(file)) { clearInterval(t); resolve(true) }
      else if (Date.now() > deadline) { clearInterval(t); resolve(false) }
    }, 250)
  })
}

function rpc (port, token, opts, body) {
  return new Promise(function (resolve) {
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: opts.path || '/rpc',
      method: opts.method || 'POST',
      headers: Object.assign(opts.noAuth
        ? { host: '127.0.0.1:' + port, 'content-type': 'application/json' }
        : { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, opts.headers || {}),
      headersTimeout: 6000,
      requestTimeout: 10000
    }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }))
    })
    req.on('error', e => resolve({ status: 0, error: e.code || e.message, body: '' }))
    req.setTimeout(11000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', body: '' }) })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function main () {
  const report = { task: 'P0-06 agent-rpc end-to-end', startedAt: new Date().toISOString(), runs: {} }

  rmrf(RUN_DIR)
  fs.mkdirSync(RUN_DIR, { recursive: true })
  fs.writeFileSync(path.join(RUN_DIR, 'tab.html'), '<!doctype html><html><head><title>Agent RPC Tab</title></head><body><p>agent rpc probe tab</p></body></html>', 'utf8')

  const bin = electronBinary()
  const discFile = path.join(EFFECTIVE_PROFILE, 'agent-rpc.json')

  /* ---- launch 1: no --agent-rpc ---- */
  const a = launch(bin, [])
  await sleep(9000)
  report.runs.withoutFlag = {
    discoveryFileExists: fs.existsSync(discFile),
    agentRpcLogLines: a.out.join('').split('\n').filter(l => l.includes('[agent-rpc]')).length
  }
  killTree(a.proc)
  await sleep(2500)

  /* ---- launch 2: with --agent-rpc ---- */
  /* Plant a stale discovery file from a hypothetical crashed launch, to check
   * that a new launch never leaves a dead port/token published. */
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  const staleToken = 'stalestale' + '0'.repeat(52)
  fs.writeFileSync(discFile, JSON.stringify({ v: 1, url: 'http://127.0.0.1:1/rpc', token: staleToken, pid: 999999, version: '0', launchedAt: '1970-01-01T00:00:00.000Z' }), 'utf8')
  report.runs.withFlag = { staleFilePlantedBeforeLaunch: true }

  const b = launch(bin, ['--agent-rpc'])
  const appeared = await waitForFile(discFile, 20000)
  report.runs.withFlag = { discoveryFileAppeared: appeared }

  if (!appeared) {
    report.runs.withFlag.stdout = b.out.join('').split('\n').filter(l => l.includes('[agent-rpc]')).slice(0, 10)
    killTree(b.proc)
  } else {
    const disc = JSON.parse(fs.readFileSync(discFile, 'utf8'))
    report.runs.withFlag.staleFileReplaced = disc.token !== staleToken && disc.pid === b.proc.pid
    report.runs.withFlag.discoveryKeys = Object.keys(disc).sort()
    report.runs.withFlag.urlIsLoopback = /^http:\/\/127\.0\.0\.1:\d+\/rpc$/.test(disc.url)
    report.runs.withFlag.tokenLength = (disc.token || '').length
    report.runs.withFlag.pidMatchesSpawnedChild = disc.pid === b.proc.pid
    report.runs.withFlag.version = disc.version
    report.runs.withFlag.agentRpcLogLines = b.out.join('').split('\n').filter(l => l.includes('[agent-rpc]')).map(l => l.trim())
    report.runs.withFlag.tokenAbsentFromStdout = b.out.join('').indexOf(disc.token) === -1

    const port = parseInt(new URL(disc.url).port, 10)

    /* The tab is created by the renderer after the window loads, so wait for a
     * real loaded tab before sampling status/tabs. */
    let settled = null
    const settleDeadline = Date.now() + 20000
    while (Date.now() < settleDeadline) {
      const probe = await rpc(port, disc.token, {}, JSON.stringify({ jsonrpc: '2.0', method: 'browser_tabs' }))
      let parsed = null
      try { parsed = JSON.parse(probe.body) } catch (e) { /* retry */ }
      const list = parsed && parsed.result && parsed.result.tabs
      const mine = list && list.find(t => t.url && t.url.indexOf('tab.html') !== -1 && t.loading === false)
      if (mine) {
        settled = list
        break
      }
      await sleep(1000)
    }
    report.runs.withFlag.settledWithinTimeout = !!settled
    report.runs.withFlag.settleMs = 20000 - (settleDeadline - Date.now())

    const st = await rpc(port, disc.token, {}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'browser_status' }))
    let status = null
    try { status = JSON.parse(st.body) } catch (e) { /* recorded below */ }
    report.runs.withFlag.status = {
      httpStatus: st.status,
      result: status && status.result
        ? {
            app: status.result.app,
            platform: status.result.platform,
            uptimeSeconds: status.result.uptimeSeconds,
            mode: status.result.mode,
            profile: status.result.profile,
            windows: { count: status.result.windows.count, currentWindowId: status.result.windows.currentWindowId, selectedTabId: status.result.windows.selectedTabId, items: status.result.windows.items },
            tabs: status.result.tabs,
            bridge: status.result.bridge,
            features: status.result.features,
            limits: status.result.limits,
            resultKeys: Object.keys(status.result).sort()
          }
        : null,
      tokenInBody: st.body.indexOf(disc.token) !== -1,
      corsHeader: st.headers['access-control-allow-origin'] || null
    }

    const tb = await rpc(port, disc.token, {}, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'browser_tabs' }))
    let tabs = null
    try { tabs = JSON.parse(tb.body) } catch (e) { /* recorded below */ }
    report.runs.withFlag.tabs = { httpStatus: tb.status, result: tabs && tabs.result }

    const tampering = {}
    tampering.noAuth = (await rpc(port, disc.token, { noAuth: true }, JSON.stringify({ jsonrpc: '2.0', method: 'browser_status' }))).status
    tampering.wrongToken = (await rpc(port, '0'.repeat(64), {}, JSON.stringify({ jsonrpc: '2.0', method: 'browser_status' }))).status
    tampering.badHost = (await rpc(port, disc.token, { headers: { host: 'evil.example:' + port } }, JSON.stringify({ jsonrpc: '2.0', method: 'browser_status' }))).status
    tampering.badOrigin = (await rpc(port, disc.token, { headers: { origin: 'http://evil.example' } }, JSON.stringify({ jsonrpc: '2.0', method: 'browser_status' }))).status
    tampering.badSecFetch = (await rpc(port, disc.token, { headers: { 'sec-fetch-site': 'cross-site' } }, JSON.stringify({ jsonrpc: '2.0', method: 'browser_status' }))).status
    tampering.getMethod = (await rpc(port, disc.token, { method: 'GET' })).status
    tampering.unknownMethod = (await rpc(port, disc.token, {}, JSON.stringify({ jsonrpc: '2.0', method: 'browser_screenshot' }))).status
    tampering.malformedJson = (await rpc(port, disc.token, {}, '{oops')).status
    report.runs.withFlag.tampering = tampering

    killTree(b.proc)
    await sleep(2500)
    report.runs.withFlag.discoveryFileRemovedAfterKill = !fs.existsSync(discFile)
    const after = await rpc(port, disc.token, {}, JSON.stringify({ jsonrpc: '2.0', method: 'browser_status' }))
    report.runs.withFlag.serverClosedAfterKill = after.status === 0
    report.runs.withFlag.afterKillError = after.error || null
  }

  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(report, null, 2), 'utf8')
  rmrf(RUN_DIR)
  report.cleanup = { runDirRemoved: !fs.existsSync(RUN_DIR) }
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(report, null, 2), 'utf8')

  console.log(JSON.stringify(report, null, 2).replace(/"token": "[^"]*"/g, '"token": "<redacted>"'))
  return 0
}

main().then(c => process.exit(c)).catch(e => {
  console.error('probe error: ' + e.message)
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }) } catch (ignored) {}
  process.exit(2)
})
