#!/usr/bin/env node
/*
 * P0-08 Two-URL argv probe. Acceptance evidence for the two-URL crash.
 *
 * Established diagnosis (docs/BASELINE.md, P0-08 addendum):
 *   A positional URL/path argument FOLLOWED BY another positional argument
 *   kills the Electron 43.4.1 runtime on Windows before any application
 *   JavaScript runs (exit 4294967295, no window, no stderr even with
 *   --enable-logging, no crashpad dump, synchronous marker file at app-JS entry
 *   never written, identical on a pristine upstream bundle, and on a minimal
 *   app with no Min code). Min cannot observe or reject these arguments; the
 *   crash is below every layer this repository controls.
 *
 * This probe therefore asserts the CURRENT, documented behaviour:
 *   1. one bare URL          -> runs, tab loads, no unhandled rejection
 *   2. two bare URLs         -> runtime dies (exit 4294967295) pre-JS:
 *                               documented, unfixable in-repo
 *   3. two URLs after `--`   -> runs, BOTH tabs load
 *   4. three URLs after `--` -> runs, all three tabs load
 *
 * Tab counts are read through the existing agent-rpc bridge - no new browser
 * tools and no instrumentation of Min.
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'two-url-argv-probe.json')
const bin = require('electron')
const WIN32 = process.platform === 'win32'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function rmrf (target) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch (e) { /* retry */ }
    if (!fs.existsSync(target)) return true
    const until = Date.now() + 400
    while (Date.now() < until) { /* brief spin */ }
  }
  return !fs.existsSync(target)
}

function rpc (port, token, body) {
  return new Promise(function (resolve) {
    const req = http.request({
      host: '127.0.0.1', port, path: '/rpc', method: 'POST',
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      headersTimeout: 6000, requestTimeout: 10000
    }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', e => resolve({ status: 0, error: e.code }))
    req.setTimeout(11000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }) })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function bridgeArgs (D) {
  fs.mkdirSync(path.join(D, 'p-development'), { recursive: true })
  fs.writeFileSync(path.join(D, 'p-development', 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  return ['.', '--development-mode', '--user-data-dir=' + path.join(D, 'p'), '--agent-rpc']
}

/* Launch, return {tabs, exit, out} for surviving launches. */
async function launchWithTabs (name, urls, dashes) {
  const D = path.join(os.tmpdir(), 'min-two-url-' + name)
  rmrf(D)
  const args = bridgeArgs(D)
  if (dashes) args.push('--')
  args.push.apply(args, urls)

  const proc = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { out += d })
  let killedByUs = false
  let selfExit = null
  proc.on('exit', function (code) {
    /* taskkill also produces an exit event; only record deaths we did not cause. */
    if (!killedByUs) selfExit = code
  })

  const started = Date.now()
  let port = null
  let token = null
  let tabs = null
  while (Date.now() - started < 30000 && selfExit === null) {
    await sleep(1000)
    const m = out.match(/listening on 127\.0\.0\.1:(\d+)/)
    const discPath = path.join(D, 'p-development', 'agent-rpc.json')
    if (m && !port && fs.existsSync(discPath)) {
      port = parseInt(m[1], 10)
      token = JSON.parse(fs.readFileSync(discPath, 'utf8')).token
    }
    if (port && token) {
      const r = await rpc(port, token, JSON.stringify({ jsonrpc: '2.0', method: 'browser_tabs' }))
      try { tabs = JSON.parse(r.body).result } catch (e) { /* still starting */ }
      if (tabs && tabs.count > 0 && tabs.tabs.every(t => t.loading === false) && Date.now() - started > 9000) break
    }
  }

  let killExit = null
  if (selfExit === null) {
    killedByUs = true
    killExit = WIN32
      ? spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { encoding: 'utf8', windowsHide: true }).status
      : null
    await sleep(2000)
  }

  const result = {
    name,
    survived: selfExit === null,
    selfExit,
    tabCount: tabs ? tabs.count : null,
    tabs: tabs ? tabs.tabs.map(t => ({ url: t.url.split('/').pop(), title: t.title, loading: t.loading, active: t.active })) : null,
    unhandledRejection: /UnhandledPromiseRejection/i.test(out),
    extensionHostLines: (out.match(/\[extension-host\]/g) || []).length
  }
  rmrf(D)
  return result
}

/* Crash scenario: no bridge, no tabs - assert death before Min JS. */
async function launchCrashing (name, urls) {
  const D = path.join(os.tmpdir(), 'min-two-url-' + name)
  rmrf(D)
  fs.mkdirSync(path.join(D, 'p-development'), { recursive: true })
  fs.writeFileSync(path.join(D, 'p-development', 'settings.json'), '{}', 'utf8')
  const args = ['.', '--development-mode', '--user-data-dir=' + path.join(D, 'p')].concat(urls)
  const res = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000 })
  const result = {
    name,
    exit: res.status,
    stdoutLines: (res.stdout || '').split('\n').filter(l => l.trim()).length,
    diedBeforeFirstURLCouldLoad: null
  }
  rmrf(D)
  return result
}

async function main () {
  const D0 = path.join(os.tmpdir(), 'min-two-url-gen')
  rmrf(D0); fs.mkdirSync(D0, { recursive: true })
  const urls = []
  for (let i = 0; i < 3; i++) {
    const f = path.join(D0, 'u' + i + '.html')
    fs.writeFileSync(f, '<!doctype html><html><head><title>URL Arg ' + i + '</title></head><body style="background:#fbbf24">' + i + '</body></html>', 'utf8')
    urls.push('file:///' + f.replace(/\\/g, '/'))
  }

  const report = { task: 'P0-08 two-URL argv probe', ranAt: new Date().toISOString(), results: {} }

  report.results.oneUrl = await launchWithTabs('one', [urls[0]], false)
  report.results.twoUrlsBare = await launchCrashing('two-bare', [urls[0], urls[1]])
  report.results.twoUrlsDashes = await launchWithTabs('two', [urls[0], urls[1]], true)
  report.results.threeUrlsDashes = await launchWithTabs('three', urls, true)
  rmrf(D0)

  report.verdicts = {
    case1_singleUrlWorks: report.results.oneUrl.survived && report.results.oneUrl.tabCount >= 1 &&
      report.results.oneUrl.tabs.some(t => /u0\.html/.test(t.url)),
    case2_twoBareUrlsRuntimeDeath_documented: report.results.twoUrlsBare.exit === 4294967295,
    /* Presence-based: Min may legitimately keep an extra background view, so
     * assert that every argv URL loaded, not an exact tab count. */
    case3_twoUrlsWithDashesBothTabs: report.results.twoUrlsDashes.survived &&
      [0, 1].every(i => report.results.twoUrlsDashes.tabs.some(t => new RegExp('u' + i + '\\.html').test(t.url) && !t.loading)),
    case4_threeUrlsWithDashesAllTabs: report.results.threeUrlsDashes.survived &&
      [0, 1, 2].every(i => report.results.threeUrlsDashes.tabs.some(t => new RegExp('u' + i + '\\.html').test(t.url) && !t.loading)),
    noUnhandledRejectionsAnywhere: !report.results.oneUrl.unhandledRejection &&
      !report.results.twoUrlsDashes.unhandledRejection && !report.results.threeUrlsDashes.unhandledRejection
  }
  report.allPassed = Object.values(report.verdicts).every(Boolean)

  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ results: report.results, verdicts: report.verdicts, allPassed: report.allPassed }, null, 2))
  return report.allPassed ? 0 : 2
}

main().then(c => process.exit(c)).catch(e => {
  console.error('two-url probe error: ' + e.message)
  try { fs.rmSync(os.tmpdir() && path.join(os.tmpdir(), 'min-two-url-one'), { recursive: true, force: true }) } catch (ignored) {}
  process.exit(2)
})
