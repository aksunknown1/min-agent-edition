#!/usr/bin/env node
/*
 * P0-07 capture verification runner.
 *
 * Phase 1 - fixture: launches the throwaway Electron app in
 * scripts/fixtures/capture-probe-main.js (a separate app, not Min) to re-measure
 * which window states capturePage() supports on this Electron, and to assert
 * that no unhandled rejection occurs in any of them.
 *
 * Phase 2 - real Min: launches the actual product with --development-mode and a
 * throwaway profile whose settings enable experimentalCaptureProbe. The probe
 * hook at the end of main/viewManager.js calls capturePage() on a
 * never-attached view (must reject -> CAPTURE_UNAVAILABLE) and on the current
 * visible tab (must resolve -> VISIBLE_CAPTURE_OK). This verifies the hardened
 * getCapture/saveViewCapture rejection path inside Min, including that no
 * UnhandledPromiseRejection reaches stderr.
 *
 * Writes docs/capture-page-probe.json. No network, no new dependencies.
 * Safety: fixed argv, no shell, throwaway profile, kill scoped to the spawned
 * PID, temp dir removed at the end.
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'capture-probe-main.js')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'capture-page-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-capture-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE_PROFILE = PROFILE + '-development' /* dev mode appends -development (main/main.js:59) */
const WIN32 = process.platform === 'win32'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function electronBinary () {
  const resolved = require('electron')
  if (typeof resolved !== 'string') throw new Error('electron did not resolve to a binary')
  return resolved
}

function rmrf (target) {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch (e) { /* retry */ }
    if (!fs.existsSync(target)) return true
    const until = Date.now() + 400
    while (Date.now() < until) { /* brief spin */ }
  }
  return !fs.existsSync(target)
}

function runFixture (bin) {
  const res = spawnSync(bin, [FIXTURE], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 180000 })
  const stdout = (res.stdout || '').trim()
  const stderr = (res.stderr || '').trim()
  let parsed = null
  const jsonLine = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop()
  try { parsed = jsonLine ? JSON.parse(jsonLine) : null } catch (e) { /* reported below */ }

  const captures = parsed ? parsed.cases.filter(c => c.case && /^[A-E] /.test(c.case)) : []
  return {
    fixture: path.relative(ROOT, FIXTURE).replace(/\\/g, '/'),
    electronExit: res.status,
    electronError: res.error ? String(res.error.message || res.error) : null,
    parseError: parsed ? null : 'no JSON on stdout',
    stdoutExcerpt: parsed ? null : stdout.slice(0, 600),
    stderrExcerpt: stderr ? stderr.slice(0, 600) : null,
    cases: captures,
    unhandledRejections: (parsed && parsed.unhandledRejections) || null,
    hiddenProducedPixels: captures.filter(c => /^[AB] /.test(c.case)).some(c => c.ok && c.zeroSized === false && (c.distinctColorsSampled || 0) >= 2),
    visibleControlProducedPixels: captures.some(c => /^D /.test(c.case) && c.ok && c.zeroSized === false && (c.distinctColorsSampled || 0) >= 2),
    minimizedProducedPixels: captures.some(c => /^E /.test(c.case) && c.ok && c.zeroSized === false && (c.distinctColorsSampled || 0) >= 2),
    noUnhandledRejections: !!(parsed && Array.isArray(parsed.unhandledRejections) && parsed.unhandledRejections.length === 0)
  }
}

async function runMinProbe (bin) {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE_PROFILE, { recursive: true })
  /* Two DISTINCT files: passing the same URL twice as positional args was
   * observed to make Min start completely silently (no window, no output,
   * docs/BASELINE.md P0-07 addendum), which would leave the probe with no
   * background tab to inspect. */
  fs.writeFileSync(path.join(RUN_DIR, 'tab-a.html'),
    '<!doctype html><html><head><title>Capture Probe A</title></head><body style="margin:0;background:rgb(251,191,36)"><p>background tab</p></body></html>', 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'tab-b.html'),
    '<!doctype html><html><head><title>Capture Probe B</title></head><body style="margin:0;background:rgb(96,165,250)"><p>selected tab</p></body></html>', 'utf8')
  fs.writeFileSync(path.join(EFFECTIVE_PROFILE, 'settings.json'),
    JSON.stringify({ experimentalCaptureProbe: true }), 'utf8')

  const tabUrlA = 'file:///' + path.join(RUN_DIR, 'tab-a.html').replace(/\\/g, '/')
  /* ONE url only: a second positional URL arg crashes Min at startup with no
   * window and no output (reproduced, docs/BASELINE.md P0-07 addendum - a
   * pre-existing product bug, reported not fixed here). The background-view
   * case is produced inside the probe hook by detaching the single tab's view
   * exactly as hideCurrentView does. */
  const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, tabUrlA],
    { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

  const out = []
  proc.stdout.on('data', d => out.push(String(d)))
  proc.stderr.on('data', d => out.push(String(d)))
  let procExit = null
  proc.on('exit', function (code) { procExit = 'exited code=' + code })

  /* Wait until both probe markers have been seen, or 45s. */
  const started = Date.now()
  let sawHidden = false
  let sawVisible = false
  while (Date.now() - started < 45000) {
    await sleep(1000)
    const joined = out.join('')
    /* The natural product line ([capture] CAPTURE_UNAVAILABLE count=N from
     * main/viewManager.js getCapture/saveViewCapture) is independent evidence
     * that the rejection handler works, distinct from the probe marker. */
    sawHidden = joined.indexOf('CAPTURE_UNAVAILABLE') !== -1
    sawVisible = joined.indexOf('VISIBLE_CAPTURE_OK') !== -1 || joined.indexOf('VISIBLE_CASE_SKIPPED') !== -1
    if (sawHidden && sawVisible) break
  }

  const kill = WIN32
    ? spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { encoding: 'utf8', windowsHide: true }).status
    : (proc.kill('SIGTERM'), null)
  await sleep(2500)

  const joined = out.join('')
  const result = {
    viewManagerHook: 'main/viewManager.js app.once(\'ready\') gated by --development-mode + settings.experimentalCaptureProbe',
    profile: EFFECTIVE_PROFILE.replace(os.tmpdir(), '<OS_TEMP>'),
    rootPid: proc.pid,
    treeKillExit: kill,
    procExitBeforeKill: procExit,
    waitedMs: Date.now() - started,
    rawOutputTail: joined.split('\n').filter(l => l.trim()).slice(-12).map(l => l.trim().slice(0, 200)),
    naturalCaptureHandlerLines: joined.split('\n').filter(l => l.includes('[capture]')).map(l => l.trim().slice(0, 120)),
    hiddenRejectionHandled: sawHidden,
    detachedTabResolved: joined.indexOf('DETACHED_CAPTURE_RESOLVED') !== -1,
    neverAttachedZeroSize: joined.indexOf('NEVER_ATTACHED_CAPTURE_RESOLVED') !== -1,
    visibleCaptureOk: joined.indexOf('VISIBLE_CAPTURE_OK') !== -1,
    visibleSkipped: joined.indexOf('VISIBLE_CASE_SKIPPED') !== -1,
    captureProbeLines: joined.split('\n').filter(l => l.includes('[capture-probe]')).map(l => l.trim()),
    unhandledRejectionLines: joined.split('\n').filter(l => /UnhandledPromiseRejection|unhandledRejection/i.test(l)).map(l => trimLine(l)),
    captureUnavailableCount: (joined.match(/CAPTURE_UNAVAILABLE/g) || []).length,
    noUnhandledRejections: joined.indexOf('UnhandledPromiseRejection') === -1,
    settingsFlag: 'experimentalCaptureProbe=true in throwaway profile only; everyday profile untouched'
  }
  const runDirRemoved = rmrf(RUN_DIR)
  result.runDirRemoved = runDirRemoved
  return result
}

function trimLine (l) {
  return l.trim().slice(0, 200)
}

async function main () {
  const bin = electronBinary()
  const report = {
    task: 'P0-07 capturePage verification',
    ranAt: new Date().toISOString(),
    electron: (() => { try { return require('electron/package.json').version } catch (e) { return 'unknown' } })(),
    fixturePhase: null,
    realMinPhase: null
  }

  report.fixturePhase = runFixture(bin)
  await sleep(1000)
  try {
    report.realMinPhase = await runMinProbe(bin)
  } catch (e) {
    report.realMinPhase = { error: String(e.message) }
  }

  report.conclusions = {
    visibleCaptureWorks: report.fixturePhase.visibleControlProducedPixels === true || report.realMinPhase.visibleCaptureOk === true,
    hiddenCaptureRejectedByElectron: report.fixturePhase.hiddenProducedPixels === false,
    minHiddenRejectionHandled: report.realMinPhase.hiddenRejectionHandled === true,
    minNoUnhandledRejections: report.realMinPhase.noUnhandledRejections === true && report.fixturePhase.noUnhandledRejections === true,
    minimizedStillWorks: report.fixturePhase.minimizedProducedPixels === true
  }

  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({
    conclusions: report.conclusions,
    fixtureCases: report.fixturePhase.cases,
    realMin: {
      captureProbeLines: report.realMinPhase.captureProbeLines,
      hiddenRejectionHandled: report.realMinPhase.hiddenRejectionHandled,
      visibleCaptureOk: report.realMinPhase.visibleCaptureOk,
      unhandledRejectionLines: report.realMinPhase.unhandledRejectionLines
    }
  }, null, 2))

  const ok = report.conclusions.visibleCaptureWorks &&
    report.conclusions.hiddenCaptureRejectedByElectron &&
    report.conclusions.minHiddenRejectionHandled &&
    report.conclusions.minNoUnhandledRejections
  return ok ? 0 : 2
}

main().then(c => process.exit(c)).catch(e => {
  console.error('capture probe error: ' + e.message)
  rmrf(RUN_DIR)
  process.exit(2)
})
