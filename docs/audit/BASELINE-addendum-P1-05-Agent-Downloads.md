# P1-05 — Agent-First Downloads (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · Backups: `docs/backups/P1-05/`

## Audit findings (Phase 1)

- Human downloads: `main/download.js downloadHandler` on `session.defaultSession` (app ready) and
  every `session-created`; never calls preventDefault/setSavePath → native save dialog + Min
  download UI (`download-info` / `cancelDownload` IPC). This path is untouched except for the
  hoisted ownership hook at its top.
- Bridge: pre-existing ADDITIVE observational `will-download` listener
  (`agentRpcEnsureDownloadTracking`, all sessions via `session-created`; `defaultSession` now also
  hooked at bridge start). No listener count grew: total will-download listeners per session
  remains exactly 2 (human handler + bridge observer); managed decisions are centralized into the
  human handler path via `agentRpcDownloadManagedHook` (same hoisted-hook pattern as P1-01D's
  ad-blocker bridge).
- Zero new `webRequest` registrations; the single effective `onBeforeRequest` handler remains
  `main/filtering.js:272` (grep-verified: 1 effective registration in filtering.js, 0 in the bridge).

## Critical Electron-43 finding (verified with an isolation harness)

`event.preventDefault()` inside `will-download` tells Electron to abandon its own transfer —
the DownloadItem then terminates immediately with `done=cancelled` and zero bytes, in ALL start
paths (webContents.downloadURL, page location=, anchor click, session.downloadURL). The correct
dialog-suppressing mechanism on this version is `item.setSavePath()` alone, which both avoids the
dialog and lets the transfer proceed. Harness evidence: `scripts/p1-05-isolate.js`,
`p1-05-isolate2.js` (preventDefault → all four variants done=cancelled) and `p1-05-isolate3.js`
(no preventDefault → A/B/C all done=completed with correct file on disk; D `session.downloadURL`
never fires will-download on a partition session and is NOT used by the implementation).
This is documented in `docs/P1-05-DESIGN.md` and drives the implementation.

## Implementation (changed files)

| file                                              | change                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main/download.js`                                | 5-line hook at the top of `downloadHandler`: `agentRpcDownloadManagedHook()` decides ownership; adopted downloads are managed silently, everything else keeps the exact human flow                                                                                                                                                                                                                                                                            |
| `main/agentRpc.js`                                | P1-05 block: relPath/name safety (drive/UNC/traversal/device-name/invalid-char rejection, containment via resolve+relative compare + lstat symlink walk, deterministic collision suffix), intent/adoption model (direct `wc.downloadURL()` intent or armed-tab page-trigger adoption), managed registry (100 cap, 1h expiry, bounded sweep), 5 new commands, extended `browser_downloads`, census 25→30, schemas, dispatcher, defaultSession observation hook |
| `mcp/min-agent-mcp.js`                            | 5 new tools (25→30) with typed schemas; scalar-only args                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scripts/mcp-e2e.js`, `scripts/agent-rpc-test.js` | census 30; `browser_downloads` extended-shape note                                                                                                                                                                                                                                                                                                                                                                                                            |
| `package.json`                                    | `probe:downloads`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mcp/README.md`                                   | tool inventory updated                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Behavior (tools)

`browser_download_start {tabId, url, relPath?}` (direct; bounded 20s adoption), or
`{tabId, armMs, relPath?}` (page-triggered adoption, bounded 1s–120s) → `{ok, downloadId, filename,
relPath, state, total}`. `browser_download_wait {downloadId, timeoutMs≤120000}` → terminal record
or structured non-terminal `{timedOut}`. `browser_download_cancel` → confirmed through the actual
`done` event (bounded 5s), never pre-claimed. `browser_download_pause` / `browser_download_resume`
→ honest capability results via DownloadItem state/canResume. `browser_downloads` → observation +
managed lists. Destination in output is root-relative; URLs echoed as origin+pathname only (query
strings dropped — signed URLs never echoed). Unknown `downloadId` → structured
`download_not_found`.

URL policy: http/https only (inherits the bridge URL validator), embedded credentials rejected,
`javascript:`/`file:` rejected, malformed URLs rejected. No general filesystem MCP APIs were added.

## Test matrix (exact commands, exit codes, pass/total)

| command                                                              | exit | result                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build` (+ `node --check main/agentRpc.js`, `main.build.js`) | 0    | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run test:agent-rpc`                                             | 0    | **182/182** (census 30)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run probe:downloads` (new)                                      | 0    | **33/33** — traversal/drive/UNC/device-name/nested-traversal rejections; js:/file:/credentials rejections; direct download → on-disk verify (size byte-exact) under root; hostile Content-Disposition name sanitized (contained); parallel isolation; collision suffix; cancel (confirmed, sibling unaffected); pause/resume true-resume full size; resume honesty; arm+click site-trigger adoption on disk; expired arm → structured timeout; unique ids |
| `npm run probe:transform`                                            | 0    | 18/18                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run probe:pav`                                                  | 0    | 15/15                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run probe:inputs`                                               | 0    | 20/20                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run probe:captcha`                                              | 0    | 14/14                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run probe:waits`                                                | 0    | 16/16                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run probe:tabs` ×5                                              | 0    | 16/16 each                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run probe:agent-actions`                                        | 0    | 33/33                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run probe:agent-snapshot`                                       | 0    | 27/27                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run probe:nps`                                                  | 0    | 38/38                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run probe:capture` / `probe:detach`                             | 0    | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `npm run smoke:baseline` ×3                                          | 0    | 6/6 each                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `node scripts/mcp-e2e.js`                                            | 0    | **52/52** (30-tool census green)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| leftover electron processes                                          | —    | 0                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ad-blocker invariant                                                 | —    | exactly 1 effective `onBeforeRequest` (main/filtering.js:272); bridge registers 0                                                                                                                                                                                                                                                                                                                                                                         |

## Live validation (docs/live-downloads-validation.json; scripts/p1-05-live-downloads.js)

- L1 PASS — live direct download (raw.githubusercontent.com/microsoft/vscode README.md) completed,
  on disk at `<root>/live/readme.md`, nonzero, content verified (markdown header contains
  "microsoft/VS Code").
- L2 PASS with note — live large transfer (speed.cloudflare.com, then nbg1-speed.hetzner.com
  100MB.bin) reached `interrupted` within ~1s on this network on every attempt; interrupted state
  recorded honestly, waiter resolved, no hang. The live cancel-on-progressing attempt is
  **ENVIRONMENT_LIMITED** (network cuts long transfers before a cancel window exists). Cancel
  capability itself is fully verified against the real Electron DownloadItem on the loopback
  fixture (probe:downloads: confirmed via done event, sibling isolation, honest record).
- L3 PASS — two parallel live downloads (TypeScript + Node READMEs) distinct ids, distinct files,
  both completed on disk, distinct sizes.
- H1 PASS — live page-flow download (github.com ZIP archive URL, no intent, no armed tab) was NOT
  adopted (managed list unchanged; hook declined ownership) and IS recorded in the observation
  list; human path (native save dialog) is code-identical to the pre-P1-05 flow. The dialog's
  visual interaction itself was not automated (no mouse/vision in scope — NOT_EXERCISED_LIVE for
  dialog UX; non-adoption is live-verified).

## Remaining limitations

- Live cancel-on-progressing is ENVIRONMENT_LIMITED (network interrupts long transfers ~1s); the
  capability is fixture-verified (real DownloadItem interaction, not a mock).
- Restore after a BR-only element replacement flattens line breaks (minor fidelity note, P1-04 lineage).
- `session.downloadURL()` is not used (its will-download behavior on partition sessions is
  unreliable in Electron 43 — verified by isolation harness D).
- Page-triggered downloads are correlated per armed tab/webContents within the arm window; an
  unrelated download triggered in the same tab inside the window would be adopted (documented).

## Gate decision: **PASS**

Mandatory local integration/regression checks pass; a managed download was independently verified
on disk inside the approved root locally AND live (3 real-public files); human-flow non-adoption
live-verified; listener/ad-blocker invariants intact. The only missing live sub-case
(cancel-on-progressing live) is demonstrably environment-blocked per the documented attempts, with
the capability itself fixture-verified on the real Electron integration (not a mock) — recorded
rather than hidden.
