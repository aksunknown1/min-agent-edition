# P1-05 Design — Agent-First Downloads

## Audit summary (verified against this fork, Electron 43.4.1)

- Human downloads: `main/download.js` → `downloadHandler` on `session.defaultSession` (app ready)
  and every `session-created`. It never calls `event.preventDefault()`/`setSavePath`,
  so Electron shows the native save dialog; progress is IPC'd to the UI (`download-info`,
  cancel via `cancelDownload`). This is the behavior that must stay untouched.
- Bridge (P1-01): `agentRpcEnsureDownloadTracking` adds a SECOND, additive `will-download`
  listener per session (observes filename/bytes/state, bounded 50-record list) —
  feeds the existing read-only `browser_downloads`. Only sessions created after the
  bridge registers (`persist:webcontent` for all agent views) are hooked; `defaultSession`
  is not.
- Multiple `will-download` listeners are legal (EventEmitter semantics; only the
  webRequest family is single-slot). No listener is added in this phase — managed-decision
  ownership is centralized INTO the existing human handler path (same pattern as the
  P1-01D ad-blocker hook): `download.js downloadHandler()` calls the hoisted bridge hook
  first; if the hook returns true the download is agent-owned and the human path returns
  early (no save dialog — the hook already called `event.preventDefault()` + `setSavePath`).

## Managed model

- `browser_download_start {tabId, url, relPath?}` — DIRECT mode: validate URL
  (http/https via the existing `agentRpcValidateUrl` policy; reject embedded
  credentials and non-browser schemes), create a short-lived (30s) intent bound to the
  view's webContents + session, call `wc.downloadURL(url)`. The will-download hook matches
  the intent (same originating webContents/session, first matching event, bounded window),
  adopts it: `preventDefault()` + safe `setSavePath()` → resolves with a stable
  `downloadId`. Bounded 20s adoption timeout → structured `timeout` error, intent dropped.
- `browser_download_start {tabId, armMs}` — ADOPT mode (page-triggered): arms the tab for
  `armMs` (bounded 1s..120s). The next `will-download` originating from that view/session
  is adopted as a managed job; the call resolves when the download starts (or a structured
  timeout). Page-initiated downloads NOT armed keep 100% human behavior (dialog, UI).
- `browser_download_wait {downloadId, timeoutMs≤120000}` — bounded wait for a terminal
  state (completed / cancelled / interrupted / failed). Clean waiter cleanup; timeout
  returns a structured result, never hangs.
- `browser_download_cancel {downloadId}` — cancels ONLY the requested managed job;
  confirmation via the actual `done` event (`cancelled`), bounded 5s confirmation window.
- `browser_download_pause` / `browser_download_resume` — only when `DownloadItem` allows;
  `resume` checked with `canResume()`; an unsupported resume returns an honest structured
  result (a restart is never reported as a resume).
- `browser_downloads` — extended: existing observation list PLUS managed jobs list
  (states, bytes, destinations relative to the root, capabilities).

## Destination & filesystem safety (all managed writes)

- Root: `<profile userData>/agent-downloads` (created lazily).
- `relPath` must be: relative, no drive/UNC prefix, no `..` segments, no reserved Windows
  device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9 per segment), no invalid chars
  (`<>:"|?*` + control chars), no trailing dot/space per segment, ≤30 segments/≤240 chars.
- Containment proven by `path.resolve` + `path.relative` (case-insensitive compare, not
  string prefix), plus an lstat walk rejecting symlink/junction intermediates.
- Server-supplied filenames (`item.getFilename()`, i.e. Content-Disposition) are
  sanitized: basename only, control/invalid chars → `_`, device names rejected,
  fallback `download.bin`.
- Collisions never overwrite: deterministic `name (N).ext` suffix.
- Destination returned as `relPath` under the root (no absolute paths in tool output).

## History & lifecycle

- Managed records capped at 100, expired 1h after terminal state (5-minute sweep).
- Tab close / renderer loss / app shutdown: the download item is session-owned and
  continues independently; the record keeps reporting; waiters resolve via item events
  or bounded timeouts (never dangle).
- Ad-blocker invariant: zero new `webRequest` registrations; the single effective
  `onBeforeRequest` handler remains `main/filtering.js`. No new `will-download`
  listener anywhere — total count stays exactly 2 (human handler + bridge observer).

## Tools & counts

New (5): `browser_download_start`, `browser_download_wait`, `browser_download_cancel`,
`browser_download_pause`, `browser_download_resume`. Census 25 → 30 (bridge + MCP adapter
+ tests updated together). `mcp/README.md` autonomy contract updated.
