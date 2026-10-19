# Phase 1 design — agent-control bridge

Status: **design only. Nothing here is implemented.** No bridge, no new dependency, no product behaviour change.

Goal: let a local agent drive a real Min window through a small, named, validated command surface — status, tabs, navigate, snapshot, click, type, press, screenshot — using primitives Min already has.

Non-goals for Phase 1: extension manager UI, multi-agent sessions, remote access, CDP passthrough, arbitrary script execution, file/URL exfiltration, blocker changes.

---

## 1. What already exists (reuse, don't rebuild)

Verified against this tree. These are the hooks the bridge would sit on.

| Concern | Existing code | Notes |
|---|---|---|
| Window creation | `main/main.js:157` `createWindow()`, `main/main.js:192` `createWindowWithBounds()` | `mainView` is a `WebContentsView` (`main/main.js:214`), not a `<webview>` |
| Window registry | `main/windowManagement.js:5` `windowFromContents()`, `:54` `getAll()` | already used by `main/main.js:461` |
| Tab view registry | `main/viewManager.js:1` `viewMap` (id → view), `:314` `getView(id)`, **`:468` `global.getView = getView`** | `getView` is already a main-process global — the bridge can resolve a tab id to a live `WebContentsView` without new plumbing |
| id ↔ webContents | `main/viewManager.js:318` `getTabIDFromWebContents(contents)` | reverse mapping already exists |
| Navigate | `main/viewManager.js:366` `loadURLInView(id, url, win)`, IPC `:382` | single funnel for URL loads |
| Focus / select | `main/viewManager.js:290` `focusView(id)`, `:267` `setView()`, IPC `:358`, `:343` | |
| Tab data model | `js/tabState/tab.js` `TabList` — `:87` `get(id)`, `:117` `getSelected()`, `:126` `getSelectedIndex()` | fields: `url,title,id,secure,private,selected,loaded,muted,hasAudio,previewImage,scrollPosition,…`; `temporaryProperties` at `:9` |
| Tab state in main | `main/main.js:461` `ipc.on('tab-state-change')`, `:477` `ipc.on('request-tab-state')` | main already receives per-window tab state events |
| Navigation history | `main/viewManager.js:421` `ipc.handle('getNavigationHistory')` | returns `{activeIndex, entries}` — reuse for `browser_status` |
| Screenshot | `main/viewManager.js:440` `ipc.on('getCapture')` → `view.webContents.capturePage()` → `img.toDataURL()`; `:457` `saveViewCapture` | `capturePage()` is already the product's screenshot primitive |
| Hidden-view caveat | `js/webviews.js:19` comment: *"capturePage doesn't work while the view is hidden"* | hard constraint on background mode (§10) |
| Session / partition | `main/main.js:60` `app.setPath('userData', …)` (dev mode appends `-development`); tab views use `persist:webcontent` | see §10 |
| Settings persistence | `js/util/settings/settingsMain.js` — atomic write, `privateMode` forces `persist:incognito` | reuse for the bridge's own settings |
| Permission gating | `main/permissionManager.js` | existing gate for geolocation/media/etc. |
| Existing generic RPC (do **not** reuse) | `main/viewManager.js:387` `ipc.on('callViewMethod')` | see §3 |

**Correction to the task brief:** there is no `js/store` in this tree. Tab data lives in `js/tabState/tab.js` (`TabList`) and `js/tabState/task.js` (tasks), synchronised across windows by `js/tabState/windowSync.js`, with the main-process mirror at `main/main.js:461`.

---

## 2. Transport

**Plain Node `http`, not Express.** `http` is already in the runtime; Express would be a new dependency for one POST route, and every added dependency is one more thing audited for network exposure. One route, one content type.

```
POST http://127.0.0.1:<ephemeral>/rpc     Content-Type: application/json
```

- Bind address is the literal string `127.0.0.1`. Never `0.0.0.0`, never `::`, never `localhost` (which can resolve to `::1` or be rebound).
- Port `0` → OS-assigned ephemeral port. No fixed port: fixed ports collide and are scannable.
- No TLS: loopback only, no credentials cross the machine boundary. Documented as a threat-model assumption.
- The server starts only when the bridge is explicitly enabled, and stops on `app.on('before-quit')`.
- Body cap **64 KiB**; `Content-Type` must be exactly `application/json`; anything else → `415`. Unknown paths → `404` with no routing information leaked.
- One command in flight per tab id; a second command for the same tab → `409 busy`. Global concurrency cap of 2.
- Rate limit: 20 requests/second, then `429`.

### Discovery file

On start, write `<userData>/agent-rpc.json`:

```json
{ "v": 1, "port": 53377, "token": "<hex>", "pid": 12345, "startedAt": "ISO-8601" }
```

Deleted on shutdown and on unclean exit (`process.on('exit')`). Consumers read it; nothing about it is ever printed to stdout or written to a log. On Windows the file inherits the user profile ACL — acceptable for a per-launch secret in the user's own profile, and stated rather than assumed strong.

---

## 3. Authentication and the hard prohibitions

**Token.** `crypto.randomBytes(32).toString('hex')` per launch. Required header: `Authorization: Bearer <token>`. Compared with `crypto.timingSafeEqual` on the raw bytes; length mismatch → reject before compare. Missing/wrong token → `401` with a generic body.

**No secret in logs.** The token never appears in any `console.log`, error message, evidence file, or crash report. The discovery file is the only place it exists. Request logging (if any) records method name, outcome, and latency — never headers or bodies.

**CSRF / DNS-rebinding guard.** A random web page can make a *simple* cross-origin POST to `http://127.0.0.1:<port>`, and it cannot read the token — but it can still fire blind requests. Therefore:
- reject any request carrying an `Origin` or `Sec-Fetch-Site` header (a native local client sends neither);
- require the `Authorization` header to be present at all;
- validate the `Host` header is `127.0.0.1:<port>` (blocks DNS rebinding against a browser that resolves an attacker domain to loopback).

**Explicitly forbidden, and why:**

| Forbidden | Reason |
|---|---|
| Routing to `callViewMethod` (`main/viewManager.js:387`) | it performs `webContents[data.method](...data.args)` with a caller-chosen method name and args — that *is* unrestricted privileged API access. Min's own renderer uses it over trusted IPC; a network-facing bridge must never reach it. |
| `webContents.executeJavaScript` with any request-derived string | arbitrary script execution in the page. See §6 for the fixed-source pattern that replaces it. |
| `webContents.debugger` / CDP / `--remote-debugging-port` | CDP is a superset of everything the bridge is meant to restrict; one flag would make the whole surface moot. |
| `shell.openExternal`, `fs.*` with request-derived paths | filesystem and OS escape hatches. |
| `process.env`, `app.getPath` passthrough | information disclosure. |
| `loadURL` with non-`http(s)` schemes | `file://`, `data:`, `javascript:`, `min:`, `chrome:` would let a navigate call read local files or run privileged internal pages. |
| `session.setPermissionRequestHandler` overrides from the bridge | permission decisions stay with `main/permissionManager.js`. |

The command table in §5 is a closed set. An unknown method is `514 method not found` — never proxied to anything.

---

## 4. Envelope, validation, errors

JSON-RPC 2.0 subset:

```json
{ "jsonrpc": "2.0", "id": "c1", "method": "browser_navigate", "params": { "tabId": "123", "url": "https://example.com/" } }
```

```json
{ "jsonrpc": "2.0", "id": "c1", "result": { "...": "..." } }
{ "jsonrpc": "2.0", "id": "c1", "error": { "code": -32602, "category": "invalid_params", "message": "url must be an absolute http(s) URL", "data": { "field": "url" } } }
```

Validation is declarative and runs before any handler: required/optional, type, min/max, enum, pattern, max array/string length. `params` is a plain object; unknown keys are **rejected**, not ignored — silently dropped keys are how a typo becomes a security hole.

Error categories (stable, machine-readable; `code` is the JSON-RPC number):

| category | code | meaning |
|---|---|---|
| `invalid_request` | -32700 | malformed JSON, oversize body, wrong content type |
| `invalid_params` | -32602 | schema violation; `data.field` names the offending field |
| `method not found` | -32601 | method not in the closed set |
| `unauthorized` | -32001 | missing/bad token |
| `not found` | -32002 | `tabId` has no live view (destroyed, or belongs to another window) |
| `invalid target` | -32003 | locator matched nothing, or matched >1 without `index` |
| `unsupported` | -32004 | command not available in this mode/profile (e.g. screenshot of a hidden view) |
| `blocked` | -32005 | refused by policy (non-http scheme, private tab in background mode, disabled feature) |
| `timeout` | -32006 | action or verification window elapsed |
| `busy` | -32007 | another command holds this tab |
| `internal` | -32603 | unexpected; message is generic, detail stays server-side |

Error messages must not echo request values back (URLs and typed text can contain secrets).

---

## 5. Commands

All tab ids are strings, matching `js/tabState/tab.js` (`id: tabId` is a string). All timeouts are milliseconds, default 5000, max 15000 (navigate: default 15000, max 30000).

### `browser_status` → capability and mode snapshot
```jsonc
// params: {}
// result:
{
  "app": { "name": "Min", "version": "1.35.7", "electron": "43.4.1", "chromium": "150.0.7871.124" },
  "mode": { "visible": true, "background": false, "privateMode": false, "development": false },
  "profile": { "kind": "agent", "dir": "<userData>/agent-profile" },   // never the user's real dir in background mode
  "windows": 1,
  "tabs": 3,
  "activeTabId": "123",
  "features": { "snapshot": true, "screenshot": true, "extensions": false },
  "limits": { "snapshotNodes": 200, "screenshotBytes": 2097152, "bodyBytes": 65536 }
}
```
Sources: `app.getVersion()`, `process.versions`, `main/main.js:57` `isDevelopmentMode`, `js/util/settings/settingsMain.js` `privateMode`, `main/windowManagement.js:54` `getAll()`, tab count from the main-process tab mirror (`main/main.js:461`).

### `browser_tabs` → list / create / close / select
```jsonc
// params: { "action": "list" | "create" | "close" | "select", "tabId"?: string, "url"?: string, "background"?: boolean }
// result (list):
{ "tabs": [ { "tabId": "123", "url": "https://example.com/", "title": "Example Domain",
              "selected": true, "loaded": true, "secure": true, "private": false,
              "active": true, "windowId": 1 } ] }
// result (create): { "tabId": "456", "created": true }
// result (close/select): { "tabId": "123", "ok": true }
```
Mapping: `list` from the tab mirror; `create` → `main/viewManager.js:331` `createView` path via the existing `newTab` IPC, or `main/remoteActions.js:110` for a new window; `close` → `main/viewManager.js:244` `destroyView`; `select` → `main/viewManager.js:290` `focusView` + `:267` `setView`. `url` on create is validated exactly like `browser_navigate`.

### `browser_navigate`
```jsonc
// params: { "tabId": "123", "url": "https://example.com/", "waitUntil"?: "load" | "domcontentloaded" | "none", "timeoutMs"?: 15000 }
// result:
{ "tabId": "123", "url": "https://example.com/", "title": "Example Domain",
  "httpStatusOrError": null, "verified": true, "waitedMs": 812 }
```
Mapping: `main/viewManager.js:366` `loadURLInView(id, url, win)`. Validation: absolute URL, `URL.parse` must succeed, protocol ∈ `{http:, https:}`. Redirects are followed by the page; the *result* URL is read back from `webContents.getURL()`, so a redirect off the requested origin is visible to the caller. Verification: `did-finish-load` / `did-fail-load` within `timeoutMs`, then `getURL()` equals-or-descends-from the requested origin.

### `browser_snapshot` → bounded a11y-ish tree
```jsonc
// params: { "tabId": "123", "root"?: "#main", "maxNodes"?: 200, "maxDepth"?: 12,
//           "includeText"?: true, "interactiveOnly"?: false }
// result:
{
  "tabId": "123", "url": "https://example.com/", "title": "Example Domain",
  "nodeCount": 42, "truncated": false, "bytes": 6180,
  "nodes": [
    { "ref": "n7", "role": "heading", "name": "Example Domain", "level": 1, "depth": 2 },
    { "ref": "n9", "role": "textbox", "name": "Search", "value": "", "placeholder": "Search",
      "box": { "x": 12, "y": 88, "w": 240, "h": 24 }, "visible": true, "enabled": true,
      "actions": ["click", "type"] },
    { "ref": "n11", "role": "button", "name": "Submit",
      "box": { "x": 260, "y": 88, "w": 72, "h": 24 }, "visible": true, "enabled": true,
      "actions": ["click"] }
  ]
}
```
`ref` is a per-snapshot, opaque handle into a short-lived server-side map (TTL 60s, max 8 snapshots retained). It is **not** a CSS selector, so a stale snapshot cannot silently target a mutated DOM. See §7.

### `browser_click`
```jsonc
// params: { "tabId": "123", "ref": "n9" }  |  { "tabId": "123", "locator": { ... } }  |  { "tabId": "123", "x": 260, "y": 96 }
//         optional: "button"?: "left"|"right", "clickCount"?: 1, "modifiers"?: ["shift"], "timeoutMs"?: 5000
// result:
{ "tabId": "123", "target": { "role": "button", "name": "Submit" },
  "dispatched": true, "verified": true, "verification": "navigation",
  "urlBefore": "https://a/", "urlAfter": "https://a/b", "waitedMs": 640 }
```
Mapping: `webContents.sendInputEvent({type:'mouseDown'|'mouseUp', x, y, button, clickCount, modifiers})` at the centre of the resolved element's box. **Native input events, not `element.click()`** — framework-bound handlers, hover menus, and pointer-event listeners behave as with a real user, and the events are trusted. Coordinates are validated finite numbers within the view bounds.

### `browser_type`
```jsonc
// params: { "tabId": "123", "ref"|"locator": ..., "text": "hello",
//           "clearFirst"?: true, "verify"?: true, "timeoutMs"?: 5000 }
// result:
{ "tabId": "123", "target": { "role": "textbox", "name": "Search" },
  "verified": true, "valueLength": 5, "valueMatches": true, "waitedMs": 180 }
```
Mapping: focus via `sendInputEvent({type:'keyDown'/'char'})` sequence, or `insertText` for the whole string after a click focuses the element. `clearFirst` selects-all + deletes with key events rather than assigning `.value`, so React/Vue controlled inputs see real input. **The typed text is never echoed in the response or logs** — `valueLength`/`valueMatches` only.

### `browser_press`
```jsonc
// params: { "tabId": "123", "key": "Enter", "modifiers"?: ["ctrl"] }
// result: { "tabId": "123", "key": "Enter", "dispatched": true, "verified": bool, "verification": "...", "waitedMs": n }
```
Mapping: `sendInputEvent({type:'keyDown'/'keyUp', keyCode})`. `key` is validated against a **closed enum** (`Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End, Space, F1–F12`) — never a free string, so a press cannot smuggle a chord that Min's own shortcuts (`main/js/util/keyBindings.js`, `main/main.js` shortcut handlers) would act on.

### `browser_screenshot`
```jsonc
// params: { "tabId": "123", "format"?: "png"|"jpeg", "quality"?: 80, "maxBytes"?: 2097152, "save"?: false }
// result: { "tabId": "123", "url": "...", "format": "png", "width": 1280, "height": 800,
//           "bytes": 143021, "sha256": "…", "base64": "…" | "path": "<agentScreenshotDir>/…png" }
```
Mapping: `view.webContents.capturePage()` — the same call as `main/viewManager.js:440`. If `size.width === 0 && size.height === 0` (the case Min already guards at `main/viewManager.js:449`) → `unsupported`, because the view is hidden or occluded.

---

## 6. How commands run without unrestricted JavaScript

The bridge never accepts code. It accepts a name plus validated scalars.

Page-side work (snapshot, locator resolution, value read-back) is done by **fixed source compiled into Min's own bundle** — e.g. `js/agentRuntime/snapshot.js` and `js/agentRuntime/locate.js`, exported as pre-built function sources. The bridge calls:

```js
webContents.executeJavaScript(FIXED_SNAPSHOT_SOURCE + '(' + JSON.stringify(validatedOpts) + ')')
```

where `validatedOpts` contains only numbers, booleans, and short strings that passed a pattern, and `FIXED_SNAPSHOT_SOURCE` is a constant from Min's own code. The request can choose *parameters*, never *source*. This is the one place the design touches `executeJavaScript`, and it is deliberately narrower than Min's existing internal use at `js/webviews.js:74`.

Alternative if that is judged too sharp: run the snapshot/locator routine in an **isolated-world content script** loaded through the already-proven extension host (`main/extensionHost.js`, `ses.extensions.loadExtension`), and talk to it over `chrome.runtime.sendMessage` from a fixed main-process caller. That path is proven to work in this Electron (see `docs/EXTENSION-COMPATIBILITY.md` §1) and keeps page-world access out of Min entirely. Trade-off: `file://` injection is unreliable there, so the `executeJavaScript` path is the default and the extension path is the fallback.

Read-only by construction: the snapshot routine may read DOM/attributes/geometry and must not mutate, navigate, fetch, or call `window.*` APIs beyond `getComputedStyle`, `getBoundingClientRect`, and attribute reads. That constraint belongs in the routine itself, not in a review checklist.

---

## 7. Locator resolution order

A locator is `{ role?, name?, text?, label?, placeholder?, css?, index?, frame? }`, at least one key required.

Resolution order — most semantic first, so a UI redesign doesn't silently retarget the agent:

1. **Accessibility: `role` + accessible `name`.** Name computed in ARIA order: `aria-labelledby` → `aria-label` → `<label for>`/wrapped `<label>` → `alt` → `title` → visible text content. Implicit role from tag (`button`, `a[href]`, `input[type=…]`, `select`, `textarea`, `h1`–`h6`, `li`, `td`, …), overridden by explicit `role`.
2. **Form semantics: `label` / `placeholder` / `name` attribute.**
3. **Visible text** (exact, then normalised-whitespace substring).
4. **`css`** — last resort, and only when the caller explicitly supplies it. Never auto-generated from a snapshot.

Rules:
- The candidate set is built inside the target frame only (`frame` selects it; default is the top frame).
- Zero matches → `invalid target`. More than one match and no `index` → `invalid target` with `data.candidates` listing up to 5 `{role, name}` pairs — never `outerHTML`.
- Hidden/off-screen candidates are excluded unless `includeHidden: true`; `display:none` and zero-area boxes never match.
- A `ref` from `browser_snapshot` bypasses resolution entirely: it is a direct handle to the node the snapshot saw, and it fails loudly when stale.

Honest limitation: this is a **DOM-derived** accessibility tree, not Chromium's native AX tree. Electron exposes the native tree only through CDP (`Accessibility.getFullAXTree`), which §3 forbids. Consequences to state in the UI and in docs: shadow DOM is not pierced, `aria-owns` relationships are not followed, and native pseudo-element names are not resolved.

---

## 8. Snapshot structure and bounds

- `maxNodes` default **200**, hard max **500**. `maxDepth` default 12, hard max 20.
- `name`/`text` truncated to **120 chars** with `truncated: true` on the node.
- Total serialised result capped at **64 KiB**; on overflow, stop adding nodes and set `truncated: true` at the top level.
- Only nodes that are interactive, a heading, a landmark, or carry an accessible name are emitted; decorative wrappers are skipped. This is what keeps a real page inside the cap without a truncation that hides the button the agent needs.
- `box` is viewport-relative CSS pixels, matching `sendInputEvent` coordinates.
- **Redaction inside the snapshot:** `input[type=password]` values are never read (only `valueLength`); `type=email`/`tel` and `autocomplete="cc-number|current-password|one-time-code"` values are length-only. `srcdoc`, `href` on `javascript:` links, and `data:` URIs over 200 chars are dropped.
- Snapshots are not persisted to disk. The `ref` map is in-memory, TTL 60s, max 8 retained, cleared on navigation in that tab.

---

## 9. Action verification and timeouts

Every mutating command returns `verified` plus a `verification` string naming what was observed. Verification is best-effort and its kind is reported, never implied:

| kind | observed by |
|---|---|
| `navigation` | `did-start-navigation` / `did-finish-load` within the window, and `getURL()` changed |
| `dom-change` | a bounded re-snapshot of the target's subtree differs from before |
| `value` | for `browser_type`, the element's value length/equality matches the request |
| `focus` | `document.activeElement` now matches the target |
| `none` | nothing observable changed — `verified: false`, and the caller decides |

Timeouts: per-command default 5000ms, max 15000ms; `browser_navigate` default 15000ms, max 30000ms. A timeout is a **result**, not a dropped connection: the response says `category: "timeout"` and includes what *did* happen (`urlBefore`/`urlAfter`, `dispatched: true`). A dispatched-but-unverified action must not be reported as a failure, because the agent needs to know the click probably landed.

Deadline discipline: the whole command has one deadline shared by action + verification. No command may hold a tab past `max 15000ms`; a stuck renderer surfaces as `timeout`, and the tab is *not* force-reloaded (that would destroy agent context).

---

## 10. Profile, visible vs background mode

Two modes, and the profile choice is a policy decision, not an implementation detail:

| Mode | Window | Profile | Notes |
|---|---|---|---|
| **visible** | normal Min window, shown | the user's real profile (default) | the agent can see logged-in sessions — that is the point, and the risk. Requires an explicit user action to enable, per launch. |
| **background** | `show: false` | **dedicated** `--user-data-dir` under `<userData>/agent-profile` | no user cookies, no user extensions; nothing of the user's leaks into an automated run |

- The dedicated directory is created with `app.setPath('userData', …)` **before** `app.on('ready')`, mirroring `main/main.js:60`. Note that dev mode appends `-development` to `userData`; the agent path must not collide with the smoke harness's throwaway profile.
- Background mode must not reuse `persist:webcontent` from the user's profile. Either a distinct partition (`persist:agent`) or a distinct `userData` root — the latter is stronger because it isolates extension storage, cache, and the places DB too.
- **Hard constraint:** `capturePage()` returns a zero-size image for hidden views (`js/webviews.js:19`, guarded at `main/viewManager.js:449`). Background screenshots therefore need either an offscreen-but-rendered view, or `backgroundThrottling: false` plus a sized bounds, or they must return `unsupported`. This must be measured in Phase 1, not assumed.
- `privateMode` (`js/util/settings/settingsMain.js`) forces `persist:incognito`; the bridge reports `mode.privateMode` and refuses to write screenshots into an incognito profile directory.
- Cleanup: on bridge shutdown, the dedicated profile is retained by default (agents need continuity) but `browser_status` reports its path and size, and a `--clear-agent-profile` path exists. Min already has storage-clearing plumbing in `main/remoteActions.js`.

---

## 11. Screenshot storage and redaction

- Default: **returned inline as base64, never written to disk.** `save: true` is opt-in.
- When saved: only under `<agentProfileDir>/screenshots/`, filename `YYYYMMDD-HHMMSS-<tabId>.png`, never a caller-supplied path. Cap total directory size (default 200 MiB, oldest evicted).
- Size: `maxBytes` default 2 MiB, hard max 8 MiB. Over cap → downscale, then `jpeg` with quality step-down, then `unsupported`.
- `sha256` of the bytes is returned so a caller can dedupe without re-reading.
- **Redaction is not possible and must not be claimed.** `capturePage()` returns pixels; there is no field-level filtering after the fact. Mitigations, stated as mitigations: screenshots are never logged, never written outside the agent profile, never included in evidence files by default, and `browser_status` reports `screenshot: true` so an operator can see the capability is live. A visible-mode screenshot of a logged-in page will contain whatever is on screen, including session cookies rendered as tokens, 2FA codes, and personal data. That is a user-facing consent question for Phase 1, not a code comment.

---

## 12. Risks and unsupported behaviour (explicit)

| Risk / limitation | Status |
|---|---|
| Bridge is a local HTTP server; any process as the same user can connect with the token | **Accepted, documented.** Token is per-launch and file-only; same-user processes are already inside the trust boundary. |
| Blind CSRF from a web page to `127.0.0.1` | **Mitigated** by Origin/Sec-Fetch-Site rejection, mandatory `Authorization`, and `Host` validation (§3). Must be tested, not just coded. |
| DOM-derived a11y tree ≠ native AX tree; no shadow DOM, no `aria-owns` | **Known limitation**, §7. |
| `capturePage()` fails for hidden views | **Known**, §10. Measure in Phase 1; may force background mode to use an offscreen sized view. |
| Screenshots are unredacted pixels | **Known**, §11. Needs explicit user consent in visible mode. |
| `executeJavaScript` with fixed source is one refactor away from arbitrary JS | **Watch item.** The fallback is the isolated-world extension path (§6). Keep the constant `FIXED_*_SOURCE` in Min's own bundle, never in a template literal fed by request data. |
| `callViewMethod` (`main/viewManager.js:387`) is reachable from any Min renderer | **Pre-existing**, not introduced here. The bridge must not add a network path to it. Worth a separate hardening task. |
| Visible mode exposes the user's logged-in sessions to an agent | **Design decision for the user**, §10. |
| Extension host is dev-gated and `file://` injection is unreliable | **Known** (`docs/EXTENSION-COMPATIBILITY.md` §2). Do not build the snapshot path on extension injection for `file://` targets. |
| Multi-window tab ids are per-window (`main/main.js:461` mirrors per window) | **Handle explicitly**: `browser_tabs` must qualify by `windowId` or flatten deterministically. |
| No rate limit on expensive commands (snapshot/screenshot) | Add per-command cost budget, not just request count. |

---

## 13. Open questions to settle before Phase 1 code

1. Visible mode with the user's real profile, or always a dedicated profile with an explicit "import my logins" step?
2. Is the snapshot runtime `executeJavaScript`-based or extension-host-based? (§6 — decide once, it shapes the tests.)
3. Does background mode need screenshots at all? If yes, solve the hidden-view `capturePage()` problem first.
4. Who owns the token file lifecycle when Min crashes — and does a stale file need to be refused rather than reused?

---

## 14. Implementation status — P0-06

Built: `main/agentRpc.js`, wired last in `scripts/buildMain.js` (it needs `viewMap`/`windows` from `viewManager.js` and `userDataPath`/`isDevelopmentMode` from `main.js`). Not built: snapshot, navigate, click, type, press, screenshot.

### 14.1 Deliberate deviations from this design

| Design said | Built | Why |
|---|---|---|
| §2 discovery file `{v, port, token, pid, startedAt}` | `{v, url, token, pid, version, launchedAt}` | the task brief specified these keys; `url` replaces `port`, `launchedAt` replaces `startedAt`, `version` added |
| §5 `browser_tabs` with `action: list/create/close/select` | **list only, and `params` is rejected outright** | P0-06 scope is status/tabs only. Creating, closing or selecting a tab is control, and control needs the verification and timeout machinery of §9 — shipping it without those would be worse than shipping nothing. Recorded as a narrowing, not an oversight. |
| §5 `browser_status.profile.kind: "agent"` | `profile.userDataPath` (live) + `profile.dedicated: false` | Min has no automation launch mode yet. Reporting the real path — which reflects `--user-data-dir` — is honest; claiming `kind: "agent"` would not be. |
| §4 eleven error categories | seven implemented | `not found`, `invalid target`, `timeout`, `unsupported` only arise for page commands, which do not exist yet |

Enable gate: the literal argv `--agent-rpc`, matching `--development-mode` / `--debug-browser` (`main/main.js:35-36`). **Not** a persisted setting — a network listener must never reappear without an explicit launch decision. Verified inert: a launch without the flag produced 0 `[agent-rpc]` lines and no discovery file.

### 14.2 Measured findings that change the design

**1. `capturePage()` on a hidden window rejects — it does not return a zero-size image.**
Measured on Electron 43.4.1 with a fixture reproducing Min's exact setup (`BrowserWindow` + `WebContentsView` attached via `win.contentView`), `docs/capture-page-probe.json`:

| Case | Result |
|---|---|
| A `show: false`, view attached | **rejected**: `Current display surface not available for capture` |
| B `show: false` + `backgroundThrottling: false` | **rejected**, same error — disabling throttling does not help |
| C view removed from the view tree | **rejected**, same error |
| D visible window (control) | **2420×1513, 9 distinct colours — works** |
| E visible, then **minimized** | **2420×1513, 9 distinct colours — works** |

Consequences:
- §10's open question is answered: background mode cannot use a never-shown window. It must show the window at least once, then minimise or move it off-screen. Case E is the viable shape.
- Min's existing guard at `main/viewManager.js:449` tests `size.width === 0 && size.height === 0`, which is **not** how this Electron fails. `getCapture` (`main/viewManager.js:440`) has no `.catch()`, so a hidden-view capture is an unhandled promise rejection. Pre-existing, not introduced here, and out of P0-06 scope to fix — but it must be fixed before `browser_screenshot` ships.
- `js/webviews.js:19` ("capturePage doesn't work while the view is hidden") is confirmed, with the correction that the failure is a rejection rather than an empty image.

**2. A force-killed or crashed launch leaves a stale discovery file behind.**
After `taskkill /F`, `before-quit` and `process.on('exit')` never run, so `agent-rpc.json` survives. Mitigated: `agentRpcStartServer()` unlinks any existing file before publishing a new one. Verified — a planted stale file with a bogus token was replaced by the new launch's token. A client that reads the file *between* a crash and the next launch can still see a dead port; that is acceptable (connection simply fails) and is stated rather than papered over.

**3. `windowId` is only known for the tab a window currently shows.**
Real Min returned two tabs: the selected one with `windowId: "1"`, and the non-selected one with `windowId: null`. `windows.getState(win).selectedView` (`main/viewManager.js:280`) records one view id per window, so main cannot attribute a background tab to its window. §12's multi-window risk is confirmed and is worse than stated: a multi-window `browser_tabs` needs either a renderer round-trip to the tab model (`js/tabState/tab.js`) or a new main-side mirror. Do not build page commands on the assumption that `windowId` is reliable.

**4. `active` and `focused` are different things.**
`active` = the tab is a window's selected view. `focused` = its own `webContents` has focus. Observed `active: true, focused: false` while the address bar held focus. Both are reported; neither is inferred from the other.

### 14.3 Test surface added

- `npm run test:agent-rpc` — 89 checks. Loads `main/agentRpc.js` into a Node `vm` with stubbed Electron globals, then (a) calls the validators directly and (b) starts the **real** server on `127.0.0.1:0` and drives it with real loopback requests, including a raw malformed request line and a non-loopback interface attempt (`ECONNREFUSED` from `192.168.0.150`).
- `npm run probe:agent-rpc` — launches the **real Min** with and without `--agent-rpc`; evidence in `docs/agent-rpc-probe.json`.
- `npm run probe:capture` — the §14.2 measurement; evidence in `docs/capture-page-probe.json`.

---

## 15. P0-07 refinement of the capture findings in 10 and 14.2

The P0-06 table ("hidden window rejects") was true for its fixture but incomplete. On Electron 43.4.1, measured inside Min with `docs/capture-page-probe.json`:

| View state | capturePage() | Handle |
|---|---|---|
| Never attached to a window | resolves **0x0** | Min's zero-size guard (`viewManager.js:449`) — **must stay** |
| Attached + rendered, then detached (= every non-selected tab view) | **rejects** | new `.catch` (`CAPTURE_UNAVAILABLE`) |
| `show: false` window, view attached + rendered | **rejects** | new `.catch` |
| Shown, then minimized | **works** (2420×1513) | viable background shape |

`getCapture`/`saveViewCapture` now handle rejection by dropping (the renderer's `captureData` contract has no error channel) and logging a rate-limited category. A plain launch logs `CAPTURE_UNAVAILABLE count=1` naturally, with no unhandled rejection.

Two pre-existing product bugs were reproduced during this and **not fixed**: (1) two positional URL args crash Min silently at startup (no window, exit 4294967295) — this constrains any future bridge-to-Min launcher to a single URL arg or a different tab-creation channel; (2) detaching the selected view from main-process code (as `hideCurrentView` does) can crash the process mid-run. Both affect Phase 1's future `browser_screenshot` and multi-tab work.

---

## 16. P0-08 constraints this diagnosis imposes on Phase 1

1. **Never launch Min with a positional URL argument followed by another positional argument.** The Electron 43.4.1 runtime on Windows dies (exit 4294967295) before any application JS — before `default_app`'s own argv loop could matter, before Chromium logging, before Min. Multi-URL launches must use the `--` separator (`electron . --development-mode --user-data-dir=<dir> -- urlA urlB`), proven to open every argv tab through the bridge's `browser_tabs`.
2. `getCapture`/`saveViewCapture` are now attachment-guarded (`isViewAttachedToAnyWindow`): detached views route to `CAPTURE_UNAVAILABLE` instead of the `capturePage()` call that deadlocks the main process when issued in the same tick as `removeChildView` (D2, `docs/detach-probe.json`). `browser_screenshot` inherits this protection; the D2 hang remains reproducible by direct calls and is an upstream Electron bug, not a Min-reachable one.
3. Detaching a view is safe (D1); capturing a long-detached view is safe (D3, clean rejection); the hazard is strictly the same-tick order.

---

## 17. P0-09: browser_snapshot implemented — decision and limitations

**Execution path: option 1 (fixed-source `executeJavaScript`)** on the target tab's webContents, with a zero-interpolation hardening over the section 6 sketch: the injected string is `'(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')()'` — the page function **takes no arguments**, so no request value participates in the page-side source at all. Requested `maxNodes` is applied by slicing the page result in the main process; the page caps itself at 500 via a constant. `format` is pure main-side post-processing. No eval, no `new Function`, no request-derived source anywhere.

Chosen over option 2 on existing evidence: extension-host content scripts are unreliable on `file://` (where `document_start` and frame injection both fail) and for session-first documents, and the host is dev-gated — the bridge must snapshot whatever tab the user has, including `file://`.

Implemented against section 6: page-side walker returns ≤500 interactive nodes (button/link/textbox/checkbox/radio/combobox + explicit role overrides, headings, named statics), skipping script/style/noscript/template, `display:none`/`visibility:hidden`/`aria-hidden`/zero-geometry nodes; names computed in ARIA order (labelledby → aria-label → label[for]/wrapped → placeholder → alt → title → text) with `nameKind` exposed as the preferred locator kind (§7 order: role+name, form semantics, text, CSS-last); 120-char name truncation and control-character stripping in the page; values are end-to-end redacted — password/email/tel/sensitive-autocomplete (cc-number, cc-csc, cc-exp, current-password, new-password, one-time-code) never leave the page (length only); checkboxes keep checked; disabled/aria-checked/aria-expanded states; viewport boxes.

Refs (section 7): opaque `r<base36>` tokens from a single process-wide counter — never reused across tabs or snapshots; stored server-side keyed by tab, replaced per snapshot, cleared on `did-navigate` (own-attachment tracked by webContents id, because Min already registers its own `did-navigate` listeners), on tab destruction (30s sweep) and at 60s TTL (sweep for memory, **read-time liveness filtering** in `browser_status.refStore` so a status read never reports a ref a future consumer could not resolve).

Bounds (section 8): `maxNodes` default 200 / hard 500 (schema-validated), names 120 chars, total response ≤ 64 KiB enforced by dropping nodes (or text lines) from the end with `truncated` flags, `bytes` reported. `format: "text"` renders one bounded line per node with `ref=` handles.

Known limitations, stated: nameless interactive nodes are kept (an unnamed checkbox is still a checkbox) — headings without text are dropped; combobox options are not enumerated (the select is); iframe internals are not traversed; shadow DOM is not pierced; the a11y tree is DOM-derived, not Chromium's native tree (CDP remains forbidden); snapshot timeout 8s → structured `timeout` error; a background (detached) tab can be snapshotted and the response marks `active`/`windowId` honestly (single-window scope, per section 10 — multi-window switching still out of scope).

Validation hardening added along the way: NaN arriving as `null` through JSON is explicitly rejected for any declared parameter; `JSON.stringify` of request params can never smuggle source because params are (type, pattern, enum, range)-checked before dispatch.

---

## 18. P0-10: browser_click / browser_type — verification model and locator resolution

Implemented on the P0-09 foundation: `browser_click { tabId, ref }` and `browser_type { tabId, ref, text }` (text ≤1000 chars, control characters including newlines rejected). **No selector, CSS, JS, or coordinate parameter exists** — verified by schema tests. Resolution and verification per sections 7-9, with these concrete mechanisms:

**Ref resolution (no stale DOM handles, no string interpolation ever):** the page function gained a `locate` mode that runs the IDENTICAL enumeration as snapshot mode (same function, so ordinals are comparable) with only a validated integer ordinal as argument, and returns the full bounded node list. Resolution is server-side:
1. **Strict**: enumeration `total` equals the snapshot's recorded length AND the element at the recorded ordinal matches the ref's `role + name + nameIndex` → resolved.
2. **Weak** (page changed since snapshot): match `role + name` in the current enumeration — exactly one → resolved (element legitimately moved); zero → `ref_stale`; **more than one → `ambiguous` (-32011), never a guess**.
Guard rails before dispatch: view attached to a live window (`view_not_attached`), element not disabled (`disabled`), typing into password/email/tel/sensitive-autocomplete fields refused (`sensitive_field`, no bypass flag), and clicks whose accessible name matches purchase/payment patterns (`Pay Now`, `Checkout`, `Place Order`, …) refused with `risky_action` **by default**; `--agent-rpc-allow-risky` (launch-time literal, never persisted) marks user approval given outside the bridge.

**Dispatch:** native only — `sendInputEvent` mouseDown/mouseUp at the element's box center (click; also focuses), ctrl/meta+A + Backspace key events (replace semantics; fixed policy — no `clearFirst` parameter exists by this task's schema), then `webContents.insertText(text)`. No `element.click()`, no JS.

**Verification (section 9 kinds):** exactly one dispatch, then a bounded 5s window with fixed poll beats (300/700/1200/2000/3000/4000/5000ms):
- `navigation` — `did-navigate`/`did-navigate-in-page` fired (strongest, wins);
- `dom-change` — body-text marker (innerText length + trailing-120 sample) plus interactive count differ from the pre-dispatch capture;
- `value` (type) — the re-located field's `value` equals the typed text (sanitized comparison; `valueLength` must match exactly so >120-char typing is verified by length, not truncated prefix);
- `focus` — the target (or the weak-moved element) holds `document.activeElement`;
- `dispatched-unverified` — nothing observed; returned with `verified: false`, **never counted as success**.
Response echoes `verified` alongside `verification` and `waitedMs`. The overall action budget is bounded (resolve ≤8s + verify ≤5s); verification failures of intermediate enumerations during navigation are tolerated and fall back to the navigation signal.

Limitations, explicitly: page zoom ≠ 100% desynchronizes CSS-px input coordinates from view DIPs (Min's default zoom is fine; per-tab zoom must be reset or absolute coordinates mis-target); macOS select-all uses `meta` (implemented) but the probe only exercises Windows `control`; typing verifies `valueLength` exactly but truncated (>120-char) values only by prefix; weak matching trusts accessible name equality, so a same-name redesign inside a changed DOM resolves to the walker's single candidate (the ambiguity and staleness guards above cover the multi/zero cases); `select` combobox values are typed as text with no popup interaction; multi-window remains out of scope.

---

## 19. P0-11: browser_navigate / browser_press / browser_screenshot

**browser_navigate `{tabId, url}`** — URL ≤300 chars, no control characters/leading-trailing whitespace (the WHATWG parser silently strips the latter; the bridge rejects instead), then a strict parse + allowlist `{http, https, file, min, about}` as parsed protocol — `javascript:`/`data:`/`vbscript:`/anything else is `blocked` (403) before the tab is touched. Refs for the tab are cleared BEFORE the navigation and again by the P0-09 `did-navigate` listener. Dispatches through Min's existing `loadURLInView` (`main/viewManager.js:366`), then waits once for `did-finish-load` (resolve: `navigation` verified, final URL + title echoed) or `did-fail-load` with `isMainFrame !== false` (`load_failed` 502, code + constant error name only). Attached-view guard applies (`view_not_attached`).

**browser_press `{tabId, key}`** — closed, case-sensitive 13-key enum (Enter, Tab, Escape, arrows, PageUp/Down, Home, End, Backspace, Delete); no chords/modifiers. Measurements (`scripts/fixtures/keymap-probe-main.js`): this Electron's `sendInputEvent` speaks accelerator codes — DOM-style `ArrowDown/Left/Right/Up` produce EMPTY key events while `Down/Left/Right/Up` deliver real ones — so the command translates internally (`agentRpcTranslateKey`); the public enum stays DOM-style. Enter delivers a real `keydown` but does NOT trigger implicit form submission on `file://` (documented runtime limitation; verify Enter effects via the page's own key listeners or click a submit button). Dispatches keyDown+keyUp only; verification reuses the P0-10 engine in a `press` mode where **focus movement is the primary signal** and is evaluated BEFORE the DOM-change marker (a page with its own key logger flips the marker for every key, including Tab). Escape on a page with no handlers → `dispatched-unverified`, `verified: false`.

**browser_screenshot `{tabId}`** — attachment guard before anything (`view_not_attached` for detached/hidden/never-shown views); inline PNG base64 only, no filesystem write; >5 MiB encoded → `screenshot_too_large` (413) via `agentRpcScreenshotSizeOk` (unit-tested boundary); zero-size images and wedged captures retried. Measured finding: on this Electron, `capturePage()` can **wedge without ever settling** after rapid successive navigations — so each attempt carries its own 2.5s soft timeout, a wedged attempt is abandoned, and a fresh one is issued (6 attempts inside the overall 8s deadline). Retries are safe here: the call is read-only, unlike input dispatch.

Bounds/logging: responses carry `mimeType, bytes (encoded), width, height, data`; logs contain byte counts only; no page text, URL, or token — asserted by the probe.

---

## 20. Usage (P0-12)

The 8 bridge tools are exposed to MCP clients over stdio: `mcp/min-agent-mcp.js` (initialize/tools/list/tools/call/ping; newline-delimited JSON-RPC; stdout is MCP frames only). Start Min first: `npm run launch:agent` (or `node scripts/min-launch.js [--profile=<dir>] [-- <url>…]`) — visible window, dedicated profile at `%USERPROFILE%\.min-agent-profile`. The adapter re-reads `<profile>/agent-rpc.json` per call and maps bridge errors to `isError` content. Client configs: `mcp/README.md`. E2E transcript: `docs/mcp-e2e-run.json`.

---

## 21. P0-13: browser_grant + policy.json — replaces the launch-flag bypass

`--agent-rpc-allow-risky` is REMOVED. Approval is now intent-scoped:

- **`browser_grant {action:'risky_click'|'sensitive_type', tabId, ref?, ttlSeconds? (30-300, default 120)}`** — issues a single-use grant bound to exact action+tabId (+ exact ref when given), stored server-side, consumed on use, pruned on TTL. Unprompted risky/sensitive actions remain 403 with no flag at all. Skill-layer hard rule: browser_grant is called ONLY in response to an explicit user instruction (documented in mcp/README.md section 3 and asserted in the adapter log).
- **policy.json (durable per-profile defaults)** — `{allowRiskyClicks, allowSensitiveTyping, allowedSchemes}` in the profile dir; read per call; pre-authorizes the categories without any grant. `allowedSchemes` can only RESTRICT the built-in {http, https, file, min, about} set (unknown entries dropped). Grants still authorizes when policy is false.

Verification (docs/agent-actions-probe.json 32/32; docs/agent-nps-probe.json 26/26): unprompted → 403; grant → 200 + consumed → second → 403; wrong-tab grant unconsumed → 403; wrong-action grant → 403; expired (ttl 30 + 31s) → 403; policy true → allowed without grant; allowedSchemes restriction → file:// blocked 403. `browser_status.bridge.grants` exposes the active COUNT only. The tool-count surface changed: 9 methods / 9 MCP tools.
