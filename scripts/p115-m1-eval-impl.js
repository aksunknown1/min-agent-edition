'use strict'
/* P1-15 M1 — page-context evaluation (browser_eval) + per-tab viewport scale.
 * AGENT_EVAL_PAGE_FN is transported to the page via Function.prototype.toString()
 * (same mechanism as AGENT_SNAPSHOT_PAGE_FN). It ALWAYS executes in the target
 * tab's main world — never in Node/MCP/server context.
 *
 * Serialization: results are JSON-serialized INSIDE the page with explicit
 * handling for cycles, functions, DOM nodes, ImageData, oversized strings/objects
 * (two-tier caps: full then tight) and non-JSON types.
 *
 * Timeout honesty: the bridge races this call against a bounded timer. An endless
 * SYNCHRONOUS expression keeps the renderer busy even after the call rejects —
 * real V8 cancellation does not exist from outside; the rejection message says so
 * and includes a recovery hint. Awaiting promises whose fulfillment never arrives is the
 * same category. */

var AGENT_EVAL_PAGE_FN = function (evalExprString, awaitPromise, maxChars) {
  'use strict'
  function safe (v, depth, seen, tight) {
    depth = depth || 0
    seen = seen || new Set()
    var t = typeof v
    if (v === undefined) return { __t: 'undefined' }
    if (v === null || t === 'number' || t === 'boolean') return { __t: t, v: Number.isNaN(v) ? 'NaN' : v }
    if (t === 'string') return { __t: 'string', len: v.length, v: (tight ? v.slice(0, 200) : v.slice(0, 2000)) }
    if (t === 'bigint') return { __t: 'bigint', v: String(v) }
    if (t === 'function') return { __t: 'function', name: v.name || 'anonymous' }
    if (v instanceof Error) return { __t: 'error', name: String(v.name || 'Error'), mess: String(v.message || '').slice(0, 300) }
    if (typeof Node !== 'undefined' && v instanceof Node) {
      var box = null
      try {
        if (v.getBoundingClientRect) {
          var bb = v.getBoundingClientRect()
          box = { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height) }
        }
      } catch (eBox) { /* detached */ }
      return { __t: 'node', nodeType: v.nodeType, tag: (v.tagName || '').toLowerCase() || null, id: v.id || null, text: (v.textContent || '').slice(0, 120), box: box }
    }
    if (typeof ImageData !== 'undefined' && v instanceof ImageData) {
      var pv = Math.min(v.data.length, tight ? 64 : 4096)
      return { __t: 'imagedata', width: v.width, height: v.height, dataLength: v.data.length, dataPreview: Array.prototype.slice.call(v.data, 0, pv) }
    }
    if (depth > 6) return { __t: 'maxdepth' }
    if (seen.has(v)) return { __t: 'circular' }
    seen.add(v)
    if (Array.isArray(v)) return { __t: 'array', length: v.length, items: v.slice(0, tight ? 15 : 300).map(function (x) { return safe(x, depth + 1, seen, tight) }) }
    if (v instanceof Map) return { __t: 'map', size: v.size }
    if (v instanceof Set) return { __t: 'set', size: v.size }
    var ks = Object.keys(v).slice(0, tight ? 10 : 100)
    var out = { __t: 'object', ctor: (v.constructor && v.constructor.name) || 'Object' }
    for (var i = 0; i < ks.length; i++) out[String(ks[i]).slice(0, 120)] = safe(v[ks[i]], depth + 1, seen, tight)
    return out
  }
  function jsonOut (v) {
    var full = JSON.stringify({ ok: true, value: safe(v, 0, new Set(), false) })
    if (full.length <= maxChars) return full
    var tj = JSON.stringify({ ok: true, truncated: true, fullChars: full.length, value: safe(v, 0, new Set(), true) })
    if (tj.length <= maxChars) return tj
    return JSON.stringify({ ok: true, truncated: true, errorNote: 'result exceeds maxResultChars even at minimum detail', fullChars: full.length })
  }
  var RUN = new Function('EPS', 'return (async function () { "use strict";\ntry {\n  return await (' + evalExprString + ');\n} catch (eEval) {\n  return { __rejected: true, name: (eEval && eEval.name) || "Error", message: String((eEval && eEval.message) || "").slice(0, 500) };\n}\n})')
  try {
    var resultPromise = RUN(evalExprString)
    if (!awaitPromise) {
      /* synchronous mode: a promise result is reported as-is (unresolved) */
      return resultPromise.then(function (r) {
        if (r && r.__rejected === true) return JSON.stringify({ ok: false, error: { name: r.name, message: r.message, isRejection: true } })
        if (r && typeof r.then === 'function') return JSON.stringify({ ok: true, awaitPromise: false, unresolvedPromise: true, value: { __t: 'promise' } })
        return jsonOut(r)
      }).catch(function (eSync) {
        return JSON.stringify({ ok: false, error: { name: String(eSync && eSync.name || 'Error'), message: String(eSync && eSync.message || '').slice(0, 500) } })
      })
    }
    return resultPromise.then(function (r) {
      if (r && r.__rejected === true) return JSON.stringify({ ok: false, awaitedPromise: true, error: { name: r.name, message: r.message, isRejection: true } })
      return jsonOut(r)
    }).catch(function (eAwait) {
      return JSON.stringify({ ok: false, awaitedPromise: true, error: { name: String(eAwait && eAwait.name || 'Error'), message: String(eAwait && eAwait.message || '').slice(0, 500), isRejection: true } })
    })
  } catch (eMake) {
    return Promise.resolve(JSON.stringify({ ok: false, error: { name: String(eMake && eMake.name || 'Error'), message: String(eMake && eMake.message || '').slice(0, 500) } }))
  }
}

function agentRpcCommandEval (params) {
  return new Promise(function (resolve, reject) {
    var tabId = params.tabId
    var view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
      return
    }
    var wc = view.webContents
    var expr = String(params.expression || '')
    var awaitPromise = params.awaitPromise !== false
    var timeoutMs = params.timeoutMs === undefined ? 10000 : params.timeoutMs
    var maxChars = params.maxResultChars === undefined ? 60000 : params.maxResultChars
    if (expr.length === 0) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'expression is required (an expression, not a statement list — wrap statements in an IIFE)'))
      return
    }
    /* serialize evaluations per webContents: two engines must not interleave on
     * the same renderer; the queue is bounded so a stalled stream surfaces as
     * busy instead of growing forever. */
    var qKey = String(wc.id)
    AGENT_RPC_EVAL_QUEUES[qKey] = AGENT_RPC_EVAL_QUEUES[qKey] || Promise.resolve()
    if ((AGENT_RPC_EVAL_QUEUE_LEN[qKey] || 0) >= 24) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'busy', 'too many queued page evaluations for this tab'))
      return
    }
    AGENT_RPC_EVAL_QUEUE_LEN[qKey] = (AGENT_RPC_EVAL_QUEUE_LEN[qKey] || 0) + 1
    var run = function () {
      var settled = false
      return new Promise(function (done) {
        var raceTimer = setTimeout(function () {
          if (settled) return
          settled = true
          done(JSON.stringify({ ok: false, timeout: true, error: { name: 'TimeoutError', message: 'page evaluation exceeded ' + timeoutMs + 'ms. If the expression contains an endless synchronous loop the renderer may still be busy; reload the page (browser_navigate) to recover.', awaitPromise: awaitPromise } }))
        }, timeoutMs)
        var src = '(' + AGENT_EVAL_PAGE_FN.toString() + ')(' +
          JSON.stringify(String(expr)) + ',' + (awaitPromise ? 'true' : 'false') + ',' + JSON.stringify(maxChars) + ')'
        wc.executeJavaScript(src)
          .then(function (outJson) {
            if (settled) return
            settled = true
            clearTimeout(raceTimer)
            done(String(outJson))
          })
          .catch(function (eExec) {
            if (settled) return
            settled = true
            clearTimeout(raceTimer)
            done(JSON.stringify({ ok: false, error: { name: String((eExec && eExec.name) || 'Error'), message: String((eExec && eExec.message) || '').slice(0, 500) } }))
          })
      })
    }
    AGENT_RPC_EVAL_QUEUES[qKey] = AGENT_RPC_EVAL_QUEUES[qKey]
      .then(run)
      .then(function (outJson) {
        AGENT_RPC_EVAL_QUEUE_LEN[qKey] = (AGENT_RPC_EVAL_QUEUE_LEN[qKey] || 1) - 1
        var parsed = null
        try { parsed = JSON.parse(outJson) } catch (eParse) {
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.internal, 'invalid_results', 'evaluation returned a non-JSON result'))
          return
        }
        if (parsed && parsed.ok === false) {
          var cat = parsed.timeout ? 'timeout' : (parsed.awaitedPromise ? 'eval_rejected' : 'eval_exception')
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, cat, (parsed.error && parsed.error.name || 'Error') + ': ' + (parsed.error && parsed.error.message || '')))
          return
        }
        resolve({
          tabId: String(tabId),
          executionContext: 'main-frame-page-world',
          awaitedPromise: !!awaitPromise,
          truncated: parsed.truncated === true,
          unresolvedPromise: parsed.unresolvedPromise === true,
          value: parsed.value
        })
      }, function (eQ) {
        AGENT_RPC_EVAL_QUEUE_LEN[qKey] = (AGENT_RPC_EVAL_QUEUE_LEN[qKey] || 1) - 1
        reject(eQ)
      })
  })
}

function agentRpcCommandViewport (params) {
  var view = typeof viewMap !== 'undefined' ? viewMap[params.tabId] : null
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  var wc = view.webContents
  var previousZoom = wc.getZoomFactor()
  var zoom = params.zoom === undefined ? 1 : params.zoom
  if (typeof zoom !== 'number' || isNaN(zoom) || zoom < 0.25 || zoom > 3) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'zoom must be a number between 0.25 and 3'))
  }
  wc.setZoomFactor(zoom)
  return agentRplFetchViewportMeta(wc).then(function (meta) {
    return {
      tabId: String(params.tabId),
      zoom: zoom,
      previousZoom: previousZoom,
      viewport: { width: meta ? meta.iw : null, height: meta ? meta.ih : null, dpr: meta ? meta.dpr : null },
      note: 'per-tab viewport scale (zoom); cssPerPixel and screenshots reflect it; restore with zoom=previousZoom'
    }
  })
}
