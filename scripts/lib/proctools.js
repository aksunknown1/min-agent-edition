'use strict'
/*
 * scripts/lib/proctools.js — shared, PID-targeted process cleanup and bounded
 * browser-readiness polling for the Min Agent Edition test/probe harnesses.
 *
 * P1-14 hygiene (from the VPS probe reconciliation): these helpers exist so the
 * probes stop duplicating breadth-unsafe or inconsistency-prone inline logic.
 *
 * Safety contract:
 *  - killTree uses ONLY a process id captured from a process this script spawned
 *    (taskkill /F /T /PID). There are no process-name-wide kills, so unrelated
 *    Electron/Min applications can never be terminated by these helpers.
 *  - PID-reuse risk is minimized by contract, not by guesswork: callers must
 *    invoke killTree within the same run as the spawn, immediately on exit.
 *    (Windows cannot be made race-free from user space; the narrower the window,
 *    the smaller the risk.)
 *  - pollReadiness is bounded and never masks failure: on timeout it rejects
 *    with {code:'PT_TIMEOUT'} carrying the last observed value.
 */

const { spawn, spawnSync } = require('child_process')

/* Targeted termination of a process tree by PID. Never uses /IM (image-name)
 * kills. Safe to call repeatedly; no-op if pid is falsy. */
function killTree (pid) {
  if (!pid) return false
  if (process.platform === 'win32') {
    try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }); return true } catch (e) { return false }
  }
  try { process.kill(pid, 'SIGKILL'); return true } catch (e) { return false }
}

/* Spawn with tracked ownership. Any piped stdio channel is drained
 * automatically (undrained 64KB buffers otherwise block the child mid-run —
 * the P1-12 lesson). Returns { proc, pid }. */
function spawnTracked (cmd, args, opts) {
  const o = Object.assign({ windowsHide: true }, opts || {})
  const stdio = o.stdio || ['ignore', 'pipe', 'pipe']
  if (Array.isArray(stdio)) {
    for (let i = 1; i < 3; i++) {
      if (stdio[i] === 'pipe') {
        o.onStderr = o.onStderr || (d => { /* drained */ })
        o.onStdout = o.onStdout || (d => { /* drained */ })
      }
    }
  }
  const proc = spawn(cmd, args, Object.assign({}, o, { stdio: Array.isArray(stdio) ? stdio.map(s => s) : stdio }))
  if (Array.isArray(stdio) && proc.stdout) proc.stdout.on('data', () => {})
  if (Array.isArray(stdio) && proc.stderr) {
    if (typeof o.onStderr === 'function') proc.stderr.on('data', o.onStderr)
    else proc.stderr.on('data', () => {})
  }
  if (Array.isArray(stdio) && proc.stdout && typeof o.onStdout === 'function') proc.stdout.on('data', o.onStdout)
  return { proc, pid: proc.pid }
}

/* Bounded wait for the bridge discovery file to exist and parse as JSON.
 * Rejects {code:'PT_TIMEOUT'} with the elapsed ms on failure. */
function waitForDiscovery (discPath, opts) {
  const o = Object.assign({ timeoutMs: 60000, intervalMs: 400 }, opts || {})
  const started = Date.now()
  return new Promise(function (resolve, reject) {
    const tick = function () {
      let disc = null
      try { disc = JSON.parse(fsRead(discPath)) } catch (e) { /* not ready */ }
      if (disc) return resolve(disc)
      if (Date.now() - started > o.timeoutMs) {
        return reject(Object.assign(new Error('discovery file not ready: ' + discPath), { code: 'PT_TIMEOUT', elapsedMs: Date.now() - started }))
      }
      setTimeout(tick, o.intervalMs)
    }
    tick()
  })
}
const fsRead = p => require('fs').readFileSync(p, 'utf8')

/* Bounded readiness poll. readFn must be an async() => any (e.g. browser_tabs
 * call). predicate(value) decides readiness. While the timeout bound is open,
 * "not ready" values (empty arrays, empty-shell objects, transient errors) are
 * tolerated and re-polled; when the bound closes, the helper rejects with
 * {code:'PT_TIMEOUT', last: value} so a browser that never becomes ready is
 * still a FAILURE. */
async function pollReadiness (readFn, predicate, opts) {
  const o = Object.assign({ timeoutMs: 30000, intervalMs: 400 }, opts || {})
  const started = Date.now()
  let last = null
  for (;;) {
    let value = null
    try { value = await readFn() } catch (eTransient) { value = { transientError: String(eTransient && eTransient.message) } }
    last = value
    try { if (predicate(value)) return { value: value, elapsedMs: Date.now() - started } } catch (e) { /* predicate rejection = not ready */ }
    if (Date.now() - started > o.timeoutMs) {
      throw Object.assign(new Error('readiness poll timed out'), { code: 'PT_TIMEOUT', last: value, elapsedMs: Date.now() - started })
    }
    await new Promise(r => setTimeout(r, o.intervalMs))
  }
}

/* Convenience: tabs-view readiness predicate. Non-empty AND structurally valid
 * (every tab has a non-empty url and no loading flags — i.e. no empty-shell
 * entries). If urlFragment is given, the launcher's start-URL tab must be
 * present among them. */
function tabsStablePredicate (urlFragment) {
  return function (tabs) {
    if (!Array.isArray(tabs) || tabs.length === 0) return false
    for (const t of tabs) {
      if (!t || typeof t.url !== 'string' || t.url.length === 0) return false
      if (t.loading === true) return false
    }
    return urlFragment ? tabs.some(t => String(t.url).indexOf(urlFragment) !== -1) : true
  }
}

module.exports = { killTree, spawnTracked, waitForDiscovery, pollReadiness, tabsStablePredicate }
