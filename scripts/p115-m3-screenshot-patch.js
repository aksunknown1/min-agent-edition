#!/usr/bin/env node
/* P1-15 M3: replace agentRpcCommandScreenshot with the adaptive-ladder +
 * element-scoped-capture implementation, and add the new screenshots params to
 * the bridge schema. Anchored, idempotent. */
const fs = require('fs')
const F = 'main/agentRpc.js'
let s = fs.readFileSync(F, 'utf8')


/* ---- 1. param schema additions ---- */
const schemaAnchor = '  browser_screenshot: {\n    tabId: { type: \'string\', required: true, pattern: /^[0-9]{1,20}$/ },'
if (s.indexOf(schemaAnchor) === -1) { console.error('SCHEMA ANCHOR MISSING'); process.exit(1) }
s = s.replace(schemaAnchor, schemaAnchor + [
  '',
  '    /* P1-15 M3: adaptive fallback ladder + element capture + explicit byte cap. */',
  "    maxBytes: { type: 'number', required: false, integer: true, min: 5000, max: 5242880 },",
  "    selector: { type: 'string', required: false, maxLength: 300 }"
].join('\n'))

/* ---- 2. helpers + handler replacement (replace the whole old function) ---- */
const start = s.indexOf('function agentRpcCommandScreenshot (params) {')
const endMarker = '/* ---------- transport ---------- */'
const end = s.indexOf(endMarker)
if (start === -1 || end === -1 || end <= start) { console.error('HANDLER BOUNDS MISSING'); process.exit(1) }

const handler = fs.readFileSync(__dirname + '/p115-m3-screenshot-handler.js', 'utf8')
s = s.slice(0, start) + handler + '\n' + s.slice(end)

fs.writeFileSync(F, s)
console.log('M3 screenshot patch applied')
