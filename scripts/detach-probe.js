#!/usr/bin/env node
/*
 * P0-08 Part B: deterministic detach-crash probe runner.
 *
 * Runs each scenario of the --probe-detach hook (main/viewManager.js) in its
 * own freshly created Min launch with one URL, and records:
 *   - whether the DONE marker appeared (i.e. the scenario ran to completion);
 *   - whether the process self-exited before we killed it;
 *   - UNCAUGHT_EXCEPTION / UNHANDLED_REJECTION / RENDER_PROCESS_GONE /
 *     CHILD_PROCESS_GONE lines;
 *   - which markers were seen.
 *
 * Writes docs/detach-probe.json. */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'detach-probe.json')
const bin = require('electron')
const WIN32 = process.platform === 'win32'

const SCENARIOS = ['D0', 'D1', 'D2', 'D3', 'G']
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

async function runScenario (scn, D) {
  rmrf(D)
  fs.mkdirSync(path.join(D, 'p-development'), { recursive: true })
  fs.writeFileSync(path.join(D, 'p-development', 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  const tab = path.join(D, 'tab.html')
  /* Duplicate URL content is not passed twice; a second positional URL arg is
   * the P0-08 runtime crash and is out of scope here. */
  fs.writeFileSync(tab, '<!doctype html><html><head><title>Detach Probe Tab</title></head><body style="margin:0;background:rgb(251,191,36)"><p>detach probe</p></body></html>', 'utf8')
  const tabUrl = 'file:///' + tab.replace(/\\/g, '/')

  const proc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + path.join(D, 'p'),
    '--probe-detach', '--probe-detach-scenario=' + scn, tabUrl],
  { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

  let out = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { out += d })
  let killedByUs = false
  let selfExit = null
  proc.on('exit', function (code) {
    if (!killedByUs) selfExit = code
  })

  const started = Date.now()
  let done = false
  while (Date.now() - started < 30000) {
    await sleep(1000)
    if (/\[detach-probe\] DONE /.test(out)) { done = true; break }
    if (/\[detach-probe\] (UNCAUGHT_EXCEPTION|RENDER_PROCESS_GONE)/.test(out) && /\[detach-probe\]/.test(out)) {
      /* keep waiting a moment in case a handler line is followed by DONE */
    }
    if (selfExit !== null) break
  }

  let killExit = null
  if (!killedByUs) {
    killedByUs = true
    killExit = WIN32
      ? spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], { encoding: 'utf8', windowsHide: true }).status
      : null
    await sleep(2000)
  }

  const lines = out.split('\n').filter(l => l.includes('[detach-probe]')).map(l => l.trim())
  const result = {
    scenario: scn,
    done: done,
    survived: selfExit === null && done,
    selfExit,
    killExit,
    waitedMs: Date.now() - started,
    events: {
      uncaughtException: lines.filter(l => l.includes('UNCAUGHT_EXCEPTION')),
      unhandledRejection: lines.filter(l => l.includes('UNHANDLED_REJECTION')),
      renderProcessGone: lines.filter(l => l.includes('RENDER_PROCESS_GONE')),
      childProcessGone: lines.filter(l => l.includes('CHILD_PROCESS_GONE'))
    },
    markers: lines
  }
  return result
}

async function main () {
  const report = { task: 'P0-08 detach-crash probe', ranAt: new Date().toISOString(), scenarios: {} }

  for (const scn of SCENARIOS) {
    const D = path.join(os.tmpdir(), 'min-detach-' + scn)
    report.scenarios[scn] = await runScenario(scn, D)
    rmrf(D)
    await sleep(1000)
  }

  const s = report.scenarios
  report.crashReproducedNote =
    (!s.D0.done && 'D0 (capture while attached)') ||
    (!s.D1.done && 'D1 (detach alone, no capture)') ||
    (!s.D2.done && 'D2 (detach + capturePage same tick)') ||
    (!s.D3.done && 'D3 (capture of already-detached background view)') ||
    (!s.G.done && 'G (product guard attachment check)') ||
    null

  const gLines = s.G.markers.join('\n')
  report.classification = {
    captureWhileAttachedWorks: s.D0.done && !s.D0.events.uncaughtException.length,
    detachAloneIsSafe: s.D1.done && !s.D1.events.uncaughtException.length && s.D1.selfExit === null,
    captureAfterDetachHangs: !s.D2.done && s.D2.selfExit === null,
    captureOfAlreadyDetachedViewIsSafe: s.D3.done,
    guardBlocksDeadlyCapture: /G-GUARD-BLOCKS-CAPTURE-EXPECTED/.test(gLines),
    crashReproduced: !!report.crashReproducedNote,
    crashTrigger: report.crashReproducedNote
  }

  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ scenarios: report.scenarios, classification: report.classification }, null, 2))
  /* Every scenario must be accounted for as one of: completed (DONE), crashed
   * (process self-exit), or hung (armed, produced output, never finished - the
   * recorded D2 outcome, which is itself the diagnostic result). Combined with
   * the guard verdict being decisive, the probe is then complete. */
  const allDecided = SCENARIOS.every(function (k) {
    const sc = report.scenarios[k]
    const armed = sc.markers.some(l => l.includes('ARMED'))
    return armed && (sc.done || sc.selfExit !== null || sc.markers.length > 1)
  })
  return allDecided && report.classification.guardBlocksDeadlyCapture ? 0 : 2
}

main().then(c => process.exit(c)).catch(e => {
  console.error('detach probe error: ' + e.message)
  SCENARIOS.forEach(s => { try { fs.rmSync(path.join(os.tmpdir(), 'min-detach-' + s), { recursive: true, force: true }) } catch (ignored) {} })
  process.exit(2)
})
