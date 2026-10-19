#!/usr/bin/env node
/*
 * P0-02A baseline smoke harness.
 *
 * Verifies, as runtime evidence rather than assumption, that the Min dev
 * workflow still works: build succeeds, the app launches, a top-level window
 * whose title contains "Min" appears, at least one real webContents (tab)
 * exists, and the whole process tree is then torn down cleanly.
 *
 * Launch is Electron dev mode driven directly (node_modules/electron/dist/
 * electron.exe . --development-mode <file URL>) after `npm run build`. This is
 * the same Electron dev entry that `npm run startElectron` uses, plus a
 * controlled local file URL so a tab is guaranteed to exist. It is NOT
 * identical to `npm run start`, which also spawns the chokidar watch process
 * and restores whatever tabs the profile happened to have. Without a URL
 * argument, a profile with no restored tab yields zero tab renderers, which
 * previously produced a false failure.
 *
 * Tab evidence is obtained WITHOUT instrumenting the app: Min creates tab
 * views with `sandbox: true` (main/viewManager.js:19) while its own privileged
 * UI windows use `nodeIntegration` and are launched `--no-sandbox`. So an
 * electron.exe renderer carrying `--enable-sandbox` is a loaded web content
 * view. The tab is requested the way any command-line URL is: Min's own
 * handleCommandLineArguments (main/main.js:136) turns an argv containing "://"
 * into an addTab IPC call. No code is injected into the app.
 *
 * Safety: this script takes no arguments, interpolates nothing into a shell,
 * never uses `shell: true`, never enables a remote debugging port (no CDP
 * surface), never evaluates code in the app, and writes exactly two files:
 * docs/smoke-baseline.json in the project, and one static HTML file under the
 * OS temp directory, which is deleted again at the end of every run.
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_FILE = path.join(ROOT, 'docs', 'smoke-baseline.json')
const WIN32 = process.platform === 'win32'

/* The controlled tab: one static HTML file in the OS temp directory. */
const TEMP_REL = path.join('min-agent-edition-smoke', 'min-agent-edition-smoke-tab.html')
const TEMP_FILE = path.join(os.tmpdir(), TEMP_REL)
const TAB_MARKER = 'Min Agent Smoke Tab'
const TAB_HTML = '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>' + TAB_MARKER + '</title></head>\n<body><p>' + TAB_MARKER + '</p></body>\n</html>\n'

const WINDOW_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000)
const POLL_MS = 2000

function electronBinary () {
  const resolved = require('electron')
  if (typeof resolved !== 'string') {
    throw new Error('electron package did not resolve to a binary path')
  }
  return resolved
}

function createTabFile () {
  fs.mkdirSync(path.dirname(TEMP_FILE), { recursive: true })
  fs.writeFileSync(TEMP_FILE, TAB_HTML, 'utf8')
  return TEMP_FILE
}

function removeTabFile () {
  try {
    if (fs.existsSync(TEMP_FILE)) {
      fs.unlinkSync(TEMP_FILE)
    }
    fs.rmdirSync(path.dirname(TEMP_FILE))
    return { removed: true, stillPresent: false }
  } catch (e) {
    return { removed: false, stillPresent: fs.existsSync(TEMP_FILE), error: e.message }
  }
}

/* Static argv only - never built from user input. */
function npmArgv (args) {
  return WIN32 ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'npm'].concat(args) } : { cmd: 'npm', args }
}

function runNpm (args) {
  const spec = npmArgv(args)
  const t0 = Date.now()
  const res = spawnSync(spec.cmd, spec.args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  return {
    command: 'npm ' + args.join(' '),
    exitCode: res.status,
    error: res.error ? String(res.error.message || res.error) : null,
    durationMs: Date.now() - t0,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim()
  }
}

/* Fixed PowerShell script; no interpolation. Returns parsed process snapshot. */
const PS_SNAPSHOT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$p = Get-CimInstance Win32_Process -Filter \"Name='electron.exe' or Name='node.exe'\"",
  "$t = @{}",
  'Get-Process electron | ForEach-Object { if ($_.MainWindowTitle) { $t[[int]$_.Id] = $_.MainWindowTitle } }',
  'ConvertTo-Json -Compress -Depth 3 -InputObject @($p | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; title=$t[[int]$_.ProcessId] } })'
].join('; ')

function snapshot () {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SNAPSHOT], { encoding: 'utf8', windowsHide: true })
  if (res.status !== 0) {
    throw new Error('powershell snapshot failed (exit ' + res.status + '): ' + (res.stderr || '').trim())
  }
  const out = (res.stdout || '').trim()
  if (!out) return []
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/* Scope everything to this workspace so unrelated processes are never touched. */
const owns = p => !!p.cmd && p.cmd.includes(ROOT)
const isDevMain = p => p.name === 'electron.exe' && /--development-mode/.test(p.cmd || '') && !/--type=/.test(p.cmd || '')
const isTabRenderer = p => p.name === 'electron.exe' && /--type=renderer/.test(p.cmd || '') && /--enable-sandbox/.test(p.cmd || '')
const isUiRenderer = p => p.name === 'electron.exe' && /--type=renderer/.test(p.cmd || '') && /--no-sandbox/.test(p.cmd || '')
/* Only the dev-launch helpers, so a user's unrelated node process is safe. */
const isDevHelper = p => p.name === 'node.exe' && /concurrently|watch\.js|startElectron/.test(p.cmd || '')

function evaluate () {
  const procs = snapshot()
  const mine = procs.filter(owns)
  const titles = mine.map(p => p.title).filter(t => !!t)
  return {
    mainProcesses: mine.filter(isDevMain).length,
    tabRenderers: mine.filter(isTabRenderer).length,
    uiRenderers: mine.filter(isUiRenderer).length,
    devHelpers: mine.filter(isDevHelper).length,
    electronProcesses: mine.filter(p => p.name === 'electron.exe').length,
    windowTitles: titles,
    windowTitleSeen: titles.find(t => t.includes('Min')) || null
  }
}

function killTree (rootPid) {
  if (!WIN32 || !rootPid) return { command: 'kill -TERM ' + rootPid, exitCode: null }
  const res = spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(rootPid)], { encoding: 'utf8', windowsHide: true })
  return {
    command: 'taskkill /F /T /PID ' + rootPid,
    exitCode: res.status,
    output: ((res.stdout || '') + (res.stderr || '')).trim()
  }
}

/* Path-scoped fallback reap for orphans left by earlier interrupted runs. */
function reapStrays () {
  const killed = []
  let procs
  try { procs = snapshot() } catch (e) { return { killed, error: e.message } }
  for (const p of procs.filter(owns)) {
    if (p.name === 'electron.exe' || isDevHelper(p)) {
      const res = spawnSync('taskkill.exe', ['/F', '/PID', String(p.pid)], { encoding: 'utf8', windowsHide: true })
      killed.push({ pid: p.pid, name: p.name, exitCode: res.status })
    }
  }
  return { killed }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main () {
  const report = {
    task: 'P0-02A smoke-baseline',
    startedAt: new Date().toISOString(),
    platform: process.platform + ' ' + process.arch,
    node: process.version,
    /* Machine-neutral on purpose: this evidence file can end up inside a package. */
    workspace: path.basename(ROOT),
    tabFile: { relativeToOsTemp: TEMP_REL, marker: TAB_MARKER },
    steps: [],
    checks: [],
    launch: null,
    teardown: null,
    afterTeardown: null
  }

  /* 0. clear orphans from previous interrupted runs */
  report.preflightReap = reapStrays()

  /* 1. build */
  const build = runNpm(['run', 'build'])
  report.steps.push(build)

  let observed = null
  let settled = false
  let after = null
  let launch = null
  let launchExit = null
  const launchOutput = []

  try {
    /* 2. controlled tab file, then the Electron dev entry plus a URL argument */
    createTabFile()
    const tabUrl = pathToFileURL(TEMP_FILE).href
    const bin = electronBinary()

    const launchT0 = Date.now()
    launch = spawn(bin, ['.', '--development-mode', tabUrl], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    launch.stdout.on('data', d => launchOutput.push(String(d)))
    launch.stderr.on('data', d => launchOutput.push(String(d)))
    launch.on('exit', code => { launchExit = code })

    report.launch = {
      command: path.relative(ROOT, bin) + ' . --development-mode file://<OS_TEMP>/' + TEMP_REL.split(path.sep).join('/'),
      rootPid: launch.pid,
      exitCode: null
    }
    console.log('launching: ' + path.relative(ROOT, bin) + ' . --development-mode ' + tabUrl)

    /* 3. poll for window + tab evidence */
    const deadline = Date.now() + WINDOW_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      if (launchExit !== null) break
      try {
        observed = evaluate()
      } catch (e) {
        report.snapshotError = e.message
        continue
      }
      if (observed.mainProcesses >= 1 && observed.windowTitleSeen && observed.tabRenderers >= 1) {
        settled = true
        break
      }
    }
    report.launch.launchDurationMs = Date.now() - launchT0
    report.observed = observed
    report.launch.settled = settled

    /* 4. teardown */
    let treeKill
    if (WIN32) {
      treeKill = killTree(launch.pid)
    } else {
      launch.kill('SIGTERM')
      treeKill = { command: 'kill ' + launch.pid, exitCode: null }
    }
    const strayReap = reapStrays()
    report.teardown = { treeKill, strayReap }

    /* 5. verify nothing survived */
    for (let i = 0; i < 5; i++) {
      await sleep(1000)
      after = evaluate()
      if (after.electronProcesses === 0 && after.devHelpers === 0) break
    }
    report.afterTeardown = after
  } finally {
    /* 6. the temp tab file is removed even if a step above threw */
    report.tabFileCleanup = removeTabFile()
  }

  /* 6. checks */
  report.checks = [
    { name: 'npm run build exit 0', pass: build.exitCode === 0, detail: 'exit=' + build.exitCode + ' in ' + build.durationMs + 'ms' },
    { name: 'electron main process running', pass: !!observed && observed.mainProcesses >= 1, detail: observed ? 'main=' + observed.mainProcesses : 'never observed' },
    { name: 'top-level window title contains "Min"', pass: !!observed && !!observed.windowTitleSeen, detail: observed ? JSON.stringify(observed.windowTitles) : 'never observed' },
    { name: '>=1 loaded webContents (sandboxed tab renderer)', pass: !!observed && observed.tabRenderers >= 1, detail: observed ? 'tabRenderers=' + observed.tabRenderers + ' uiRenderers=' + observed.uiRenderers : 'never observed' },
    { name: 'process tree terminated cleanly', pass: !!after && after.electronProcesses === 0 && after.devHelpers === 0, detail: after ? 'electron=' + after.electronProcesses + ' devHelpers=' + after.devHelpers : 'snapshot failed' },
    { name: 'temporary tab file removed', pass: !!report.tabFileCleanup && report.tabFileCleanup.removed === true, detail: JSON.stringify(report.tabFileCleanup) }
  ]

  report.launch.exitCode = launchExit
  report.launch.outputTail = launchOutput.join('').split('\n').filter(l => l.trim()).slice(-40)
  report.finishedAt = new Date().toISOString()
  report.allPassed = report.checks.every(c => c.pass)

  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(report, null, 2), 'utf8')

  console.log('\n=== P0-02A smoke-baseline ===')
  for (const c of report.checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name + '  [' + c.detail + ']')
  }
  console.log('\nevidence written to: ' + EVIDENCE_FILE)
  console.log('launch root pid: ' + (launch && launch.pid) + '  settled: ' + settled)
  return report.allPassed ? 0 : 1
}

main().then(code => process.exit(code)).catch(err => {
  console.error('smoke harness error: ' + err.message)
  process.exit(2)
})
