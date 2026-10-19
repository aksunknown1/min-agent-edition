/* P0-04 fixture: MAIN-world content script at document_start.
 *
 * A MAIN-world script shares the page's JS context, so it can append to a page
 * global that the page's own inline <head> script also appends to. The resulting
 * array order is a direct, unambiguous record of which ran first.
 *
 * It has no chrome.* access, so it publishes its findings into the DOM; the
 * ISOLATED-world fixture reads them back and reports them over storage.
 */

;(function () {
  window.__minAgentSeq = window.__minAgentSeq || []
  window.__minAgentSeq.push('ext-main-document-start')
  window.__minAgentMainWorldRan = true

  function publish () {
    if (!document.documentElement) {
      return
    }
    document.documentElement.dataset.minAgentMainWorld = 'document-start'
    document.documentElement.dataset.minAgentSeq = (window.__minAgentSeq || []).join('|')
  }

  publish()

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', publish)
  }
})()
