#!/usr/bin/env node
/*
 * P0-12 launcher: starts a visible Min (development mode) with the agent-rpc
 * bridge on a dedicated profile.
 *
 * Usage:
 *   node scripts/min-launch.js [--profile=<dir>] [-- <startUrl> [url2 …]]
 *
 * Default profile dir: %USERPROFILE%\.min-agent-profile
 * Overridable per launch with --profile=<dir>.
 *
 * Start URLs MUST come after `--` (P0-08 rule: a positional URL followed by
 * another positional URL crashes the Electron runtime before Min runs; the
 * `--` form is safe for any count).
 *
 * stdout carries exactly three startup lines ("profile", "discovery-file",
 * "ready") and nothing else - the token never appears there. Diagnostic
 * messages go to stderr. The Electron child's output is piped and FILTERED —
 * only lifecycle lines are forwarded to launcher stderr; nothing from Min's pages can leak.
 *
 * Ctrl+C kills the Electron process tree that was started here.
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const WIN32 = process.platform === 'win32'

const argv = process.argv.slice(2)
let profileDir = path.join(os.homedir(), '.min-agent-profile')
const startUrls = []
let afterDash = false

for (const a of argv) {
  if (a === '--') { afterDash = true; continue }
  if (!afterDash && a.indexOf('--profile=') === 0) {
    const v = a.slice('--profile='.length)
    if (!v) { console.error('min-launch: --profile= requires a directory'); process.exit(2) }
    profileDir = path.resolve(v)
    continue
  }
  if (!afterDash && a === '--help' || a === '-h') {
    console.error('usage: node scripts/min-launch.js [--profile=<dir>] [-- <startUrl> …]')
    process.exit(0)
  }
  if (!afterDash && a.charAt(0) === '-') {
    console.error('min-launch: unknown option "' + a + '"')
    console.error('usage: node scripts/min-launch.js [--profile=<dir>] [-- <startUrl> …]')
    process.exit(2)
  }
  if (afterDash) startUrls.push(a)
}

/* Min appends "-development" to userData in development mode
 * (main/main.js), so the discovery file lives in <profile>-development. */
const discoveryFile = path.join(profileDir + '-development', 'agent-rpc.json')

fs.mkdirSync(profileDir, { recursive: true })

const bin = require('electron')
const electronArgs = ['.', '--development-mode', '--agent-rpc', '--user-data-dir=' + profileDir]
/* P0-08: start URLs always after `--`, any count. */
if (startUrls.length > 0) electronArgs.push('--')

let killedByUs = false
let exited = false
const child = spawn(bin, electronArgs.concat(startUrls), {
  cwd: ROOT,
  /* stdout of the launcher carries only the three startup lines; Min's child
   * output is piped and FILTERED — only bridge lifecycle lines ([agent-rpc],
   * MAIN-THREAD-LAG) are forwarded to the launcher's STDERR (never stdout,
   * never page content, never tokens). */
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
  const BRIDGE_LINE_RE = /\[agent-rpc|MAIN-THREAD-LAG/
  child.stdout.on('data', function (d) {
    String(d).split('\n').forEach(function (line) {
      if (BRIDGE_LINE_RE.test(line)) process.stderr.write('[min-bridge] ' + line.trim() + '\n')
    })
  })
  child.stderr.on('data', function (d) {
    String(d).split('\n').forEach(function (line) {
      if (BRIDGE_LINE_RE.test(line)) process.stderr.write('[min-bridge-err] ' + line.trim() + '\n')
    })
  })

child.on('exit', function (code, signal) {
  exited = true
  if (killedByUs) return /* we initiated the kill; the exit handler below reports */
  console.log('min exited (code ' + code + (signal ? ', ' + signal : '') + ')')
  process.exit(code || 0)
})

function killTree () {
  if (killedByUs || exited) return
  killedByUs = true
  if (WIN32) {
    spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (e) { try { child.kill('SIGKILL') } catch (e2) { /* gone */ } }
  }
}

process.on('SIGINT', function () {
  killTree()
  process.exit(0)
})
process.on('SIGTERM', function () {
  killTree()
  process.exit(0)
})

console.log('profile: ' + profileDir)
console.log('discovery-file: ' + discoveryFile)

/* Ready = the bridge published its discovery file (token stays in the file). */
let announced = false
const deadline = Date.now() + 60000
const t = setInterval(function () {
  if (announced) return
  if (fs.existsSync(discoveryFile)) {
    announced = true
    clearInterval(t)
    console.log('ready')
    return
  }
  if (exited) { clearInterval(t); return }
  if (Date.now() > deadline) {
    clearInterval(t)
    console.error('min-launch: the agent-rpc discovery file did not appear within 60s; is the agent-rpc bridge built into this Min build? (npm run build)')
    killTree()
    process.exit(1)
  }
}, 500)
