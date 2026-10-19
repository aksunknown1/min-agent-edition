#!/usr/bin/env node
/* P1-12: copy the effective publish set into a disposable temp workspace (no main.build.js, no node_modules). */
const fs = require('fs')
const path = require('path')
const ROOT = process.cwd()
const DEST = path.join(process.env.TEMP, 'p112-clean-try')

const rules = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
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

let n = 0
function walk (d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    const rel = path.relative(ROOT, p)
    if (e.isDirectory()) {
      if (ignored(rel + '/') || ignored(rel)) continue
      fs.mkdirSync(path.join(DEST, rel), { recursive: true })
      walk(p)
    } else {
      if (ignored(rel)) continue
      fs.copyFileSync(p, path.join(DEST, rel))
      n++
    }
  }
}
fs.rmSync(DEST, { recursive: true, force: true })
fs.mkdirSync(DEST, { recursive: true })
walk(ROOT)
console.log('copied ' + n + ' files to ' + DEST + ' (publish set; no main.build.js, no node_modules, no dist)')
