#!/usr/bin/env node
/*
 * P1-14 hygiene: tests for scripts/lib/proctools.js
 *
 * Success, timeout and cleanup-on-failure paths, using SAFELY-SPAWNED node child
 * processes only (never Electron, never process-name kills, no Min instance).
 * Evidence: docs/p112... no — docs/proctools-test.json (see below).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const pt = require('./lib/proctools')

const results = []
function check (name, pass, detail) {
  results.push({ name, pass: !!pass })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  [' + String(detail === undefined ? '' : detail).slice(0, 200) + ']'))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return false } }

async function main () {
  /* 1. killTree success path on a spawned node child */
  const child = pt.spawnTracked(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  await sleep(600)
  check('spawnTracked: spawned node child is alive (tracked pid owned by this test)', alive(child.pid))
  pt.killTree(child.pid)
  await sleep(900)
  check('killTree: tracked child terminated, nothing else touched', !alive(child.pid))

  /* 2. pollReadiness timeout path — must FAIL when the browser never becomes ready */
  let timedOut = false, threwNothing = false
  try {
    await pt.pollReadiness(async () => [], t => Array.isArray(t) && t.length > 0, { timeoutMs: 900, intervalMs: 150 })
  } catch (e) {
    threwNothing = true
    timedOut = e.code === 'PT_TIMEOUT'
  }
  check('pollReadiness: still FAILS with PT_TIMEOUT when readiness never arrives (no masking)', threwNothing && timedOut)

  /* 3. pollReadiness success path — transient empty reads tolerated, then predicate met */
  let flipped = false
  const t0 = Date.now()
  const ok = await pt.pollReadiness(
    async () => { if (!flipped && Date.now() - t0 > 700) { flipped = true } return flipped ? [{ url: 'http://fixture/', loading: false }] : [] },
    pt.tabsStablePredicate('fixture'),
    { timeoutMs: 6000, intervalMs: 150 }
  )
  check('pollReadiness: transient empty-shell reads tolerated until stable readiness', ok && ok.value.length === 1, JSON.stringify(ok && ok.value).slice(0, 120))

  /* 4. cleanup-on-failure path: failure between spawn and readiness still cleans up */
  const child2 = pt.spawnTracked(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  await sleep(600)
  const failThenCleanup = async () => {
    try {
      await pt.pollReadiness(async () => [], t => Array.isArray(t) && t.length > 0, { timeoutMs: 600, intervalMs: 150 })
    } finally {
      pt.killTree(child2.pid)
    }
  }
  let cleaned = false
  try { await failThenCleanup() } catch (e) { cleaned = !alive(child2.pid) }
  await sleep(300)
  check('cleanup-on-failure: finally-path killTree reclaims a spawned process after a failed readiness await', cleaned)

  /* 5. tabsStablePredicate semantics (empty-shell / loading / fragment) — re-asserted here
   * so the helper's contract is pinned by a test rather than by ad-hoc checks. */
  check('tabsStablePredicate rejects empty arrays', pt.tabsStablePredicate()([]) === false)
  check('tabsStablePredicate rejects empty-shell entries', pt.tabsStablePredicate()([{}, { url: '' }]) === false)
  check('tabsStablePredicate rejects still-loading tabs', pt.tabsStablePredicate()([{ url: 'http://x/', loading: true }]) === false)
  check('tabsStablePredicate requires the start-URL fragment when given', pt.tabsStablePredicate('pav.html')([{ url: 'http://x/', loading: false }]) === false)

  const pass = results.filter(r => r.pass).length
  fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'proctools-test.json'), JSON.stringify({ ts: new Date().toISOString(), pass, total: results.length, results }, null, 2))
  console.log('\nproctools-test: ' + pass + '/' + results.length + ' checks passed')
  process.exit(pass === results.length ? 0 : 1)
}

main().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2) })
