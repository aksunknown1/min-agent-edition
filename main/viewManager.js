var viewMap = {} // id: view
var viewStateMap = {} // id: view state

var temporaryPopupViews = {} // id: view

// rate limit on "open in app" requests
var globalLaunchRequests = 0

function getDefaultViewWebPreferences () {
  return (
    {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      scrollBounce: true,
      safeDialogs: true,
      safeDialogsMessage: 'Prevent this page from creating additional dialogs',
      preload: __dirname + '/dist/preload.js',
      contextIsolation: true,
      sandbox: true,
      enableRemoteModule: false,
      allowPopups: false,
      // partition: partition || 'persist:webcontent',
      enableWebSQL: false,
      autoplayPolicy: (settings.get('enableAutoplay') ? 'no-user-gesture-required' : 'user-gesture-required'),
      // match Chrome's default for anti-fingerprinting purposes (Electron defaults to 0)
      minimumFontSize: 6,
      javascript: !(settings.get('filtering')?.contentTypes?.includes('script'))
    }
  )
}

function createView (existingViewId, id, webPreferences, boundsString, events) {
  if (viewStateMap[id]) {
    console.warn('Creating duplicate view')
  }

  const viewPrefs = Object.assign({}, getDefaultViewWebPreferences(), webPreferences)

  viewStateMap[id] = {
    loadedInitialURL: false,
    hasJS: viewPrefs.javascript // need this later to see if we should swap the view for a JS-enabled one
  }

  let view
  if (existingViewId) {
    view = temporaryPopupViews[existingViewId]
    delete temporaryPopupViews[existingViewId]

    // the initial URL has already been loaded, so set the background color
    view.setBackgroundColor('#fff')
    viewStateMap[id].loadedInitialURL = true
  } else {
    view = new WebContentsView({ webPreferences: viewPrefs })
  }

  events.forEach(function (event) {
    view.webContents.on(event, function (e) {
      var args = Array.prototype.slice.call(arguments).slice(1)

      const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

      if (!eventTarget) {
        // this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
        return
      }

      getWindowWebContents(eventTarget).send('view-event', {
        tabId: id,
        event: event,
        args: args
      })
    })
  })

  view.webContents.on('select-bluetooth-device', function (event, deviceList, callback) {
    event.preventDefault()
    callback('')
  })

  view.webContents.setWindowOpenHandler(function (details) {
    if (details.url && !filterPopups(details.url)) {
      return {
        action: 'deny'
      }
    }

    /*
      Opening a popup with window.open() generally requires features to be set
      So if there are no features, the event is most likely from clicking on a link, which should open a new tab.
      Clicking a link can still have a "new-window" or "foreground-tab" disposition depending on which keys are pressed
      when it is clicked.
      (https://github.com/minbrowser/min/issues/1835)
    */
    if (details.url && details.url !== 'about:blank' && !details.features) {
      const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

      getWindowWebContents(eventTarget).send('view-event', {
        tabId: id,
        event: 'new-tab',
        args: [details.url, !(details.disposition === 'background-tab')]
      })
      return {
        action: 'deny'
      }
    }

    return {
      action: 'allow',
      createWindow: function (options) {
        const view = new WebContentsView({ webPreferences: getDefaultViewWebPreferences(), webContents: options.webContents })

        var popupId = Math.random().toString()
        temporaryPopupViews[popupId] = view

        const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

        getWindowWebContents(eventTarget).send('view-event', {
          tabId: id,
          event: 'did-create-popup',
          args: [popupId, details.url]
        })

        return view.webContents
      }
    }
  })

  view.webContents.on('ipc-message', function (e, channel, data) {
    var senderURL
    try {
      senderURL = e.senderFrame.url
    } catch (err) {
      // https://github.com/minbrowser/min/issues/2052
      console.warn('dropping message because senderFrame is destroyed', channel, data, err)
      return
    }

    const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

    if (!eventTarget) {
      // this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
      return
    }

    getWindowWebContents(eventTarget).send('view-ipc', {
      id: id,
      name: channel,
      data: data,
      frameId: e.frameId,
      frameURL: senderURL
    })
  })

  // Open a login prompt when site asks for http authentication
  view.webContents.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
    if (authInfo.scheme !== 'basic') { // Only for basic auth
      return
    }
    event.preventDefault()
    var title = l('loginPromptTitle').replace('%h', authInfo.host)
    createPrompt({
      text: title,
      values: [{ placeholder: l('username'), id: 'username', type: 'text' },
        { placeholder: l('password'), id: 'password', type: 'password' }],
      ok: l('dialogConfirmButton'),
      cancel: l('dialogSkipButton'),
      width: 400,
      height: 200
    }, function (result) {
      // resend request with auth credentials
      callback(result.username, result.password)
    })
  })

  // show an "open in app" prompt for external protocols

  function handleExternalProtocol (e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
    var knownProtocols = ['http', 'https', 'file', 'min', 'about', 'data', 'javascript', 'chrome'] // TODO anything else?
    if (!knownProtocols.includes(url.split(':')[0])) {
      var externalApp = app.getApplicationNameForProtocol(url)
      if (externalApp) {
        var sanitizedName = externalApp.replace(/[^a-zA-Z0-9.]/g, '')
        if (globalLaunchRequests < 2) {
          globalLaunchRequests++
          setTimeout(function () {
            globalLaunchRequests--
          }, 20000)
          var result = electron.dialog.showMessageBoxSync({
            type: 'question',
            buttons: ['OK', 'Cancel'],
            message: l('openExternalApp').replace('%s', sanitizedName).replace(/\\/g, ''),
            detail: url.length > 160 ? url.substring(0, 160) + '...' : url
          })

          if (result === 0) {
            electron.shell.openExternal(url)
          }
        }
      }
    }
  }

  view.webContents.on('did-start-navigation', handleExternalProtocol)
  /*
  It's possible for an HTTP request to redirect to an external app link
  (primary use case for this is OAuth from desktop app > browser > back to app)
  and did-start-navigation isn't (always?) emitted for redirects, so we need this handler as well
  */
  view.webContents.on('will-redirect', handleExternalProtocol)

  /*
  the JS setting can only be set when the view is created, so swap the view on navigation if the setting value changed
  This can occur if the user manually changed the setting, or if we are navigating between an internal page (always gets JS)
  and an external one
  */
  view.webContents.on('did-start-navigation', function (event) {
    if (event.isMainFrame && !event.isSameDocument) {
      const hasJS = viewStateMap[id].hasJS
      const shouldHaveJS = (!(settings.get('filtering')?.contentTypes?.includes('script'))) || event.url.startsWith('min://')
      if (hasJS !== shouldHaveJS) {
        setTimeout(function () {
          view.webContents.stop()
          const currentWindow = getWindowFromViewContents(view.webContents)
          destroyView(id)
          const newView = createView(existingViewId, id, Object.assign({}, webPreferences, { javascript: shouldHaveJS }), boundsString, events)
          loadURLInView(id, event.url, currentWindow)

          if (currentWindow) {
            setView(id, getWindowWebContents(currentWindow))
            focusView(id)
          }
        }, 0)
      }
    }
  })

  view.setBounds(JSON.parse(boundsString))

  viewMap[id] = view

  return view
}

function destroyView (id) {
  if (!viewMap[id]) {
    return
  }

  windows.getAll().forEach(function (window) {
    if (windows.getState(window).selectedView === id) {
      window.getContentView().removeChildView(viewMap[id])
      windows.getState(window).selectedView = null
    }
  })
  viewMap[id].webContents.destroy()

  delete viewMap[id]
  delete viewStateMap[id]
}

function destroyAllViews () {
  for (const id in viewMap) {
    destroyView(id)
  }
}

function setView (id, senderContents) {
  const win = windows.windowFromContents(senderContents).win

  // changing views can cause flickering, so we only want to call it if the view is actually changing
  // see https://github.com/minbrowser/min/issues/1966
  if (windows.getState(win).selectedView !== viewMap[id]) {
    // remove all prior views
    win.getContentView().children.slice(1).forEach(child => win.getContentView().removeChildView(child))
    if (viewStateMap[id].loadedInitialURL) {
      win.getContentView().addChildView(viewMap[id])
    } else {
      win.getContentView().removeChildView(viewMap[id])
    }
    windows.getState(win).selectedView = id
  }
}

function setBounds (id, bounds) {
  if (viewMap[id]) {
    viewMap[id].setBounds(bounds)
  }
}

function focusView (id) {
  // empty views can't be focused because they won't propogate keyboard events correctly, see https://github.com/minbrowser/min/issues/616
  // also, make sure the view exists, since it might not if the app is shutting down
  if (viewMap[id] && (viewMap[id].webContents.getURL() !== '' || viewMap[id].webContents.isLoading())) {
    viewMap[id].webContents.focus()
    return true
  } else if (getWindowFromViewContents(viewMap[id]?.webContents)) {
    getWindowWebContents(getWindowFromViewContents(viewMap[id]?.webContents)).focus()
    return true
  }
}

function hideCurrentView (senderContents) {
  const win = windows.windowFromContents(senderContents).win
  const currentId = windows.getState(win).selectedView
  if (currentId) {
    win.getContentView().removeChildView(viewMap[currentId])
    windows.getState(win).selectedView = null
    if (win.isFocused()) {
      getWindowWebContents(win).focus()
    }
  }
}

function getView (id) {
  return viewMap[id]
}

function getTabIDFromWebContents (contents) {
  for (var id in viewMap) {
    if (viewMap[id].webContents === contents) {
      return id
    }
  }
}

function getWindowFromViewContents (webContents) {
  const viewId = Object.keys(viewMap).find(id => viewMap[id].webContents === webContents)
  return windows.getAll().find(win => windows.getState(win).selectedView === viewId)
}

ipc.on('createView', function (e, args) {
  createView(args.existingViewId, args.id, args.webPreferences, args.boundsString, args.events)
})

ipc.on('destroyView', function (e, id) {
  destroyView(id)
})

ipc.on('destroyAllViews', function () {
  destroyAllViews()
})

ipc.on('setView', function (e, args) {
  setView(args.id, e.sender)
  setBounds(args.id, args.bounds)
  if (args.focus && BrowserWindow.fromWebContents(e.sender) && BrowserWindow.fromWebContents(e.sender).isFocused()) {
    const couldFocus = focusView(args.id)
    if (!couldFocus) {
      e.sender.focus()
    }
  }
})

ipc.on('setBounds', function (e, args) {
  setBounds(args.id, args.bounds)
})

ipc.on('focusView', function (e, id) {
  focusView(id)
})

ipc.on('hideCurrentView', function (e) {
  hideCurrentView(e.sender)
})

function loadURLInView (id, url, win) {
  // wait until the first URL is loaded to set the background color so that new tabs can use a custom background
  if (!viewStateMap[id].loadedInitialURL) {
    // Give the site a chance to display something before setting the background, in case it has its own dark theme
    viewMap[id].webContents.once('dom-ready', function () {
      viewMap[id].setBackgroundColor('#fff')
    })
    // If the view has no URL, it won't be attached yet
    if (win && id === windows.getState(win).selectedView) {
      win.getContentView().addChildView(viewMap[id])
    }
  }
  viewMap[id].webContents.loadURL(url)
  viewStateMap[id].loadedInitialURL = true
}

ipc.on('loadURLInView', function (e, args) {
  const win = windows.windowFromContents(e.sender)?.win
  loadURLInView(args.id, args.url, win)
})

ipc.on('callViewMethod', function (e, data) {
  var error, result
  try {
    var webContents = viewMap[data.id].webContents
    var methodOrProp = webContents[data.method]
    if (methodOrProp instanceof Function) {
      // call function
      result = methodOrProp.apply(webContents, data.args)
    } else {
      // set property
      if (data.args && data.args.length > 0) {
        webContents[data.method] = data.args[0]
      }
      // read property
      result = methodOrProp
    }
  } catch (e) {
    error = e
  }
  if (result instanceof Promise) {
    result.then(function (result) {
      if (data.callId) {
        e.sender.send('async-call-result', { callId: data.callId, error: null, result })
      }
    })
    result.catch(function (error) {
      if (data.callId) {
        e.sender.send('async-call-result', { callId: data.callId, error, result: null })
      }
    })
  } else if (data.callId) {
    e.sender.send('async-call-result', { callId: data.callId, error, result })
  }
})

ipc.handle('getNavigationHistory', function (e, id) {
  if (!viewMap[id]?.webContents) {
    return null
  }
  const entries = []
  const activeIndex = viewMap[id].webContents.navigationHistory.getActiveIndex()
  const size = viewMap[id].webContents.navigationHistory.length()

  for (let i = 0; i < size; i++) {
    entries.push(viewMap[id].webContents.navigationHistory.getEntryAtIndex(i))
  }

  return {
    activeIndex,
    entries
  }
})

/* Electron 43 rejects capturePage() for hidden, minimised, detached and
 * never-attached views instead of resolving a zero-size image
 * (docs/capture-page-probe.json), so a missing rejection handler here becomes
 * an unhandled promise rejection. Rejections are dropped rather than forwarded:
 * the renderer's captureData handler (js/webviews.js:517) consumes only
 * { id, url } and has no error channel, and an empty data URL would be treated
 * as a real preview. Nothing page-derived is logged - only a fixed category. */
var captureUnavailableCount = 0
function handleCaptureRejection () {
  captureUnavailableCount++
  /* Rate-limited: tab previews can retry hidden views many times a session. */
  if (captureUnavailableCount <= 5 || captureUnavailableCount % 50 === 0) {
    console.warn('[capture]', 'CAPTURE_UNAVAILABLE', 'count=' + captureUnavailableCount)
  }
}

/* P0-08: capturePage() called in the same tick after a view is removed from
 * its window's view tree deadlocks this Electron build (D2 in
 * docs/detach-probe.json - no exception, no exit event, no done marker). Views
 * reach that state through hideCurrentView on every tab switch, so a preview
 * request arriving in the same tick as a switch would hang Min for real. The
 * guard turns that case into the existing CAPTURE_UNAVAILABLE path instead of
 * the native hang. Views the guard cannot assess are treated as attached, so
 * behaviour can only ever tighten, never break. */
function isViewAttachedToAnyWindow (view) {
  try {
    return windows.openWindows.some(function (entry) {
      return !entry.closed && entry.win && !entry.win.isDestroyed() &&
        entry.win.getContentView().children.indexOf(view) !== -1
    })
  } catch (e) {
    return true
  }
}

ipc.on('getCapture', function (e, data) {
  var view = viewMap[data.id]
  if (!view) {
    // view could have been destroyed
    return
  }

  if (!isViewAttachedToAnyWindow(view)) {
    handleCaptureRejection()
    return
  }

  view.webContents.capturePage().then(function (img) {
    var size = img.getSize()
    if (size.width === 0 && size.height === 0) {
      return
    }
    img = img.resize({ width: data.width, height: data.height })
    e.sender.send('captureData', { id: data.id, url: img.toDataURL() })
  }).catch(handleCaptureRejection)
})

ipc.on('saveViewCapture', function (e, data) {
  var view = viewMap[data.id]
  if (!view) {
    // view could have been destroyed
  }

  if (!isViewAttachedToAnyWindow(view)) {
    handleCaptureRejection()
    return
  }

  view.webContents.capturePage().then(function (image) {
    view.webContents.downloadURL(image.toDataURL())
  }).catch(handleCaptureRejection)
})

global.getView = getView

/* P0-07 verification probe only. Development-only and off by default: requires
 * BOTH --development-mode and settings.experimentalCaptureProbe === true, so a
 * packaged build can never enable it. It registers no commands and changes no
 * behaviour; it calls capturePage() three times so the hardening above can be
 * observed inside Min and not only in the standalone fixture:
 *   - a never-attached WebContentsView, expected to resolve zero-size (the case
 *     Min's original guard covers);
 *   - the current tab's view after being detached from the window's view tree
 *     exactly as hideCurrentView does - the state every non-selected tab view
 *     is in, expected to reject (the case the new .catch covers), then restored;
 *   - the current visible tab, which must still resolve.
 * Emits [capture-probe] lines on stdout; no page content or URLs are logged. */
function captureProbeLog (label) {
  console.log('[capture-probe]', label)
}

app.once('ready', function () {
  if (!isDevelopmentMode || settings.get('experimentalCaptureProbe') !== true) {
    return
  }

  setTimeout(function () {
    var hidden = new WebContentsView({ webPreferences: { sandbox: true } })
    hidden.webContents.loadURL('data:text/html,<title>capture-probe-hidden</title><body style="margin:0;background:rgb(251,191,36)"></body>')
      .then(function () {
        return hidden.webContents.capturePage()
      })
      .then(function (img) {
        captureProbeLog('NEVER_ATTACHED_CAPTURE_RESOLVED ' + JSON.stringify(img.getSize()))
      })
      .catch(function () {
        captureProbeLog('CAPTURE_UNAVAILABLE')
      })
  }, 6000)

  /* The detached-background-view case. A single-tab launch still has one: Min
   * keeps a non-selected background view (restore/new-tab), and every
   * non-selected tab view sits detached from the view tree exactly as
   * hideCurrentView leaves it - the state a real tab-preview capture of a
   * background tab would hit. Detaching the selected view ourselves is
   * deliberately avoided: that was observed to crash Min mid-flight (see
   * P0-07 addendum). */
  setTimeout(function () {
    try {
      var probeWin = windows.getCurrent()
      var probeSelected = probeWin && windows.getState(probeWin).selectedView
      var backgroundId = null
      Object.keys(viewMap).forEach(function (id) {
        if (!backgroundId && id !== probeSelected && viewMap[id] && viewMap[id].webContents && !viewMap[id].webContents.isDestroyed()) {
          backgroundId = id
        }
      })
      if (!backgroundId) {
        captureProbeLog('BACKGROUND_NONE single view only')
        return
      }
      viewMap[backgroundId].webContents.capturePage()
        .then(function (img) {
          captureProbeLog('BACKGROUND_CAPTURE_RESOLVED ' + JSON.stringify(img.getSize()))
        })
        .catch(function () {
          captureProbeLog('CAPTURE_UNAVAILABLE')
        })
    } catch (e) {
      captureProbeLog('BACKGROUND_CASE_ERROR')
    }
  }, 9000)

  setTimeout(function () {
    try {
      var win = windows.getCurrent()
      var id = win && windows.getState(win).selectedView
      var view = id && viewMap[id]
      if (!view || !view.webContents || view.webContents.isDestroyed()) {
        captureProbeLog('VISIBLE_CASE_SKIPPED no view')
        return
      }
      view.webContents.capturePage()
        .then(function (img) {
          captureProbeLog('VISIBLE_CAPTURE_OK ' + JSON.stringify(img.getSize()))
        })
        .catch(function () {
          captureProbeLog('CAPTURE_UNAVAILABLE')
        })
    } catch (e) {
      captureProbeLog('VISIBLE_CASE_ERROR')
    }
  }, 12000)
})

/* P0-08 detach-crash probe. Development-only: requires BOTH --development-mode
 * and the literal launch argument --probe-detach, so it is never persisted and
 * a packaged build cannot enable it. Reproduces the P0-07 crash sequence
 * deterministically under instrumentation; registers no commands and changes
 * no product behaviour. Scenarios (one per launch):
 *   D0  capture the selected view while still attached   (baseline)
 *   D1  detach the selected view, wait 4s, reattach      (detach alone)
 *   D2  detach the selected view, capturePage same tick  (the crash sequence)
 *   D3  capture an already-detached background view      (known good)
 * Emits [detach-probe] markers; a crash is visible as a missing DONE marker
 * plus process/child/render event lines from the handlers below. */
function detachProbeLog (label) {
  console.log('[detach-probe]', label)
}

app.on('ready', function () {
  if (!isDevelopmentMode || !process.argv.some(function (a) { return a === '--probe-detach' })) {
    return
  }
  var scnArg = process.argv.filter(function (a) { return a.indexOf('--probe-detach-scenario=') === 0 })[0]
  var scnMatch = /^--probe-detach-scenario=(\w+)$/.exec(scnArg || '')
  var scn = scnMatch ? scnMatch[1] : 'D1'

  process.on('uncaughtException', function (e) {
    detachProbeLog('UNCAUGHT_EXCEPTION ' + (e && e.message ? String(e.message).slice(0, 160) : 'unknown'))
  })
  process.on('unhandledRejection', function (r) {
    detachProbeLog('UNHANDLED_REJECTION ' + (r && r.message ? String(r.message).slice(0, 160) : String(r)))
  })
  app.on('web-contents-created', function (e, wc) {
    wc.on('render-process-gone', function (e2, details) {
      detachProbeLog('RENDER_PROCESS_GONE ' + JSON.stringify(details))
    })
  })
  app.on('child-process-gone', function (e, details) {
    detachProbeLog('CHILD_PROCESS_GONE ' + JSON.stringify(details))
  })

  detachProbeLog('ARMED scenario=' + scn)

  setTimeout(function () {
    try {
      var probeWin = windows.getCurrent()
      var selectedId = probeWin && windows.getState(probeWin).selectedView
      var selectedView = selectedId && viewMap[selectedId]
      if (!selectedView || !selectedView.webContents || selectedView.webContents.isDestroyed()) {
        detachProbeLog('NO-VIEW')
        detachProbeLog('DONE ' + scn)
        return
      }

      if (scn === 'D0') {
        selectedView.webContents.capturePage()
          .then(function (img) {
            detachProbeLog('D0-CAPTURE-WHILE-ATTACHED ' + JSON.stringify(img.getSize()))
            detachProbeLog('DONE ' + scn)
          })
          .catch(function () {
            detachProbeLog('CAPTURE_UNAVAILABLE')
            detachProbeLog('DONE ' + scn)
          })
        return
      }

      if (scn === 'D3') {
        var bgId = null
        Object.keys(viewMap).forEach(function (vid) {
          if (!bgId && vid !== selectedId && viewMap[vid] && viewMap[vid].webContents && !viewMap[vid].webContents.isDestroyed()) {
            bgId = vid
          }
        })
        if (!bgId) {
          detachProbeLog('D3-NO-BACKGROUND-VIEW')
          detachProbeLog('DONE ' + scn)
          return
        }
        viewMap[bgId].webContents.capturePage()
          .then(function (img) {
            detachProbeLog('D3-BACKGROUND-CAPTURE-RESOLVED ' + JSON.stringify(img.getSize()))
            detachProbeLog('DONE ' + scn)
          })
          .catch(function () {
            detachProbeLog('CAPTURE_UNAVAILABLE')
            detachProbeLog('DONE ' + scn)
          })
        return
      }

      /* D1 and D2 detach the SELECTED view, exactly as hideCurrentView does. */
      var savedBounds = selectedView.getBounds()
      probeWin.getContentView().removeChildView(selectedView)
      detachProbeLog(scn + '-DETACHED selectedView=' + selectedId)

      var reattach = function () {
        probeWin.getContentView().addChildView(selectedView)
        selectedView.setBounds(savedBounds)
        detachProbeLog(scn + '-REATTACHED')
        detachProbeLog('DONE ' + scn)
      }

      if (scn === 'D1') {
        setTimeout(function () {
          detachProbeLog('D1-STILL-ALIVE-4S-NO-CAPTURE')
          reattach()
        }, 4000)
        return
      }

      if (scn === 'D2') {
        selectedView.webContents.capturePage()
          .then(function (img) {
            detachProbeLog('D2-CAPTURE-RESOLVED ' + JSON.stringify(img.getSize()))
            reattach()
          })
          .catch(function () {
            detachProbeLog('CAPTURE_UNAVAILABLE')
            reattach()
          })
        return
      }

      if (scn === 'G') {
        /* Exercise the product guard's own check in the exact state that hangs:
         * just detached, before compositor settle. The guard must report the
         * view as detached so getCapture/saveViewCapture never call
         * capturePage() here. */
        var guardVerdict = isViewAttachedToAnyWindow(selectedView)
        detachProbeLog('G-ATTACHMENT-CHECK ' + guardVerdict)
        detachProbeLog(guardVerdict ? 'G-GUARD-ALLOWS-CAPTURE-UNSAFE' : 'G-GUARD-BLOCKS-CAPTURE-EXPECTED')
        reattach()
        return
      }

      detachProbeLog('UNKNOWN-SCENARIO ' + scn)
      detachProbeLog('DONE ' + scn)
    } catch (e) {
      detachProbeLog('SCENARIO_ERROR ' + (e && e.message ? String(e.message).slice(0, 160) : String(e)))
      detachProbeLog('DONE ' + scn)
    }
  }, 5000)
})
