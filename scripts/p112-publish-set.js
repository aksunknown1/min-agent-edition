#!/usr/bin/env node
/* P1-12 Phase 2: compute the effective publish set per .gitignore semantics (emulated). */
const fs = require('fs')
const path = require('path')

const rules = ['/.git/'].concat(fs.readFileSync('.gitignore', 'utf8').split('\n').map(l => l.trim()))
  .filter(l => l && !l.startsWith('#'))

function ignored (rel) {
  const n = rel.split(path.sep).join('/')
  for (const raw of rules) {
    if (raw.startsWith('!')) continue
    const isDirRule = raw.endsWith('/')
    const r = raw.replace(/^\//, '').replace(/\/$/, '')
    if (isDirRule) {
      if (n === r || n.startsWith(r + '/')) return raw
    } else if (r.includes('*')) {
      const re = new RegExp('^' + r.split('*').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
      if (re.test(path.basename(n)) || re.test(n)) return raw
    } else {
      if (n === r || n.startsWith(r + '/')) return raw
    }
  }
  return null
}

const out = []
const exDirs = []
function walk (dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    const rel = path.relative('.', p)
    if (e.isDirectory()) {
      const g = ignored(rel + '/') || ignored(rel)
      if (g) { exDirs.push(rel + '  [' + g + ']'); continue }
      walk(p)
    } else {
      const g = ignored(rel)
      if (g) { exDirs.push(rel + '  [' + g + ']'); continue }
      out.push({ rel: rel, size: fs.statSync(p).size })
    }
  }
}
walk('.')

const total = out.reduce((s, f) => s + f.size, 0)
console.log('PUBLISH SET: ' + out.length + ' files, ' + total + ' bytes = ' + (total / 1048576).toFixed(1) + ' MB')
out.sort((a, b) => b.size - a.size)
console.log('\nLARGEST 30 INCLUDED FILES:')
for (const f of out.slice(0, 30)) console.log('  ' + String(f.size).padStart(9) + '  ' + f.rel)
console.log('\nEXCLUDED top-level paths:')
for (const d of exDirs.filter(d => d.split(/[\\/]/).length <= 2)) console.log('  ' + d.slice(0, 100))
fs.writeFileSync(path.join('docs', 'p112-publish-set.json'), JSON.stringify({ ts: new Date().toISOString(), count: out.length, bytes: total, largest: out.slice(0, 100) }, null, 2))
console.log('\nevidence: docs/p112-publish-set.json')
