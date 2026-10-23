#!/usr/bin/env node
/*
 * Change-impact test selector.
 *
 *   node scripts/test-impact.js                 # plan from the working tree
 *   node scripts/test-impact.js --run           # plan, then RUN the selected suites
 *   node scripts/test-impact.js --run --realweb # also run Layer C (network-dependent)
 *   node scripts/test-impact.js --files=a.js,b.js
 *   node scripts/test-impact.js --all           # force the full suite
 *
 * DESIGN RULE: this tool never guesses. Selection comes from
 * scripts/lib/test-impact-map.json (hand-maintained, documented in
 * docs/audit/TEST-IMPACT-MAP.md). If a changed path matches NO rule the tool
 * reports UNBOUNDED and refuses to pretend the change is safe — run the full
 * suite instead.
 *
 * It does NOT run everything by default, and it does NOT run real-web tests
 * unless asked: those need network and may vary with third-party sites.
 *
 * Safety: it only spawns the suites listed in the map, each of which owns its
 * own temp profile and finishes its own PID-targeted cleanup. Suites run
 * serially because they share Electron runtime state.
 */
const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'test-impact-map.json'), 'utf8'))
const argv = process.argv.slice(2)
const has = f => argv.indexOf(f) !== -1
const val = name => { const a = argv.find(x => x.indexOf('--' + name + '=') === 0); return a ? a.slice(name.length + 3) : null }

function changedFiles () {
  const explicit = val('files')
  if (explicit) return explicit.split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/\\/g, '/'))
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' })
    /* Porcelain format is EXACTLY "XY<space>path" (or "XY<space>old -> new" on
     * rename). Never trim before slicing or the status prefix shifts by one and
     * paths get truncated — which would silently send every real source file
     * down the UNBOUNDED branch. */
    return out.split('\n')
      .filter(l => l.length > 3)
      .map(l => {
        let p = l.slice(3)
        if (p.indexOf(' -> ') !== -1) p = p.split(' -> ').pop()
        return p.trim().replace(/\\/g, '/')
      })
      .filter(Boolean)
  } catch (e) {
    console.error('test-impact: could not read git status: ' + e.message)
    process.exit(2)
  }
}

function matches (rule, file) {
  return rule.match.some(m => {
    if (m.endsWith('/**')) return file.indexOf(m.slice(0, -3) + '/') === 0
    if (m.endsWith('*')) return file.indexOf(m.slice(0, -1)) === 0
    return file === m || file.endsWith('/' + m)
  })
}

function main () {
  const forcedAll = has('--all')
  const files = forcedAll ? [] : changedFiles()
  const selected = new Set()
  const unbound = []
  const reasons = new Map()
  let realweb = false

  for (const f of files) {
    const rule = MAP.impact.find(r => matches(r, f))
    if (!rule) { unbound.push(f); continue }
    rule.suites.forEach(s => selected.add(s))
    if (rule.realweb) realweb = true
    reasons.set(f, rule.why)
  }

  const fullSuite = Array.from(selected)
  const ordered = Object.keys(MAP.suites).filter(s => fullSuite.indexOf(s) !== -1)

  console.log('=== test-impact plan ===')
  console.log('changed files : ' + (files.length || '(none — use --files or --all)'))
  if (reasons.size) {
    /* Collapse documentation-only churn: 80 doc files must not bury the three
     * files that actually select suites. */
    const impactful = []
    const docOnly = []
    for (const [f, why] of reasons) {
      if (why.indexOf('documentation only') === 0) docOnly.push(f)
      else impactful.push([f, why])
    }
    if (impactful.length) {
      console.log('\nmapping (executable impact):')
      for (const [f, why] of impactful) console.log('  ' + f + '\n      -> ' + why)
    }
    if (docOnly.length) console.log('\ndocumentation/evidence only (' + docOnly.length + ' file(s)): no suite selected')
  }
  if (unbound.length) {
    console.log('\nUNBOUNDED — no impact rule for:')
    unbound.forEach(f => console.log('  ' + f))
    console.log('  A change with no rule cannot be judged safe. Run the FULL suite (--all).')
  }

  console.log('\nselected suites (serial):')
  ordered.forEach(s => console.log('  ' + s.padEnd(16) + ' [Layer ' + MAP.suites[s].layer + '] ' + MAP.suites[s].cmd))
  console.log('\nLayer C real-web: ' + (realweb ? (has('--realweb') ? 'WILL RUN' : 'recommended — add --realweb') : 'not indicated by this change'))
  console.log('full-suite triggers (never skipped if the change hits them):')
  MAP.always_full.forEach(t => console.log('  - ' + t))

  if (!has('--run')) {
    console.log('\n(dry run — add --run to execute)')
    return unbound.length ? 1 : 0
  }

  if (unbound.length && !has('--all')) {
    console.log('\nrefusing to run a partial plan while UNBOUNDED files exist. Re-run with --all.')
    return 1
  }

  const results = []
  const runOne = (name, cmd) => {
    console.log('\n$ ' + cmd)
    const r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' })
    results.push({ suite: name, exit: r.status === null ? -1 : r.status })
    return r.status === 0
  }
  for (const s of ordered) runOne(s, MAP.suites[s].cmd)
  if (realweb && has('--realweb')) runOne('realweb', MAP.suites.realweb.cmd)

  console.log('\n=== results ===')
  results.forEach(r => console.log('  ' + r.suite.padEnd(16) + ' exit=' + r.exit))
  const failed = results.filter(r => r.exit !== 0)
  console.log(failed.length ? '\n' + failed.length + ' suite(s) FAILED — see their output above. Failing is information, not permission to skip.' : '\nall selected suites passed')
  return failed.length ? 1 : 0
}

process.exit(main())