/* P1-15 M2: extend act.html with a painted canvas (for the screenshot ladder)
 * and widen the MCP batch enum with browser_eval/browser_viewport. */
const fs = require('fs')
let s = fs.readFileSync('scripts/mcp-e2e.js', 'utf8')

if (s.indexOf('noisecv') !== -1) { console.log('already applied'); process.exit(0) }

const anchor = "    '<div id=\"out\">initial</div>' +"
if (s.indexOf(anchor) === -1) { console.error('ACT ANCHOR MISS'); process.exit(1) }
const canvasBlock = [
  anchor,
  "    '<canvas id=\"noisecv\" width=\"2400\" height=\"1200\" style=\"display:block\"></canvas>' +",
  "    '<script>' +",
  "    'var nc=document.getElementById(\"noisecv\").getContext(\"2d\");' +",
  "    'var x=12345;function rnd(){x=(x*1103515245+12345)&0x7fffffff;return x&0xff}' +",
  "    'for(var px=0;px<2400;px+=8){for(var py=0;py<1200;py+=8){nc.fillStyle=\"rgb(\"+rnd()+\",\"+rnd()+\",\"+rnd()+\")\";nc.fillRect(px,py,8,8)}}' +",
  "    '</scr' + 'ipt>' +"
].join('\n')
s = s.replace(anchor, canvasBlock)

const enumAnchor = "'browser_state','browser_tab_open','browser_tab_select','browser_tab_close'] },"
if (s.indexOf(enumAnchor) === -1) { console.error('ENUM ANCHOR MISS'); process.exit(1) }
s = s.replace(enumAnchor, "'browser_state','browser_tab_open','browser_tab_select','browser_tab_close','browser_eval','browser_viewport'] },")

fs.writeFileSync('scripts/mcp-e2e.js', s)
console.log('act.html + batch enum extended')
