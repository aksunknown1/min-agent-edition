#!/usr/bin/env node
/* P1-15 M1: add browser_eval + browser_viewport to the bridge.
 * The page-side evaluator/serializer is authored as a REAL function
 * (AGENT_EVAL_PAGE_FN) here and transported into the page via
 * Function.prototype.toString() — the same mechanism the snapshot page-fn uses.
 * Idempotent: exits cleanly if already applied. */
const fs = require('fs')
const path = require('path')
const F = 'main/agentRpc.js'
let s = fs.readFileSync(F, 'utf8')

if (s.indexOf('agentRpcCommandEval') !== -1) { console.log('already applied'); process.exit(0) }

function used (sub, why) { if (s.indexOf(sub) === -1) { console.error('ANCHOR-MISSING: ' + why); process.exit(1) } }

used('"browser_transform_status","browser_type","browser_verify","browser_wait"]', 'METHODS tail')
s = s.replace(
  '"browser_transform_status","browser_type","browser_verify","browser_wait"]',
  '"browser_eval","browser_transform_status","browser_type","browser_verify","browser_viewport","browser_wait"]'
)

used('  browser_downloads: {},', 'downloads param schema anchor')
s = s.replace('  browser_downloads: {},', [
  '  browser_downloads: {},',
  '  browser_eval: {',
  "    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },",
  "    expression: { type: 'string', required: true, min: 1, max: 20000 },",
  "    awaitPromise: { type: 'boolean', required: false },",
  "    timeoutMs: { type: 'number', required: false, integer: true, min: 1000, max: 30000 },",
  "    maxResultChars: { type: 'number', required: false, integer: true, min: 1000, max: 200000 }",
  '  },',
  '  browser_viewport: {',
  "    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },",
  "    zoom: { type: 'number', required: false, min: 0.25, max: 3 }",
  '  },'
].join('\n'))

used("  if (method === 'browser_downloads') {", 'dispatcher downloads anchor')
s = s.replace("  if (method === 'browser_downloads') {\n    return agentRpcCommandDownloads()\n  }",
  "  if (method === 'browser_downloads') {\n    return agentRpcCommandDownloads()\n  }\n  if (method === 'browser_eval') {\n    return agentRpcCommandEval(params)\n  }\n  if (method === 'browser_viewport') {\n    return agentRpcCommandViewport(params)\n  }")

used('function agentRpcCommandBatch (params) {', 'batch anchor')
const impl = fs.readFileSync(path.join(__dirname, 'p115-m1-eval-impl.js'), 'utf8')
s = s.replace('function agentRpcCommandBatch (params) {', impl + '
function agentRpcCommandBatch (params) {')

fs.writeFileSync(F, s)
console.log('M1 bridge patch applied')
