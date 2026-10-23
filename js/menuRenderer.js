/* Handles messages that get sent from the menu bar in the main process */

var webviews = require('webviews.js')
var webviewGestures = require('webviewGestures.js')
var browserUI = require('browserUI.js')
var focusMode = require('focusMode.js')
var modalMode = require('modalMode.js')
var findinpage = require('findinpage.js')
var PDFViewer = require('pdfViewer.js')
var tabEditor = require('navbar/tabEditor.js')
var readerView = require('readerView.js')
var taskOverlay = require('taskOverlay/taskOverlay.js')

module.exports = {
  initialize: function () {
    ipc.on('zoomIn', function () {
      webviewGestures.zoomWebviewIn(tabs.getSelected())
    })

    ipc.on('zoomOut', function () {
      webviewGestures.zoomWebviewOut(tabs.getSelected())
    })

    ipc.on('zoomReset', function () {
      webviewGestures.resetWebviewZoom(tabs.getSelected())
    })

    ipc.on('print', function () {
      if (PDFViewer.isPDFViewer(tabs.getSelected())) {
        PDFViewer.printPDF(tabs.getSelected())
      } else if (readerView.isReader(tabs.getSelected())) {
        readerView.printArticle(tabs.getSelected())
      } else if (webviews.placeholderRequests.length === 0) {
        // work around #1281 - calling print() when the view is hidden crashes on Linux in Electron 12
        // TODO figure out why webContents.print() doesn't work in Electron 4
        webviews.callAsync(tabs.getSelected(), 'executeJavaScript', 'window.print()')
      }
    })

    ipc.on('findInPage', function () {
      /* Page search is not available in modal mode. */
      if (modalMode.enabled()) {
        return
      }

      findinpage.start()
    })

    ipc.on('inspectPage', function () {
      webviews.callAsync(tabs.getSelected(), 'toggleDevTools')
    })

    ipc.on('openEditor', function () {
      tabEditor.show(tabs.getSelected())
    })

    /* agent bridge (browser_tab_select / browser_tab_open): selecting a tab has
     * to go through the RENDERER, because the renderer owns view visibility
     * (viewManager.setView only attaches; a placeholder - edit mode, overlay,
     * password viewer - keeps the previous view on screen until the renderer
     * hides it). Attaching in main alone left a tab "selected" in state while
     * every page-level command still saw the previous document. */
    ipc.on('agentSelectTab', function (e, data) {
      var id = data && data.id
      if (!id || !tabs.get(id)) {
        return
      }
      browserUI.switchToTab(id, { focusWebview: true })
      /* switchToTab runs synchronously, but the main process also attaches the
       * view on its own path. Re-assert visibility on the next turn so a late
       * attach cannot leave the previous view in front (measured: a renderer
       * switch followed by a main-process attach left tab A displayed while B
       * was selected). Idempotent: setSelected on an already-shown tab is a
       * no-op apart from a bounds sync. */
      setTimeout(function () {
        if (!tabs.get(id)) return
        webviews.setSelected(id, { focus: true })
      }, 60)
    })

    ipc.on('showBookmarks', function () {
      tabEditor.show(tabs.getSelected(), '!bookmarks ')
    })

    ipc.on('showHistory', function () {
      tabEditor.show(tabs.getSelected(), '!history ')
    })

    ipc.on('addTab', function (e, data) {
      /* new tabs can't be created in modal mode */
      if (modalMode.enabled()) {
        return
      }

      /* new tabs can't be created in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      var newTab = tabs.add({
        url: data.url || ''
      })

      browserUI.addTab(newTab, {
        enterEditMode: !data.url, // only enter edit mode if the new tab is empty
        /* agent bridge (browser_tab_open background:true): create the tab
         * without switching to it. Without this the renderer always performs
         * the full switch, so a "background" open replaced the user's view. */
        openInBackground: data.background === true
      })
    })

    ipc.on('saveCurrentPage', async function () {
      var currentTab = tabs.get(tabs.getSelected())

      // new tabs cannot be saved
      if (!currentTab.url) {
        return
      }

      // if the current tab is a PDF, let the PDF viewer handle saving the document
      if (PDFViewer.isPDFViewer(tabs.getSelected())) {
        PDFViewer.savePDF(tabs.getSelected())
        return
      }

      if (tabs.get(tabs.getSelected()).isFileView) {
        webviews.callAsync(tabs.getSelected(), 'downloadURL', [tabs.get(tabs.getSelected()).url])
      } else {
        var savePath = await ipc.invoke('showSaveDialog', {
          defaultPath: currentTab.title.replace(/[/\\]/g, '_')
        })

        // savePath will be undefined if the save dialog is canceled
        if (savePath) {
          if (!savePath.endsWith('.html')) {
            savePath = savePath + '.html'
          }
          webviews.callAsync(tabs.getSelected(), 'savePage', [savePath, 'HTMLComplete'])
        }
      }
    })

    ipc.on('addPrivateTab', function () {
      /* new tabs can't be created in modal mode */
      if (modalMode.enabled()) {
        return
      }

      /* new tabs can't be created in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      browserUI.addTab(tabs.add({
        private: true
      }))
    })

    ipc.on('toggleTaskOverlay', function () {
      taskOverlay.toggle()
    })

    ipc.on('goBack', function () {
      webviews.callAsync(tabs.getSelected(), 'goBack')
    })

    ipc.on('goForward', function () {
      webviews.callAsync(tabs.getSelected(), 'goForward')
    })
  }
}
