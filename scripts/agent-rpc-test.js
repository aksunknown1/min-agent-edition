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
    isFocused: () => id === 101
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
  const exported = code + '\n;globalThis.__x = { agentRpcValidate, agentRpcState, agentRpcStartServer, agentRpcStopServer, agentRpcHostAllowed, agentRpcBrowserHeadersAllowed, agentRpcBearer, agentRpcConstantTimeEqual, agentRpcSafeUrl, agentRpcSafeText, AGENT_RPC_MAX_BODY_BYTES, AGENT_RPC_METHODS, AGENT_RPC_SNAPSHOT_BYTES, AGENT_RPC_SNAPSHOT_TIMEOUT, agentRpcValidateUrl, agentRpcScreenshotSizeOk, agentRpcPrefixMatchesUrl };\n'

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

  const unknown = V(baseMeta(), JSON.stringify({ jsonrpc: '2.0', method: 'browser_eval' }))
  check('unknown method -> method_not_found', unknown.httpStatus === 404 && unknown.error.code === -32601)
  const unknown2 = V(baseMeta(), JSON.stringify({ jsonrpc: '2.0', method: 'executeJavaScript' }))
  /* camelCase never reaches the method set: the identifier pattern rejects it first. */
  check('injected method name rejected before dispatch', unknown2.httpStatus === 400 && unknown2.error.code === -32600)
  check('method set is closed (31 methods)', JSON.stringify(api.AGENT_RPC_METHODS.slice().sort()) === JSON.stringify(["browser_batch","browser_check","browser_click","browser_content","browser_download_cancel","browser_download_pause","browser_download_resume","browser_download_start","browser_download_wait","browser_downloads","browser_grant","browser_hover","browser_mouse","browser_navigate","browser_predict","browser_press","browser_screenshot","browser_scroll","browser_select","browser_snapshot","browser_state","browser_status","browser_tab_close","browser_tab_open","browser_tab_select","browser_tabs","browser_transform","browser_transform_status","browser_type","browser_verify","browser_wait"]))
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
  check('snapshot cap constant is 256 KiB', api.AGENT_RPC_SNAPSHOT_BYTES === 256 * 1024)

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
  const unknown = await rpc(port, { headers: H() }, JSON.stringify({ jsonrpc: '2.0', method: 'browser_eval' }))
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

async function main () {
  layer1()
  await layer2()
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
