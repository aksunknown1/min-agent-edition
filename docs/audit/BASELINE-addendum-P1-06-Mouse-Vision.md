# P1-06 — Mouse Control + Agent-Usable Vision (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · MCP adapter: custom stdio JSON-RPC (MCP 2024-11-05/2025-03-26/2025-06-18) Backups: `docs/backups/P1-06/`

## 1. Audit findings

- Screenshot path already existed end-to-end from earlier phases: `webContents.capturePage()` →
  base64 PNG over JSON-RPC → MCP adapter mapped it to a real `{type:'image', data, mimeType}`
  content block (mcp-e2e asserted the PNG magic + mime + size). What was missing: screenshot
  identity/metadata, encoding/size options, stale-coordinate validation, and the typed mouse API.
- `browser_click`/`browser_hover` dispatch `sendInputEvent` in viewport CSS-pixel space at
  snapshot-derived boxes; no raw coordinate-level mouse API existed.
- MCP client support: the production stdio client (mcp-e2e) receives `image` content blocks —
  verified in e2e (magic header + mime + >1000-byte payload) AND in the live runs below
  (screenshots exported to disk decode as real PNGs).

## 2. Changed files & backups

| file | change | backup |
|---|---|---|
| `main/agentRpc.js` | screenshot v2 (`screenshotId`, viewport/dpr/scroll/zoom metadata, `coordinateUnits: 'viewport-css-px'`, `cssPerPixel` conversion, png/jpeg + aspect-preserving downscale, identity registry bounded 25); P1-06 mouse engine (`browser_mouse`: move/hover/down/up/click/rightClick/scroll/movePath/drag/status; per-tab serialization, pressed-button tracking with bounded auto-release on navigation/tab-close/failure, deterministic eased interpolation, bounds+schema rejection, optional screenshotId staleness gate → `ref_stale`); census 30→31; wheel dispatch carries an honest delivery note | `docs/backups/P1-06/main_agentRpc.js` |
| `mcp/min-agent-mcp.js` | `browser_mouse` tool + screenshot schema v2; screenshot metadata text block extended (screenshotId/viewport/dpr/cssPerPixel/zoom/urlPath/timestamp) | `docs/backups/P1-06/mcp_min-agent-mcp.js` |
| `scripts/mcp-e2e.js` | census 31; screenshot metadata assertions; mouse move/scroll + unknown-screenshotId rejection over production stdio | `docs/backups/P1-06/mcp-e2e.js` |
| `scripts/agent-rpc-test.js` | census 31 | (same) |
| `package.json` | `probe:mouse` | `docs/backups/P1-06/package.json` |
| new scripts | `scripts/agent-mouse-probe.js`, `scripts/p1-06-live.js`, isolation harnesses `p1-06-isolate*.js`, `p1-06-perf2.js` | (new files, no backups needed) |

## 3. Screenshot schema & delivery evidence

Response: `{tabId, screenshotId ('ss<N>'), mimeType, bytes, width, height, coordinateUnits,
cssPerPixel, viewport {width,height,dpr,scrollX,scrollY}, zoom, urlPath, timestamp, data(base64)}`.
Evidence that actual image bytes traverse the production path:
- `node scripts/mcp-e2e.js` (stdio client): `browser_screenshot -> PNG image block (magic, mime,
  size)` PASS — the image block data begins with the real PNG magic and decodes; metadata block
  verified with screenshotId/viewport/dpr/cssPerPixel.
- Live: `docs/live-example-com.png` (320 790 bytes) and `docs/live-hn.png` (1 212 325 bytes) are
  the decoded bytes of live screenshots received through the same path.

## 4. Mouse tools & coordinate contract

Unified `browser_mouse` (31st bridge tool). Coordinate space: **viewport CSS pixels** relative to
the target view; screenshot→action mapping = `x_css = x_screenshot / cssPerPixel`. Every action
requires an explicit `tabId`. Optional `screenshotId`: coordinates are rejected with
`ref_stale` when the document (origin+pathname), viewport size, devicePixelRatio, zoom, or scroll
offsets changed since the screenshot (tolerance 2px). Out-of-bounds → structured `invalid_params`
including the bounds. Dispatch acceptance is reported as `dispatched: true` and explicitly does
not prove page effect (verification is the caller's next step — semantic tools preferred).

## 5. Smooth path bounds/timing & cleanup

- `movePath`: steps = clamp(durationMs/16, 2, 240); deterministic easeInOut; bounded
  durationMs ≤ 5000; instant mode = 1 dispatch. Per-tab busy lock → second concurrent job gets
  `busy`. Total-time guard timer bounds every job; failure → `agentRpcMouseAbort` (bounded button
  release + lock release).
- Cleanup verified: navigation and tab close abort jobs and release pressed buttons
  (probe: 'navigation clears pressed/busy state'); status action exposes pressed/busy/last.
- Measured (perf run on the loopback fixture): mouse move RTT 1–2 ms; movePath smooth 500 ms
  duration → ~790–930 ms end-to-end including RPC; PNG screenshot ≈ 75 ms ≈ 49 KB base64
  (viewport); JPEG q80 1024w ≈ 83–93 ms ≈ 7.4 KB.

## 6. Page-level input vs OS-global cursor (mandatory distinction)

- **Page-level (Electron `sendInputEvent`)** — IMPLEMENTED and verified: clicks (left, and
  right-click reaching the page's contextmenu handler), explicit down/up with pressed-state
  tracking, hover without clicks, drag dispatch, scroll dispatch. Verified at page level via
  independent fixture state ('Clicked: 1', 'Pressed: yes/no', 'Ctx: yes', 'Hover: on box').
- **OS-global Windows cursor** — **NOT_IMPLEMENTED**. Moving the real Windows cursor requires a
  native `SendInput`-style mechanism; no safe in-repu provider exists and no native dependency
  was added. Page-level input events do NOT move the OS cursor — reported separately, never conflated.
- **Synthesized wheel (`mouseWheel`) and standalone `mouseMove` delivery**: verified delivered in
  minimal Electron windows (isolation harnesses `p1-06-isolate4/5/6/7`: single + cadence moves,
  WebContentsView + dual-view architecture, frameless window — all delivered). In Min's
  production window on this build/machine, dispatched standalone mouseMove/mouseWheel events are
  dropped by the compositor (bridge dispatch logs confirm every event leaves the bridge; the page
  counter stays at 0), while mouseDown/mouseUp (clicks) ARE delivered. Wheel dispatch therefore
  returns an honest delivery note pointing to `browser_scroll` (DOM-level, delivered) for actual
  scrolling. This is the one functional gap: smooth-path dispatch is complete and bounded, but
  page-level delivery of standalone moves could not be verified on the production window.

## 7. Test matrix (exact commands, exit codes, pass/total)

| command | exit | result |
|---|---|---|
| `npm run build` (+ syntax checks) | 0 | clean |
| `npm run test:agent-rpc` | 0 | **182/182** (census 31) |
| `npm run probe:mouse` (new) | 2 (see below) | **23/25** — 3 stable runs; the 2 FAILs are the page-delivery limitation above ('page received ordered path events', 'page registered drop INSIDE B'); everything else passes: click state change, hover-no-click, down/up, rightClick, wheel dispatch + honest note, real-scroll metadata, bounds/schema rejection, busy serialization, stale rejection + fresh acceptance, navigation cleanup, explicit-tab isolation |
| `node scripts/mcp-e2e.js` | 0 | **56/56** (census 31; image block; metadata; mouse over stdio; stale rejection over stdio) |
| `npm run probe:transform` / `probe:pav` / `probe:inputs` / `probe:captcha` / `probe:waits` / `probe:downloads` | 0 | 18/18, 15/15, 20/20, 14/14, 16/16, 33/33 |
| `npm run probe:tabs` ×5 | 0 | 16/16 each |
| `probe:agent-actions` / `agent-snapshot` / `nps` | 0 | 33/33, 27/27, 38/38 |
| `probe:capture` / `detach`, `smoke:baseline` ×3 | 0 | 0, 0, 6/6 ×3 |
| stray electron processes | — | 0 |
| ad-blocker invariant | — | exactly 1 effective `onBeforeRequest` (main/filtering.js:272); bridge registers 0 |

## 8. Live validation (scripts/p1-06-live.js — 7/7 PASS)

- example.com: live screenshot → real PNG bytes + full metadata (saved `docs/live-example-com.png`);
  click-flow navigation to iana.org verified (`finalUrl` contains iana.org).
- news.ycombinator.com: live screenshot → real PNG (saved `docs/live-hn.png`); hover caused no
  navigation (no side effects); **stale screenshot coordinates rejected live (`ref_stale`) after a
  scroll; fresh screenshot coordinates accepted** (hover dispatched).
- Performance (measured): see section 5.

## 9. Invariants confirmation

Downloads (33/33 probe + e2e), transforms (18/18), navigation (nps 38/38), tabs, capture/detach,
extensions host (extension probes untouched), ad/tracker blocking: single `onBeforeRequest`
handler intact; no leaked processes (0 electrons after gates), no leaked listeners/timers/jobs
(abort paths verified).

## 10. Limitations & gate decision

- Public long-transfer wheel scrolling via synthesized wheel is dropped by the compositor in Min
  production window (verified; DOM-level `browser_scroll` remains fully functional and is what
  agents should use for scrolling).
- Standalone synthesized mouseMove delivery to the renderer is unreliable in Min's production
  window on this build/machine (click/down/up ARE delivered; the identical dispatch delivers in
  minimal Electron windows). movePath/drag therefore remained **page-delivery-unverified** in the
  production window (dispatch verified, serialization verified).
- OS-global cursor: NOT_IMPLEMENTED (separate, honestly reported).
- Zoom/devicePixelRatio parameter matrix exercised only at default zoom.

### Gate decision: **PARTIAL PASS** ✅⚠️

Mandatory local regressions pass; real screenshots traverse the production MCP transport as
actual image content to the client (verified live + e2e); page-level mouse is verified for
clicks/press/release/hover-no-click/right-click with coordinate + staleness semantics. The
missing slice for full `PASS` is page-level delivery of smooth standalone mouse moves inside
Min's production window (compositor drop, isolated and documented above), which could not be
independently verified here. No P1-07 work started.
