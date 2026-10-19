#!/usr/bin/env node
/*
 * P1-10 MCP keeper: keeps Min + the REAL MCP stdio adapter running and exposes a
 * localhost HTTP control port so an external agent (the evaluator) can issue one
 * MCP tool call at a time and make decisions between calls - the MCP adapter
 * itself is the real configured client path.
 *
 *   POST /call     {name, args, timeoutMs, label, shotPrefix} -> {isError, imageFile, latency, summary}
 *   POST /shutdown {}
 *
 * Every call is appended to docs/p110-runs/trace-<runId>.jsonl (tool, latency,
 * ok/error, image file path, summary). Shutdown terminates ONLY the processes
 * this keeper spawned (targeted PID tree kills) and removes the temp profile.
 *
 * usage: node scripts/p110-keeper.js [--fixture-port=47310] [--control-port=47311]
 * prints: keeper-ready <controlPort> <fixturePort> <runId>
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const lib = require('./p110-lib')

const args = process.argv.slice(2)
let fixturePort = 47310
let controlPort = 47311
for (const a of args) {
  if (a.indexOf('--fixture-port=') === 0) fixturePort = parseInt(a.slice(14), 10) || fixturePort
  if (a.indexOf('--control-port=') === 0) controlPort = parseInt(a.slice(14), 10) || controlPort
}

let stack = null
let shuttingDown = false

async function shutdown () {
  if (shuttingDown || !stack) return
  shuttingDown = true
  try { await stack.shutdown() } catch (e) { console.error('shutdown-error ' + e.message) }
  console.log('keeper-shutdown')
  setTimeout(() => process.exit(0), 200)
}

async function main () {
  const runId = 'p110-' + Date.now()
  stack = await lib.launchStack({ fixturePort, profileBase: path.join(require('os').tmpdir(), 'min-p110-prof-' + runId), startPath: '/known' })
  const tracePath = path.join(lib.ROOT, 'docs', 'p110-runs', 'trace-' + runId + '.jsonl')
  fs.mkdirSync(path.dirname(tracePath), { recursive: true })
  try { fs.writeFileSync(tracePath, '') } catch (e) { /* ignore */ }

  const server = http.createServer(function (req, res) {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', async function () {
      let out = { ok: false }
      try {
        if (req.url === '/call' && req.method === 'POST') {
          const j = JSON.parse(body)
          const r = await stack.callTool(j.name, j.args, { timeoutMs: j.timeoutMs || 60000, label: j.label || '', shotPrefix: j.shotPrefix || null })
          out = { ok: true, isError: r.isError, imageFile: r.imageFile, latencyMs: r.latency, summary: r.summary }
          try { fs.appendFileSync(tracePath, JSON.stringify(stack.trace[stack.trace.length - 1]) + '\n') } catch (e) { /* ignore */ }
        } else if (req.url === '/shutdown' && req.method === 'POST') {
          out = { ok: true, bye: true }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out))
          await shutdown()
          return
        } else if (req.url === '/ping') {
          out = { ok: true, runId }
        } else {
          out = { ok: false, error: 'unknown route' }
        }
      } catch (e) {
        out = { ok: false, error: String(e && e.message) }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  server.listen(controlPort, '127.0.0.1', function () {
    console.log('keeper-ready ' + controlPort + ' ' + fixturePort + ' ' + runId)
  })
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(function (e) { console.error('keeper-fatal ' + (e && e.message)); process.exit(1) })
