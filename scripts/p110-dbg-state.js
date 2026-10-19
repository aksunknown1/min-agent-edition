#!/usr/bin/env node
/* P1-10 debug: inspect browser_state captcha fields on the /captcha fixture. */
const lib = require('./p110-lib')
const path = require('path')
const os = require('os')

async function main () {
  const stack = await lib.launchStack({ fixturePort: 47330, profileBase: path.join(os.tmpdir(), 'min-p110-dbg-' + Date.now()), startPath: '/captcha' })
  try {
    const tabs = await stack.callTool('browser_tabs', {})
    const tabId = tabs.raw.result.content.map(b => b.text).join('').match(/"tabId":"([0-9]+)"/) ? null : null
    const tabsT = JSON.parse(tabs.raw.result.content[0].text)
    const active = tabsT.tabs.find(t => t.active && t.focused)
    const tabId2 = active.tabId
    const nav = await stack.callTool('browser_navigate', { tabId: tabId2, url: stack.fixtureBase + '/captcha' })
    const st = await stack.callTool('browser_state', { tabId: tabId2 })
    const stT = JSON.parse(st.raw.result.content[0].text)
    console.log('state url:', stT.url)
    for (const k of Object.keys(stT)) if (/captcha|near|focus/i.test(k)) console.log(k + ':', JSON.stringify(stT[k]).slice(0, 300))
    const snap = await stack.callTool('browser_snapshot', { tabId: tabId2 })
    const snapT = JSON.parse(snap.raw.result.content[0].text)
    console.log('snapshot captchaBoxes:', JSON.stringify(snapT.captchaBoxes))
    // find the clear button ref and try clicking it (should work - not near widget)
    const btn = (snapT.nodes || []).find(n => n.role === 'button')
    console.log('buttons:', JSON.stringify((snapT.nodes || []).filter(n => n.role === 'button').map(n => n.name)))
    if (btn) {
      const cl = await stack.callTool('browser_click', { tabId: tabId2, ref: btn.ref })
      console.log('click clear-btn:', cl.summary.slice(0, 200))
    }
  } finally {
    await stack.shutdown()
  }
}
main().catch(e => { console.error('dbg-fatal', e.message); process.exit(1) })
