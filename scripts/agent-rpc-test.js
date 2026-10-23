#!/usr/bin/env node
/*
 * P0-06 tests for main/agentRpc.js.
 *
 * Layer 1 - pure validation: the product file is loaded into a Node vm sandbox
 * with stubbed Electron globals, and its validators are called directly.
 * Layer 2 - live transport: the real http server from that same file is started
 * on 127.0.0.1:0 and driven with real loopback requests.
 *
 * No browser, no Electron, no Min launch, no instrumentation of Min. The stubs
 * exist only inside this process.
 *
 * Safety: no arguments, fixed argv, writes only under the OS temp dir.
 */

const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const TARGET = path.join(ROOT, 'main', 'agentRpc.js')
const TMP = path.join(os.tmpdir(), 'min-agent-rpc-test')

const results = []
function check (name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  [' + detail + ']'))
}

/* ---------- stubs ---------- */

function makeStubs () {
  fs.mkdirSync(TMP, { recursive: true })
  const userDataPath = path.join(TMP, 'profile')
  fs.mkdirSync(userDataPath, { recursive: true })

  const fakeWC = (id, url, title) => ({
    id,
    getURL: () => url,
    getTitle: () => title,
    isLoading: () => false,
    isCrashed: () => false,
    isDestroyed: () => false,
    isFocused: () => id === 101,
    /* P1-15/D1-F2: the stale-ref recovery path re-snapshots through this hook.
     * Default resolves to a minimal snapshot payload; tests override
     * `__scriptFn` to distinguish locate-mode from snapshot-mode replies. */
    executeJavaScript: function (src) {
      if (typeof this.__scriptFn === 'function') return Promise.resolve(this.__scriptFn(src))
      return Promise.resolve({ nodes: [], url: url, title: title, truncated: false })
    },
    sendInputEvent: function () {},
    insertText: function () {},
    on: function () {},
    once: function () {},
    removeListener: function () {}
  })

  const winA = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    getContentView: () => ({ children: [], removeChildView () {} })
  }
  const winB = {
    isDestroyed: () => false,
    isVisible: () => false,
    isFocused: () => false,
    getContentView: () => ({ children: [], removeChildView () {} })
  }

  const windows = {
    openWindows: [
      { id: '1', win: winA, state: { selectedView: 'tab-1', lastFocused: 2 } },
      { id: '2', win: winB, state: { selectedView: 'tab-2', lastFocused: 1 } }
    ],
    getCurrent: () => winA,
    getAll: () => [winA, winB],
    getState: w => windows.openWindows.find(o => o.win === w).state,
    windowFromContents: () => windows.openWindows[0]
  }

  const viewMap = {
    'tab-1': { webContents: fakeWC(101, 'https://example.com/', 'Example Domain') },
    'tab-2': { webContents: fakeWC(102, 'https://user:hunter2@secret.example.com/path?q=1', '  weird\u0000title ') },
    'tab-dead': { webContents: { id: 103, isDestroyed: () => true } }
  }

  const app = {
    name: 'Min',
    getVersion: () => '1.35.7',
    getPath: () => userDataPath,
    on: () => {}
  }

  const stubProcess = {
    argv: ['node', 'test'],
    platform: process.platform,
    arch: process.arch,
    /* Electron's own version strings do not exist in a plain Node process, so
     * they are stubbed with the values this project actually runs on. */
    versions: { electron: '43.4.1', chrome: '150.0.7871.124', node: process.versions.node },
    pid: 4242,
    uptime: () => 12.5,
    on: () => {}
  }

  return {
    userDataPath,
    app,
    windows,
    viewMap,
    settings: { get: k => (k === 'privateMode' ? false : undefined) },
    isDevelopmentMode: false,
    process: stubProcess
  }
}

function loadTarget () {
  const stubs = makeStubs()
  const code = fs.readFileSync(TARGET, 'utf8')
  /* Top-level const/let in a vm script are script-scoped, so hand the names we
   * need back out explicitly. Appended here only - the product file is untouched. */
  const exported = code + '\n;globalThis.__x = { agentRpcValidate, agentRpcState, agentRpcStartServer, agentRpcStopServer, agentRpcHostAllowed, agentRpcBrowserHeadersAllowed, agentRpcBearer, agentRpcConstantTimeEqual, agentRpcSafeUrl, agentRpcSafeText, AGENT_RPC_MAX_BODY_BYTES, AGENT_RPC_METHODS, AGENT_RPC_SNAPSHOT_BYTES, AGENT_RPC_SNAPSHOT_TIMEOUT, agentRpcValidateUrl, agentRpcScreenshotSizeOk, agentRpcPrefixMatchesUrl, agentRpcCommandBatch, agentRpcDispatch, agentRpcReResolveRef, agentRpcGrantsActive, agentRpcConsumeGrant, AGENT_RPC_COMMAND_HTTP_STATUS, AGENT_RPC_DISPATCH_TABLE: (typeof AGENT_RPC_DISPATCH_TABLE === "undefined" ? null : AGENT_RPC_DISPATCH_TABLE), AGENT_RPC_HELPER_CATALOGUE: (typeof AGENT_RPC_HELPER_CATALOGUE === "undefined" ? null : AGENT_RPC_HELPER_CATALOGUE), AGENT_RPC_HELPER_ALLOWED_TOOLS: (typeof AGENT_RPC_HELPER_ALLOWED_TOOLS === "undefined" ? null : AGENT_RPC_HELPER_ALLOWED_TOOLS), agentRpcJsonError, agentRpcCommandError, AGENT_RPC_ERRORS, agentRpcReadPolicy, agentRpcEffectiveProtocols, agentRpcCommandGrant, agentRpcPruneGrants, AGENT_RPC_RISKY_NAME, AGENT_RPC_ALLOWED_PROTOCOLS, agentRpcPolicyAllows: (typeof agentRpcPolicyAllows === "undefined" ? undefined : agentRpcPolicyAllows), agentRpcPolicyWouldAllow: (typeof agentRpcPolicyWouldAllow === "undefined" ? undefined : agentRpcPolicyWouldAllow), AGENT_RPC_ERRORS: (typeof AGENT_RPC_ERRORS === "undefined" ? null : AGENT_RPC_ERRORS), agentRpcCommandHelper, agentRpcCommandHelperList, AGENT_RPC_PARAM_SCHEMAS, AGENT_RPC_BATCH_EXCLUDED, AGENT_RPC_BATCH_MAX_STEPS, AGENT_RPC_GRANTS, AGENT_SNAPSHOT_REFS };\n'

  const sandbox = Object.assign({}, stubs, {
    require: m => require(m),
    /* A vm context has no Node globals at all, so hand over the ones the file uses. */
    Buffer: Buffer,
    URL: URL,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    console: { log: () => {}, warn: () => {}, error: () => {} }
  })
  vm.createContext(sandbox)
  vm.runInContext(exported, sandbox, { filename: TARGET })
  return { api: sandbox.__x, stubs }
}

/* ---------- layer 1: pure validation ---------- */

function baseMeta (over) {
  return Object.assign({
    method: 'POST',
    url: '/rpc',
    port: 41000,
    expectedToken: 'a'.repeat(64),
    headers: {
      host: '127.0.0.1:41000',
      authorization: 'Bearer ' + 'a'.repeat(64),
      'content-type': 'application/json'
    }
  }, over || {})
}

const GOOD_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'browser_status' })

function layer1 () {
  const { api } = loadTarget()
  const V = api.agentRpcValidate

  const ok = V(baseMeta(), GOOD_BODY)
  check('valid request accepted', ok.ok === true && ok.request.method === 'browser_status')

  check('GET rejected', V(baseMeta({ method: 'GET' }), '').httpStatus === 405)
  check('wrong path rejected', V(baseMeta({ url: '/' }), '').httpStatus === 404)
  check('path traversal rejected', V(baseMeta({ url: '/rpc/../etc/passwd' }), '').httpStatus === 404)

  check('missing Authorization rejected', V(baseMeta({ headers: { host: '127.0.0.1:41000', 'content-type': 'application/json' } }), GOOD_BODY).httpStatus === 401)
  check('wrong token rejected', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { authorization: 'Bearer ' + 'b'.repeat(64) }) }), GOOD_BODY).error.category === 'unauthorized')
  check('short token rejected (no timingSafeEqual throw)', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { authorization: 'Bearer short' }) }), GOOD_BODY).error.category === 'unauthorized')
  check('non-Bearer scheme rejected', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { authorization: 'Basic ' + 'a'.repeat(64) }) }), GOOD_BODY).httpStatus === 401)
  check('token is not echoed in error', JSON.stringify(V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { authorization: 'Bearer ' + 'b'.repeat(64) }) }), GOOD_BODY)).indexOf('b'.repeat(64)) === -1)

  check('mismatched Host rejected', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { host: 'evil.example:41000' }) }), GOOD_BODY).error.category === 'blocked')
  check('Host without port rejected', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { host: '127.0.0.1' }) }), GOOD_BODY).error.category === 'blocked')
  check('empty Host rejected', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { host: '' }) }), GOOD_BODY).error.category === 'blocked')
  check('DNS-rebinding style Host rejected', api.agentRpcHostAllowed('attacker.test:41000', 41000) === false)
  check('correct Host accepted', api.agentRpcHostAllowed('127.0.0.1:41000', 41000) === true)

  check('Origin header rejected', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { origin: 'http://evil.example' }) }), GOOD_BODY).error.category === 'blocked')
  check('Sec-Fetch-Site header rejected', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { 'sec-fetch-site': 'cross-site' }) }), GOOD_BODY).error.category === 'blocked')
  check('browser-header guard rejects cross-site', api.agentRpcBrowserHeadersAllowed({ 'sec-fetch-site': 'cross-site' }) === false)
  check('browser-header guard allows native client', api.agentRpcBrowserHeadersAllowed({}) === true)

  check('wrong content-type rejected', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { 'content-type': 'text/plain' }) }), GOOD_BODY).httpStatus === 415)
  check('content-type with charset accepted', V(baseMeta({ headers: Object.assign({}, baseMeta().headers, { 'content-type': 'application/json; charset=utf-8' }) }), GOOD_BODY).ok === true)

  check('malformed JSON rejected cleanly', V(baseMeta(), '{not json').error.category === 'invalid_request')
  check('empty body rejected cleanly', V(baseMeta(), '').error.category === 'invalid_request')
  check('JSON array envelope rejected', V(baseMeta(), '[]').error.category === 'invalid_request')
  check('JSON scalar envelope rejected', V(baseMeta(), '"x"').error.category === 'invalid_request')
  check('missing jsonrpc rejected', V(baseMeta(), JSON.stringify({ method: 'browser_status' })).error.category === 'invalid_request')
  check('wrong jsonrpc version rejected', V(baseMeta(), JSON.stringify({ jsonrpc: '1.0', method: 'browser_status' })).error.category === 'invalid_request')

  const unknown = V(baseMeta(), JSON.stringify({ jsonrpc: '2.0', method: 'browser_evalx' }))
  check('unknown method -> method_not_found', unknown.httpStatus === 404 && unknown.error.code === -32601)
  const unknown2 = V(baseMeta(), JSON.stringify({ jsonrpc: '2.0', method: 'executeJavaScript' }))
  /* camelCase never reaches the method set: the identifier pattern rejects it first. */
  check('injected method name rejected before dispatch', unknown2.httpStatus === 400 && unknown2.error.code === -32600)
  check('method set is closed (39 methods)', JSON.stringify(api.AGENT_RPC_METHODS.slice().sort()) === JSON.stringify(["browser_batch","browser_check","browser_click","browser_content","browser_download_cancel","browser_download_pause","browser_download_resume","browser_download_start","browser_download_wait","browser_downloads","browser_eval","browser_frames","browser_grant","browser_health","browser_helper","browser_helper_list","browser_hover","browser_mouse","browser_navigate","browser_pdf","browser_predict","browser_press","browser_screenshot","browser_scroll","browser_select","browser_snapshot","browser_state","browser_status","browser_tab_close","browser_tab_open","browser_tab_select","browser_tabs","browser_transform","browser_transform_status","browser_type","browser_upload","browser_verify","browser_viewport","browser_wait"]))
  check('method name pattern blocks traversal', V(baseMeta(), JSON.stringify({ jsonrpc: '2.0', method: '../../etc' })).error.category === 'invalid_request')

  check('params on a no-param command rejected', V(baseMeta(), JSON.stringify({ jsonrpc: '2.0', method: 'browser_status', params: { url: 'file:///etc/passwd' } })).error.category === 'invalid_params')
  check('params array rejected', V(baseMeta(), JSON.stringify({ jsonrpc: '2.0', method: 'browser_status', params: [] })).error.category === 'invalid_params')

  /* P0-09: browser_snapshot parameter schema. */
  var snapBody = function (params) { return JSON.stringify(Object.assign({ jsonrpc: '2.0', method: 'browser_snapshot' }, params ? { params: params } : {})) }
  check('snapshot without tabId rejected', (V(baseMeta(), snapBody(undefined)).error.data || {}).field === 'tabId')
  check('snapshot empty tabId rejected', V(baseMeta(), snapBody({ tabId: '' })).error.category === 'invalid_params')
  check('snapshot non-numeric tabId rejected', V(baseMeta(), snapBody({ tabId: 'abc(null)' })).error.category === 'invalid_params')
  check('snapshot tabId with injection chars rejected', V(baseMeta(), snapBody({ tabId: '1);process.exit(1)' })).error.category === 'invalid_params')
  check('snapshot valid numeric tabId accepted', V(baseMeta(), snapBody({ tabId: '123' })).ok === true)
  check('snapshot bad format rejected', V(baseMeta(), snapBody({ tabId: '123', format: 'html' })).error.category === 'invalid_params')
  check('snapshot format text accepted', V(baseMeta(), snapBody({ tabId: '123', format: 'text' })).ok === true)
  check('snapshot maxNodes 0 rejected', V(baseMeta(), snapBody({ tabId: '123', maxNodes: 0 })).error.category === 'invalid_params')
  check('snapshot maxNodes 1001 rejected', V(baseMeta(), snapBody({ tabId: '123', maxNodes: 1001 })).error.category === 'invalid_params')
  check('snapshot maxNodes NaN rejected', V(baseMeta(), snapBody({ tabId: '123', maxNodes: NaN })).error.category === 'invalid_params')
  check('snapshot maxNodes 500 accepted', V(baseMeta(), snapBody({ tabId: '123', maxNodes: 500 })).ok === true)
  check('snapshot unknown key rejected', (V(baseMeta(), snapBody({ tabId: '123', css: '#x' })).error.data || {}).field === 'css')
  /* P1-15/D1-F5: the handler implements a bounded settle delay but the schema
   * never declared it, and unknown keys are rejected - so it was unreachable. */
  check('D1-F5: snapshot schema declares waitMs', !!api.AGENT_RPC_PARAM_SCHEMAS.browser_snapshot.waitMs)
  check('D1-F5: snapshot waitMs accepted', V(baseMeta(), snapBody({ tabId: '123', waitMs: 250 })).ok === true)
  check('D1-F5: snapshot waitMs above the 5000ms bound rejected', V(baseMeta(), snapBody({ tabId: '123', waitMs: 6000 })).error.category === 'invalid_params')
  check('D1-F5: snapshot waitMs below 0 rejected', V(baseMeta(), snapBody({ tabId: '123', waitMs: -1 })).error.category === 'invalid_params')
  check('D1-F5: snapshot waitMs non-integer rejected', V(baseMeta(), snapBody({ tabId: '123', waitMs: 1.5 })).error.category === 'invalid_params')
  check('snapshot cap constant is 256 KiB', api.AGENT_RPC_SNAPSHOT_BYTES === 256 * 1024)

  /* P1-15/D1-F7: every category a command can emit must have an HTTP status.
   * A missing entry silently falls through to 500, which tells the client the
   * bridge crashed when it was in fact an expected structured outcome. */
  const emitted = new Set()
  const reCat = /agentRpcCommandError\(AGENT_RPC_ERRORS\.[a-z_]+,\s*'([a-z_]+)'/g
  let mCat
  while ((mCat = reCat.exec(fs.readFileSync(TARGET, 'utf8'))) !== null) emitted.add(mCat[1])
  /* Two eval categories come from a computed variable, not a literal. */
  emitted.add('eval_rejected')
  emitted.add('eval_exception')
  const unmapped = Array.from(emitted).filter(c => !api.AGENT_RPC_COMMAND_HTTP_STATUS[c])
  check('D1-F7: every emitted error category has an HTTP status mapping', unmapped.length === 0, unmapped.join(','))
  check('D1-F7: queue saturation maps to 429, not 500', api.AGENT_RPC_COMMAND_HTTP_STATUS.busy === 429)
  check('D1-F7: unknown downloadId maps to 404', api.AGENT_RPC_COMMAND_HTTP_STATUS.download_not_found === 404)
  check('D1-F7: a rejected page promise is distinguishable from a crash', api.AGENT_RPC_COMMAND_HTTP_STATUS.eval_rejected === 502 && api.AGENT_RPC_COMMAND_HTTP_STATUS.eval_exception === 502)

  /* P0-10: browser_click / browser_type schemas. */
  var clickBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_click', params: params }) }
  var typeBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_type', params: params }) }
  check('click without ref rejected', (V(baseMeta(), clickBody({ tabId: '123' })).error.data || {}).field === 'ref')
  check('click bad ref pattern rejected', V(baseMeta(), clickBody({ tabId: '123', ref: 'SELECT *' })).error.category === 'invalid_params')
  check('click valid ref accepted', V(baseMeta(), clickBody({ tabId: '123', ref: 'r1a' })).ok === true)
  check('click coordinate param rejected (no coordinates from requests)', V(baseMeta(), clickBody({ tabId: '123', ref: 'r1a', x: 5, y: 5 })).error.category === 'invalid_params')
  check('click css param rejected', V(baseMeta(), clickBody({ tabId: '123', ref: 'r1a', css: '#x' })).error.category === 'invalid_params')
  check('click js param rejected', V(baseMeta(), clickBody({ tabId: '123', ref: 'r1a', script: 'alert(1)' })).error.category === 'invalid_params')
  check('type missing text rejected', (V(baseMeta(), typeBody({ tabId: '123', ref: 'r1a' })).error.data || {}).field === 'text')
  check('type text over 1000 rejected', V(baseMeta(), typeBody({ tabId: '123', ref: 'r1a', text: 'x'.repeat(1001) })).error.category === 'invalid_params')
  check('type text with control chars rejected', V(baseMeta(), typeBody({ tabId: '123', ref: 'r1a', text: 'a' + String.fromCharCode(0) + 'b' })).error.category === 'invalid_params')
  check('type text with newline rejected', V(baseMeta(), typeBody({ tabId: '123', ref: 'r1a', text: 'a\nb' })).error.category === 'invalid_params')
  check('type valid text accepted', V(baseMeta(), typeBody({ tabId: '123', ref: 'r1a', text: 'hello world' })).ok === true)
  check('action timeout constant is 8s', api.AGENT_RPC_SNAPSHOT_TIMEOUT === 8000)

  /* P0-11: navigate URL policy. */
  var U = api.agentRpcValidateUrl
  check('url http accepted', U('http://example.com/').ok === true)
  check('url https accepted', U('https://example.com/').ok === true)
  check('url file accepted', U('file:///tmp/x.html').ok === true)
  check('url min accepted', U('min://app/newtab.html').ok === true)
  check('url about accepted', U('about:blank').ok === true)
  check('url javascript rejected', U('javascript:alert(1)').ok === false)
  check('url data rejected', U('data:text/html,<b>x</b>').ok === false)
  check('url vbscript rejected', U('vbscript:msgbox(1)').ok === false)
  check('url unknown scheme rejected', U('telnet://example.com/').ok === false)
  check('url not absolute rejected', U('example.com').ok === false)
  check('url with leading space rejected', U(' https://example.com/').ok === false)
  check('url with control char rejected', U('http://example.com/').ok === false)
  check('url over 2048 rejected', U('https://example.com/' + 'x'.repeat(2048)).ok === false)
  check('url non-string rejected', U(12345).ok === false)

  /* P0-11: press key enum + screenshot size. */
  var pressBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_press', params: params }) }
  check('press Enter accepted', V(baseMeta(), pressBody({ tabId: '1', key: 'Enter' })).ok === true)
  check('press ArrowDown accepted', V(baseMeta(), pressBody({ tabId: '1', key: 'ArrowDown' })).ok === true)
  check('press lowercase rejected', V(baseMeta(), pressBody({ tabId: '1', key: 'enter' })).error.category === 'invalid_params')
  check('press chord rejected', V(baseMeta(), pressBody({ tabId: '1', key: 'Meta+A' })).error.category === 'invalid_params')
  check('press F1 rejected', V(baseMeta(), pressBody({ tabId: '1', key: 'F1' })).error.category === 'invalid_params')
  check('press Space rejected', V(baseMeta(), pressBody({ tabId: '1', key: 'Space' })).error.category === 'invalid_params')

  /* P0-13: browser_grant schema. */
  var grantBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_grant', params: params }) }
  check('grant risky_click accepted (binds tab, 120s default)', V(baseMeta(), grantBody({ action: 'risky_click', tabId: '1' })).ok === true)
  check('grant sensitive_type with ref + ttl accepted', V(baseMeta(), grantBody({ action: 'sensitive_type', tabId: '1', ref: 'r1a', ttlSeconds: 30 })).ok === true)
  check('grant unknown action rejected', V(baseMeta(), grantBody({ action: 'anything_goes', tabId: '1' })).error.category === 'invalid_params')
  check('grant ttlSeconds 29 rejected', V(baseMeta(), grantBody({ action: 'risky_click', tabId: '1', ttlSeconds: 29 })).error.category === 'invalid_params')
  check('grant ttlSeconds 301 rejected', V(baseMeta(), grantBody({ action: 'risky_click', tabId: '1', ttlSeconds: 301 })).error.category === 'invalid_params')
  check('grant bad ref pattern rejected', V(baseMeta(), grantBody({ action: 'sensitive_type', tabId: '1', ref: 'XSS-REF' })).error.category === 'invalid_params')
  check('grant without tabId rejected', (V(baseMeta(), grantBody({ action: 'risky_click' })).error.data || {}).field === 'tabId')
  check('grant null ttlSeconds rejected as null param', V(baseMeta(), grantBody({ action: 'risky_click', tabId: '1', ttlSeconds: null })).error.category === 'invalid_params')

  /* P1-00 Stage A: tab management schemas. */
  var tabOpenBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_tab_open', params: params }) }
  var tabSelBody = function (tabId) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_tab_select', params: { tabId: tabId } }) }
  var tabCloseBody = function (tabId) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_tab_close', params: { tabId: tabId } }) }
  check('tab_open default accepted', V(baseMeta(), tabOpenBody({})).ok === true)
  check('tab_open with url accepted', V(baseMeta(), tabOpenBody({ url: 'https://example.com/' })).ok === true)
  check('tab_open background accepted', V(baseMeta(), tabOpenBody({ background: true })).ok === true)
  check('tab_open url over 2048 rejected', V(baseMeta(), tabOpenBody({ url: 'https://example.com/' + 'x'.repeat(2048) })).error.category === 'invalid_params')
  check('tab_open background non-bool rejected', V(baseMeta(), tabOpenBody({ background: 'yes' })).error.category === 'invalid_params')
  check('tab_open unknown key rejected', (V(baseMeta(), tabOpenBody({ ref: 'r1a' })).error.data || {}).field === 'ref')
  check('tab_select requires tabId', (V(baseMeta(), tabSelBody(undefined)).error.data || {}).field === 'tabId')
  check('tab_select bad tabId rejected', V(baseMeta(), tabSelBody('abc')).error.category === 'invalid_params')
  check('tab_close requires tabId', (V(baseMeta(), tabCloseBody(undefined)).error.data || {}).field === 'tabId')
  check('tab_close bad tabId rejected', V(baseMeta(), tabCloseBody('12;3')).error.category === 'invalid_params')
  var navBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_navigate', params: params }) }
  check('navigate without url rejected at schema', (V(baseMeta(), navBody({ tabId: '1' })).error.data || {}).field === 'url')
  check('navigate url over 2048 rejected at schema', V(baseMeta(), navBody({ tabId: '1', url: 'https://example.com/' + 'x'.repeat(2048) })).error.category === 'invalid_params')
  check('navigate valid url accepted at schema', V(baseMeta(), navBody({ tabId: '1', url: 'https://example.com/' })).ok === true)
  /* P1-01D: origin-safe expectUrlPrefix comparison (no lookalike hosts) */
  const PM = api.agentRpcPrefixMatchesUrl
  check('prefix: same-origin path prefix accepted', PM('https://example.com/static', 'https://example.com/static/page') === true)
  check('prefix: bare origin prefix accepted', PM('https://example.com', 'https://example.com/anything') === true)
  check('prefix: lookalike host rejected (example.com.evil)', PM('https://example.com', 'https://example.com.evil.com/page') === false)
  check('prefix: scheme downgrade rejected', PM('https://example.com/x', 'http://example.com/x') === false)
  check('prefix: different host rejected', PM('https://example.com/x', 'https://attacker.org/x') === false)
  check('prefix: path mismatch rejected', PM('https://example.com/static', 'https://example.com/other') === false)
  check('prefix: non-URL prefix not string-matched', PM('example.com/x', 'https://example.com/x') === false)
  /* P1-01E: browser_state schema (params object, no extra keys accepted) */
  const stateBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_state', params: params }) }
  check('browser_state valid params accepted', V(baseMeta(), stateBody({ tabId: '1' })).ok === true)
  check('browser_state unknown key rejected', V(baseMeta(), stateBody({ tabId: '1', verbose: true })).error.category === 'invalid_params')
  /* P1-02: browser_batch schema (actions = bounded JSON array string) */
  const batchBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_batch', params: params }) }
  check('batch valid actions accepted at schema', V(baseMeta(), batchBody({ tabId: '1', actions: '[{"tool":"browser_status"},{"tool":"browser_tabs"}]' })).ok === true)
  check('batch non-JSON string accepted at schema (JSON validity enforced per-command)', V(baseMeta(), batchBody({ tabId: '1', actions: 'not json' })).ok === true)
  check('batch array-typed actions rejected at schema (string required)', V(baseMeta(), batchBody({ tabId: '1', actions: [{ tool: 'browser_status' }] })).error.category === 'invalid_params')
  check('batch overflowing array accepted at schema (count enforced per-command)', (function () {
    const big = JSON.stringify(Array.from({ length: 21 }, () => ({ tool: 'browser_status' })))
    return V(baseMeta(), batchBody({ tabId: '1', actions: big })).ok === true
  })())

  /* P1-03: browser_state/predict/verify; P1-04: transform. JSON validity,
   * op enums, array lengths and style allowlists are enforced per-command
   * (the flat schema validator only checks the scalar shape). */
  const predictBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_predict', params: params }) }
  check('browser_predict valid params accepted', V(baseMeta(), predictBody({ tabId: '1', ref: 'r0', action: 'click' })).ok === true)
  check('browser_predict action enum rejected on garbage', V(baseMeta(), predictBody({ tabId: '1', ref: 'r0', action: 'explode' })).error.category === 'invalid_params')
  const verifyBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_verify', params: params }) }
  check('browser_verify url-only accepted', V(baseMeta(), verifyBody({ tabId: '1', urlPrefix: 'https://example.com/' })).ok === true)
  check('browser_verify combined checks accepted', V(baseMeta(), verifyBody({ tabId: '1', urlPrefix: 'https://example.com/', selector: 'h1', textContains: 'anything' })).ok === true)
  check('browser_verify oversize textContains rejected', V(baseMeta(), verifyBody({ tabId: '1', textContains: 'x'.repeat(201) })).error.category === 'invalid_params')
  const transformBody = function (params) { return JSON.stringify({ jsonrpc: '2.0', method: 'browser_transform', params: params }) }
  const tfActions = JSON.stringify([{ op: 'replace_text', ref: 'r0', text: 'hello' }])
  check('browser_transform valid actions accepted at schema', V(baseMeta(), transformBody({ tabId: '1', actions: tfActions })).ok === true)
  check('browser_transform array-typed actions rejected at schema (string required)', V(baseMeta(), transformBody({ tabId: '1', actions: [{ op: 'highlight', ref: 'r0' }] })).error.category === 'invalid_params')
  check('batch actions with control chars rejected', V(baseMeta(), batchBody({ tabId: '1', actions: '[{"tool":"browser_status"}]\nGARBAGE' })).error.category === 'invalid_params')
  /* P1-01B: stabilityWindowMs schema */
  check('navigate stabilityWindowMs accepted in range', V(baseMeta(), navBody({ tabId: '1', url: 'https://example.com/', stabilityWindowMs: 3000 })).ok === true)
  check('navigate stabilityWindowMs 0 accepted', V(baseMeta(), navBody({ tabId: '1', url: 'https://example.com/', stabilityWindowMs: 0 })).ok === true)
  check('navigate stabilityWindowMs over 15000 rejected', V(baseMeta(), navBody({ tabId: '1', url: 'https://example.com/', stabilityWindowMs: 15001 })).error.category === 'invalid_params')
  check('navigate stabilityWindowMs negative rejected', V(baseMeta(), navBody({ tabId: '1', url: 'https://example.com/', stabilityWindowMs: -1 })).error.category === 'invalid_params')
  check('navigate stabilityWindowMs non-integer rejected', V(baseMeta(), navBody({ tabId: '1', url: 'https://example.com/', stabilityWindowMs: 12.5 })).error.category === 'invalid_params')
  check('navigate stabilityWindowMs wrong type rejected', V(baseMeta(), navBody({ tabId: '1', url: 'https://example.com/', stabilityWindowMs: 'fast' })).error.category === 'invalid_params')
  check('bad id rejected', V(baseMeta(), JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'browser_status' })).error.category === 'invalid_request')

  check('constant-time compare equal', api.agentRpcConstantTimeEqual('a'.repeat(64), 'a'.repeat(64)) === true)
  check('constant-time compare unequal', api.agentRpcConstantTimeEqual('a'.repeat(64), 'b'.repeat(64)) === false)
  check('constant-time compare length mismatch safe', api.agentRpcConstantTimeEqual('a', 'a'.repeat(64)) === false)
  check('bearer parser extracts token', api.agentRpcBearer('Bearer ' + 'f'.repeat(64)) === 'f'.repeat(64))
  check('bearer parser rejects junk', api.agentRpcBearer('Bearer not-hex!') === null && api.agentRpcBearer(undefined) === null)

  check('url truncation applied', api.agentRpcSafeUrl('https://example.com/' + 'x'.repeat(500)).length <= 320)
  check('url userinfo stripped', api.agentRpcSafeUrl('https://user:pass@example.com/').indexOf('pass') === -1)
  check('url userinfo stripped when URL parse fails', api.agentRpcSafeUrl('https://user:pass@ex ample/').indexOf('pass') === -1)
  check('control chars stripped from title', api.agentRpcSafeText('a\u0000b\u001fc', 200) === 'a b c')
  check('title truncation applied', api.agentRpcSafeText('t'.repeat(500), 200).length <= 215)
  check('body limit constant is 64 KiB', api.AGENT_RPC_MAX_BODY_BYTES === 65536)
}

/* ---------- layer 2: live transport ---------- */

function rpc (port, opts, body) {
  return new Promise(function (resolve) {
    const req = http.request({
      host: opts.host || '127.0.0.1',
      port: port,
      path: opts.path || '/rpc',
      method: opts.method || 'POST',
      headers: opts.headers || { 'content-type': 'application/json', authorization: 'Bearer ' + 'a'.repeat(64), host: '127.0.0.1:' + port },
      headersTimeout: 5000,
      requestTimeout: 8000
    }, function (res) {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }))
    })
    req.on('error', e => resolve({ status: 0, error: e.code || e.message, body: '' }))
    req.setTimeout(9000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', body: '' }) })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function layer2 () {
  const { api, stubs } = loadTarget()
  api.agentRpcStartServer()

  await new Promise(resolve => {
    const t = setInterval(() => { if (api.agentRpcState.port) { clearInterval(t); resolve() } }, 100)
    setTimeout(() => { clearInterval(t); resolve() }, 5000)
  })

  const port = api.agentRpcState.port
  check('server bound to an ephemeral port', port > 0 && port < 65536, 'port=' + port)
  check('server bound to 127.0.0.1 only', api.agentRpcState.host === '127.0.0.1', api.agentRpcState.server && api.agentRpcState.server.address().address)

  /* The real server generated a random per-launch token. Read it the same way a
   * client would, so the live tests use it rather than a hard-coded value. */
  const discPath = path.join(stubs.userDataPath, 'agent-rpc.json')
  const discToken = JSON.parse(fs.readFileSync(discPath, 'utf8')).token
  check('per-launch token is random, not the test constant', discToken !== 'a'.repeat(64) && /^[0-9a-f]{64}$/.test(discToken))

  /* Non-loopback interface must refuse. */
  const lanIP = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)[0]
  if (lanIP) {
    const r = await rpc(port, { host: lanIP, headers: { host: lanIP + ':' + port, authorization: 'Bearer ' + 'a'.repeat(64), 'content-type': 'application/json' } }, GOOD_BODY)
    check('non-loopback interface refused', r.status === 0, lanIP + ' -> ' + r.error)
  } else {
    check('non-loopback interface refused', true, 'skipped: no non-loopback IPv4 interface')
  }

  const H = extra => Object.assign({ host: '127.0.0.1:' + port, authorization: 'Bearer ' + discToken, 'content-type': 'application/json' }, extra || {})

  const leaked = await rpc(port, { headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + 'a'.repeat(64), 'content-type': 'application/json' } }, GOOD_BODY)
  check('hard-coded token rejected by real server', leaked.status === 401, 'status=' + leaked.status)

  const st = await rpc(port, { headers: H() }, GOOD_BODY)
  check('browser_status over real HTTP -> 200', st.status === 200, 'status=' + st.status)
  let statusJson = null
  try { statusJson = JSON.parse(st.body) } catch (e) { /* reported below */ }
  check('browser_status is valid JSON-RPC result', !!(statusJson && statusJson.jsonrpc === '2.0' && statusJson.result), '')
  check('browser_status reports app/electron/chromium', !!(statusJson && statusJson.result.app.version === '1.35.7' && statusJson.result.app.electron && statusJson.result.app.chromium), statusJson && statusJson.result.app.electron)
  check('browser_status reports userData path', !!(statusJson && statusJson.result.profile.userDataPath === stubs.userDataPath))
  check('browser_status reports window/tab counts', !!(statusJson && statusJson.result.windows.count === 2 && statusJson.result.tabs.count === 2), statusJson && (statusJson.result.windows.count + '/' + statusJson.result.tabs.count))
  check('browser_status reports selected tab id', !!(statusJson && statusJson.result.windows.selectedTabId === 'tab-1'))
  check('browser_status reports no-CORS header', st.headers['access-control-allow-origin'] === undefined)
  check('browser_status sets no-store', st.headers['cache-control'] === 'no-store')
  check('token value absent from response', st.body.indexOf(discToken) === -1)
  check('response has no executable content-type', st.headers['content-type'] === 'application/json')

  const tb = await rpc(port, { headers: H() }, JSON.stringify({ jsonrpc: '2.0', id: 't1', method: 'browser_tabs' }))
  let tabsJson = null
  try { tabsJson = JSON.parse(tb.body) } catch (e) { /* below */ }
  check('browser_tabs over real HTTP -> 200', tb.status === 200)
  check('browser_tabs returns tab array', !!(tabsJson && Array.isArray(tabsJson.result.tabs) && tabsJson.result.tabs.length === 2), tabsJson && tabsJson.result.tabs.length)
  const t1 = tabsJson && tabsJson.result.tabs.find(t => t.tabId === 'tab-1')
  const t2 = tabsJson && tabsJson.result.tabs.find(t => t.tabId === 'tab-2')
  check('tab maps Min tabId -> webContentsId', !!(t1 && t1.webContentsId === 101))
  check('active flag reflects selectedView', !!(t1 && t1.active === true && t2 && t2.active === true))
  check('focused flag is per-webContents', !!(t1 && t1.focused === true && t2 && t2.focused === false))
  check('destroyed view excluded', !(tabsJson && tabsJson.result.tabs.find(t => t.tabId === 'tab-dead')))
  check('tab URL credentials redacted', !!(t2 && t2.url.indexOf('hunter2') === -1), t2 && t2.url)
  check('tab title sanitised', !!(t2 && t2.title === 'weird title'), t2 && JSON.stringify(t2 && t2.title))
  check('browser_tabs id echoed', !!(tabsJson && tabsJson.id === 't1'))

  const g = await rpc(port, { method: 'GET', headers: H() })
  check('GET /rpc rejected', g.status === 405, 'status=' + g.status)
  const root = await rpc(port, { path: '/', headers: H() }, GOOD_BODY)
  check('POST / rejected', root.status === 404, 'status=' + root.status)
  const noauth = await rpc(port, { headers: { host: '127.0.0.1:' + port, 'content-type': 'application/json' } }, GOOD_BODY)
  check('missing auth rejected', noauth.status === 401, 'status=' + noauth.status)
  const badauth = await rpc(port, { headers: H({ authorization: 'Bearer ' + 'd'.repeat(64) }) }, GOOD_BODY)
  check('invalid auth rejected', badauth.status === 401, 'status=' + badauth.status)
  check('invalid-auth response does not leak token', badauth.body.indexOf('d'.repeat(64)) === -1)
  const badhost = await rpc(port, { headers: H({ host: 'evil.example:' + port }) }, GOOD_BODY)
  check('Host tampering rejected', badhost.status === 403, 'status=' + badhost.status)
  const badorigin = await rpc(port, { headers: H({ origin: 'http://evil.example' }) }, GOOD_BODY)
  check('cross-site Origin rejected', badorigin.status === 403, 'status=' + badorigin.status)
  const badfetch = await rpc(port, { headers: H({ 'sec-fetch-site': 'cross-site' }) }, GOOD_BODY)
  check('cross-site Sec-Fetch-Site rejected', badfetch.status === 403, 'status=' + badfetch.status)
  const badct = await rpc(port, { headers: H({ 'content-type': 'text/plain' }) }, GOOD_BODY)
  check('wrong content-type rejected', badct.status === 415, 'status=' + badct.status)
  const badjson = await rpc(port, { headers: H() }, '{ broken')
  check('malformed JSON rejected cleanly', badjson.status === 400, 'status=' + badjson.status)
  const unknown = await rpc(port, { headers: H() }, JSON.stringify({ jsonrpc: '2.0', method: 'browser_evalx' }))
  check('unknown method -> 404 + -32601', unknown.status === 404 && JSON.parse(unknown.body).error.code === -32601)

  const big = await rpc(port, { headers: H() }, JSON.stringify({ jsonrpc: '2.0', method: 'browser_status', pad: 'z'.repeat(70 * 1024) }))
  check('oversize body rejected', big.status === 413 || big.status === 0, 'status=' + (big.status || big.error))

  /* Raw malformed request line -> clientError path. */
  const rawResult = await new Promise(function (resolve) {
    const net = require('net')
    const sock = net.connect(port, '127.0.0.1', function () { sock.write('GARBAGE\r\n\r\n') })
    let d = ''
    sock.on('data', c => { d += c })
    sock.on('close', () => resolve(d))
    sock.on('error', e => resolve('ERR:' + e.code))
    sock.setTimeout(5000, () => { sock.destroy(); resolve(d || 'timeout') })
  })
  check('raw malformed request answered 400', /400/.test(rawResult), rawResult.split('\r\n')[0])

  /* Rate limit: 21 rapid requests, expect at least one 429. */
  let got429 = false
  for (let i = 0; i < 60; i++) {
    const r = await rpc(port, { headers: H() }, GOOD_BODY)
    if (r.status === 429) { got429 = true; break }
  }
  check('rate limit engages (40/s cap)', got429)

  check('discovery file written', fs.existsSync(path.join(stubs.userDataPath, 'agent-rpc.json')))
  const disc = JSON.parse(fs.readFileSync(path.join(stubs.userDataPath, 'agent-rpc.json'), 'utf8'))
  check('discovery file has url/token/pid/version/launchedAt', !!(disc.url && disc.token && disc.pid && disc.version && disc.launchedAt))
  check('discovery file url is loopback', disc.url === 'http://127.0.0.1:' + port + '/rpc', disc.url)
  check('discovery token is 64 hex chars', /^[0-9a-f]{64}$/.test(disc.token), disc.token.length)
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(stubs.userDataPath, 'agent-rpc.json')).mode & 0o777
    check('discovery file mode 0600', mode === 0o600, mode.toString(8))
  } else {
    check('discovery file mode 0600', true, 'skipped on Windows (NTFS ACLs govern)')
  }

  api.agentRpcStopServer()
  check('discovery file removed on stop', !fs.existsSync(path.join(stubs.userDataPath, 'agent-rpc.json')))
  const after = await rpc(port, { headers: H() }, GOOD_BODY)
  check('server closed after stop', after.status === 0, after.error)
}

/* ---------- layer 3: D1 batch security boundary, stale-ref recovery, error map ---------- */

async function layer3 () {
  const { api, stubs } = loadTarget()
  api.agentRpcState.port = 41000
  api.agentRpcState.token = 'a'.repeat(64)
  /* The transport only accepts numeric tabIds; the shared stub keys views by
   * name. Alias one so grant/click paths can resolve a real view. */
  stubs.viewMap['1'] = stubs.viewMap['tab-1']
  /* agentRpcPruneGrants REASSIGNS AGENT_RPC_GRANTS, so a captured array
   * reference goes stale. Assert through the live-binding accessor instead. */
  const grants0 = api.agentRpcGrantsActive()

  /* --- D1-F1: excluded tools must NEVER execute, whatever stopOnError says --- */
  const r1 = await api.agentRpcCommandBatch({
    tabId: '1',
    stopOnError: false,
    actions: JSON.stringify([
      { tool: 'browser_grant', params: { tabId: '1', action: 'risky_click' } },
      { tool: 'browser_tabs', params: {} }
    ])
  })
  check('D1-F1: browser_grant inside a batch is refused', !!(r1.steps[0] && r1.steps[0].tool === 'browser_grant' && r1.steps[0].ok === false), JSON.stringify(r1.steps[0]))
  check('D1-F1: refused grant had NO side effect (no grant issued)', api.agentRpcGrantsActive() === grants0, api.agentRpcGrantsActive() + ' vs ' + grants0)
  check('D1-F1: no step returned a granted result', !r1.steps.some(s => s.result && s.result.granted === true), JSON.stringify(r1.steps.map(s => s.result)))
  check('D1-F1: stopOnError:false still runs later ALLOWED steps', r1.steps.length === 2 && !!(r1.steps[1] && r1.steps[1].ok === true), JSON.stringify(r1.steps.map(s => s.tool + ':' + s.ok)))

  const r1b = await api.agentRpcCommandBatch({
    tabId: '1',
    stopOnError: false,
    actions: JSON.stringify([{ tool: 'browser_batch', params: { tabId: '1', actions: '[]' } }])
  })
  check('D1-F1: nested browser_batch inside a batch is refused', !!(r1b.steps[0] && r1b.steps[0].tool === 'browser_batch' && r1b.steps[0].ok === false))

  /* --- D1-F1: a step the validator REJECTED must not reach dispatch either --- */
  const r2 = await api.agentRpcCommandBatch({
    tabId: '1',
    stopOnError: false,
    actions: JSON.stringify([
      { tool: 'browser_click', params: { tabId: '1' } },
      { tool: 'browser_tabs', params: {} }
    ])
  })
  check('D1-F1: schema-invalid step is rejected by the transport validator', !!(r2.steps[0] && r2.steps[0].error && r2.steps[0].error.category === 'invalid_params' && r2.steps[0].error.data && r2.steps[0].error.data.field === 'ref'), JSON.stringify(r2.steps[0] && r2.steps[0].error))
  check('D1-F1: rejected step never dispatched (invalid_params, not a runtime ref error)', !!(r2.steps[0] && r2.steps[0].error.category !== 'ref_not_found' && r2.steps[0].error.category !== 'ref_stale'))
  check('D1-F1: later allowed step still ran after the invalid one', r2.steps.length === 2 && !!(r2.steps[1] && r2.steps[1].ok === true))

  /* --- unchanged default behaviour --- */
  const r3 = await api.agentRpcCommandBatch({
    tabId: '1',
    actions: JSON.stringify([
      { tool: 'browser_grant', params: { tabId: '1', action: 'risky_click' } },
      { tool: 'browser_tabs', params: {} }
    ])
  })
  check('D1-F1: stopOnError:true still halts at the excluded step', r3.steps.length === 1 && r3.steps[0].ok === false, JSON.stringify(r3.steps.map(s => s.ok)))
  check('D1-F1: no grant issued with stopOnError:true either', api.agentRpcGrantsActive() === grants0, String(api.agentRpcGrantsActive()))
  /* A grant created by a batch would be spendable by a later risky click.
   * Prove the single-use grant mechanism still works through the normal path. */
  const gIssued = await api.agentRpcDispatch('browser_grant', { tabId: '1', action: 'risky_click', ttlSeconds: 30 })
  check('D1-F1: a directly-issued grant still works (control)', !!(gIssued && gIssued.granted === true && gIssued.grantsActive === 1), JSON.stringify(gIssued))
  check('D1-F1: that grant is consumable exactly once', api.agentRpcConsumeGrant('risky_click', '1') === true && api.agentRpcConsumeGrant('risky_click', '1') === false)

  /* --- D1-F4: the response must echo what the caller asked for --- */
  check('D1-F4: response echoes stopOnError:false', r1.stopOnError === false, String(r1.stopOnError))
  check('D1-F4: response echoes stopOnError:true', r3.stopOnError === true, String(r3.stopOnError))
  check('D1-F4: batch ok:false when a step failed under stopOnError:false', r1.ok === false)

  /* --- D1-F2: identity-strict stale-ref recovery --- */
  const wc1 = stubs.viewMap['1'].webContents
  const store = api.AGENT_SNAPSHOT_REFS
  const IDENTITY = { role: 'button', name: 'Continue', nameIndex: 0 }
  /* The page-side box uses w/h keys (not width/height) - see AGENT_SNAPSHOT_PAGE_FN. */
  const BOXED = { role: IDENTITY.role, name: IDENTITY.name, nameIndex: 0, box: { x: 0, y: 0, w: 40, h: 20 } }
  const seed = () => store.set('1', { born: Date.now(), refs: [{ ref: 'ra', role: IDENTITY.role, name: IDENTITY.name, nameIndex: 0, ordinal: 0, enumLen: 1 }], enumLen: 1 })
  let locateCalls = 0
  wc1.__scriptFn = function (src) {
    if (src.indexOf('"locate"') !== -1) {
      locateCalls++
      /* First locate: the element has vanished -> weak fallback finds zero
       * candidates -> ref_stale, with the original record STILL in the store. */
      if (locateCalls === 1) return { mode: 'locate', nodes: [], target: null, total: 1 }
      return { mode: 'locate', nodes: [BOXED], target: BOXED, total: 1 }
    }
    return { nodes: [{ role: IDENTITY.role, name: IDENTITY.name, nameIndex: 0, nameKind: 'text', box: { x: 0, y: 0, width: 10, height: 10 } }], url: 'https://example.com/', title: 'Example', truncated: false }
  }

  seed()
  const pending = api.agentRpcReResolveRef('1', 'ra')
  check('D1-F2: re-resolve returns a Promise (async; callers MUST await it)', !!(pending && typeof pending.then === 'function'))
  const reResolved = await pending
  check('D1-F2: re-resolve yields a STRING ref, never a Promise object', !!(reResolved && typeof reResolved.ref === 'string' && /^[0-9a-z]{1,13}$/.test(reResolved.ref)), JSON.stringify(reResolved))

  seed()
  locateCalls = 0
  const r4 = await api.agentRpcCommandBatch({
    tabId: '1',
    recoverStale: true,
    actions: JSON.stringify([{ tool: 'browser_click', params: { tabId: '1', ref: 'ra', verification: 'none' } }])
  })
  check('D1-F2: batch reports the original ref_stale', !!(r4.steps[0] && r4.steps[0].error && r4.steps[0].error.category === 'ref_stale'), JSON.stringify(r4.steps[0] && r4.steps[0].error))
  check('D1-F2: recovery actually retried the step', r4.steps.some(s => s.retried === true), JSON.stringify(r4.steps.map(s => (s.retried ? 'retry:' : 'first:') + (s.error ? s.error.category : 'ok'))))
  check('D1-F2: retry received a usable ref (no ref_stale_recovery_failed)', !r4.steps.some(s => s.error && s.error.category === 'ref_stale_recovery_failed'), JSON.stringify(r4.steps.map(s => s.error && s.error.category)))

  /* Ambiguous identity must fail loudly rather than pick one element. */
  seed()
  locateCalls = 0
  wc1.__scriptFn = function (src) {
    if (src.indexOf('"locate"') !== -1) {
      locateCalls++
      if (locateCalls === 1) return { mode: 'locate', nodes: [], target: null, total: 1 }
      return { mode: 'locate', nodes: [BOXED], target: BOXED, total: 1 }
    }
    /* Two elements share the identity -> must NOT be resolved to one of them. */
    return { nodes: [
      { role: IDENTITY.role, name: IDENTITY.name, nameIndex: 0, nameKind: 'text', box: { x: 0, y: 0, width: 10, height: 10 } },
      { role: IDENTITY.role, name: IDENTITY.name, nameIndex: 0, nameKind: 'text', box: { x: 0, y: 40, width: 10, height: 10 } }
    ], url: 'https://example.com/', title: 'Example', truncated: false }
  }
  const r5 = await api.agentRpcCommandBatch({
    tabId: '1',
    recoverStale: true,
    actions: JSON.stringify([{ tool: 'browser_click', params: { tabId: '1', ref: 'ra', verification: 'none' } }])
  })
  check('D1-F2: ambiguous identity fails loudly, never silently retargeted', r5.steps.some(s => s.error && s.error.category === 'ref_stale_recovery_failed'), JSON.stringify(r5.steps.map(s => s.error && s.error.category)))
  check('D1-F2: ambiguous recovery performed no click', !r5.steps.some(s => s.ok === true && s.retried === true))

  /* --- D2-A: the three stages must never be conflated --- */
  const DELIVERIES = ['attested', 'unverified', 'unsupported']
  const clickRes = r4.steps.filter(s => s.result).map(s => s.result)[0]
  check('D2-A: click result carries an explicit delivery stage', !!(clickRes && DELIVERIES.indexOf(clickRes.delivery) !== -1), JSON.stringify(clickRes && { delivered: clickRes.delivered, verified: clickRes.verified, delivery: clickRes.delivery }))
  check('D2-A: delivery is never ' + "'attested'" + ' when no renderer channel exists', !!(clickRes && clickRes.delivery === 'unsupported'), clickRes && clickRes.delivery)
  check('D2-A: delivery does NOT imply verified page effect', !!(clickRes && clickRes.delivery !== 'attested' || clickRes.verified !== true))
  check('D2-A: unattested delivery reports a reason', !!(clickRes && typeof clickRes.deliveryReason === 'string' && clickRes.deliveryReason.length > 10), clickRes && clickRes.deliveryReason)
}

/* ---------- layer 4: dispatch-routing characterization (ADR-11 seam) ----------
 * These tests are deliberately IMPLEMENTATION-AGNOSTIC: they assert the routing
 * CONTRACT (which method reaches which command handler, and that unknown methods
 * yield null) rather than the shape of the dispatcher. They must pass identically
 * before and after the if-chain is replaced by a data table, which is what makes
 * the extraction verifiable rather than merely plausible.
 *
 * Characterization for ADR-11: registry-as-data. Written BEFORE the code moved. */
async function layer4 () {
  const { api, stubs } = loadTarget()

  /* 1. the registry the dispatcher must agree with */
  const methods = api.AGENT_RPC_METHODS.slice().sort()
  check('D4/ADR-11: method registry is a non-empty sorted-able list of unique names', Array.isArray(api.AGENT_RPC_METHODS) && methods.length === api.AGENT_RPC_METHODS.length && new Set(methods).size === methods.length, String(api.AGENT_RPC_METHODS.length))
  check('D4/ADR-11: every registered method is a browser_* identifier', methods.every(m => /^browser_[a-z_]+$/.test(m)))

  /* 2. unknown methods are not routed (the transport rejects them first; the
   *    dispatcher's own fallthrough must still be null, not undefined/throw) */
  check('D4/ADR-11: unknown method dispatches to null', api.agentRpcDispatch('browser_not_a_tool', {}) === null)
  check('D4/ADR-11: prototype-ish name dispatches to null', api.agentRpcDispatch('constructor', {}) === null)

  /* 3. no-argument handlers must be callable without params and must not be
   *    routed with a params argument that changes their signature */
  const status = api.agentRpcDispatch('browser_status', {})
  check('D4/ADR-11: browser_status routes to a no-arg handler and returns a result', !!(status && typeof status === 'object' && status.bridge && status.app))
  const health = api.agentRpcDispatch('browser_health', {})
  check('D4/ADR-11: browser_health routes and returns an overall verdict', !!(health && ['healthy', 'degraded', 'unavailable'].indexOf(health.overall) !== -1))

  /* 4. every registered method must be ROUTABLE — i.e. the dispatcher knows it,
   *    even if the call itself fails later for want of a real view. This is the
   *    core anti-regression for a table that could silently drop a row. */
  const unrouted = []
  const throwsFor = {}
  for (const m of methods) {
    let out = null
    try {
      out = api.agentRpcDispatch(m, {})
      /* a handler returning a Promise is also "routed" */
      if (out !== null && out !== undefined) continue
    } catch (e) {
      throwsFor[m] = (e && e.category) || 'throw'
      continue
    }
    unrouted.push(m)
  }
  check('D4/ADR-11: every registered method is routed by the dispatcher', unrouted.length === 0, unrouted.join(','))
  check('D4/ADR-11: routing never silently returns undefined for a known method', unrouted.length === 0)

  /* 5. registry and dispatcher must stay in lockstep: a method in the registry
   *    with no route, or a route for an unregistered method, is the exact bug a
   *    data-table refactor can introduce. */
  check('D4/ADR-11: dispatch table keys equal the method registry', (function () {
    if (!api.AGENT_RPC_DISPATCH_TABLE) return true /* pre-extraction: chain has no table */
    const keys = Object.keys(api.AGENT_RPC_DISPATCH_TABLE).sort()
    return JSON.stringify(keys) === JSON.stringify(methods)
  })(), (function () {
    if (!api.AGENT_RPC_DISPATCH_TABLE) return 'no table yet (pre-extraction)'
    const keys = Object.keys(api.AGENT_RPC_DISPATCH_TABLE).sort()
    const missing = methods.filter(m => keys.indexOf(m) === -1)
    const extra = keys.filter(k => methods.indexOf(k) === -1)
    return 'missing=' + missing.join(',') + ' extra=' + extra.join(',')
  })())

  /* 6. a params-taking route must forward params (spot-check on a pure validator
   *    path: an invalid tabId must produce the same structured rejection whether
   *    reached through the chain or a table). */
  const badTab = api.agentRpcDispatch('browser_snapshot', { tabId: 'not-a-tab' })
  const badTabErr = await Promise.resolve(badTab).then(() => null, e => e)
  check('D4/ADR-11: params are forwarded to the handler (structured error shape preserved)', !!(badTabErr && badTabErr.agentRpcCommandError === true && typeof badTabErr.category === 'string'), badTabErr && badTabErr.category)
}

/* ---------- layer 5: ADR-09 Option C built-in catalogue (gates C1-C10) ----------
 * Deterministic/security assertions for the curated read-only built-ins. These
 * lock the boundary (allowlist, fixed IDs, no arbitrary tool names, no mutating
 * reachability) independently of any browser. */
async function layer5 () {
  const { api, stubs } = loadTarget()
  const CAT = api.AGENT_RPC_HELPER_CATALOGUE
  const ALLOW = api.AGENT_RPC_HELPER_ALLOWED_TOOLS
  stubs.viewMap['1'] = stubs.viewMap['tab-1']

  /* C1: only registered IDs exist, and the set is exactly the approved two */
  check('C1: catalogue is frozen', !!(CAT && Object.isFrozen(CAT)))
  check('C1: catalogue is exactly the approved two built-ins', JSON.stringify(Object.keys(CAT).sort()) === JSON.stringify(['form_control_inventory', 'page_summary']), Object.keys(CAT).join(','))
  check('C1: every built-in declares readOnly:true', Object.keys(CAT).every(k => CAT[k].readOnly === true))

  /* C2: fixed sequences, and no step may be outside the allowlist */
  check('C2: page_summary sequence is exactly [browser_state, browser_snapshot]', JSON.stringify(CAT.page_summary.steps) === JSON.stringify(['browser_state', 'browser_snapshot']), CAT.page_summary.steps.join('>'))
  check('C2: form_control_inventory sequence is exactly [browser_snapshot]', JSON.stringify(CAT.form_control_inventory.steps) === JSON.stringify(['browser_snapshot']), CAT.form_control_inventory.steps.join('>'))
  check('C2: definitions and step arrays are frozen', Object.isFrozen(CAT.page_summary) && Object.isFrozen(CAT.page_summary.steps) && Object.isFrozen(CAT.form_control_inventory.steps))
  check('C2: every catalogued step is on the allowlist', Object.keys(CAT).every(k => CAT[k].steps.every(s => ALLOW[s] === true)))

  /* C4: mutating / privileged tools are NOT reachable through the catalogue */
  const forbidden = ['browser_grant', 'browser_batch', 'browser_health', 'browser_eval', 'browser_click', 'browser_type', 'browser_press', 'browser_mouse', 'browser_scroll', 'browser_navigate', 'browser_transform', 'browser_viewport', 'browser_download_start', 'browser_screenshot', 'browser_pdf', 'browser_select', 'browser_check', 'browser_hover', 'browser_tab_open', 'browser_tab_close', 'browser_wait']
  const leaked = forbidden.filter(f => ALLOW[f] === true)
  check('C4: no mutating or privileged tool is on the allowlist', leaked.length === 0, leaked.join(','))
  check('C4: allowlist is exactly the audited six read-only tools', JSON.stringify(Object.keys(ALLOW).sort()) === JSON.stringify(['browser_content', 'browser_snapshot', 'browser_state', 'browser_status', 'browser_tabs', 'browser_verify']), Object.keys(ALLOW).sort().join(','))

  /* C1b: unknown / tampered IDs are rejected at the boundary */
  const unknown = await api.agentRpcCommandHelper({ helper: 'browser_grant', tabId: '1' }).then(() => null, e => e)
  check('C1: an unknown/tampered helper id is refused', !!(unknown && unknown.agentRpcCommandError === true && unknown.category === 'not_found'), unknown && unknown.category)
  const inherited = await api.agentRpcCommandHelper({ helper: 'constructor', tabId: '1' }).then(() => null, e => e)
  check('C1: a prototype-ish helper id is refused (own-property lookup)', !!(inherited && inherited.category === 'not_found'), inherited && inherited.category)
  const badVer = await api.agentRpcCommandHelper({ helper: 'page_summary', tabId: '1', version: 9 }).then(() => null, e => e)
  check('C2: a mismatched definition version is refused', !!(badVer && badVer.category === 'invalid_params'), badVer && badVer.category)

  /* C3: argument bounds are enforced by the transport schema */
  const base = { host: '127.0.0.1:41000', authorization: 'Bearer ' + 'a'.repeat(64), 'content-type': 'application/json' }
  const V = body => api.agentRpcValidate({ method: 'POST', url: '/rpc', headers: base, port: 41000, expectedToken: 'a'.repeat(64) }, JSON.stringify(body))
  const hb = p => ({ jsonrpc: '2.0', method: 'browser_helper', params: p })
  check('C3: helper id is required', (V(hb({ tabId: '1' })).error.data || {}).field === 'helper')
  check('C3: tabId is required (no implicit current tab)', (V(hb({ helper: 'page_summary' })).error.data || {}).field === 'tabId')
  check('C3: maxNodes above 200 refused', V(hb({ helper: 'page_summary', tabId: '1', maxNodes: 201 })).error.category === 'invalid_params')
  check('C3: limit above 60 refused', V(hb({ helper: 'form_control_inventory', tabId: '1', limit: 61 })).error.category === 'invalid_params')
  check('C3: unknown parameter refused (no step injection)', (V(hb({ helper: 'page_summary', tabId: '1', steps: ['browser_grant'] })).error.data || {}).field === 'steps')
  check('C3: valid helper request accepted', V(hb({ helper: 'page_summary', tabId: '1' })).ok === true)

  /* C4b: helper is a registered dispatch route and behaves for a dead tab */
  check('C4: browser_helper + browser_helper_list are registered methods', api.AGENT_RPC_METHODS.indexOf('browser_helper') !== -1 && api.AGENT_RPC_METHODS.indexOf('browser_helper_list') !== -1)
  /* --- readonly gate (post-Option-C): tri-state, never a default false --- */
  const src = fs.readFileSync(TARGET, 'utf8')
  check('RO-1: snapshot base node initialises readOnly to null (unknown), not false', /disabled: false, readOnly: null/.test(src))
  check('RO-2: snapshot result copy preserves tri-state (no === true coercion to false)', src.indexOf('readOnly: (n.readOnly === true || n.readOnly === false) ? n.readOnly : null') !== -1)
  check('RO-3: helper projections preserve tri-state too', (src.match(/readOnly: \(n\.readOnly === true \|\| n\.readOnly === false\) \? n\.readOnly : null/g) || []).length >= 2)
  check('RO-4: page fn marks readOnly unknown when the DOM does not establish it', src.indexOf("node.readOnly = ar === 'true' ? true : (ar === 'false' ? false : null)") !== -1)
  check('RO-5: locate mode records an authoritative live readOnly for the action guard', src.indexOf('targetNode.readOnlyLive = liveReadOnly') !== -1)
  check('RO-6: the type guard prefers the LIVE value over the cached snapshot flag', src.indexOf('if (t.readOnlyLive === true || (t.readOnlyLive === null && t.readOnly === true))') !== -1)
  check('RO-8: the snapshot-mode node whitelist carries readOnly (the B4 loss point)', src.indexOf('valueLength: n.valueLength, readOnly: n.readOnly') !== -1)
  check('RO-7: readOnly never trusts page text as authorization (property read only)', !/readOnly\s*=\s*[^;\n]*innerText/.test(src))
  const list = api.agentRpcCommandHelperList()
  check('C1: helper_list returns the two ids and the six-tool allowlist', !!(list && list.helpers.length === 2 && list.allowlist.length === 6), JSON.stringify(list && list.helpers.map(h => h.id)))
  const deadRes = await api.agentRpcCommandHelper({ helper: 'page_summary', tabId: 'tab-dead' }).then(r => ({ ok: true, r: r }), e => ({ ok: false, e: e }))
  const deadObj = deadRes.ok ? (deadRes.r && deadRes.r.obj) : null
  check('C9: a dead/missing tab yields a structured error or an explicit unavailable status (never fabricated success)',
    !!(deadRes.ok ? (deadObj && deadObj.status === 'unavailable') : (deadRes.e && deadRes.e.agentRpcCommandError === true)),
    deadRes.ok ? ('status=' + (deadObj && deadObj.status)) : ('error=' + (deadRes.e && deadRes.e.category)))
  check('C9: a dead-tab result never claims status=complete', !(deadObj && deadObj.status === 'complete'))
}

/* ---------- layer 6: ADR-11 seam 2 — error-contract matrix ----------
 * Table-driven, one EXPLICITLY NAMED case per contract so a failure names the
 * exact contract that broke. Asserts: stable category+code, HTTP mapping where
 * the error is top-level, safe message shape, and no secret leakage. */
function layer6 () {
  const { api } = loadTarget()
  const MAP = api.AGENT_RPC_COMMAND_HTTP_STATUS
  const ERR = api.AGENT_RPC_ERRORS

  /* every top-level category an agentRpcCommandError can emit must map */
  const src = fs.readFileSync(TARGET, 'utf8')
  const emitted = new Set([...src.matchAll(/agentRpcCommandError\(AGENT_RPC_ERRORS\.[a-z_]+, *'([a-z_]+)'/g)].map(m => m[1]))
  emitted.add('eval_rejected'); emitted.add('eval_exception')
  const unmapped = [...emitted].filter(c => !MAP[c])
  check('SEAM2: every top-level emitted category has an HTTP status', unmapped.length === 0, unmapped.join(','))

  /* error families the task enumerates: category -> expected stable code + status */
  const CASES = [
    ['unknown method/tool', 'not_found', ERR.not_found, 404],
    ['schema-invalid args', 'invalid_params', ERR.invalid_params, 400],
    /* VALIDATION-layer error: carries httpStatus directly, never via the command map */
    ['authentication failure (validation layer)', 'unauthorized', ERR.unauthorized, 'validation-401'],
    ['origin/host rejection', 'blocked', ERR.blocked, 403],
    ['grant missing (risky action)', 'risky_action', ERR.risky_action, 403],
    ['sensitive field (grant missing)', 'sensitive_field', ERR.sensitive_field, 403],
    ['disabled target', 'disabled', ERR.disabled, 409],
    ['readonly target', 'readonly', ERR.disabled, 409],
    ['stale reference', 'ref_stale', ERR.ref_stale, 404],
    ['stale-ref recovery failure (nested)', 'ref_stale_recovery_failed', null, null],
    ['ambiguous target', 'ambiguous', ERR.ambiguous, 409],
    ['ref from another tab', 'ref_mismatch', ERR.ref_mismatch, 404],
    ['tab not found', 'not_found', ERR.not_found, 404],
    ['view not attached', 'view_not_attached', ERR.view_not_attached, 409],
    ['last tab close guard', 'last_tab', ERR.last_tab, 409],
    ['unsupported action', 'unsupported', ERR.unsupported, 500],
    ['verification failure (nested)', 'verification_failed', null, null],
    ['transform target failure (nested)', 'transform_target_failed', null, null],
    ['queue saturation', 'busy', ERR.busy, 429],
    ['screenshot size limit', 'screenshot_too_large', ERR.screenshot_too_large, 413],
    ['navigation load failure', 'load_failed', ERR.load_failed, 502],
    ['eval rejection (page promise)', 'eval_rejected', ERR.timeout, 502],
    ['captcha handoff', 'captcha_handoff_required', ERR.captcha_handoff_required, 409],
    ['download not found', 'download_not_found', ERR.not_found, 404]
  ]
  CASES.forEach(function (c) {
    const name = c[0]; const cat = c[1]; const code = c[2]; const status = c[3]
    if (status === 'validation-401') {
      /* unauthorized is produced by agentRpcValidate with an explicit 401; it is
       * deliberately NOT in the command map (commands never emit it). */
      check('SEAM2: ' + name + ' is a validation-layer 401, not a command category', code === ERR.unauthorized && MAP[cat] === undefined, 'map=' + String(MAP[cat]))
      return
    }
    if (status === null) {
      /* nested step/target category: must NOT be required to map, and must not
       * collide with a transport status (it is payload, not an HTTP outcome). */
      check('SEAM2 n/a: ' + name + ' is a nested result category (no HTTP status)', MAP[cat] === undefined, cat + ' mapped=' + String(MAP[cat]))
      return
    }
    check('SEAM2: ' + name + ' -> ' + cat + ' (' + code + ') maps to HTTP ' + status, MAP[cat] === status && code !== undefined, 'status=' + String(MAP[cat]))
  })

  /* constructors produce a stable, safe shape */
  const e1 = api.agentRpcJsonError(-32016, 'ref_stale', 'fixed message')
  check('SEAM2: json error shape is {code,category,message,data}', e1.code === -32016 && e1.category === 'ref_stale' && e1.message === 'fixed message' && e1.data === null && Object.keys(e1).length === 4)
  const e2 = api.agentRpcCommandError(-32016, 'ref_stale', 'fixed message')
  check('SEAM2: command error carries the agentRpcCommandError discriminator', e2.agentRpcCommandError === true && e2.code === -32016)
  check('SEAM2: command error data is null by default (no page payload attached)', e2.data === null)

  /* messages never interpolate page content or secrets */
  const badMsg = /message:\\s*'(?:[^'\\\\]|\\\\.)*'\\s*\\+\\s*(?:.*pageRes|.*textContent|.*innerText|.*\\.value\\b|.*token)/
  check('SEAM2: no error message interpolates page content, values or the token', !badMsg.test(src))

  /* codes are unique and in the -320xx/JSON-RPC ranges */
  const vals = Object.keys(ERR).map(k => ERR[k])
  check('SEAM2: error codes are unique', new Set(vals).size === vals.length)
  check('SEAM2: every error code is a negative JSON-RPC-style integer', vals.every(v => typeof v === 'number' && v < 0 && Number.isInteger(v)))
}

/* ---------- layer 7: ADR-11 seam 3 — policy boundary ----------
 * Characterization for the policy seam: grants, risky/sensitive policy and
 * policy.json. Written BEFORE the extraction and expected to pass identically
 * before and after, so the extraction is verifiable rather than plausible. */
function layer7 () {
  const { api, stubs } = loadTarget()
  stubs.viewMap['1'] = stubs.viewMap['tab-1']

  /* policy.json is the durable per-profile default; both flags default to FALSE */
  const pol = api.agentRpcReadPolicy()
  check('SEAM3: readPolicy returns the documented shape', !!(pol && typeof pol.allowRiskyClicks === 'boolean' && typeof pol.allowSensitiveTyping === 'boolean' && 'allowedSchemes' in pol))
  check('SEAM3: risky clicks default to DENIED', pol.allowRiskyClicks === false)
  check('SEAM3: sensitive typing defaults to DENIED', pol.allowSensitiveTyping === false)

  /* policies can only RESTRICT the built-in scheme set */
  const eff = api.agentRpcEffectiveProtocols()
  check('SEAM3: default effective schemes are the built-in allowlist', !!(eff && eff['https:'] === 1 && eff['http:'] === 1))
  check('SEAM3: dangerous schemes are never present', !eff['javascript:'] && !eff['data:'] && !eff['vbscript:'])

  /* grants: single-use, action+tab bound, TTL'd */
  const g1 = api.agentRpcCommandGrant({ tabId: '1', action: 'risky_click', ttlSeconds: 30 })
  check('SEAM3: grant issues for a live tab', !!(g1 && g1.granted === true && g1.grantsActive === 1), JSON.stringify(g1 && { g: g1.granted, n: g1.grantsActive }))
  check('SEAM3: grant is single-use (second consume fails)', api.agentRpcConsumeGrant('risky_click', '1') === true && api.agentRpcConsumeGrant('risky_click', '1') === false)
  api.agentRpcCommandGrant({ tabId: '1', action: 'sensitive_type', ttlSeconds: 30 })
  check('SEAM3: a grant for one action does not satisfy another', api.agentRpcConsumeGrant('risky_click', '1') === false)
  check('SEAM3: grants are bound to the exact tab', api.agentRpcConsumeGrant('sensitive_type', '2') === false)
  const gDead = api.agentRpcCommandGrant({ tabId: 'tab-dead', action: 'risky_click', ttlSeconds: 30 })
  /* agentRpcCommandGrant RETURNS the structured error (it does not throw) */
  check('SEAM3: grant refused for a non-live tab', !!(gDead && gDead.agentRpcCommandError === true && gDead.category === 'ref_not_found'), gDead && gDead.category)

  /* the evaluator must be addressable as a unit (the seam's stated purpose) */
  if (typeof api.agentRpcPolicyAllows === 'function') {
    check('SEAM3: a single policy evaluator exists and denies by default', api.agentRpcPolicyAllows('risky_click', { tabId: '1' }) === false)
    api.agentRpcCommandGrant({ tabId: '1', action: 'risky_click', ttlSeconds: 30 })
  /* Contract split (important for single-use grants):
   *   agentRpcPolicyAllows    -> policy FLAG only (no grant look-up)
   *   agentRpcPolicyWouldAllow -> flag OR live grant, WITHOUT consuming
   * The handlers call the flag evaluator and then consume the grant themselves,
   * which is what keeps a grant one-shot. */
  check('SEAM3: the flag evaluator ignores grants (policy only)', api.agentRpcPolicyAllows('risky_click', { tabId: '1' }) === false)
  const beforePeek = api.agentRpcGrantsActive()
  check('SEAM3: the dry-run evaluator honours a live grant', api.agentRpcPolicyWouldAllow('risky_click', { tabId: '1' }) === true)
  check('SEAM3: the dry-run evaluator does not consume the grant', api.agentRpcPolicyWouldAllow('risky_click', { tabId: '1' }) === true && api.agentRpcGrantsActive() === beforePeek, beforePeek + ' -> ' + api.agentRpcGrantsActive())
  check('SEAM3: the dry-run evaluator denies an unknown action', api.agentRpcPolicyWouldAllow('not_an_action', { tabId: '1' }) === false)
  } else {
    check('SEAM3: a single policy evaluator exists (ADR-11 seam-3 purpose)', false, 'agentRpcPolicyAllows not present')
  }

  /* risky-name policy is a bridge-side predicate on the accessible name */
  check('SEAM3: risky-name regex matches purchase/payment wording', api.AGENT_RPC_RISKY_NAME.test('place order') && api.AGENT_RPC_RISKY_NAME.test('buy now'))
  check('SEAM3: risky-name regex ignores ordinary wording', !api.AGENT_RPC_RISKY_NAME.test('read more') && !api.AGENT_RPC_RISKY_NAME.test('sign in'))

  /* policy must not be reachable through the dispatch table */
  check('SEAM3: no policy function is exposed as a dispatchable method', ['agentRpcReadPolicy', 'agentRpcConsumeGrant', 'agentRpcPolicyAllows'].every(f => api.AGENT_RPC_METHODS.indexOf(f) === -1))
}

async function main () {
  layer1()
  await layer2()
  await layer3()
  await layer4()
    await layer5()
    layer6()
    layer7()
    const passed = results.filter(r => r.pass).length
  console.log('\n' + passed + '/' + results.length + ' checks passed')
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  return results.every(r => r.pass) ? 0 : 1
}

main().then(c => process.exit(c)).catch(e => {
  console.error('test harness error: ' + e.message)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (ignored) {}
  process.exit(2)
})
