#!/usr/bin/env node
/* P1-12 scanner hygiene: exclude VCS internals (.git) from the publish-set walker
 * now that the repository has a local Git history. Both scanners updated. */
const fs = require('fs')

const pub = 'scripts/p112-publish-set.js'
let p = fs.readFileSync(pub, 'utf8')
p = p.replace(
  "const rules = ['/.git/',].concat(fs.readFileSync('.gitignore', 'utf8')).split('\\n').map(l => l.trim())",
  "const rules = ['/.git/'].concat(fs.readFileSync('.gitignore', 'utf8').split('\\n').map(l => l.trim()))"
)
fs.writeFileSync(pub, p)

const sec = 'scripts/p112-secret-scan.js'
let s = fs.readFileSync(sec, 'utf8')
s = s.replace(
  "const rules = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))",
  "const rules = ['/.git/'].concat(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')))"
)
fs.writeFileSync(sec, s)
console.log('publish-set patched:', p.includes("['/.git/']"), '| secret-scan patched:', s.includes("['/.git/']"))
