/* P1-15 M4-2: downloads done-race hardening (fast downloads finishing before
 * event attach would otherwise stay 'progressing' forever). */
const fs = require('fs')
let s = fs.readFileSync('main/agentRpc.js', 'utf8')
const marker = "      item.once('done', function (e3, st3) {"
if (s.indexOf(marker) === -1) { console.error('DL ANCHOR MISS'); process.exit(1) }
const block = marker + "\n" + [
  "        /* P1-15 M4: done-race hardening - if the item finished BEFORE our events",
  "         * attached (fast downloads), the 'done' event never fires and the record",
  "         * would stay 'progressing' forever. Re-check the item state right away. */",
  "        process.nextTick(function () {",
  "          try {",
  "            if (rec.terminal) return",
  "            var stNow = null",
  "            try { stNow = item.getState ? item.getState() : (item.isDone && item.isDone() ? 'completed' : null) } catch (eState) { return }",
  "            if (item.isDone && item.isDone()) stNow = stNow === 'interrupted' ? 'interrupted' : 'completed'",
  "            if (!stNow || stNow === 'progressing') return",
  "            rec.received = item.getReceivedBytes()",
  "            rec.state = stNow",
  "            rec.terminal = true",
  "            rec.endedAt = Date.now()",
  "            rec.canResume = rec.state === 'interrupted' && item.canResume()",
  "            rec.item = null",
  "            agentRpcDlFlushWaiters(rec)",
  "          } catch (eRace) { /* ignore */ }",
  "        })"
].join('\n')
s = s.replace(marker, block)
fs.writeFileSync('main/agentRpc.js', s)
console.log('downloads done-race hardening added')
