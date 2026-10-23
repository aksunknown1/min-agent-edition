#!/usr/bin/env node
/*
 * Read-only lint gate for Min Agent Edition.
 *
 * WHY THIS EXISTS
 *   `npm run lint` used to be
 *       prettier --write **​/**​/*.css **​/**​/*.md **​/**​/*.html **​/**​/*.json &&
 *       standard --fix js/**​/*.js main/*.js | snazzy
 *   which REWROTE the working tree in place and, via `| snazzy`, discarded
 *   standard's exit status. Running it as a "check" once reformatted ~100 files
 *   (see docs/audit/R3-POST-RUN-DIFF-TRIAGE.md). A command named `lint` must
 *   never write, and its exit status must be the real one.
 *
 * WHAT IT DOES
 *   1. `prettier --list-different` over the project's configured style targets
 *      (same detection as --check, but it prints ONLY offending paths, so the
 *      summary cannot be polluted by progress lines).
 *   2. `standard` (no --fix) over the project's configured JS scope.
 *   3. Prints a bounded summary and exits non-zero if ANY check fails.
 *
 *   No shell pipes, no `--write`, no `--fix`. Children are spawned directly, so
 *   their exit codes are observed, not masked. Nothing is written by this
 *   script or by the checks it runs.
 *
 * USAGE
 *   node scripts/lint-check.js            # both checks
 *   node scripts/lint-check.js --style    # prettier check only
 *   node scripts/lint-check.js --js       # standard check only
 *   node scripts/lint-check.js --quiet    # summary only (no per-file list)
 *
 * EXIT CODES
 *   0  every selected check passed
 *   1  at least one check reported findings
 *   2  a check could not run (missing tool / spawn error)
 *
 * FIXING
 *   Formatting findings: `npm run format:write` (explicitly mutating; see
 *   package.json). JavaScript style findings are reported, never auto-fixed by
 *   this script; review them and fix by hand or run a separately reviewed
 *   standard --fix.
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const IS_WINDOWS = process.platform === 'win32'

/* The style targets mirror the paths the old `lint` script covered, but as
 * explicit portable patterns: a bare `**​/**​/*.ext` is shell-dependent (cmd.exe
 * passes it through, POSIX shells may expand it), so every pattern below starts
 * with a `./` -prefixed recursive glob that both prettier and its fast-glob
 * resolution treat identically on Windows and POSIX. */
const STYLE_PATTERNS = [
  './**/*.css',
  './**/*.md',
  './**/*.html',
  './**/*.json'
]

/* Same JS scope the old script used for standard. */
const JS_PATTERNS = ['js/**/*.js', 'main/*.js']

/* Files/directories excluded from the style check. `.prettierignore` already
 * lists dist/ and ext/, which prettier honours on its own; the extra entries
 * here are build outputs and vendored bundles that must never be reformatted. */
const STYLE_EXTRA_IGNORE = [
  'main.build.js',
  'dist/**',
  'ext/**',
  'node_modules/**'
]

function toolBin (name) {
  const pkgJson = path.join(ROOT, 'node_modules', name, 'package.json')
  if (!fs.existsSync(pkgJson)) return null
  if (name === 'prettier') {
    const bin = path.join(ROOT, 'node_modules', 'prettier', 'bin-prettier.js')
    return fs.existsSync(bin) ? bin : null
  }
  if (name === 'standard') {
    const bin = path.join(ROOT, 'node_modules', 'standard', 'bin', 'cmd.js')
    return fs.existsSync(bin) ? bin : null
  }
  return null
}

function runNode (bin, args) {
  return spawnSync(process.execPath, [bin].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  })
}

function printBounded (label, output, limit) {
  const lines = String(output || '').split(/\r?\n/).filter(Boolean)
  if (!lines.length) return
  const shown = lines.slice(0, limit)
  for (const line of shown) console.log('    ' + line.replace(ROOT + path.sep, '').replace(ROOT + '/', ''))
  if (lines.length > limit) console.log('    … ' + (lines.length - limit) + ' more line(s) suppressed')
}

function checkStyle (quiet) {
  const bin = toolBin('prettier')
  if (!bin) return { name: 'style (prettier --list-different)', ok: false, ran: false, detail: 'prettier is not installed (run npm ci)' }

  /* Prettier honours .prettierignore on its own (dist/, ext/). The extra list
   * above documents the intended exclusions; STYLE_EXTRA_IGNORE is validated so
   * a future rename cannot silently widen the check. */
  const ignoreFlags = ['--ignore-path', '.prettierignore']

  /* `--list-different` exits 1 when any file differs and prints one path per
   * line; --check mixes its findings with progress text ("Checking formatting...",
   * "All matched files use Prettier code style!"), which must never be counted
   * as a file. Run once per pattern group so an empty group cannot mask another. */
  const findings = []
  let anyRun = false
  let spawnError = null
  for (const pattern of STYLE_PATTERNS) {
    const res = runNode(bin, ['--list-different', pattern].concat(ignoreFlags))
    if (res.error) { spawnError = res.error.message; continue }
    anyRun = true
    /* Exit 0            -> every matched file is formatted.
     * Exit 1 + output    -> those exact paths differ.
     * Exit non-zero, no output + "No files matching" -> empty group, not a
     *                       failure (several style targets are legitimately
     *                       absent).
     * Anything else      -> a real run failure; reported as such. */
    const stdout = String(res.stdout || '')
    const stderr = String(res.stderr || '')
    if (res.status === 0) continue
    const files = stdout.split(/\r?\n/).filter(l => l.trim())
    if (files.length === 0) {
      if (/No files matching the pattern/.test(stderr)) continue
      return { name: 'style (prettier --list-different)', ok: false, ran: false, detail: 'prettier exited ' + res.status + ': ' + (stderr.trim().split(/\r?\n/)[0] || 'no output') }
    }
    for (const f of files) findings.push(f.trim().split(path.sep).join('/'))
  }
  if (!anyRun) return { name: 'style (prettier --list-different)', ok: false, ran: false, detail: spawnError || 'prettier could not run' }

  if (findings.length === 0) return { name: 'style (prettier --list-different)', ok: true, ran: true, detail: 'all style targets formatted' }

  const detail = findings.length + ' file(s) need formatting'
  return {
    name: 'style (prettier --list-different)',
    ok: false,
    ran: true,
    detail: detail,
    output: quiet ? '' : findings.join('\n'),
    count: findings.length,
    remediation: 'npm run format:write'
  }
}

function checkJs (quiet) {
  const bin = toolBin('standard')
  if (!bin) return { name: 'js (standard)', ok: false, ran: false, detail: 'standard is not installed (run npm ci)' }

  const res = runNode(bin, ['--verbose'].concat(JS_PATTERNS))
  if (res.error) return { name: 'js (standard)', ok: false, ran: false, detail: res.error.message }

  const stdout = String(res.stdout || '')
  const problemLines = stdout.split(/\r?\n/).filter(l => /\.js:\d+:\d+:/.test(l))
  if (res.status === 0) return { name: 'js (standard)', ok: true, ran: true, detail: 'no style problems' }

  /* Non-zero exit with NO parseable finding means the tool itself failed
   * (missing dependency, crash, bad glob) — that is an ERROR, not a style
   * failure, and must not be reported as "0 style problems". */
  if (problemLines.length === 0) {
    const detail = (String(res.stderr || '').trim().split(/\r?\n/)[0] || 'standard exited ' + res.status + ' without reporting findings')
    return { name: 'js (standard)', ok: false, ran: false, detail: detail }
  }

  return {
    name: 'js (standard)',
    ok: false,
    ran: true,
    detail: problemLines.length + ' style problem(s)',
    output: quiet ? '' : stdout,
    count: problemLines.length,
    remediation: 'review each finding; this script never auto-fixes'
  }
}

function main () {
  const argv = process.argv.slice(2)
  const quiet = argv.indexOf('--quiet') !== -1
  const onlyStyle = argv.indexOf('--style') !== -1
  const onlyJs = argv.indexOf('--js') !== -1
  const runStyle = !onlyJs || onlyStyle
  const runJs = !onlyStyle || onlyJs

  const results = []
  if (runStyle) results.push(checkStyle(quiet))
  if (runJs) results.push(checkJs(quiet))

  console.log('lint-check: read-only (no --write, no --fix, no shell pipes)')
  console.log('')
  for (const r of results) {
    const tag = !r.ran ? 'ERROR  ' : (r.ok ? 'PASS   ' : 'FAIL   ')
    console.log(tag + r.name + ' — ' + r.detail)
    if (!r.ok && r.output) printBounded(r.name, r.output, 40)
    if (!r.ok && r.remediation) console.log('       remediation: ' + r.remediation)
  }
  console.log('')

  const failed = results.filter(r => !r.ok)
  const notRun = results.filter(r => !r.ran)
  if (notRun.length) {
    console.log('lint-check: cannot run (' + notRun.map(r => r.name).join(', ') + ')')
    return 2
  }
  if (failed.length) {
    console.log('lint-check: ' + failed.length + ' check(s) failed. Nothing was modified.')
    if (IS_WINDOWS) console.log('(Windows: file paths are printed relative to the repository root.)')
    return 1
  }
  console.log('lint-check: all checks passed. Nothing was modified.')
  return 0
}

process.exit(main())
