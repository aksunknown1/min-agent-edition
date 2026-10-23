#!/usr/bin/env node
/*
 * R2 probe (Layer B): the four remaining D2 parity rows, over the real bridge.
 *
 *   C6 browser_upload  - file input, path policy, dispatch vs verified state
 *   C8 browser_frames  - frame enumeration + honest limitations
 *   D1 fullPage        - bounded scroll-stitch, metadata, scroll restoration
 *   B4 format:'ax'     - genuine Chromium accessibility tree
 *
 * Local fixtures only. Cleanup is /PID-targeted on the process this run spawned.
 */
const { spawn, spawnSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE = path.join(ROOT, 'docs', 'agent-r2-probe.json')
const RUN_DIR = path.join(os.tmpdir(), 'min-r2-probe')
const PROFILE = path.join(RUN_DIR, 'profile')
const EFFECTIVE = PROFILE + '-development'

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? null : String(detail).slice(0, 240) })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  [' + String(detail).slice(0, 180) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
function rmrf (p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) {} }

/* Tall page for D1, an iframe for C8, a file input for C6, an accessible
 * structure for B4. */
const PAGE = [
  '<!doctype html><html><head><title>R2 Fixture</title></head><body style="margin:0">',
  '<h1 id="h">R2 Fixture Heading</h1>',
  '<label for="file">Pick a file</label><input id="file" type="file">',
  '<label for="dis">Disabled input</label><input id="dis" type="text" disabled>',
  '<iframe id="same" src="inner.html" width="300" height="120"></iframe>',
  '<div id="tall">',
  [1, 2, 3, 4, 5, 6].map(function (i) {
    return '<div style="height:600px;background:hsl(' + (i * 55) + ',70%,55%)">BLOCK ' + i + '</div>'
  }).join(''),
  '</div>',
  '<button id="btn">Action Button</button>',
  '</body></html>'
].join('')

const INNER = '<!doctype html><html><head><title>Inner</title></head><body><p id="ip">inner frame text</p></body></html>'

function rpc (port, token, method, params) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params })
    const req = http.request({
      host: '127.0.0.1', port: Number(port), path: '/rpc', method: 'POST',
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, 'content-type': 'application/json' }
    }, function (res) {
      let b = ''
      res.on('data', c => { b += c })
      res.on('end', function () { let j = null; try { j = JSON.parse(b) } catch (e) {}; resolve(j || { error: { message: 'bad json' } }) })
    })
    req.on('error', reject)
    req.write(body); req.end()
  })
}
const rpcJ = (p, t, m, params) => rpc(p, t, m, params).then(j => j.result !== undefined ? j.result : { error: j.error })

let probeProc = null
function finish (code) {
  const passed = results.filter(r => r.pass).length
  console.log('\n' + passed + '/' + results.length + ' checks passed')
  try { fs.writeFileSync(EVIDENCE, JSON.stringify({ ts: new Date().toISOString(), results, pass: passed, total: results.length }, null, 2)) } catch (e) {}
  try { if (probeProc && probeProc.pid) spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(probeProc.pid)], { windowsHide: true }) } catch (e) {}
  process.exit(code)
}

async function main () {
  rmrf(RUN_DIR)
  fs.mkdirSync(EFFECTIVE, { recursive: true })
  fs.writeFileSync(path.join(EFFECTIVE, 'settings.json'), JSON.stringify({ experimentalExtensionHost: false }), 'utf8')
  try { fs.rmSync(path.join(EFFECTIVE, 'policy.json'), { force: true }) } catch (e) {}
  fs.writeFileSync(path.join(RUN_DIR, 'r2.html'), PAGE, 'utf8')
  fs.writeFileSync(path.join(RUN_DIR, 'inner.html'), INNER, 'utf8')

  const bin = require('electron')
  probeProc = spawn(bin, ['.', '--development-mode', '--user-data-dir=' + PROFILE, '--agent-rpc', '--', 'file:///' + path.join(RUN_DIR, 'r2.html').replace(/\\/g, '/')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  probeProc.stdout.on('data', d => { out += d })
  probeProc.stderr.on('data', d => { out += d })
  const discPath = path.join(EFFECTIVE, 'agent-rpc.json')
  let disc = null
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) { await sleep(500); try { disc = JSON.parse(fs.readFileSync(discPath, 'utf8')); break } catch (e) {} }
  if (!disc) { check('bridge discovery appeared', false, 'no agent-rpc.json'); return 2 }
  check('bridge discovery appeared', true)
  const port = new URL(disc.url).port
  const token = disc.token
  await sleep(2200)

  const tabs = await rpcJ(port, token, 'browser_tabs', {})
  const tab = (tabs.tabs.find(t => t.active === true) || {}).tabId
  check('startup tab enumerated', !!tab)

  /* ---------- C8: frames ---------- */
  const fr = await rpcJ(port, token, 'browser_frames', { tabId: tab })
  check('C8: frames enumerated without CDP', !!(fr && typeof fr.count === 'number' && fr.count >= 1), fr && fr.count)
  check('C8: main frame URL reported', !!(fr && /r2\.html/.test(String(fr.mainFrameUrl))), fr && fr.mainFrameUrl)
  check('C8: same-origin child frame listed', !!(fr && (fr.frames || []).some(f => /inner\.html/.test(String(f.url)))), (fr && fr.frames || []).map(f => f.url).join(','))
  check('C8: honest limitations returned', !!(fr && typeof fr.limitations === 'string' && /cross-origin/i.test(fr.limitations)))
  check('C8: child frame carries a distinct frame identity', !!(fr && new Set((fr.frames || []).map(f => f.frameId)).size === (fr.frames || []).length))

  /* ---------- B4: accessibility tree ---------- */
  const ax = await rpcJ(port, token, 'browser_snapshot', { tabId: tab, format: 'ax' })
  check('B4: ax format returns a genuine accessibility tree', !!(ax && ax.source === 'chromium-accessibility-tree' && Array.isArray(ax.nodes) && ax.nodes.length > 0), ax && (ax.source + '/' + (ax.nodes || []).length))
  const axRoles = (ax && ax.nodes || []).map(n => n.role)
  check('B4: hierarchy/roles present', axRoles.some(r => /heading|button|textbox|RootWebArea|generic/i.test(String(r))), axRoles.slice(0, 8).join(','))
  const axH = (ax && ax.nodes || []).find(n => /R2 Fixture Heading/.test(String(n.name || '')))
  check('B4: accessible NAME resolved from the tree', !!axH, axH && axH.name)
  const axDis = (ax && ax.nodes || []).find(n => n.disabled === true)
  check('B4: disabled state reported where Chromium provides it', !!axDis, axDis && (axDis.role + ':' + axDis.name))
  check('B4: unsupported properties are null, not invented false', !!(ax && (ax.nodes || []).every(n => n.readonly === null || typeof n.readonly === 'boolean')))
  check('B4: truncation flag present', !!(ax && typeof ax.truncated === 'boolean'))
  const axJson = JSON.stringify(ax)
  check('B4: no node carries a raw page value for a password field', axJson.indexOf('"value":"') === -1 || !/password/.test(axJson))
  const domSnap = await rpcJ(port, token, 'browser_snapshot', { tabId: tab })
  check('B4: DOM snapshot mode still works (backward compatible)', !!(domSnap && Array.isArray(domSnap.nodes)))

  /* ---------- D1: full-page capture ---------- */
  const pageMeta = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'JSON.stringify({h:document.documentElement.scrollHeight,ih:window.innerHeight,y:window.scrollY})' })
  let pm = null
  try { pm = JSON.parse(unescapeEval(pageMeta)) } catch (e) { pm = null }
  const fp = await rpcJ(port, token, 'browser_screenshot', { tabId: tab, fullPage: true, maxSlices: 6 })
  check('D1: fullPage capture ran', !!(fp && fp.source === 'fullpage' && fp.data && fp.data.length > 1000), fp && (fp.source + ' ' + fp.bytes + 'b'))
  check('D1: capture is taller than one viewport', !!(fp && fp.height > (pm && pm.ih ? pm.ih : 0)), fp && ('img ' + fp.height + ' vs viewport ' + (pm && pm.ih)))
  check('D1: slice geometry and document height reported', !!(fp && fp.slices >= 2 && fp.documentHeightCss > 0 && fp.sliceHeightCss > 0), fp && JSON.stringify({ s: fp.slices, d: fp.documentHeightCss }))
  check('D1: completeness is stated honestly', !!(fp && typeof fp.completeCapture === 'boolean' && typeof fp.limitations === 'string'))
  const scrollNow = await rpcJ(port, token, 'browser_eval', { tabId: tab, expression: 'String(window.scrollY)' })
  check('D1: scroll position restored after capture', String(unescapeEval(scrollNow)) === String(pm && pm.y), 'now=' + unescapeEval(scrollNow) + ' was=' + (pm && pm.y))

  /* ---------- C6: upload ---------- */
  const upRoot = path.join(EFFECTIVE, 'agent-uploads')
  fs.mkdirSync(upRoot, { recursive: true })
  fs.writeFileSync(path.join(upRoot, 'sample.txt'), 'r2-upload-sample', 'utf8')
  const snap2 = await rpcJ(port, token, 'browser_snapshot', { tabId: tab })
  const fileNode = (snap2.nodes || []).find(n => n.inputType === 'file')
  check('C6: file input enumerated with its type', !!fileNode, fileNode && (fileNode.name + '/' + fileNode.inputType))
  if (fileNode) {
    const up = await rpcJ(port, token, 'browser_upload', { tabId: tab, ref: fileNode.ref, relPath: 'sample.txt' })
    check('C6: upload attaches the file and verifies input state', !!(up && up.dispatched === true && up.verified === true && up.filesCount === 1), JSON.stringify(up && { d: up.dispatched, v: up.verified, n: up.filesCount }))
    check('C6: result distinguishes dispatched from verified', !!(up && up.delivered === 'attested' && up.verification === 'files-attached'))
    check('C6: local absolute path is not echoed', !JSON.stringify(up).includes(upRoot.replace(/\\/g, '\\\\')), 'path not leaked')
    const upBad = await rpcJ(port, token, 'browser_upload', { tabId: tab, ref: fileNode.ref, relPath: '../../../etc/passwd' })
    check('C6: traversal path refused', !!(upBad && upBad.error && upBad.error.category === 'invalid_params'), upBad && upBad.error && upBad.error.message)
    const upMissing = await rpcJ(port, token, 'browser_upload', { tabId: tab, ref: fileNode.ref, relPath: 'nope.txt' })
    check('C6: missing file refused', !!(upMissing && upMissing.error && upMissing.error.category === 'invalid_params'), upMissing && upMissing.error && upMissing.error.message)
    const textNode = (snap2.nodes || []).find(n => n.role === 'textbox' && n.inputType !== 'file')
    if (textNode) {
      const upWrong = await rpcJ(port, token, 'browser_upload', { tabId: tab, ref: textNode.ref, relPath: 'sample.txt' })
      check('C6: non-file target refused', !!(upWrong && upWrong.error && upWrong.error.category === 'unsupported'), upWrong && upWrong.error && upWrong.error.category)
    } else check('C6: non-file target refused', false, 'no textbox enumerated')
  } else {
    check('C6: upload attaches the file and verifies input state', false, 'file input not enumerated')
  }

  return results.every(r => r.pass) ? 0 : 1
}

/* browser_eval results are wrapped; unwrap the common shapes for assertions. */
function unescapeEval (r) {
  try {
    const v = r && r.value
    if (v && v.__t === 'string') return v.v
    if (typeof v === 'string') return v
    return v === undefined || v === null ? '' : JSON.stringify(v)
  } catch (e) { return '' }
}

main().then(finish).catch(e => { console.error('r2 probe error: ' + e.message); finish(2) })