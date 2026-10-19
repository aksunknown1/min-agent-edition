/* P0-03 feasibility fixture content script.
 * Runs at document_start, all_frames, in the extension's isolated world.
 *
 * Evidence channels, in order of reliability:
 *   1. chrome.storage.local, written via the service worker (readable off disk)
 *   2. document.title, which Min propagates to the window title
 *      (js/browserUI.js:157-166 -> set-window-title)
 * Channel 2 is reported but not relied on: see docs/EXTENSION-COMPATIBILITY.md.
 */

document.documentElement.dataset.minAgentExtension = 'document-start'

var minAgentFrameId = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
var minAgentIsTop = window === window.top

function minAgentInjectVisibleMarker () {
  if (!document.body || document.getElementById('min-agent-extension-marker')) {
    return
  }
  var marker = document.createElement('div')
  marker.id = 'min-agent-extension-marker'
  marker.setAttribute('data-min-agent-extension-marker', 'visible')
  marker.textContent = 'min-agent-extension active'
  marker.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:2px 5px;font:11px monospace;background:#fff;color:#000;border:1px solid rgb(251,191,36);opacity:0.9'
  document.body.appendChild(marker)
}

if (document.body) {
  minAgentInjectVisibleMarker()
} else {
  document.addEventListener('DOMContentLoaded', minAgentInjectVisibleMarker)
}

function minAgentCssMarkerSeen () {
  try {
    var value = getComputedStyle(document.documentElement).getPropertyValue('--min-agent-css-marker').trim()
    return value === 'rgb(251, 191, 36)' ? 'yes' : 'no'
  } catch (e) {
    return 'err'
  }
}

function minAgentObserved () {
  /* pageSawDocumentStart is written by the probe page's own <head> script.
   * Isolated worlds share the DOM, so reading it here proves the content script
   * had already run before any page script executed. */
  return {
    ds: document.documentElement.dataset.pageSawDocumentStart === 'yes' ? 'yes' : 'no',
    css: minAgentCssMarkerSeen()
  }
}

function minAgentReport (summary) {
  document.documentElement.dataset.minAgentReport = summary
  document.title = summary
}

/* P0-04: report document_start ordering once the document is parsed.
 * The MAIN-world fixture publishes the shared sequence into a data attribute;
 * an isolated world can read the DOM but not page JS globals, so this is the
 * only way to carry the ordering back over storage. */
document.addEventListener('DOMContentLoaded', function () {
  try {
    chrome.runtime.sendMessage({
      type: 'min-agent-order',
      frameId: minAgentFrameId,
      isTop: minAgentIsTop,
      seq: document.documentElement.dataset.minAgentSeq || null,
      pageSawIsolated: document.documentElement.dataset.pageSawIso || null,
      pageSawMainWorld: document.documentElement.dataset.pageSawMain || null,
      mainWorldMarker: document.documentElement.dataset.minAgentMainWorld || null
    })
  } catch (e) { /* ignore */ }
})

try {
  chrome.runtime.sendMessage({ type: 'min-agent-probe', frameId: minAgentFrameId, isTop: minAgentIsTop }, function (response) {
    var observed = minAgentObserved()

    if (chrome.runtime.lastError) {
      minAgentReport('EXT sw=ERR')
      chrome.runtime.sendMessage({ type: 'min-agent-result', frameId: minAgentFrameId, isTop: minAgentIsTop, ds: observed.ds, css: observed.css, sw: 'ERR: ' + chrome.runtime.lastError.message })
      return
    }
    if (!response || !response.ok) {
      minAgentReport('EXT sw=BAD')
      chrome.runtime.sendMessage({ type: 'min-agent-result', frameId: minAgentFrameId, isTop: minAgentIsTop, ds: observed.ds, css: observed.css, sw: 'BAD' })
      return
    }

    chrome.runtime.sendMessage({ type: 'min-agent-result', frameId: minAgentFrameId, isTop: minAgentIsTop, ds: observed.ds, css: observed.css, sw: 'ok', count: response.count, frames: response.frames })

    minAgentReport('EXT ds=' + observed.ds + ' css=' + observed.css + ' sw=ok n=' + response.count + ' f=' + response.frames + ' v=' + response.marker)
  })
} catch (e) {
  minAgentReport('EXT sw=THROW')
}
