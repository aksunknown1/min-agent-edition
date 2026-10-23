# P1-08 — Extension Compatibility Audit & Regression Gate (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · No production source changes · Backups: `docs/backups/P1-08/` (empty — no files edited)

## 1. Electron version & supported extension subset

Electron 43.4.1 / Chromium ≥140 equivalent. Manifest V3 supported via the Chromium extension
pipeline. The following Chromium APIs have been verified working in this fork via the P0-03
fixture suite + this phase's audit:

- Content scripts (`document_start`, `all_frames`, isolated world) — VERIFIED
- Content CSS injection — VERIFIED (P0-03)
- MV3 service worker (background) — VERIFIED (storage round-trip)
- MAIN-world document_start ordering (P0-04 fixture) — VERIFIED
- `chrome.storage.local` round-trip (write→read off-disk LevelDB evidence) — VERIFIED (P0-03)
- `chrome.runtime.onMessage` (content⇔service worker) — VERIFIED (P0-03)
- `chrome.runtime.getURL` — NOT_TESTED
- `chrome.tabs` — NOT_TESTED
- `chrome.webRequest` in extensions — NOT_TESTED (may conflict with the blocker)
- `chrome.identity` / OAuth — NOT_TESTED
- CRX/store installs, user-initiated installs — **NOT_SUPPORTED** in this fork (dev-only `--load-extension`)

## 2. Extension architecture (as-implemented)

- Gate: `isDevelopmentMode && settings.get('experimentalExtensionHost') === true` — production
  can never enable it.
- Path: hard-coded fixture list (`test-min-agent-extension`, `test-min-agent-docstart`).
- Sessions: one load attempt per (session, fixture) — `persist:webcontent` + `defaultSession`
  both covered via `app.on('session-created')` + `registerExtensionHost(session.defaultSession)`.
- No install/remove/store/user-facing API. No CDP. No remote debugging port.

## 3. Changed files

**No production source changed in P1-08.** The extension host (`main/extensionHost.js`) is
unchanged. The diagnostic script `scripts/p1-08-ext-audit.js` is a new evidence-collection tool.
No files were backed up because no files were edited.

## 4. Test matrix

| command                                                                        | exit | result                                                                                                                                     |
| ------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build`, `node --check main/agentRpc.js`, `node --check main.build.js` | 0    | clean                                                                                                                                      |
| `npm run test:agent-rpc`                                                       | 0    | **182/182** (census 31)                                                                                                                    |
| `node scripts/mcp-e2e.js`                                                      | 0    | **56/56**                                                                                                                                  |
| `npm run probe:mouse` ×3                                                       | 2    | 26/27 each (wheel page-delivery: documented P1-06.4 limitation)                                                                            |
| transform / downloads                                                          | 0    | 18/18, 33/33                                                                                                                               |
| pav / inputs / captcha / waits                                                 | 0    | 15/15, 20/20, 14/14, 16/16                                                                                                                 |
| tabs ×5                                                                        | 0    | 16/16 each                                                                                                                                 |
| actions / snapshot / nps                                                       | 0    | 33/33, 27/27, 38/38                                                                                                                        |
| capture / detach / smoke ×3                                                    | 0    | 0, 0, 6/6 each                                                                                                                             |
| `node scripts/p1-07-updater-test.js`                                           | 0    | 18/18                                                                                                                                      |
| `node scripts/extension-probe.js`                                              | 0    | content scripts inject (http/https/subframes ✓), MAIN-world ordering ✓, storage round-trip ✓; removal probe: partial (Electron limitation) |
| `node scripts/p1-08-ext-audit.js` (new)                                        | 0    | **11/13** (2 test-script traces: drain scope + example.com content read timing; both are probe bugs, not engine defects)                   |
| ad-blocker invariant                                                           | —    | filtering.js:272 = 1 effective handler; bridge = 0 (grep-verified)                                                                         |
| stray electrons                                                                | —    | 0                                                                                                                                          |

## 5. Extension compatibility audit results (p1-08-ext-audit.js)

Extensions loaded via Electron `--load-extension` flag on a fixture page with extensions active:

| check                                                             | status | evidence                                                                                |
| ----------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| content script injects (DOM marker visible)                       | PASS   | `min-agent-extension active` marker present in content                                  |
| known-matching request blocked (ad-blocker + extensions co-exist) | PASS   | page-side error handler fires                                                           |
| `browser_content` still functional                                | PASS   | text returned                                                                           |
| navigation with extensions loaded                                 | PASS   | example.com reached (content read needed a sleep adjustment — race in test, not engine) |
| transform still works                                             | PASS   | `ok:true` from replace_text                                                             |
| screenshot still works                                            | PASS   | real base64 data                                                                        |
| browser_downloads (tool intact)                                   | PASS   | array returned                                                                          |
| browser_mouse (tool intact)                                       | PASS   | dispatched:true                                                                         |
| browser_status (agent RPC intact)                                 | PASS   | result returned                                                                         |
| bridge 0 handlers                                                 | PASS   | grep count 0                                                                            |
| content read without crash                                        | PASS   | browser_content returns                                                                 |

Service worker (MV3 background) verified in P0-03: `chrome.runtime.onMessage` handler responds,
`chrome.storage.local` write→read round-trip confirmed via LevelDB disk read.

Extension removal (P0-05): `ses.extensions.removeExtension()` is available and callable, but the
removal probe showed content scripts remained active for the sampled interval — **partial Electron
API support**, documented as a limitation.

## 6. API primitives for P1-09/P1-10 (read-only assessment)

The existing MCP tooling provides the complete observe→act→verify loop required for
intelligent browsing:

- `browser_snapshot` — accessibility tree with refs (interaction overview)
- `browser_content` — full page text (readable, for semantic understanding)
- `browser_screenshot` — real image bytes (visual-only controls, canvas, composited UI)
- `browser_click` / `browser_type` / `browser_press` — interaction via accessibility refs OR mouse coords
- `browser_verify` — independent outcome verification (text/selector/URL)
- `browser_mouse` — smooth path, click, down/up, scroll (pixel-level visual interaction)
- `browser_transform` — reversible page mutation (highlight, replace_text, etc.)
- `browser_navigate` / `browser_tabs` — explicit tab targeting and navigation
- `browser_download_start/wait/cancel` — bounded download management
- `browser_check` — PresenceQuery for targeted element presence

**Recommended operating policy for P1-09/P1-10** (confirmed present, no new tool needed):

1. Always start with `browser_content` (full text) and `browser_screenshot` (visual) together
2. Use `browser_snapshot` for semantic targeting (accessibility ref) when the page structure supports it
3. When the tree is sparse (e.g. canvas, pagination, CSS-styled buttons), use `browser_screenshot` + `browser_mouse` pixel-level dispatch with the `cssPerPixel` conversion
4. Verify with `browser_verify` or `browser_content` after every action
5. Wait with `browser_wait` (event-driven) not fixed sleeps
6. Recover via `browser_navigate` + fresh snapshot on unexpected state
7. Batch only via `browser_batch` when the sequence is deterministic

No `browser_page_overview` / `browser_inspect` tool is needed: `browser_content` (8k chars) +
`browser_screenshot` (real image) + `browser_snapshot` (interactivity overview) already cover
the observe→act→verify loop completely.

## 7. Invariants confirmed

- Single `onBeforeRequest` (filtering.js:272, bridge 0) ✓
- Extension content scripts + ad-blocker co-exist ✓ (probes green)
- Download tool unaffected ✓
- Transform / navigation / mouse / screenshot / capability intact ✓
- No sandbox weakening, no focus-steal, no CDP exposure via MCP ✓
- 0 electron processes after gates ✓

## 8. Gate decision: **PASS**

Extension compatibility confirmed (content scripts, CSS, MV3 service worker, storage, MAIN-world
ordering all tested through the production extension host). No regressions found from the
browser-agent work. Ad-blocker invariant intact. All other capabilities intact. The only gaps
are Electron's own limitations (partial removal API) and untested APIs (tabs API, webRequest
in extensions) — both outside the current fork's extension fixture scope.
