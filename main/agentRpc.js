/* Phase 1 agent-control bridge - transport + status/tabs only.

 * Design authority: docs/PHASE1-DESIGN.md. Implemented sections: 2 (transport),
 * 3 (auth), 4 (envelope/errors), and the browser_status / browser_tabs commands
 * of 5. Deliberately NOT implemented here: snapshot, click, type, press,
 * screenshot, and anything that touches page content. There is no
 * executeJavaScript, no callViewMethod routing, no debugger/CDP, no fs access
 * from a request value, and no navigation.

 * Enabling: the literal command-line argument --agent-rpc, matching the existing
 * --development-mode / --debug-browser pattern (main/main.js:35-36). It is never
 * enabled by a persisted setting, so a network listener can never appear without
 * an explicit launch decision. --agent-rpc contains no "://" and is not preceded
 * by -s, so handleCommandLineArguments (main/main.js:131) ignores it.

 * Follows the shared-global style of main/*.js: no module.exports. Globals used:
 * app, settings, windows, viewMap, userDataPath, isDevelopmentMode.
 */

const agentRpcHttp = require('http')
const agentRpcCrypto = require('crypto')
const agentRpcFs = require('fs')
const agentRpcPath = require('path')

const AGENT_RPC_MAX_BODY_BYTES = 64 * 1024
const AGENT_RPC_MAX_URL_CHARS = 300
const AGENT_RPC_MAX_TITLE_CHARS = 200
const AGENT_RPC_MAX_REQUESTS_PER_SECOND = 40
const AGENT_RPC_MAX_AUTH_FAILURES = 10
const AGENT_RPC_AUTH_COOLDOWN_MS = 15000
const AGENT_RPC_DISCOVERY_FILE = 'agent-rpc.json'

/* Closed set. An unknown method is never proxied to anything. */
const AGENT_RPC_METHODS = ["browser_batch","browser_check","browser_click","browser_content","browser_download_cancel","browser_download_pause","browser_download_resume","browser_download_start","browser_download_wait","browser_downloads","browser_grant","browser_hover","browser_mouse","browser_navigate","browser_predict","browser_press","browser_screenshot","browser_scroll","browser_select","browser_snapshot","browser_state","browser_status","browser_tab_close","browser_tab_open","browser_tab_select","browser_tabs","browser_transform","browser_transform_status","browser_type","browser_verify","browser_wait"]/* P1-06: 31 methods */

/* Per-method parameter schemas (P0-09/P0-10). Everything not listed is
 * rejected for that method; fields declared here are validated by
 * type/pattern/enum/bounds before any handler runs. */
const AGENT_RPC_TYPE_TEXT_MAX = 1000
const AGENT_RPC_PARAM_SCHEMAS = {
  browser_status: {},
  browser_tabs: {},
  browser_snapshot: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    format: { type: 'string', required: false, enum: ['json', 'text'] },
    maxNodes: { type: 'number', required: false, min: 1, max: 1000, integer: true }
  },
  browser_click: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ }
  },
  browser_type: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ },
    /* No control characters: input events cannot represent them and they are
     * a common injection carrier. Checked without a regex (see validator). */
    text: { type: 'string', required: true, maxLength: AGENT_RPC_TYPE_TEXT_MAX, noControl: true }
  },
  browser_navigate: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    /* Scheme policy is enforced against the parsed URL in the command
     * (javascript:/data:/vbscript: never pass); here only length + control. */
    url: { type: 'string', required: true, maxLength: 2048, noControl: true },
    /* P1-01B: settle event. Default 'load' (did-finish-load). */
    waitUntil: { type: 'string', required: false, enum: ['load', 'domcontentloaded'] },
    /* P1-01B: require the FINAL URL (after the stability window) to start
     * with this prefix. Max 300 chars, no control characters. */
    expectUrlPrefix: { type: 'string', required: false, maxLength: 300, noControl: true },
    /* P1-01B: bounded post-settle URL-stability window. The URL must stay
     * unchanged for this long after the load event before the navigation is
     * reported verified; the window RESETS whenever the URL changes, so
     * delayed redirects and SPA pushState route changes are detected. */
    stabilityWindowMs: { type: 'number', required: false, integer: true, min: 0, max: 15000 }
  },
  browser_press: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    /* Closed enum, case-sensitive, no chords or modifiers in this task. */
    key: { type: 'string', required: true, enum: ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete'] }
  },
  browser_screenshot: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    /* P1-06: optional encoding/size controls. maxWidth/maxHeight downscale the
     * image with aspect ratio preserved. */
    format: { type: 'string', required: false, enum: ['png', 'jpeg'] },
    quality: { type: 'number', required: false, min: 1, max: 100, integer: true },
    maxWidth: { type: 'number', required: false, min: 16, max: 4096, integer: true },
    maxHeight: { type: 'number', required: false, min: 16, max: 4096, integer: true }
  },
  browser_mouse: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    action: { type: 'string', required: true, enum: ['move', 'hover', 'down', 'up', 'click', 'rightClick', 'scroll', 'movePath', 'drag', 'status'] },
    x: { type: 'number', required: false, min: 0, max: 20000, integer: true },
    y: { type: 'number', required: false, min: 0, max: 20000, integer: true },
    toX: { type: 'number', required: false, min: 0, max: 20000, integer: true },
    toY: { type: 'number', required: false, min: 0, max: 20000, integer: true },
    fromX: { type: 'number', required: false, min: 0, max: 20000, integer: true },
    fromY: { type: 'number', required: false, min: 0, max: 20000, integer: true },
    button: { type: 'string', required: false, enum: ['left', 'right', 'middle'] },
    durationMs: { type: 'number', required: false, min: 16, max: 5000, integer: true },
    mode: { type: 'string', required: false, enum: ['smooth', 'instant'] },
    steps: { type: 'number', required: false, min: 2, max: 240, integer: true },
    deltaX: { type: 'number', required: false, min: -10000, max: 10000, integer: true },
    deltaY: { type: 'number', required: false, min: -10000, max: 10000, integer: true },
    screenshotId: { type: 'string', required: false, pattern: /^ss[0-9]{1,12}$/ }
  },
  browser_tab_open: {
    url: { type: 'string', required: false, maxLength: 2048, noControl: true },
    background: { type: 'boolean', required: false }
  },
  browser_tab_select: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ }
  },
  browser_tab_close: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ }
  },
  browser_grant: {
    action: { type: 'string', required: true, enum: ['risky_click', 'sensitive_type'] },
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: false, pattern: /^r[0-9a-z]{1,12}$/ },
    ttlSeconds: { type: 'number', required: false, integer: true, min: 30, max: 300 }
  },
  /* P1-00A.1: schemas for the P1-01 Stage-2 primitives. Before this block
   * these methods rejected ALL params at the transport layer (no schema entry
   * meant every key was "unknown or unsupported parameter"). */
  browser_content: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    maxChars: { type: 'number', required: false, integer: true, min: 1000, max: 50000 }
  },
  browser_hover: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ }
  },
  browser_scroll: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    x: { type: 'number', required: false, integer: true, min: -100000, max: 100000 },
    y: { type: 'number', required: false, integer: true, min: -100000, max: 100000 },
    to: { type: 'string', required: false, enum: ['top', 'bottom'] }
  },
  browser_select: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ },
    value: { type: 'string', required: true, maxLength: 300, noControl: true }
  },
  browser_check: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ },
    checked: { type: 'boolean', required: true }
  },
  browser_wait: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    until: { type: 'string', required: true, enum: ['network_idle', 'selector_visible'] },
    selector: { type: 'string', required: false, maxLength: 200, noControl: true },
    timeoutMs: { type: 'number', required: false, integer: true, min: 1000, max: 20000 }
  },
  browser_downloads: {},
  /* P1-05: agent-managed downloads. url is an http/https absolute URL
   * (deeper policy checks live in the command); relPath is a relative path
   * inside the approved agent download root; armMs arms tab-local adoption
   * of a page-triggered download. downloadId is the stable opaque
   * 'dlm<N>' printed by browser_download_start / browser_downloads. */
  browser_download_start: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    url: { type: 'string', required: false, maxLength: 2048 },
    relPath: { type: 'string', required: false, maxLength: 240 },
    armMs: { type: 'number', required: false, min: 1000, max: 120000, integer: true }
  },
  browser_download_wait: {
    downloadId: { type: 'string', required: true, pattern: /^dlm[0-9]{1,12}$/ },
    timeoutMs: { type: 'number', required: false, min: 100, max: 120000, integer: true }
  },
  browser_download_cancel: { downloadId: { type: 'string', required: true, pattern: /^dlm[0-9]{1,12}$/ } },
  browser_download_pause: { downloadId: { type: 'string', required: true, pattern: /^dlm[0-9]{1,12}$/ } },
  browser_download_resume: { downloadId: { type: 'string', required: true, pattern: /^dlm[0-9]{1,12}$/ } },
  /* P1-01E: state signals only (no page content; captcha/focus/in-flight).
   * tabId is optional at the bridge layer — it defaults to the selected tab
   * of the first live window; the MCP tool keeps it required. */
  browser_state: {
    tabId: { type: 'string', required: false, pattern: /^[0-9]{1,20}$/ }
  },
  /* P1-04: reversible rendered-page transformations (local session only).
   * actions = bounded JSON array; entries validated + identity-checked; per-
   * target results. See docs/P1-04-DESIGN.md. */
  browser_transform: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    actions: { type: 'string', required: true, maxLength: 24000, noControl: true }
  },
  browser_transform_status: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ }
  },
  /* P1-02: typed batch execution. actions is a JSON array string (the flat
   * param validator only handles scalars); every entry is re-validated with
   * the SAME per-method schemas the transport uses. browser_grant and
   * browser_batch are excluded — a batch cannot issue grants or nest. */
  /* P1-03: static prediction (never triggers the action) and cheap combined
   * post-action verification. */
  browser_predict: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ },
    action: { type: 'string', required: false, enum: ['click', 'type', 'check', 'select', 'press', 'hover'] }
  },
  browser_verify: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    urlPrefix: { type: 'string', required: false, maxLength: 300, noControl: true },
    selector: { type: 'string', required: false, maxLength: 200, noControl: true },
    textContains: { type: 'string', required: false, maxLength: 200, noControl: true }
  },
  browser_batch: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    actions: { type: 'string', required: true, maxLength: 24000, noControl: true }
  }
}

const AGENT_RPC_SNAPSHOT_DEFAULT_NODES = 200
const AGENT_RPC_SNAPSHOT_HARD_NODES = 1000
const AGENT_RPC_SNAPSHOT_NAME_MAX = 120
const AGENT_RPC_SNAPSHOT_BYTES = 256 * 1024
const AGENT_RPC_SNAPSHOT_TIMEOUT = 8000
const AGENT_RPC_REF_TTL_MS = 60000
const AGENT_RPC_REF_SWEEP_MS = 30000
/* P1-01B navigation verification. The stability window must cover delayed
 * redirects (Proton-class signup bounces land ~1-3s after the load event)
 * without adding unbounded latency; the window RESETS on every URL change
 * and is capped at 15s per request, so a worst-case navigate costs the load
 * time + window + (changes x poll granularity), never an unbounded wait. */
const AGENT_RPC_NAV_STABILITY_DEFAULT_MS = 1500
const AGENT_RPC_NAV_STABILITY_MAX_MS = 15000
const AGENT_RPC_NAV_PREFIX_WAIT_MS = 5000
const AGENT_RPC_NAV_POLL_MS = 250

const AGENT_RPC_ERRORS = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal: -32603,
  unauthorized: -32001,
  not_found: -32002,
  unsupported: -32004,
  blocked: -32005,
  timeout: -32006,
  busy: -32007,
  ref_expired: -32010,
  ambiguous: -32011,
  view_not_attached: -32012,
  sensitive_field: -32013,
  risky_action: -32014,
  disabled: -32015,
  ref_stale: -32016,
  ref_mismatch: -32017,
  load_failed: -32018,
  screenshot_too_large: -32019,
  last_tab: -32020,
  captcha_handoff_required: -32021
}

const agentRpcState = {
  server: null,
  host: null,
  port: 0,
  token: null,
  discoveryFile: null,
  startedAt: 0,
  requestCount: 0,
  rejectedCount: 0,
  authFailures: 0,
  cooldownUntil: 0,
  rateWindowStart: 0,
  rateWindowCount: 0
}

function agentRpcEnabledByArgv () {
  return process.argv.some(function (arg) { return arg === '--agent-rpc' })
}

function agentRpcLog () {
  /* Never pass headers, bodies, tokens or URLs here. Only fixed labels and counts. */
  const elapsed = ((Date.now() - (agentRpcState.startedAt || Date.now())) / 1000).toFixed(1)
  console.log.apply(console, ['[agent-rpc ' + elapsed + 's]'].concat(Array.prototype.slice.call(arguments)))
}

/* P1-00A diagnostic: detects main-thread blocking. setTimeout(0) on an idle
 * event loop fires within ~1ms; a large delay means the loop was blocked. */
function agentRpcHeartbeat (label) {
  const t0 = Date.now()
  setImmediate(function () {
    const lag = Date.now() - t0
    if (lag > 250) {
      agentRpcLog('MAIN-THREAD-LAG', label, lag + 'ms')
      setImmediate(function () {
        const lag2 = Date.now() - t0
        agentRpcLog('MAIN-THREAD-LAG-CONT', label, (Date.now() - t0 - lag) + 'ms after first sign')
      })
    }
  })
}

/* ---------- pure request validation (unit-testable, no Electron) ---------- */

function agentRpcConstantTimeEqual (a, b) {
  var bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8')
  var bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8')
  /* timingSafeEqual throws on length mismatch, and the length itself is not secret. */
  if (bufA.length !== bufB.length) {
    return false
  }
  try {
    return agentRpcCrypto.timingSafeEqual(bufA, bufB)
  } catch (e) {
    return false
  }
}

function agentRpcBearer (authHeader) {
  if (typeof authHeader !== 'string') {
    return null
  }
  var match = /^Bearer ([A-Za-z0-9]+)$/.exec(authHeader.trim())
  return match ? match[1] : null
}

/* Host must be exactly 127.0.0.1:<our port>. This is what blocks DNS rebinding:
 * a browser that resolves an attacker domain to loopback still sends the
 * attacker's Host header. */
function agentRpcHostAllowed (hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader === '') {
    return false
  }
  var h = hostHeader.trim().toLowerCase()
  return h === '127.0.0.1:' + port || h === 'localhost:' + port
}

/* A native local client sends neither header. Their presence means a browser
 * made this request, which is exactly the blind-CSRF / rebinding case. */
function agentRpcBrowserHeadersAllowed (headers) {
  if (headers.origin || headers['sec-fetch-site']) {
    return false
  }
  return true
}

function agentRpcJsonError (code, category, message, data) {
  return { code: code, category: category, message: message, data: data || null }
}

/* A structured error raised BY a command handler (as opposed to transport or
 * validation errors, which the request layer builds itself). Messages are
 * fixed strings — never page content. */
function agentRpcCommandError (code, category, message) {
  var err = agentRpcJsonError(code, category, message)
  err.agentRpcCommandError = true
  return err
}

var AGENT_RPC_COMMAND_HTTP_STATUS = {
  not_found: 404,
  ref_not_found: 404,
  blocked: 403,
  unsupported: 500,
  timeout: 504,
  ref_expired: 410,
  ambiguous: 409,
  view_not_attached: 409,
  invalid_params: 400,
  sensitive_field: 403,
  risky_action: 403,
  disabled: 409,
  ref_stale: 404,
  ref_mismatch: 404,
  load_failed: 502,
  screenshot_too_large: 413,
  last_tab: 409,
  captcha_handoff_required: 409
}

/* P0-13: purchase/payment-named clicks are still refused by default, but the
 * bypass is no longer a launch flag: the user pre-authorizes durable policy
 * (policy.json in the profile) or issues a single-use browser_grant at run
 * time. Unprompted risky actions stay blocked with no flag at all. */
var AGENT_RPC_RISKY_NAME = /(purchase|checkout|pay now|payment|place order|complete (order|purchase)|confirm (order|purchase|payment)|buy now|submit payment)/i

/* ---------- P0-13 intent-scoped single-use grants ----------
 * Issued only through browser_grant (explicit user instruction at the skill
 * layer). Bound to exact action + tabId (+ ref when given), single-use,
 * expired on use or TTL. Status carries the active COUNT only. */
var AGENT_RPC_GRANTS = []

function agentRpcPruneGrants () {
  var now = Date.now()
  AGENT_RPC_GRANTS = AGENT_RPC_GRANTS.filter(function (g) { return g.expires > now })
}

/* Drop the stored snapshot ref map for one tab (called on close, navigate,
 * and ref-sweep expiry). Sync map mutation; safe to call for unknown ids. */
function agentRpcClearSnapshotRefs (tabId) {
  try {
    if (AGENT_SNAPSHOT_REFS.has(tabId)) AGENT_SNAPSHOT_REFS.delete(tabId)
  } catch (e) { /* map already gone */ }
}

function agentRpcSweepSnapshotRefs () {
  AGENT_SNAPSHOT_SWEEP_RUNS++
  agentRpcPruneGrants()
  if (AGENT_SNAPSHOT_PENDING_DESTROYS.length > 0) {
    const pendingWc = AGENT_SNAPSHOT_PENDING_DESTROYS.shift()
    agentRpcLog('deferred destroy begin: pending=' + AGENT_SNAPSHOT_PENDING_DESTROYS.length)
    try { pendingWc.destroy() } catch (e) { /* already gone */ }
    agentRpcLog('deferred tab destroy: pending=' + AGENT_SNAPSHOT_PENDING_DESTROYS.length)
  }
  AGENT_SNAPSHOT_REFS.forEach(function (store, tabId) {
    var view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
    var dead = !view || !view.webContents || view.webContents.isDestroyed()
    var expired = Date.now() - store.born > AGENT_RPC_REF_TTL_MS
    if (dead || expired) {
      AGENT_SNAPSHOT_REFS.delete(tabId)
    }
  })
}

function agentRpcGrantsActive () {
  agentRpcPruneGrants()
  return AGENT_RPC_GRANTS.length
}

function agentRpcConsumeGrant (action, tabId, ref) {
  agentRpcPruneGrants()
  for (var i = 0; i < AGENT_RPC_GRANTS.length; i++) {
    var g = AGENT_RPC_GRANTS[i]
    var refOk = g.ref === undefined || g.ref === null || g.ref === ref
    if (g.action === action && g.tabId === String(tabId) && refOk) {
      AGENT_RPC_GRANTS.splice(i, 1)
      return true
    }
  }
  return false
}

/* ---------- P0-13 policy.json (durable per-profile defaults) ----------
 * Read per call from the profile (both userData spellings), so edits apply
 * without a restart. Shape:
 *   { "allowRiskyClicks": bool, "allowSensitiveTyping": bool, "allowedSchemes": [...] }
 * allowedSchemes can only RESTRICT the built-in protocol set (unknown schemes
 * are dropped). Defaults: deny both categories; built-in schemes apply. */
function agentRpcReadPolicy () {
  const defaults = { allowRiskyClicks: false, allowSensitiveTyping: false, allowedSchemes: null }
  const candidates = []
  try { candidates.push(userDataPath) } catch (e2) { /* not ready */ }
  try { candidates.push(String(userDataPath).replace(/-development$/, '')) } catch (e3) { /* ignore */ }
  for (let i = 0; i < candidates.length; i++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(candidates[i], 'policy.json'), 'utf8'))
      const out = {
        allowRiskyClicks: parsed.allowRiskyClicks === true,
        allowSensitiveTyping: parsed.allowSensitiveTyping === true,
        allowedSchemes: null
      }
      if (Array.isArray(parsed.allowedSchemes)) {
        out.allowedSchemes = parsed.allowedSchemes.map(function (s) {
          return String(s).toLowerCase().replace(/:+$/, '')
        })
      }
      return out
    } catch (e) { /* missing or unreadable: fall through */ }
  }
  return defaults
}

function agentRpcEffectiveProtocols () {
  const policy = agentRpcReadPolicy()
  if (!Array.isArray(policy.allowedSchemes) || policy.allowedSchemes.length === 0) {
    return AGENT_RPC_ALLOWED_PROTOCOLS
  }
  const eff = {}
  policy.allowedSchemes.forEach(function (s) {
    if (AGENT_RPC_ALLOWED_PROTOCOLS[s + ':']) eff[s + ':'] = 1
  })
  return eff
}

function agentRpcCommandGrant (params) {
  var view = typeof viewMap !== 'undefined' ? viewMap[params.tabId] : null
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view')
  }
  var ttl = params.ttlSeconds === undefined ? 120 : params.ttlSeconds
  agentRpcPruneGrants()
  AGENT_RPC_GRANTS.push({
    action: params.action,
    tabId: String(params.tabId),
    ref: params.ref,
    expires: Date.now() + ttl * 1000
  })
  /* category-only log: no ref, no page context. */
  agentRpcLog('grant issued:', params.action, 'active=' + agentRpcGrantsActive())
  return {
    granted: true,
    action: params.action,
    tabId: String(params.tabId),
    ttlSeconds: ttl,
    grantsActive: agentRpcGrantsActive()
  }
}

function agentRpcHasControlChars (s) {
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

/* Validates everything before any handler runs. Returns
 * { ok: true, request } or { ok: false, httpStatus, error }. */
function agentRpcValidate (meta, bodyText) {
  var headers = meta.headers || {}

  if (meta.method !== 'POST') {
    return { ok: false, httpStatus: 405, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_request, 'invalid_request', 'only POST is accepted') }
  }
  if (meta.url !== '/rpc') {
    return { ok: false, httpStatus: 404, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_request, 'invalid_request', 'no such endpoint') }
  }
  if (!agentRpcHostAllowed(headers.host, meta.port)) {
    return { ok: false, httpStatus: 403, error: agentRpcJsonError(AGENT_RPC_ERRORS.blocked, 'blocked', 'host not allowed') }
  }
  if (!agentRpcBrowserHeadersAllowed(headers)) {
    return { ok: false, httpStatus: 403, error: agentRpcJsonError(AGENT_RPC_ERRORS.blocked, 'blocked', 'cross-origin request rejected') }
  }

  var token = agentRpcBearer(headers.authorization)
  if (!token) {
    return { ok: false, httpStatus: 401, error: agentRpcJsonError(AGENT_RPC_ERRORS.unauthorized, 'unauthorized', 'missing or malformed bearer token') }
  }
  if (!agentRpcConstantTimeEqual(token, meta.expectedToken)) {
    return { ok: false, httpStatus: 401, error: agentRpcJsonError(AGENT_RPC_ERRORS.unauthorized, 'unauthorized', 'invalid token') }
  }

  var ctype = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (ctype !== 'application/json') {
    return { ok: false, httpStatus: 415, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_request, 'invalid_request', 'content-type must be application/json') }
  }

  var parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch (e) {
    return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.parse_error, 'invalid_request', 'request body is not valid JSON') }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_request, 'invalid_request', 'envelope must be an object') }
  }
  if (parsed.jsonrpc !== '2.0') {
    return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_request, 'invalid_request', 'jsonrpc must be "2.0"') }
  }
  if (typeof parsed.method !== 'string' || !/^[a-z_]{1,40}$/.test(parsed.method)) {
    return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_request, 'invalid_request', 'method must be a lowercase identifier') }
  }
  if (AGENT_RPC_METHODS.indexOf(parsed.method) === -1) {
    return { ok: false, httpStatus: 404, error: agentRpcJsonError(AGENT_RPC_ERRORS.method_not_found, 'method not found', 'method is not available') }
  }
  if (parsed.params === undefined || parsed.params === null) {
    parsed.params = {}
  } else if (typeof parsed.params !== 'object' || Array.isArray(parsed.params)) {
    return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'params must be an object') }
  }
  /* Per-method schema validation (P0-09). Unknown keys are rejected, not
   * ignored: a silently dropped key is how a typo becomes a security hole. */
  var paramSchema = AGENT_RPC_PARAM_SCHEMAS[parsed.method]
  for (var providedKey in parsed.params) {
    if (!Object.prototype.hasOwnProperty.call(parsed.params, providedKey)) continue
    if (!paramSchema || !paramSchema[providedKey]) {
      return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'unknown or unsupported parameter', { field: providedKey }) }
    }
  }
  for (var schemaField in paramSchema) {
    var rule = paramSchema[schemaField]
    var val = parsed.params[schemaField]
    if (val === null) {
      /* JSON has no NaN; a client serializing NaN (or sending null) gets an explicit rejection. */
      return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter must not be null', { field: schemaField }) }
    }
    if (val === undefined) {
      if (rule.required) {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'missing required parameter', { field: schemaField }) }
      }
      continue
    }
    if (rule.type === 'string') {
      if (typeof val !== 'string' || (rule.pattern && !rule.pattern.test(val))) {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter failed validation', { field: schemaField }) }
      }
      if (rule.enum && rule.enum.indexOf(val) === -1) {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter not one of the allowed values', { field: schemaField }) }
      }
      if (rule.maxLength && val.length > rule.maxLength) {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter too long', { field: schemaField }) }
      }
      if (rule.noControl && agentRpcHasControlChars(val)) {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter contains control characters', { field: schemaField }) }
      }
    } else if (rule.type === 'boolean') {
      if (typeof val !== 'boolean') {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter must be a boolean', { field: schemaField }) }
      }
    } else if (rule.type === 'number') {
      if (typeof val !== 'number' || !isFinite(val)) {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter must be a finite number', { field: schemaField }) }
      }
      if (rule.integer && Math.floor(val) !== val) {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter must be an integer', { field: schemaField }) }
      }
      if ((rule.min !== undefined && val < rule.min) || (rule.max !== undefined && val > rule.max)) {
        return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'parameter out of range', { field: schemaField }) }
      }
    }
  }
  if (parsed.id !== undefined && typeof parsed.id !== 'string' && typeof parsed.id !== 'number') {
    return { ok: false, httpStatus: 400, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_request, 'invalid_request', 'id must be a string or number') }
  }

  return { ok: true, request: parsed }
}

/* ---------- JSON-safe projection of tab/window state ---------- */

function agentRpcSafeUrl (rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return ''
  }
  var out = rawUrl
  /* Strip any userinfo, which is the only credential a URL can carry. */
  try {
    var u = new URL(rawUrl)
    if (u.username || u.password) {
      u.username = ''
      u.password = ''
      out = u.toString()
    }
  } catch (e) {
    /* Unparseable URL: drop any userinfo component rather than echo it. */
    out = rawUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1')
  }
  if (out.length > AGENT_RPC_MAX_URL_CHARS) {
    return out.slice(0, AGENT_RPC_MAX_URL_CHARS) + '…[truncated]'
  }
  return out
}

function agentRpcSafeText (raw, maxChars) {
  if (typeof raw !== 'string') {
    return ''
  }
  /* Titles are page-controlled; strip control characters before they reach JSON. */
  var stripped = ''
  for (var i = 0; i < raw.length; i++) {
    var code = raw.charCodeAt(i)
    stripped += (code < 32 || code === 127) ? ' ' : raw.charAt(i)
  }
  var cleaned = stripped.replace(/\s+/g, ' ').trim()
  if (cleaned.length > maxChars) {
    return cleaned.slice(0, maxChars) + '…[truncated]'
  }
  return cleaned
}

/* ---------- commands ---------- */

function agentRpcWindowSummaries () {
  var out = []
  try {
    windows.openWindows.forEach(function (entry) {
      if (entry.closed || !entry.win || entry.win.isDestroyed()) {
        return
      }
      out.push({
        windowId: entry.id,
        selectedTabId: windows.getState(entry.win).selectedView || null,
        visible: entry.win.isVisible(),
        focused: entry.win.isFocused()
      })
    })
  } catch (e) {
    agentRpcLog('window enumeration failed')
  }
  return out
}

function agentRpcTabSummaries () {
  var out = []
  try {
    Object.keys(viewMap).forEach(function (tabId) {
      var view = viewMap[tabId]
      if (!view || !view.webContents || view.webContents.isDestroyed()) {
        return
      }
      var wc = view.webContents
      var ownerWindow = windows.openWindows.find(function (entry) {
        return !entry.closed && entry.win && !entry.win.isDestroyed() && windows.getState(entry.win).selectedView === tabId
      })
      out.push({
        tabId: String(tabId),
        url: agentRpcSafeUrl(wc.getURL()),
        title: agentRpcSafeText(wc.getTitle(), AGENT_RPC_MAX_TITLE_CHARS),
        /* "active" = this tab is the selected view of a window. "focused" = the
         * tab's own webContents currently has focus. They are not the same thing. */
        active: !!ownerWindow,
        focused: wc.isFocused(),
        loading: wc.isLoading(),
        crashed: wc.isCrashed(),
        windowId: ownerWindow ? ownerWindow.id : null,
        webContentsId: wc.id
      })
    })
  } catch (e) {
    agentRpcLog('tab enumeration failed')
  }
  return out
}

function agentRpcCommandStatus () {
  var summaries = agentRpcWindowSummaries()
  var tabs = agentRpcTabSummaries()
  var currentWindow = null
  try {
    var win = windows.getCurrent()
    if (win && !win.isDestroyed()) {
      var entry = windows.openWindows.find(function (w) { return w.win === win })
      currentWindow = entry ? entry.id : null
    }
  } catch (e) { /* leave null */ }

  return {
    app: {
      name: app.name || 'Min',
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node
    },
    platform: { os: process.platform, arch: process.arch },
    uptimeSeconds: Math.round(process.uptime()),
    mode: {
      /* Min has no background/automation launch mode yet; report what is true
       * rather than what the design intends. See PHASE1-DESIGN.md 10. */
      automationMode: false,
      backgroundMode: false,
      development: isDevelopmentMode,
      privateMode: settings.get('privateMode') === true
    },
    profile: {
      /* This is the live userData path, so --user-data-dir is reflected here. */
      userDataPath: userDataPath,
      dedicated: false
    },
    windows: {
      count: summaries.length,
      items: summaries,
      currentWindowId: currentWindow,
      selectedTabId: (function () {
        var found = summaries.find(function (w) { return w.windowId === currentWindow })
        return found ? found.selectedTabId : null
      })()
    },
    tabs: { count: tabs.length },
    bridge: {
      /* Self-status only. The token value is never included anywhere. */
      enabled: true,
      boundHost: agentRpcState.host,
      boundPort: agentRpcState.port,
      authenticated: true,
      tokenSource: 'per-launch file',
      discoveryFile: agentRpcState.discoveryFile,
      launchedAt: new Date(agentRpcState.startedAt).toISOString(),
      requestCount: agentRpcState.requestCount,
      rejectedCount: agentRpcState.rejectedCount,
      authFailures: agentRpcState.authFailures,
      grants: { active: agentRpcGrantsActive() },
      policy: agentRpcReadPolicy(),
      refStore: agentRpcRefStoreStatus(),
      net: { inflight: AGENT_RPC_NET_INFLIGHT, observedTotal: AGENT_RPC_NET_OBSERVED_TOTAL, settledTotal: AGENT_RPC_NET_SETTLED_TOTAL, blockedTotal: AGENT_RPC_NET_BLOCKED_TOTAL, filteringBlockedCount: (function () { try { return settings.get('filteringBlockedCount') || 0 } catch (eBlocked) { return null } })() },
      telemetry: agentRpcTelemetryStatus()
    },
    features: {
      status: true,
      tabs: true,
      snapshot: true,
      navigate: true,
      click: true,
      type: true,
      press: true,
      screenshot: true,
      tabOpen: true,
      tabSelect: true,
      tabClose: true,
      content: true,
      hover: true,
      scroll: true,
      select: true,
      check: true,
      wait: true,
      downloads: true
    },
    limits: {
      bodyBytes: AGENT_RPC_MAX_BODY_BYTES,
      urlChars: AGENT_RPC_MAX_URL_CHARS,
      titleChars: AGENT_RPC_MAX_TITLE_CHARS,
      requestsPerSecond: AGENT_RPC_MAX_REQUESTS_PER_SECOND
    }
  }
}

function agentRpcCommandTabs () {
  var tabs = agentRpcTabSummaries()
  return { tabs: tabs, count: tabs.length }
}

function agentRpcDispatch (method, params) {
  if (method === 'browser_status') {
    return agentRpcCommandStatus()
  }
  if (method === 'browser_tabs') {
    return agentRpcCommandTabs()
  }
  if (method === 'browser_snapshot') {
    return agentRpcCommandSnapshot(params)
  }
  if (method === 'browser_click') {
    return agentRpcCommandClick(params)
  }
  if (method === 'browser_type') {
    return agentRpcCommandType(params)
  }
  if (method === 'browser_navigate') {
    return agentRpcCommandNavigate(params)
  }
  if (method === 'browser_press') {
    return agentRpcCommandPress(params)
  }
  if (method === 'browser_screenshot') {
    return agentRpcCommandScreenshot(params)
  }
  if (method === 'browser_grant') {
    return agentRpcCommandGrant(params)
  }
  if (method === 'browser_tab_open') {
    return agentRpcCommandTabOpen(params)
  }
  if (method === 'browser_tab_select') {
    return agentRpcCommandTabSelect(params)
  }
  if (method === 'browser_tab_close') {
    return agentRpcCommandTabClose(params)
  }
  if (method === 'browser_content') {
    return agentRpcCommandContent(params)
  }
  if (method === 'browser_hover') {
    return agentRpcCommandHover(params)
  }
  if (method === 'browser_mouse') {
    return agentRpcCommandMouse(params)
  }
  if (method === 'browser_scroll') {
    return agentRpcCommandScroll(params)
  }
  if (method === 'browser_select') {
    return agentRpcCommandSelect(params)
  }
  if (method === 'browser_check') {
    return agentRpcCommandCheck(params)
  }
  if (method === 'browser_wait') {
    return agentRpcCommandWait(params)
  }
  if (method === 'browser_downloads') {
    return agentRpcCommandDownloads()
  }
  if (method === 'browser_download_start') {
    return agentRpcCommandDownloadStart(params)
  }
  if (method === 'browser_download_wait') {
    return agentRpcCommandDownloadWait(params)
  }
  if (method === 'browser_download_cancel') {
    return agentRpcCommandDownloadCancel(params)
  }
  if (method === 'browser_download_pause') {
    return agentRpcCommandDownloadPause(params)
  }
  if (method === 'browser_download_resume') {
    return agentRpcCommandDownloadResume(params)
  }
  if (method === 'browser_state') {
    return agentRpcCommandState(params)
  }
  if (method === 'browser_batch') {
    return agentRpcCommandBatch(params)
  }
  if (method === 'browser_predict') {
    return agentRpcCommandPredict(params)
  }
  if (method === 'browser_verify') {
    return agentRpcCommandVerify(params)
  }
  if (method === 'browser_transform') {
    return agentRpcCommandTransform(params)
  }
  if (method === 'browser_transform_status') {
    return agentRpcCommandTransformStatus(params)
  }
  return null
}

/* ---------- browser_snapshot (P0-09) ----------
 *
 * Execution path: option 1 of PHASE1-DESIGN.md section 6 - fixed-source
 * executeJavaScript in the target webContents. Chosen over the extension-host
 * path on the evidence in docs/EXTENSION-COMPATIBILITY.md: content-script
 * injection is unreliable for file:// tabs (where document_start and frame
 * injection both failed) and for the first document of a session, while the
 * extension host is itself dev-gated.
 *
 * The injected string is ONLY this module's own function source, and the
 * function takes no arguments, so no request value participates in the source
 * built for the page at all - zero interpolation, zero evaluation of request
 * data. The page caps itself at AGENT_RPC_SNAPSHOT_HARD_NODES; the requested
 * maxNodes is applied by slicing in the main process.
 *
 * Page content is untrusted: every string returned below passes through
 * control-character stripping and length caps, values flagged sensitive by the
 * page never leave the page, the result is parsed as JSON (never evaluated),
 * and nothing from a page is ever logged.
 */
function AGENT_SNAPSHOT_PAGE_FN (mode, ordinal, extra) {
  /* Fixed-source page function for the agent bridge (P1-01).
   * Modes: 'snapshot' | 'locate' | 'content' | 'selcheck' | 'selection'
   * extra: { selector?: string (charset-validated upstream), dx?: number, dy?: number, optionText?: string }
   * No request-derived source is ever executed: args arrive as validated data. */
  var HARD_MAX = 1000
  var NAME_MAX = 120
  var TEXT_CAP = 40000
  function clean (s, max) {
    if (typeof s !== 'string') return ''
    var stripped = ''
    for (var ci = 0; ci < s.length; ci++) {
      var code = s.charCodeAt(ci)
      stripped += (code < 32 || code === 127) ? ' ' : s.charAt(ci)
    }
    return stripped.replace(/\s+/g, ' ').trim().slice(0, max)
  }
  var SENSITIVE_AUTO = { 'cc-number': 1, 'cc-csc': 1, 'cc-exp': 1, 'current-password': 1, 'new-password': 1, 'one-time-code': 1 }
  var CAPTCHA_SEL = '.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],iframe[src*="turnstile"],#cf-challenge'
  function isHidden (el) {
    try {
      const st = el.ownerDocument.defaultView.getComputedStyle(el)
      if (!st || st.display === 'none' || st.visibility === 'hidden') return true
      const r = el.getBoundingClientRect()
      if (r.width <= 0 && r.height <= 0) return true
      return el.getAttribute('aria-hidden') === 'true'
    } catch (e) { return true }
  }
  function nameOf (el) {
    let v = ''
    let kind = 'text'
    try {
      const ids = el.getAttribute('aria-labelledby')
      if (ids) {
        const acc = []
        const parts = ids.split(/\s+/)
        for (let pi = 0; pi < parts.length; pi++) {
          const refEl = el.ownerDocument.getElementById(parts[pi])
          if (refEl) acc.push(refEl.textContent || '')
        }
        v = clean(acc.join(' '), NAME_MAX)
        if (v) return { kind: 'role-name', name: v }
      }
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel && clean(ariaLabel, 1)) return { kind: 'role-name', name: clean(ariaLabel, NAME_MAX) }
      const fid = el.getAttribute('id')
      if (fid) {
        /* P1-01C: look up label[for] in the element's own tree root FIRST so
         * labels inside shadow roots resolve (ownerDocument cannot see into
         * shadow trees); fall back to the document for cross-tree labels. */
        const selLabel = 'label[for="' + fid.replace(/"/g, '') + '"]'
        let lab = null
        try {
          const ownRoot = el.getRootNode ? el.getRootNode() : null
          if (ownRoot && typeof ownRoot.querySelector === 'function') lab = ownRoot.querySelector(selLabel)
        } catch (eR) { lab = null }
        if (!lab) {
          try { lab = el.ownerDocument.querySelector(selLabel) } catch (eR2) { lab = null }
        }
        if (lab) {
          v = clean(lab.textContent, NAME_MAX)
          if (v) return { kind: 'label', name: v }
        }
      }
      const wrap = el.closest ? el.closest('label') : null
      if (wrap) {
        v = clean(wrap.textContent, NAME_MAX)
        if (v) return { kind: 'label', name: v }
      }
      const ph = el.getAttribute('placeholder')
      if (ph && clean(ph, 1)) return { kind: 'placeholder', name: clean(ph, NAME_MAX) }
      const alt = el.getAttribute('alt')
      if (alt && clean(alt, 1)) return { kind: 'role-name', name: clean(alt, NAME_MAX) }
      const ti = el.getAttribute('title')
      if (ti && clean(ti, 1)) return { kind: 'role-name', name: clean(ti, NAME_MAX) }
      v = clean(el.textContent, NAME_MAX)
      if (v) return { kind: 'text', name: v }
    } catch (e) { /* fall through */ }
    return { kind: kind, name: v }
  }
  function roleOf (el, tag) {
    try {
      const ariaRole = el.getAttribute('role')
      if (ariaRole && ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'switch', 'option', 'heading'].indexOf(ariaRole) !== -1) return ariaRole
    } catch (e) { /* ignore */ }
    if (tag === 'button' || (tag === 'input' && (el.type === 'button' || el.type === 'submit' || el.type === 'reset'))) return 'button'
    if (tag === 'a' && el.getAttribute('href') !== null) return 'link'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = el.type
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'password' || t === 'email' || t === 'tel' || t === 'text' || t === 'search' || t === 'url' || t === 'number' || t === 'date' || t === 'time' || t === 'file') return 'textbox'
      return null
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading'
    return null
  }
  /* Walk light DOM + OPEN shadow roots; dedupe via visited set; stable doc order. */
  const els = []
  const nodeEls = []
  const nodes = []
  const state = { scanned: 0, stopped: false, visited: new Set(), openShadowRoots: 0, nameSeen: {}, shadowPath: new Map() }
  const rootElement = document.body
  if (rootElement) {
    const walk = function (hostEl, fromShadow) {
      /* iterative per-host: queue children, traverse shadow roots when met */
    }
    const queue = [rootElement]
    state.queue = queue
    while (queue.length > 0 && !state.stopped) {
      const el = queue.shift()
      if (!el || state.visited.has(el)) continue
      state.visited.add(el)
      state.scanned++
      if (state.scanned > 30000) { state.stopped = true; break }
      const tag = (el.tagName || '').toLowerCase()
      /* enqueue children (light DOM) and open shadow roots (tracked for meta) */
      const kids = el.children || []
      for (let k = 0; k < kids.length; k++) queue.push(kids[k])
      let shadow = null
      try { shadow = el.shadowRoot } catch (eS) { shadow = null }
      if (shadow) {
        state.openShadowRoots++
        const skids = shadow.children || []
        for (let sk = 0; sk < skids.length; sk++) {
          if (!state.visited.has(skids[sk])) { state.shadowPath.set(skids[sk], (state.shadowPath.get(el) || '') + '::shadow'); queue.push(skids[sk]) }
        }
      }
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'link' || tag === 'meta') { /* metadata tags are not interactive */ continue }
      if (tag === 'option' || tag === 'optgroup') continue
      if (isHidden(el)) continue
      const role = roleOf(el, tag)
      if (!role) continue
      const nm = nameOf(el)
      /* P1-00A.1: nameless INTERACTIVE nodes are kept (icon-only buttons and
       * checkboxes are real click targets); roleOf already filters to
       * semantic interactive roles. Only non-semantic tags are dropped above. */
      const node = {
        role: role, name: nm.name, nameKind: nm.kind,
        shadowPath: state.shadowPath.get(el) || null, box: null,
        checked: null, expanded: null, disabled: false, redacted: false, value: null, valueLength: null
      }
      try {
        const r = el.getBoundingClientRect()
        node.box = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      } catch (e2) { node.box = null }
      try {
        node.disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
        if (role === 'checkbox' || role === 'radio' || role === 'switch') node.checked = el.checked === true || el.getAttribute('aria-checked') === 'true'
        if (role === 'combobox') node.expanded = el.getAttribute('aria-expanded') === 'true'
      } catch (e3) { /* states stay null */ }
      try {
        if (role === 'textbox' || role === 'combobox') {
          const type = (el.type || '').toLowerCase()
          const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
          const never = type === 'password' || SENSITIVE_AUTO[ac] || type === 'email' || type === 'tel'
          if (never) { node.redacted = true; node.valueLength = (el.value || '').length } else {
            node.value = clean(el.value || '', NAME_MAX)
            node.valueLength = (el.value || '').length
          }
        }
      } catch (e4) { /* value stays null */ }
      const key = role + '\u0000' + nm.name
      state.nameSeen[key] = (state.nameSeen[key] || 0) + 1
      node.nameIndex = state.nameSeen[key] - 1
      nodes.push(node)
      els.push(el)
      nodeEls.push(el)
    }
  }
  /* captcha widget boxes (fixed selector list; light DOM + shadow via query) */
  const captchaBoxes = []
  try {
    const widgets = document.querySelectorAll(CAPTCHA_SEL)
    for (let wi = 0; wi < widgets.length && wi < 12; wi++) {
      const wbox = widgets[wi].getBoundingClientRect()
      captchaBoxes.push({ x: Math.round(wbox.x), y: Math.round(wbox.y), w: Math.round(wbox.width), h: Math.round(wbox.height) })
    }
  } catch (eW) { /* ignore */ }

  const url = clean(location.href, 2000)
  const title = clean(document.title, 200)

  if (mode === 'locate') {
    const targetNode = (typeof ordinal === 'number' && ordinal >= 0 && ordinal < nodes.length) ? nodes[ordinal] : null
    const targetEl = (typeof ordinal === 'number' && ordinal >= 0 && ordinal < nodeEls.length) ? nodeEls[ordinal] : null
    if (targetNode) {
      try { targetNode.focused = (targetEl === document.activeElement) } catch (eF) { targetNode.focused = false }
    }
    /* P1-00A.1: press-family verification compares focused ordinals across
     * locate runs - the flag must be present on EVERY node, not only the
     * requested target (P1-01 regression: target-only flag broke 'focus' kind). */
    for (let fi = 0; fi < nodes.length; fi++) {
      try { nodes[fi].focused = (nodeEls[fi] === document.activeElement) } catch (eFo) { nodes[fi].focused = false }
    }
    let nearCaptcha = false
    const tRect = targetEl ? targetEl.getBoundingClientRect() : null
    for (let cbi = 0; cbi < captchaBoxes.length; cbi++) {
      const b = captchaBoxes[cbi]
      if (tRect && !(tRect.right < b.x || tRect.left > b.x + b.w || tRect.bottom < b.y || tRect.top > b.y + b.h)) { nearCaptcha = true; break }
    }
    if (targetNode) targetNode.nearCaptcha = nearCaptcha
    const markerText = clean(document.body ? document.body.innerText.slice(-120) : '', 120)
    const markerLen = document.body ? document.body.innerText.length : 0
    return {
      mode: 'locate', url: url, title: title, total: nodes.length,
      truncated: state.stopped, nodeCount: nodes.length,
      target: targetNode, nodes: nodes,
      marker: { interactiveCount: nodes.length, textLen: markerLen, sample: markerText },
      captchaBoxes: captchaBoxes, nearCaptcha: nearCaptcha, shadowMeta: { openShadowRoots: state.openShadowRoots }
    }
  }
  if (mode === 'content') {
    let text = document.body ? clean(document.body.innerText, TEXT_CAP) : ''
    /* P1-04.2: innerText never includes open shadow roots; surface their text
     * so browser_content reflects the full rendered document. Bounded walk
     * (≤200 hosts, text capped at the same TEXT_CAP as light DOM). */
    try {
      const hosts = (document.body || document.documentElement).querySelectorAll('*')
      const parts = []
      let used = 0
      for (let hi = 0; hi < hosts.length && hi < 2000 && used < TEXT_CAP; hi++) {
        const h = hosts[hi]
        if (!h.shadowRoot) continue
        const sEls = h.shadowRoot.querySelectorAll('p,h1,h2,h3,h4,h5,h6,span,div,li,td,th,button,label')
        for (let si = 0; si < sEls.length && si < 200 && used < TEXT_CAP; si++) {
          const sT = String(sEls[si].textContent || '').replace(/\s+/g, ' ').trim()
          if (!sT) continue
          parts.push(sT)
          used += sT.length + 1
        }
      }
      if (parts.length > 0) text = clean(text + '\n' + parts.join('\n'), TEXT_CAP)
    } catch (eShadow) { /* keep light-DOM text */ }
    return { mode: 'content', url: url, title: title, text: text, truncated: text.length >= TEXT_CAP }
  }
  if (mode === 'selcheck') {
    const sel = (extra && extra.selector) ? String(extra.selector) : null
    let found = false, visible = false, matches = 0
    if (sel) {
      try {
        const list = document.querySelectorAll(sel)
        matches = list.length
        for (let qi = 0; qi < list.length; qi++) { if (!isHidden(list[qi])) { found = true; visible = true; break } }
      } catch (eS2) { /* selector invalid in-page */ }
    }
    return { mode: 'selcheck', found: found, visible: visible, matches: matches }
  }
  if (mode === 'selection') {
    const selOrd = (typeof ordinal === 'number') ? ordinal : -1
    const selEl = nodeEls[selOrd]
    const opt = (extra && extra.optionText) ? String(extra.optionText) : ''
    if (!selEl) return { mode: 'selection', ok: false, reason: 'target not found' }
    if (selEl.tagName && selEl.tagName.toLowerCase() !== 'select') return { mode: 'selection', ok: false, reason: 'not a select element' }
    const opts = selEl.options || []
    let chosen = -1
    for (let oi = 0; oi < opts.length; oi++) {
      if ((opts[oi].value || '') === opt || clean(opts[oi].textContent, 200) === opt) { chosen = oi; break }
    }
    if (chosen === -1) return { mode: 'selection', ok: false, reason: 'option not found', hadOptions: opts.length }
    try {
      /* native value setter + change/input events (React/framework controlled selects) */
      const selProto = Object.getPrototypeOf(selEl)
      const selDesc = Object.getOwnPropertyDescriptor(selProto, 'value') || Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
      if (selDesc && selDesc.set) selDesc.set.call(selEl, opts[chosen].value)
      else selEl.value = opts[chosen].value
      selEl.dispatchEvent(new Event('input', { bubbles: true }))
      selEl.dispatchEvent(new Event('change', { bubbles: true }))
    } catch (eSel) { return { mode: 'selection', ok: false, reason: String(eSel && eSel.message ? eSel.message : eSel) } }
    return { mode: 'selection', ok: true, value: selEl.value, selectedText: clean((opts[chosen] && opts[chosen].textContent) || '', 200) }
  }
  /* P1-01C: native-setter input fallback. Identity-checked against the
   * enumeration that produced the ref (role + name + nameIndex at ordinal);
   * writes via the prototype's own value setter (framework-controlled inputs
   * see a real value change) then dispatches input + change. The read-back is
   * sanitized: redacted targets return length only, never the value. */
  /* P1-01D: scroll the located element into view and return its FRESH box.
   * sendInputEvent dispatch uses viewport coordinates, so any action on an
   * element below/above the fold needs this first (real pages are huge;
   * fixture-sized pages never noticed). Identity-checked like setvalue. */
  if (mode === 'scrollinto') {
    const siOrd = (typeof ordinal === 'number') ? ordinal : -1
    const siEl = nodeEls[siOrd]
    const siNode = nodes[siOrd] || null
    if (!siEl || !siNode) return { mode: 'scrollinto', ok: false, reason: 'target not found (stale reference)' }
    if (extra && siNode.role !== extra.role) return { mode: 'scrollinto', ok: false, reason: 'target identity drifted (role mismatch)' }
    try {
      siEl.scrollIntoView({ block: 'center', inline: 'center' })
      const r = siEl.getBoundingClientRect()
      const vw = window.innerWidth || 0
      const vh = window.innerHeight || 0
      const nx = Math.round(r.x), ny = Math.round(r.y)
      const inViewport = nx >= 0 && ny >= 0 && nx < vw && ny < vh
      return { mode: 'scrollinto', ok: true, boxVp: { x: nx, y: ny, w: Math.round(r.width), h: Math.round(r.height) }, inViewport: inViewport, scrollY: Math.round(window.scrollY || 0) }
    } catch (eSI) {
      return { mode: 'scrollinto', ok: false, reason: String(eSI && eSI.message ? eSI.message : eSI) }
    }
  }
  /* P1-01E: lightweight page-state signals for browser_state — no page
   * content leaves the page; only booleans, counts and short structural
   * fields. Kind classification is locator-based (recaptcha/hcaptcha/
   * turnstile) with an explicit 'unknown' for generic sitekey markers. */
  /* P1-04: transform drift check for browser_transform_status. Text records:
   * drift = the rendered text no longer equals the applied replacement (a
   * framework re-render overwrote the transform). Style records: drift = the
   * marker attribute is gone. Identity-drift targets are marked drift too
   * (the element they were applied to cannot be found). */
  if (mode === 'driftcheck') {
    const opsDC = (extra && Array.isArray(extra.ops)) ? extra.ops : []
    const outDC = []
    for (let di = 0; di < opsDC.length && di < 60; di++) {
      const dc = opsDC[di]
      let el2 = null
      let n2 = null
      if (dc.sel) {
        try { el2 = document.querySelector(dc.sel) } catch (eSel) { el2 = null }
        n2 = el2 ? { role: 'sel-target', name: 'sel:' + dc.sel } : null
      } else {
        el2 = nodeEls[dc.ordinal]
        n2 = nodes[dc.ordinal] || null
      }
      let entryDC = { transformId: dc.transformId, op: dc.op, drift: false, reason: null }
      if (!el2) {
        entryDC.drift = true
        entryDC.reason = 'target no longer enumerable'
      } else if (!dc.sel && (n2.role !== dc.role || n2.name !== dc.name || (n2.nameIndex || 0) !== (dc.nameIndex || 0))) {
        entryDC.drift = true
        entryDC.reason = 'target identity drifted'
      } else if (dc.op === 'driftcheck' && dc.appliedText !== undefined) {
        if ((el2.textContent || '').trim() !== String(dc.appliedText)) {
          entryDC.drift = true
          entryDC.reason = 'rendered text differs from the applied replacement'
        }
      } else if (dc.op === 'drift-styled') {
        if (el2.getAttribute('data-agent-transform') !== '1') {
          entryDC.drift = true
          entryDC.reason = 'transform marker attribute gone (re-render or manual change)'
        }
      }
      outDC.push(entryDC)
    }
    return { mode: 'driftcheck', ok: true, ops: outDC }
  }
  /* P1-04: reversible transformations. One call applies a bounded list of ops
   * against identity-checked targets. Original state is CAPTURED HERE and the
   * bridge stores it for restore ops. Never outerHTML; never node replacement
   * (framework listeners survive). Per-entry outcomes; no page text returned. */
  if (mode === 'transform') {
    const ops = (extra && Array.isArray(extra.ops)) ? extra.ops : []
    const outOps = []
    function tfIdentityCheck (op2) {
      if (op2.sel) {
        let found = null
        try { found = document.querySelector(op2.sel) } catch (eSel2) { found = null }
        if (!found) return { stale: true, reason: 'selector matched no element on the current page' }
        return { stale: false, el: found }
      }
      const el2 = nodeEls[op2.ordinal]
      const n2 = nodes[op2.ordinal] || null
      if (!el2 || !n2) return { stale: true, reason: 'target not found (stale reference)' }
      /* P1-11: a replace_text transform changes the accessible NAME of its own
       * target, so requiring the snapshot-time name after applying it made every
       * text restore self-drift. restore_target keeps ordinal+role checks and
       * additionally accepts the post-apply name (the transform's own output). */
      if (n2.role !== op2.role) {
        return { stale: true, reason: 'target identity drifted (role mismatch)' }
      }
      if (op2.op !== 'restore_target' && (n2.name !== op2.name || (n2.nameIndex || 0) !== (op2.nameIndex || 0))) {
        return { stale: true, reason: 'target identity drifted (stale reference)' }
      }
      return { stale: false, el: el2 }
    }
    function captureStyleProps (el2, props) {
      const caps = {}
      for (let pi = 0; pi < props.length; pi++) {
        const p = props[pi]
        caps[p] = { hadInlineProp: el2.style.getPropertyValue(p) !== '', inlineValue: el2.style.getPropertyValue(p), inlinePriority: el2.style.getPropertyPriority(p) }
      }
      return caps
    }
    for (let oi = 0; oi < ops.length && oi < 50; oi++) {
      const op2 = ops[oi]
      const idc = tfIdentityCheck(op2)
      if (idc.stale) { outOps.push({ sel: op2.sel || null, ordinal: op2.ordinal, op: op2.op, ok: false, reason: idc.reason, stale: true }); continue }
      const el = idc.el
      try {
        if (op2.op === 'replace_text') {
          /* Framework safety: refuse when content-bearing element children exist.
           * BR-only children are pure formatting, so replacement proceeds: the
           * new text is split on '\n' and <br> markers are rebuilt between
           * segments (restore flattens back to a single text node — noted). */
          const kidArr = el.children ? Array.prototype.slice.call(el.children) : []
          if (kidArr.length > 0 && kidArr.some(function (kid) { return kid.tagName !== 'BR' })) {
            outOps.push({ ordinal: op2.ordinal, op: op2.op, ok: false, reason: 'target has element children; text replacement refused (framework safety)' }); continue
          }
          const prev = el.textContent || ''
          if (kidArr.length > 0 && kidArr.every(function (kid) { return kid.tagName === 'BR' })) {
            const segs2 = String(op2.text).split('\n')
            while (el.firstChild) el.removeChild(el.firstChild)
            el.appendChild(document.createTextNode(segs2[0]))
            for (let gi = 1; gi < segs2.length; gi++) {
              el.appendChild(document.createElement('br'))
              el.appendChild(document.createTextNode(segs2[gi]))
            }
          } else {
            el.textContent = op2.text
          }
          outOps.push({ ordinal: op2.ordinal, sel: op2.sel || null, op: op2.op, ok: true, original: { text: prev.slice(0, 1200) }, appliedText: op2.text, rendered: { text: String(el.textContent || '').slice(0, 200), children: el.children.length } })
        } else if (op2.op === 'set_style' || op2.op === 'hide' || op2.op === 'highlight') {
          const styleEntries = op2.op === 'set_style' ? (op2.style || []) : []
          const appliedProps = []
          const originalProps = captureStyleProps(el, styleEntries.map(function (se) { return se.prop }).concat(op2.op === 'highlight' ? ['outline', 'outlineOffset'] : []).concat(op2.op === 'hide' ? ['display'] : []))
          if (op2.op === 'set_style') {
            for (let si = 0; si < styleEntries.length; si++) { el.style.setProperty(styleEntries[si].prop, styleEntries[si].value); appliedProps.push(styleEntries[si].prop) }
          } else if (op2.op === 'hide') {
            el.style.setProperty('display', 'none', 'important')
            appliedProps.push('display')
          } else {
            el.style.setProperty('outline', '3px solid #f59e0b', 'important')
            el.style.setProperty('outlineOffset', '2px')
            appliedProps.push('outline', 'outlineOffset')
          }
          const hadMarker = el.hasAttribute('data-agent-transform')
          const markerBefore = el.getAttribute('data-agent-transform')
          el.setAttribute('data-agent-transform', '1')
          const rendered = {}
          for (let ri = 0; ri < appliedProps.length; ri++) rendered[appliedProps[ri]] = el.style.getPropertyValue(appliedProps[ri])
          outOps.push({ ordinal: op2.ordinal, sel: op2.sel || null, op: op2.op, ok: true, opKind: op2.op, original: { props: originalProps }, appliedProps: appliedProps, marker: { had: hadMarker, value: markerBefore }, rendered: rendered })
        } else if (op2.op === 'restore_target' || op2.op === 'restore_all') {
          /* restore actual values are supplied by the bridge from its records */
          const rec = op2.original || null
          const resProps = rec && rec.props ? rec.props : null
          if (resProps) {
            for (const rk of Object.keys(resProps)) {
              const rv = resProps[rk]
              if (rv.hadInlineProp) el.style.setProperty(rk, rv.inlineValue, rv.inlinePriority)
              else el.style.removeProperty(rk)
            }
          }
          if (rec && rec.textContentOriginal !== undefined && el.children && el.children.length === 0) {
            el.textContent = rec.textContentOriginal
          }
          const markerBefore = el.getAttribute('data-agent-transform')
          if (rec && rec.marker && rec.marker.had === true && rec.marker.value !== null) el.setAttribute('data-agent-transform', rec.marker.value)
          else if (el.getAttribute('data-agent-transform') === '1') el.removeAttribute('data-agent-transform')
          const rendered = {}
          if (resProps) for (const rk2 of Object.keys(resProps)) rendered[rk2] = el.style.getPropertyValue(rk2)
          outOps.push({ ordinal: op2.ordinal, sel: op2.sel || null, op: 'restore', ok: true, original: rec, transformId: op2.transformId, rendered: rendered, restoredText: (rec && rec.textContentOriginal !== undefined) ? String(el.textContent || '').slice(0, 200) : undefined })
        } else {
          outOps.push({ ordinal: op2.ordinal, op: op2.op, ok: false, reason: 'unknown op' })
        }
      } catch (eT) {
        outOps.push({ ordinal: op2.ordinal, op: op2.op, ok: false, reason: String(eT && eT.message ? eT.message : eT) })
      }
    }
    return { mode: 'transform', ok: true, ops: outOps, overflow: ops.length > 50 ? ops.length - 50 : 0 }
  }
  /* P1-03: static action prediction. Pure DOM inspection of the located
   * element — the action is NEVER triggered. Returns structure only (hrefs,
   * form actions, types); no page text. */
  if (mode === 'predict') {
    const prOrd = (typeof ordinal === 'number') ? ordinal : -1
    const prEl = nodeEls[prOrd]
    const prNode = nodes[prOrd] || null
    if (!prEl || !prNode) return { mode: 'predict', ok: false, reason: 'target not found (stale reference)' }
    const wantRole = extra && extra.role
    if (wantRole && prNode.role !== wantRole) return { mode: 'predict', ok: false, reason: 'target identity drifted (role mismatch)' }
    const tag = (prEl.tagName || '').toLowerCase()
    const href = (prEl.getAttribute && prEl.getAttribute('href')) || null
    const hrefResolved = href ? (function () { try { return new URL(href, location.href).href } catch (eH) { return null } })() : null
    /* only the EXPLICIT type attribute: a bare <button> DOM type defaults to submit, which would misclassify non-submit buttons. */
    const elType = (prEl.getAttribute && prEl.getAttribute('type') || '').toLowerCase()
    const disabled = prEl.disabled === true || prEl.getAttribute('aria-disabled') === 'true'
    const targetAttr = (prEl.getAttribute && prEl.getAttribute('target')) || null
    let formAction = null
    let formMethod = null
    let insideForm = false
    try {
      const form = prEl.closest ? prEl.closest('form') : null
      if (form) {
        insideForm = true
        formAction = form.getAttribute('action') || null
        formMethod = (form.getAttribute('method') || 'get').toLowerCase()
        formAction = formAction ? (function () { try { return new URL(formAction, location.href).href } catch (eFA) { return formAction } }()) : null
      }
    } catch (eF2) { /* ignore */ }
    return {
      mode: 'predict', ok: true,
      tag: tag,
      role: prNode.role,
      name: prNode.name,
      href: hrefResolved,
      hrefTarget: targetAttr,
      form: { insideForm: insideForm, action: formAction, method: formMethod },
      inputType: elType || null,
      disabled: disabled,
      isContentEditable: prEl.isContentEditable === true,
      currentUrl: url,
      parentTag: (function () { try { const pc2 = prEl.parentElement; return pc2 ? (pc2.tagName || '').toLowerCase() : 'none' } catch (eP) { return 'err' } })(),
      insideFormRaw: (function () { try { return prEl.closest && prEl.closest('form') ? true : false } catch (eC) { return 'err' } })()
    }
  }
  /* P1-03: cheap post-action verification (no full snapshot). Callable
   * conditions are combined; each is answered independently. textContains is
   * the AGENT's own expectation string (≤200 chars), compared against the
   * bounded body text — the value is never sent back, only the boolean. */
  if (mode === 'verify') {
    const wantSel = (extra && typeof extra.selector === 'string' && extra.selector) ? extra.selector : null
    const wantText = (extra && typeof extra.textContains === 'string' && extra.textContains) ? clean(extra.textContains, 200) : null
    const out = { mode: 'verify', url: url, title: title }
    if (wantSel) {
      out.selector = wantSel
      out.selectorFound = false
      out.selectorVisible = false
      out.selectorMatches = 0
      try {
        const list = document.querySelectorAll(wantSel)
        out.selectorMatches = list.length
        for (let qi = 0; qi < list.length; qi++) { if (!isHidden(list[qi])) { out.selectorFound = true; out.selectorVisible = true; break } }
        if (!out.selectorVisible && list.length > 0) out.selectorFound = true
      } catch (eQ2) { out.selectorInvalid = true }
    }
    if (wantText) {
      const bodyText = document.body ? document.body.innerText : ''
      out.textLength = bodyText.length
      out.textContains = bodyText.indexOf(wantText) !== -1
    }
    out.focusedTag = (document.activeElement && document.activeElement !== document.body) ? (document.activeElement.tagName || '').toLowerCase() : null
    return out
  }
  if (mode === 'state') {
    let kind = null
    let basis = null
    let confidence = null
    let widgetCount = 0
    try {
      const widgets = document.querySelectorAll(CAPTCHA_SEL)
      widgetCount = widgets.length
      const order = [
        ['.h-captcha', 'hcaptcha', 'high'],
        ['iframe[src*="hcaptcha"]', 'hcaptcha', 'high'],
        ['.g-recaptcha', 'recaptcha', 'high'],
        ['iframe[src*="recaptcha"]', 'recaptcha', 'high'],
        ['iframe[src*="challenges.cloudflare"]', 'turnstile', 'high'],
        ['.cf-turnstile', 'turnstile', 'high'],
        ['#cf-challenge', 'turnstile', 'medium'],
        ['[data-sitekey]', 'unknown', 'low']
      ]
      for (let oi = 0; oi < order.length && kind === null; oi++) {
        let n = 0
        try { n = document.querySelectorAll(order[oi][0]).length } catch (eQ) { n = 0 }
        if (n > 0) { kind = order[oi][1]; confidence = order[oi][2]; basis = 'locator ' + order[oi][0] + ' (' + n + ' match(es))' }
      }
      if (widgetCount > 0 && kind === null) { kind = 'unknown'; confidence = 'low'; basis = 'composite locator matched ' + widgetCount + ' element(s)' }
    } catch (eC) { /* detection unavailable */ }
    let focusTag = null
    let focusIsTextField = false
    let focusIsPasswordField = false
    let focusIsBody = true
    try {
      const ae = document.activeElement
      if (ae && ae !== document.body) {
        focusIsBody = false
        focusTag = (ae.tagName || '').toLowerCase()
        const ftype = (ae.type || '').toLowerCase()
        focusIsTextField = focusTag === 'input' || focusTag === 'textarea'
        focusIsPasswordField = focusTag === 'input' && ftype === 'password'
      }
    } catch (eF) { /* ignore */ }
    return {
      mode: 'state', url: url, title: title,
      readyState: String(document.readyState || ''),
      captcha: { detected: kind !== null, kind: kind, confidence: confidence, basis: basis, widgetCount: widgetCount, docWidth: Math.round(document.documentElement ? document.documentElement.scrollWidth || 0 : 0) },
      focus: { isBody: focusIsBody, tag: focusTag, isTextField: focusIsTextField, isPasswordField: focusIsPasswordField },
      shadowMeta: { openShadowRoots: state.openShadowRoots }
    }
  }
  if (mode === 'setvalue') {
    const svOrd = (typeof ordinal === 'number') ? ordinal : -1
    const svEl = nodeEls[svOrd]
    const svNode = nodes[svOrd] || null
    const wantRole = extra && extra.role
    const wantName = extra && extra.name
    const wantNameIndex = extra && typeof extra.nameIndex === 'number' ? extra.nameIndex : 0
    const svText = (extra && typeof extra.text === 'string') ? extra.text : null
    const redacted = !!(extra && extra.redacted)
    if (!svEl || !svNode) return { mode: 'setvalue', ok: false, reason: 'target not found (stale reference)' }
    if (svNode.role !== wantRole || svNode.name !== wantName || (svNode.nameIndex || 0) !== wantNameIndex) {
      return { mode: 'setvalue', ok: false, reason: 'target identity drifted (stale reference)' }
    }
    if (svEl.disabled === true) return { mode: 'setvalue', ok: false, reason: 'element is disabled' }
    if (svText === null) return { mode: 'setvalue', ok: false, reason: 'no text supplied' }
    try {
      let usedNativeSetter = false
      const proto = Object.getPrototypeOf(svEl)
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      if (desc && desc.set) { desc.set.call(svEl, svText); usedNativeSetter = true }
      else svEl.value = svText
      svEl.dispatchEvent(new Event('input', { bubbles: true }))
      svEl.dispatchEvent(new Event('change', { bubbles: true }))
      const finalLen = (svEl.value || '').length
      return { mode: 'setvalue', ok: true, usedNativeSetter: usedNativeSetter, valueLength: finalLen, value: redacted ? null : clean(svEl.value || '', NAME_MAX), redacted: redacted }
    } catch (eSet) {
      return { mode: 'setvalue', ok: false, reason: String(eSet && eSet.message ? eSet.message : eSet) }
    }
  }
  /* snapshot mode (default) */
  const sNodes = nodes.map(function (n) {
    return {
      role: n.role, name: n.name, nameKind: n.nameKind, nameIndex: n.nameIndex,
      shadowPath: n.shadowPath || null, box: n.box, checked: n.checked, expanded: n.expanded,
      disabled: n.disabled, redacted: n.redacted, value: n.value, valueLength: n.valueLength
    }
  })
  return {
    mode: 'snapshot', url: url, title: title, nodes: sNodes,
    truncated: state.stopped || nodes.length >= HARD_MAX, scanned: state.scanned,
    shadowMeta: { openShadowRoots: state.openShadowRoots },
    captchaBoxes: captchaBoxes
  }
}

/* P1-01D: per-method telemetry (local, concise; no payloads, no URLs).
 * Counts + wall-clock durations only. Bounded to registered method names. */
const AGENT_RPC_TELEMETRY = {}
function agentRpcTelemetryEntry (method) {
  if (!AGENT_RPC_TELEMETRY[method]) {
    AGENT_RPC_TELEMETRY[method] = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0, errors: 0 }
  }
  return AGENT_RPC_TELEMETRY[method]
}
function agentRpcTelemetryRecord (method, ms, isError) {
  if (AGENT_RPC_METHODS.indexOf(method) === -1) return
  const t = agentRpcTelemetryEntry(method)
  t.count++
  t.lastMs = ms
  t.totalMs += ms
  if (ms > t.maxMs) t.maxMs = ms
  if (isError) t.errors++
}
function agentRpcTelemetryRecordSync (method, outcome, startedAt) {
  if (outcome && typeof outcome.then === 'function') return /* async: recorded on settle */
  agentRpcTelemetryRecord(method, Date.now() - startedAt, false)
}
function agentRpcTelemetryRecordAsync (method, startedAt, errorCategory) {
  agentRpcTelemetryRecord(method, Date.now() - startedAt, errorCategory !== undefined)
}
function agentRpcTelemetryStatus () {
  const out = {}
  Object.keys(AGENT_RPC_TELEMETRY).forEach(function (m) {
    const t = AGENT_RPC_TELEMETRY[m]
    out[m] = { count: t.count, avgMs: t.count ? Math.round(t.totalMs / t.count) : 0, maxMs: t.maxMs, lastMs: t.lastMs, errors: t.errors }
  })
  return out
}

function agentRpcRefStoreStatus () {
  /* Live refs only: expiry is a read-time property (the sweep is memory
   * hygiene), so a status read must not report refs that a future consumer
   * could no longer resolve. */
  var now = Date.now()
  var total = 0
  var liveTabs = 0
  AGENT_SNAPSHOT_REFS.forEach(function (store, tabId) {
    var view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
    var dead = !view || !view.webContents || view.webContents.isDestroyed()
    var expired = now - store.born > AGENT_RPC_REF_TTL_MS
    if (!dead && !expired) {
      total += store.refs.length
      liveTabs++
    }
  })
  return { tabs: liveTabs, refCount: total, ttlMs: AGENT_RPC_REF_TTL_MS, sweepRuns: AGENT_SNAPSHOT_SWEEP_RUNS }
}

function agentRpcCommandSnapshot (params) {
  return new Promise(function (resolve, reject) {
    const waitMs = Math.max(0, Math.min(params.waitMs === undefined ? 0 : params.waitMs, 5000))
    if (waitMs > 0) {
      setTimeout(function () { agentRpcCommandSnapshotBody(params, resolve, reject) }, waitMs)
      return
    }
    agentRpcCommandSnapshotBody(params, resolve, reject)
  })
}

function agentRpcCommandSnapshotBody (params, resolve, reject) {
    var tabId = params.tabId
    var view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'not_found', 'tabId does not match a live view'))
      return
    }
    if (view.webContents.getURL() === '') {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no page loaded yet (about to show the start page)'))
      return
    }
    /* Single-window scope (P0-09): report attribution rather than guessing. */
    var selectedIn = null
    try {
      windows.openWindows.forEach(function (entry) {
        if (!entry.closed && entry.win && !entry.win.isDestroyed() && windows.getState(entry.win).selectedView === String(tabId)) {
          selectedIn = entry.id
        }
      })
    } catch (e) { selectedIn = null }

    var wc = view.webContents
    var source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')()'

    var timedOut = false
    var timer = setTimeout(function () {
      timedOut = true
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'snapshot did not return within ' + AGENT_RPC_SNAPSHOT_TIMEOUT + 'ms'))
    }, AGENT_RPC_SNAPSHOT_TIMEOUT)

    wc.executeJavaScript(source)
      .then(function (pageRes) {
        if (timedOut) return
        clearTimeout(timer)
        if (!pageRes || !Array.isArray(pageRes.nodes)) {
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'page returned no snapshot data'))
          return
        }
        var maxNodes = params.maxNodes === undefined ? AGENT_RPC_SNAPSHOT_DEFAULT_NODES : params.maxNodes
        var taken = pageRes.nodes.slice(0, Math.min(maxNodes, AGENT_RPC_SNAPSHOT_HARD_NODES))

        var nodes = []
        taken.forEach(function (n) {
          var ref = 'r' + (AGENT_SNAPSHOT_REF_COUNTER++).toString(36)
          nodes.push({
            ref: ref,
            role: n.role,
            name: agentRpcSafeText(n.name, AGENT_RPC_SNAPSHOT_NAME_MAX),
            value: (n.value === null || n.value === undefined) ? null : agentRpcSafeText(n.value, AGENT_RPC_SNAPSHOT_NAME_MAX),
            valueLength: typeof n.valueLength === 'number' ? n.valueLength : null,
            redacted: n.redacted === true,
            checked: typeof n.checked === 'boolean' ? n.checked : null,
            expanded: typeof n.expanded === 'boolean' ? n.expanded : null,
            disabled: n.disabled === true,
            box: n.box && typeof n.box.x === 'number' ? n.box : null,
            shadowPath: (typeof n.shadowPath === 'string' && n.shadowPath) ? n.shadowPath : null,
            locator: { kind: n.nameKind || 'text', role: n.role, nameIndex: n.nameIndex || 0 }
          })
        })

        var result = {
          tabId: String(tabId),
          url: agentRpcSafeUrl(pageRes.url),
          title: agentRpcSafeText(pageRes.title, AGENT_RPC_MAX_TITLE_CHARS),
          active: selectedIn !== null,
          windowId: selectedIn,
          format: params.format === 'text' ? 'text' : 'json',
          requestedMaxNodes: maxNodes,
          pageTruncated: pageRes.truncated === true,
          truncated: false,
          nodeCount: nodes.length
        }

        var bounded = agentRpcBoundSnapshot(result, nodes)
        var finalNodes = bounded.nodes
        result.bytes = bounded.bytes
        result.truncated = bounded.truncated
        result.nodeCount = finalNodes.length

        /* Ref records carry everything the action resolver needs to re-locate
         * the element WITHOUT trusting a stale DOM handle: role + accessible
         * name + nameIndex + the snapshot-time ordinal and enumeration length. */
        var refRecords = []
        finalNodes.forEach(function (n, idx) {
          refRecords.push({ ref: n.ref, role: n.role, name: n.name, nameIndex: n.locator.nameIndex, ordinal: idx, enumLen: finalNodes.length })
        })
        AGENT_SNAPSHOT_REFS.set(String(tabId), { born: Date.now(), refs: refRecords, enumLen: finalNodes.length })
        result.refsStored = refRecords.length

        if (result.format === 'text') {
          var textLines = finalNodes.map(function (n) {
            var attrs = []
            if (n.disabled) attrs.push('disabled')
            if (n.checked !== null) attrs.push('checked=' + n.checked)
            if (n.redacted) attrs.push('redacted')
            attrs.push('ref=' + n.ref)
            return n.role + ' ' + JSON.stringify(n.name) + (n.value !== null ? ' value=' + JSON.stringify(n.value) : (n.valueLength !== null ? ' len=' + n.valueLength : '')) + ' [' + attrs.join(' ') + ']'
          })
          result.text = 'url ' + JSON.stringify(result.url) + '\ntitle ' + JSON.stringify(result.title) + '\n' + textLines.join('\n')
          while (result.text.length > AGENT_RPC_SNAPSHOT_BYTES && textLines.length > 1) {
            textLines.pop()
            result.truncated = true
            result.text = 'url ' + JSON.stringify(result.url) + '\ntitle ' + JSON.stringify(result.title) + '\n' + textLines.join('\n')
          }
        } else {
          result.nodes = finalNodes
        }
        resolve(result)
      })
      .catch(function () {
        if (timedOut) return
        clearTimeout(timer)
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'snapshot could not be collected from this view'))
      })

    /* Navigation clears the ref store for this tab immediately. Min already
     * attaches its own did-navigate listeners to every tab webContents
     * (viewManager createView), so listenerCount cannot decide this - track
     * our own attachment by webContents id. */
    if (!AGENT_SNAPSHOT_NAV_ATTACHED.has(wc.id)) {
      AGENT_SNAPSHOT_NAV_ATTACHED.add(wc.id)
      wc.on('did-navigate', function () { agentRpcClearSnapshotRefs(String(tabId)); agentRpcClearTransforms(String(tabId)); agentRpcMouseAbort(String(tabId)) })
    }
}

function agentRpcBoundSnapshot (result, nodes) {
  /* Total response cap: drop nodes from the end until the serialised envelope
   * fits, then mark truncated. */
  var probe = function (list) { return JSON.stringify({ result: Object.assign({}, result, { nodes: list }) }).length }
  var list = nodes
  if (probe(list) > AGENT_RPC_SNAPSHOT_BYTES) {
    result.truncated = true
    while (list.length > 1 && probe(list) > AGENT_RPC_SNAPSHOT_BYTES) {
      list = list.slice(0, Math.ceil(list.length * 0.9))
    }
  }
  return { nodes: list, bytes: probe(list), truncated: !!result.truncated }
}

/* Periodic sweep for TTL + destroyed views. Runs only while the bridge is
 * enabled; cleared on stop. */
function agentRpcStartRefSweep () {
  if (AGENT_SNAPSHOT_SWEEP) return
  AGENT_SNAPSHOT_SWEEP = setInterval(agentRpcSweepSnapshotRefs, AGENT_RPC_REF_SWEEP_MS)
}

function agentRpcStopRefSweep () {
  if (!AGENT_SNAPSHOT_SWEEP) return
  clearInterval(AGENT_SNAPSHOT_SWEEP)
  AGENT_SNAPSHOT_SWEEP = null
}

/* ---------- P1-00 Stage A: tab management ----------
 * Open/select/close use Min's own tab + view APIs: open goes through the
 * renderer tab model (addTab), select/close drive the viewManager primitives
 * (attach/detach/destroy). No parallel tab store is created. */

function agentRpcAttachView (win, id) {
  const view = viewMap[id]
  if (!view) return false
  if (!viewStateMap[id] || !viewStateMap[id].loadedInitialURL) return false
  const content = win.getContentView()
  /* P1-00 lesson: double-attaching a view hard-crashes this Electron. The
   * renderer may have attached the view already (tab creation attaches
   * synchronously through its own pipeline); guard by identity. */
  const alreadyAttached = content.children.indexOf(view) !== -1
  if (!alreadyAttached) {
    content.children.slice(1).forEach(function (child) { content.removeChildView(child) })
    content.addChildView(view)
  }
  /* bounds: refresh either way (renderer bounds events don't cover our attach). */
  const ui = content.children[0]
  const uiB = (ui && ui.getBounds) ? ui.getBounds() : { y: 0, height: 0 }
  const wb = win.getContentBounds()
  view.setBounds({ x: 0, y: uiB.y + uiB.height, width: wb.width, height: Math.max(200, wb.height - uiB.y - uiB.height) })
  windows.getState(win).selectedView = id
  return true
}

function agentRpcWaitForNewView (beforeKeys, timeoutMs) {
  return new Promise(function (resolve) {
    const t = setTimeout(function () { clearInterval(iv); resolve(null) }, timeoutMs || 8000)
    const iv = setInterval(function () {
      const added = Object.keys(viewMap).filter(function (k) { return beforeKeys.indexOf(k) === -1 })
      if (added.length > 0) { clearTimeout(t); clearInterval(iv); resolve(added[0]) }
    }, 100)
  })
}

function agentRpcCommandTabOpen (params) {
  return new Promise(function (resolve, reject) {
    const win = windows.getCurrent()
    if (!win || win.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'no open window'))
      return
    }
    if (params.url) {
      const urlCheck = agentRpcValidateUrl(params.url, agentRpcEffectiveProtocols())
      if (!urlCheck.ok) {
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', urlCheck.reason))
        return
      }
    }
    const before = Object.keys(viewMap)
    const attachedPromise = agentRpcWaitForNewView(before, 8000)
    try {
      sendIPCToWindow(win, 'addTab', { url: params.url || '' })
    } catch (e) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.internal, 'internal', 'tab could not be opened'))
      return
    }
    attachedPromise.then(function (newId) {
      if (!newId) {
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'tab did not open within 8s'))
        return
      }
      /* A tab opened without a URL has no page loaded at all (empty wc) —
       * snapshot/act on it would crash the renderer chain; give it the start
       * page through the existing funnel. */
      const viewNew = viewMap[newId]
      if (viewNew && viewNew.webContents && !viewNew.webContents.isDestroyed() && viewNew.webContents.getURL() === '') {
        try { loadURLInView(newId, 'min://newtab') } catch (eLoad) { /* renderer load is best-effort */ }
      }
      const winNow = windows.getCurrent()
      const attachedNow = winNow && !winNow.isDestroyed() && windows.getState(winNow).selectedView === newId
      if (!attachedNow && params.background !== true) {
        agentRpcAttachView(winNow, newId)
      }
      resolve({ tabId: String(newId), attached: params.background === true ? false : true, background: params.background === true })
    })
  })
}

function agentRpcCommandTabSelect (params) {
  return new Promise(function (resolve, reject) {
    const id = params.tabId
    if (!viewMap[id] || !viewMap[id].webContents || viewMap[id].webContents.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
      return
    }
    /* single-window scope: use the currently focused window. */
    const win = windows.getCurrent()
    if (!win || win.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'no open window'))
      return
    }
    const attached = agentRpcAttachView(win, id)
    if (!attached) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view is not ready for attachment (first URL not loaded yet)'))
      return
    }
    try { viewMap[id].webContents.focus() } catch (e2) { /* focus is best-effort */ }
    resolve({ tabId: String(id), attached: true })
  })
}

function agentRpcCommandTabClose (params) {
  return new Promise(function (resolve, reject) {
    const id = params.tabId
    agentRpcHeartbeat('tab-close begin id=' + id)
    if (!viewMap[id]) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
      return
    }
    if (Object.keys(viewMap).length <= 1) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.last_tab, 'last_tab', 'cannot close the last tab'))
      return
    }
    agentRpcClearSnapshotRefs(String(id))
    agentRpcClearTransforms(String(id))
    /* P1-00A: the P0-08 wedge family wraps destroy()/post-detach operations.
     * Instead of wc.destroy(), use the graceful wc.close() and clean the maps
     * immediately; the 'closed' event fires asynchronously when the page exits.
     * The view is detached from every window first (the renderer pipeline may
     * still hold it attached). */
    windows.getAll().forEach(function (window) {
      try {
        const content = window.getContentView()
        if (content.children.indexOf(viewMap[id]) !== -1) {
          content.removeChildView(viewMap[id])
          if (windows.getState(window).selectedView === id) windows.getState(window).selectedView = null
        }
      } catch (eDet) { /* window mid-layout; detach is best-effort */ }
    })
    try {
      agentRpcMouseAbort(String(id))
      viewMap[id].webContents.close()
      agentRpcLog('tab close: graceful close requested, views live=' + Object.keys(viewMap).length)
    } catch (eClose) {
      /* close() may throw on an already-dead wc; fall back to destroy once */
      try { viewMap[id].webContents.destroy() } catch (e2) { /* already gone */ }
      agentRpcLog('tab close: close() unavailable, destroyed instead')
    }
    delete viewMap[id]
    delete viewStateMap[id]
    agentRpcHeartbeat('tab-close done')
    resolve({ tabId: String(id), closed: true })
  })
}

/* ---------- P1-01 Stage 2: generic browser primitives ---------- *
 * browser_content, browser_wait, browser_hover, browser_scroll,
 * browser_select, browser_check, browser_downloads.
 * Fixed sources only; args are validated scalars. See docs/RESTRICTION-AUDIT.md
 * items B7, C1/C2, C9, D1/D2, G1, H1. */

/* download tracking (read-only observation of Min's flow; no interference) */
var AGENT_RPC_DOWNLOADS = []
var AGENT_RPC_DOWNLOAD_SEQ = 0
var AGENT_RPC_DOWNLOAD_SESSIONS = new WeakSet()
var AGENT_RPC_NET_INFLIGHT = 0
var AGENT_RPC_SESSION_HOOKED = new WeakSet()

function agentRpcEnsureDownloadTracking (ses) {
  if (AGENT_RPC_DOWNLOAD_SESSIONS.has(ses)) return
  AGENT_RPC_DOWNLOAD_SESSIONS.add(ses)
  try {
    ses.on('will-download', function (event, item, webContents) {
      const id = 'dl' + (++AGENT_RPC_DOWNLOAD_SEQ)
      const rec = {
        id: id, filename: item.getFilename(), mimeType: item.getMimeType(),
        received: item.getReceivedBytes(), total: item.getTotalBytes(),
        state: 'started', startedAt: new Date().toISOString()
      }
      AGENT_RPC_DOWNLOADS.push(rec)
      if (AGENT_RPC_DOWNLOADS.length > 50) AGENT_RPC_DOWNLOADS.shift()
      try {
        item.on('updated', function (e2, state2) {
          rec.received = item.getReceivedBytes()
          rec.state = state2 === 'interrupted' ? 'interrupted' : 'progressing'
          if (item.getSavePath()) rec.path = item.getSavePath()
        })
        item.on('done', function (e3, state2) {
          rec.state = state2 === 'completed' ? 'completed' : state2
          rec.received = item.getReceivedBytes()
          if (item.getSavePath()) rec.path = item.getSavePath()
        })
      } catch (eItem) { /* item listeners unavailable */ }
    })
  } catch (e) { /* session hook unavailable */ }
}

/* ---------- P1-05: agent-managed downloads ---------- *
 * Ownership is centralized in the existing human will-download path:
 * main/download.js downloadHandler() calls agentRpcDownloadManagedHook()
 * FIRST (same hoisted-hook pattern as the P1-01D ad-blocker bridge), and the
 * hook returns true ONLY for downloads explicitly owned by an authorized
 * agent action (direct downloadURL intent or an armed tab). Everything else
 * keeps 100% human behavior: save dialog, download UI, cancel IPC.
 * NO new will-download listener is registered for this feature.
 * Electron note: adoption uses setSavePath() only — preventDefault() is NOT
 * used (it would abandon Electron's transfer entirely, see docs/P1-05-DESIGN.md). */
const AGENT_RPC_DL_ROOT_SEGMENT = 'agent-downloads'
var AGENT_RPC_DL_SEQ = 0
var AGENT_RPC_DL_INTENTS = new Map() /* intentId -> pending direct-download intent */
var AGENT_RPC_DL_MANAGED = new Map() /* downloadId -> managed record */
var AGENT_RPC_DL_ARMED = new Map() /* webContents id -> {session, expires, relPath, resolve, reject} */
var AGENT_RPC_DL_TERMINAL = { completed: 1, cancelled: 1, interrupted: 1, failed: 1 }

function agentRpcDlRoot () {
  const root = agentRpcPath.join(app.getPath('userData'), AGENT_RPC_DL_ROOT_SEGMENT)
  try { agentRpcFs.mkdirSync(root, { recursive: true }) } catch (eR) { /* per-write errors surface later */ }
  return root
}

/* Windows-aware relative path validation. Rejects absolute paths, drive/
 * UNC prefixes, traversal, reserved device names, invalid characters and
 * trailing dot/space segments. Returns { ok, rel?, reason? }. */
function agentRpcDlValidateRelPath (raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: true, rel: '' }
  if (raw.length > 240) return { ok: false, reason: 'relPath too long (max 240)' }
  const win = process.platform === 'win32'
  if (/^[a-zA-Z]:/.test(raw)) return { ok: false, reason: 'drive paths are not allowed' }
  if (raw.indexOf('\\\\') === 0 || raw.indexOf('//') === 0) return { ok: false, reason: 'UNC/network paths are not allowed' }
  if (agentRpcPath.posix.isAbsolute(raw) || agentRpcPath.win32.isAbsolute(raw)) return { ok: false, reason: 'absolute paths are not allowed' }
  const segs = raw.split(/[\\/]+/).filter(function (s2) { return s2.length > 0 })
  if (segs.length === 0) return { ok: true, rel: '' }
  if (segs.length > 30) return { ok: false, reason: 'too many path segments (max 30)' }
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si]
    if (seg === '.' || seg === '..') return { ok: false, reason: "'.' and '..' segments are not allowed" }
    if (win && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]*)?$/i.test(seg)) return { ok: false, reason: 'reserved Windows device name: ' + seg }
    for (let ci = 0; ci < seg.length; ci++) {
      const code = seg.charCodeAt(ci)
      if (code < 32 || code === 127) return { ok: false, reason: 'control characters are not allowed in relPath' }
    }
    if (/[<>:"|?*]/.test(seg)) return { ok: false, reason: "invalid path characters (< > : \" | ? *)" }
    if (/[. ]$/.test(seg)) return { ok: false, reason: 'segments must not end with a dot or space' }
  }
  return { ok: true, rel: segs.join('/') }
}

/* Sanitize a server-supplied filename (Content-Disposition etc.): basename
 * only, control/invalid characters replaced, device names rejected. */
function agentRpcDlSanitizeName (rawName) {
  let name = String(rawName === undefined || rawName === null ? '' : rawName)
  name = name.split(/[\\/]+/).pop() || ''
  let out = ''
  for (let ci = 0; ci < name.length; ci++) {
    const code = name.charCodeAt(ci)
    const ch = (code < 32 || code === 127) ? '_' : name.charAt(ci)
    out += /[<>:"|?*]/.test(ch) ? '_' : ch
  }
  out = out.replace(/[. ]+$/g, '').slice(0, 120)
  if (!out || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]*)?$/i.test(out)) out = 'download.bin'
  return out
}

/* Collision policy: never overwrite — deterministic ' name (N).ext ' suffix. */
function agentRpcDlUniqueDest (absPath) {
  if (!agentRpcFs.existsSync(absPath)) return absPath
  const dir = agentRpcPath.dirname(absPath)
  const ext = agentRpcPath.extname(absPath)
  const base = agentRpcPath.basename(absPath, ext)
  for (let n = 2; n < 1000; n++) {
    const cand = agentRpcPath.join(dir, base + ' (' + n + ')' + ext)
    if (!agentRpcFs.existsSync(cand)) return cand
  }
  return null
}

/* Containment proof beyond string prefixes: resolve and compare relative
 * parts case-insensitively (Windows), and refuse symlink/junction members. */
function agentRpcDlContainmentOk (root, absPath) {
  let rel = agentRpcPath.relative(root, absPath)
  if (!rel || rel === '') return false
  if (agentRpcPath.isAbsolute(rel) || rel.split(agentRpcPath.sep)[0] === '..') return false
  if (process.platform === 'win32' && /^\.\.([\\/]|$)/i.test(rel)) return false
  if (agentRpcPath.relative(root.toLowerCase(), absPath.toLowerCase()).split(agentRpcPath.sep)[0] === '..') return false
  /* symlink/junction walk: no member of the may-exist prefix chain may be a
   * symbolic link (bounded, 30 levels) */
  let cur = root
  const parts = agentRpcPath.relative(root, absPath).split(agentRpcPath.sep)
  for (let pi = 0; pi < parts.length && pi < 30; pi++) {
    cur = agentRpcPath.join(cur, parts[pi])
    try {
      const st = agentRpcFs.lstatSync(cur)
      if (st.isSymbolicLink()) return false
      if (pi < parts.length - 1 && !st.isDirectory()) return false
    } catch (eL) { /* does not exist yet — fine */ }
  }
  return true
}

function agentRpcDlPrune () {
  const now = Date.now()
  AGENT_RPC_DL_INTENTS.forEach(function (intent, id) {
    if (intent.expires < now) {
      AGENT_RPC_DL_INTENTS.delete(id)
      if (intent.reject && intent.pending) { intent.pending = false; intent.reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'download intent expired before adoption')) }
    }
  })
  AGENT_RPC_DL_MANAGED.forEach(function (rec, id) {
    if (rec.terminal && rec.endedAt && now - rec.endedAt > 3600000) AGENT_RPC_DL_MANAGED.delete(id)
  })
  const caps = Array.from(AGENT_RPC_DL_MANAGED.keys())
  while (caps.length > 100) { AGENT_RPC_DL_MANAGED.delete(caps.shift()) }
}
setInterval(agentRpcDlPrune, 60000).unref()

/* resolve the tabId pinned to a webContents (null when not a known view) */
function agentRpcDlTabIdFor (wc) {
  for (const id of Object.keys(viewMap)) {
    if (viewMap[id] && viewMap[id].webContents === wc) return String(id)
  }
  return null
}

function agentRpcDlPublicRec (rec) {
  return {
    downloadId: rec.id,
    tabId: rec.tabId,
    kind: rec.kind,
    originHost: rec.originHost,
    url: rec.urlPath, /* origin + pathname; query/hash dropped (never echo signed URLs) */
    filename: rec.filename,
    relPath: rec.relPath,
    state: rec.state,
    received: rec.received,
    total: rec.total === undefined ? null : rec.total,
    canResume: rec.canResume,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt || null,
    error: rec.error || null
  }
}

/* The centralized managed-ownership hook. Called from main/download.js
 * downloadHandler() before any human-flow side effects. Returns true when
 * the download was adopted (preventDefault + setSavePath already done). */
function agentRpcDownloadManagedHook (event, item, wc) {
  try {
    agentRpcDlPrune()
    let intent = null
    let intentId = null
    AGENT_RPC_DL_INTENTS.forEach(function (it, id) {
      if (intent || it.consumed) return
      if (it.kind === 'direct' && it.wc === wc && it.session === wc.session) { intent = it; intentId = id }
    })
    let arm = null
    if (!intent && wc.id !== undefined && AGENT_RPC_DL_ARMED.has(wc.id)) {
      arm = AGENT_RPC_DL_ARMED.get(wc.id)
      if (arm.expires < Date.now()) { arm = null; AGENT_RPC_DL_ARMED.delete(wc.id) }
    }
    if (!intent && !arm) return false
    let relPath = ''
    let filename = ''
    if (intent) {
      relPath = intent.relPath
      const base = agentRpcPath.basename(relPath || '')
      filename = base || agentRpcDlSanitizeName(item.getFilename())
      if (!base) relPath = filename
    } else {
      filename = agentRpcDlSanitizeName(item.getFilename())
      relPath = arm.relPath ? agentRpcPath.posix.join(arm.relPath, filename) : filename
    }
    const vRel = agentRpcDlValidateRelPath(relPath)
    if (!vRel.ok) {
      /* structured refusal WITHOUT adopting: let the human flow run */
      if (intent && intent.reject && intent.pending) { intent.pending = false; intent.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'relPath rejected: ' + vRel.reason)) }
      AGENT_RPC_DL_INTENTS.delete(intentId)
      return false
    }
    let abs = agentRpcPath.resolve(agentRpcDlRoot(), vRel.rel)
    if (!agentRpcDlContainmentOk(agentRpcDlRoot(), abs)) {
      if (intent && intent.reject && intent.pending) { intent.pending = false; intent.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'destination escapes the approved download root')) }
      AGENT_RPC_DL_INTENTS.delete(intentId)
      return false
    }
    const unique = agentRpcDlUniqueDest(abs)
    if (!unique) {
      if (intent && intent.reject && intent.pending) { intent.pending = false; intent.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'could not compute a unique destination')) }
      AGENT_RPC_DL_INTENTS.delete(intentId)
      return false
    }
    abs = unique
    /* Electron will not create missing destination directories — build them
     * (bounded to the validated segment count inside the root). */
    try { agentRpcFs.mkdirSync(agentRpcPath.dirname(abs), { recursive: true }) } catch (eMkd) {
      if (intent && intent.reject && intent.pending) { intent.pending = false; intent.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'could not create destination directory: ' + eMkd.message)) }
      AGENT_RPC_DL_INTENTS.delete(intentId)
      return false
    }
    /* NOTE (verified against Electron 43.4.1 behavior, see isolate harness):
     * setSavePath() ALONE suppresses the save dialog and lets the item
     * download normally. Calling event.preventDefault() here instead tells
     * Electron to abandon its own download handling entirely — the item
     * terminates immediately with done=cancelled and zero bytes. */
    item.setSavePath(abs)
    const id = 'dlm' + (++AGENT_RPC_DL_SEQ)
    let originHost = ''
    let urlPath = ''
    try { const u = new URL(item.getURL()); originHost = u.host; urlPath = u.origin + u.pathname } catch (eU) { /* opaque */ }
    const rec = {
      id: id,
      kind: intent ? 'direct' : 'site',
      tabId: agentRpcDlTabIdFor(wc),
      originHost: originHost,
      urlPath: urlPath,
      filename: agentRpcPath.basename(abs),
      relPath: agentRpcPath.relative(agentRpcDlRoot(), abs).split(agentRpcPath.sep).join('/'),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      canResume: false,
      startedAt: new Date().toISOString(),
      endedAt: 0,
      terminal: false,
      item: item,
      waiters: []
    }
    AGENT_RPC_DL_MANAGED.set(id, rec)
    if (intent) {
      AGENT_RPC_DL_INTENTS.delete(intentId)
      if (intent.resolve && intent.pending) { intent.pending = false; intent.resolve({ ok: true, downloadId: id, filename: rec.filename, relPath: rec.relPath, state: rec.state, total: rec.total }) }
    }
    if (arm && wc.id !== undefined) {
      AGENT_RPC_DL_ARMED.delete(wc.id)
      if (arm.resolve && arm.pending) { arm.pending = false; arm.resolve({ ok: true, downloadId: id, kind: 'site', filename: rec.filename, relPath: rec.relPath, state: rec.state, total: rec.total }) }
    }
    try {
      item.on('updated', function (e2, st2) {
        rec.received = item.getReceivedBytes()
        if (st2 === 'interrupted') {
          rec.state = 'interrupted'
          rec.terminal = true
          rec.endedAt = Date.now()
          rec.error = 'download interrupted (network/server)'
        } else if (!rec.terminal) {
          rec.state = 'progressing'
        }
        agentRpcDlFlushWaiters(rec)
      })
      item.once('done', function (e3, st3) {
        rec.received = item.getReceivedBytes()
        rec.state = st3 === 'completed' ? 'completed' : (st3 === 'cancelled' ? 'cancelled' : (st3 === 'interrupted' ? 'interrupted' : st3))
        rec.terminal = true
        rec.endedAt = Date.now()
        rec.canResume = rec.state === 'interrupted' && item.canResume()
        rec.item = null
        agentRpcDlFlushWaiters(rec)
      })
    } catch (eItem2) { /* item events unavailable; record stays as-is */ }
    return true
  } catch (eHook) {
    return false /* any internal error degrades to the human flow */
  }
}

function agentRpcDlFlushWaiters (rec) {
  const ws = rec.waiters || []
  rec.waiters = ws.filter(function (w) {
    if (!rec.terminal) return true
    clearTimeout(w.timer)
    try { w.resolve(agentRpcDlPublicRec(rec)) } catch (eW) { /* gone */ }
    return false
  })
}

function agentRpcDlGetManaged (downloadId) {
  const rec = AGENT_RPC_DL_MANAGED.get(String(downloadId))
  if (!rec) throw agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'download_not_found', 'no managed download with this downloadId')
  return rec
}

function agentRpcCommandDownloadStart (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  const wc = view.webContents
  let rel = { ok: true, rel: '' }
  if (params.relPath !== undefined) rel = agentRpcDlValidateRelPath(params.relPath)
  if (!rel.ok) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'relPath rejected: ' + rel.reason))
  }
  if (rel.rel && !agentRpcDlContainmentOk(agentRpcDlRoot(), agentRpcPath.resolve(agentRpcDlRoot(), rel.rel))) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'relPath escapes the approved download root'))
  }
  agentRpcDlPrune()
  if (params.url !== undefined) {
    if (params.armMs !== undefined) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'provide either url (direct download) or armMs (page-triggered adoption), not both'))
    }
    let parsed = null
    try { parsed = new URL(params.url) } catch (eU) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'malformed download URL'))
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'only http/https download URLs are allowed'))
    }
    if (parsed.username || parsed.password) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'URLs with embedded credentials are not allowed'))
    }
    const urlCheck = agentRpcValidateUrl(params.url, { 'http:': 1, 'https:': 1 })
    if (!urlCheck.ok) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', urlCheck.reason))
    }
    const intentId = 'i' + (++AGENT_RPC_DL_SEQ)
    return new Promise(function (resolve, reject) {
      const intent = {
        kind: 'direct',
        url: params.url,
        wc: wc,
        session: wc.session,
        relPath: rel.rel,
        expires: Date.now() + 30000,
        pending: true,
        resolve: resolve,
        reject: reject
      }
      AGENT_RPC_DL_INTENTS.set(intentId, intent)
      setTimeout(function () {
        if (intent.pending) {
          intent.pending = false
          AGENT_RPC_DL_INTENTS.delete(intentId)
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'download was not adopted within 20s (no will-download event from this tab)'))
        }
      }, 20000)
      try {
        wc.downloadURL(params.url)
      } catch (eDl) {
        if (intent.pending) {
          intent.pending = false
          AGENT_RPC_DL_INTENTS.delete(intentId)
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'downloadURL could not be started: ' + eDl.message))
        }
      }
    })
  }
  if (params.armMs !== undefined) {
    return new Promise(function (resolve, reject) {
      if (AGENT_RPC_DL_ARMED.has(wc.id)) {
        const prev = AGENT_RPC_DL_ARMED.get(wc.id)
        if (prev.reject && prev.pending) { prev.pending = false; prev.reject(agentRpcCommandError(AGENT_RPC_ERRORS.busy, 'busy', 'tab already has an armed download adoption pending')) }
      }
      const arm = {
        session: wc.session,
        relPath: rel.rel,
        expires: Date.now() + params.armMs,
        pending: true,
        resolve: resolve,
        reject: reject
      }
      AGENT_RPC_DL_ARMED.set(wc.id, arm)
      setTimeout(function () {
        if (arm.pending) {
          arm.pending = false
          AGENT_RPC_DL_ARMED.delete(wc.id)
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'no page-triggered download occurred in this tab within armMs'))
        }
      }, params.armMs + 500)
    })
  }
  return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'provide url (direct download) or armMs (page-triggered adoption)'))
}

function agentRpcCommandDownloadWait (params) {
  let rec
  try { rec = agentRpcDlGetManaged(params.downloadId) } catch (e) { return Promise.reject(e) }
  if (rec.terminal) return Promise.resolve(agentRpcDlPublicRec(rec))
  const timeoutMs = params.timeoutMs === undefined ? 30000 : params.timeoutMs
  return new Promise(function (resolve) {
    const w = {
      timer: setTimeout(function () {
        rec.waiters = rec.waiters.filter(function (x) { return x !== w })
        resolve({ downloadId: rec.id, state: rec.state, terminal: false, timedOut: true, received: rec.received, total: rec.total === undefined ? null : rec.total })
      }, timeoutMs),
      resolve: resolve
    }
    rec.waiters.push(w)
  })
}

function agentRpcCommandDownloadCancel (params) {
  let rec
  try { rec = agentRpcDlGetManaged(params.downloadId) } catch (e) { return Promise.reject(e) }
  if (rec.terminal || !rec.item) {
    return Promise.resolve({ downloadId: rec.id, cancelled: false, state: rec.state, reason: 'already-terminal' })
  }
  return new Promise(function (resolve) {
    const timer = setTimeout(function () {
      done(false)
    }, 5000)
    function done (confirmed) {
      clearTimeout(timer)
      resolve({ downloadId: rec.id, cancelled: rec.state === 'cancelled', state: rec.state, confirmed: confirmed })
    }
    const onDone = function (e3, st3) {
      item.removeListener('done', onDone)
      done(st3 === 'cancelled')
    }
    const item = rec.item
    try { item.on('done', onDone) } catch (eEv) { done(false) }
    try { item.cancel() } catch (eC) {
      item.removeListener && item.removeListener('done', onDone)
      done(false)
      rec.error = 'cancel() failed: ' + eC.message
    }
  })
}

function agentRpcCommandDownloadPause (params) {
  let rec
  try { rec = agentRpcDlGetManaged(params.downloadId) } catch (e) { return Promise.reject(e) }
  if (rec.terminal || !rec.item) {
    return Promise.resolve({ downloadId: rec.id, paused: false, state: rec.state, reason: 'already-terminal' })
  }
  if (rec.state !== 'progressing') {
    return Promise.resolve({ downloadId: rec.id, paused: false, state: rec.state, reason: 'not in a pausable state' })
  }
  try {
    rec.item.pause()
    rec.state = 'paused'
    return Promise.resolve({ downloadId: rec.id, paused: true, state: 'paused' })
  } catch (eP) {
    return Promise.resolve({ downloadId: rec.id, paused: false, state: rec.state, reason: 'pause() refused: ' + eP.message })
  }
}

function agentRpcCommandDownloadResume (params) {
  let rec
  try { rec = agentRpcDlGetManaged(params.downloadId) } catch (e) { return Promise.reject(e) }
  if (rec.terminal || !rec.item) {
    return Promise.resolve({ downloadId: rec.id, resumed: false, state: rec.state, reason: 'already-terminal' })
  }
  let canResume = false
  try { canResume = rec.item.canResume() } catch (eR) { canResume = false }
  rec.canResume = canResume
  if (rec.state !== 'paused' && rec.state !== 'interrupted') {
    return Promise.resolve({ downloadId: rec.id, resumed: false, state: rec.state, reason: 'resume requires a paused or interrupted download' })
  }
  if (!canResume) {
    return Promise.resolve({ downloadId: rec.id, resumed: false, state: rec.state, reason: 'resume not supported for this transfer (server/geometry does not allow it; a restart would not be a resume)' })
  }
  try {
    rec.item.resume()
    rec.state = 'progressing'
    return Promise.resolve({ downloadId: rec.id, resumed: true, state: 'progressing' })
  } catch (eR2) {
    return Promise.resolve({ downloadId: rec.id, resumed: false, state: rec.state, reason: 'resume() refused: ' + eR2.message })
  }
}




function agentRpcDerivedBounds (bwin) {
  try {
    const cb = bwin.getContentBounds()
    return { x: 0, y: 36, width: cb.width, height: Math.max(1, cb.height - 36) }
  } catch (eDB) {
    return null
  }
}

function agentRpcBoundsHealthy (b) {
  return !!(b && b.width > 1 && b.height > 400)
}

function agentRpcEnsureViewAttachedAndSelected (tabId) {
  try {
    const view = viewMap[tabId]
    if (!view) return false
    const wasAttached = (typeof isViewAttachedToAnyWindow === 'function') ? isViewAttachedToAnyWindow(view) : true
    let curB = null
    try { curB = (typeof view.getBounds === 'function') ? view.getBounds() : null } catch (eB0) { curB = null }
    if (wasAttached && agentRpcBoundsHealthy(curB)) return true
    const bwin = windows.getCurrent()
    if (!bwin) return false
    if (agentRpcBoundsHealthy(curB)) { AGENT_RPC_BOUNDS_STORE.set(String(tabId), curB) }
    bwin.getContentView().children.slice(1).forEach(function (child) { bwin.getContentView().removeChildView(child) })
    if (viewStateMap[tabId] && viewStateMap[tabId].loadedInitialURL) {
      bwin.getContentView().addChildView(view)
    }
    windows.getState(bwin).selectedView = tabId
    const stored = AGENT_RPC_BOUNDS_STORE.get(String(tabId))
    if (stored) { try { view.setBounds(stored) } catch (eSB) { } }
    else { const dv = agentRpcDerivedBounds(bwin); if (dv) { try { view.setBounds(dv) } catch (eSB2) { } } }
    const isAttachedNow = (typeof isViewAttachedToAnyWindow === 'function') ? isViewAttachedToAnyWindow(view) : true
    if (isAttachedNow) {
      try {
        const uiwc = (typeof getWindowWebContents === 'function') ? getWindowWebContents(bwin) : null
        if (uiwc) { uiwc.executeJavaScript("window.dispatchEvent(new Event('resize'))") }
      } catch (eRz) { /* best effort */ }
    }
    return isAttachedNow
  } catch (eA) {
    return false
  }
}



/* ---------- P1-06: typed mouse (viewport CSS px; explicit tabId) ---------- *
 * sendInputEvent dispatch is ELECTRON PAGE-LEVEL input: it does NOT move the
 * real Windows cursor. The OS-global cursor is a separate mechanism and is
 * NOT implemented in this phase (no safe native provider in-repo). */
var AGENT_RPC_MOUSE_BTN = { left: 1, right: 1, middle: 1 }

function agentRpcMouseBounds (view) {
  const b = (typeof view.getBounds === 'function' ? view.getBounds() : null) || { width: 0, height: 0 }
  return b
}

function agentRpcMousePt (raw, bounds) {
  if (typeof raw.x !== 'number' || typeof raw.y !== 'number') return null
  if (raw.x < 0 || raw.y < 0 || raw.x > bounds.width - 1 || raw.y > bounds.height - 1) return null
  return { x: Math.round(raw.x), y: Math.round(raw.y) }
}

function agentRpcMouseSendMove (wc, p) { wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }) }

function agentRpcMouseEase (t) {
  if (t < 0.5) return 2 * t * t
  return 1 - Math.pow(-2 * t + 2, 2) / 2
}

function agentRpcMouseShotStaleness (tabId, screenshotId, wc) {
  const rec = AGENT_RPC_SCREENSHOTS.get(String(screenshotId))
  if (!rec) { throw agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'unknown screenshotId ' + String(screenshotId)) }
  if (rec.tabId !== String(tabId)) { throw agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'screenshotId belongs to a different tab') }
  return agentRplFetchViewportMeta(wc).then(function (meta) {
    let urlNow = null
    try { const u2 = new URL(wc.getURL()); urlNow = u2.origin + u2.pathname } catch (e2) { /* opaque */ }
    const diffs = []
    if (rec.urlPath && urlNow && rec.urlPath !== urlNow) diffs.push('document changed')
    if (rec.zoom && Math.abs(wc.getZoomFactor() - rec.zoom) > 0.001) diffs.push('zoom changed')
    if (meta) {
      if (rec.viewport.width !== null && meta.iw !== rec.viewport.width) diffs.push('viewport width changed')
      if (rec.viewport.height !== null && meta.ih !== rec.viewport.height) diffs.push('viewport height changed')
      if (rec.viewport.dpr !== null && meta.dpr !== rec.viewport.dpr) diffs.push('devicePixelRatio changed')
      if (rec.viewport.scrollX !== null && Math.abs(meta.sx - rec.viewport.scrollX) > 2) diffs.push('scrollX changed')
      if (rec.viewport.scrollY !== null && Math.abs(meta.sy - rec.viewport.scrollY) > 2) diffs.push('scrollY changed')
    }
    if (diffs.length > 0) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', 'screenshot coordinates are stale: ' + diffs.join('; '))
    }
    return rec
  })
}

function agentRpcCommandMouse (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  /* P1-06.3: action 'status' is OBSERVATIONAL ONLY — no selection, no attach,
   * no focus change, no input. Served before any view-state mutation. */
  if (params.action === 'status') {
    return Promise.resolve({ tabId: String(params.tabId), pressed: AGENT_RPC_MOUSE_PRESSED.get(String(params.tabId)) || null, busy: AGENT_RPC_MOUSE_BUSY.has(String(params.tabId)), last: AGENT_RPC_MOUSE_LASTPOS.get(String(params.tabId)) || null })
  }
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  /* P1-06.3: attach/select the target view FIRST through the shared helper,
   * and only then enforce the attached contract — the previous order rejected
   * detached targets before the attach logic could ever run. */
  const attachedNow = agentRpcEnsureViewAttachedAndSelected(String(params.tabId))
  if (typeof isViewAttachedToAnyWindow === 'function' && !attachedNow && !isViewAttachedToAnyWindow(view)) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.view_not_attached, 'view_not_attached', 'mouse actions require an attached view; the tab could not be safely selected'))
  }
  /* P1-06.1: dispatch-time bounds correction — Min's renderer may send a late
   * collapsed bounds update (e.g. 2032x200) after re-attach; restore the last
   * known healthy bounds so coordinates stay valid. */
  try {
    const bad = (typeof view.getBounds === 'function') ? view.getBounds() : null
    const good = AGENT_RPC_BOUNDS_STORE.get(String(params.tabId))
    if (bad && good && (bad.height < 300 || bad.width < 300) && good.height > bad.height && viewMap[params.tabId]) {
      viewMap[params.tabId].setBounds(good)
    }
  } catch (eBC) { /* best effort */ }
  const wc = view.webContents
  /* P1-06.1: ensure the target view is attached+selected in Min's composition.
   * Root cause of the P1-06 move-delivery failure: a spawned-URL tab can remain
   * DETACHED (Min's window state keeps a different selectedView); detached
   * views still process mouseDown/Up (so clicks seemed to work) but drop
   * standalone mouseMove/mouseWheel. Mirrors viewManager.setView() without the
   * sender webContents (bridge acts on its own explicit-tabId contract). This
   * makes the target tab the visible surface for its own mouse actions. */
  try {
    const bwin2 = windows.getCurrent()
    if (bwin2 && windows.getState(bwin2).selectedView !== viewMap[params.tabId]) {
      /* capture the target view's last-known healthy bounds — Min's renderer
       * re-sent bounds only via resize events, which do not fire on a
       * programmatic select; without this the re-attached view collapses.
       * The renderer's (late, collapsed) update is also re-corrected at
       * +250/+700/+1500ms and at every dispatch below. */
      const savedB = (typeof view.getBounds === 'function') ? view.getBounds() : null
      if (savedB && savedB.width > 1 && savedB.height > 400) { AGENT_RPC_BOUNDS_STORE.set(String(params.tabId), savedB) }
      bwin2.getContentView().children.slice(1).forEach(function (child) { bwin2.getContentView().removeChildView(child) })
      if (viewStateMap[params.tabId] && viewStateMap[params.tabId].loadedInitialURL) {
        bwin2.getContentView().addChildView(viewMap[params.tabId])
      }
      windows.getState(bwin2).selectedView = params.tabId
      const applyB = function () {
        const stored = AGENT_RPC_BOUNDS_STORE.get(String(params.tabId))
        if (stored && viewMap[params.tabId]) { try { viewMap[params.tabId].setBounds(stored) } catch (eSB) { } }
      }
      if (savedB && savedB.width > 1 && savedB.height > 1) { applyB() } else { try { const cb = bwin2.getContentBounds(); view.setBounds({ x: 0, y: 36, width: cb.width, height: Math.max(1, cb.height - 36) }) } catch (eSB2) { } }
      /* make Min's own renderer recompute and send correct view bounds (fixed
       * literal source — no request data) */
      try {
        const uiwc = getWindowWebContents(bwin2)
        if (uiwc) { uiwc.executeJavaScript("window.dispatchEvent(new Event('resize'))") } 
      } catch (eRz) { /* best effort */ }
    }
  } catch (eAttach) { /* best-effort; failures surface as structured errors below */ }
  const bounds = agentRpcMouseBounds(view)
  if (!(bounds.width > 1 && bounds.height > 1)) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no usable viewport bounds (width=' + bounds.width + ', height=' + bounds.height + ')'))
  }
  /* Electron-on-Windows: synthesized mouseMove/mouseWheel require the hosting
   * window to be focused (isolation-harness evidence, P1-06). Focusing Min is
   * expected for agent-driven page input (explicit tabId semantics keep the
   * action on the requested tab). status does not dispatch, so no focus. */
  const action = params.action
  const btn = AGENT_RPC_MOUSE_BTN[params.button || 'left'] ? (params.button || 'left') : null
  const startedAt = Date.now()
  const tabIdS = String(params.tabId)


  /* staleness gate: explicit screenshotId coordinates are only valid while the
   * tab, document, viewport, zoom and scroll state are unchanged */
  const shotChain = params.screenshotId !== undefined
    ? agentRpcMouseShotStaleness(params.tabId, params.screenshotId, wc)
    : Promise.resolve(null)

  return shotChain.then(function (shotRec) {
    if ((action === 'move' || action === 'hover' || action === 'click' || action === 'rightClick' || action === 'down' || action === 'up' || action === 'scroll') && (params.x !== undefined || params.y !== undefined)) {
      const pt = agentRpcMousePt(params, bounds)
      if (!pt) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'x/y out of bounds (' + bounds.width + 'x' + bounds.height + ' viewport; got ' + params.x + ',' + params.y + ')')
      }
      if (action === 'move' || action === 'hover' || action === 'down' || action === 'scroll') {
        agentRpcMouseSendMove(wc, pt)
        AGENT_RPC_MOUSE_LASTPOS.set(tabIdS, pt)
      }
      if (action === 'click' || action === 'rightClick') {
        agentRpcMouseSendMove(wc, pt)
        AGENT_RPC_MOUSE_LASTPOS.set(tabIdS, pt)
        wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: action === 'rightClick' ? 'right' : (btn || 'left'), clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: action === 'rightClick' ? 'right' : (btn || 'left'), clickCount: 1 })
      }
      if (action === 'down') {
        wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: btn || 'left', clickCount: 1 })
        AGENT_RPC_MOUSE_PRESSED.set(tabIdS, btn || 'left')
      }
      if (action === 'scroll') {
        const dx = params.deltaX === undefined ? 0 : params.deltaX
        const dy = params.deltaY === undefined ? 0 : params.deltaY
        wc.sendInputEvent({ type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: dx, deltaY: dy, canScroll: true })
        return { tabId: tabIdS, action: 'scroll', dispatched: true, deltaX: dx, deltaY: dy, ms: Date.now() - startedAt, note: 'mouseWheel synthesized per Electron contract with canScroll:true; on this Electron build/OS synthesized wheel events are dropped by the compositor (verified by isolation harness + page counters) - use browser_scroll for reliable DOM-level scrolling' }
      }
      if (action === 'up') {
        const last = AGENT_RPC_MOUSE_LASTPOS.get(tabIdS) || pt
        wc.sendInputEvent({ type: 'mouseUp', x: last.x, y: last.y, button: btn || 'left', clickCount: 1 })
        AGENT_RPC_MOUSE_PRESSED.delete(tabIdS)
      }
      return { tabId: tabIdS, action: action, dispatched: true, x: pt.x, y: pt.y, screenshotId: params.screenshotId || null, screenshotCheck: shotRec ? 'verified' : null, delivery: 'unverified', deliveryNote: 'standalone mouseMove delivery is dropped by the compositor in Min production windows on this Electron build (P1-06.1); verify page effects via browser_verify/snapshot, or use click/down/up which deliver reliably', ms: Date.now() - startedAt }
    }

    if (action === 'up') {
      const last = AGENT_RPC_MOUSE_LASTPOS.get(tabIdS) || { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) }
      wc.sendInputEvent({ type: 'mouseUp', x: last.x, y: last.y, button: btn || 'left', clickCount: 1 })
      AGENT_RPC_MOUSE_PRESSED.delete(tabIdS)
      return { tabId: tabIdS, action: 'up', dispatched: true, x: last.x, y: last.y, ms: Date.now() - startedAt }
    }

    if (action === 'move' || action === 'hover') {
      const last = AGENT_RPC_MOUSE_LASTPOS.get(tabIdS) || { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) }
      agentRpcMouseSendMove(wc, last)
      AGENT_RPC_MOUSE_LASTPOS.set(tabIdS, last)
      return { tabId: tabIdS, action: action, dispatched: true, x: last.x, y: last.y, ms: Date.now() - startedAt }
    }

    if (action === 'movePath' || action === 'drag') {
      if (AGENT_RPC_MOUSE_BUSY.has(tabIdS)) {
        return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.busy, 'busy', 'a mouse path job is already running on this tab; wait or cancel first'))
      }
      const toPt = agentRpcMousePt({ x: params.toX, y: params.toY }, bounds)
      if (!toPt) {
        return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'toX/toY out of bounds (' + bounds.width + 'x' + bounds.height + ' viewport; got ' + params.toX + ',' + params.toY + ')'))
      }
      const fromPt = params.fromX !== undefined || params.fromY !== undefined
        ? agentRpcMousePt({ x: params.fromX, y: params.fromY }, bounds)
        : (AGENT_RPC_MOUSE_LASTPOS.get(tabIdS) || { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) })
      if (!fromPt) {
        return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'fromX/fromY out of bounds'))
      }
      const useBtn = btn || 'left'
      const mode = params.mode === 'instant' ? 'instant' : 'smooth'
      const duration = params.durationMs === undefined ? 500 : params.durationMs
      const steps = mode === 'instant'
        ? 1
        : Math.max(2, Math.min(params.steps === undefined ? Math.max(2, Math.round(duration / 16)) : params.steps, 240))
      const stepDelay = mode === 'instant' ? 0 : Math.max(8, Math.min(33, Math.round(duration / steps)))
      const useDrag = action === 'drag'
      try { wc.focus() } catch (eF2) { /* page focus for input routing */ }
      return new Promise(function (resolve, reject) {
        AGENT_RPC_MOUSE_BUSY.set(tabIdS, true)
        const job = { aborted: false, timer: null }
        const finish = function (out) {
          clearTimeout(job.timer)
          AGENT_RPC_MOUSE_JOBS.delete(tabIdS)
          AGENT_RPC_MOUSE_BUSY.delete(tabIdS)
          job.aborted = true
          AGENT_RPC_MOUSE_LASTPOS.set(tabIdS, { x: toPt.x, y: toPt.y })
          resolve(out)
        }
        const failAbort = function (msg, category) {
          clearTimeout(job.timer)
          AGENT_RPC_MOUSE_JOBS.delete(tabIdS)
          AGENT_RPC_MOUSE_BUSY.delete(tabIdS)
          job.aborted = true
          agentRpcMouseAbort(tabIdS)
          if (category) reject(agentRpcCommandError(AGENT_RPC_ERRORS[category] || AGENT_RPC_ERRORS.unsupported, category, msg))
          else reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', msg))
        }
        const guard = setTimeout(function () {
          if (!job.aborted) failAbort('mouse job exceeded its total time budget')
        }, duration * 3 + 8000)
        job.timer = guard
        AGENT_RPC_MOUSE_JOBS.set(tabIdS, job)
        const emit = function (i, doneCb) {
          if (job.aborted) { clearTimeout(guard); reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'mouse job aborted (navigation, tab close or newer job)')); return }
          const tt = steps <= 1 ? 1 : i / (steps - 1)
          const eased = mode === 'instant' ? 1 : agentRpcMouseEase(tt)
          const mp = { x: Math.round(fromPt.x + (toPt.x - fromPt.x) * eased), y: Math.round(fromPt.y + (toPt.y - fromPt.y) * eased) }
          agentRpcMouseSendMove(wc, mp)
          AGENT_RPC_MOUSE_LASTPOS.set(tabIdS, mp)
          try { require('fs').appendFileSync(require('os').tmpdir() + '/p1-06-mouse-debug.log', 'step ' + i + ' -> ' + mp.x + ',' + mp.y + '\n') } catch (eDbg) { }
          if (i + 1 < steps) { setTimeout(function () { emit(i + 1, doneCb) }, stepDelay) } else doneCb()
        }
        if (useDrag) {
          try {
            wc.sendInputEvent({ type: 'mouseDown', x: fromPt.x, y: fromPt.y, button: useBtn, clickCount: 1 })
            AGENT_RPC_MOUSE_PRESSED.set(tabIdS, useBtn)
          } catch (eD) { failAbort('mouseDown for drag failed: ' + eD.message); return }
        }
        emit(0, function () {
          if (useDrag) {
            try {
              wc.sendInputEvent({ type: 'mouseUp', x: toPt.x, y: toPt.y, button: useBtn, clickCount: 1 })
              AGENT_RPC_MOUSE_PRESSED.delete(tabIdS)
            } catch (eU) { failAbort('mouseUp for drag failed: ' + eU.message); return }
          }
          finish({ tabId: tabIdS, action: action, dispatched: true, steps: steps, mode: mode, from: fromPt, to: toPt, ms: Date.now() - startedAt, eventCount: steps + (useDrag ? 2 : 0), button: useDrag ? useBtn : null, delivery: 'unverified', deliveryNote: 'standalone mouseMove events of the path are dropped by the compositor in Min production windows on this Electron build (P1-06.1); button events deliver reliably' })
        })
      })
    }

    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'unknown or incomplete action: ' + action))
  })
}

/* P1-01D: network activity observation. Electron allows only ONE
 * onBeforeRequest listener per session — a second registration REPLACES the
 * previous one. Min's ad blocker (main/filtering.js registerFiltering) owns
 * that slot, so the bridge must NOT register its own. Instead, filtering's
 * handleRequest calls the hoisted bridgeside hook below (single concatenated
 * bundle scope), and the bridge only adds onCompleted/onErrorOccurred
 * decoders, which nobody else in this codebase registers. */
var AGENT_RPC_NET_INFLIGHT = 0
var AGENT_RPC_NET_OBSERVED_TOTAL = 0
var AGENT_RPC_NET_SETTLED_TOTAL = 0
function agentRpcNetworkRequestObserved () {
  AGENT_RPC_NET_OBSERVED_TOTAL++
  AGENT_RPC_NET_INFLIGHT++
}
var AGENT_RPC_NET_BLOCKED_TOTAL = 0
function agentRpcNetworkRequestBlocked () {
  AGENT_RPC_NET_BLOCKED_TOTAL++
}
function agentRpcNetworkRequestSettled () {
  AGENT_RPC_NET_INFLIGHT = Math.max(0, AGENT_RPC_NET_INFLIGHT - 1)
  AGENT_RPC_NET_SETTLED_TOTAL++
}
function agentRpcEnsureWebRequestCounters (ses) {
  if (AGENT_RPC_SESSION_HOOKED.has(ses)) return
  AGENT_RPC_SESSION_HOOKED.add(ses)
  const filter = { urls: ['http://*/*', 'https://*/*'] }
  try {
    const dec = function () { AGENT_RPC_NET_INFLIGHT = Math.max(0, AGENT_RPC_NET_INFLIGHT - 1); AGENT_RPC_NET_SETTLED_TOTAL++ }
    ses.webRequest.onCompleted(filter, dec)
    ses.webRequest.onErrorOccurred(filter, dec)
  } catch (e) { /* counting unavailable */ }
}

/* ---------- browser_content ---------- */

function agentRpcCommandContent (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  if (view.webContents.getURL() === '') {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no page loaded yet'))
  }
  const maxChars = params.maxChars === undefined ? 20000 : params.maxChars
  const source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('content') + ')'
  return view.webContents.executeJavaScript(source).then(function (page) {
    let text = page && page.text ? page.text : ''
    const dropped = text.length > maxChars
    if (dropped) text = text.slice(0, maxChars)
    return {
      tabId: String(params.tabId),
      url: page.url, title: page.title, text: text,
      truncated: page.truncated === true || dropped
    }
  }).catch(function () {
    return agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'page content could not be read from this view')
  })
}

/* ---------- browser_hover ---------- */

/* P1-01: hook every session (incl. future tab partitions) for download
 * observation and network-idle counting. Additive only: the existing
 * ad/tracker blocking webRequest handlers are untouched. */
var AGENT_SNAPSHOT_REFS = new Map()
var AGENT_SNAPSHOT_REF_COUNTER = 0
var AGENT_SNAPSHOT_NAV_ATTACHED = new Set()
var AGENT_SNAPSHOT_SWEEP = null
var AGENT_SNAPSHOT_PENDING_DESTROYS = []
var AGENT_SNAPSHOT_SWEEP_RUNS = 0

app.on('session-created', function (ses) {
  agentRpcEnsureDownloadTracking(ses)
  agentRpcEnsureWebRequestCounters(ses)
})

function agentRpcCommandHover (params) {
  return agentRpcResolveTarget(params.tabId, params.ref).then(function (res) {
    let t = res.target
    if (!t.box || typeof t.box.x !== 'number' || !(t.box.w > 0) || !(t.box.h > 0)) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'target has no usable on-screen geometry')
    }
    const hoverOrdinal = res.page.nodes.indexOf(t) >= 0 ? res.page.nodes.indexOf(t) : res.record.ordinal
    /* P1-01D: fresh in-viewport box before dispatch (see click). */
    return agentRpcRefreshBoxInViewport(res.wc, hoverOrdinal, t.role).then(function (freshBox) {
      if (freshBox && freshBox.boxVp && freshBox.boxVp.w > 0) {
        t = Object.assign({}, t, { box: freshBox.boxVp })
      }
      const cx = t.box.x + Math.round(t.box.w / 2)
      const cy = t.box.y + Math.round(t.box.h / 2)
      try {
        res.wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy })
      } catch (e) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'hover dispatch failed')
      }
      agentRpcLog('action dispatched', 'hover', 'ref=' + params.ref)
      return { tabId: String(params.tabId), ref: params.ref, target: { role: t.role, name: t.name }, dispatched: true, verified: true, verification: 'dispatched', url: res.page.url }
    })
  })
}

/* ---------- browser_scroll ---------- */

function agentRpcCommandScroll (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  if (view.webContents.getURL() === '') {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no page loaded yet'))
  }
  const wc = view.webContents
  const to = params.to
  const dy = params.y === undefined ? 0 : params.y
  const dx = params.x === undefined ? 0 : params.x
  let source
  if (to === 'top') source = 'window.scrollTo(0, 0); JSON.stringify({ x: window.scrollX, y: window.scrollY })'
  else if (to === 'bottom') source = 'window.scrollTo(0, document.body.scrollHeight); JSON.stringify({ x: window.scrollX, y: window.scrollY })'
  else source = 'window.scrollBy(' + JSON.stringify(dx) + ', ' + JSON.stringify(dy) + '); JSON.stringify({ x: window.scrollX, y: window.scrollY })'
  return wc.executeJavaScript(source).then(function (pos) {
    return { tabId: String(params.tabId), scrolled: true, scrollX: pos.x, scrollY: pos.y }
  }).catch(function () {
    return agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'scroll dispatch failed')
  })
}

/* ---------- browser_select ---------- */

function agentRpcCommandSelect (params) {
  return agentRpcResolveTarget(params.tabId, params.ref).then(function (res) {
    const t = res.target
    if (t.role !== 'combobox') {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'ref does not point at a combobox (select) element (role=' + t.role + ')')
    }
    const pre = {
      mode: 'click', url: res.page.url, title: res.page.title, marker: res.page.marker,
      enumLen: res.page.total, targetRole: t.role, targetName: t.name, targetNameIndex: t.nameIndex,
      ordinal: res.page.nodes.indexOf(t) >= 0 ? res.page.nodes.indexOf(t) : res.record.ordinal,
      dispatchedAt: Date.now()
    }
    const source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('selection') + ',' + JSON.stringify(pre.ordinal) + ',' + JSON.stringify({ optionText: params.value }) + ')'
    return res.wc.executeJavaScript(source).then(function (selRes) {
      if (!selRes || selRes.ok !== true) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'option not found in the select element' + (selRes && selRes.hadOptions !== undefined ? ' (' + selRes.hadOptions + ' options present)' : ''))
      }
      agentRpcLog('action dispatched', 'select', 'ref=' + params.ref)
      return agentRpcRunVerification(res.wc, params.tabId, params.ref, pre, true, selRes.selectedText).then(function (v) {
        return {
          tabId: String(params.tabId), ref: params.ref,
          target: { role: t.role, name: t.name },
          dispatched: true, verified: v.verified, verification: v.kind,
          value: selRes.value, selectedText: selRes.selectedText,
          url: res.page.url, waitedMs: Date.now() - pre.dispatchedAt
        }
      })
    })
  })
}

/* ---------- browser_check ---------- */

function agentRpcAwaitCheck (wc, ordinal, wanted) {
  const locateSource = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('locate') + ',' + JSON.stringify(ordinal) + ')'
  const beats = [300, 700, 1200, 2000, 3000, 4000, 5000]
  return new Promise(function (resolve) {
    const started = Date.now()
    const poll = function (i) {
      if (Date.now() - started > 5000) { resolve({ verified: false, kind: 'dispatched-unverified', state: null }); return }
      wc.executeJavaScript(locateSource).then(function (page) {
        const t = page && page.target
        if (t && t.checked === wanted) { resolve({ verified: true, kind: 'checked', state: wanted }); return }
        if (i < beats.length) { setTimeout(function () { poll(i + 1) }, beats[i]); return }
        resolve({ verified: false, kind: 'dispatched-unverified', state: t ? t.checked : null })
      }).catch(function () {
        if (i < beats.length) { setTimeout(function () { poll(i + 1) }, beats[i]); return }
        resolve({ verified: false, kind: 'dispatched-unverified', state: null })
      })
    }
    poll(0)
  })
}

function agentRpcCommandCheck (params) {
  return agentRpcResolveTarget(params.tabId, params.ref).then(function (res) {
    let t = res.target
    if (t.role !== 'checkbox' && t.role !== 'radio') {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'ref does not point at a checkbox or radio element (role=' + t.role + ')')
    }
    if (t.disabled === true) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.disabled, 'disabled', 'target element is disabled')
    }
    if (!t.box || typeof t.box.x !== 'number' || !(t.box.w > 0) || !(t.box.h > 0)) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'target has no usable on-screen geometry')
    }
    const checkOrdinal = res.page.nodes.indexOf(res.target) >= 0 ? res.page.nodes.indexOf(res.target) : res.record.ordinal
    const dispatchedAt = Date.now()
    /* P1-01D: fresh in-viewport box before dispatch (see click). */
    return agentRpcRefreshBoxInViewport(res.wc, checkOrdinal, t.role).then(function (freshBox) {
      if (freshBox && freshBox.boxVp && freshBox.boxVp.w > 0) {
        t = Object.assign({}, t, { box: freshBox.boxVp })
      }
      const cx = t.box.x + Math.round(t.box.w / 2)
      const cy = t.box.y + Math.round(t.box.h / 2)
      try {
        /* native input events only: a real mouse click toggles the control and
         * fires the change events React/framework listeners expect. */
        res.wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
        res.wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
      } catch (e) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'check dispatch failed')
      }
      agentRpcLog('action dispatched', 'check', 'ref=' + params.ref)
      return agentRpcAwaitCheck(res.wc, checkOrdinal, params.checked).then(function (v) {
        return {
          tabId: String(params.tabId), ref: params.ref,
          target: { role: t.role, name: t.name },
          dispatched: true, verified: v.verified, verification: v.kind,
          checked: v.state, waitedMs: Date.now() - dispatchedAt
        }
      })
    })
  })
}

/* ---------- browser_wait ---------- */

/* Resolve the session for a view (used for webRequest counters). Returns
 * null for destroyed/dead views. Additive observation only. */
function agentRpcSessionForView (view) {
  try {
    return (view && view.webContents && !view.webContents.isDestroyed()) ? view.webContents.session : null
  } catch (e) {
    return null
  }
}

function agentRpcCommandWait (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  if (view.webContents.getURL() === '') {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no page loaded yet'))
  }
  const wc = view.webContents
  const ses = agentRpcSessionForView(view)
  if (ses) agentRpcEnsureWebRequestCounters(ses)
  const timeoutMs = Math.max(500, Math.min(params.timeoutMs === undefined ? 8000 : params.timeoutMs, 20000))
  if (params.until === 'network_idle') {
    return new Promise(function (resolve) {
      const t0 = Date.now()
      const deadline = t0 + timeoutMs
      let lastStart = Date.now() /* time of the last NEW request start (anchored at wait begin) */
      let lastObserved = AGENT_RPC_NET_OBSERVED_TOTAL
      const poll = function () {
        const inflight = AGENT_RPC_NET_INFLIGHT
        const now = Date.now()
        if (AGENT_RPC_NET_OBSERVED_TOTAL !== lastObserved) {
          lastObserved = AGENT_RPC_NET_OBSERVED_TOTAL
          lastStart = now
        }
        /* idle = no new request started for 1000ms AND in-flight drained; OR
         * no new activity at all for 3000ms (tolerates deliveries that never
         * produce onCompleted, e.g. long-poll/SSE or counter leaks from other
         * tabs; the reason string discloses remaining in-flight count). */
        const quietMs = now - lastStart
        if ((quietMs >= 1000 && inflight === 0) || quietMs >= 3000) {
          resolve({ satisfied: true, waitedMs: now - t0, reason: inflight > 0 ? 'no new activity for ' + quietMs + 'ms; in-flight=' + inflight + ' (pre-existing)' : 'no request activity for ' + quietMs + 'ms' })
          return
        }
        if (now >= deadline) { resolve({ satisfied: false, waitedMs: now - t0, reason: inflight + ' in-flight request(s) remain' }); return }
        setTimeout(poll, 200)
      }
      poll()
    })
  }
  if (params.until === 'selector_visible') {
    const sel = params.selector || ''
    if (typeof sel !== 'string' || sel.length === 0 || sel.length > 200 || /[<>\\{};`]/.test(sel)) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'selector must be 1-200 chars of plain CSS (no angle brackets, braces, backslashes, semicolons or backticks)'))
    }
    /* P1-01D fix: the selector object is the page fn's THIRD argument (extra);
     * the previous call passed it as the second (ordinal) argument, so extra
     * was always undefined and every selector reported not-found. */
    const locateSource = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('selcheck') + ',null,' + JSON.stringify({ selector: sel }) + ')'
    return new Promise(function (resolve) {
      const t0 = Date.now()
      const deadline = t0 + timeoutMs
      const poll = function () {
        wc.executeJavaScript(locateSource).then(function (page) {
          if (page && page.found && page.visible) { resolve({ satisfied: true, waitedMs: Date.now() - t0, reason: 'selector visible (' + page.matches + ' matches)' }); return }
          if (Date.now() >= deadline) { resolve({ satisfied: false, waitedMs: Date.now() - t0, reason: page && page.found ? 'selector found but not visible' : 'selector not found' }); return }
          setTimeout(poll, 300)
        }).catch(function () {
          if (Date.now() >= deadline) { resolve({ satisfied: false, waitedMs: Date.now() - t0, reason: 'page not enumerable' }); return }
          setTimeout(poll, 300)
        })
      }
      poll()
    })
  }
  return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'until must be network_idle or selector_visible'))
}

/* ---------- browser_downloads (read-only listing) ---------- */

/* P1-02: typed multi-action execution. Order-preserving, sequential, bounded
 * (60 s budget, max 20 steps), stop-on-error. Every step is re-validated with
 * the transport's own schema machinery, so input verification, single-use
 * grant consumption, tab-identity checks, navigation stability and CAPTCHA
 * handoff behave EXACTLY as they do for standalone calls. browser_grant and
 * browser_batch are excluded from the allowlist (no grant bundling, no
 * nesting). No arbitrary JS/shell/filesystem access. */
const AGENT_RPC_BATCH_BUDGET_MS = 60000
const AGENT_RPC_BATCH_MAX_STEPS = 20
const AGENT_RPC_BATCH_EXCLUDED = ['browser_grant', 'browser_batch']

function agentRpcCommandBatch (params) {
  return new Promise(function (resolve) {
    const startedAt = Date.now()
    let plan = null
    try { plan = JSON.parse(params.actions) } catch (eParse) {
      resolve({ ok: false, error: { category: 'invalid_params', message: 'actions is not valid JSON' }, steps: [], completed: 0, planned: 0 })
      return
    }
    if (!Array.isArray(plan) || plan.length < 1 || plan.length > AGENT_RPC_BATCH_MAX_STEPS) {
      resolve({ ok: false, error: { category: 'invalid_params', message: 'actions must be a JSON array of 1-' + AGENT_RPC_BATCH_MAX_STEPS + ' entries' }, steps: [], completed: 0, planned: Array.isArray(plan) ? plan.length : 0 })
      return
    }
    for (let pi = 0; pi < plan.length; pi++) {
      const entry = plan[pi]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.tool !== 'string' ||
          AGENT_RPC_METHODS.indexOf(entry.tool) === -1 ||
          (entry.params !== undefined && (typeof entry.params !== 'object' || Array.isArray(entry.params)))) {
        resolve({ ok: false, error: { category: 'invalid_params', message: 'entry ' + pi + ': tool must be a registered browser tool and params an object' }, steps: [], completed: 0, planned: plan.length })
        return
      }
    }

    async function run () {
      const steps = []
      for (let i = 0; i < plan.length; i++) {
        if (Date.now() - startedAt > AGENT_RPC_BATCH_BUDGET_MS) {
          steps.push({ step: i, tool: plan[i].tool, ok: false, error: { category: 'timeout', message: 'batch time budget (' + AGENT_RPC_BATCH_BUDGET_MS + 'ms) exhausted' } })
          break
        }
        const entry = plan[i]
        if (AGENT_RPC_BATCH_EXCLUDED.indexOf(entry.tool) !== -1) {
          /* per-step enforcement: an excluded tool fails AT its own step, so
           * earlier steps still run and stop-on-error halts the rest. */
          steps.push({ step: i, tool: entry.tool, ok: false, error: { category: 'invalid_params', message: entry.tool + ' cannot run inside a batch (excluded tool)' } })
          break
        }
        const mergedParams = Object.assign({}, entry.params || {})
        const schemaTakesTabId = Object.prototype.hasOwnProperty.call(AGENT_RPC_PARAM_SCHEMAS[entry.tool] || {}, 'tabId')
        if (schemaTakesTabId && mergedParams.tabId === undefined) mergedParams.tabId = params.tabId
        const verdict = agentRpcValidate({
          method: 'POST', url: '/rpc',
          headers: { host: '127.0.0.1:' + agentRpcState.port, authorization: 'Bearer ' + agentRpcState.token, 'content-type': 'application/json' },
          port: agentRpcState.port, expectedToken: agentRpcState.token
        }, JSON.stringify({ jsonrpc: '2.0', id: 'batch-step', method: entry.tool, params: mergedParams }))
        if (!verdict.ok) {
          steps.push({ step: i, tool: entry.tool, ok: false, error: verdict.error })
          break
        }
        try {
          const outcome = agentRpcDispatch(entry.tool, mergedParams)
          const result = await outcome
          /* P1-03: an executed step whose own structured verification FAILED
           * (verified === false — e.g. a failed browser_verify check or an
           * unexpected navigation state) invalidates later steps: it is a
           * step failure for stop-on-error purposes. The full result is kept
           * in the step entry for re-planning. */
          if (result && typeof result === 'object' && result.verified === false) {
            steps.push({ step: i, tool: entry.tool, ok: false, result: result, error: { category: 'verification_failed', message: 'step completed but its verification did not pass' } })
            break
          }
          steps.push({ step: i, tool: entry.tool, ok: true, result: result })
        } catch (eStep) {
          steps.push({
            step: i, tool: entry.tool, ok: false,
            error: (eStep && eStep.agentRpcCommandError) ? { category: eStep.category, message: eStep.message, code: eStep.code } : { category: 'internal', message: 'command failed' }
          })
          break
        }
      }
      return {
        ok: steps.length > 0 && steps[steps.length - 1].ok === true && steps.every(function (x) { return x.ok === true }),
        steps: steps,
        completed: steps.length,
        planned: plan.length,
        stopOnError: true,
        totalMs: Date.now() - startedAt
      }
    }
    run().then(resolve, function (eRun) {
      resolve({ ok: false, error: { category: 'internal', message: 'batch execution failed' }, steps: [], completed: 0, planned: plan.length })
    })
  })
}

function agentRpcCommandDownloads () {
  agentRpcDlPrune()
  const managed = []
  AGENT_RPC_DL_MANAGED.forEach(function (rec2) { managed.push(agentRpcDlPublicRec(rec2)) })
  return { downloads: AGENT_RPC_DOWNLOADS.slice(-50), count: AGENT_RPC_DOWNLOADS.length, managed: managed, managedCount: managed.length }
}

/* ---------- browser_click / browser_type (P0-10) ----------
 *
 * The request supplies only tabId + ref (+ text for browser_type). The ref is
 * resolved by RE-ENUMERATING the page with the same function that produced the
 * snapshot (locate mode, ordinal argument only - a validated integer), then
 * matching SERVER-SIDE against the ref record. The only strings ever built for
 * the page remain this module's own function source and fixed mode literals.
 * Page text is compared as data and never sent back into the page.
 */

/* ---------- browser_click / browser_type (P0-10) ----------
 *
 * The request supplies only tabId + ref (+ text for browser_type). The ref is
 * resolved by RE-ENUMERATING the page with the same function that produced the
 * snapshot (locate mode; the only page-side arguments are a fixed mode literal
 * and a validated integer ordinal), then matching SERVER-SIDE against the ref
 * record: strict ordinal match first, weak role+name match second, and a
 * multi-match always fails with AMBIGUOUS instead of guessing. Page text is
 * compared as data and never sent back into the page. Dispatch uses native
 * input events (sendInputEvent / insertText), never element.click() or JS.
 */

function agentRpcResolveTarget (tabId, ref) {
  return new Promise(function (resolve, reject) {
    var store = AGENT_SNAPSHOT_REFS.get(String(tabId))
    var view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
    var tabDead = !view || !view.webContents || view.webContents.isDestroyed()

    function refInAnotherTab () {
      var other = null
      AGENT_SNAPSHOT_REFS.forEach(function (s2, id2) {
        if (!other && id2 !== String(tabId) && s2.refs.some(function (r2) { return r2.ref === ref })) other = id2
      })
      return other !== null
    }

    if (!store) {
      reject(refInAnotherTab()
        ? agentRpcCommandError(AGENT_RPC_ERRORS.ref_mismatch, 'ref_mismatch', 'ref belongs to a different tab')
        : agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'no live snapshot ref store for this tabId'))
      return
    }
    if (Date.now() - store.born > AGENT_RPC_REF_TTL_MS) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.ref_expired, 'ref_expired', 'ref expired (snapshot older than ' + Math.round(AGENT_RPC_REF_TTL_MS / 1000) + 's); take a new snapshot'))
      return
    }
    if (tabDead) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
      return
    }
    var record = store.refs.find(function (r3) { return r3.ref === ref })
    if (!record) {
      reject(refInAnotherTab()
        ? agentRpcCommandError(AGENT_RPC_ERRORS.ref_mismatch, 'ref_mismatch', 'ref belongs to a different tab')
        : agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', 'ref not in the current store; take a new snapshot'))
      return
    }

    var view2 = view
    var wc = view.webContents
    if (typeof isViewAttachedToAnyWindow === 'function' && !isViewAttachedToAnyWindow(view2)) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.view_not_attached, 'view_not_attached', 'view is not attached to a live window; select the tab first (single-window scope)'))
      return
    }

    var source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('locate') + ',' + JSON.stringify(record.ordinal) + ')'
    var timedOut = false
    var timer = setTimeout(function () {
      timedOut = true
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'action target could not be located within ' + AGENT_RPC_SNAPSHOT_TIMEOUT + 'ms'))
    }, AGENT_RPC_SNAPSHOT_TIMEOUT)

    wc.executeJavaScript(source)
      .then(function (pageRes) {
        if (timedOut) return
        clearTimeout(timer)
        if (!pageRes || pageRes.mode !== 'locate' || !Array.isArray(pageRes.nodes)) {
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'action target could not be located in this view'))
          return
        }
        var t = pageRes.target
        /* Strict: the enumeration length is unchanged AND the element at the
         * stored ordinal still matches the ref's role + name + nameIndex. */
        var strict = t && pageRes.total === store.enumLen &&
          t.role === record.role && t.name === record.name && t.nameIndex === record.nameIndex
        if (strict) {
          resolve({ view: view2, wc: wc, page: pageRes, target: t, record: record })
          return
        }
        /* Weak fallback: the page changed since the snapshot. Match role +
         * accessible name in the CURRENT enumeration. One match = the element
         * legitimately moved. Zero = gone. Multiple = AMBIGUOUS - fail loudly,
         * never guess. */
        var weak = pageRes.nodes.filter(function (n) {
          return n.role === record.role && n.name === record.name
        })
        if (weak.length === 1) {
          resolve({ view: view2, wc: wc, page: pageRes, target: weak[0], record: record, moved: true })
          return
        }
        if (weak.length === 0) {
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', 'element no longer present; take a new snapshot'))
          return
        }
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.ambiguous, 'ambiguous', 'role and accessible name match ' + weak.length + ' elements; take a fresh snapshot and use the unambiguous ref'))
      })
      .catch(function () {
        if (timedOut) return
        clearTimeout(timer)
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'action target could not be located in this view'))
      })
  })
}

/* Shared bounded verification. pre = { url, title, marker, targetName ... }
 * captured from the resolve step (pre-dispatch). Poll windows are fixed; no
 * unbounded polling, no retries, exactly one dispatch. */
var AGENT_RPC_VERIFY_WINDOW_MS = 5000
var AGENT_RPC_VERIFY_STEPS = [300, 700, 1200, 2000, 3000, 4000, 5000]

function agentRpcRunVerification (wc, tabId, ref, pre, isType, expectedText) {
  return new Promise(function (resolve) {
    var navFired = false
    var onNav = function () { navFired = true }
    wc.on('did-navigate', onNav)
    wc.on('did-navigate-in-page', onNav)

    var best = null
    var done = false
    var zeroLenStreak = 0
    var deadline = Date.now() + AGENT_RPC_VERIFY_WINDOW_MS

    function finish (kind) {
      if (done) return
      done = true
      try { wc.removeListener('did-navigate', onNav); wc.removeListener('did-navigate-in-page', onNav) } catch (e) { /* ignore */ }
      resolve({ kind: kind || 'dispatched-unverified', verified: kind !== null && kind !== 'dispatched-unverified', navFired: navFired })
    }

    var locateSource = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('locate') + ',' + JSON.stringify(pre.ordinal) + ')'

    function inspect () {
      return wc.executeJavaScript(locateSource).then(function (page) {
        if (!page || page.mode !== 'locate') return null
        /* P0-11 press mode: focus movement is the primary signal - a page with
         * its own key logger would flip the marker for EVERY key (Tab included),
         * so focus is evaluated BEFORE the marker. */
        if (pre.mode === 'press') {
          var focusIdx = null
          page.nodes.forEach(function (n, i) { if (n.focused === true && focusIdx === null) focusIdx = i })
          var focusChanged = (pre.focusOrdinal !== focusIdx) && (focusIdx !== null || pre.focusOrdinal !== null)
          if (focusChanged) return 'focus'
          var pressMarkerChanged = page.marker && pre.marker &&
            (page.marker.interactiveCount !== pre.marker.interactiveCount ||
             page.marker.textLen !== pre.marker.textLen ||
             page.marker.sample !== pre.marker.sample)
          if (pressMarkerChanged) return 'dom-change'
          return null
        }
        /* DOM marker: coarse body-text sample + interactive count. */
        if (!isType && page.marker && pre.marker) {
          if (page.marker.interactiveCount !== pre.marker.interactiveCount ||
              page.marker.textLen !== pre.marker.textLen ||
              page.marker.sample !== pre.marker.sample) return 'dom-change'
        }
        var target = null
        if (page.total === pre.enumLen && page.target && page.target.role === pre.targetRole &&
            page.target.name === pre.targetName && page.target.nameIndex === pre.targetNameIndex) {
          target = page.target
        } else {
          var weak = page.nodes.filter(function (n) { return pre.targetRole === n.role && pre.targetName === n.name })
          if (weak.length === 1) target = weak[0]
        }
        if (isType && target) {
          /* Redacted targets (password/sensitive) never expose their value:
           * 'value' verification is length-only. Non-redacted fields match the
           * sanitized value. */
          if (target.redacted === true) {
            if (target.valueLength === expectedText.length) return 'value'
          } else if (target.valueLength === expectedText.length && target.value === agentRpcSafeText(expectedText, AGENT_RPC_SNAPSHOT_NAME_MAX).slice(0, AGENT_RPC_SNAPSHOT_NAME_MAX)) return 'value'
          /* P1-01D: a located (identity-strict) target that still reads length 0
           * while non-empty text was dispatched is DEMONSTRABLY not accepted.
           * Two consecutive reads (~700ms apart at the head of the window) let
           * the type command engage its native-setter fallback early instead
           * of waiting out the full window. */
          if (expectedText.length > 0 && target.valueLength === 0) {
            zeroLenStreak++
          } else {
            zeroLenStreak = 0
          }
        }
        if (target && target.focused === true && best === null) best = 'focus'
        if (isType) {
          if (target && target.valueLength !== null && best === null) best = 'focus' /* field interacted with */
        }
        return null
      }).catch(function () { return null /* page mid-navigation; rely on navFired */ })
    }

    function poll (i) {
      if (done) return
      if (navFired) { finish('navigation'); return }
      inspect().then(function (verdict) {
        if (done) return
        if (verdict) { finish(verdict); return }
        /* P1-01D: early not-accepted detection for typing (two consecutive
         * zero-length reads ~700ms apart) - type command falls back early. */
        if (isType && zeroLenStreak >= 2) { finish('framework-unchanged'); return }
        if (Date.now() >= deadline) {
          if (navFired) { finish('navigation'); return }
          if (best) { finish(best); return }
          finish('dispatched-unverified')
          return
        }
        var delay = (AGENT_RPC_VERIFY_STEPS[i] !== undefined ? AGENT_RPC_VERIFY_STEPS[i] : AGENT_RPC_VERIFY_WINDOW_MS) - (Date.now() - pre.dispatchedAt)
        setTimeout(function () { poll(i + 1) }, delay > 0 ? delay : 50)
      })
    }
    poll(0)
  })
}

/* P1-01D: refresh an element's on-screen box right before a coordinate-based
 * dispatch by scrolling it into view. Returns a fresh viewport-space box or
 * null. Uses the fixed setvalue-style identity re-check (no arbitrary code). */
function agentRpcRefreshBoxInViewport (wc, ordinal, role) {
  const src = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' +
    JSON.stringify('scrollinto') + ',' + JSON.stringify(ordinal) + ',' +
    JSON.stringify({ role: role || null }) + ')'
  return wc.executeJavaScript(src).then(function (r) {
    if (r && r.mode === 'scrollinto' && r.ok === true && r.boxVp && typeof r.boxVp.x === 'number') return r
    return null
  }).catch(function () { return null })
}

function agentRpcCommandClick (params) {
  return agentRpcResolveTarget(params.tabId, params.ref).then(function (res) {
    var t = res.target
    if (t.disabled === true) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.disabled, 'disabled', 'target element is disabled; a click would be a no-op')
    }
    if (t.nearCaptcha === true) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.captcha_handoff_required, 'captcha_handoff_required', 'a CAPTCHA widget overlaps this element; solve it in the visible window and continue the workflow afterwards')
    }
    var nameLower = (t.name || '').toLowerCase()
    if (AGENT_RPC_RISKY_NAME.test(nameLower)) {
      /* P0-13: policy pre-authorization first, then a single-use grant. */
      const policy = agentRpcReadPolicy()
      if (!policy.allowRiskyClicks && !agentRpcConsumeGrant('risky_click', params.tabId, params.ref)) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.risky_action, 'risky_action', 'accessible name matches a purchase/payment pattern; requires a single-use browser_grant(risky_click) for this tab (or allowRiskyClicks: true in profile policy.json)')
      }
    }
    if (!t.box || typeof t.box.x !== 'number' || !(t.box.w > 0) || !(t.box.h > 0)) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'target has no usable on-screen geometry')
    }
    var clickOrdinal = res.page.nodes.indexOf(t) >= 0 ? res.page.nodes.indexOf(t) : res.record.ordinal
    /* P1-01D: scroll the target into view and use its FRESH in-viewport box —
     * sendInputEvent coordinates are viewport-space; snapshot boxes for
     * far-offscreen elements silently miss on real-world pages. */
    return agentRpcRefreshBoxInViewport(res.wc, clickOrdinal, t.role).then(function (freshBox) {
      if (freshBox && freshBox.boxVp && freshBox.boxVp.w > 0) {
        t = Object.assign({}, t, { box: freshBox.boxVp })
      }
      var cx = t.box.x + Math.round(t.box.w / 2)
      var cy = t.box.y + Math.round(t.box.h / 2)
      var pre = {
        url: res.page.url,
        title: res.page.title,
        marker: res.page.marker,
        enumLen: res.page.total,
        targetRole: t.role,
        targetName: t.name,
        targetNameIndex: t.nameIndex,
        ordinal: clickOrdinal,
        targetName_unused: undefined,
        dispatchedAt: Date.now()
      }
      delete pre.targetName_unused
    try {
      res.wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
      res.wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
    } catch (e) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'input dispatch failed')
    }
    agentRpcLog('action dispatched', 'click', 'ref=' + params.ref)
    return agentRpcRunVerification(res.wc, params.tabId, params.ref, pre, false, null).then(function (v) {
      const base = {
        tabId: String(params.tabId),
        ref: params.ref,
        target: { role: t.role, name: t.name, nameIndex: t.nameIndex },
        dispatched: true,
        verified: v.verified,
        verification: v.kind,
        url: res.page.url,
        title: res.page.title,
        waitedMs: Date.now() - pre.dispatchedAt
      }
      /* P1-03: a navigating click must expose the FINAL URL (Stage 2 cheap
       * verification). Bounded 3 s settle read at 250 ms; capped to keep the
       * tool fast. */
      if (v.navFired === true) {
        return new Promise(function (resolveSettle) {
          const deadline = Date.now() + 3000
          let last = res.wc.getURL()
          let lastChange = Date.now()
          const poll = function () {
            const nowUrl = res.wc.getURL()
            const now = Date.now()
            if (nowUrl !== last) { last = nowUrl; lastChange = now }
            if ((now - lastChange >= 250) || now >= deadline) {
              resolveSettle(Object.assign(base, { finalUrl: last }))
              return
            }
            setTimeout(poll, 250)
          }
          poll()
        })
      }
      return base
    })
    })
  })
}

function agentRpcCommandType (params) {
  return agentRpcResolveTarget(params.tabId, params.ref).then(function (res) {
    var t = res.target
    if (t.redacted === true) {
      /* P0-13: policy pre-authorization first, then a single-use grant. */
      const policy = agentRpcReadPolicy()
      if (!policy.allowSensitiveTyping && !agentRpcConsumeGrant('sensitive_type', params.tabId, params.ref)) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.sensitive_field, 'sensitive_field', 'typing into password/email/phone/autocomplete-sensitive fields is refused; requires a single-use browser_grant(sensitive_type) for this tab (or allowSensitiveTyping: true in profile policy.json)')
      }
    }
    if (t.nearCaptcha === true) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.captcha_handoff_required, 'captcha_handoff_required', 'a CAPTCHA widget overlaps this field; solve it in the visible window and continue the workflow afterwards')
    }
    if (t.role !== 'textbox' && t.role !== 'combobox') {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'ref does not point at a text-entry element (role=' + t.role + ')')
    }
    if (t.disabled === true) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.disabled, 'disabled', 'target element is disabled')
    }
    if (!t.box || typeof t.box.x !== 'number' || !(t.box.w > 0) || !(t.box.h > 0)) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'target has no usable on-screen geometry')
    }
    var typeOrdinal = res.page.nodes.indexOf(t) >= 0 ? res.page.nodes.indexOf(t) : res.record.ordinal
    /* P1-01D: fresh in-viewport box before coordinate dispatch (see click). */
    return agentRpcRefreshBoxInViewport(res.wc, typeOrdinal, t.role).then(function (freshBox) {
      if (freshBox && freshBox.boxVp && freshBox.boxVp.w > 0) {
        t = Object.assign({}, t, { box: freshBox.boxVp })
      }
      var cx = t.box.x + Math.round(t.box.w / 2)
      var cy = t.box.y + Math.round(t.box.h / 2)
      var text = params.text
      var pre = {
        url: res.page.url,
        title: res.page.title,
        marker: res.page.marker,
        enumLen: res.page.total,
        targetRole: t.role,
        targetName: t.name,
        targetNameIndex: t.nameIndex,
        ordinal: typeOrdinal,
        dispatchedAt: Date.now()
      }
    try {
      /* Focus via a native click, select-all + delete via native key events,
       * then native text insertion (insertText). No JS is injected. */
      res.wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
      res.wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
      var mod = process.platform === 'darwin' ? 'meta' : 'control'
      res.wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [mod] })
      res.wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: [mod] })
      res.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      res.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      res.wc.insertText(text)
    } catch (e) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'input dispatch failed')
    }
    agentRpcLog('action dispatched', 'type', 'ref=' + params.ref, 'len=' + text.length)
    var buildTypeResult = function (verification, verified, strategy, extraFields) {
      return Object.assign({
        tabId: String(params.tabId),
        ref: params.ref,
        target: { role: t.role, name: t.name, nameIndex: t.nameIndex, shadowPath: t.shadowPath || null },
        strategy: strategy,
        dispatched: true,
        verified: verified,
        verification: verification,
        valueLength: text.length,
        url: res.page.url,
        title: res.page.title,
        waitedMs: Date.now() - pre.dispatchedAt
      }, extraFields || {})
    }
    return agentRpcRunVerification(res.wc, params.tabId, params.ref, pre, true, text).then(function (v) {
      /* P1-01C: dispatched input is NOT assumed accepted. Acceptance is the
       * read-back: exact sanitized value (non-sensitive) or exact length only
       * (sensitive). A late navigation during verification is still a valid
       * outcome (verified via the navigation signal). */
      var acceptedKind = null
      if (v.kind === 'value') acceptedKind = t.redacted === true ? 'value-length' : 'value'
      if (acceptedKind !== null || v.kind === 'navigation') {
        return buildTypeResult(acceptedKind || v.kind, true, 'native-insert', { navFired: v.navFired === true })
      }
      /* Bounded fallback: exactly ONE retry with a different strategy - the
       * input element's own prototype value setter plus input+change events
       * (framework-controlled inputs and delegated listeners observe a real
       * value change). Identity-checked against the enumeration that produced
       * the ref; never dispatched when the first strategy verified. */
      var setvalueSource = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' +
        JSON.stringify('setvalue') + ',' + JSON.stringify(pre.ordinal) + ',' +
        JSON.stringify({ role: t.role, name: t.name, nameIndex: t.nameIndex || 0, text: text, redacted: t.redacted === true }) + ')'
      return res.wc.executeJavaScript(setvalueSource).then(function (fb) {
        if (!fb || fb.mode !== 'setvalue') {
          return buildTypeResult('unreadable-state', false, 'native-setter-fallback', { failReason: 'fallback could not read back page state' })
        }
        if (!fb.ok) {
          if (/stale|not found/.test(fb.reason || '')) {
            throw agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', 'element drifted or vanished during fallback; take a new snapshot')
          }
          return buildTypeResult('unreadable-state', false, 'native-setter-fallback', { failReason: String(fb.reason || 'fallback failed') })
        }
        var lenOk = fb.valueLength === text.length
        if (fb.redacted) {
          return lenOk
            ? buildTypeResult('value-length', true, 'native-setter-fallback')
            : buildTypeResult('rejected-input', false, 'native-setter-fallback', { failReason: 'framework rejected the value (length mismatch after fallback)' })
        }
        if (lenOk && fb.value === agentRpcSafeText(text, AGENT_RPC_SNAPSHOT_NAME_MAX).slice(0, AGENT_RPC_SNAPSHOT_NAME_MAX)) {
          return buildTypeResult('value', true, 'native-setter-fallback')
        }
        return buildTypeResult('rejected-input', false, 'native-setter-fallback', { failReason: 'framework rejected the value (content mismatch after fallback)' })
      }).catch(function (eFB) {
        if (eFB && eFB.agentRpcCommandError) throw eFB
        return buildTypeResult('unreadable-state', false, 'native-setter-fallback', { failReason: 'fallback execution failed' })
      })
    })
    })
  })
}

/* ---------- browser_navigate / browser_press / browser_screenshot (P0-11) ---------- */

var AGENT_RPC_ALLOWED_PROTOCOLS = { 'http:': 1, 'https:': 1, 'file:': 1, 'min:': 1, 'about:': 1 }

/* P1-01D: origin-safe expectUrlPrefix comparison. Raw string matching can
 * accept a lookalike host (prefix 'https://example.com' would also match
 * 'https://example.com.evil.com/...'). Rule: the prefix must parse as an
 * absolute URL; the final URL's ORIGIN (scheme + host incl. port) must equal
 * the prefix's origin exactly, and the full href must start with the prefix. */
function agentRpcPrefixMatchesUrl (prefix, url) {
  if (typeof prefix !== 'string' || prefix.length === 0) return false
  if (typeof url !== 'string' || url.length === 0) return false
  if (url.indexOf(prefix) !== 0) return false
  let prefixParsed, urlParsed
  try {
    prefixParsed = new URL(prefix)
    urlParsed = new URL(url)
  } catch (e) {
    return false
  }
  return prefixParsed.origin === urlParsed.origin
}

function agentRpcValidateUrl (raw, allowedProtocols) {
  var protocols = allowedProtocols || AGENT_RPC_ALLOWED_PROTOCOLS
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: 'url must be a non-empty string of at most 2048 characters' }
  }
  if (agentRpcHasControlChars(raw)) {
    return { ok: false, reason: 'url contains control characters' }
  }
  /* The WHATWG parser silently strips leading/trailing whitespace; the bridge
   * rejects it instead, exactly like every other invisible character. */
  if (raw !== raw.trim()) {
    return { ok: false, reason: 'url contains leading or trailing whitespace' }
  }
  var parsed
  try {
    parsed = new URL(raw)
  } catch (e) {
    return { ok: false, reason: 'url is not a valid absolute URL' }
  }
  if (!protocols[parsed.protocol]) {
    return { ok: false, reason: 'url scheme is not allowed; http, https, file, min and about only (the profile policy.json can further restrict this)' }
  }
  return { ok: true, protocol: parsed.protocol }
}

/* P1-01E: last navigation outcome per tab (bounded; feeds browser_state). */
var AGENT_RPC_LAST_NAV = new Map()

function agentRpcCommandState (params) {
  let tabId = params.tabId
  if (tabId === undefined) {
    /* default: the selected tab of the first live window (single-window scope) */
    try {
      windows.openWindows.forEach(function (entry) {
        if (tabId === undefined && !entry.closed && entry.win && !entry.win.isDestroyed()) {
          const sel = windows.getState(entry.win).selectedView
          if (sel && viewMap[sel]) tabId = sel
        }
      })
    } catch (eSel) { /* fall through to not_found */ }
  }
  const view = viewMap[tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  const wc = view.webContents
  if (wc.getURL() === '') {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no page loaded yet'))
  }
  const source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('state') + ')'
  const startedAt = Date.now()
  return wc.executeJavaScript(source).then(function (page) {
    if (!page || page.mode !== 'state') {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'page state could not be collected from this view')
    }
    const lastNav = AGENT_RPC_LAST_NAV.get(String(tabId)) || null
    const captcha = page.captcha || { detected: false, kind: null, confidence: null, basis: null, widgetCount: 0 }
    const blockedSignals = []
    if (lastNav && lastNav.verified === false && (lastNav.verification === 'load_failed' || lastNav.verification === 'timeout')) {
      blockedSignals.push('last navigation: ' + lastNav.verification)
    }
    if ((page.url || '').indexOf('min://app/pages/error') === 0) {
      blockedSignals.push('Min internal error page')
    }
    return {
      tabId: String(tabId),
      url: page.url,
      title: page.title,
      readyState: page.readyState,
      captcha: {
        detected: captcha.detected === true,
        kind: captcha.kind || null,
        confidence: captcha.confidence || null,
        basis: captcha.basis || null,
        widgetCount: captcha.widgetCount || 0,
        policy: 'never solved, bypassed or automated by the agent; complete challenges manually in the visible window, then re-run browser_state to confirm cleared'
      },
      blocked: { apparently: blockedSignals.length > 0, signals: blockedSignals },
      focus: page.focus || { isBody: true, isTextField: false, isPasswordField: false, tag: null },
      net: { inFlight: AGENT_RPC_NET_INFLIGHT },
      lastNavigation: lastNav ? { verified: lastNav.verified, verification: lastNav.verification, ageMs: Date.now() - lastNav.at } : null,
      waitedMs: Date.now() - startedAt
    }
  }).catch(function (eState) {
    if (eState && eState.agentRpcCommandError) throw eState
    throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'page state could not be collected from this view')
  })
}

/* P1-03: static prediction of an action's likely effect (pure DOM inspection;
 * the action is never triggered to discover its semantics). */
function agentRpcClassifyPrediction (page, action) {
  const evidence = []
  let likelyEffect = 'unknown'
  let sideEffectClass = 'unknown'
  let confidence = 'low'
  let requiresUserInput = false
  let reason = null
  if (page.disabled === true) {
    likelyEffect = 'none'; sideEffectClass = 'read-only'; confidence = 'high'
    evidence.push('element is disabled; dispatch would be a no-op')
  } else if (page.tag === 'a' && page.href) {
    let external = false
    try { external = new URL(page.href).origin !== new URL(page.currentUrl).origin } catch (eO) { /* keep false */ }
    likelyEffect = 'navigates to ' + page.href
    sideEffectClass = 'navigation'
    confidence = 'high'
    evidence.push('anchor href=' + page.href + ' (resolved)')
    if (page.hrefTarget === '_blank') { evidence.push('target=_blank (may open a new tab)') }
    if (external) { sideEffectClass = 'navigation-external'; evidence.push('destination origin differs from the current page origin') }
  } else if (page.tag === 'button' || (page.tag === 'input' && page.inputType === 'submit')) {
    if (page.form.insideForm === true) {
      /* inside a form: a <button> defaults to submit semantics and an
       * explicit submit input always submits. */
      if (page.inputType === 'submit' || page.tag === 'button') {
        likelyEffect = 'submits the enclosing form' + (page.form.action ? ' to ' + page.form.action : '')
        sideEffectClass = 'form-submit'
        confidence = 'medium'
        evidence.push('submit-control inside a form (method=' + (page.form.method || 'get') + ', action=' + (page.form.action || 'current URL') + ')')
        evidence.push('script-driven submit handlers cannot be detected statically; additional effects are possible')
      } else {
        likelyEffect = 'unknown (script-defined)'
        sideEffectClass = 'unknown'
        confidence = 'low'
        evidence.push('non-submit control inside a form')
      }
    } else {
      likelyEffect = 'unknown (script-defined)'
      sideEffectClass = 'unknown'
      confidence = 'low'
      evidence.push('button outside a form; click effects come from script listeners that static inspection cannot enumerate')
    }
  } else if (page.role === 'textbox' || page.role === 'combobox') {
    likelyEffect = page.role === 'combobox' ? 'selects an option' : 'replaces the field value (value/name are framework-verified after dispatch)'
    sideEffectClass = 'input'
    confidence = 'high'
    evidence.push('text-entry element (tag=' + page.tag + ', type=' + (page.inputType || 'n/a') + ')')
  } else if (page.role === 'checkbox' || page.role === 'radio') {
    likelyEffect = 'toggles the control state'
    sideEffectClass = 'input'
    confidence = 'high'
    evidence.push('toggle control (tag=' + page.tag + ', type=' + (page.inputType || 'n/a') + ')')
  } else {
    likelyEffect = 'unknown (unrecognized control)'
    sideEffectClass = 'unknown'
    confidence = 'low'
    evidence.push('tag=' + page.tag + ', role=' + page.role)
  }
  if (action === 'type' && page.role !== 'textbox' && page.role !== 'combobox') {
    reason = 'browser_type requires a textbox/combobox ref'
  }
  if (sideEffectClass === 'unknown') {
    requiresUserInput = true
    reason = reason || 'the effect cannot be known statically; run the action only within the task authorization and verify the aftermath'
  }
  evidence.push('current page: ' + page.currentUrl)
  return { target: { tag: page.tag, role: page.role, name: page.name, href: page.href || null }, action: action, likelyEffect: likelyEffect, evidence: evidence, confidence: confidence, sideEffectClass: sideEffectClass, requiresUserInput: requiresUserInput, reason: reason }
}

function agentRpcCommandPredict (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  if (view.webContents.getURL() === '') {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no page loaded yet'))
  }
  return agentRpcResolveTarget(params.tabId, params.ref).then(function (res) {
    const ord = res.page.nodes.indexOf(res.target) >= 0 ? res.page.nodes.indexOf(res.target) : res.record.ordinal
    const source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('predict') + ',' + JSON.stringify(ord) + ',' + JSON.stringify({ role: res.target.role }) + ')'
    return res.wc.executeJavaScript(source).then(function (page) {
      if (!page || page.mode !== 'predict') {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'prediction could not be collected from this view')
      }
      if (page.ok === false) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', page.reason || 'target no longer matches its reference')
      }
      const out = agentRpcClassifyPrediction(page, params.action)
      out.tabId = String(params.tabId)
      out.ref = params.ref
      out.url = page.currentUrl || null
      out.parentTag = page.parentTag || null
      out.insideFormRaw = page.insideFormRaw || null
      return out
    })
  })
}

/* P1-03: cheap post-action verification. Every provided condition is checked
 * in one bounded page pass; escalation to a snapshot is the caller's choice. */
function agentRpcCommandVerify (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  if (params.urlPrefix !== undefined && (typeof params.urlPrefix !== 'string' || params.urlPrefix.length === 0 || params.urlPrefix.length > 300)) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'urlPrefix must be a non-empty string of at most 300 characters'))
  }
  if (params.selector !== undefined && (typeof params.selector !== 'string' || params.selector.length === 0 || params.selector.length > 200)) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'selector must be a non-empty string of at most 200 characters'))
  }
  if (params.textContains !== undefined && (typeof params.textContains !== 'string' || params.textContains.length === 0 || params.textContains.length > 200)) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'textContains must be a non-empty string of at most 200 characters'))
  }
  const wc = view.webContents
  if (wc.getURL() === '') {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no page loaded yet'))
  }
  const source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('verify') + ',null,' + JSON.stringify({ selector: params.selector, textContains: params.textContains }) + ')'
  const startedAt = Date.now()
  return wc.executeJavaScript(source).then(function (page) {
    if (!page || page.mode !== 'verify') {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'verification could not be collected from this view')
    }
    const checks = {}
    let verified = true
    if (params.urlPrefix !== undefined) {
      checks.urlPrefix = agentRpcPrefixMatchesUrl(params.urlPrefix, page.url)
      verified = verified && checks.urlPrefix
    }
    if (params.selector !== undefined) {
      checks.selectorVisible = page.selectorVisible === true
      checks.selectorMatches = page.selectorMatches || 0
      verified = verified && page.selectorVisible === true
    }
    if (params.textContains !== undefined) {
      checks.textContains = page.textContains === true
      verified = verified && page.textContains === true
    }
    return {
      tabId: String(params.tabId),
      url: page.url,
      title: page.title,
      checks: checks,
      verified: verified,
      waitedMs: Date.now() - startedAt
    }
  })
}

var AGENT_RPC_PRESS_KEYS = { Enter: 1, Tab: 1, Escape: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1, Backspace: 1, Delete: 1 }
/* The public enum is DOM-style; this runtime's sendInputEvent speaks accelerator
 * codes - measured with scripts/fixtures/keymap-probe-main.js:
 *   ArrowDown/Left/Right/Up produce EMPTY key events (e.key '' keyCode 0),
 *   while Down/Left/Right/Up deliver ArrowDown/Left/Right/Up. Everything else
 *   in the enum matches 1:1. */
var AGENT_RPC_KEY_TRANSLATION = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }
function agentRpcTranslateKey (key) {
  return AGENT_RPC_KEY_TRANSLATION[key] || key
}
var AGENT_RPC_SCREENSHOT_MAX = 5 * 1024 * 1024

function agentRpcScreenshotSizeOk (encodedLength) {
  /* encoded = base64 payload length (what the response would carry). */
  return encodedLength <= AGENT_RPC_SCREENSHOT_MAX
}

function agentRpcCommandNavigate (params) {
  return new Promise(function (resolve, reject) {
    const startedAt = Date.now()
    const tabId = params.tabId
    const view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
      return
    }
    const urlCheck = agentRpcValidateUrl(params.url, agentRpcEffectiveProtocols())
    if (!urlCheck.ok) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', urlCheck.reason))
      return
    }
    if (params.expectUrlPrefix !== undefined) {
      if (typeof params.expectUrlPrefix !== 'string' || params.expectUrlPrefix.length === 0 || params.expectUrlPrefix.length > 300) {
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'expectUrlPrefix must be a non-empty string of at most 300 characters'))
        return
      }
    }
    if (params.waitUntil !== undefined && ['load', 'domcontentloaded'].indexOf(params.waitUntil) === -1) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'waitUntil must be "load" or "domcontentloaded"'))
      return
    }
    if (typeof isViewAttachedToAnyWindow === 'function' && !isViewAttachedToAnyWindow(view)) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.view_not_attached, 'view_not_attached', 'view is not attached to a live window; select the tab first (single-window scope)'))
      return
    }

    const wc = view.webContents
    const settleEvent = params.waitUntil === 'domcontentloaded' ? 'dom-ready' : 'did-finish-load'
    let navSettleAt = 0 /* P1-01D: when the load event settled (0 = timed out) */
    const failEvent = 'did-fail-load'
    let attemptCount = 0
    const maxAttempts = params.expectUrlPrefix !== undefined ? 2 : 1
    let responded = false

    function resolveOnce (payload) {
      if (responded) return
      responded = true
      resolve(payload)
    }
    function rejectOnce (err) {
      if (responded) return
      responded = true
      reject(err)
    }

    /* bounded wait for the final URL to start with expectUrlPrefix (up to 5s) */
    function waitForPrefix (prefix) {
      const deadline = Date.now() + 5000
      return new Promise(function (resolve) {
        const check = function () {
          const nowUrl = wc.getURL()
          if (!prefix || agentRpcPrefixMatchesUrl(prefix, nowUrl)) { resolve({ url: nowUrl, matched: true }); return }
          if (Date.now() >= deadline) { resolve({ url: nowUrl, matched: false }); return }
          setTimeout(check, 250)
        }
        check()
      })
    }

    function attemptNavigate () {
      attemptCount++
      return new Promise(function (resolveAttempt) {
        let settled = false
        const timer = setTimeout(function () {
          if (settled) return
          settled = true
          cleanup()
          resolveAttempt({ outcome: 'timeout' })
        }, AGENT_RPC_SNAPSHOT_TIMEOUT)
        const cleanup = function () {
          wc.removeListener(settleEvent, onSettle)
          wc.removeListener(failEvent, onFail)
          clearTimeout(timer)
        }
        const onSettle = function () {
          if (settled) return
          settled = true
          navSettleAt = Date.now()
          cleanup()
          resolveAttempt({ outcome: 'loaded' })
        }
        const onFail = function (e, errorCode, errorDescription, validatedURL, isMainFrame) {
          if (settled || isMainFrame === false) return
          settled = true
          navSettleAt = Date.now()
          cleanup()
          resolveAttempt({ outcome: 'failed', errorCode: errorCode, errorDescription: errorDescription })
        }
        wc.on(settleEvent, onSettle)
        wc.on(failEvent, onFail)
        agentRpcClearSnapshotRefs(String(tabId))
        try {
          loadURLInView(tabId, params.url)
        } catch (e) {
          settled = true
          cleanup()
          resolveAttempt({ outcome: 'failed', errorCode: -1, errorDescription: 'loadURLInView threw' })
        }
      })
    }

    /* P1-01B: bounded URL-stability monitor. The URL must STAY UNCHANGED for
     * `windowMs` after the load settles; whenever it changes, the quiet
     * window restarts (so a delayed redirect - the observed signup-page
     * bounce family - and history.pushState SPA route changes are caught,
     * not just instant hops). A hard cap (windowMs + 10s) bounds pathological
     * flip-flopping pages. The classification distinguishes same-document
     * (pushState) from cross-document changes where the webContents events
     * allow it. Trade-off: larger windows detect later bounces but add
     * windowMs latency to every verified navigation. */
    function monitorStability (windowMs) {
      const pollMs = AGENT_RPC_NAV_POLL_MS
      const hardDeadline = Date.now() + windowMs + 10000
      return new Promise(function (resolve) {
        let lastUrl = wc.getURL()
        let lastChange = Date.now()
        let changes = 0
        let navKind = null
        let routeChangeKind = null
        const inPageNav = function (e, u, isMainFrame) { if (isMainFrame === false) return; navKind = 'same-document' }
        const crossNav = function (e, u, isMainFrame) { if (isMainFrame === false) return; navKind = 'cross-document' }
        function cleanup () {
          wc.removeListener('did-navigate-in-page', inPageNav)
          wc.removeListener('did-navigate', crossNav)
        }
        function finish (stable) {
          cleanup()
          /* first URL transition only - protocol-level URL data already in results */
          resolve({ url: lastUrl, stable: stable, changes: changes, routeChangeKind: routeChangeKind, changedFrom: changes > 0 ? firstUrl : null })
        }
        const firstUrl = lastUrl
        wc.on('did-navigate-in-page', inPageNav)
        wc.on('did-navigate', crossNav)
        const poll = function () {
          const nowUrl = wc.getURL()
          const now = Date.now()
          if (nowUrl !== lastUrl) {
            /* Min swaps its own internal pages (e.g. min://app/pages/error/
             * ...) asynchronously after a refused navigation; when settle
             * fired during such a swap the monitor would otherwise count the
             * REQUESTED navigation's arrival as a bounce. Internal min://
             * transitions are absorbed as re-anchors, never counted as page
             * changes; cross-document/same-document page changes always are. */
            const internal = lastUrl.indexOf('min://') === 0 || nowUrl.indexOf('min://') === 0
            if (!internal) {
              changes++
              routeChangeKind = navKind || 'unclassified'
            }
            lastUrl = nowUrl
            lastChange = now
          }
          if (now - lastChange >= windowMs) { finish(true); return }
          if (now >= hardDeadline) { finish(false); return }
          setTimeout(poll, pollMs)
        }
        poll()
      })
    }

    function classify (stab, windowMs) {
      const prefix = params.expectUrlPrefix
      const finalUrl = stab.url
      if (stab.changes === 0 && stab.stable) {
        if (prefix && !agentRpcPrefixMatchesUrl(prefix, finalUrl)) {
          return { verified: false, verification: 'redirected', finalUrl: finalUrl, failReason: 'URL drifted away from expectUrlPrefix during the stability window', urlChanges: 0 }
        }
        return { verified: true, verification: 'navigation', finalUrl: finalUrl, urlChanges: 0, routeChangeKind: null }
      }
      /* URL changed after the load event: a delayed redirect or a SPA route
       * change. Never reported as clean success (requirement: no false
       * success whenever the URL moved inside the verification window). */
      const kindNote = stab.routeChangeKind === 'same-document' ? 'same-document route change (history.pushState)' : (stab.routeChangeKind === 'cross-document' ? 'cross-document redirect' : 'URL change of unclassified kind')
      if (prefix && !agentRpcPrefixMatchesUrl(prefix, finalUrl)) {
        return { verified: false, verification: 'redirected', finalUrl: finalUrl, failReason: 'URL left expectUrlPrefix after a ' + kindNote + ' within the ' + windowMs + 'ms stability window', urlChanges: stab.changes, routeChangeKind: stab.routeChangeKind }
      }
      return { verified: false, verification: 'unstable', finalUrl: finalUrl, failReason: (stab.stable ? 'URL changed ' : 'URL kept changing ') + stab.changes + ' time(s) (' + kindNote + ') during the ' + windowMs + 'ms stability window', urlChanges: stab.changes, routeChangeKind: stab.routeChangeKind, stable: stab.stable === true, changedFrom: stab.changedFrom || null }
    }

    const navWindowMs = Math.max(0, Math.min(params.stabilityWindowMs === undefined ? AGENT_RPC_NAV_STABILITY_DEFAULT_MS : params.stabilityWindowMs, AGENT_RPC_NAV_STABILITY_MAX_MS))

    function attempt () {
      return attemptNavigate().then(function (res) {
        if (res.outcome === 'failed') {
          return { verified: false, verification: 'load_failed', finalUrl: wc.getURL(), failCode: res.errorCode, failReason: res.errorDescription }
        }
        if (res.outcome === 'timeout') {
          return { verified: false, verification: 'timeout', finalUrl: wc.getURL() }
        }
        /* loaded: bounded prefix wait (when requested), then the reset-on-change
         * stability window. The prefix is RE-CHECKED against the final URL after
         * the window, so a late redirect away from the expected URL is reported
         * as 'redirected', never hidden behind the earlier match. */
        if (params.expectUrlPrefix) {
          return waitForPrefix(params.expectUrlPrefix).then(function (p) {
            if (!p.matched) {
              return { verified: false, verification: 'redirected', finalUrl: p.url, failReason: 'URL never matched expectUrlPrefix within ' + AGENT_RPC_NAV_PREFIX_WAIT_MS + 'ms' }
            }
            return monitorStability(navWindowMs).then(function (stab) { return classify(stab, navWindowMs) })
          })
        }
        return monitorStability(navWindowMs).then(function (stab) { return classify(stab, navWindowMs) })
      }).then(function (res2) {
        if (res2.verified) return res2
        /* one bounded retry, ONLY for a prefix miss ('redirected'): re-issuing
         * the requested URL is a fresh, idempotent top-level GET and cannot
         * repeat page actions (forms, buttons, purchases). 'unstable'
         * (page mutates itself), 'load_failed' and 'timeout' are never
         * retried. */
        if (attemptCount < maxAttempts && params.expectUrlPrefix !== undefined && res2.verification === 'redirected') {
          return attempt()
        }
        return res2
      })
    }

    /* P1-04.2: deterministic transform lifecycle — clear this tab's transform
     * records exactly once per navigation request, AFTER all validation has
     * passed and immediately before the first navigation attempt. Rejected
     * requests (missing tab, invalid URL, bad params, detached view) never
     * reach this point, so their active transform records are preserved.
     * Prefix-miss retries re-issue the same navigation; the records were
     * already cleared before attempt 1, so no additional clear is performed. */
    agentRpcClearTransforms(String(tabId))

    attempt().then(function (res2) {
      resolveOnce({
        tabId: String(tabId),
        requestedUrl: params.url,
        finalUrl: res2.finalUrl !== undefined ? res2.finalUrl : wc.getURL(),
        title: view.webContents.isDestroyed() ? '' : wc.getTitle(),
        verified: res2.verified === true,
        verification: res2.verification,
        failCode: res2.failCode, failReason: res2.failReason,
        urlChanges: res2.urlChanges || 0,
        routeChangeKind: res2.routeChangeKind || null,
        changedFrom: res2.changedFrom || null,
        settleMs: navSettleAt ? (navSettleAt - startedAt) : 0,
        stabilityMs: navSettleAt ? Math.max(0, Date.now() - startedAt - (navSettleAt - startedAt)) : 0,
        stabilityWindowMs: navWindowMs,
        refsCleared: true,
        waitedMs: Date.now() - startedAt
      })
      /* P1-01E: remember the last navigation outcome per tab for
       * browser_state's blocked/apparently signal (bounded map). */
      try {
        AGENT_RPC_LAST_NAV.set(String(tabId), {
          verified: res2.verified === true,
          verification: res2.verification,
          at: Date.now()
        })
      } catch (eNav) { /* map unavailable */ }
    }).catch(function (e) {
      rejectOnce(e)
    })
  })
}

/* ---------- P1-04: reversible rendered-page transformations ---------- */
/* Per-tab records live only for this session; cleared on navigation and tab
 * close. Values that reach the page (text/style) are user/agent choices —
 * page text itself is never persisted here. */
const AGENT_RPC_TRANSFORM_ALLOWLIST = ['color', 'backgroundcolor', 'fontsize', 'fontweight', 'lineheight', 'maxwidth', 'textalign', 'visibility', 'padding', 'paddingtop', 'paddingbottom', 'margin', 'margintop', 'marginbottom']
const AGENT_RPC_TRANSFORM_MAX_ENTRIES = 50
var AGENT_RPC_TRANSFORMS = new Map()
var AGENT_RPC_TRANSFORM_SEQ = 0

function agentRpcClearTransforms (tabId) {
  try { AGENT_RPC_TRANSFORMS.delete(String(tabId)) } catch (e) { /* ignore */ }
}

function agentRpcValidateTransformValue (v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 120) return false
  if (/urn|url\s*\(|expression\s*\(|@|;|\{|\}|<|>/i.test(v)) return false
  return /^[A-Za-z0-9#,.%()\s/-]+$/.test(v) || /^-?[0-9.]+(px|em|rem|%|vh|vw|pt)?$/.test(v)
}

/* P1-04: transform resolution + state. One Map per tab; records hold the
 * EXACT original state per target. Records are cleared on navigation (the
 * browser discards the old document itself) and on tab close. */
function agentRpcResolveTargetForTransformPlan (tabId, plan) {
  const store = AGENT_SNAPSHOT_REFS.get(String(tabId))
  const tabRecs = AGENT_RPC_TRANSFORMS.get(String(tabId))
  const ops = []
  const missing = []
  for (let pi = 0; pi < plan.length; pi++) {
    const entry = plan[pi]
    if (entry.op === 'restore_all') {
      /* expand to per-record restores with the full restore envelope */
      if (tabRecs) {
        for (const tr of tabRecs.records.values()) {
          ops.push({ ordinal: tr.ordinal, role: tr.role, name: tr.name, nameIndex: tr.nameIndex, sel: tr.selector || null, op: 'restore_target', transformId: tr.id, original: { recordId: tr.id, props: tr.original && tr.original.props ? tr.original.props : null, textContentOriginal: tr.original && tr.original.text !== undefined ? tr.original.text : undefined }, marker: tr.marker || null })
        }
      }
      continue
    }
    /* P1-04.3: transformId-only restore_target — the documented restore path
     * ("restore using that exact transformId"). Resolves the record directly;
     * sel/ordinal/role fields mirror the selector-arm restore envelope so the
     * page fn can reach the same element (selector branch when rec.selector is
     * set, nodeEls lookup otherwise). */
    if (entry.op === 'restore_target' && typeof entry.transformId === 'string' && tabRecs) {
      const recTf = tabRecs.records.get(entry.transformId)
      if (recTf) {
        ops.push({ sel: recTf.selector || null, op: 'restore_target', transformId: recTf.id, ordinal: recTf.ordinal, role: recTf.role, name: recTf.name, nameIndex: recTf.nameIndex, original: { recordId: recTf.id, props: recTf.original && recTf.original.props ? recTf.original.props : null, textContentOriginal: recTf.original && recTf.original.text !== undefined ? recTf.original.text : undefined }, marker: recTf.marker || null })
        continue
      }
      missing.push({ transformId: entry.transformId, sel: null, op: entry.op, reason: 'restore failed: no active transformation recorded for transformId ' + entry.transformId })
      continue
    }
    if (typeof entry.selector === 'string' && entry.selector) {
      /* selector-targeted entry */
      if (entry.op === 'restore_target') {
        let rec = null
        if (tabRecs) {
          if (entry.transformId && tabRecs.records.get(entry.transformId)) rec = tabRecs.records.get(entry.transformId)
          if (!rec) { for (const tr of tabRecs.records.values()) { if (tr.selector === entry.selector) rec = tr } }
        }
        if (!rec) { missing.push({ selector: entry.selector, op: entry.op, reason: 'restore failed: no active transformation recorded for this selector' }); continue }
        ops.push({ sel: rec.selector, op: 'restore_target', transformId: rec.id, original: { recordId: rec.id, props: rec.original && rec.original.props ? rec.original.props : null, textContentOriginal: rec.original && rec.original.text !== undefined ? rec.original.text : undefined }, marker: rec.marker || null, ordinal: rec.ordinal, role: rec.role, name: rec.name, nameIndex: rec.nameIndex })
      } else {
        /* P1-04.2: selector-targeted entries MUST carry a unique synthetic
         * ordinal. Without one every selector op collides on
         * 'undefined:<op>' in the command's planById map (last-wins), which
         * mislabels the records of earlier batch targets with the LAST
         * plan entry's selector and can restore earlier targets' text into
         * the wrong element. The synthetic string can never collide with
         * ref-target numeric ordinals, and the page fn's identity check uses
         * the selector branch for sel-carrying ops (never nodeEls). */
        ops.push({ sel: entry.selector, op: entry.op, ordinal: 'sel' + pi })
        if (entry.op === 'replace_text') ops[ops.length - 1].text = entry.text
        if (entry.op === 'set_style') ops[ops.length - 1].style = Object.keys(entry.style).map(k => ({ prop: String(k).toLowerCase(), value: String(entry.style[k]) }))
      }
      continue
    }
    /* ref-targeted entry */
    let record = null
    if (store) {
      const matches = store.refs.filter(r2 => r2.ref === entry.ref)
      if (matches.length > 0) record = matches[matches.length - 1]
    }
    if (!record) {
      const reason = entry.op === 'restore_target' ? 'restore failed: no live snapshot ref (take a new snapshot)' : 'ref_not_found: no live snapshot ref (take a fresh snapshot)'
      missing.push({ ref: entry.ref, op: entry.op, reason: reason })
      continue
    }
    if (entry.op === 'restore_target') {
      let rec = null
      if (tabRecs) {
        if (entry.transformId && tabRecs.records.get(entry.transformId)) rec = tabRecs.records.get(entry.transformId)
        if (!rec) { for (const tr of tabRecs.records.values()) { if (tr.ref === entry.ref) rec = tr } }
      }
      if (!rec) { missing.push({ ref: entry.ref, op: entry.op, reason: 'restore failed: no active transformation recorded for this ref' }); continue }
      ops.push({ ordinal: rec.ordinal, role: rec.role, name: rec.name, nameIndex: rec.nameIndex, op: 'restore_target', transformId: rec.id, original: { recordId: rec.id, props: rec.original && rec.original.props ? rec.original.props : null, textContentOriginal: rec.original && rec.original.text !== undefined ? rec.original.text : undefined }, marker: rec.marker || null })
      continue
    }
    /* P1-11: carry ref into the op envelope so the transform record stores it;
     * without this, rec.ref was always null and restore_target by ref could never match. */
    ops.push({ ordinal: record.ordinal, role: record.role, name: record.name, nameIndex: record.nameIndex || 0, op: entry.op, ref: entry.ref })
    if (entry.op === 'replace_text') ops[ops.length - 1].text = entry.text
    if (entry.op === 'set_style') ops[ops.length - 1].style = Object.keys(entry.style).map(k => ({ prop: String(k).toLowerCase(), value: String(entry.style[k]) }))
  }
  return { ops: ops, missing: missing }
}

function agentRpcCommandTransform (params) {
  const startedAt = Date.now()
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  const wc = view.webContents
  if (wc.getURL() === '') {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view has no page loaded yet'))
  }
  let plan = null
  try { plan = JSON.parse(params.actions) } catch (eParse) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'actions is not valid JSON'))
  }
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > AGENT_RPC_TRANSFORM_MAX_ENTRIES) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'actions must be a JSON array of 1-' + AGENT_RPC_TRANSFORM_MAX_ENTRIES + ' entries'))
  }
  const validOps = ['replace_text', 'highlight', 'set_style', 'hide', 'restore_target', 'restore_all']
  for (let i = 0; i < plan.length; i++) {
    const e = plan[i]
    if (!e || typeof e !== 'object' || validOps.indexOf(e.op) === -1) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'entry ' + i + ': op must be one of the supported transforms'))
    }
    if (e.op === 'restore_all') { continue /* handled by the resolver: expands to per-record restores */ }
    const hasTfId = e.op === 'restore_target' && typeof e.transformId === 'string' && /^tf[0-9]+$/.test(e.transformId)
    const hasRef = typeof e.ref === 'string' && /^r[0-9a-z]{1,12}$/.test(e.ref)
    const hasSel = typeof e.selector === 'string' && e.selector.length >= 2 && e.selector.length <= 120 && /^[A-Za-z0-9#.:'"=\s\[\]()>_-]+$/.test(e.selector)
    if (!hasRef && !hasSel && !hasTfId) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'entry ' + i + ': requires ref (snapshot), selector (bounded CSS), or transformId (restore_target) targeting'))
    }
    if (e.op === 'replace_text' && (typeof e.text !== 'string' || e.text.length === 0 || e.text.length > 1200)) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'entry ' + i + ': replace_text requires text of 1-1200 characters'))
    }
    if (e.op === 'restore_target' && e.transformId !== undefined && (typeof e.transformId !== 'string' || !/^tf[0-9]+$/.test(e.transformId))) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'entry ' + i + ': transformId must be a tf<N> string'))
    }
    if (e.op === 'set_style') {
      if (!e.style || typeof e.style !== 'object' || Array.isArray(e.style) || Object.keys(e.style).length === 0 || Object.keys(e.style).length > 12) {
        return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'entry ' + i + ': set_style requires a style object of 1-12 properties'))
      }
      for (const k of Object.keys(e.style)) {
        if (AGENT_RPC_TRANSFORM_ALLOWLIST.indexOf(String(k).toLowerCase()) === -1) {
          return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'entry ' + i + ': style property not allowlisted: ' + k))
        }
        if (!agentRpcValidateTransformValue(String(e.style[k]))) {
          return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'entry ' + i + ': style value rejected for ' + k))
        }
      }
    }
    /* normalize target for the page fn */
    if (e.ref) e.ref = e.ref
    if (e.selector) e.sel = e.selector
  }
  const resolvedPlan = agentRpcResolveTargetForTransformPlan(params.tabId, plan)
  const source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('transform') + ',null,' + JSON.stringify({ ops: resolvedPlan.ops }) + ')'
  return wc.executeJavaScript(source).then(function (page) {
    if (!page || page.mode !== 'transform') {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'transform could not be applied in this view')
    }
    let tabRecs = AGENT_RPC_TRANSFORMS.get(String(params.tabId))
    if (!tabRecs) { tabRecs = { records: new Map() }; AGENT_RPC_TRANSFORMS.set(String(params.tabId), tabRecs) }
    const results = []
    for (const m of resolvedPlan.missing) {
      results.push({ sel: m.sel || null, ref: m.ref || null, op: m.op, ok: false, error: { category: m.op === 'restore_target' || m.op === 'restore_all' ? 'restore_failed' : 'ref_stale', message: m.reason } })
    }
    const planById = {}
    for (const o of resolvedPlan.ops) planById[o.ordinal + ':' + o.op] = o
    for (const r of page.ops) {
      const outEntry = { sel: r.sel || null, ordinal: r.ordinal, op: r.op, ok: r.ok === true }
      if (!r.ok) outEntry.error = { category: 'transform_target_failed', message: r.reason || 'transform failed' }
      if (r.ok && (r.op === 'replace_text' || r.op === 'highlight' || r.op === 'set_style' || r.op === 'hide')) {
        const id = 'tf' + (++AGENT_RPC_TRANSFORM_SEQ)
        outEntry.transformedId = id
        const recPlanSrc = planById[r.ordinal + ':' + (r.op === 'restore' ? 'restore_target' : r.op)] || null
        /* P1-11: persist role/name/nameIndex (and ref via plan above) on the record;
         * the ref-targeted restore envelope reads them back from the record. */
        const rec = { id: id, ref: recPlanSrc ? (recPlanSrc.ref || null) : null, selector: recPlanSrc ? (recPlanSrc.sel || null) : (r.sel || null), ordinal: r.ordinal, role: recPlanSrc ? (recPlanSrc.role || null) : null, name: recPlanSrc ? (recPlanSrc.name || null) : null, nameIndex: recPlanSrc ? (recPlanSrc.nameIndex || 0) : 0, op: r.op, original: r.original, appliedText: r.appliedText, at: Date.now(), url: wc.getURL() }
        tabRecs.records.set(id, rec)
      }
      if (r.ok && r.op === 'restore') {
        if (r.transformId) tabRecs.records.delete(r.transformId)
        outEntry.restoredText = r.restoredText
        outEntry.restoredId = r.transformId
      }
      if (r.rendered) outEntry.rendered = r.rendered
      results.push(outEntry)
    }
    /* apply-plan ops were in page order; keep the missing ones interleaved as
     * failures at their plan position for honest reporting. */
    const okCount = results.filter(r2 => r2.ok).length
    return {
      tabId: String(params.tabId),
      ok: results.length === 0 ? true : okCount === results.length,
      applied: okCount,
      failed: results.length - okCount,
      results: results,
      totalMs: Date.now() - startedAt
    }
  })
}

function agentRpcCommandTransformStatus (params) {
  const recs = AGENT_RPC_TRANSFORMS.get(String(params.tabId))
  if (!recs || recs.records.size === 0) {
    return Promise.resolve({ tabId: String(params.tabId), active: 0, ops: {}, drift: [], cleared: true })
  }
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.resolve({ tabId: String(params.tabId), active: 0, ops: {}, drift: [], cleared: true })
  }
  /* P1-04 close-out: URL-based lifecycle — navigation to a different URL discards prior transforms (the browser discarded the old document; no stale restore attempted). */
  const curUrl = view.webContents.getURL()
  for (const rec of recs.records.values()) {
    if (rec.url && rec.url !== curUrl) { recs.records.delete(rec.id) }
  }
  if (recs.records.size === 0) {
    return Promise.resolve({ tabId: String(params.tabId), active: 0, ops: {}, drift: [], cleared: true })
  }
  const opCounts = {}
  const driftList = []
  const opsForPage = []
  for (const rec of recs.records.values()) {
    opCounts[rec.op] = (opCounts[rec.op] || 0) + 1
    if (rec.appliedText) {
      /* P1-04.2: pass rec.selector so the page fn can resolve selector-targeted
       * records by selector (nodeEls lookups cannot work for them); without it
       * every selector record would false-positive as 'no longer enumerable'. */
      opsForPage.push({ ordinal: rec.ordinal, sel: rec.selector || undefined, role: rec.role, name: rec.name, nameIndex: rec.nameIndex, op: 'driftcheck', appliedText: rec.appliedText, transformId: rec.id })
    } else {
      const stillInViewportRange = false
      opsForPage.push({ ordinal: rec.ordinal, sel: rec.selector || undefined, role: rec.role, name: rec.name, nameIndex: rec.nameIndex, op: 'drift-styled', transformId: rec.id, markerCheck: true })
    }
  }
  const source = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('driftcheck') + ',null,' + JSON.stringify({ ops: opsForPage }) + ')'
  return view.webContents.executeJavaScript(source, { } ).then(function (page) {
    if (page && page.mode === 'driftcheck' && Array.isArray(page.ops)) {
      for (const p of page.ops) {
        if (p.op === 'driftcheck' && p.drift === true) driftList.push(p.transformId)
      }
    }
    return { tabId: String(params.tabId), active: recs.records.size, ops: opCounts, drift: driftList, cleared: false }
  }).catch(function () {
    return { tabId: String(params.tabId), active: recs.records.size, ops: opCounts, drift: driftList, cleared: false }
  })
}

function agentRpcCommandPress (params) {
  return new Promise(function (resolve, reject) {
    var tabId = params.tabId
    var view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
      return
    }
    if (!AGENT_RPC_PRESS_KEYS[params.key]) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'key is not in the supported set (no chords or modifiers)'))
      return
    }
    if (typeof isViewAttachedToAnyWindow === 'function' && !isViewAttachedToAnyWindow(view)) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.view_not_attached, 'view_not_attached', 'view is not attached to a live window; select the tab first (single-window scope)'))
      return
    }

    var wc = view.webContents
    var locateSource = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('locate') + ',null)'
    var timedOut = false
    var timer = setTimeout(function () {
      timedOut = true
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'page state could not be read within ' + AGENT_RPC_SNAPSHOT_TIMEOUT + 'ms'))
    }, AGENT_RPC_SNAPSHOT_TIMEOUT)

    wc.executeJavaScript(locateSource)
      .then(function (page) {
        if (timedOut) return
        clearTimeout(timer)
        if (!page || page.mode !== 'locate') {
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'page state could not be read'))
          return
        }
        var focusOrdinal = null
        page.nodes.forEach(function (n, i) { if (n.focused === true && focusOrdinal === null) focusOrdinal = i })
        var pre = {
          mode: 'press',
          url: page.url,
          title: page.title,
          marker: page.marker,
          enumLen: page.total,
          focusOrdinal: focusOrdinal,
          dispatchedAt: Date.now()
        }
        try {
          wc.sendInputEvent({ type: 'keyDown', keyCode: agentRpcTranslateKey(params.key) })
          wc.sendInputEvent({ type: 'keyUp', keyCode: agentRpcTranslateKey(params.key) })
        } catch (e) {
          throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'input dispatch failed')
        }
        agentRpcLog('action dispatched', 'press', 'key=' + params.key)
        return agentRpcRunVerification(wc, tabId, null, pre, false, null).then(function (v) {
          return {
            tabId: String(tabId),
            key: params.key,
            dispatched: true,
            verified: v.verified,
            verification: v.kind,
            url: pre.url,
            title: pre.title,
            waitedMs: Date.now() - pre.dispatchedAt
          }
        })
      })
      .then(function (result) { resolve(result) }, function (err) { reject(err) })
      .catch(function () {
        if (timedOut) return
        clearTimeout(timer)
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'press could not be dispatched'))
      })
  })
}

/* ---------- P1-06: agent-usable vision + typed mouse ---------- */
/* Viewport metadata for coordinates: fixed source (no request data is ever
 * interpolated into page code). Values are CSS pixels; sendInputEvent takes
 * the same viewport CSS-pixel space (see docs/audit P1-06 addendum). */
var AGENT_RPC_VIEWPORT_META_SRC = '(function(){try{return JSON.stringify({iw:window.innerWidth,ih:window.innerHeight,dpr:window.devicePixelRatio||1,sx:window.scrollX||0,sy:window.scrollY||0,ready:document.readyState})}catch(e){return null}})()'
var AGENT_RPC_SS_SEQ = 0
var AGENT_RPC_SCREENSHOTS = new Map()
var AGENT_RPC_MOUSE_LASTPOS = new Map()
var AGENT_RPC_BOUNDS_STORE = new Map()
var AGENT_RPC_MOUSE_PRESSED = new Map()
var AGENT_RPC_MOUSE_BUSY = new Map()
var AGENT_RPC_MOUSE_JOBS = new Map()

function agentRpcMouseAbort (tabId) {
  const job = AGENT_RPC_MOUSE_JOBS.get(String(tabId))
  if (job) { job.aborted = true; if (job.timer) clearTimeout(job.timer) }
  AGENT_RPC_MOUSE_JOBS.delete(String(tabId))
  AGENT_RPC_MOUSE_BUSY.delete(String(tabId))
  const btn = AGENT_RPC_MOUSE_PRESSED.get(String(tabId))
  AGENT_RPC_MOUSE_PRESSED.delete(String(tabId))
  if (btn) {
    const view = viewMap[tabId]
    if (view && view.webContents && !view.webContents.isDestroyed()) {
      const b = (typeof view.getBounds === 'function' ? view.getBounds() : null) || { width: 1, height: 1 }
      try { view.webContents.sendInputEvent({ type: 'mouseUp', x: Math.max(0, b.width - 1), y: Math.max(0, b.height - 1), button: btn, clickCount: 1 }) } catch (eR) { /* best effort */ }
    }
  }
}

function agentRplFetchViewportMeta (wc) {
  return wc.executeJavaScript(AGENT_RPC_VIEWPORT_META_SRC).then(function (m) {
    try { const parsed = JSON.parse(m); if (parsed && typeof parsed.iw === 'number') return parsed } catch (e) { /* null */ }
    return null
  }).catch(function () { return null })
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
    var settled = false
    /* capturePage can reject transiently AND can wedge without ever settling
     * on this Electron (observed after rapid successive navigations:
     * docs/agent-nps-probe.json). It is read-only, so bounded retries carry no
     * double-effect risk - unlike input dispatch. Each attempt gets its own
     * soft timeout; a wedged attempt is abandoned and a fresh one issued,
     * inside an overall deadline below. The attached-view guard above stays:
     * the P0-08 same-tick-after-detach hang is prevented before this point. */
    var attempts = 0
    var overall = setTimeout(function () {
      if (settled) return
      settled = true
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'capture did not complete within ' + AGENT_RPC_SNAPSHOT_TIMEOUT + 'ms'))
    }, AGENT_RPC_SNAPSHOT_TIMEOUT)
    var attempt = function () {
      if (settled || attempts >= 6) return
      attempts++
      var attemptSettled = false
      var perAttempt = setTimeout(function () {
        if (attemptSettled) return
        attemptSettled = true
        /* wedged: abandon this attempt and try again */
        if (attempts < 6) setTimeout(attempt, 200)
        else if (!settled) {
          settled = true
          clearTimeout(overall)
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'capture did not settle (' + attempts + ' attempts)'))
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
            else if (!settled) {
              settled = true
              clearTimeout(overall)
              reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'captured a zero-size image (view not rendered)'))
            }
            return
          }
          var data = img.toPNG().toString('base64')
          if (!agentRpcScreenshotSizeOk(data.length)) {
            if (!settled) {
              settled = true
              clearTimeout(overall)
              reject(agentRpcCommandError(AGENT_RPC_ERRORS.screenshot_too_large, 'screenshot_too_large', 'encoded image exceeds ' + AGENT_RPC_SCREENSHOT_MAX + ' bytes'))
            }
            return
          }
          if (!settled) {
            settled = true
            clearTimeout(overall)
            /* P1-06: optional format/scale + identity + viewport metadata. The
             * image pixel size vs CSS viewport gives the exact px->css factor
             * the agent needs to map screenshot coordinates for browser_mouse. */
            var outFmt = params.format === 'jpeg' ? 'jpeg' : 'png'
            var img2 = img
            var iw2 = size.width
            var ih2 = size.height
            if (params.maxWidth !== undefined || params.maxHeight !== undefined) {
              var swF = params.maxWidth !== undefined ? params.maxWidth / iw2 : 1
              var shF = params.maxHeight !== undefined ? params.maxHeight / ih2 : 1
              var scale = Math.min(swF, shF, 1)
              if (scale < 1) {
                img2 = img2.resize({ width: Math.max(1, Math.round(iw2 * scale)), height: Math.max(1, Math.round(ih2 * scale)) })
                iw2 = img2.getSize().width
                ih2 = img2.getSize().height
              }
            }
            var outBuf
            var outMime
            if (outFmt === 'jpeg') { outBuf = img2.toJPEG(params.quality === undefined ? 80 : params.quality); outMime = 'image/jpeg' } else { outBuf = img2.toPNG(); outMime = 'image/png' }
            var outData = outBuf.toString('base64')
            if (!agentRpcScreenshotSizeOk(outData.length)) {
              reject(agentRpcCommandError(AGENT_RPC_ERRORS.screenshot_too_large, 'screenshot_too_large', 'encoded image exceeds ' + AGENT_RPC_SCREENSHOT_MAX + ' bytes; use format=jpeg or maxWidth/maxHeight'))
              return
            }
            agentRplFetchViewportMeta(wc).then(function (meta) {
              var id = 'ss' + (++AGENT_RPC_SS_SEQ)
              var vp = { width: meta ? meta.iw : null, height: meta ? meta.ih : null, dpr: meta ? meta.dpr : null, scrollX: meta ? meta.sx : null, scrollY: meta ? meta.sy : null }
              var rec = { id: id, tabId: String(tabId), viewport: vp, zoom: wc.getZoomFactor(), imageWidth: iw2, imageHeight: ih2, format: outMime, at: Date.now() }
              try { var u2 = new URL(wc.getURL()); rec.urlPath = u2.origin + u2.pathname } catch (e3) { rec.urlPath = null }
              AGENT_RPC_SCREENSHOTS.set(id, rec)
              const cap = Array.from(AGENT_RPC_SCREENSHOTS.keys())
              while (cap.length > 25) { AGENT_RPC_SCREENSHOTS.delete(cap.shift()) }
              var cssFactor = vp.width ? (iw2 / vp.width) : 1
              resolve({
                tabId: String(tabId),
                screenshotId: id,
                mimeType: outMime,
                bytes: outData.length,
                width: iw2,
                height: ih2,
                coordinateUnits: 'viewport-css-px',
                cssPerPixel: cssFactor,
                viewport: vp,
                zoom: rec.zoom,
                urlPath: rec.urlPath,
                timestamp: new Date().toISOString(),
                data: outData
              })
            })
          }
        })
        .catch(function () {
          if (attemptSettled || settled) return
          attemptSettled = true
          clearTimeout(perAttempt)
          if (attempts < 6) setTimeout(attempt, 200)
          else if (!settled) {
            settled = true
            clearTimeout(overall)
            reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'capture did not succeed (' + attempts + ' attempts)'))
          }
        })
    }
    attempt()
  })
}

/* ---------- transport ---------- */

function agentRpcRateAllowed () {
  var now = Date.now()
  if (now - agentRpcState.rateWindowStart > 1000) {
    agentRpcState.rateWindowStart = now
    agentRpcState.rateWindowCount = 0
  }
  agentRpcState.rateWindowCount++
  return agentRpcState.rateWindowCount <= AGENT_RPC_MAX_REQUESTS_PER_SECOND
}

function agentRpcSendJson (res, httpStatus, payload) {
  var body = JSON.stringify(payload)
  res.writeHead(httpStatus, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    /* No CORS headers are sent at all, so no cross-origin read is ever permitted. */
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
}

function agentRpcHandleRequest (req, res) {
  agentRpcState.requestCount++

  var remote = (req.socket && req.socket.remoteAddress) || ''
  /* Defence in depth: the listen address is already 127.0.0.1, but never rely
   * on that alone. */
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    agentRpcState.rejectedCount++
    agentRpcLog('rejected: non-loopback peer')
    res.destroy()
    return
  }

  if (Date.now() < agentRpcState.cooldownUntil) {
    agentRpcState.rejectedCount++
    agentRpcLog('rejected: cooldown')
    agentRpcSendJson(res, 429, { jsonrpc: '2.0', id: null, error: agentRpcJsonError(AGENT_RPC_ERRORS.busy, 'busy', 'too many failed attempts') })
    return
  }
  if (!agentRpcRateAllowed()) {
    agentRpcState.rejectedCount++
    agentRpcLog('rejected: rate limit')
    agentRpcSendJson(res, 429, { jsonrpc: '2.0', id: null, error: agentRpcJsonError(AGENT_RPC_ERRORS.busy, 'busy', 'rate limit exceeded') })
    return
  }

  var chunks = []
  var tooLarge = false

  req.on('data', function (chunk) {
    if (tooLarge) {
      return
    }
    var size = chunks.reduce(function (n, c) { return n + c.length }, 0) + chunk.length
    if (size > AGENT_RPC_MAX_BODY_BYTES) {
      tooLarge = true
      agentRpcState.rejectedCount++
      agentRpcLog('rejected: body too large')
      agentRpcSendJson(res, 413, { jsonrpc: '2.0', id: null, error: agentRpcJsonError(AGENT_RPC_ERRORS.invalid_request, 'invalid_request', 'request body too large') })
      req.destroy()
      return
    }
    chunks.push(chunk)
  })

  req.on('error', function () {
    agentRpcState.rejectedCount++
    agentRpcLog('rejected: stream error')
  })

  req.on('aborted', function () {
    agentRpcState.rejectedCount++
    agentRpcLog('rejected: aborted')
  })

  req.on('end', function () {
    if (tooLarge) {
      return
    }
    var bodyText = Buffer.concat(chunks).toString('utf8')
    var verdict = agentRpcValidate({
      method: req.method,
      url: (req.url || '').split('?')[0],
      headers: req.headers,
      port: agentRpcState.port,
      expectedToken: agentRpcState.token
    }, bodyText)

    if (!verdict.ok) {
      agentRpcState.rejectedCount++
      if (verdict.error.category === 'unauthorized') {
        agentRpcState.authFailures++
        if (agentRpcState.authFailures >= AGENT_RPC_MAX_AUTH_FAILURES) {
          agentRpcState.cooldownUntil = Date.now() + AGENT_RPC_AUTH_COOLDOWN_MS
          agentRpcLog('auth cooldown engaged')
        }
      }
      /* Log category only - never the header, body, URL or token. */
      agentRpcLog('rejected:', verdict.error.category, '(' + chunks.length + ' chunks)')
      agentRpcSendJson(res, verdict.httpStatus, { jsonrpc: '2.0', id: null, error: verdict.error })
      return
    }

    var outcome
    var dispatchStartedAt = Date.now()
    try {
      outcome = agentRpcDispatch(verdict.request.method, verdict.request.params)
      agentRpcTelemetryRecordSync(verdict.request.method, outcome, dispatchStartedAt)
    } catch (e) {
      if (e && e.agentRpcCommandError) {
        agentRpcSendJson(res, AGENT_RPC_COMMAND_HTTP_STATUS[e.category] || 500, { jsonrpc: '2.0', id: verdict.request.id, error: e })
      } else {
        agentRpcState.rejectedCount++
        agentRpcLog('handler failed:', (e && e.stack ? String(e.stack).split('\n')[0] : String(e)))
        agentRpcSendJson(res, 500, { jsonrpc: '2.0', id: verdict.request.id, error: agentRpcJsonError(AGENT_RPC_ERRORS.internal, 'internal', 'command failed: ' + (e && e.message ? e.message : 'unknown')) })
      }
      return
    }

    if (outcome && typeof outcome.then === 'function') {
      outcome.then(function (result) {
        agentRpcTelemetryRecordAsync(verdict.request.method, dispatchStartedAt)
        agentRpcSendJson(res, 200, { jsonrpc: '2.0', id: verdict.request.id === undefined ? null : verdict.request.id, result: result })
      }, function (err) {
        agentRpcTelemetryRecordAsync(verdict.request.method, dispatchStartedAt, err && err.category)
        if (err && err.agentRpcCommandError) {
          agentRpcSendJson(res, AGENT_RPC_COMMAND_HTTP_STATUS[err.category] || 500, { jsonrpc: '2.0', id: verdict.request.id, error: err })
        } else {
          agentRpcLog('handler failed:', (err && err.stack ? String(err.stack).split('\n')[0] : String(err)))
          agentRpcSendJson(res, 500, { jsonrpc: '2.0', id: verdict.request.id, error: agentRpcJsonError(AGENT_RPC_ERRORS.internal, 'internal', 'command failed: ' + (err && err.message ? err.message : 'unknown')) })
        }
      })
      return
    }

    agentRpcSendJson(res, 200, { jsonrpc: '2.0', id: verdict.request.id === undefined ? null : verdict.request.id, result: outcome })
  })
}

function agentRpcWriteDiscoveryFile () {
  var file = agentRpcPath.join(userDataPath, AGENT_RPC_DISCOVERY_FILE)
  var payload = JSON.stringify({
    v: 1,
    url: 'http://' + agentRpcState.host + ':' + agentRpcState.port + '/rpc',
    token: agentRpcState.token,
    pid: process.pid,
    version: app.getVersion(),
    launchedAt: new Date(agentRpcState.startedAt).toISOString()
  }, null, 2)
  try {
    /* 0600 is advisory on Windows (NTFS ACLs govern access) but exact on
     * POSIX. Stated, not assumed strong. */
    agentRpcFs.writeFileSync(file, payload, { mode: 0o600 })
    try { agentRpcFs.chmodSync(file, 0o600) } catch (e) { /* Windows */ }
    agentRpcState.discoveryFile = file
  } catch (e) {
    agentRpcLog('failed to write discovery file')
  }
}

function agentRpcRemoveDiscoveryFile () {
  if (!agentRpcState.discoveryFile) {
    return
  }
  try {
    agentRpcFs.unlinkSync(agentRpcState.discoveryFile)
  } catch (e) { /* already gone */ }
  agentRpcState.discoveryFile = null
}

function agentRpcStartServer () {
  if (agentRpcState.server) {
    return
  }

  /* A previous run that was force-killed or crashed never reached before-quit,
   * so a stale file can still be sitting there. Remove it before anything new
   * is published, so a client can never read a dead launch's port and token. */
  try {
    agentRpcFs.unlinkSync(agentRpcPath.join(userDataPath, AGENT_RPC_DISCOVERY_FILE))
  } catch (e) { /* nothing there */ }

  agentRpcState.token = agentRpcCrypto.randomBytes(32).toString('hex')
  agentRpcState.host = '127.0.0.1'
  agentRpcState.startedAt = Date.now()

  var server = agentRpcHttp.createServer(agentRpcHandleRequest)

  server.on('clientError', function (err, socket) {
    agentRpcState.rejectedCount++
    /* Malformed request line: answer 400 and close. err.code is a parser code
     * such as HPE_INVALID_METHOD, never request content. */
    agentRpcLog('rejected: client error', err && err.code ? err.code : 'unknown')
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    }
  })

  server.on('error', function () {
    agentRpcLog('server error')
    agentRpcState.server = null
  })

  /* port 0 -> OS-assigned ephemeral port. Never a fixed port. */
  server.listen(0, agentRpcState.host, function () {
    agentRpcState.port = server.address().port
    agentRpcState.server = server
    agentRpcWriteDiscoveryFile()
    agentRpcStartRefSweep()
    /* P1-05: also observe the default session (internal pages) — no new
     * will-download listener type is added beyond the pre-existing additive
     * observation listener, and managed decisions still flow through the
     * centralized hook in main/download.js downloadHandler(). */
    try {
      const electronSession = require('electron').session
      if (electronSession && electronSession.defaultSession) agentRpcEnsureDownloadTracking(electronSession.defaultSession)
    } catch (eDs) { /* defaultSession unavailable before ready — views' partition session is the primary path */ }
    /* Port only. The token is never logged. */
    agentRpcLog('listening on 127.0.0.1:' + agentRpcState.port)
  })
}

function agentRpcStopServer () {
  agentRpcRemoveDiscoveryFile()
  agentRpcStopRefSweep()
  AGENT_SNAPSHOT_REFS.clear()
  if (agentRpcState.server) {
    try { agentRpcState.server.close() } catch (e) { /* already closed */ }
    agentRpcState.server = null
  }
}

app.on('ready', function () {
  if (!agentRpcEnabledByArgv()) {
    return
  }
  agentRpcStartServer()
})

app.on('before-quit', function () {
  agentRpcStopServer()
})

process.on('exit', function () {
  agentRpcRemoveDiscoveryFile()
})
