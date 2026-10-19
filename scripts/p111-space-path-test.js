#!/usr/bin/env node
/* P1-11: launch packaged app from an install path containing spaces. */
const { spawn, spawnSync } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const EXE = 'C:/Users/AKS-PC/AppData/Local/Temp/p111 spaced dir/Min/' + (fs.existsSync('C:/Users/AKS-PC/AppData/Local/Temp/p111 spaced dir/Min/Min Agent Edition.exe') ? 'Min Agent Edition.exe' : 'Min.exe')
const PROFILE = path.join(os.tmpdir(), 'min-p111-space-' + Date.now())
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main () {
  const min = spawn(EXE, ['--user-data-dir=' + PROFILE, '--agent-rpc', '--', 'https://example.com/'], { cwd: path.dirname(EXE), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  min.stdout.on('data', function () {})
  min.stderr.on('data', function () {})
  let disc = null
  for (let i = 0; i < 50 && !disc; i++) { await sleep(500); try { disc = JSON.parse(fs.readFileSync(path.join(PROFILE, 'agent-rpc.json'), 'utf8')) } catch (e) {} }
  console.log(disc ? 'PASS: packaged app launches from spaced path; bridge listening' : 'FAIL: no discovery from spaced path')
  try { spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(min.pid)], { windowsHide: true }) } catch (e) {}
  setTimeout(() => process.exit(disc ? 0 : 1), 1500)
}
main()
