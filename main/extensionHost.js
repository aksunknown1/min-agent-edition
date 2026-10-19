/* P0-03 experimental extension host. Development-only and gated off by default.

 * This is a feasibility probe, not an extension manager. It loads exactly two
 * hard-coded paths - the in-repo test fixtures - and nothing else. There is no
 * install/remove path for a user, no CRX handling, no store integration, and no
 * way for a setting to point this at an arbitrary directory.

 * Gating: requires BOTH --development-mode AND the persisted setting
 * experimentalExtensionHost === true. A production build can never enable it,
 * and the default (setting absent) leaves Min's behaviour completely unchanged.

 * Follows the shared-global style of main/*.js: no module.exports, and the
 * electron/session/path/fs/isDevelopmentMode globals come from main/main.js,
 * which is concatenated before this file in scripts/buildMain.js.
 */

var EXTENSION_HOST_LOG_PREFIX = '[extension-host]'

/* Sessions we have already started a load for, so one session never loads twice. */
var extensionHostSessions = new Set()
/* session -> Set of fixture indices already attempted. A WeakMap keyed on the
 * session object, because String(session) is not unique across sessions. */
var extensionHostSlots = new WeakMap()

/* Electron's Session object exposes no .partition property, so label sessions
 * ourselves; otherwise every session logs as the default one. */
var extensionHostLabels = new WeakMap()

function extensionHostLabel (ses) {
  if (extensionHostLabels.has(ses)) {
    return extensionHostLabels.get(ses)
  }
  return (ses === session.defaultSession) ? 'default' : 'session-created'
}

function extensionHostEnabled () {
  return isDevelopmentMode && settings.get('experimentalExtensionHost') === true
}

/* Hard-coded list: never derived from a setting, a download, or a store. */
function extensionHostFixturePaths () {
  return [
    path.join(__dirname, 'extensions', 'test-min-agent-extension'),
    path.join(__dirname, 'extensions', 'test-min-agent-docstart'),
    path.join(__dirname, '..', '..', 'extensions', 'real', 'darkreader')
  ]
}

function extensionHostLog () {
  var args = [EXTENSION_HOST_LOG_PREFIX].concat(Array.prototype.slice.call(arguments))
  console.log.apply(console, args)
}

function logExtensionHostExtensions (label, ses) {
  try {
    var all = ses.extensions.getAllExtensions()
    extensionHostLog(label, 'count=' + all.length, 'ids=' + (all.map(function (ext) { return ext.id }).join(',') || 'none'))
  } catch (e) {
    extensionHostLog(label, 'getAllExtensions failed:', e.message)
  }
}

function registerExtensionHost (ses) {
  if (!extensionHostEnabled()) {
    return
  }

  if (!ses || !ses.extensions || typeof ses.extensions.loadExtension !== 'function') {
    extensionHostLog('ses.extensions.loadExtension is unavailable in this Electron runtime')
    return
  }

  if (extensionHostSessions.has(ses)) {
    return
  }
  extensionHostSessions.add(ses)

  /* One load attempt per (session, fixture). A rejected fixture must not block
   * the others, and must never be retried with weaker flags. */
  var fixturePaths = extensionHostFixturePaths()

  fixturePaths.forEach(function (fixturePath, index) {
    var slots = extensionHostSlots.get(ses)
    if (!slots) {
      slots = new Set()
      extensionHostSlots.set(ses, slots)
    }
    if (slots.has(index)) {
      return
    }
    slots.add(index)

    try {
      if (!fs.existsSync(path.join(fixturePath, 'manifest.json'))) {
        extensionHostLog('fixture manifest missing at', fixturePath)
        return
      }

      extensionHostLog('loading fixture into session', extensionHostLabel(ses), path.basename(fixturePath))

      ses.extensions.loadExtension(fixturePath, { allowFileAccess: false })
        .then(function (ext) {
          extensionHostLog('loaded:', 'name=' + ext.name, 'id=' + ext.id, 'session=' + extensionHostLabel(ses))
          logExtensionHostExtensions('after load [' + extensionHostLabel(ses) + ']', ses)
        })
        .catch(function (err) {
          slots.delete(index)
          extensionHostLog('loadExtension rejected:', path.basename(fixturePath), err && err.message ? err.message : err)
        })
    } catch (e) {
      slots.delete(index)
      extensionHostLog('loadExtension threw:', path.basename(fixturePath), e.message)
    }
  })
}

/* P0-05 probe only: when set to a positive number of milliseconds (and the host
 * gate is already on), remove every loaded extension from the tab session once,
 * after that delay. Used to measure whether mid-session unload works without a
 * restart. Never enabled by default and never reachable outside dev mode. */
function extensionHostRemoveProbeDelay () {
  var value = settings.get('experimentalExtensionRemoveProbe')
  return (typeof value === 'number' && value > 0) ? value : null
}

function removeLoadedExtensionsFromSession (ses, label) {
  try {
    logExtensionHostExtensions('before remove [' + label + ']', ses)
    var exts = ses.extensions.getAllExtensions()
    exts.forEach(function (ext) {
      try {
        var result = ses.extensions.removeExtension(ext.id)
        if (result && typeof result.then === 'function') {
          result.then(function () {
            extensionHostLog('removed:', ext.name, ext.id, label)
            logExtensionHostExtensions('after remove [' + label + ']', ses)
          }).catch(function (err) {
            extensionHostLog('removeExtension rejected:', ext.id, err && err.message ? err.message : err)
          })
        } else {
          extensionHostLog('removed:', ext.name, ext.id, label)
          logExtensionHostExtensions('after remove [' + label + ']', ses)
        }
      } catch (e) {
        extensionHostLog('removeExtension threw:', ext.id, e.message)
      }
    })
  } catch (e) {
    extensionHostLog('getAllExtensions failed before remove:', e.message)
  }
}

/* Same registration path the blocker already uses, so every session is covered:
 * the default session plus each persist:* partition Min creates for tab views. */
app.on('session-created', function (ses) {
  registerExtensionHost(ses)
})

app.on('ready', function () {
  if (!extensionHostEnabled()) {
    return
  }

  registerExtensionHost(session.defaultSession)

  /* Min's tab views live in this partition (js/webviews.js:201). Touching it
   * here starts the load before the renderer asks for the first view, otherwise
   * the first document of the first tab can beat extension registration and
   * miss its content scripts. */
  var tabSession = session.fromPartition('persist:webcontent')
  extensionHostLabels.set(tabSession, 'persist:webcontent')
  registerExtensionHost(tabSession)

  logExtensionHostExtensions('after app ready', session.defaultSession)

  var removeDelay = extensionHostRemoveProbeDelay()
  if (removeDelay) {
    extensionHostLog('remove probe scheduled in', removeDelay, 'ms')
    setTimeout(function () {
      removeLoadedExtensionsFromSession(tabSession, 'persist:webcontent')
    }, removeDelay)
  }
})
