#!/usr/bin/env node
/* P1-10 agent-level helper: one real MCP tool call per invocation, FULL result JSON.
   usage: node scripts/p110-agent-step.js <tool> <argsJson> [label] [shotPrefix]   */
const lib = require('./p110-lib')
async function main () {
  const tool = process.argv[2]
  const args = JSON.parse(process.argv[3] || '{}')
  const label = process.argv[4] || ''
  const shotPrefix = process.argv[5] || null
  const KP = 47311
  let out = {}
  try {
    const res = await lib.httpPost(KP, { name: tool, args, label, shotPrefix, timeoutMs: 90000 }, 95000)
    if (res.imageFile && res.summary) console.log('IMAGE_SAVED: ' + res.imageFile)
    const s = res.summary || ''
    // summary = image info + JSON text; print the JSON part in full
    const texts = s.split(' | ')
    for (const piece of texts) {
      if (piece.startsWith('image ')) { console.log('[image block] ' + piece); continue }
      try { console.log(JSON.stringify(JSON.parse(piece), null, 1)) } catch (e) { console.log(piece) }
    }
  } catch (e) { console.log('STEP-ERROR ' + (e && e.message)); process.exit(1) }
}
main()
