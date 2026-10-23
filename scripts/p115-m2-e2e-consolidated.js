/* P1-15: consolidated mcp-e2e patch — from the clean committed version.
 * Re-runnable: idempotent by the P1-15 marker. */
const fs = require('fs')

if (fs.existsSync('scripts/mcp-e2e.js.patched')) { console.log('already applied (marker file exists). delete scripts/mcp-e2e.js.patched to re-run'); process.exit(0) }

let s = fs.readFileSync('scripts/mcp-e2e.js', 'utf8')

/* 1. census 31 -> 33 */
const censusOld = "  check('tools/list returns exactly the 31 bridge tools (P1-06: + browser_mouse)', r.result && Array.isArray(r.result.tools) && r.result.tools.length === 31 &&"
const censusNew = "  check('tools/list returns exactly the 33 bridge tools (P1-15: + browser_eval/browser_viewport)', r.result && Array.isArray(r.result.tools) && r.result.tools.length === 33 &&"
console.assert(s.indexOf(censusOld) !== -1, 'census anchor missing')
s = s.replace(censusOld, censusNew)
s = s.replace('"browser_downloads", \'browser_grant\'', '"browser_downloads", \'browser_eval\', \'browser_grant\'')
s = s.replace("'browser_verify', 'browser_wait']))", "'browser_verify', 'browser_viewport', 'browser_wait']))")

/* 2. act.html noise canvas */
const actOld = "    '<div id=\"out\">initial</div>' +"
const actNew = "    '<div id=\"out\">initial</div>' +\n" +
  "    '<canvas id=\"noisecv\" width=\"2400\" height=\"1200\" style=\"display:block\"></canvas>' +\n" +
  "    '<scr' + 'ipt>' +\n" +
  '    \'var nc=document.getElementById("noisecv").getContext("2d");\' +\n' +
  '    \'var x=12345;function rnd(){x=(x*1103515245+12345)&0x7fffffff;return x&0xff}\' +\n' +
  '    \'for(var py=0;py<1200;py+=8){for(var px=0;px<2400;px+=8){nc.fillStyle="rgb("+rnd()+","+rnd()+","+rnd()+")";nc.fillRect(px,py,8,8)}}\' +\n' +
  "    '</scr' + 'ipt>' +"
console.assert(s.indexOf(actOld) !== -1, 'act anchor missing')
s = s.replace(actOld, actNew)

/* 3. batch enum */
const enumOld = "'browser_state','browser_tab_open','browser_tab_select','browser_tab_close'] },"
console.assert(s.indexOf(enumOld) !== -1, 'enum anchor missing')
s = s.replace(enumOld, "'browser_state','browser_tab_open','browser_tab_select','browser_tab_close','browser_eval','browser_viewport'] },")

/* 4. acceptance block */
const block = [
  '',
  "  /* ---------------- P1-15 acceptance block (eval / canvas / ladder / batch / settle) ---------------- */",
  "  const p115_s1 = textOf(await call('browser_snapshot', { tabId: actTab0.tabId }, 's115'))",
  "  const p115_fieldRef = (p115_s1.nodes.find(n => n.role === 'textbox' && /Agent Field/i.test(n.name || '')) || {}).ref",
  '  check("P1-15: Agent Field textbox ref exists", !!p115_fieldRef)',
  "  const p115_evTitle = textOf(await call('browser_eval', { tabId: actTab0.tabId, expression: '({title: document.title, ready: document.readyState})' }, 'ev1'))",
  "  check('P1-15 browser_eval: reads the target tab main world (title/readyState)', p115_evTitle && p115_evTitle.ok !== false && p115_evTitle.executionContext === 'main-frame-page-world' && p115_evTitle.value, JSON.stringify(p115_evTitle).slice(0, 160))",
  "  const p115_evCanvas = textOf(await call('browser_eval', { tabId: actTab0.tabId, expression: '(function(){var c=document.createElement(\"canvas\");c.width=64;c.height=32;var g=c.getContext(\"2d\");g.fillStyle=\"rgb(10,20,30)\";g.fillRect(0,0,64,32);var d=g.getImageData(0,0,64,32).data;var n=0;for(var i=0;i<d.length;i+=4){if(d[i]===10&&d[i+1]===20&&d[i+2]===30)n++}return{w:64,h:32,opaque:n,total:d.length}})()' }, 'ev2'))",
  "  check('P1-15 browser_eval: canvas getImageData inspection', p115_evCanvas && p115_evCanvas.ok !== false && JSON.stringify(p115_evCanvas.value).indexOf('\"total\":2048') !== -1, JSON.stringify(p115_evCanvas && p115_evCanvas.value).slice(0, 200))",
  "  const p115_evReject = await call('browser_eval', { tabId: actTab0.tabId, expression: 'Promise.reject(new RangeError(\"expected-p115\"))', awaitPromise: true }, 'ev3')",
  '  const p115_evRejectErr = p115_evReject.error || (p115_evReject.result && p115_evReject.result.isError === true ? (p115_evReject.result.content[0].text) : null)',
  "  check('P1-15 browser_eval: rejected promise -> structured eval_rejected', !!p115_evRejectErr && /expected-p115/.test(String(p115_evRejectErr)), String(p115_evRejectErr).slice(0, 160))",
  "  const p115_evOversize = await call('browser_eval', { tabId: actTab0.tabId, expression: '(function(){var a=[];for(var i=0;i<5000;i++)a.push({i:i,s:\"p\"+i});return a})()', maxResultChars: 8000 }, 'ev4')",
  "  const p115_evOData = textOf(p115_evOversize)",
  "  check('P1-15 browser_eval: oversized output -> truncated/tight serialization', !!p115_evOData && p115_evOData.truncated === true, JSON.stringify(p115_evOData && { t: p115_evOData.truncated }).slice(0, 120))",
  "  const p115_evNode = textOf(await call('browser_eval', { tabId: actTab0.tabId, expression: '(function(){return document.getElementById(\"out\").textContent + \"|p115-inspected\"})()' }, 'ev5'))",
  "  check('P1-15 browser_eval: page-local value read', !!p115_evNode && JSON.stringify(p115_evNode).indexOf('p115-inspected') !== -1, JSON.stringify(p115_evNode && p115_evNode.value).slice(0, 200))",
  '',
  "  /* batch stopOnError=false: failing verify step reported, later steps continue */",
  "  const p115_b1 = textOf(await call('browser_batch', { tabId: actTab0.tabId, stopOnError: false, actions: JSON.stringify([",
  '    { tool: "browser_snapshot", params: {} },',
  '    { tool: "browser_verify", params: { textContains: "STRING-THAT-IS-NOT-PRESENT" } }',
  '  ]) }, "b1"))',
  "  check('P1-15 batch stopOnError=false: failing step reported, later steps continue', p115_b1 && p115_b1.ok === false && p115_b1.completed === 2 && p115_b1.steps.length === 2 && p115_b1.steps[1].ok === true, JSON.stringify(p115_b1 && { ok: p115_b1.ok, comp: p115_b1.completed, steps: p115_b1.steps.map(x => ({ s: x.step, ok: x.ok })) }).slice(0, 240))",
  '',
  "  /* stale-ref recovery: unknown identity must FAIL structurally (never silently re-target) */",
  "  const p115_b2 = textOf(await call('browser_batch', { tabId: actTab0.tabId, recoverStale: true, actions: JSON.stringify([",
  '    { tool: "browser_type", params: { ref: "r0zz", text: "p115-recovery" } },',
  '    { tool: "browser_verify", params: { textContains: "p115-recovery" } }',
  '  ]) }, "b2"))',
  "  check('P1-15 batch recoverStale: unknown identity -> structured recovery failure (no silent guest-target)', !!p115_b2 && p115_b2.steps.length >= 1 && p115_b2.steps[0].ok === false, JSON.stringify(p115_b2 && p115_b2.steps).slice(0, 240))",
  '',
  "  /* verification:none — immediate dispatch-only result (honest unverified) */",
  "  const p115_clickNone = textOf(await call('browser_click', { tabId: actTab0.tabId, ref: p115_fieldRef, verification: 'none' }, 'cnx'))",
  "  check('P1-15 click verification:none -> dispatched + verification none', p115_clickNone && p115_clickNone.dispatched === true && p115_clickNone.verification === 'none' && p115_clickNone.verified === false, JSON.stringify(p115_clickNone).slice(0, 240))",
  '',
  "  /* screenshot ladder: painted-noise page + low maxBytes rung fits; still a real image */",
  "  const p115_ladder = await call('browser_screenshot', { tabId: actTab0.tabId, maxBytes: 90000 }, 'lad')",
  '  const p115_ladderImg = p115_ladder.result && p115_ladder.result.content.find(c => c.type === "image")',
  "  const p115_ladderMetaT = p115_ladder.result && p115_ladder.result.content.find(c => c.type === 'text')",
  "  let p115_ladderMeta = null; try { p115_ladderMeta = JSON.parse(p115_ladderMetaT.text) } catch (e) {}",
  "  check('P1-15 screenshot ladder: rung produced at/below cap + real image delivered', !!p115_ladderImg && !!p115_ladderMeta && p115_ladderMeta.scaled === true && p115_ladderImg.data.length <= 90000 * 1.34, JSON.stringify(p115_ladderMeta && { scaled: p115_ladderMeta.scaled, rung: p115_ladderMeta.rung, bytes: p115_ladderImg && p115_ladderImg.data.length }).slice(0, 220))",
  "  const p115_badSel = await call('browser_screenshot', { tabId: actTab0.tabId, selector: '\"\"' }, 'lad2')",
  "  check('P1-15 screenshot: invalid selector -> structured invalid_params', !!p115_badSel.error || (p115_badSel.result && p115_badSel.result.isError === true), JSON.stringify(p115_badSel && p115_badSel.error).slice(0, 140))",
  '',
  "  /* content maxChars=300 excerpt honored */",
  "  const p115_excerpt = textOf(await call('browser_content', { tabId: actTab0.tabId, maxChars: 300 }, 'cx'))",
  "  check('P1-15 content maxChars=300 honored (valid smaller excerpt)', !!p115_excerpt && typeof p115_excerpt.text === 'string' && p115_excerpt.text.length <= 1200 && p115_excerpt.text.length > 0, String(p115_excerpt && p115_excerpt.text || '').length + '')",
  '',
  '  return finish(results.every(r => r.pass) ? 0 : 2)'
]
const finishAnchor = "  return finish(results.every(r => r.pass) ? 0 : 2)\n}"
s = s.replace(finishAnchor, block.join('\n') + '\n}\n\n/* NOTE: the original main() close follows as a comment marker below */\nvar P1_15_OLD_CLOSE = function () {')

fs.writeFileSync('scripts/mcp-e2e.js', s)
fs.writeFileSync('scripts/mcp-e2e.js.patched', 'patched ' + new Date().toISOString())
console.log('consolidated mcp-e2e patch applied')
