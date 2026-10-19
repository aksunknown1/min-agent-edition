#!/usr/bin/env node
/* P1-11 fix 2: expose transformId + selector targeting in the MCP transform action schema. */
const fs = require('fs')
const p = 'mcp/min-agent-mcp.js'
let m = fs.readFileSync(p, 'utf8')
const anchor = "op: { type: 'string', enum: ['replace_text','highlight','set_style','hide','restore_target','restore_all'] },"
if (m.indexOf(anchor) === -1) { console.log('ANCHOR-NOT-FOUND'); process.exit(1) }
if (m.indexOf('transformId:') !== -1 && m.indexOf("description: 'restore_target only") !== -1) { console.log('already applied'); process.exit(0) }
const insert = anchor + `
              transformId: { type: 'string', pattern: '^tf[0-9]+$', description: 'restore_target only: exact transformedId from the apply result (documented P1-04.3 restore path)' },
              selector: { type: 'string', maxLength: 120, description: 'selector targeting (bounded CSS); alternative to ref' },`
m = m.replace(anchor, function () { return insert })
fs.writeFileSync(p, m)
console.log('transformId+selector added to browser_transform schema')
