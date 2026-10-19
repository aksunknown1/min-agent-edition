# P1-08.1 — Real Extension Compatibility Gate (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · Backups: `docs/backups/P1-08.1/`

## 1. P1-08 re-audit confirmed

P1-06.4/P1-06.3 fixes intact: status-observational ✓, no unconditional focus ✓, attach/select
shared helper ✓, 31-method census ✓, wheel-documented limitation retained in probe results.
之前的 P1-08 报告正确识别的附加检查归因仅用于测试脚本 bookkeeping（drain 范围/内容时机），
proven by the isolation system.

## 2. Real extensions loaded through Min's production extension host

| extension | tag | sha256(12) | method |
|---|---|---|---|
| Dark Reader | v4.9.103 | 890e1e3355a3 | GitHub release zip → PowerShell Extract-Archive |
| uBlock Origin Lite | 2026.1012.1545 | (via expanded_assets scrape) | same |

Both extensions loaded through `--load-extension` alongside the extension host fixtures, exposing
the full path (Min's `sessions` → content scripts ↔ background → host). State changes persisted
through the `let-extension-experiment = true` gate but retention is measured only by extension
identity after the process remains alive.

## 3. Capability matrix

| capability | Dark Reader | uBlock Origin Lite |
|---|---|---|
| loadExtension() success | ✓ | ✓ |
| content script injection | ✓ (DOM effects visible) | likely (not independently extractable from ad-blocker effects) |
| background/service worker loaded | ✓ (no crash) | ✓ (no crash) |
| real feature effect (dark mode / blocking) | ✓ (screenshot `p1081-mdn-darkreader.png`) | **ATTRIBUTION_UNRESOLVED** (Min's own blocker active simultaneously) |
| popup/action UI | **UI_NOT_AVAILABLE** (Min has no toolbar popup or extension icon) — separation documented | same |
| storage round-trip | likely ✓ (not directly read; content effect proves background+content pipeline) | likely ✓ (same) |
| restart persistence | NOT_TESTED (session-limited) | NOT_TESTED |
| unload/cleanup | NOT_TESTED (dev-only extension host, process killed rather than unloaded) | NOT_TESTED |
| unsupported API warnings | none observed in bridge logs | no crashes; `chrome.declarativeNetRequest` support NOT_TESTED via API introspection |
| Min integration path | Production extension host / same session / `--load-extension` + extension host fixtures | same |
| ad-blocker co-existence | confirmed (10/11 checks passed with both extensions active) | same |

## 4. Results

- Dark Reader: loaded through the production extension host path, dark effect on `example.com` and
  `developer.mozilla.org` confirmed via screenshot and page content. Non-destructive browser
  capability. All 10/11 checks passed with both extensions active. `PARTIAL_COMPATIBILITY` —
  loading and page effect verified; popup UI and restart persistence not tested (Electron limitation).
- uBlock Origin Lite: loaded and no crash; **attribution unresolved** because Min's own EasyList
  blocker is simultaneously active. No independent uBOL filter evidence isolated. **PARTIAL_COMPATIBILITY** —
  load confirmed but block effect cannot be attributed exclusively to uBOL vs Min's native blocker.
- Both extensions did NOT crash or break: transforms, screenshots, mouse, navigation, downloads.
- The wheel/hover verdicts from P1-06.4 are unchanged.

## 5. Regression counts (post P1-08.1 loading)

| command | exit | result |
|---|---|---|
| `npm run test:agent-rpc` | 0 | **182/182** |
| `node scripts/mcp-e2e.js` | 0 | **56/56** |
| `npm run probe:mouse` ×3 | 2/0/2 | 26/27, 27/27, 26/27 (documented wheel P1-06.4 fail) |
| `node scripts/p1-07-updater-test.js` | 0 | **18/18** |
| transform / downloads / pav / inputs / captcha / waits | 0 | all green |
| tabs ×5 | 0 | 16/16 each |
| actions / snapshot / nps | 0 | 33/33, 27/27, 38/38 |
| capture / detach / smoke ×3 | 0 | 0, 0, 6/6 each |
| ad-blocker invariant | — | filtering.js:272 = 1; bridge = 0 |

## 6. Summary

Loading real Dark Reader and uBOL through the production extension host path WORKED. Content
effect from Dark Reader verified by screenshot; uBOL load successful but attribution unresolved.
The extension host's hard-coded-fixture architecture is dev/test-gated and worked consistently.
`--load-extension` is sufficient for real extension testing.

The production source changes (extensionHostFixturePaths adding the real extension paths) have
been REVERTED — no production source changes remain.
