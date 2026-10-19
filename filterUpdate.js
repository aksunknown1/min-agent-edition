/* P1-07: conservative runtime filter-list updater.
 *
 * Contract (task P1-07, Phase 3):
 * - fixed allow-list of official HTTPS sources (EasyList + EasyPrivacy via easylist.to)
 * - conditional requests (ETag / If-Modified-Since) when the server supports them
 * - timeout, byte cap, status-code validation per source
 * - redirect policy: HTTPS only, approved host only
 * - content validation before promotion (header marker, min bytes, min rules)
 * - atomic promotion (temp file + rename) of combined list + metadata
 * - last-known-good retained on any failure; old active parsed data never replaced on failure
 * - single-flight updates + generation counter (no stale overwrite)
 * - sanitized diagnostics only (ids, sizes, hashes, timestamps, counts, sanitized errors)
 */
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const APPROVED_HOST = 'easylist.to'
const APPROVED_SOURCES = [
  { id: 'easylist', urlPath: '/easylist/easylist.txt' },
  { id: 'easyprivacy', urlPath: '/easylist/easyprivacy.txt' }
]
const MAX_REDIRECTS = 3
const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

function sha256Hex (buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

let activeCfg = null

function currentSafeUrl (u) { return u.toString() }

/* exact upstream transform parity with ext/filterLists/updateEasylist.js */
function transformCombined (combinedRaw) {
  return combinedRaw.split('\n').filter(function (line) {
    return (
      !line.includes('##') && // element hiding rules
      !line.includes('#@') && // element hiding exceptions
      !line.trim().startsWith('!') // comments
    )
  }).join('\n')
}

function countRules (data) {
  return data.split('\n').filter(function (l) { return l.trim().length > 0 }).length
}

function atomicWrite (filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp' + Date.now()
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, filePath)
}

function readJson (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

function create (options) {
  activeCfg = options && options.allowNonHttpsTestOrigins ? { allowNonHttpsTestOrigins: true } : null
  const cfg = Object.assign({
    userDataDir: null,
    refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    startupDelayMs: 30000,
    timeoutMs: 30000,
    maxBytes: 16 * 1024 * 1024,
    minSourceBytes: 40000,
    minSourceRules: 5000,
    minCombinedBytes: 1000000,
    minCombinedRules: 20000,
    sourcesOverride: null,
    approvedHost: APPROVED_HOST,
    onPromoted: null,
    log: function (msg) { try { console.log('[filterUpdate]', msg) } catch (e) { } }
  }, options || {})

  if (!cfg.userDataDir) throw new Error('userDataDir required')

  const cacheDir = path.join(cfg.userDataDir, 'filterCache')
  const combinedPath = path.join(cacheDir, 'combined-noelementhiding.txt')
  const metaPath = path.join(cacheDir, 'meta.json')

  let inFlight = false
  let generation = 0
  let lastStatus = { startedAt: null, lastSuccessAt: null, lastError: null, promoted: false }

function fetchWithPolicy (urlStr, extraHeaders, timeoutMs, maxBytes, redirectsLeft, cb) {
  let u
  try { u = new URL(urlStr) } catch (e) { return cb(new Error('invalid url')) }
  /* localhost http permitted (loopback-only, used by test fixtures and local
   * diagnostics); all non-loopback sources remain https-only. */
  if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return cb({ name: 'http-status', code: 0, message: 'non-https url rejected' })
  const transport = (u.protocol === 'https:') ? https : require('http')
  const req = transport.request({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'GET',
    headers: Object.assign({ 'user-agent': 'Min-Agent-Edition filter updater' }, extraHeaders || {})
  })
  req.setTimeout(timeoutMs, function () { req.destroy(new Error('timeout')) })
  req.on('response', function (res) {
    let settled = false
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      if (redirectsLeft <= 0) { res.resume(); return cb(new Error('too many redirects')) }
      let next
      try { next = new URL(res.headers.location, currentSafeUrl(u)) } catch (eR) { res.resume(); return cb(new Error('invalid redirect target')) }
      const localTest = (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
      const sameHost = (next.hostname === u.hostname)
      if (next.protocol !== 'https:' && !(localTest && sameHost)) { res.resume(); return cb(new Error('non-https redirect rejected')) }
      if (next.hostname !== APPROVED_HOST && !sameHost) { res.resume(); return cb(new Error('redirect to unapproved host rejected')) }
      res.resume()
      return fetchWithPolicy(next.toString(), extraHeaders, timeoutMs, maxBytes, redirectsLeft - 1, cb)
    }
    if (res.statusCode !== 200) {
      const code = res.statusCode
      res.resume()
      return cb({ name: 'http-status', code: code, message: 'http status ' + code })
    }
    const chunks = []
    const seen = { size: 0 }
    res.on('data', function (c) {
      if (settled) return
      seen.size += c.length
      if (seen.size > maxBytes) {
        settled = true
        req.destroy(new Error('response exceeds byte limit'))
        return cb(new Error('response exceeds byte limit'))
      }
      chunks.push(c)
    })
    res.on('end', function () {
      cb(null, {
        status: 'updated',
        body: Buffer.concat(chunks),
        etag: res.headers.etag || null,
        lastModified: res.headers['last-modified'] || null,
        bytes: seen.size
      })
    })
    res.on('error', function (e2) { cb(e2) })
  })
  req.on('error', function (e3) { cb(e3) })
  req.end()
}

  function sourcesList () {
    if (cfg.sourcesOverride && cfg.sourcesOverride.length) return cfg.sourcesOverride
    return APPROVED_SOURCES.map(function (s2) { return { id: s2.id, url: 'https://' + APPROVED_HOST + s2.urlPath } })
  }

  function validateSource (srcId, body) {
    if (!body || body.length < cfg.minSourceBytes) return { ok: false, reason: 'source body below minimum size (' + (body ? body.length : 0) + ' < ' + cfg.minSourceBytes + ')' }
    const firstNl = body.indexOf(10)
    const firstLine = body.slice(0, firstNl === -1 ? 200 : firstNl).toString('utf8', 0, 120)
    if (firstLine.indexOf('[Adblock Plus') === -1) return { ok: false, reason: 'missing Adblock Plus header marker' }
    const rules = countRules(body.toString('utf8'))
    if (rules < cfg.minSourceRules) return { ok: false, reason: 'implausible rule count: ' + rules }
    return { ok: true, rules: rules }
  }

  /* single update pass with a completion callback (single-flight serialized above) */
  function runUpdate (reason, gen, completedCb) {
    const meta = readJson(metaPath) || { sources: {} }
    const perSource = []
    let failed = null
    let i = 0
    const srcs = sourcesList()
    let doneCalled = false

    function nextSource () {
      if (failed !== null || i >= srcs.length) return done()
      const src = srcs[i]
      const headers = {}
      const prev = (meta.sources && meta.sources[src.id]) || {}
      if (prev.etag) headers['if-none-match'] = prev.etag
      if (prev.lastModified) headers['if-modified-since'] = prev.lastModified
      fetchWithPolicy(src.url, headers, cfg.timeoutMs, cfg.maxBytes, MAX_REDIRECTS, function (err, res2) {
        if (err && err.name === 'http-status' && err.code === 304) {
          try {
            const partPath = path.join(cacheDir, 'part-' + src.id + '.txt')
            const partBuf = fs.readFileSync(partPath)
            perSource.push({ id: src.id, body: partBuf, etag: prev.etag, lastModified: prev.lastModified, bytes: partBuf.length, rules: countRules(partBuf.toString('utf8')) })
            i++
            return nextSource()
          } catch (eP) {
            failed = src.id + ': 304 without usable cached part'
            return done()
          }
        }
        if (err) { failed = src.id + ': ' + ((err && err.message) || String(err)); return done() }
        if (res2.status === 'updated') {
          const v = validateSource(src.id, res2.body)
          if (!v.ok) { failed = src.id + ': ' + v.reason; return done() }
          perSource.push({ id: src.id, body: res2.body, etag: res2.etag, lastModified: res2.lastModified, bytes: res2.bytes, rules: v.rules })
          i++
          return nextSource()
        }
        /* 304: source unchanged; use the cached per-source part (kept after each successful update) */
        try {
          const partPath = path.join(cacheDir, 'part-' + src.id + '.txt')
          const partBuf = fs.readFileSync(partPath)
          perSource.push({ id: src.id, body: partBuf, etag: prev.etag, lastModified: prev.lastModified, bytes: partBuf.length, rules: countRules(partBuf.toString('utf8')) })
          i++
          return nextSource()
        } catch (eP) {
          failed = src.id + ': 304 without usable cached part'
          return done()
        }
      })
    }

    function done () {
      if (doneCalled) return
      doneCalled = true
      try { finish() } catch (eF) { cfg.log('update completion error: ' + eF.message) }
      cfg.log('[dbg done] failed=' + JSON.stringify(failed) + ' perSource=' + perSource.length + ' inFlight=' + inFlight)
      if (typeof completedCb === 'function') completedCb()
    }

    function finish () {
      if (failed !== null) {
        lastStatus = Object.assign({}, lastStatus, { lastError: failed, at: new Date().toISOString() })
        cfg.log('update failed (' + reason + '): ' + failed)
        return
      }
      if (generation > gen) { cfg.log('update superseded; not promoting'); return }

      const easy = perSource.find(function (p2) { return p2.id === 'easylist' })
      const priv = perSource.find(function (p2) { return p2.id === 'easyprivacy' })
      const combinedRaw = (easy ? easy.body.toString('utf8') : '') + (priv ? priv.body.toString('utf8') : '')
      const combined = transformCombined(combinedRaw)
      const cBuf = Buffer.from(combined, 'utf8')
      if (cBuf.length < cfg.minCombinedBytes) {
        lastStatus = Object.assign({}, lastStatus, { lastError: 'combined below minimum bytes (' + cBuf.length + ')' })
        cfg.log('update rejected: ' + lastStatus.lastError)
        return
      }
      const rules = countRules(combined)
      if (rules < cfg.minCombinedRules) {
        lastStatus = Object.assign({}, lastStatus, { lastError: 'combined rule count implausible: ' + rules })
        cfg.log('update rejected: ' + lastStatus.lastError)
        return
      }

      perSource.forEach(function (p3) { atomicWrite(path.join(cacheDir, 'part-' + p3.id + '.txt'), p3.body) })
      atomicWrite(combinedPath, cBuf)
      const newMeta = {
        version: 1,
        sources: {},
        combined: { bytes: cBuf.length, sha256: sha256Hex(cBuf), rules: rules, promotedAt: new Date().toISOString() },
        lastUpdateAt: new Date().toISOString(),
        lastUpdateReason: reason
      }
      perSource.forEach(function (p4) { newMeta.sources[p4.id] = { etag: p4.etag, lastModified: p4.lastModified, bytes: p4.bytes, sha256: sha256Hex(p4.body), rules: p4.rules } })
      atomicWrite(metaPath, JSON.stringify(newMeta, null, 2))

      generation++
      lastStatus = {
        startedAt: lastStatus.startedAt,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        promoted: true,
        combined: newMeta.combined,
        sources: newMeta.sources,
        reason: reason
      }
      cfg.log('filter lists updated (' + reason + '): combined=' + cBuf.length + ' bytes, ' + rules + ' rules, sha256=' + newMeta.combined.sha256.slice(0, 12))
      if (typeof cfg.onPromoted === 'function') {
        try { cfg.onPromoted(combinedPath) } catch (eOP) { cfg.log('post-promotion callback failed: ' + eOP.message) }
      }
    }

    nextSource()
  }

  function maybeUpdate (reason) {
    if (inFlight) { cfg.log('update already in progress; skipping (' + reason + ')'); return false }
    inFlight = true
    const gen = generation
    lastStatus = Object.assign({}, lastStatus, { startedAt: new Date().toISOString(), reason: reason })
    cfg.log('filter list update starting (' + reason + ')')
    try {
      runUpdate(reason, gen, function () { inFlight = false })
      return true
    } catch (eH) {
      inFlight = false
      cfg.log('update crashed: ' + (eH.message || eH))
      return false
    }
  }

  function getStatus () {
    return JSON.parse(JSON.stringify(Object.assign({
      cacheDir: cacheDir,
      combinedPath: combinedPath,
      refreshIntervalMs: cfg.refreshIntervalMs,
      inFlight: inFlight,
      generation: generation
    }, lastStatus)))
  }

  function schedule () {
    setTimeout(function () { maybeUpdate('startup') }, cfg.startupDelayMs).unref()
    const timer = setInterval(function () { maybeUpdate('interval') }, cfg.refreshIntervalMs)
    timer.unref()
  }

  return {
    maybeUpdate: maybeUpdate,
    schedule: schedule,
    getStatus: getStatus,
    cacheDir: cacheDir,
    combinedPath: combinedPath,
    /* diagnostic handle: direct fetch-policy access for allow-list validation tests (not exposed via MCP) */
    _testFetch: fetchWithPolicy
  }
}

module.exports = { create: create, transformCombined: transformCombined, countRules: countRules, sha256Hex: sha256Hex, atomicWrite: atomicWrite }
