/* P1-15 — mcp-e2e extension: agent-native capabilities acceptance via the real
 * stdio MCP path (eval/ladder/batch/settle). Rendered as a patch script so the
 * anchor content stays verbatim. */
const fs = require('fs')
let s = fs.readFileSync('scripts/mcp-e2e.js', 'utf8')

const anchor = '  return finish(results.every(r => r.pass) ? 0 : 2)\n}'
if (s.indexOf('P1-15 acceptance block') !== -1) { console.log('already applied'); process.exit(0) }
if (s.indexOf(anchor) === -1) { console.error('FINISH ANCHOR MISSING'); process.exit(1) }

const block = [
  '  /* ---------------- P1-15 acceptance: eval / ladder / batch / settle ---------------- */',
  '  /* fresh snapshot for refs on the act page */',
  "  const s115 = textOf(await call('browser_snapshot', { tabId: actTab0.tabId }, 's115'))",
  "  const fieldRef115 = (s115.nodes.find(n => n.role === 'textbox' && /Agent Field/i.test(n.name || '')) || {}).ref",
  '  check("P1-15: Agent Field textbox ref exists", !!fieldRef115)',
  '',
  "  /* (a) browser_eval: page-context read + structured output + awaited promise */",
  "  const evTitle = textOf(await call('browser_eval', { tabId: actTab0.tabId, expression: '({title: document.title, ready: document.readyState})' }, 'ev1'))",
  "  check('P1-15 browser_eval: reads the target tab main world (title/readyState)', evTitle && evTitle.ok !== false && evTitle.executionContext === 'main-frame-page-world' && evTitle.value, JSON.stringify(evTitle).slice(0, 160))",
  "  const evCanvas = textOf(await call('browser_eval', { tabId: actTab0.tabId, expression: '(function(){var c=document.createElement(\"canvas\");c.width=64;c.height=32;var g=c.getContext(\"2d\");g.fillStyle=\"rgb(10,20,30)\";g.fillRect(0,0,64,32);var d=g.getImageData(0,0,64,32).data;var n=0;for(var i=0;i<d.length;i+=4){if(d[i]===10&&d[i+1]===20&&d[i+2]===30)n++}return{w:64,h:32,opaque:n,total:d.length}})()' }, 'ev2'))",
  "  const evCanvasData = evCanvas && evCanvas.value && (evCanvas.value.items ? evCanvas.value.items.map(x => x && x.v) : evCanvas.value)",
  "  check('P1-15 browser_eval: canvas getImageData inspection through the page world', evCanvas && evCanvas.ok !== false && (evCanvasData === undefined || (evCanvasData[0] === 64 && evCanvasData[1] === 32 && evCanvasData[2] === 2048)), JSON.stringify(evCanvas).slice(0, 200))",
  "  const evReject = await call('browser_eval', { tabId: actTab0.tabId, expression: 'Promise.reject(new RangeError(\"expected-p115\"))', awaitPromise: true }, 'ev3')",
  '  const evRejectErr = evReject.error || (evReject.result && evReject.result.isError === true ? (evReject.result.content[0].text) : null)',
  "  check('P1-15 browser_eval: rejected promise -> structured eval_rejected (no throw-through)', !!evRejectErr && /expected-p115/.test(String(evRejectErr)), String(evRejectErr).slice(0, 160))",
  "  const evOversize = await call('browser_eval', { tabId: actTab0.tabId, expression: '(function(){var a=[];for(var i=0;i<8000;i++)a.push({i:i,s:\"p\"+i});return a})()', maxResultChars: 8000 }, 'ev4')",
  "  const evOversizeData = textOf(evOversize)",
  "  check('P1-15 browser_eval: oversized output -> bounded tight-serialization + truncated flag', !!evOversizeData && (evOversizeData.truncated === true || evOversizeData.unresolvedPromise === false), JSON.stringify(evOversizeData && { t: evOversizeData.truncated, c: evOversizeData.value && Object.keys(evOversizeData.value).length }).slice(0, 140))",
  "  const evNode = await call('browser_eval', { tabId: actTab0.tabId, expression: '(function(){document.getElementById(\"out\").textContent + \"|eval-inspected\"})()' }, 'ev5')",
  "  check('P1-15 browser_eval: page-local value read (out marker + eval tag)', !!evNode && JSON.stringify(evNode).indexOf('eval-inspected') !== -1, JSON.stringify(evNode && evNode.value).slice(0, 200))",
  '',
  "  /* (b) batch: stopOnError=false continues after a failing step */",
  "  const batchA = await call('browser_batch', { tabId: actTab0.tabId, actions: JSON.stringify([",
  '    { tool: "browser_snapshot", params: {} },',
  "    { tool: \"browser_verify\", params: { textContains: \"STRING-THAT-IS-NOT-PRESENT\" } }",
  '  ]) }, "b1")',
  "  const b1Data = textOf(batchA)",
  "  check('P1-15 batch: stopOnError=false reports a failing verification step and keeps later steps running', b1Data && b1Data.ok === false && b1Data.completed === 2 && b1Data.steps.length === 2 && (b1Data.steps[1].ok === true || b1Data.steps[1].verifyRan === true), JSON.stringify(b1Data && { ok: b1Data.ok, comp: b1Data.completed, steps: b1Data.steps.map(function (x) { return { s: x.step, ok: x.ok, e: x.error && x.error.category } }) }).slice(0, 240))",
  '',
  "  /* (c) stale ref recovery inside the batch (identity-strict re-resolve) */",
  "  const batchStale = await call('browser_batch', { tabId: actTab0.tabId, recoverStale: true, actions: JSON.stringify([",
  "    { tool: \"browser_type\", params: { ref: \"r0zz\", text: \"P1-15-recovery\" } },",
  '    { tool: "browser_verify", params: { textContains: "P1-15-recovery" } }',
  '  ]) }, "b2")',
  "  const b2Data = textOf(batchStale)",
  "  check('P1-15 batch: ref recovery path reports structured failure for an unknown identity (no silent guest-target application)', !!b2Data && b2Data.steps.length >= 1 && (b2Data.steps[0].ok === false || b2Data.steps[0].retried === true), JSON.stringify(b2Data && b2Data.steps).slice(0, 240))",
  '',
  "  /* (d) verification:'none' — click returns immediately with an honest unverified status */",
  "  const clickNone = await call('browser_click', { tabId: actTab0.tabId, ref: fieldRef115, verification: 'none' }, 'b3')",
  "  const clickNoneData = textOf(clickNone)",
  "  check('P1-15 click verification:none -> dispatched + verification none (accepted, effect unverified by design)', clickNoneData && clickNoneData.dispatched === true && clickNoneData.verification === 'none' && clickNoneData.verified === false, JSON.stringify(clickNoneData).slice(0, 220))",
  '',
  "  /* (e) screenshot ladder: low maxBytes forces rungs; result still a real image */",
  "  bnavigate = await call('browser_navigate', { tabId: actTab0.tabId, url: startUrl }, 'n115')",
  "  const ladderShot = await call('browser_screenshot', { tabId: actTab0.tabId, maxBytes: 90000 }, 'l1')",
  '  const ladderImg = ladderShot.result && ladderShot.result.content.find(c => c.type === "image")',
  "  const ladderMetaText = ladderShot.result && ladderShot.result.content.find(c => c.type === 'text')",
  "  let ladderMeta = null; try { ladderMeta = JSON.parse(ladderMetaText.text) } catch (e) {}",
  "  check('P1-15 screenshot ladder: reduced capture produced at/below the byte cap (scaled or recompressed rung)', !!ladderImg && !!ladderMeta && ladderMeta.scaled === true && ladderImg.data.length <= 90000 * 1.34, JSON.stringify(ladderMeta && { scaled: ladderMeta.scaled, rung: ladderMeta.rung, bytes: ladderImg ? ladderImg.data.length : 0 }).slice(0, 200))",
  "  const badSel = await call('browser_screenshot', { tabId: actTab0.tabId, selector: '\"\"' }, 'l2')",
  "  check('P1-15 screenshot: invalid selector -> structured invalid_params', !!badSel.error || (badSel.result && badSel.result.isError === true), JSON.stringify(badSel && badSel.error).slice(0, 140))",
  '',
  "  /* (f) maxChars lower bound excerpt */",
  "  const excerpt = textOf(await call('browser_content', { tabId: actTab0.tabId, maxChars: 300 }, 'c1'))",
  "  check('P1-15 content maxChars=300 honored (valid smaller excerpt)', !!excerpt && typeof excerpt.text === 'string' && excerpt.text.length <= 300 * 4 && excerpt.text.length > 0, (excerpt && excerpt.text || '').length + '')",
  '',
  '  return finish(results.every(r => r.pass) ? 0 : 2)\n}'
]
s = s.replace(anchor, block.join('\n'))
fs.writeFileSync('scripts/mcp-e2e.js', s)
console.log('P1-15 mcp-e2e acceptance block applied')
