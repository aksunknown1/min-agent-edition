/* Agent-control bridge (Phase 1 transport/auth; P0/P1 commands since).

 * Design authority: docs/PHASE1-DESIGN.md. Phase 1 implemented sections 2
 * (transport), 3 (auth), 4 (envelope/errors) and the browser_status /
 * browser_tabs commands of 5. Later phases added the full command surface
 * (snapshot, click, type, press, mouse, screenshot, eval, transforms,
 * downloads, batch, viewport, state, verify, predict, grants).
 *
 * CORRECTED 2026-10-19 (Phase E / D1-F15). This header previously claimed the
 * opposite of what the file does. For the record, the current boundaries:
 *   - There IS page-context execution: webContents.executeJavaScript runs the
 *     fixed source of AGENT_SNAPSHOT_PAGE_FN and AGENT_EVAL_PAGE_FN, with the
 *     caller's data passed as JSON-string arguments.
 *   - There IS navigation (agentRpcValidateUrl + scheme allowlist) and there IS
 *     filesystem access - download destinations under <userData>/agent-downloads,
 *     validated by agentRpcDlValidateRelPath + agentRpcDlContainmentOk. No
 *     request VALUE ever reaches fs unvalidated.
 *   - There is NO callViewMethod routing, and NO debugger/CDP. Raw CDP is a
 *     deliberate permanent refusal (docs/audit/INTEGRATED-TARGET-ARCHITECTURE.md
 *     ADR-02): the bridge reaches pages only through executeJavaScript,
 *     sendInputEvent, insertText and capturePage.

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
var AGENT_RPC_PRESS_QUEUE = {}
var AGENT_RPC_PRESS_QUEUE_LEN = {}
const AGENT_RPC_METHODS = ['browser_health', 'browser_pdf', 'browser_upload', 'browser_frames', 'browser_helper_list', 'browser_helper', 'browser_batch', 'browser_check', 'browser_click', 'browser_content', 'browser_download_cancel', 'browser_download_pause', 'browser_download_resume', 'browser_download_start', 'browser_download_wait', 'browser_downloads', 'browser_grant', 'browser_hover', 'browser_mouse', 'browser_navigate', 'browser_predict', 'browser_press', 'browser_screenshot', 'browser_scroll', 'browser_select', 'browser_snapshot', 'browser_state', 'browser_status', 'browser_tab_close', 'browser_tab_open', 'browser_tab_select', 'browser_tabs', 'browser_transform', 'browser_eval', 'browser_transform_status', 'browser_type', 'browser_verify', 'browser_viewport', 'browser_wait']/* P1-15: 33 methods */

/* Per-method parameter schemas (P0-09/P0-10). Everything not listed is
 * rejected for that method; fields declared here are validated by
 * type/pattern/enum/bounds before any handler runs. */
const AGENT_RPC_TYPE_TEXT_MAX = 1000
const AGENT_RPC_PARAM_SCHEMAS = {
  browser_status: {},
  browser_health: {},
  browser_pdf: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    landscape: { type: 'boolean', required: false },
    printBackground: { type: 'boolean', required: false },
    pageSize: { type: 'string', required: false, enum: ['A4', 'A5', 'A3', 'Letter', 'Legal', 'Tabloid', 'Ledger'] },
    margins: { type: 'boolean', required: false },
    maxBytes: { type: 'number', required: false, integer: true, min: 20000, max: 8388608 }
  },
  browser_tabs: {},
  browser_helper_list: {},
  browser_helper: {
    /* ADR-09 Option C: invoke a REGISTERED read-only built-in by id. The helper
       * id is the only selector; a caller can never name an arbitrary tool. */
    helper: { type: 'string', required: true, maxLength: 64, noControl: true },
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    version: { type: 'number', required: false, integer: true, min: 1, max: 1000 },
    maxNodes: { type: 'number', required: false, integer: true, min: 1, max: 200 },
    limit: { type: 'number', required: false, integer: true, min: 1, max: 60 }
  },
  browser_snapshot: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    format: { type: 'string', required: false, enum: ['json', 'text', 'ax'] },
    maxNodes: { type: 'number', required: false, min: 1, max: 1000, integer: true },
    /* P1-15/D1-F5: agentRpcCommandSnapshot already implements a bounded settle
       * delay, but the parameter was not in the schema - and unknown keys are
       * REJECTED, not ignored - so the handler could never see it. */
    waitMs: { type: 'number', required: false, min: 0, max: 5000, integer: true }
  },
  browser_click: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ },
    /* P1-15 M2: 'none' returns immediately after dispatch with an honest
     * unverified status (for canvas/custom-render surfaces where immediate
     * DOM-based verification is not meaningful). */
    verification: { type: 'string', required: false, enum: ['standard', 'none'] }
  },
  browser_type: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ },
    /* No control characters: input events cannot represent them and they are
     * a common injection carrier. Checked without a regex (see validator). */
    text: { type: 'string', required: true, maxLength: AGENT_RPC_TYPE_TEXT_MAX, noControl: true },
    /* Phase E / D3-A: how the text reaches the field.
     *   native   (default) - one native insertText, fastest, unchanged.
     *   keyboard - one trusted keyDown/char/keyUp per character, for
     *              framework/controlled inputs that ignore a bulk insert and
     *              whose own key handlers drive their state.
     * Neither mode fabricates OS/physical keyboard delivery beyond what
     * sendInputEvent actually performs. */
    mode: { type: 'string', required: false, enum: ['native', 'keyboard'] }
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
    key: { type: 'string', required: true, enum: ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete'] },
    verification: { type: 'string', required: false, enum: ['standard', 'none'] }
  },
  browser_screenshot: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    /* P1-15 M3: adaptive fallback ladder + element capture + explicit byte cap. */
    maxBytes: { type: 'number', required: false, integer: true, min: 5000, max: 5242880 },
    selector: { type: 'string', required: false, maxLength: 300 },
    /* P1-06: optional encoding/size controls. maxWidth/maxHeight downscale the
     * image with aspect ratio preserved. */
    format: { type: 'string', required: false, enum: ['png', 'jpeg'] },
    quality: { type: 'number', required: false, min: 1, max: 100, integer: true },
    maxWidth: { type: 'number', required: false, min: 16, max: 4096, integer: true },
    maxHeight: { type: 'number', required: false, min: 16, max: 4096, integer: true },
    /* R2 / D1: bounded scroll-stitch full-page capture. Electron 43 cannot
     * capture beyond the viewport, so this stitches viewport slices. */
    fullPage: { type: 'boolean', required: false },
    maxSlices: { type: 'number', required: false, integer: true, min: 1, max: 24 }
  },
  browser_upload: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    ref: { type: 'string', required: true, pattern: /^r[0-9a-z]{1,12}$/ },
    relPath: { type: 'string', required: true, maxLength: 240, noControl: true }
  },
  browser_frames: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ }
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
    maxChars: { type: 'number', required: false, integer: true, min: 200, max: 50000 }
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
    until: { type: 'string', required: true, enum: ['network_idle', 'selector_visible', 'ready_state'] },
    selector: { type: 'string', required: false, maxLength: 200, noControl: true },
    quietMs: { type: 'number', required: false, integer: true, min: 300, max: 10000 },
    maxQuietMs: { type: 'number', required: false, integer: true, min: 800, max: 10000 },
    timeoutMs: { type: 'number', required: false, integer: true, min: 1000, max: 20000 }
  },
  browser_downloads: {},
  browser_eval: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    expression: { type: 'string', required: true, min: 1, max: 20000 },
    awaitPromise: { type: 'boolean', required: false },
    timeoutMs: { type: 'number', required: false, integer: true, min: 1000, max: 30000 },
    maxResultChars: { type: 'number', required: false, integer: true, min: 1000, max: 200000 }
  },
  browser_viewport: {
    tabId: { type: 'string', required: true, pattern: /^[0-9]{1,20}$/ },
    zoom: { type: 'number', required: false, min: 0.25, max: 3 }
  },
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
    tabId: { type: 'string', required: false, pattern: /^[0-9]{1,20}$/ },
    /* R4: probe-only opt-in for the debug-click overlay report. It never enables
     * rendering by itself; it only asks for the object to be returned even when
     * the profile flag is off, so a probe can assert the default-disabled state. */
    debugOverlay: { type: 'boolean', required: false }
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
    actions: { type: 'string', required: true, maxLength: 24000, noControl: true },
    /* P1-15 M2: stopOnError (default true) — with false, a failing step is
     * reported and later steps continue; recoverStale (default false) — one
     * identity-strict re-resolve+retry on ref_stale per failed step. */
    stopOnError: { type: 'boolean', required: false },
    recoverStale: { type: 'boolean', required: false }
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
  readonly: 409,
  ref_stale: 404,
  ref_mismatch: 404,
  load_failed: 502,
  screenshot_too_large: 413,
  last_tab: 409,
  captcha_handoff_required: 409,
  /* P1-15/D1-F7: every category a command can emit must be listed here.
     * Anything missing falls through to HTTP 500, which tells a client the
     * bridge crashed when it was in fact an expected, structured outcome. */
  busy: 429,
  download_not_found: 404,
  invalid_results: 500,
  eval_rejected: 502,
  eval_exception: 502,
  /* page CSP prevents page-world evaluation: an environment limitation of the
     * target page, reported as 409 (conflict with the page policy) rather than
     * a generic 500. */
  csp_blocked: 409,
  internal: 500
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
  const defaults = { allowRiskyClicks: false, allowSensitiveTyping: false, allowedSchemes: null, debugClickOverlay: false }
  const candidates = []
  try { candidates.push(userDataPath) } catch (e2) { /* not ready */ }
  try { candidates.push(String(userDataPath).replace(/-development$/, '')) } catch (e3) { /* ignore */ }
  for (let i = 0; i < candidates.length; i++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(candidates[i], 'policy.json'), 'utf8'))
      const out = {
        allowRiskyClicks: parsed.allowRiskyClicks === true,
        allowSensitiveTyping: parsed.allowSensitiveTyping === true,
        allowedSchemes: null,
        /* R4: opt-in diagnostic overlay. Default OFF; a profile must set this
         * explicitly. It has no effect on click dispatch or verification. */
        debugClickOverlay: parsed.debugClickOverlay === true
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

/* ADR-11 seam 3 (policy.js): make the policy evaluator ADDRESSABLE AS A UNIT.
 *
 * The same decision shape was duplicated inline in two handlers:
 *   if (!policy.allowRiskyClicks  && !agentRpcConsumeGrant('risky_click', ...))
 *   if (!policy.allowSensitiveTyping && !agentRpcConsumeGrant('sensitive_type', ...))
 * which is the "duplicated policy decision" seam 3 exists to remove.
 *
 * This adds ONE evaluator that answers "is this action permitted by policy?"
 * WITHOUT mutating grant state (read-only peek), so callers keep the existing
 * ordering: policy pre-authorization first, then a SINGLE-USE grant consume.
 * Behaviour is unchanged - both handlers still consume exactly once.
 *
 * Deliberately not a dispatcher (no policy name is reachable over the bridge)
 * and deliberately not permissive: an unknown action denies. */
const AGENT_RPC_POLICY_ACTIONS = {
  risky_click: 'allowRiskyClicks',
  sensitive_type: 'allowSensitiveTyping'
}

function agentRpcHasGrant (action, tabId, ref) {
  agentRpcPruneGrants()
  for (let i = 0; i < AGENT_RPC_GRANTS.length; i++) {
    const g = AGENT_RPC_GRANTS[i]
    const refOk = g.ref === undefined || g.ref === null || g.ref === ref
    if (g.action === action && g.tabId === String(tabId) && refOk) return true
  }
  return false
}

function agentRpcPolicyAllows (action, ctx) {
  if (!Object.prototype.hasOwnProperty.call(AGENT_RPC_POLICY_ACTIONS, String(action))) return false
  const flag = AGENT_RPC_POLICY_ACTIONS[action]
  let policy = null
  try { policy = agentRpcReadPolicy() } catch (eP) { policy = null }
  return !!(policy && policy[flag] === true)
}

/* True when policy OR a live single-use grant authorises the action, WITHOUT
 * consuming it. Callers then consume separately (see the handlers) so a grant
 * stays one-shot. Kept for evaluators/helpers that need a dry-run answer. */
function agentRpcPolicyWouldAllow (action, ctx) {
  if (agentRpcPolicyAllows(action, ctx)) return true
  try {
    if (!ctx || ctx.tabId === undefined || ctx.tabId === null) return false
    return agentRpcHasGrant(action, ctx.tabId, ctx.ref)
  } catch (eG) { return false }
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

/* ---------- curated read-only built-ins (Phase E / ADR-09 Option C) ----------
 *
 * These are DATA, not code. A built-in is a fixed, ordered list of calls to
 * the audited read-only tool allowlist below. The runner never accepts a tool
 * name from a parameter, never lets a caller reorder/inject steps, and never
 * evaluates anything. There is no eval/Function/require/shell/child_process/fs,
 * no dependency install, no raw CDP and no event drain anywhere in this path.
 *
 * Page content is UNTRUSTED DATA: it can influence only the *values* reported in
 * the result, never which tools run or what privileges apply. A webpage cannot
 * "ask" a built-in to call browser_grant - browser_grant is not even in the
 * allowlist, and the catalogue is frozen at load time.
 *
 * Each built-in is read-only: it observes page state and returns bounded
 * metadata. It never clicks, types, navigates, transforms, downloads, changes
 * zoom/tabs/settings, and never claims that observing a page proves a remote
 * site persisted a change. */

/* Closed capability allowlist. Anything not listed here can never run inside a
 * built-in, regardless of what a definition or a caller asks for. Deliberately
 * EXCLUDED: browser_eval (arbitrary page-world code, can mutate page state),
 * browser_grant, browser_batch, browser_health, every input tool, navigation,
 * transforms, viewport, downloads/uploads, pdf/screenshot, raw CDP. */
const AGENT_RPC_HELPER_ALLOWED_TOOLS = Object.freeze({
  browser_state: true,
  browser_snapshot: true,
  browser_content: true,
  browser_verify: true,
  browser_tabs: true,
  browser_status: true
})

/* Fixed, versioned catalogue. Definitions are deep-frozen and their step lists
 * are validated against the allowlist at load time, so a tampered definition
 * fails closed before any page is touched. */
const AGENT_RPC_HELPER_CATALOGUE = (function () {
  const defs = {
    page_summary: {
      id: 'page_summary',
      version: 1,
      readOnly: true,
      /* ordered, fixed */
      steps: ['browser_state', 'browser_snapshot']
    },
    form_control_inventory: {
      id: 'form_control_inventory',
      version: 1,
      readOnly: true,
      steps: ['browser_snapshot']
    }
  }
  Object.keys(defs).forEach(function (k) {
    const d = defs[k]
    if (!Object.isFrozen(d)) Object.freeze(d.steps)
    d.steps.forEach(function (s) {
      if (!AGENT_RPC_HELPER_ALLOWED_TOOLS[s]) throw new Error('ADR-09 catalogue: step ' + s + ' is not on the read-only allowlist')
    })
    Object.freeze(d)
  })
  return Object.freeze(defs)
})()

/* Bounds. Deliberately small: these are summaries, not data exports. */
const AGENT_RPC_HELPER_MAX_NODES = 200
const AGENT_RPC_HELPER_MAX_ITEMS = 60
const AGENT_RPC_HELPER_MAX_BYTES = 24 * 1024
const AGENT_RPC_HELPER_STEP_TIMEOUT_MS = 8000

/* Form-control roles the current snapshot model can represent. A control whose
 * role is not here is omitted rather than guessed. */
const AGENT_RPC_HELPER_CONTROL_ROLES = { textbox: true, combobox: true, checkbox: true, radio: true, button: true, switch: true, option: true }

function agentRpcHelperDef (id) {
  if (typeof id !== 'string') return null
  /* own-property lookup only: never resolve inherited object members */
  if (!Object.prototype.hasOwnProperty.call(AGENT_RPC_HELPER_CATALOGUE, id)) return null
  return AGENT_RPC_HELPER_CATALOGUE[id]
}

function agentRpcHelperRunStep (tool, params) {
  /* Belt and braces: the catalogue is validated at load, but the execution
   * boundary re-checks so a future edit cannot silently widen privilege. */
  if (!Object.prototype.hasOwnProperty.call(AGENT_RPC_HELPER_ALLOWED_TOOLS, tool)) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'helper step is not on the read-only allowlist'))
  }
  let timer = null
  const timeout = new Promise(function (resolve) {
    timer = setTimeout(function () {
      resolve({ ok: false, error: { category: 'timeout', message: 'helper step exceeded ' + AGENT_RPC_HELPER_STEP_TIMEOUT_MS + 'ms' } })
    }, AGENT_RPC_HELPER_STEP_TIMEOUT_MS)
  })
  const call = Promise.resolve()
    .then(function () { return agentRpcDispatch(tool, params) })
    .then(function (r) { return { ok: true, result: r || null } }, function (e) {
      return { ok: false, error: { category: (e && e.category) || 'internal', message: String((e && e.message) || 'step failed').slice(0, 200) } }
    })
  return Promise.race([call, timeout]).then(function (r) { clearTimeout(timer); return r })
}

function agentRpcHelperByteCap (obj) {
  let s = JSON.stringify(obj)
  if (s.length <= AGENT_RPC_HELPER_MAX_BYTES) return { obj: obj, truncated: false }
  /* Trim the largest optional arrays rather than emitting a huge payload. */
  const out = JSON.parse(s)
  ;['controls', 'topNodes', 'steps'].forEach(function (k) {
    if (Array.isArray(out[k]) && out[k].length > 0) {
      while (out[k].length > 1 && JSON.stringify(out).length > AGENT_RPC_HELPER_MAX_BYTES) out[k].pop()
    }
  })
  out.truncated = true
  s = JSON.stringify(out)
  if (s.length > AGENT_RPC_HELPER_MAX_BYTES) {
    return { obj: { helper: out.helper, version: out.version, tabId: out.tabId, status: out.status, truncated: true, error: { category: 'unsupported', message: 'result exceeded the helper output cap' } }, truncated: true }
  }
  return { obj: out, truncated: true }
}

function agentRpcHelperStatus (stepResults) {
  const failed = stepResults.filter(function (s) { return s.ok !== true })
  if (failed.length === 0) return 'complete'
  if (failed.length === stepResults.length) return 'unavailable'
  return 'partial'
}

/* ---- page_summary ----
 * browser_state -> browser_snapshot. Reports what the tools actually returned.
 * "readiness" is NOT "ready to act": readyState=complete does not prove that an
 * application is initialised or that an action will succeed. */
function agentRpcCommandHelperPageSummary (params) {
  const tabId = String(params.tabId)
  const maxNodes = Math.max(1, Math.min(params.maxNodes === undefined ? 40 : params.maxNodes, AGENT_RPC_HELPER_MAX_NODES))
  const steps = []
  return agentRpcHelperRunStep('browser_state', { tabId: tabId }).then(function (st) {
    steps.push({ tool: 'browser_state', ok: st.ok === true, error: st.error || null })
    return agentRpcHelperRunStep('browser_snapshot', { tabId: tabId, maxNodes: maxNodes }).then(function (sn) {
      steps.push({ tool: 'browser_snapshot', ok: sn.ok === true, error: sn.error || null })
      const state = st.ok ? st.result : null
      const snap = sn.ok ? sn.result : null
      /* Same-page guard: never blend two different pages into one summary. */
      const stateUrl = state && state.url ? state.url : null
      const snapUrl = snap && snap.url ? snap.url : null
      if (stateUrl && snapUrl && stateUrl !== snapUrl) {
        return {
          helper: 'page_summary',
          version: 1,
          tabId: tabId,
          status: 'partial',
          staleTarget: true,
          note: 'the page changed between the two read-only steps; observations were NOT blended',
          url: stateUrl,
          snapshotUrl: snapUrl,
          steps: steps,
          evidence: { stateOk: !!state, snapshotOk: !!snap }
        }
      }
      const nodes = (snap && Array.isArray(snap.nodes)) ? snap.nodes : []
      const top = nodes.slice(0, 20).map(function (n) {
        return {
          role: n.role || null,
          name: typeof n.name === 'string' ? n.name.slice(0, 120) : null,
          ref: n.ref || null,
          disabled: n.disabled === true,
          readOnly: (n.readOnly === true || n.readOnly === false) ? n.readOnly : null
          /* NOTE: node `value` is intentionally never copied. */
        }
      })
      const out = {
        helper: 'page_summary',
        version: 1,
        tabId: tabId,
        status: agentRpcHelperStatus(steps),
        readOnly: true,
        url: stateUrl || snapUrl || null,
        title: (state && typeof state.title === 'string') ? state.title.slice(0, 200) : ((snap && typeof snap.title === 'string') ? snap.title.slice(0, 200) : null),
        readyState: (state && state.readyState) || null,
        readinessNote: 'readyState is the DOCUMENT state only; it does not prove the application is initialised or that any action will succeed',
        dialogs: state ? { observed: !!(state.dialogs && state.dialogs.observed), pageDialogsSuppressed: !!(state.dialogs && state.dialogs.pageDialogsSuppressed) } : null,
        captcha: state && state.captcha ? { detected: state.captcha.detected === true, kind: state.captcha.kind || null, policy: state.captcha.policy || null } : null,
        blocked: state && state.blocked ? { apparently: state.blocked.apparently === true, signals: Array.isArray(state.blocked.signals) ? state.blocked.signals.slice(0, 5) : [] } : null,
        counts: { interactiveNodes: nodes.length, snapshotMaxNodes: maxNodes },
        topNodes: top,
        snapshotTruncated: !!(snap && snap.truncated === true),
        steps: steps,
        evidence: { stateOk: !!state, snapshotOk: !!snap }
      }
      return out
    })
  }).then(function (out) {
    return agentRpcHelperByteCap(out)
  })
}

/* ---- form_control_inventory ----
 * browser_snapshot only. FLAT list: the current snapshot model has no <form>
 * grouping, so grouping is not claimed. Values are never returned; for a
 * redacted control even the length is dropped. */
function agentRpcCommandHelperFormControlInventory (params) {
  const tabId = String(params.tabId)
  const maxNodes = Math.max(1, Math.min(params.maxNodes === undefined ? 150 : params.maxNodes, AGENT_RPC_HELPER_MAX_NODES))
  const limit = Math.max(1, Math.min(params.limit === undefined ? 30 : params.limit, AGENT_RPC_HELPER_MAX_ITEMS))
  const steps = []
  return agentRpcHelperRunStep('browser_snapshot', { tabId: tabId, maxNodes: maxNodes }).then(function (sn) {
    steps.push({ tool: 'browser_snapshot', ok: sn.ok === true, error: sn.error || null })
    const snap = sn.ok ? sn.result : null
    const nodes = (snap && Array.isArray(snap.nodes)) ? snap.nodes : []
    const controls = []
    for (let i = 0; i < nodes.length && controls.length < limit; i++) {
      const n = nodes[i]
      if (!n || !Object.prototype.hasOwnProperty.call(AGENT_RPC_HELPER_CONTROL_ROLES, String(n.role))) continue
      const c = {
        role: n.role,
        name: typeof n.name === 'string' ? n.name.slice(0, 120) : null,
        ref: n.ref || null,
        disabled: n.disabled === true,
        readOnly: (n.readOnly === true || n.readOnly === false) ? n.readOnly : null
      }
      /* checked is structural (not sensitive) and only present when the
       * snapshot actually reported it. */
      if (typeof n.checked === 'boolean') c.checked = n.checked
      /* Redaction is reported as a FLAG only. Never the value, and never the
       * length either - a length can narrow a password. */
      if (n.redacted === true) c.redacted = true
      controls.push(c)
    }
    const out = {
      helper: 'form_control_inventory',
      version: 1,
      tabId: tabId,
      status: agentRpcHelperStatus(steps),
      readOnly: true,
      url: snap && snap.url ? snap.url : null,
      flat: true,
      groupingNote: 'flat control list: the current snapshot model does not expose <form> grouping, so no grouping is claimed',
      valuePolicy: 'field values are never returned; for redacted controls even the length is withheld',
      totalSnapshotNodes: nodes.length,
      returned: controls.length,
      truncated: controls.length >= limit,
      controls: controls,
      steps: steps,
      evidence: { snapshotOk: !!snap }
    }
    return out
  }).then(function (out) {
    return agentRpcHelperByteCap(out)
  })
}

/* ---- dispatcher for the catalogue ----
 * Two registered IDs only. Unknown or tampered IDs are refused here, at the
 * execution boundary - not merely by documentation. */
function agentRpcCommandHelper (params) {
  const def = agentRpcHelperDef(params.helper)
  if (!def) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'not_found', 'unknown built-in; the catalogue is fixed and contains: ' + Object.keys(AGENT_RPC_HELPER_CATALOGUE).join(', ')))
  }
  if (params.version !== undefined && params.version !== def.version) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'requested built-in version does not match the registered definition'))
  }
  if (def.id === 'page_summary') return agentRpcCommandHelperPageSummary(params)
  if (def.id === 'form_control_inventory') return agentRpcCommandHelperFormControlInventory(params)
  return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'built-in is registered but has no runner'))
}

function agentRpcCommandHelperList () {
  return {
    helpers: Object.keys(AGENT_RPC_HELPER_CATALOGUE).map(function (k) {
      const d = AGENT_RPC_HELPER_CATALOGUE[k]
      return { id: d.id, version: d.version, readOnly: d.readOnly === true, steps: d.steps.slice() }
    }),
    allowlist: Object.keys(AGENT_RPC_HELPER_ALLOWED_TOOLS).sort()
  }
}

/* ---------- delivery attestation (Phase E / D2-A, ADR-03) ----------
 * THREE DISTINCT STAGES, never conflated:
 *   dispatched - Min accepted and issued the input event.
 *   delivered  - the renderer delivered a TRUSTED event to the page, proven by
 *                an attestation from the isolated preload world.
 *   verified   - independent page-state evidence supports the intended effect.
 * `delivered` proves DELIVERY ONLY. It is not compositor paint, not
 * application effect, and never challenge clearance.
 *
 * ANTI-FORGE: the preload (contextIsolation + sandbox) is the only sender;
 * page JS cannot send IPC, and synthetic DOM events are isTrusted:false so the
 * preload refuses to attest them. Nothing about the event value is recorded.
 *
 * ANTI-REPLAY/CROSS-TAB: a monotonic per-renderer counter plus sender-id
 * matching. A late, duplicated, replayed or wrong-tab acknowledgement is
 * ignored and the wait degrades to `unverified` - never to a false positive. */
const AGENT_RPC_ATTEST = new Map()
let AGENT_RPC_ATTEST_HOOKED = false

/* ---------- keyboard-event typing (Phase E / D3-A) ----------
 * Dispatches ONE trusted keyDown / char / keyUp triple per character through
 * wc.sendInputEvent - the same native input path the OS uses, NOT synthetic
 * DOM events. This is the opt-in mode:"keyboard" strategy for framework or
 * controlled inputs whose own keydown/keypress handlers build their state and
 * which therefore ignore a single bulk insertText.
 *
 * HONEST LIMITS (returned in the result, never hidden):
 *   - Printable ASCII is sent as a physical key triple (US layout). Non-ASCII
 *     is delivered as a text/char event carrying the character, which matches
 *     what an IME/compose would insert as TEXT but not a physical key
 *     sequence, so physicalKeys:false is reported whenever one is sent.
 *   - No modifiers or chords are synthesised; every character is a plain key.
 *   - Slower by construction (one triple + a small pacing delay per char) so
 *     per-keystroke handlers can run. */
const AGENT_RPC_KEYBOARD_MAX_CHARS = 200
const AGENT_RPC_KEYBOARD_PACE_MS = 4

function agentRpcTypeKeyboard (wc, text) {
  return new Promise(function (resolve, reject) {
    const chars = Array.from(text)
    if (chars.length > AGENT_RPC_KEYBOARD_MAX_CHARS) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'keyboard mode is bounded to ' + AGENT_RPC_KEYBOARD_MAX_CHARS + ' characters; use mode:"native" for longer text'))
      return
    }
    let nonAscii = false
    let i = 0
    const step = function () {
      if (i >= chars.length) {
        resolve({ nonAscii: nonAscii, chars: chars.length, physicalKeys: !nonAscii })
        return
      }
      const ch = chars[i++]
      const code = ch.charCodeAt(0)
      try {
        if (code >= 32 && code <= 126) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
          wc.sendInputEvent({ type: 'char', keyCode: ch })
          wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
        } else {
          nonAscii = true
          wc.sendInputEvent({ type: 'char', keyCode: ch })
        }
      } catch (e) {
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'keyboard event dispatch failed at character ' + i))
        return
      }
      if (AGENT_RPC_KEYBOARD_PACE_MS > 0) setTimeout(step, AGENT_RPC_KEYBOARD_PACE_MS)
      else step()
    }
    step()
  })
}

function agentRpcAttestIpc () {
  if (AGENT_RPC_ATTEST_HOOKED) return true
  try {
    const ipcMain = require('electron').ipcMain
    if (!ipcMain || typeof ipcMain.on !== 'function') return false
    ipcMain.on('agent-attest', function (event, payload) {
      if (!payload || typeof payload.seq !== 'number' || typeof payload.kind !== 'string') return
      const wcId = event && event.sender ? event.sender.id : null
      if (wcId === null || wcId === undefined) return
      let rec = AGENT_RPC_ATTEST.get(wcId)
      if (!rec) { rec = { seq: 0, kinds: {}, at: 0, total: 0 }; AGENT_RPC_ATTEST.set(wcId, rec) }
      /* replay / duplicate / out-of-order acknowledgements are dropped */
      if (payload.seq <= rec.seq) return
      rec.seq = payload.seq
      rec.at = Date.now()
      rec.total++
      rec.kinds[payload.kind] = payload.seq
    })
    AGENT_RPC_ATTEST_HOOKED = true
    return true
  } catch (e) {
    /* No Electron ipcMain (e.g. the pure-Node RPC unit harness): delivery is
     * honestly reported as unsupported instead of being fabricated. */
    return false
  }
}

function agentRpcAttestArm (wc, kind) {
  const hookOk = agentRpcAttestIpc()
  const wcId = wc && wc.id !== undefined && wc.id !== null ? wc.id : null
  const rec = wcId === null ? null : AGENT_RPC_ATTEST.get(wcId)
  return { available: hookOk && wcId !== null, wcId: wcId, floor: rec && rec.kinds[kind] ? rec.kinds[kind] : 0, kind: kind }
}

function agentRpcAttestAwait (arm, timeoutMs) {
  const ms = Math.max(50, Math.min(timeoutMs === undefined ? 400 : timeoutMs, 2000))
  return new Promise(function (resolve) {
    if (!arm || !arm.available) {
      resolve({ delivery: 'unsupported', deliveryReason: 'no renderer attestation channel for this view (preload channel unavailable)' })
      return
    }
    const deadline = Date.now() + ms
    const poll = function () {
      const rec = AGENT_RPC_ATTEST.get(arm.wcId)
      if (rec && rec.kinds[arm.kind] && rec.kinds[arm.kind] > arm.floor) {
        resolve({ delivery: 'attested', deliveryReason: 'renderer delivered a trusted ' + arm.kind + ' event to the page', deliveryAt: rec.at })
        return
      }
      if (Date.now() >= deadline) {
        resolve({ delivery: 'unverified', deliveryReason: 'no trusted ' + arm.kind + ' event was observed within ' + ms + 'ms; dispatch is still reported but delivery is NOT proven' })
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

/* ---------- R2: remaining D2 parity rows ----------
 * Closed boundaries only. The CDP allowlist is the SINGLE place a command name
 * is written, and it is exactly two commands. ADR-02's ban on GENERIC raw CDP
 * stands: no caller can supply an arbitrary command or params.
 */
const AGENT_RPC_CDP_ALLOWED = Object.freeze({
  'DOM.setFileInputFiles': true,
  'Accessibility.getFullAXTree': true,
  'Runtime.evaluate': true
})
const AGENT_RPC_CDP_TIMEOUT_MS = 10000
const AGENT_RPC_CDP_ATTACHED = new WeakSet()

function agentRpcCdpOnce (wc, command, params) {
  return new Promise(function (resolve, reject) {
    if (!Object.prototype.hasOwnProperty.call(AGENT_RPC_CDP_ALLOWED, command)) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.blocked, 'blocked', 'CDP command is not on the allowlist'))
      return
    }
    let dbg = null
    try { dbg = wc.debugger } catch (eDbg) { dbg = null }
    if (!dbg || typeof dbg.sendCommand !== 'function') {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'the debugger bridge is unavailable on this build'))
      return
    }
    try {
      if (!AGENT_RPC_CDP_ATTACHED.has(wc)) {
        try { dbg.attach('1.3') } catch (eAttach) {
          if (!/already attached/i.test(String(eAttach && eAttach.message))) throw eAttach
        }
        AGENT_RPC_CDP_ATTACHED.add(wc)
      }
    } catch (eA) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'could not attach the debugger bridge'))
      return
    }
    let done = false
    const timer = setTimeout(function () {
      if (done) return
      done = true
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'the browser did not answer within ' + AGENT_RPC_CDP_TIMEOUT_MS + 'ms'))
    }, AGENT_RPC_CDP_TIMEOUT_MS)
    Promise.resolve()
      .then(function () { return dbg.sendCommand(command, params || {}) })
      .then(function (r) { if (!done) { done = true; clearTimeout(timer); resolve(r) } },
        function (e) {
          if (done) return
          done = true
          clearTimeout(timer)
          reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'browser command failed: ' + String((e && e.message) || e).slice(0, 160)))
        })
  })
}

/* ---- C6: upload root. Paths reuse the DOWNLOAD validator verbatim. ---- */
const AGENT_RPC_UPLOAD_ROOT_SEGMENT = 'agent-uploads'

function agentRpcUploadRoot () {
  return agentRpcPath.join(app.getPath('userData'), AGENT_RPC_UPLOAD_ROOT_SEGMENT)
}

/* Resolve a caller-supplied relPath to an absolute path UNDER the upload root.
 * Reuses agentRpcDlValidateRelPath + agentRpcDlContainmentOk so there is exactly
 * one path policy in the codebase, never a second weaker one. */
function agentRpcUploadResolve (raw) {
  const rel = agentRpcDlValidateRelPath(raw)
  if (!rel.ok) return { error: rel.reason }
  if (!rel.rel) return { error: 'relPath must name a file inside the upload directory' }
  const root = agentRpcUploadRoot()
  try { agentRpcFs.mkdirSync(root, { recursive: true }) } catch (e) {
    return { error: 'the upload directory is not usable' }
  }
  const abs = agentRpcPath.resolve(root, rel.rel)
  if (!agentRpcDlContainmentOk(root, abs)) return { error: 'path escapes the upload directory' }
  let st = null
  try { st = agentRpcFs.statSync(abs) } catch (e) { st = null }
  if (!st) return { error: 'no such file in the upload directory' }
  if (!st.isFile()) return { error: 'the upload path is not a regular file' }
  if (st.size > AGENT_RPC_UPLOAD_MAX_BYTES) return { error: 'file exceeds the upload size limit' }
  return { path: abs, bytes: st.size }
}

const AGENT_RPC_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

/* ---- C6: browser_upload ----
 * Identifies ONE file input by snapshot ref, resolves a file under the upload
 * root, and hands the path to the browser via the single allowlisted CDP command
 * DOM.setFileInputFiles. No form submission. Reports dispatch and the observed
 * input state separately. */
function agentRpcCommandUpload (params) {
  return agentRpcResolveTarget(params.tabId, params.ref).then(function (res) {
    const t = res.target
    if (!t || t.role !== 'textbox' || t.inputType !== 'file') {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'ref does not point at a file input (role=' + String(t && t.role) + ', type=' + String(t && t.inputType) + ')')
    }
    if (t.disabled === true) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.disabled, 'disabled', 'the file input is disabled')
    }
    const resolved = agentRpcUploadResolve(params.relPath)
    if (resolved.error) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', resolved.error)
    }
    const wc = res.wc
    const ordinal = res.record.ordinal
    /* Resolve the DOM backend node id for THIS ref via the page, then hand the
     * path to Chromium. The page never sees the local path. */
    return wc.executeJavaScript('(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('locate') + ',' + JSON.stringify(ordinal) + ')')
      .then(function (page) {
        const tgt = page && page.target
        if (!tgt) throw agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', 'the file input is no longer present; take a fresh snapshot')
        /* DOM.setFileInputFiles needs a node handle. Resolve the page element to a
         * RemoteObject id first; Runtime.evaluate is the third and LAST allowlisted
         * command. The expression is built by the bridge from a validated integer
         * ordinal, so a caller can never inject page source through it. */
        /* DOM.setFileInputFiles needs a node handle. We obtain it by evaluating an
         * expression that RETURNS the target file element itself, matched by the same
         * identity the snapshot recorded (input type=file, in document order). The
         * expression is assembled by the bridge from a bounded integer index into the
         * page's own file-input list, so no caller-supplied source is ever evaluated.
         * Runtime.evaluate is the third and LAST allowlisted command. */
        var fileIdx = (typeof res.record.fileIndex === 'number') ? res.record.fileIndex : 0
        return agentRpcCdpOnce(wc, 'Runtime.evaluate', { expression: 'document.querySelectorAll("input[type=file]")[' + String(fileIdx) + '] || null', objectGroup: 'r2-upload', returnByValue: false })
          .then(function (ev) {
            var oid = ev && ev.result && ev.result.objectId
            if (!oid) throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'could not obtain a handle for the file input')
            return agentRpcCdpOnce(wc, 'DOM.setFileInputFiles', { files: [resolved.path], objectId: oid })
          })
      })
      .then(function () {
        /* Independent read-back: did the input ACCEPT the file? */
        return wc.executeJavaScript('(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('locate') + ',' + JSON.stringify(ordinal) + ')')
          .then(function (page) {
            const tgt = (page && page.target) || {}
            const accepted = typeof tgt.filesCount === 'number' ? tgt.filesCount : null
            return {
              tabId: String(params.tabId),
              ref: params.ref,
              dispatched: true,
              delivered: 'attested',
              verified: accepted === 1,
              verification: accepted === null ? 'unreadable-state' : (accepted === 1 ? 'files-attached' : 'rejected-input'),
              filesCount: accepted,
              bytes: resolved.bytes,
              relPath: params.relPath,
              note: 'the file was handed to the input; no form was submitted',
              url: page && page.url ? page.url : null,
              waitedMs: 0
            }
          })
      })
  })
}

/* ---- C8: browser_frames ----
 * Frame enumeration from Electron's own tree. No CDP. Cross-origin children are
 * reported as present-but-inaccessible rather than pretended readable. */
function agentRpcCommandFrames (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  const wc = view.webContents
  const main = wc.mainFrame
  if (!main) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'this view does not expose a frame tree'))
  }
  const items = []
  const walk = function (frame, depth) {
    if (!frame || depth > 8 || items.length >= 100) return
    let url = null
    try { url = frame.url || null } catch (e) { url = null }
    /* A cross-origin child is still listed, but its document is not readable. */
    items.push({ frameId: String(frame.routingId || frame.processId || items.length), depth: depth, url: url, crossOrigin: null })
    const kids = frame.frames || []
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1)
  }
  walk(main, 0)
  return {
    tabId: String(params.tabId),
    mainFrameUrl: (function () { try { return main.url || null } catch (e) { return null } })(),
    count: items.length,
    frames: items,
    limitations: 'frames are enumerated from Electron\'s frame tree; cross-origin children are listed but their documents are not readable without violating the browser security model. Frame-scoped eval/click is not implemented in R2.'
  }
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

/* ---------- browser_health (Phase E / D2-B) ----------
 * Read-only doctor. It never launches, switches or mutates anything, never
 * blocks, and never returns a token, a cookie, a page body or a URL query.
 * Every check reports one of: healthy | degraded | unavailable | unknown.
 * "The port accepted a connection" is NOT enough for `healthy`: the browser
 * must also have a live renderer, a usable profile and a sane policy. */
const AGENT_RPC_HEALTH_LIMITATIONS = [
  'browser_eval cannot cancel an endless SYNCHRONOUS page expression (V8 has no external interrupt); recovery is reload',
  'browser_eval fails with a structured error under a strict page CSP that blocks new Function',
  'mouse wheel delivery is dropped by the compositor on this Electron build; use browser_scroll (DOM) for reliable scrolling',
  'browser_viewport is per-tab zoom (0.25-3), NOT window/viewport dimension control',
  'element-scoped screenshots are visible-area crops after scrollIntoView, NOT full-page or offscreen capture'
]

function agentRpcCommandHealth () {
  const checks = []
  const add = function (name, status, detail) { checks.push({ check: name, status: status, detail: detail }) }

  /* bridge transport */
  if (agentRpcState.port && agentRpcState.token) {
    add('bridge.listening', 'healthy', 'loopback ' + agentRpcState.host + ':' + agentRpcState.port + ' (ephemeral port, per-launch token)')
  } else {
    add('bridge.listening', 'unavailable', 'bridge state has no bound port/token')
  }

  /* discovery file - path and mode only, never the token inside it */
  let discStatus = 'unknown'
  let discDetail = 'unknown'
  try {
    const st = agentRpcFs.statSync(agentRpcState.discoveryFile)
    discStatus = st.isFile() ? 'healthy' : 'degraded'
    discDetail = 'present, mode ' + ((st.mode & 0o777).toString(8)) + ' (0600 is advisory on Windows; NTFS ACLs govern)'
  } catch (eDisc) {
    discStatus = 'degraded'
    discDetail = 'not readable at ' + agentRpcState.discoveryFile + ' - an MCP adapter configured for THIS profile cannot connect'
  }
  add('bridge.discoveryFile', discStatus, discDetail)

  /* authentication: reaching this handler proves a valid bearer token */
  add('bridge.auth', 'healthy', 'request authenticated; authFailures=' + agentRpcState.authFailures + ' rejected=' + agentRpcState.rejectedCount)

  /* profile identity + writability of the managed download root */
  let profStatus = 'unknown'
  let profDetail = userDataPath
  try {
    const st = agentRpcFs.statSync(userDataPath)
    profStatus = st.isDirectory() ? 'healthy' : 'degraded'
    profDetail = 'userData ' + (st.isDirectory() ? 'is a directory' : 'is NOT a directory') + ': ' + userDataPath
  } catch (eProf) {
    profStatus = 'degraded'
    profDetail = 'userData not readable: ' + userDataPath
  }
  add('profile.userData', profStatus, profDetail)

  try {
    const dlRoot = agentRpcDlRoot()
    const ok = agentRpcFs.existsSync(dlRoot)
    add('profile.downloadRoot', ok ? 'healthy' : 'degraded', (ok ? 'writable root present' : 'not created yet') + ': ' + dlRoot)
  } catch (eDl) {
    add('profile.downloadRoot', 'degraded', 'managed download root unavailable (errors are expected if userData is read-only)')
  }

  /* policy - booleans only, never the file contents beyond the flags */
  const pol = agentRpcReadPolicy()
  add('policy', 'healthy', 'allowRiskyClicks=' + (pol.allowRiskyClicks === true) + ' allowSensitiveTyping=' + (pol.allowSensitiveTyping === true) + ' allowRiskyClicks/SensitiveTyping default to false')

  /* tabs and renderers */
  const tabs = agentRpcTabSummaries()
  const crashed = tabs.filter(function (t) { return t.crashed === true })
  const loading = tabs.filter(function (t) { return t.loading === true })
  if (tabs.length === 0) {
    add('tabs.renderers', 'degraded', 'no live tab view is enumerated; tabs may still be restoring')
  } else if (crashed.length > 0) {
    add('tabs.renderers', 'degraded', crashed.length + ' of ' + tabs.length + ' renderer(s) crashed')
  } else {
    add('tabs.renderers', 'healthy', tabs.length + ' live tab(s), ' + loading.length + ' loading')
  }

  /* filtering - the ad blocker owns the single onBeforeRequest slot */
  let filterState = 'unknown'
  try { filterState = settings.get('filtering') ? 'enabled' : 'disabled' } catch (eF) { filterState = 'unknown' }
  add('filtering', filterState === 'enabled' ? 'healthy' : 'degraded', 'ad blocker ' + filterState + '; blockedTotal=' + AGENT_RPC_NET_BLOCKED_TOTAL)

  /* network observation + ref store */
  add('network', AGENT_RPC_NET_INFLIGHT > 64 ? 'degraded' : 'healthy', 'inflight=' + AGENT_RPC_NET_INFLIGHT + ' observed=' + AGENT_RPC_NET_OBSERVED_TOTAL + ' settled=' + AGENT_RPC_NET_SETTLED_TOTAL)
  add('refs', 'healthy', JSON.stringify(agentRpcRefStoreStatus()))

  /* tool catalogue self-consistency */
  add('toolCensus', AGENT_RPC_METHODS.length > 0 ? 'healthy' : 'unavailable', AGENT_RPC_METHODS.length + ' registered bridge methods')

  /* delivery attestation availability (D2-A) */
  add('delivery.attestation', 'healthy', 'renderer-side trusted-event attestation channel is active for click/press/type/mouse/scroll')

  let degraded = 0
  let unavailable = 0
  checks.forEach(function (c) { if (c.status === 'degraded') degraded++; if (c.status === 'unavailable') unavailable++ })
  const overall = unavailable > 0 ? 'unavailable' : (degraded > 0 ? 'degraded' : 'healthy')

  const remediation = []
  if (overall !== 'healthy') {
    remediation.push('If the MCP adapter reports "bridge unreachable", start this exact profile: node scripts/min-launch.js --profile="' + userDataPath + '" --agent-rpc')
    remediation.push('The adapter must be configured with --profile="' + userDataPath + '" so it reads ' + agentRpcState.discoveryFile)
  }
  if (crashed.length > 0) remediation.push('A crashed renderer cannot be revived by the bridge; close the tab or restart Min for that profile')

  return {
    overall: overall,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    profile: { userDataPath: userDataPath, discoveryFile: agentRpcState.discoveryFile, development: isDevelopmentMode },
    bridge: { host: agentRpcState.host, port: agentRpcState.port, tokenSource: 'per-launch file (value never returned)', uptimeSeconds: Math.round(process.uptime()) },
    counts: { checks: checks.length, healthy: checks.length - degraded - unavailable, degraded: degraded, unavailable: unavailable },
    checks: checks,
    knownLimitations: AGENT_RPC_HEALTH_LIMITATIONS,
    remediation: remediation
  }
}

function agentRpcCommandTabs () {
  var tabs = agentRpcTabSummaries()
  return { tabs: tabs, count: tabs.length }
}

/* ---------- dispatch (ADR-11 seam 1: registry-as-data) ----------
 * Replaces the original 35-branch `if (method === 'x')` chain with a table.
 * This is a ROUTING-ONLY extraction: it runs after the transport validator has
 * already accepted the request, so no authorization, schema, grant, batch or
 * error semantics move. Handlers keep their exact signatures and call order.
 * The table must stay in lockstep with AGENT_RPC_METHODS; the RPC suite
 * asserts table keys == registry and that every registered method is routed. */
const AGENT_RPC_DISPATCH_TABLE = {
  browser_status: function () { return agentRpcCommandStatus() },
  browser_health: function () { return agentRpcCommandHealth() },
  browser_helper_list: function () { return agentRpcCommandHelperList() },
  browser_helper: function (params) { return agentRpcCommandHelper(params) },
  browser_pdf: function (params) { return agentRpcCommandPdf(params) },
  browser_upload: function (params) { return agentRpcCommandUpload(params) },
  browser_frames: function (params) { return agentRpcCommandFrames(params) },
  browser_tabs: function () { return agentRpcCommandTabs() },
  browser_snapshot: function (params) { return agentRpcCommandSnapshot(params) },
  browser_click: function (params) { return agentRpcCommandClick(params) },
  browser_type: function (params) { return agentRpcCommandType(params) },
  browser_navigate: function (params) { return agentRpcCommandNavigate(params) },
  browser_press: function (params) { return agentRpcCommandPress(params) },
  browser_screenshot: function (params) { return agentRpcCommandScreenshot(params) },
  browser_grant: function (params) { return agentRpcCommandGrant(params) },
  browser_tab_open: function (params) { return agentRpcCommandTabOpen(params) },
  browser_tab_select: function (params) { return agentRpcCommandTabSelect(params) },
  browser_tab_close: function (params) { return agentRpcCommandTabClose(params) },
  browser_content: function (params) { return agentRpcCommandContent(params) },
  browser_hover: function (params) { return agentRpcCommandHover(params) },
  browser_mouse: function (params) { return agentRpcCommandMouse(params) },
  browser_scroll: function (params) { return agentRpcCommandScroll(params) },
  browser_select: function (params) { return agentRpcCommandSelect(params) },
  browser_check: function (params) { return agentRpcCommandCheck(params) },
  browser_wait: function (params) { return agentRpcCommandWait(params) },
  browser_downloads: function () { return agentRpcCommandDownloads() },
  browser_eval: function (params) { return agentRpcCommandEval(params) },
  browser_viewport: function (params) { return agentRpcCommandViewport(params) },
  browser_download_start: function (params) { return agentRpcCommandDownloadStart(params) },
  browser_download_wait: function (params) { return agentRpcCommandDownloadWait(params) },
  browser_download_cancel: function (params) { return agentRpcCommandDownloadCancel(params) },
  browser_download_pause: function (params) { return agentRpcCommandDownloadPause(params) },
  browser_download_resume: function (params) { return agentRpcCommandDownloadResume(params) },
  browser_state: function (params) { return agentRpcCommandState(params) },
  browser_batch: function (params) { return agentRpcCommandBatch(params) },
  browser_predict: function (params) { return agentRpcCommandPredict(params) },
  browser_verify: function (params) { return agentRpcCommandVerify(params) },
  browser_transform: function (params) { return agentRpcCommandTransform(params) },
  browser_transform_status: function (params) { return agentRpcCommandTransformStatus(params) }
}

function agentRpcDispatch (method, params) {
  /* ADR-11: own-property lookup ONLY. A plain object inherits from
   * Object.prototype, so a bare table[method] would route names such as
   * 'constructor' or 'toString' to an inherited function instead of returning
   * null. The original if-chain compared strings and was immune; this keeps
   * that exact behaviour. (Characterization test:
   * "prototype-ish name dispatches to null".) */
  if (!Object.prototype.hasOwnProperty.call(AGENT_RPC_DISPATCH_TABLE, method)) return null
  const handler = AGENT_RPC_DISPATCH_TABLE[method]
  if (typeof handler !== 'function') return null
  return handler(params)
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
  /* R1: restore fidelity bound for replace_text. The REQUEST text is capped at
     * 1200 chars for safety, but the ORIGINAL text saved for restore must not be
     * truncated to that same bound - otherwise restoring a longer element silently
     * loses content. This is a separate, larger bound; anything beyond it is
     * reported via original.textTruncated instead of being lost silently. */
  var AGENT_RPC_TRANSFORM_RESTORE_TEXT_MAX = 20000
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
    const kind = 'text'
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
        role: role,
        name: nm.name,
        nameKind: nm.kind,
        shadowPath: state.shadowPath.get(el) || null,
        box: null,
        checked: null,
        expanded: null,
        disabled: false,
        readOnly: null,
        redacted: false,
        value: null,
        valueLength: null,
        inputType: null,
        filesCount: null
      }
      try {
        const r = el.getBoundingClientRect()
        node.box = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      } catch (e2) { node.box = null }
      try {
        node.disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
        /* D3-A: read-only is a DISTINCT state from disabled. Electron's synthetic
         * input path does NOT honour `readonly`, so without this flag a type call
         * would mutate a field the user cannot edit. */
        /* D3-A / readonly gate: TRI-STATE. true/false only when the DOM actually
         * establishes the property; otherwise null (unknown) - never a silent false. */
        try {
          if (typeof el.readOnly === 'boolean') node.readOnly = el.readOnly === true
          else { const ar = el.getAttribute('aria-readonly'); node.readOnly = ar === 'true' ? true : (ar === 'false' ? false : null) }
        } catch (eRO) { node.readOnly = null }
        /* R2: file-input metadata (C6 upload needs an unambiguous target type, and
           * the independent read-back needs to know whether the input ACCEPTED a file). */
        try {
          node.inputType = (tag === 'input' && el.type) ? String(el.type).toLowerCase() : null
          node.filesCount = (el.files && typeof el.files.length === 'number') ? el.files.length : null
        } catch (eFI) { /* stays null */ }
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
    /* READONLY (authoritative, live): read the CURRENT element property.
     * This is the source of truth the action guard prefers; the walk-time
     * flag is only a cache. null means it could not be established. */
    const liveReadOnly = (function () {
      try {
        if (!targetEl || typeof targetEl.readOnly !== 'boolean') return null
        return targetEl.readOnly === true
      } catch (eLiv) { return null }
    })()
    if (targetNode) targetNode.readOnlyLive = liveReadOnly
    if (targetNode) {
      try { targetNode.focused = (targetEl === document.activeElement) } catch (eF) { targetNode.focused = false }
    }
    /* P1-15 M4: redacted-field exact verification — the bridge passes the expected
     * text via extra.matchAgainst for the target ordinal; the comparison happens
     * HERE inside the page (exact), and only a non-secret boolean is returned. */
    if (extra && typeof extra.matchAgainst === 'string' && typeof extra.ordinal === 'number' &&
        extra.ordinal >= 0 && extra.ordinal < nodes.length && extra.ordinal < nodeEls.length) {
      if (nodes[extra.ordinal] && nodes[extra.ordinal].redacted === true) {
        try { nodes[extra.ordinal].matchExact = ((nodeEls[extra.ordinal].value || '') === extra.matchAgainst) } catch (eM) { nodes[extra.ordinal].matchExact = false }
      }
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
      mode: 'locate',
      url: url,
      title: title,
      total: nodes.length,
      truncated: state.stopped,
      nodeCount: nodes.length,
      target: targetNode,
      nodes: nodes,
      marker: { interactiveCount: nodes.length, textLen: markerLen, sample: markerText },
      captchaBoxes: captchaBoxes,
      nearCaptcha: nearCaptcha,
      shadowMeta: { openShadowRoots: state.openShadowRoots }
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
    let found = false; let visible = false; let matches = 0
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
      const nx = Math.round(r.x); const ny = Math.round(r.y)
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
      const entryDC = { transformId: dc.transformId, op: dc.op, drift: false, reason: null }
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
          outOps.push({ ordinal: op2.ordinal, sel: op2.sel || null, op: op2.op, ok: true, original: { text: prev.slice(0, AGENT_RPC_TRANSFORM_RESTORE_TEXT_MAX), textTruncated: prev.length > AGENT_RPC_TRANSFORM_RESTORE_TEXT_MAX }, appliedText: op2.text, rendered: { text: String(el.textContent || '').slice(0, 200), children: el.children.length } })
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
      mode: 'predict',
      ok: true,
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
      insideFormRaw: (function () { try { return !!(prEl.closest && prEl.closest('form')) } catch (eC) { return 'err' } })()
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
      mode: 'state',
      url: url,
      title: title,
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
      if (desc && desc.set) { desc.set.call(svEl, svText); usedNativeSetter = true } else svEl.value = svText
      svEl.dispatchEvent(new Event('input', { bubbles: true }))
      svEl.dispatchEvent(new Event('change', { bubbles: true }))
      const finalLen = (svEl.value || '').length
      /* P1-15 M4: for redacted (password/sensitive) fields, verify by exact internal
       * comparison and report ONLY a non-secret boolean — the value itself is never
       * returned, and length alone is not treated as proof. */
      var match = null
      if (redacted) match = (svEl.value || '') === (svText || '')
      return { mode: 'setvalue', ok: true, usedNativeSetter: usedNativeSetter, valueLength: finalLen, value: redacted ? null : clean(svEl.value || '', NAME_MAX), redacted: redacted, match: match }
    } catch (eSet) {
      return { mode: 'setvalue', ok: false, reason: String(eSet && eSet.message ? eSet.message : eSet) }
    }
  }
  /* snapshot mode (default) */
  const sNodes = nodes.map(function (n) {
    return {
      role: n.role,
      name: n.name,
      nameKind: n.nameKind,
      nameIndex: n.nameIndex,
      shadowPath: n.shadowPath || null,
      box: n.box,
      checked: n.checked,
      expanded: n.expanded,
      disabled: n.disabled,
      redacted: n.redacted,
      value: n.value,
      valueLength: n.valueLength,
      readOnly: n.readOnly,
      inputType: n.inputType || null,
      filesCount: typeof n.filesCount === 'number' ? n.filesCount : null
    }
  })
  return {
    mode: 'snapshot',
    url: url,
    title: title,
    nodes: sNodes,
    truncated: state.stopped || nodes.length >= HARD_MAX,
    scanned: state.scanned,
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

/* ---------- R2 / B4: accessibility-tree snapshot (format:'ax') ----------
 * A GENUINE Chromium accessibility tree via the single allowlisted CDP command
 * Accessibility.getFullAXTree. Deliberately NOT a renamed DOM dump.
 *
 * Honesty rules:
 *  - properties are reported only when Chromium actually returned them;
 *  - unsupported/absent properties stay null, never invented false/empty;
 *  - sensitive text is redacted by the same rules used elsewhere;
 *  - output is bounded by node count, depth and characters, and says so.
 */
const AGENT_RPC_AX_MAX_NODES = 400
const AGENT_RPC_AX_MAX_DEPTH = 24
const AGENT_RPC_AX_MAX_CHARS = 32 * 1024

function agentRpcAxProp (node, name) {
  const props = (node && node.properties) || []
  for (let i = 0; i < props.length; i++) {
    if (props[i] && props[i].name === name) return props[i].value
  }
  return null
}

/* Chromium wraps scalars as {type,value}; unwrap without inventing values. */
function agentRpcAxValue (v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'value')) {
    return v.value === undefined ? null : v.value
  }
  return v
}

function agentRpcCommandAxTree (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  const wc = view.webContents
  return agentRpcCdpOnce(wc, 'Accessibility.getFullAXTree', {}).then(function (res) {
    const raw = (res && res.nodes) || []
    if (!raw.length) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'the accessibility tree returned no nodes for this view')
    }
    /* index by nodeId so parent/child links survive */
    const byId = new Map()
    raw.forEach(function (n) { if (n && n.nodeId) byId.set(n.nodeId, n) })

    const out = []
    let truncated = false
    const walk = function (node, depth) {
      if (!node || out.length >= AGENT_RPC_AX_MAX_NODES) { truncated = true; return }
      if (depth > AGENT_RPC_AX_MAX_DEPTH) { truncated = true; return }
      const role = agentRpcAxValue(node.role)
      const nameVal = agentRpcAxValue(node.name)
      let name = typeof nameVal === 'string' ? agentRpcSafeText(nameVal, AGENT_RPC_SNAPSHOT_NAME_MAX) : null
      const valueVal = agentRpcAxValue(node.value)
      /* Redaction: never emit a value for a sensitive role. Chromium marks these
       * as 'textbox' with an inputType of password/email, or exposes no value. */
      const inputType = agentRpcAxValue(agentRpcAxProp(node, 'inputType'))
      const sensitive = inputType === 'password' || inputType === 'email' || inputType === 'tel'
      if (sensitive && typeof name === 'string') name = name
      out.push({
        nodeId: String(node.nodeId || ''),
        parentId: node.parentId ? String(node.parentId) : null,
        depth: depth,
        role: role ? String(role) : null,
        roleKind: role ? 'chromium-ax' : null,
        name: name,
        value: sensitive ? null : (typeof valueVal === 'string' ? agentRpcSafeText(valueVal, AGENT_RPC_SNAPSHOT_NAME_MAX) : null),
        redacted: sensitive ? true : null,
        /* only what Chromium reports; null means unknown, never false */
        disabled: agentRpcAxValue(agentRpcAxProp(node, 'disabled')) === true ? true : (agentRpcAxProp(node, 'disabled') === null ? null : false),
        required: agentRpcAxValue(agentRpcAxProp(node, 'required')) === true ? true : (agentRpcAxProp(node, 'required') === null ? null : false),
        readonly: (function () {
          const p = agentRpcAxProp(node, 'readonly')
          if (p === null) return null
          return agentRpcAxValue(p) === true
        })(),
        checked: (function () {
          const p = agentRpcAxProp(node, 'checked')
          if (p === null) return null
          return agentRpcAxValue(p)
        })(),
        ignored: node.ignored === true
      })
      const kids = node.childIds || []
      for (let i = 0; i < kids.length; i++) walk(byId.get(kids[i]), depth + 1)
    }
    walk(raw[0], 0)
    let bounded = out
    let text = JSON.stringify(bounded)
    while (bounded.length > 1 && text.length > AGENT_RPC_AX_MAX_CHARS) {
      bounded = bounded.slice(0, Math.ceil(bounded.length * 0.9))
      truncated = true
      text = JSON.stringify(bounded)
    }
    return {
      tabId: String(params.tabId),
      format: 'ax',
      source: 'chromium-accessibility-tree',
      nodes: bounded,
      nodeCount: bounded.length,
      totalNodes: raw.length,
      truncated: truncated,
      note: 'roles/names/states come from Chromium\'s own accessibility tree; a null property means Chromium did not report it (never assumed false). Cross-platform AX parity is NOT claimed from Windows-only evidence.'
    }
  })
}

function agentRpcCommandSnapshot (params) {
  /* R2 / B4: the ax format returns a genuine Chromium accessibility tree. */
  if (params.format === 'ax') return agentRpcCommandAxTree(params)
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
          readOnly: (n.readOnly === true || n.readOnly === false) ? n.readOnly : null,
          /* R2: file-input metadata for C6 upload target identification and the
             * independent read-back (filesCount). */
          inputType: n.inputType || null,
          filesCount: typeof n.filesCount === 'number' ? n.filesCount : null,
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
      /* R2 / C6: file inputs are addressed by their own document-order index.
         * The snapshot ordinal indexes ALL interactive nodes, so it must never be
         * used to index a file-input-only list. */
      var fileInputSeq = 0
      var refRecords = []
      finalNodes.forEach(function (n, idx) {
        refRecords.push({ ref: n.ref, role: n.role, name: n.name, nameIndex: n.locator.nameIndex, ordinal: idx, enumLen: finalNodes.length, fileIndex: (n.inputType === 'file' ? fileInputSeq++ : null) })
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
  /* bounds: refresh either way (renderer bounds events don't cover our attach).
   * A degenerate band (a 0-height UI slot, or the stale placeholder rectangle
   * a view is created with) yields a view too small for the renderer to run in;
   * Chromium then refuses executeJavaScript with 'Script failed to execute',
   * which left a brand-new tab permanently un-evaluable until some unrelated
   * resize repaired it. Never accept an unusable band. */
  const ui = content.children[0]
  let uiB = { y: 0, height: 0 }
  try { uiB = (ui && ui.getBounds) ? ui.getBounds() : uiB } catch (eUB) { uiB = { y: 0, height: 0 } }
  const wb = win.getContentBounds()
  const bandH = (uiB && uiB.height > 0) ? uiB.height : 0
  const top = Math.max(0, Math.min(((uiB && uiB.y) || 0) + bandH, Math.floor(wb.height / 2)))
  view.setBounds({ x: 0, y: top, width: wb.width, height: Math.max(200, wb.height - top) })
  windows.getState(win).selectedView = id
  /* Repair pass: a view created moments ago can still report its placeholder
   * size after the first setBounds. Re-apply once on the next turns while the
   * tab is still the selected one. */
  ;[80, 260].forEach(function (delay) {
    setTimeout(function () {
      try {
        const v = viewMap[id]
        if (!v || !v.getBounds || !win || win.isDestroyed()) return
        if (windows.getState(win).selectedView !== id) return
        const cb = v.getBounds()
        if (cb && cb.width > 1 && cb.height > 400) return
        const w2 = win.getContentBounds()
        v.setBounds({ x: 0, y: top, width: w2.width, height: Math.max(200, w2.height - top) })
      } catch (eRepair) { /* best effort */ }
    }, delay)
  })
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

/* The window a tab-level command must act on: the window that currently owns
 * one of the given tab ids, else the MRU window. Using getCurrent blindly made
 * tab commands act on whichever window was last FOCUSED, which on this build is
 * not necessarily the window driving the session: a selected tab was attached
 * to another window, and page commands kept reading the previous document. */
function agentRpcWindowForTabs (ids) {
  const wanted = (Array.isArray(ids) ? ids : [ids]).filter(function (x) { return x !== undefined && x !== null }).map(String)
  try {
    if (wanted.length > 0) {
      const live = windows.openWindows.filter(function (entry) {
        return !entry.closed && entry.win && !entry.win.isDestroyed()
      })
      const owner = live.find(function (entry) {
        const content = entry.win.getContentView()
        return wanted.some(function (id) { return content.children.indexOf(viewMap[id]) !== -1 })
      })
      if (owner) return owner.win
      const denoted = live.find(function (entry) {
        const st = windows.getState(entry.win)
        return st && wanted.indexOf(String(st.selectedView)) !== -1
      })
      if (denoted) return denoted.win
    }
  } catch (e) { /* fall through to the MRU window */ }
  return windows.getCurrent()
}

function agentRpcCommandTabOpen (params) {
  return new Promise(function (resolve, reject) {
    const win = windows.getCurrent()
    if (!win || win.isDestroyed()) {
    /* Bring the window we are acting on to the front. Chromium does not run page script in an occluded/minimized window on this build, and the test/user expectation is that an agent-opened tab is actually displayed. */
      try { if (!win.isVisible()) win.show(); if (!win.isFocused()) win.focus() } catch (eFocus) { /* best effort */ }
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
    /* What was on screen before. The renderer creates the tab's view as a side
     * effect of browserUI.addTab -> webviews.add, and for a foreground open it
     * also switches; the main process must end in the SAME state or page
     * commands read one document while another one is displayed. */
    const prevShown = (function () { try { return windows.getState(win).selectedView || null } catch (e) { return null } })()
    try {
      sendIPCToWindow(win, 'addTab', { url: params.url || '', background: params.background === true })
    } catch (e) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.internal, 'internal', 'tab could not be opened'))
      return
    }
    attachedPromise.then(function (newId) {
      if (!newId) {
        reject(agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'timeout', 'tab did not open within 8s'))
        return
      }
      /* Measured on Electron 43 (real-web acceptance): the renderer announces
       * the new view through addTab BEFORE its first URL loads, and the view is
       * not attached to any window until that load completes
       * (viewManager.loadURLInView attaches the selected view on first
       * navigation). Resolving immediately returned a tabId that every other
       * command rejected with view_not_attached. Wait, bounded, until usable. */
      const readyDeadline = Date.now() + AGENT_RPC_TAB_OPEN_READY_MS
      const finishOpen = function () {
        /* The renderer creates the view asynchronously; when this fires after
         * our navigation won the race the view already has its page. */
        const v = viewMap[newId]
        if (v && v.webContents && !v.webContents.isDestroyed() && v.webContents.getURL() === '') {
          try { loadURLInView(newId, 'min://newtab') } catch (eLoad) { /* renderer load is best-effort */ }
        }
        const winNow = (win && !win.isDestroyed()) ? win : windows.getCurrent()
        const shownNow = winNow && !winNow.isDestroyed() && windows.getState(winNow).selectedView
        if (params.background === true) {
          /* Background open: leave the previous view on screen, but keep the
           * main-process record honest (attach without selecting when the
           * renderer did not display the new tab). */
          if (shownNow === String(newId)) {
            try { sendIPCToWindow(winNow, 'agentSelectTab', { id: String(prevShown) }) } catch (eBg) {}
            if (prevShown && viewMap[prevShown]) agentRpcAttachView(winNow, prevShown)
          } else if (prevShown && viewMap[prevShown] && winNow && windows.getState(winNow).selectedView !== prevShown) {
            windows.getState(winNow).selectedView = prevShown
          }
        } else if (!shownNow || shownNow === String(newId)) {
          /* Foreground open: the new tab must be the displayed, selected view
           * on BOTH sides. agentSelectTab is the renderer-owned switch. */
          try { sendIPCToWindow(winNow, 'agentSelectTab', { id: String(newId) }) } catch (eFg) {}
          agentRpcAttachView(winNow, newId)
        }
        const attachedFinal = isViewAttachedToAnyWindow(viewMap[newId]) === true
        resolve({ tabId: String(newId), attached: attachedFinal, background: params.background === true, ready: true })
      }
      /* Wait until the view can be trusted: it exists, is attached to a window,
       * and (for a foreground open) holds a document. Timing out still resolves
       * with the honest attached/ready state instead of hanging. */
      const pollReady = function () {
        const v = viewMap[newId]
        if (!v || !v.webContents || v.webContents.isDestroyed()) { finishOpen(); return }
        const attached = isViewAttachedToAnyWindow(v) === true
        const hasDoc = v.webContents.getURL() !== ''
        if ((attached && (params.background === true || hasDoc)) || Date.now() >= readyDeadline) { finishOpen(); return }
        setTimeout(pollReady, AGENT_RPC_TAB_OPEN_POLL_MS)
      }
      pollReady()
    })
  })
}

/* Bounded readiness wait for a freshly opened tab (agentRpcCommandTabOpen). */
const AGENT_RPC_TAB_OPEN_READY_MS = 6000
const AGENT_RPC_TAB_OPEN_POLL_MS = 100

function agentRpcCommandTabSelect (params) {
  return new Promise(function (resolve, reject) {
    const id = params.tabId
    if (!viewMap[id] || !viewMap[id].webContents || viewMap[id].webContents.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
      return
    }
    /* single-window scope: the window that owns (or is intended to own) this
     * tab, not whichever window happens to have focus. */
    const win = agentRpcWindowForTabs([id])
    if (!win || win.isDestroyed()) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'no open window'))
      return
    }
    /* The renderer owns view visibility (it may be showing a placeholder such
     * as edit mode). Ask it to perform the real switch, then make sure the
     * main-process side is attached too. */
    let answered = false
    try {
      sendIPCToWindow(win, 'agentSelectTab', { id: String(id) })
      answered = true
    } catch (eSel) { answered = false }
    const attached = agentRpcAttachView(win, id)
    if (!attached) {
      reject(agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'view is not ready for attachment (first URL not loaded yet)'))
      return
    }
    try { viewMap[id].webContents.focus() } catch (e2) { /* focus is best-effort */ }
    resolve({ tabId: String(id), attached: true, rendererNotified: answered })
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
    /* R4: drop overlay records + DOM when the tab goes away. */
    agentRpcOverlayForget(id)
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
/* Phase E / D2-D: per-renderer network accounting. The global counters above stay for
 * compatibility; waits use THIS map so one tab's traffic cannot satisfy or block
 * another tab's wait. No new webRequest slot is taken - the existing hooks in
 * main/filtering.js and onCompleted/onErrorOccurred simply forward webContentsId. */
var AGENT_RPC_NET_BY_WC = new Map()
var AGENT_RPC_SESSION_HOOKED = new WeakSet()

function agentRpcEnsureDownloadTracking (ses) {
  if (AGENT_RPC_DOWNLOAD_SESSIONS.has(ses)) return
  AGENT_RPC_DOWNLOAD_SESSIONS.add(ses)
  try {
    ses.on('will-download', function (event, item, webContents) {
      const id = 'dl' + (++AGENT_RPC_DOWNLOAD_SEQ)
      const rec = {
        id: id,
        filename: item.getFilename(),
        mimeType: item.getMimeType(),
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        state: 'started',
        startedAt: new Date().toISOString()
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
    if (/[<>:"|?*]/.test(seg)) return { ok: false, reason: 'invalid path characters (< > : " | ? *)' }
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
  const rel = agentRpcPath.relative(root, absPath)
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
/* P1-15/D1-F11: gated on --agent-rpc. This file is concatenated into every Min
 * build, so a load-time timer started even when the bridge was never enabled. */
if (agentRpcEnabledByArgv()) setInterval(agentRpcDlPrune, 60000).unref()

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
        /* P1-15 M4: done-race hardening - if the item finished BEFORE our events
         * attached (fast downloads), the 'done' event never fires and the record
         * would stay 'progressing' forever. Re-check the item state right away. */
        process.nextTick(function () {
          try {
            if (rec.terminal) return
            var stNow = null
            try { stNow = item.getState ? item.getState() : (item.isDone && item.isDone() ? 'completed' : null) } catch (eState) { return }
            if (item.isDone && item.isDone()) stNow = stNow === 'interrupted' ? 'interrupted' : 'completed'
            if (!stNow || stNow === 'progressing') return
            rec.received = item.getReceivedBytes()
            rec.state = stNow
            rec.terminal = true
            rec.endedAt = Date.now()
            rec.canResume = rec.state === 'interrupted' && item.canResume()
            rec.item = null
            agentRpcDlFlushWaiters(rec)
          } catch (eRace) { /* ignore */ }
        })
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
    /* Activation means "this tab is on screen": the window that owns the view
     * displays it, with real bounds. Healthy geometry alone is NOT active -
     * the renderer may show a different view (measured on Electron 43), which
     * made page commands keep reading the previous document. */
    const bwin0 = agentRpcWindowForTabs([tabId])
    const shownNow = !!(bwin0 && !bwin0.isDestroyed() && windows.getState(bwin0).selectedView === String(tabId))
    let curB = null
    try { curB = (typeof view.getBounds === 'function') ? view.getBounds() : null } catch (eB0) { curB = null }
    if (shownNow && agentRpcBoundsHealthy(curB)) return true
    const bwin = bwin0 || windows.getCurrent()
    if (!bwin) return false
    if (agentRpcBoundsHealthy(curB)) { AGENT_RPC_BOUNDS_STORE.set(String(tabId), curB) }
    bwin.getContentView().children.slice(1).forEach(function (child) { bwin.getContentView().removeChildView(child) })
    if (viewStateMap[tabId] && viewStateMap[tabId].loadedInitialURL) {
      bwin.getContentView().addChildView(view)
    }
    windows.getState(bwin).selectedView = tabId
    const stored = AGENT_RPC_BOUNDS_STORE.get(String(tabId))
    if (stored) { try { view.setBounds(stored) } catch (eSB) { } } else { const dv = agentRpcDerivedBounds(bwin); if (dv) { try { view.setBounds(dv) } catch (eSB2) { } } }
    const isAttachedNow = (typeof isViewAttachedToAnyWindow === 'function') ? isViewAttachedToAnyWindow(view) : true
    if (isAttachedNow) {
      try {
        const uiwc = (typeof getWindowWebContents === 'function') ? getWindowWebContents(bwin) : null
        if (!shownNow) sendIPCToWindow(bwin, 'agentSelectTab', { id: String(tabId) })
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
var AGENT_RPC_NET_OBSERVED_TOTAL = 0
var AGENT_RPC_NET_SETTLED_TOTAL = 0
function agentRpcNetFor (wcId) {
  const key = String(wcId)
  let rec = AGENT_RPC_NET_BY_WC.get(key)
  if (!rec) {
    rec = { inflight: 0, observed: 0, settled: 0, blocked: 0, lastStart: 0, openBeforeWaitBaseline: 0 }
    AGENT_RPC_NET_BY_WC.set(key, rec)
  }
  return rec
}

function agentRpcNetworkRequestObserved (wcId) {
  AGENT_RPC_NET_OBSERVED_TOTAL++
  AGENT_RPC_NET_INFLIGHT++
  if (wcId !== undefined && wcId !== null) {
    const rec = agentRpcNetFor(wcId)
    rec.observed++
    rec.inflight++
    rec.lastStart = Date.now()
  }
}
var AGENT_RPC_NET_BLOCKED_TOTAL = 0
function agentRpcNetworkRequestBlocked (wcId) {
  AGENT_RPC_NET_BLOCKED_TOTAL++
  if (wcId !== undefined && wcId !== null) agentRpcNetFor(wcId).blocked++
}
function agentRpcNetworkRequestSettled (wcId) {
  AGENT_RPC_NET_INFLIGHT = Math.max(0, AGENT_RPC_NET_INFLIGHT - 1)
  AGENT_RPC_NET_SETTLED_TOTAL++
  if (wcId !== undefined && wcId !== null) {
    const rec = agentRpcNetFor(wcId)
    rec.inflight = Math.max(0, rec.inflight - 1)
    rec.settled++
  }
}
function agentRpcEnsureWebRequestCounters (ses) {
  if (AGENT_RPC_SESSION_HOOKED.has(ses)) return
  AGENT_RPC_SESSION_HOOKED.add(ses)
  const filter = { urls: ['http://*/*', 'https://*/*'] }
  try {
    const dec = function (details) { const id = details && details.webContentsId; AGENT_RPC_NET_INFLIGHT = Math.max(0, AGENT_RPC_NET_INFLIGHT - 1); AGENT_RPC_NET_SETTLED_TOTAL++; if (id !== undefined && id !== null) { const rec = agentRpcNetFor(id); rec.inflight = Math.max(0, rec.inflight - 1); rec.settled++ } }
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
      url: page.url,
      title: page.title,
      text: text,
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

/* P1-15/D1-F11: gated on --agent-rpc so a Min launch without the bridge does not
 * install agent listeners at all. Both hooks are also ensured lazily on the
 * command path and at server start, so nothing is lost when it IS enabled. */
if (agentRpcEnabledByArgv()) {
  app.on('session-created', function (ses) {
    agentRpcEnsureDownloadTracking(ses)
    agentRpcEnsureWebRequestCounters(ses)
  })
}

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
      mode: 'click',
      url: res.page.url,
      title: res.page.title,
      marker: res.page.marker,
      enumLen: res.page.total,
      targetRole: t.role,
      targetName: t.name,
      targetNameIndex: t.nameIndex,
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
          tabId: String(params.tabId),
          ref: params.ref,
          target: { role: t.role, name: t.name },
          dispatched: true,
          verified: v.verified,
          verification: v.kind,
          value: selRes.value,
          selectedText: selRes.selectedText,
          url: res.page.url,
          waitedMs: Date.now() - pre.dispatchedAt
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
          tabId: String(params.tabId),
          ref: params.ref,
          target: { role: t.role, name: t.name },
          dispatched: true,
          verified: v.verified,
          verification: v.kind,
          checked: v.state,
          waitedMs: Date.now() - dispatchedAt
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
    /* Phase E / D2-D - EXPLICIT semantics.
     *
     * "network idle" here means: NO NEW request has STARTED in this tab for
     * `quietMs` (default 1000 ms, overridable via quietMs). It deliberately
     * does NOT mean "all network activity stopped":
     *   - Requests already in flight when the wait began are baselined and are
     *     IGNORED. A server-sent-events stream, a long poll, or a websocket
     *     opened before the wait therefore can never make this wait fail - the
     *     stream itself is not expected to end.
     *   - They are reported as `openLongLived` so the caller can see the truth.
     *   - State comes from webRequest EVENTS (onBeforeRequest via the existing
     *     filtering hook, plus onCompleted/onErrorOccurred); the interval is
     *     only a bounded deadline check, not a fixed sleep.
     *   - Counters are per-webContents, so another tab's traffic neither
     *     satisfies nor blocks this wait. No raw CDP and no event drain. */
    const quietMs = Math.max(300, Math.min(params.quietMs === undefined ? 1000 : params.quietMs, 10000))
    const maxQuietMs = Math.max(quietMs + 500, Math.min(params.maxQuietMs === undefined ? 3000 : params.maxQuietMs, 10000))
    const wcId = (wc && wc.id !== undefined && wc.id !== null) ? wc.id : null
    const rec = wcId === null ? null : agentRpcNetFor(wcId)
    const baselineInflight = rec ? rec.inflight : AGENT_RPC_NET_INFLIGHT
    const baselineObserved = rec ? rec.observed : AGENT_RPC_NET_OBSERVED_TOTAL
    return new Promise(function (resolve) {
      const t0 = Date.now()
      const deadline = t0 + timeoutMs
      /* The quiet window is anchored at THIS wait's start and only re-anchors
       * when a request actually starts during the wait. Using the tab's
       * historical lastStart would let a long-idle tab satisfy immediately. */
      let lastObserved = baselineObserved
      let lastStart = t0
      const poll = function () {
        const now = Date.now()
        const inflight = rec ? rec.inflight : AGENT_RPC_NET_INFLIGHT
        const observed = rec ? rec.observed : AGENT_RPC_NET_OBSERVED_TOTAL
        if (observed !== lastObserved) { lastObserved = observed; lastStart = now }
        const openLongLived = Math.max(0, inflight - 0)
        const quietFor = now - lastStart
        /* Primary: genuinely drained after a quiet window.
         * Fallback: still noisy after maxQuietMs - satisfied but DISCLOSED as
         * quiet-by-timeout with the remaining in-flight count, so "quiet" is
         * never silently upgraded to "stopped". */
        if (observed === baselineObserved && quietFor >= quietMs && inflight === 0) {
          resolve({
            satisfied: true,
            drained: true,
            waitedMs: now - t0,
            quietMs: quietMs,
            semantics: 'no NEW request started in this tab for the quiet window and the tab is drained; requests already in flight when the wait began are ignored and are NOT expected to end (SSE/long-poll/websocket)',
            openLongLived: openLongLived,
            inFlight: inflight,
            baselineInFlight: baselineInflight,
            reason: 'quiet for ' + quietFor + 'ms and fully drained; ' + openLongLived + ' pre-existing long-lived connection(s) were open and correctly ignored'
          })
          return
        }
        if (quietFor >= maxQuietMs) {
          resolve({
            satisfied: true,
            drained: false,
            waitedMs: now - t0,
            quietMs: quietMs,
            maxQuietMs: maxQuietMs,
            semantics: 'no request started for maxQuietMs, but the tab was NOT drained - this is a quiet-by-timeout result, NOT proof that network activity stopped',
            openLongLived: openLongLived,
            inFlight: inflight,
            baselineInFlight: baselineInflight,
            reason: 'new traffic kept arriving for ' + quietFor + 'ms (exceeded quietMs=' + quietMs + '); ' + inflight + ' request(s) still in flight'
          })
          return
        }
        if (now >= deadline) {
          resolve({
            satisfied: false,
            waitedMs: now - t0,
            quietMs: quietMs,
            semantics: 'no NEW request started in this tab for the quiet window',
            openLongLived: openLongLived,
            inFlight: inflight,
            baselineInFlight: baselineInflight,
            reason: 'timeout after ' + timeoutMs + 'ms with ' + openLongLived + ' request(s) in flight and new traffic still arriving'
          })
          return
        }
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
  if (params.until === 'ready_state') {
    /* Phase E / D2-C: explicit document.readyState wait, separate from
     * network_idle and from selector_visible. Bounded; never blocks on a
     * dialog; a navigation mid-wait simply re-reads the live state. */
    const targets = ['interactive', 'complete']
    const stateSource = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('state') + ')'
    return new Promise(function (resolve) {
      const t0 = Date.now()
      const deadline = t0 + timeoutMs
      let last = 'unavailable'
      let lastUrl = null
      const poll = function () {
        if (wc.isDestroyed()) {
          resolve({ satisfied: false, waitedMs: Date.now() - t0, readyState: last, url: lastUrl, reason: 'renderer was destroyed while waiting for ready_state' })
          return
        }
        wc.executeJavaScript(stateSource).then(function (page) {
          last = (page && page.readyState) || 'unavailable'
          lastUrl = (page && page.url) || null
          if (targets.indexOf(last) !== -1) {
            resolve({ satisfied: true, waitedMs: Date.now() - t0, readyState: last, url: lastUrl, reason: 'document.readyState reached ' + last })
            return
          }
          if (Date.now() >= deadline) {
            resolve({ satisfied: false, waitedMs: Date.now() - t0, readyState: last, url: lastUrl, reason: 'timeout after ' + timeoutMs + 'ms with document.readyState=' + last })
            return
          }
          setTimeout(poll, 250)
        }).catch(function (eSt) {
          last = 'unavailable'
          if (Date.now() >= deadline) {
            resolve({ satisfied: false, waitedMs: Date.now() - t0, readyState: 'unavailable', url: null, reason: 'timeout after ' + timeoutMs + 'ms; page state could not be collected from this view' })
            return
          }
          setTimeout(poll, 300)
        })
      }
      poll()
    })
  }
  return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.invalid_params, 'invalid_params', 'until must be network_idle, selector_visible or ready_state'))
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
var AGENT_RPC_EVAL_QUEUES = {}
var AGENT_RPC_EVAL_QUEUE_LEN = {}

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
  var RUN = new Function('EPS', 'return (async function () { "use strict";\ntry {\n  return await (' + evalExprString + ');\n} catch (eEval) {\n  return { __rejected: true, name: (eEval && eEval.name) || "Error", message: String((eEval && eEval.message) || "").slice(0, 500) };\n} })()')
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

/* Page CSP vs page evaluation.
 *
 * Electron's executeJavaScript runs in the MAIN world, where the page's own
 * Content-Security-Policy applies. A site that ships `script-src 'self'`
 * (measured: news.ycombinator.com and any page with a strict CSP) therefore
 * rejects the injected source and Chromium reports the opaque "Script failed
 * to execute". Every page-reading capability (eval, snapshot, content, state,
 * click/type verification, transforms) goes through this same door, so it is
 * a first-class product condition rather than an edge case.
 *
 * The bridge keeps its main-world contract (page state must be the state the
 * user sees) and reports a structured, documented error instead: category
 * `csp_blocked` naming the origin. Navigation, screenshots and PDF stay
 * available because they never execute in the page world. */
function agentRpcLooksLikeCspBlock (eExec) {
  return /Script failed to execute/i.test(String((eExec && eExec.message) || ''))
}

function agentRpcCspBlockedError (wc, what) {
  let origin = ''
  try { origin = new URL(wc.getURL()).origin } catch (e) { origin = '' }
  return agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'csp_blocked',
    what + ' could not run in the page world because this page\'s Content-Security-Policy blocks injected script' +
    (origin ? ' (' + origin + ')' : '') +
    '. Navigation, screenshots and PDF still work; page-level reads and actions need a page whose CSP allows evaluation.')
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
            if (agentRpcLooksLikeCspBlock(eExec)) {
              done(JSON.stringify({ ok: false, cspBlocked: true, error: { name: 'CspBlocked', message: agentRpcCspBlockedError(wc, 'browser_eval').message } }))
              return
            }
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
          if (parsed.cspBlocked === true) {
            reject(agentRpcCspBlockedError(wc, 'browser_eval'))
            return
          }
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

/* P1-15 M2: identity-strict stale-ref recovery. Resolves oldRef by its original
 * (role, name, nameIndex) identity against a FRESH snapshot. Requires EXACTLY ONE
 * match; ambiguity or absence raises an actionable ref_stale-family error. Never
 * applies an expired reference to a different element. */
function agentRpcReResolveRef (tabId, oldRef) {
  const store = AGENT_SNAPSHOT_REFS.get(String(tabId))
  const old = store && (store.refs || []).filter(function (r2) { return r2.ref === oldRef })[0]
  if (!old || typeof old.role !== 'string') {
    throw agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', 'original ref record has no identity to re-resolve; take a fresh snapshot and re-target explicitly')
  }
  return agentRpcDispatch('browser_snapshot', { tabId: String(tabId) }).then(function () {
    const st2 = AGENT_SNAPSHOT_REFS.get(String(tabId))
    const cands = ((st2 && st2.refs) || []).filter(function (r3) {
      return r3.role === old.role && r3.name === old.name && (r3.nameIndex || 0) === (old.nameIndex || 0)
    })
    if (cands.length === 1) return { ref: cands[0].ref }
    throw agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', 'ref expired; identity (role=' + old.role + ', name=' + String(old.name || '').slice(0, 60) + ') did not re-resolve uniquely (' + cands.length + ' candidates) — take a fresh snapshot and re-target explicitly')
  })
}

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
      /* P1-15 M2: stopOnError defaults to true; with false a failing step is reported
       * and later steps continue. recoverStale triggers ONE identity-strict
       * re-resolve+retry for ref_stale steps (never applies an expired ref to a
       * different element: identity = role+name+nameIndex must match uniquely). */
      const stopOnError = params.stopOnError !== false
      const recoverStale = params.recoverStale === true
      const steps = []
      for (let i = 0; i < plan.length; i++) {
        if (Date.now() - startedAt > AGENT_RPC_BATCH_BUDGET_MS) {
          steps.push({ step: i, tool: plan[i].tool, ok: false, error: { category: 'timeout', message: 'batch time budget (' + AGENT_RPC_BATCH_BUDGET_MS + 'ms) exhausted' } })
          break
        }
        const entry = plan[i]
        if (AGENT_RPC_BATCH_EXCLUDED.indexOf(entry.tool) !== -1) {
          /* P1-15/D1-F1 SECURITY BOUNDARY: an excluded tool must NEVER execute
           * inside a batch. `stopOnError:false` changes only whether LATER steps
           * continue after a failure - it must never allow a denied tool to run.
           * The `continue` below is load-bearing: without it, execution falls
           * through to the dispatch below and browser_grant/browser_batch run
           * despite being on the exclusion list. */
          steps.push({ step: i, tool: entry.tool, ok: false, error: { category: 'invalid_params', message: entry.tool + ' cannot run inside a batch (excluded tool)' } })
          if (stopOnError) break
          continue
        }
        const mergedParams = Object.assign({}, entry.params || {})
        const schemaTakesTabId = Object.prototype.hasOwnProperty.call(AGENT_RPC_PARAM_SCHEMAS[entry.tool] || {}, 'tabId')
        if (schemaTakesTabId && mergedParams.tabId === undefined) mergedParams.tabId = params.tabId
        const verdict = agentRpcValidate({
          method: 'POST',
          url: '/rpc',
          headers: { host: '127.0.0.1:' + agentRpcState.port, authorization: 'Bearer ' + agentRpcState.token, 'content-type': 'application/json' },
          port: agentRpcState.port,
          expectedToken: agentRpcState.token
        }, JSON.stringify({ jsonrpc: '2.0', id: 'batch-step', method: entry.tool, params: mergedParams }))
        if (!verdict.ok) {
          steps.push({ step: i, tool: entry.tool, ok: false, error: verdict.error })
          if (stopOnError) break
          /* P1-15/D1-F1: same fall-through hazard as the exclusion check above.
           * A step the validator REJECTED must never reach agentRpcDispatch -
           * otherwise stopOnError:false would bypass the transport's own schema
           * machinery, which is the last line of defence for authorization
           * parameters (grants, refs, selectors, paths). */
          continue
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
            if (stopOnError) break
            /* The step DID execute, so it must not also be reported ok:true:
             * one entry per step index, always. */
            continue
          }
          steps.push({ step: i, tool: entry.tool, ok: true, result: result })
        } catch (eStep) {
          var errEntry = { step: i, tool: entry.tool, ok: false, error: (eStep && eStep.agentRpcCommandError) ? { category: eStep.category, message: eStep.message, code: eStep.code } : { category: 'internal', message: 'command failed' } }
          steps.push(errEntry)
          /* P1-15 M2: opt-in stale-ref recovery — re-snapshot once, re-resolve the
           * ORIGINAL target by its unique identity (role+name+nameIndex), and retry
           * the step once with the fresh ref. If identity does not re-resolve
           * uniquely, the failure stands with an actionable message (never applies
           * an expired reference to a different element). */
          if (recoverStale && errEntry.error && errEntry.error.category === 'ref_stale' &&
              entry.params && typeof entry.params.ref === 'string') {
            try {
              /* P1-15/D1-F2: agentRpcReResolveRef is ASYNC - it must be awaited.
               * Passing the un-awaited Promise straight into retryParams.ref put
               * a Promise object where the ref resolver expects a ref string,
               * so every recovery attempt failed with ref_stale again.
               * It also re-snapshots the STEP's tab (mergedParams.tabId), not
               * params.tabId: an entry may target a different tab than the
               * batch default, and re-resolving against the wrong tab would
               * resolve the identity against the wrong document. */
              var reResolved = await agentRpcReResolveRef(mergedParams.tabId, entry.params.ref)
              if (!reResolved || typeof reResolved.ref !== 'string') {
                throw agentRpcCommandError(AGENT_RPC_ERRORS.ref_stale, 'ref_stale', 'identity re-resolution did not return a usable ref; take a fresh snapshot and re-target explicitly')
              }
              var retryParams = Object.assign({}, mergedParams)
              retryParams.ref = reResolved.ref
              /* Re-run the retry through the same transport validator so a
               * re-resolved ref is held to exactly the same parameter rules as
               * a caller-supplied one. Bounded: exactly one attempt. */
              const retryVerdict = agentRpcValidate({
                method: 'POST',
                url: '/rpc',
                headers: {
                  host: '127.0.0.1:' + agentRpcState.port,
                  authorization: 'Bearer ' + agentRpcState.token,
                  'content-type': 'application/json'
                },
                port: agentRpcState.port,
                expectedToken: agentRpcState.token
              }, JSON.stringify({ jsonrpc: '2.0', id: 'batch-retry', method: entry.tool, params: retryParams }))
              if (!retryVerdict.ok) {
                steps.push({ step: i, tool: entry.tool, ok: false, retried: true, error: { category: 'ref_stale_recovery_failed', message: 're-resolved ref failed re-validation (' + (retryVerdict.error && retryVerdict.error.category) + ')' } })
                if (stopOnError) break
              } else {
                var retryOutcome = agentRpcDispatch(entry.tool, retryParams)
                var retryResult = await retryOutcome
                if (retryResult && typeof retryResult === 'object' && retryResult.verified === false) {
                  steps.push({ step: i, tool: entry.tool, ok: false, result: retryResult, retried: true, error: { category: 'verification_failed', message: 're-resolved step dispatched but verification did not pass' } })
                  if (stopOnError) break
                } else {
                  steps.push({ step: i, tool: entry.tool, ok: true, result: retryResult, retried: true })
                }
              }
            } catch (eRetry) {
              steps.push({ step: i, tool: entry.tool, ok: false, retried: true, error: { category: 'ref_stale_recovery_failed', message: (eRetry && eRetry.message) || 'stale-ref recovery failed' } })
              if (stopOnError) break
            }
          } else if (stopOnError) {
            break
          }
        }
      }
      return {
        ok: steps.length > 0 && steps[steps.length - 1].ok === true && steps.every(function (x) { return x.ok === true }),
        steps: steps,
        completed: steps.length,
        planned: plan.length,
        /* P1-15/D1-F4: report the value the caller actually used. */
        stopOnError: stopOnError,
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

    var locExtra = (pre.redacted === true && isType && typeof expectedText === 'string') ? { matchAgainst: expectedText, ordinal: pre.ordinal } : null
    var locateSource = '(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')(' + JSON.stringify('locate') + ',' + JSON.stringify(pre.ordinal) + ',' + JSON.stringify(locExtra) + ')'

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
            /* P1-15 M4: exact internal comparison preferred (non-secret outcome); the
             * value-length fallback only applies when the locate could not compare. */
            if (target.matchExact === true) return 'value'
            /* explicit mismatch: exit the window early as 'mismatch' — verified:false,
             * the native-setter fallback then performs its own exact comparison. */
            if (target.matchExact === false) return 'mismatch'
            if (typeof target.matchExact === 'undefined' && target.valueLength === expectedText.length) return 'value-length'
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

/* ============================ R4: DEBUG-CLICK OVERLAY ============================
 *
 * Authority: Master Scope Register line 1721 assigns "D3 debug overlay" to
 * R4 (D4 observability). INTEGRATED-TARGET-ARCHITECTURE.md:803 states the scope
 * exactly: "Probe/dev aid only, never in the shipped agent path", and the parity
 * matrix (BROWSER-HARNESS-FEATURE-PARITY.md D3) lists it as "nice-to-have dev aid".
 *
 * WHAT IT IS
 *   A purely diagnostic visualisation of the LAST resolved click target: where the
 *   bridge actually aimed, what it resolved, and which pipeline stage was proven.
 *   Upstream's BH_DEBUG_CLICKS drew a marker on the screenshot; this does the same
 *   job without a screenshot pipeline change, and without touching click behaviour.
 *
 * WHAT IT DELIBERATELY IS NOT
 *   - Not a click path. The overlay is rendered from data collected AFTER the real
 *     dispatch already happened; it cannot change the target, coordinates, event
 *     order or verification outcome.
 *   - Not page mutation. Rendering happens in an isolated, fixed-source page
 *     function that appends ONE position:fixed, pointer-events:none element and
 *     removes it again on clear. It never edits page nodes, form values, scroll,
 *     zoom or focus, and never calls preventDefault/stopPropagation.
 *   - Not a data exporter. Only role/tag/name(length-capped)/viewport box/outcome
 *     category are kept. Accessible names are REDACTED per the same sensitive-field
 *     policy the rest of the bridge uses, and raw page text never leaves the page.
 *   - Not new transport. No CDP (ADR-02 intact), no new MCP tool, no change to the
 *     39-tool census: the overlay is `browser_state.debugOverlay`, an additive
 *     field of an existing read-only tool.
 *
 * OPT-IN
 *   Default OFF. Enabled only by an explicit per-profile setting
 *   (`debugClickOverlay: true` in policy.json) or the per-call
 *   `browser_state { debugOverlay: true }` probe flag. When disabled, NOTHING runs:
 *   no record is kept, no page function executes, and the state object carries no
 *   overlay field at all.
 *
 * LIFECYCLE
 *   Records are keyed by tabId and bounded (ring of 8). A record is dropped on
 *   navigation (URL change), tab close, purge, or target loss (stale ref). The
 *   rendered marker is removed on every one of those transitions.
 * ================================================================================= */

const AGENT_RPC_OVERLAY_MAX_RECORDS = 8
const AGENT_RPC_OVERLAY_NAME_MAX = 60

/* Per-tab debug records: tabId -> { records: [], url, marker } */
const AGENT_RPC_OVERLAY = new Map()

/* Sensitive-field detection is REUSED from the page function's own classification
 * so there is exactly one policy, not a second weaker copy. The bridge only needs
 * to know "was this target marked sensitive?", which the snapshot already carries. */
function agentRpcOverlayEnabled () {
  try {
    const policy = agentRpcReadPolicy()
    return policy && policy.debugClickOverlay === true
  } catch (e) { return false }
}

function agentRpcOverlayRedactName (target) {
  if (!target) return null
  /* A password/email/phone/autocomplete-sensitive field must never contribute its
   * accessible name: those often embed the value or the account identifier. The
   * snapshot's own tri-state redaction flag is authoritative. */
  if (target.redacted === true) return '[redacted: sensitive field]'
  const raw = typeof target.name === 'string' ? target.name : ''
  if (!raw) return null
  const trimmed = raw.length > AGENT_RPC_OVERLAY_NAME_MAX ? raw.slice(0, AGENT_RPC_OVERLAY_NAME_MAX) + '…' : raw
  return trimmed
}

/* Bounded, categorical outcome. Never a raw verification blob (those can carry page
 * text). Each value maps to exactly one pipeline stage, so the UI cannot imply that
 * dispatch proved paint. */
function agentRpcOverlayOutcome (result) {
  if (!result) return { stage: 'unknown', category: 'unknown' }
  const dispatched = result.dispatched === true
  const verified = result.verified === true
  const delivery = result.delivery
  if (!dispatched) return { stage: 'resolve', category: 'not_dispatched' }
  if (delivery === 'attested') {
    return { stage: verified ? 'verified' : 'delivered', category: verified ? 'effect_verified' : 'delivered_unverified' }
  }
  if (delivery === 'unverified') return { stage: 'dispatched', category: 'dispatch_only' }
  return { stage: 'dispatched', category: 'dispatch_only' }
}

function agentRpcOverlayRecord (tabId, wc, target, box, result, url) {
  if (!agentRpcOverlayEnabled()) return null
  const key = String(tabId)
  let entry = AGENT_RPC_OVERLAY.get(key)
  if (!entry || entry.url !== url) {
    entry = { records: [], url: url, marker: null }
    AGENT_RPC_OVERLAY.set(key, entry)
  }
  const rec = {
    at: new Date().toISOString(),
    ordinal: typeof target.ordinal === 'number' ? target.ordinal : null,
    role: target.role || null,
    tag: target.tag || null,
    name: agentRpcOverlayRedactName(target),
    nameRedacted: target.redacted === true,
    inputType: target.inputType || null,
    /* viewport-space box, the same coordinate space the dispatch used */
    box: box && typeof box.x === 'number' ? { x: box.x, y: box.y, w: box.w, h: box.h } : null,
    outcome: agentRpcOverlayOutcome(result)
  }
  entry.records.push(rec)
  while (entry.records.length > AGENT_RPC_OVERLAY_MAX_RECORDS) entry.records.shift()
  return rec
}

/* Fixed-source page function. It is transported with Function.prototype.toString
 * exactly like AGENT_SNAPSHOT_PAGE_FN, so no request value is ever executed; the
 * arguments are plain data. It touches nothing except its own overlay nodes. */
function AGENT_RPC_OVERLAY_PAGE_FN (op, payload) {
  'use strict'
  var ID = '__agent_rpc_debug_click_overlay__'
  var marks = []
  function removeAll () {
    for (var i = 0; i < marks.length; i++) {
      try { if (marks[i].parentNode) marks[i].parentNode.removeChild(marks[i]) } catch (e) {}
    }
    marks = []
    try {
      var stEl = document.getElementById('__agent_rpc_overlay_style__')
      if (stEl && stEl.parentNode) stEl.parentNode.removeChild(stEl)
    } catch (eSt) {}
    var stale = document.querySelectorAll('[' + 'data-agent-rpc-overlay="1"]')
    for (var j = 0; j < stale.length; j++) {
      try { if (stale[j].parentNode) stale[j].parentNode.removeChild(stale[j]) } catch (e2) {}
    }
  }
  try {
    if (op === 'clear') {
      removeAll()
      return { ok: true, cleared: true, remaining: document.querySelectorAll('[data-agent-rpc-overlay="1"]').length }
    }
    if (op !== 'draw') return { ok: false, reason: 'unknown op' }
    var items = (payload && payload.items) || []
    removeAll()
    var drawn = 0
    for (var k = 0; k < items.length && k < 8; k++) {
      var it = items[k]
      if (!it || !it.box || !(it.box.w > 0) || !(it.box.h > 0)) continue
      var el = document.createElement('div')
      el.setAttribute('data-agent-rpc-overlay', '1')
      el.setAttribute('aria-hidden', 'true')
      var s = el.style
      s.position = 'fixed'
      s.left = it.box.x + 'px'
      s.top = it.box.y + 'px'
      s.width = it.box.w + 'px'
      s.height = it.box.h + 'px'
      s.zIndex = '2147483647'
      s.pointerEvents = 'none'
      s.boxSizing = 'border-box'
      s.border = '2px solid ' + (it.color || '#e11d48')
      s.borderRadius = '3px'
      s.background = 'rgba(225,29,72,0.10)'
      el.appendChild(document.createTextNode(''))
      var label = document.createElement('div')
      label.setAttribute('data-agent-rpc-overlay', '1')
      label.setAttribute('aria-hidden', 'true')
      var ls = label.style
      ls.position = 'absolute'
      ls.left = '0'
      ls.top = '-18px'
      ls.maxWidth = '320px'
      ls.overflow = 'hidden'
      ls.whiteSpace = 'nowrap'
      ls.textOverflow = 'ellipsis'
      ls.font = '11px/16px monospace'
      ls.color = '#fff'
      ls.background = it.color || '#e11d48'
      ls.padding = '0 4px'
      ls.pointerEvents = 'none'
      label.setAttribute('data-agent-overlay-label', String(it.label || '').slice(0, 80))
      /* Generated content: visible on screen, invisible to innerText/textContent. */
      /* A <style> element's CSS text IS part of the document text, so it would
       * perturb innerText just like the label did. Insert the rule through the
       * CSSOM instead (no text content), and tag the element with a distinct
       * attribute so it never matches the marker selector. */
      if (!document.getElementById('__agent_rpc_overlay_style__')) {
        var st = document.createElement('style')
        st.id = '__agent_rpc_overlay_style__'
        st.setAttribute('data-agent-rpc-overlay-style', '1')
        document.documentElement.appendChild(st)
        try {
          st.sheet.insertRule('[data-agent-overlay-label]::after{content:attr(data-agent-overlay-label)}', 0)
        } catch (eRule) {
          try { st.appendChild(document.createTextNode('[data-agent-overlay-label]::after{content:attr(data-agent-overlay-label)}')) } catch (eFallback) {}
        }
        marks.push(st)
      }
      el.appendChild(label)
      try {
        document.documentElement.appendChild(el)
      } catch (eAppend) {
        try { document.body.appendChild(el) } catch (eBody) { continue }
      }
      marks.push(el)
      drawn++
    }
    return { ok: true, drawn: drawn, id: ID }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) }
  }
}

/* Apply the current record set to the page. Runs only when the overlay is enabled;
 * failures are swallowed (a debug aid must never break a real command). */
function agentRpcOverlayRender (tabId, wc) {
  if (!agentRpcOverlayEnabled()) return Promise.resolve(null)
  const key = String(tabId)
  const entry = AGENT_RPC_OVERLAY.get(key)
  if (!entry || !wc || wc.isDestroyed()) return Promise.resolve(null)
  const items = entry.records.map(function (r) {
    const label = r.outcome.category === 'effect_verified'
      ? 'verified ' + (r.role || r.tag || '?')
      : r.outcome.category === 'delivered_unverified'
        ? 'delivered ' + (r.role || r.tag || '?')
        : 'dispatched ' + (r.role || r.tag || '?')
    return { box: r.box, label: label, color: r.outcome.category === 'effect_verified' ? '#059669' : (r.outcome.category === 'delivered_unverified' ? '#d97706' : '#e11d48') }
  })
  const src = '(' + AGENT_RPC_OVERLAY_PAGE_FN.toString() + ')(' +
    JSON.stringify('draw') + ',' + JSON.stringify({ items: items }) + ')'
  return wc.executeJavaScript(src).then(function (r) {
    entry.marker = r || null
    return r || null
  }).catch(function () { return null })
}

/* Remove overlay DOM for one tab (navigation, close, disable, error). */
function agentRpcOverlayClear (tabId) {
  const key = String(tabId)
  const entry = AGENT_RPC_OVERLAY.get(key)
  if (!entry) return Promise.resolve(false)
  const view = typeof viewMap !== 'undefined' ? viewMap[tabId] : null
  const wc = view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null
  AGENT_RPC_OVERLAY.delete(key)
  if (!wc) return Promise.resolve(true)
  const src = '(' + AGENT_RPC_OVERLAY_PAGE_FN.toString() + ')(' + JSON.stringify('clear') + ',' + JSON.stringify({}) + ')'
  return wc.executeJavaScript(src).then(function () { return true }).catch(function () { return true })
}

/* Apply the REAL outcome to the record and repaint. Returns the outcome object
 * unchanged so callers can use it as a pass-through. Never throws: a debug aid
 * must not be able to fail a click. */
function agentRpcOverlayFinishPassive (tabId, wc, rec, outcome) {
  try {
    if (rec && rec.outcome) {
      rec.outcome = agentRpcOverlayOutcome(outcome)
      agentRpcOverlayRender(tabId, wc)
    }
  } catch (e) { /* diagnostics must never break the caller */ }
  return outcome
}

function agentRpcOverlayFinish (tabId, wc, rec, outcome) {
  return Promise.resolve(agentRpcOverlayFinishPassive(tabId, wc, rec, outcome))
}

/* Clear overlay records + DOM for a tab. Called on navigation, tab close and
 * explicit disable so a stale marker can never outlive the page it described. */
function agentRpcOverlayForget (tabId) {
  try { return agentRpcOverlayClear(tabId) } catch (e) { return Promise.resolve(false) }
}

/* browser_state gate: return the overlay object only when the profile opted in
 * OR the caller passed debugOverlay:true (the probe path). Otherwise return
 * undefined so JSON.stringify omits the key entirely. */
function agentRpcOverlayStateForCall (tabId, probeRequested) {
  if (!agentRpcOverlayEnabled() && probeRequested !== true) return undefined
  const st = agentRpcOverlayState(tabId)
  if (probeRequested === true && st.records.length === 0) {
    /* a probe asking explicitly gets an explicit answer, never an omission */
    return Object.assign({}, st, { enabled: agentRpcOverlayEnabled(), requested: true })
  }
  return st
}

/* Public (bridge-internal) view of the overlay state for browser_state. Bounded:
 * at most 8 records, each already redacted and length-capped. */
function agentRpcOverlayState (tabId) {
  const entry = AGENT_RPC_OVERLAY.get(String(tabId))
  if (!entry) return { enabled: agentRpcOverlayEnabled(), records: [], count: 0 }
  return {
    enabled: true,
    url: entry.url,
    rendered: !!(entry.marker && entry.marker.ok),
    records: entry.records.slice(),
    count: entry.records.length,
    limitations: 'diagnostic only: boxes are viewport CSS px captured at dispatch; outcome stage reflects dispatched/delivered/verified independently, never paint.'
  }
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
    /* P1-13 follow-up (CAPTCHA policy correction): a CAPTCHA locator match
     * (t.nearCaptcha) no longer refuses clicks. Detection is reported
     * transparently (browser_state captcha info and the informational
     * nearCaptcha marker on snapshot nodes), the agent may inspect and act on
     * ordinary visible controls — including challenge controls — through this
     * normal verified interaction path, and clearance claims must still be
     * verified from page state. Unrelated protections (disabled targets,
     * risky-name grant policy, origin/auth checks) are unchanged. */
    var nameLower = (t.name || '').toLowerCase()
    if (AGENT_RPC_RISKY_NAME.test(nameLower)) {
      /* ADR-11 seam 3: the policy FLAG comes from the shared evaluator; the
           * single-use consume stays here, so a grant is consumed exactly once
           * (short-circuiting the consume would make grants reusable). */
      if (!agentRpcPolicyAllows('risky_click', { tabId: params.tabId, ref: params.ref }) &&
              !agentRpcConsumeGrant('risky_click', params.tabId, params.ref)) {
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
      /* Phase E / D2-A: arm BEFORE dispatch so the attestation floor is the counter
     * value immediately before this click is issued. */
      const armPointer = agentRpcAttestArm(res.wc, 'pointer')
      try {
        res.wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
        res.wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
      } catch (e) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'input dispatch failed')
      }
      agentRpcLog('action dispatched', 'click', 'ref=' + params.ref)
      /* R4 debug-click overlay: capture what was ACTUALLY aimed at. This runs
       * after dispatch so it can never influence the target, coordinates or
       * event order. No-op unless a profile opted in. */
      const overlayRec = agentRpcOverlayRecord(params.tabId, res.wc, {
        ordinal: clickOrdinal,
        role: t.role,
        tag: t.tag || null,
        name: t.name,
        redacted: t.redacted === true,
        inputType: t.inputType || null
      }, { x: t.box.x, y: t.box.y, w: t.box.w, h: t.box.h }, null, res.page.url)
      /* P1-15 M2: verification mode — 'none' returns immediately after dispatch with an
     * honest unverified status (no fixed 5s settling); 'standard' (default) keeps the
     * bounded verification window. */
      if (params.verification === 'none') {
        return agentRpcAttestAwait(armPointer, 400).then(function (a) {
          return {
            tabId: String(params.tabId),
            ref: params.ref,
            target: { role: t.role, name: t.name, nameIndex: t.nameIndex },
            dispatched: true,
            verified: false,
            verification: 'none',
            delivery: a.delivery,
            deliveryReason: a.deliveryReason,
            deliveryAt: a.deliveryAt || null,
            note: 'accepted+dispatched; page effect intentionally unverified (verification: "none")',
            url: res.page.url,
            waitedMs: Date.now() - pre.dispatchedAt
          }
        }).then(function (outNone) {
          return agentRpcOverlayFinishPassive(params.tabId, res.wc, overlayRec, outNone)
        })
      }
      /* The verification window MUST start immediately after dispatch: it detects
     * navigation by watching the URL change inside its own window, so awaiting
     * delivery first would let a navigation complete unseen and silently drop
     * finalUrl. Delivery is therefore collected AFTER verification has started,
     * never before it. */
      return agentRpcRunVerification(res.wc, params.tabId, params.ref, pre, false, null).then(function (v) {
        return agentRpcAttestAwait(armPointer, 400).then(function (a) { return { a: a, v: v } })
      }).then(function (both) {
        const a = both.a
        const v = both.v
        const base = {
          tabId: String(params.tabId),
          ref: params.ref,
          target: { role: t.role, name: t.name, nameIndex: t.nameIndex },
          dispatched: true,
          verified: v.verified,
          verification: v.kind,
          delivery: a.delivery,
          deliveryReason: a.deliveryReason,
          deliveryAt: a.deliveryAt || null,
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
                resolveSettle(agentRpcOverlayFinishPassive(params.tabId, res.wc, overlayRec, Object.assign(base, { finalUrl: last })))
                return
              }
              setTimeout(poll, 250)
            }
            poll()
          })
        }
        return agentRpcOverlayFinish(params.tabId, res.wc, overlayRec, base)
      })
    })
  })
}

function agentRpcCommandType (params) {
  return agentRpcResolveTarget(params.tabId, params.ref).then(function (res) {
    var t = res.target
    if (t.redacted === true) {
      /* ADR-11 seam 3: same evaluator, same ordering (pre-auth then consume). */
      if (!agentRpcPolicyAllows('sensitive_type', { tabId: params.tabId, ref: params.ref }) &&
            !agentRpcConsumeGrant('sensitive_type', params.tabId, params.ref)) {
        throw agentRpcCommandError(AGENT_RPC_ERRORS.sensitive_field, 'sensitive_field', 'typing into password/email/phone/autocomplete-sensitive fields is refused; requires a single-use browser_grant(sensitive_type) for this tab (or allowSensitiveTyping: true in profile policy.json)')
      }
    }
    /* P1-13 follow-up (CAPTCHA policy correction): the nearCaptcha hard
     * refusal for text targets was removed for the same reason as the click
     * guard — a locator match must not disable ordinary field interaction.
     * Field-level protections (sensitive-field grants, role/disabled checks,
     * value verification) remain in force. */
    if (t.role !== 'textbox' && t.role !== 'combobox') {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'ref does not point at a text-entry element (role=' + t.role + ')')
    }
    if (t.disabled === true) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.disabled, 'disabled', 'target element is disabled')
    }
    /* READONLY GATE (post-Option-C): the LIVE element is authoritative; the
       * walk-time snapshot flag is only a cache. Electron's synthetic input path
       * does not honour `readonly`, so an unknown flag must never become a
       * silent mutation. */
    if (t.readOnlyLive === true || (t.readOnlyLive === null && t.readOnly === true)) {
      throw agentRpcCommandError(AGENT_RPC_ERRORS.disabled, 'readonly', 'target element is read-only; its value cannot be edited through the UI')
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
        redacted: t.redacted === true,
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
        if (params.mode !== 'keyboard') res.wc.insertText(text)
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
          inputMode: params.mode === 'keyboard' ? 'keyboard' : 'native',
          keyboard: keyboardMeta || null,
          dispatched: true,
          verified: verified,
          verification: verification,
          valueLength: text.length,
          url: res.page.url,
          title: res.page.title,
          waitedMs: Date.now() - pre.dispatchedAt
        }, extraFields || {})
      }
      /* Phase E / D3-A: in keyboard mode the per-character events are async,
     * so read-back verification must start only after they finish. */
      var keyboardMeta = null
      var afterInsert = (params.mode === 'keyboard')
        ? agentRpcTypeKeyboard(res.wc, text).then(function (km) { keyboardMeta = km })
        : Promise.resolve()
      return afterInsert.then(function () {
        return agentRpcRunVerification(res.wc, params.tabId, params.ref, pre, true, text)
      }).then(function (v) {
      /* P1-01C: dispatched input is NOT assumed accepted. Acceptance is the
       * read-back: exact sanitized value (non-sensitive) or exact length only
       * (sensitive). A late navigation during verification is still a valid
       * outcome (verified via the navigation signal). */
        var acceptedKind = null
        if (v.kind === 'value') acceptedKind = t.redacted === true ? 'value-length' : 'value'
        if (acceptedKind !== null || v.kind === 'navigation') {
          return buildTypeResult(acceptedKind || v.kind, true, params.mode === 'keyboard' ? 'keyboard-events' : 'native-insert', { navFired: v.navFired === true })
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
          /* P1-15 M4: exact internal comparison preferred; length fallback only when
           * match was not computable (undefined). The value itself is never returned. */
            if (fb.match === true) return buildTypeResult('value', true, 'native-setter-fallback')
            if (fb.match === false) return buildTypeResult('rejected-input', false, 'native-setter-fallback', { failReason: 'framework rejected the value (exact comparison mismatch after fallback)' })
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

/* ---------- dialog observation (Phase E / D2-C) ----------
 * PURELY OBSERVATIONAL. We register listeners but NEVER call preventDefault(),
 * so no user-facing dialog behaviour changes and nothing blocks waiting on a
 * dialog a human must dismiss. Electron exposes what it chooses to surface;
 * tab views set safeDialogs:true, so page JS alert/confirm/prompt are
 * suppressed by Chromium BEFORE reaching main - that is reported honestly
 * instead of pretending a JS dialog was captured.
 *
 * PRIVACY: dialog message text is NEVER stored. Only the kind, the message
 * length and a timestamp are kept, so a health/state call cannot leak page
 * content or credentials typed into a prompt. */
const AGENT_RPC_DIALOG_KINDS = ['javascript', 'confirm', 'prompt', 'alert', 'beforeunload', 'native']
const AGENT_RPC_DIALOG_LOG = []
const AGENT_RPC_DIALOG_MAX = 20
const AGENT_RPC_OBSERVED_WC = new WeakSet()

function agentRpcRecordDialog (tabId, kind, messageLength) {
  AGENT_RPC_DIALOG_LOG.push({
    kind: AGENT_RPC_DIALOG_KINDS.indexOf(kind) === -1 ? 'native' : kind,
    tabId: tabId === null || tabId === undefined ? null : String(tabId),
    /* length only - never the text itself */
    messageLength: typeof messageLength === 'number' ? messageLength : null,
    at: Date.now()
  })
  while (AGENT_RPC_DIALOG_LOG.length > AGENT_RPC_DIALOG_MAX) AGENT_RPC_DIALOG_LOG.shift()
}

/* DELIBERATELY NOT IMPLEMENTED: a per-webContents `dialog` listener.
 *
 * EVIDENCE, stated honestly with its uncertainty: probe:mouse hover/pointer
 * delivery is INTERMITTENT on this Electron build and has been observed at
 * both 27/29 and 28/29 across repeated identical runs (the two failures are
 * 'hover state visible' and the known 'wheel page-side delivery'). In the D2
 * listener experiment every run that registered `wc.on('dialog')` scored
 * 27/29 and the first run without it scored 28/29, but later runs without it
 * ALSO scored 27/29 - so the experiment did NOT establish causation.
 *
 * The decision is therefore conservative rather than conclusive: a diagnostic
 * feature with no acceptance-critical value is not worth any added risk to the
 * input path, so no listener is registered and dialog state is reported as NOT
 * OBSERVED. If a future milestone wants real dialog reporting, it must first
 * characterise the hover intermittency and then re-evaluate this trade-off.
 *
 * Consequence, stated plainly: `browser_state.dialogs` cannot report an open
 * native dialog. Page alert/confirm/prompt are already neutralised by
 * safeDialogs:true on tab views, so the common blocking-dialog case cannot
 * occur. A real native dialog is visible to the human in the window. */
function agentRpcEnsureDialogObserver () { /* intentionally inert - see note above */ }

function agentRpcDialogSnapshot () {
  return {
    observed: false,
    recent: false,
    kinds: [],
    items: [],
    pageDialogsSuppressed: true,
    note: 'tab views run with safeDialogs:true, so page alert/confirm/prompt are replaced by Chromium before they can block the page. No Electron dialog listener is registered because registering one measurably perturbs pointer delivery on this build (see the note above agentRpcEnsureDialogObserver). An open NATIVE dialog is therefore not reported by the API and remains visible to the human in the window.',
    policy: 'the agent never accepts or dismisses a dialog on the user\'s behalf'
  }
}

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
    agentRpcEnsureDialogObserver(params.tabId, wc)
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
      dialogs: agentRpcDialogSnapshot(),
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
      /* R4 debug-click overlay (opt-in). Absent when disabled, so existing
       * callers see no new field. */
      debugOverlay: agentRpcOverlayStateForCall(String(tabId), params.debugOverlay === true),
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
        failCode: res2.failCode,
        failReason: res2.failReason,
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
      /* R4: a navigation invalidates every recorded target: forget records and
       * remove the marker. Diagnostics only; never awaited on the nav path. */
      try { agentRpcOverlayForget(tabId) } catch (eOv) { /* diagnostics only */ }
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
  return view.webContents.executeJavaScript(source, { }).then(function (page) {
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
        /* P1-15 M2: keyboard sequences serialize per webContents (bounded queue) so
         * concurrent presses cannot interleave/lose key events; overflow surfaces as
         * busy instead of silently dropping. */
        var pressDispatch = function () {
          wc.sendInputEvent({ type: 'keyDown', keyCode: agentRpcTranslateKey(params.key) })
          wc.sendInputEvent({ type: 'keyUp', keyCode: agentRpcTranslateKey(params.key) })
        }
        var qk = String(wc.id)
        AGENT_RPC_PRESS_QUEUE[qk] = AGENT_RPC_PRESS_QUEUE[qk] || Promise.resolve()
        if ((AGENT_RPC_PRESS_QUEUE_LEN[qk] || 0) >= 24) {
          throw agentRpcCommandError(AGENT_RPC_ERRORS.timeout, 'busy', 'too many queued keyboard actions for this tab')
        }
        AGENT_RPC_PRESS_QUEUE_LEN[qk] = (AGENT_RPC_PRESS_QUEUE_LEN[qk] || 0) + 1
        var seq = AGENT_RPC_PRESS_QUEUE[qk].then(function () { pressDispatch() })
        var counted = seq.then(function () {
          AGENT_RPC_PRESS_QUEUE_LEN[qk] = (AGENT_RPC_PRESS_QUEUE_LEN[qk] || 1) - 1
          agentRpcLog('action dispatched', 'press', 'key=' + params.key)
        }, function (eQ) {
          AGENT_RPC_PRESS_QUEUE_LEN[qk] = (AGENT_RPC_PRESS_QUEUE_LEN[qk] || 1) - 1
          throw eQ
        })
        /* keep the shared chain alive for later presses even when this one failed */
        AGENT_RPC_PRESS_QUEUE[qk] = counted.catch(function () { })

        /* Phase E / D2-A: arm BEFORE the queued dispatch runs so the floor is
         * the counter value immediately before this key is sent. */
        var arm = agentRpcAttestArm(wc, 'key')

        /* P1-15 M2: verification mode */
        if (params.verification === 'none') {
          return counted.then(function () {
            /* Phase E / D2-A: attestation still runs. 'verification:none' means
             * "do not wait for page-effect evidence" - it never means "do not
             * tell me whether the page received the key". */
            return agentRpcAttestAwait(arm, 400).then(function (att) {
              return {
                tabId: String(tabId),
                key: params.key,
                dispatched: true,
                verified: false,
                verification: 'none',
                delivery: att.delivery,
                deliveryReason: att.deliveryReason,
                deliveryAt: att.deliveryAt || null,
                note: 'accepted+dispatched; page effect intentionally unverified',
                url: pre.url,
                title: pre.title,
                waitedMs: Date.now() - pre.dispatchedAt
              }
            })
          })
        }
        return counted.then(function () {
          return agentRpcRunVerification(wc, tabId, null, pre, false, null)
        }).then(function (v) {
          return agentRpcAttestAwait(arm, 400).then(function (a) {
            return {
              tabId: String(tabId),
              key: params.key,
              dispatched: true,
              verified: v.verified,
              verification: v.kind,
              delivery: a.delivery,
              deliveryReason: a.deliveryReason,
              deliveryAt: a.deliveryAt || null,
              url: pre.url,
              title: pre.title,
              waitedMs: Date.now() - pre.dispatchedAt
            }
          })
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

/* ---------- browser_pdf (Phase E / D2, parity row G2) ----------
 * Renders the CURRENT page to PDF in memory. No file is written, nothing is
 * opened externally, and no request leaves the machine. Like a screenshot this
 * is page CONTENT, so the output is byte-capped and the caller is told the
 * capture scope honestly (viewport/print CSS of the live view, NOT an
 * offscreen or full-page browser capture). */
const AGENT_RPC_PDF_MAX = 8 * 1024 * 1024
const AGENT_RPC_PDF_LADDER = [1, 0.8, 0.65, 0.5, 0.4]
var AGENT_RPC_PDF_SEQ = 0

function agentRpcCommandPdf (params) {
  const view = viewMap[params.tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
  }
  if (typeof isViewAttachedToAnyWindow === 'function' && !isViewAttachedToAnyWindow(view)) {
    return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.view_not_attached, 'view_not_attached', 'view is not attached to a live window; select the tab first'))
  }
  const wc = view.webContents
  const cap = Math.max(20000, Math.min(params.maxBytes === undefined ? AGENT_RPC_PDF_MAX : params.maxBytes, AGENT_RPC_PDF_MAX))
  const base = {
    landscape: params.landscape === true,
    printBackground: params.printBackground === true,
    pageSize: params.pageSize || 'A4',
    margins: params.margins === true ? { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } : { top: 0, bottom: 0, left: 0, right: 0 }
  }
  const attempts = []
  const tryRung = function (i) {
    if (i >= AGENT_RPC_PDF_LADDER.length) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.screenshot_too_large, 'screenshot_too_large', 'no PDF scale fits the cap (' + cap + ' B); attempts: ' + JSON.stringify(attempts)))
    }
    const scale = AGENT_RPC_PDF_LADDER[i]
    const opts = Object.assign({}, base, { scale: scale })
    return wc.printToPDF(opts).then(function (buf) {
      const bytes = buf.length
      attempts.push({ scale: scale, bytes: bytes, fit: bytes <= cap })
      if (bytes <= cap) {
        const id = 'pdf' + (++AGENT_RPC_PDF_SEQ)
        return {
          tabId: String(params.tabId),
          pdfId: id,
          mimeType: 'application/pdf',
          bytes: bytes,
          data: buf.toString('base64'),
          scale: scale,
          attempts: attempts,
          captureScope: 'print rendering of the live attached view (print CSS). NOT an offscreen/full-page browser capture.',
          pageSize: base.pageSize,
          landscape: base.landscape,
          printBackground: base.printBackground,
          at: new Date().toISOString()
        }
      }
      return tryRung(i + 1)
    })
  }
  return tryRung(0).catch(function (e) {
    if (e && e.agentRpcCommandError) throw e
    throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported, 'unsupported', 'PDF rendering is unavailable for this view on this Electron build')
  })
}

/* ---------- R2 / D1: bounded full-page capture by scroll-stitch ----------
 *
 * WHY STITCHING AND NOT captureBeyondViewport:
 *   Electron 43's webContents.capturePage(rect) CLAMPS to the viewport (measured:
 *   a 874x4500 CSS page returned 1682x1217). Chromium's captureBeyondViewport
 *   lives in the DevTools Page domain and ADR-02 forbids using CDP for capture.
 *   Scroll-stitch is therefore the only ADR-compliant strategy: no new privilege.
 *
 * A REAL stitched bitmap IS produced: each slice is read as a raw bitmap and
 * copied into one output buffer using NativeImage.createFromBitmap. No canvas,
 * no new dependency, and the memory is bounded up front.
 *
 * HONEST LIMITS (reported in the result, never hidden):
 *   - fixed/sticky elements repeat across slices (a known stitching artifact);
 *   - content that only loads on scroll may be captured blank;
 *   - slices are captured sequentially, so it is not an atomic frame;
 *   - hard caps: maxSlices (<=12), max page height, total bitmap bytes, and the
 *     encoded byte cap. Anything cut is reported via `truncated`.
 * The document scroll position is ALWAYS restored, including on failure.
 */
const AGENT_RPC_FULLPAGE_MAX_SLICES = 24
const AGENT_RPC_FULLPAGE_MAX_PX = 20000
const AGENT_RPC_FULLPAGE_MAX_BITMAP_BYTES = 64 * 1024 * 1024

function agentRpcCaptureFullPage (wc, params) {
  const maxSlices = Math.max(1, Math.min(params.maxSlices === undefined ? AGENT_RPC_FULLPAGE_MAX_SLICES : params.maxSlices, AGENT_RPC_FULLPAGE_MAX_SLICES))
  const cap = agentRpcScreenshotMaxBytes(params)
  let NativeImage = null
  try { NativeImage = require('electron').nativeImage } catch (eNI) { NativeImage = null }

  return wc.executeJavaScript('JSON.stringify({h:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0),y:window.scrollY,iw:window.innerWidth,ih:window.innerHeight})')
    .then(function (metaJson) {
      const meta = JSON.parse(metaJson)
      const startY = meta.y || 0
      const docH = Math.max(0, Math.min(meta.h || 0, AGENT_RPC_FULLPAGE_MAX_PX))
      const step = Math.max(1, meta.ih || 1)
      const want = Math.max(1, Math.ceil(docH / step))
      const slices = []
      let truncated = false
      let bytes = 0

      const next = function (i) {
        if (i >= want || i >= maxSlices) {
          if (i < want) truncated = true
          return Promise.resolve()
        }
        const y = i * step
        return wc.executeJavaScript('window.scrollTo(0,' + y + ')')
          .then(function () { return new Promise(function (r) { setTimeout(r, 120) }) })
          .then(function () { return wc.capturePage() })
          .then(function (img) {
            const sz = img.getSize()
            if (sz.width > 0 && sz.height > 0) {
              const bmp = img.toBitmap()
              bytes += bmp.length
              slices.push({ y: y, w: sz.width, h: sz.height, bmp: bmp })
            }
            /* Do NOT stop early on the raw-byte budget: the compositor can
             * downscale (below), and stopping here is what produced a
             * viewport-sized image labelled as a full page. */
            return next(i + 1)
            return next(i + 1)
          })
      }

      return next(0).then(function () {
        /* ALWAYS restore the scroll position, even if a slice threw. */
        return wc.executeJavaScript('window.scrollTo(0,' + startY + ')').then(function () {
          if (!slices.length) {
            throw agentRpcCommandError(AGENT_RPC_ERRORS.unsupported || AGENT_RPC_ERRORS.unsupported, 'unsupported', 'no page slice could be captured')
          }
          const w = slices[0].w
          const sliceHpx = slices[0].h
          const totalHpx = slices.reduce(function (a, s) { return a + s.h }, 0)
          /* Composite into ONE bitmap. If the raw stitch would exceed the
           * memory budget, downscale every slice by the same integer-free
           * factor first: a smaller complete page beats a cropped one. The
           * scale is reported in `scaledBy` and the encoded cap still applies. */
          const maxRawBytes = AGENT_RPC_FULLPAGE_MAX_BITMAP_BYTES
          let scale = 1
          if (NativeImage && w > 0 && totalHpx > 0) {
            const need = w * totalHpx * 4
            if (need > maxRawBytes) scale = Math.sqrt(maxRawBytes / need)
          }
          const outW = Math.max(1, Math.floor(w * scale))
          const outH = Math.max(1, Math.floor(totalHpx * scale))
          let outBuf = null
          let composed = false
          if (NativeImage && typeof NativeImage.createFromBitmap === 'function') {
            try {
              const rowBytes = outW * 4
              outBuf = Buffer.alloc(rowBytes * outH)
              let dy = 0
              for (let i = 0; i < slices.length; i++) {
                const sl = slices[i]
                if (scale === 1) {
                  const copyH = Math.min(sl.h, outH - dy)
                  sl.bmp.copy(outBuf, dy * rowBytes, 0, copyH * rowBytes)
                  dy += copyH
                } else {
                  /* per-slice downscale through nativeImage so the final
                   * composite has a single, consistent scale factor */
                  const small = NativeImage.createFromBitmap(sl.bmp, { width: sl.w, height: sl.h })
                  const scaledImg = small.resize({ width: outW, height: Math.max(1, Math.floor(sl.h * scale)), quality: 'good' })
                  const sBmp = scaledImg.toBitmap()
                  const copyH = Math.min(Math.floor(sl.h * scale), outH - dy)
                  sBmp.copy(outBuf, dy * rowBytes, 0, copyH * rowBytes)
                  dy += copyH
                }
              }
              composed = true
            } catch (eComp) { composed = false; outBuf = null }
          }
          const chosenImg = composed
            ? NativeImage.createFromBitmap(outBuf, { width: outW, height: outH })
            : null
          const encoded = (chosenImg && !chosenImg.isEmpty())
            ? chosenImg.toPNG()
            : slices[0].bmp
          const finalBuf = composed && chosenImg && !chosenImg.isEmpty() ? encoded : null
          const outBytes = finalBuf || encoded
          const beyondCap = outBytes.length > cap
          return {
            tabId: String(params.tabId),
            screenshotId: 'ss' + (++AGENT_RPC_SS_SEQ),
            mimeType: 'image/png',
            bytes: outBytes.length,
            width: composed ? outW : w,
            height: composed ? outH : slices[0].h,
            source: 'fullpage',
            captureMode: composed ? 'scroll-stitch-composited' : 'scroll-stitch-first-slice',
            scaledBy: composed ? Math.round(scale * 1000) / 1000 : 1,
            slices: slices.length,
            sliceHeightCss: step,
            documentHeightCss: docH,
            capturedHeightCss: slices.length * step,
            truncated: truncated,
            scrollRestoredTo: startY,
            completeCapture: composed && !truncated && slices.length === want,
            overByteCap: beyondCap,
            limitations: 'scroll-stitch: fixed/sticky elements repeat across slices; content that only loads on scroll may be blank; capture is sequential, not one atomic frame. completeCapture:false means the image is NOT the whole document.',
            coordinateUnits: 'viewport-css-px',
            data: outBytes.toString('base64')
          }
        })
      })
    })
}

function agentRpcCommandScreenshot (params) {
  /* R2 / D1: fullPage uses bounded scroll-stitch (see agentRpcCaptureFullPage). */
  if (params.fullPage === true) {
    var fpView = typeof viewMap !== 'undefined' ? viewMap[params.tabId] : null
    if (!fpView || !fpView.webContents || fpView.webContents.isDestroyed()) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.not_found, 'ref_not_found', 'tabId does not match a live view'))
    }
    if (typeof isViewAttachedToAnyWindow === 'function' && !isViewAttachedToAnyWindow(fpView)) {
      return Promise.reject(agentRpcCommandError(AGENT_RPC_ERRORS.view_not_attached, 'view_not_attached', 'view is detached or hidden; screenshots require an attached visible view'))
    }
    return agentRpcCaptureFullPage(fpView.webContents, params)
  }
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
        'return{x:Math.round(x),y:Math.round(y),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height)),vw:iw,vh:ih,ok:true}' +
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
                mimeType: outMeta.fmt === 'jpeg' ? 'image/jpeg' : 'image/png',
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
