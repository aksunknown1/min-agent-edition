#!/usr/bin/env node
/* P1-12 Phase 4: publish-set secret scan. Prints paths + categories + counts ONLY. */
const fs = require('fs')
const path = require('path')
const ROOT = process.cwd()
const rules = ['/.git/'].concat(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')))
function ignored (rel) {
  const n = rel.split(path.sep).join('/')
  for (const raw of rules) {
    if (raw.startsWith('!')) continue
    const isDir = raw.endsWith('/')
    const r = raw.replace(/^\//, '').replace(/\/$/, '')
    if (isDir) { if (n === r || n.startsWith(r + '/')) return true } else if (r.includes('*')) {
      const re = new RegExp('^' + r.split('*').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
      if (re.test(path.basename(n)) || re.test(n)) return true
    } else { if (n === r || n.startsWith(r + '/')) return true }
  }
  return false
}

const patterns = {
  'private key header': /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  'password assignment literal': /(password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/i,
  'bearer/api-token literal': /(bearer|api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_-]{12,}['"]/i,
  'email-like string': /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
}

const hits = {}
let files = 0
function record (rel, cat) {
  hits[rel] = hits[rel] || {}
  hits[rel][cat] = (hits[rel][cat] || 0) + 1
}
function walk (d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    const rel = path.relative(ROOT, p)
    if (e.isDirectory()) {
      if (ignored(rel + '/') || ignored(rel)) continue
      walk(p)
      continue
    }
    if (ignored(rel)) continue
    files++
    if (/^\.env/.test(e.name)) { record(rel, 'env file'); continue }
    if (/(Cookies|cookies\.sqlite|Session[s]? Storage|Local Storage)/i.test(e.name)) { record(rel, 'cookie/session store'); continue }
    if (/\.(png|jpe?g|ico|icns|woff2?|zip|exe|dll|pak|bin|pdf|node)$/i.test(e.name)) continue
    let txt = ''
    try { txt = fs.readFileSync(p, 'utf8') } catch (e) { continue }
    for (const cat of Object.keys(patterns)) {
      const m = txt.match(patterns[cat])
      if (m) record(rel, cat)
    }
  }
}
walk(ROOT)

console.log('files scanned (publish set): ' + files)
let emailFiles = []
let real = 0
for (const [f, cats] of Object.entries(hits)) {
  for (const c of Object.keys(cats)) {
    if (c === 'email-like string') { emailFiles.push(f); continue }
    real++
    console.log('REVIEW | ' + f + ' | ' + c + ' (occurrences: ' + cats[c] + ')')
  }
}
console.log('---')
console.log('hard findings (excl. bare emails): ' + real)
console.log('files with email-like strings: ' + emailFiles.length)
for (const f of emailFiles) console.log('  REVIEW-email | ' + f)
fs.writeFileSync(path.join(ROOT, 'docs', 'p112-secret-scan.json'), JSON.stringify({ ts: new Date().toISOString(), filesScanned: files, hardFindings: real, emailFiles: emailFiles, note: 'values intentionally never recorded' }, null, 2))
console.log('evidence: docs/p112-secret-scan.json')
