/* P1-15 M3 — screenshots with adaptive fallback ladder + element-scoped capture.
 * The caller-required encoded-size cap is honored by re-encoding through a
 * ladder of (scale, format, quality) rungs — full detail first; progressively
 * smaller / recompressed until one rung fits, or an error with the attempts and cap.
 *
 * Element-scoped capture: an optional `selector` resolves an element rect inside
 * the page (validated, clamped), the view scrolls it into view, and the captured
 * full-viewport image is cropped to the element rect before the ladder runs.
 *
 * Metadata honestly reports attempts, whether rescaling/recompression happened,
 * and the final dimensions/format. Image data always goes to the caller. */
var AGENT_RPC_SCREENSHOT_DEFAULT_MAX = 5 * 1024 * 1024
var AGENT_RPC_SCREENSHOT_LADDER = [
  { scale: 1, fmt: 'as-req', q: -1 },
  { scale: 0.5, fmt: 'jpeg', q: 80 },
  { scale: 0.35, fmt: 'jpeg', q: 60 },
  { scale: 0.25, fmt: 'jpeg', q: 45 },
  { scale: 0.2, fmt: 'jpeg', q: 35 }
]

function agentRpcScreenshotMaxBytes (params) {
  if (params && typeof params.maxBytes === 'number' && params.maxBytes >= 5000) return Math.floor(params.maxBytes)
  return AGENT_RPC_SCREENSHOT_MAX
}

function agentRpcCommandScreenshot (params) {
  return new Promise(function (resolve, reject) {
    var tabId = params.tabId
    var view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
      return
    }
    if (typeof isViewAttachedToAnyWindow === 'function' && !isViewAttachedToAnyWindow(view)) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.view_not_attached, 'view_not_attached', 'view is detached or hidden; screenshots require an attached visible view'))
      return
    }
    var wc = view.webContents
    var cap = agentRpcScreenshotMaxBytes(params)
    /* selector: bounded CSS selector, same char family the transform engine accepts */
    if (params.selector !== undefined && (typeof params.selector !== 'string' || params.selector.length < 1 || params.selector.length > 300)) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'selector must be a string of 1-300 characters'))
      return
    }
    var settled = false
    var attempts = 0
    var overall = setTimeout(function () {
      if (settled) return
      settled = true
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'capture did not complete within ' + AGENT_RPC_SNAPSHOT_TIMEOUT + 'ms'))
    }, AGENT_RPC_SNAPSHOT_TIMEOUT)

    function finishResolve (payload) {
      if (settled) return
      settled = true
      clearTimeout(overall)
      resolve(payload)
    }
    function finishReject (err) {
      if (settled) return
      settled = true
      clearTimeout(overall)
      reject(err)
    }

    /* resolve the element rect (if selector), scroll it into view, return
     * viewport-space rect clamped to the current viewport */
    var resolveRect = params.selector === undefined
      ? Promise.resolve({ source: 'full' })
      : wc.executeJavaScript(
        '(function(){try{' +
        'var el=document.querySelector(' + JSON.stringify(String(params.selector)) + ');' +
        'if(!el||!el.getBoundingClientRect)return{error:"selector matched no element"};' +
        'el.scrollIntoView({block:"center",inline:"center"});' +
        'var r=el.getBoundingClientRect();' +
        'var iw=window.innerWidth,ih=window.innerHeight;' +
        'var x=Math.max(0,r.x),y=Math.max(0,r.y);' +
        'if(r.width<=0||r.height<=0)return{error:"element has zero size"};' +
        'return{x:Math.round(x),y:Math.round(y),width:Math.max(1,Math.round(w)),height:Math.max(1,Math.round(h)),vw:iw,vh:ih,ok:true}' +
        '}catch(eSel){return{error:String(eSel&&eSel.message||eSel).slice(0,200)}}})()'
      ).then(function (r) { return r == null ? { error: 'selector rect unavailable' } : r })

    resolveRect.then(function (rect) {
      if (rect && rect.error) {
        finishReject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', rect.error))
        return
      }
      /* bounded capture with re-issued attempts on wedges (pre-P1-15 behavior) */
      var attempt = function () {
        if (settled || attempts >= 6) return
        attempts++
        var attemptSettled = false
        var perAttempt = setTimeout(function () {
          if (attemptSettled) return
          attemptSettled = true
          if (attempts < 6) setTimeout(attempt, 200)
          else if (!settled) {
            finishReject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'capture did not settle (' + attempts + ' attempts)'))
          }
        }, 2500)
        wc.capturePage()
          .then(function (img) {
            if (attemptSettled || settled) return
            attemptSettled = true
            clearTimeout(perAttempt)
            var size = img.getSize()
            if (size.width === 0 && size.height === 0) {
              if (attempts < 6) setTimeout(attempt, 200)
              else if (!settled) finishReject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'captured a zero-size image (view not rendered)'))
              return
            }
            var sourceKind = rect && rect.ok ? 'element' : 'full'
            /* element crop: CSS px × (imgW / viewportCssW) → image px; clamped */
            if (rect && rect.ok) {
              var f = size.width / Math.max(1, rect.vw || 1)
              var cx = Math.round((rect.x || 0) * f)
              var cy = Math.round((rect.y || 0) * f)
              var cw = Math.max(1, Math.min(Math.round((rect.width || 1) * f), size.width - cx))
              var ch = Math.max(1, Math.min(Math.round((rect.height || 1) * f), size.height - cy))
              var cropped
              try { cropped = img.crop({ x: cx, y: cy, width: cw, height: ch }) } catch (eC) {
                finishReject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'element crop failed: ' + String(eC && eC.message || eC)))
                return
              }
              if (!cropped || cropped.isEmpty()) {
                finishReject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'element crop produced an empty image'))
                return
              }
              img = cropped
              size = img.getSize()
            }
            /* ladder: first rung honors requested format/quality/maxW/H; later
             * rungs downscale ( jpeg + lower q until it fits or all rungs fail) */
            var outMeta = null
            var rungResults = []
            var reqFmt = params.format === 'jpeg' ? 'jpeg' : 'png'
            var baseScale = 1
            if (params.maxWidth !== undefined || params.maxHeight !== undefined) {
              var swF = params.maxWidth !== undefined ? params.maxWidth / size.width : 1
              var shF = params.maxHeight !== undefined ? params.maxHeight / size.height : 1
              baseScale = Math.min(swF, shF, 1)
            }
            for (var li = 0; li < AGENT_RPC_SCREENSHOT_LADDER.length; li++) {
              var rung = AGENT_RPC_SCREENSHOT_LADDER[li]
              var effScale = Math.min(1, baseScale * rung.scale)
              var w = Math.max(1, Math.round(size.width * (effScale === 1 && li === 0 ? 1 : effScale / (li === 0 ? 1 : 1))))
              /* first rung encodes at native requested scale; later rungs downscale
               * relative to the ORIGINAL size */
              var wR = Math.max(1, Math.round(size.width * effScale))
              var hR = Math.max(1, Math.round(size.height * effScale))
              var imgR = li === 0 && effScale === 1 ? img : img.resize({ width: wR, height: hR })
              var fmt = rung.fmt === 'as-req' ? reqFmt : rung.fmt
              var q = rung.q === -1 ? (params.quality === undefined ? 80 : params.quality) : rung.q
              var buf = fmt === 'jpeg' ? imgR.toJPEG(q) : imgR.toPNG()
              var len = buf.toString('base64').length
              rungResults.push({ rung: li, fmt: fmt, w: imgR.getSize().width, h: imgR.getSize().height, encoded: len })
              if (len <= cap) {
                outMeta = { buf: buf, fmt: fmt, w: imgR.getSize().width, h: imgR.getSize().height, rung: li, scaled: li > 0, quality: fmt === 'jpeg' ? q : null }
                break
              }
            }
            if (!outMeta) {
              finishReject(agentRpcCommandError(AGENT_RPC_ERRORS.screenshot_too_large, 'screenshot_too_large',
                'no screenshot rung fits the cap (' + cap + ' B); attempts: ' + JSON.stringify(rungResults)))
              return
            }
            var outData = outMeta.buf.toString('base64')
            agentRplFetchViewportMeta(wc).then(function (meta) {
              var id = 'ss' + (++AGENT_RPC_SS_SEQ)
              var vp = { width: meta ? meta.iw : null, height: meta ? meta.ih : null, dpr: meta ? meta.dpr : null, scrollX: meta ? meta.sx : null, scrollY: meta ? meta.sy : null }
              var rec = { id: id, tabId: String(tabId), viewport: vp, zoom: wc.getZoomFactor(), imageWidth: outMeta.w, imageHeight: outMeta.h, format: outMeta.fmt, at: Date.now() }
              try { var u2 = new URL(wc.getURL()); rec.urlPath = u2.origin + u2.pathname } catch (e3) { rec.urlPath = null }
              AGENT_RPC_SCREENSHOTS.set(id, rec)
              var cssFactor = vp.width ? (outMeta.w / vp.width) : 1
              finishResolve({
                tabId: String(tabId),
                screenshotId: id,
                mimeType: outMeta.fmt,
                bytes: outData.length,
                width: outMeta.w,
                height: outMeta.h,
                coordinateUnits: 'viewport-css-px',
                cssPerPixel: cssFactor,
                viewport: vp,
                zoom: rec.zoom,
                urlPath: rec.urlPath,
                timestamp: new Date().toISOString(),
                source: sourceKind,
                scaled: outMeta.scaled,
                attempts: attempts,
                ladder: rungResults,
                data: outData
              })
            })
          })
          .catch(function () {
            if (attemptSettled || settled) return
            attemptSettled = true
            clearTimeout(perAttempt)
            if (attempts < 6) setTimeout(attempt, 200)
            else if (!settled) finishReject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'capture did not succeed (' + attempts + ' attempts)'))
          })
      }
      attempt()
    })
  })
}
function windowWidthFallback (img, rect) { return rect.vw || 1 }
