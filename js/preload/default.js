/* imports common modules */

var electron = require('electron')
var ipc = electron.ipcRenderer

var propertiesToClone = ['deltaX', 'deltaY', 'metaKey', 'ctrlKey', 'defaultPrevented', 'clientX', 'clientY']

function cloneEvent (e) {
  var obj = {}

  for (var i = 0; i < propertiesToClone.length; i++) {
    obj[propertiesToClone[i]] = e[propertiesToClone[i]]
  }
  return JSON.stringify(obj)
}

// workaround for Electron bug
setTimeout(function () {
  /* Used for swipe gestures */
  window.addEventListener('wheel', function (e) {
    ipc.send('wheel-event', cloneEvent(e))
  })

  var scrollTimeout = null

  window.addEventListener('scroll', function () {
    clearTimeout(scrollTimeout)
    scrollTimeout = setTimeout(function () {
      ipc.send('scroll-position-change', Math.round(window.scrollY))
    }, 200)
  })
}, 0)

/* Used for picture in picture item in context menu */
ipc.on('getContextMenuData', function (event, data) {
  // check for video element to show picture-in-picture menu
  var hasVideo = Array.from(document.elementsFromPoint(data.x, data.y)).some(el => el.tagName === 'VIDEO')
  ipc.send('contextMenuData', { hasVideo })
})

ipc.on('enterPictureInPicture', function (event, data) {
  var videos = Array.from(document.elementsFromPoint(data.x, data.y)).filter(el => el.tagName === 'VIDEO')
  if (videos[0]) {
    videos[0].requestPictureInPicture()
  }
})

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  if (e.data?.message === 'showCredentialList') {
    ipc.send('showCredentialList')
  }

  if (e.data?.message === 'showUserscriptDirectory') {
    ipc.send('showUserscriptDirectory')
  }

  if (e.data?.message === 'downloadFile') {
    ipc.send('downloadFile', e.data.url)
  }
})

/* Phase E / D2-A: trusted-input delivery attestation.
 *
 * This runs in the isolated preload world (contextIsolation:true,
 * sandbox:true). Page JavaScript cannot read, call or forge anything defined
 * here, and cannot send IPC at all - so a page can never manufacture a
 * "delivered" acknowledgement.
 *
 * Only events with isTrusted === true are attested. A synthetic
 * `new KeyboardEvent('keydown', ...)` dispatched by the page is isTrusted:false
 * and is therefore never counted.
 *
 * NOTHING about the event VALUE is recorded - no key, no character, no
 * coordinates, no target - only the kind and a monotonic counter. A password
 * typed into a field cannot leak through this channel.
 *
 * This attests ONLY that the renderer delivered a trusted input event to the
 * page. It is NOT compositor paint, NOT application effect, and NOT challenge
 * clearance. Those remain unproven and are reported as such. */
var attestSeq = 0
function attestTrusted (kind, e) {
  if (!e || e.isTrusted !== true) return
  attestSeq++
  ipc.send('agent-attest', { seq: attestSeq, kind: kind })
}
window.addEventListener('keydown', function (e) { attestTrusted('key', e) }, true)
window.addEventListener('keyup', function (e) { attestTrusted('key', e) }, true)
window.addEventListener('mousedown', function (e) { attestTrusted('pointer', e) }, true)
window.addEventListener('mouseup', function (e) { attestTrusted('pointer', e) }, true)
