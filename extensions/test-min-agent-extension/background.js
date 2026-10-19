/* P0-03 feasibility fixture MV3 service worker.
 *
 * chrome.storage.local is the primary evidence channel: it is readable from
 * outside the app as plain bytes in the profile's LevelDB, so the whole chain
 * (content script -> runtime message -> service worker -> storage) is provable
 * without a remote debugging port, CDP, or any instrumentation of Min.
 */

var PROBE_KEY = 'minAgentProbe'
var FRAMES_KEY = 'minAgentFrames'
var ORDER_KEY = 'minAgentOrder'
var seenFrames = new Set()

console.log('[min-agent-test-extension] service worker started')

function recordFrame (entry) {
  chrome.storage.local.get(FRAMES_KEY, function (result) {
    var frames = (result && result[FRAMES_KEY]) ? result[FRAMES_KEY] : []
    frames.push(entry)
    chrome.storage.local.set({ minAgentFrames: frames })
  })
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) {
    return false
  }

  if (message.type === 'min-agent-order') {
    /* P0-04: document_start ordering, observed at DOMContentLoaded */
    chrome.storage.local.get(ORDER_KEY, function (result) {
      var orders = (result && result[ORDER_KEY]) ? result[ORDER_KEY] : []
      orders.push({
        frameId: message.frameId,
        isTop: message.isTop,
        url: sender ? sender.url : null,
        senderFrameId: sender ? sender.frameId : null,
        seq: message.seq,
        pageSawIsolated: message.pageSawIsolated,
        pageSawMainWorld: message.pageSawMainWorld,
        mainWorldMarker: message.mainWorldMarker
      })
      chrome.storage.local.set({ minAgentOrder: orders })
    })
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'min-agent-result') {
    /* second leg: the content script's own view of what it observed */
    recordFrame({
      frameId: message.frameId,
      isTop: message.isTop,
      documentStartSeenByPage: message.ds,
      cssMarkerSeen: message.css,
      senderUrl: sender ? sender.url : null,
      senderTabId: sender && sender.tab ? sender.tab.id : null,
      senderFrameId: sender ? sender.frameId : null,
      senderExtensionId: sender ? sender.id : null
    })
    sendResponse({ ok: true })
    return false
  }

  if (message.type !== 'min-agent-probe') {
    return false
  }

  if (message.frameId) {
    seenFrames.add(message.frameId)
  }

  chrome.storage.local.get(PROBE_KEY, function (result) {
    var stored = (result && result[PROBE_KEY]) ? result[PROBE_KEY] : { marker: 'P0-03', count: 0 }
    stored.count += 1

    chrome.storage.local.set({ minAgentProbe: stored }, function () {
      chrome.storage.local.get(PROBE_KEY, function (verify) {
        var readBack = (verify && verify[PROBE_KEY]) ? verify[PROBE_KEY] : null
        sendResponse({
          ok: !!(readBack && readBack.marker === 'P0-03' && readBack.count === stored.count),
          marker: readBack ? readBack.marker : null,
          count: readBack ? readBack.count : null,
          frames: seenFrames.size,
          hasSenderTab: !!(sender && sender.tab)
        })
      })
    })
  })

  /* keep the message channel open: the response is asynchronous */
  return true
})
