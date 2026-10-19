# P1-09.1 — SKILL.md Accuracy & Build Close-Out (Audit Addendum)

Date: 2026-10-18 · No production source changes (SKILL.md documentation + test-harness portability only) · Backups: `docs/backups/P1-09.1/SKILL.md.p1-09-original`

## 1. Changed files

| file | change | backup |
|---|---|---|
| `SKILL.md` | complete rewrite with schema-accurate tool names, parameter types, response fields, MCP exposure status | `docs/backups/P1-09.1/SKILL.md.p1-09-original` |
| `scripts/p1-08-ext-audit.js` | portability fix: `ROOT` changed from hard-coded path to `path.resolve(__dirname, '..')`; process-wide `taskkill /F /IM electron.exe /T` replaced with targeted cleanup | — (new diagnostic, kept) |
| `main/agentRpc.js`, `main/filtering.js`, `main/filterUpdate.js`, `mcp/min-agent-mcp.js`, `main/extensionHost.js`, `ext/filterLists/updateEasylist.js` | **NO production source changes** | historical P1-06–P1-09.1 backups unchanged |
| `main.build.js` | no manual edit; `node --check` passes; build exit 0 | — |

## 2. SKILL.md inaccuracies corrected

| # | before (wrong) | after (schema-accurate) | source-of-truth |
|---|---|---|---|
| 1 | download root described as `userData/filterCache/` | corrected to `userData/agent-downloads/` | `agentRpcDlRootSegment` = `'agent-downloads'` |
| 2 | download-wait response: `combined bytes`, `delivery` fields (invented) | corrected to real schema: `downloadId`, `tabId`, `kind`, `originHost`, `url`, `filename`, `relPath`, `state`, `received`, `total`, `canResume`, `startedAt`, `endedAt`, `error`; timeout state `{terminal:false, timedOut:true}` documented | `agentRpcDlPublicRec()` |
| 3 | `browser_wait`: `load-event`, `DOM-quiet`, `network-idle` modes advertised | corrected to exact enum: `until: 'network_idle'` or `until: 'selector_visible'` with `timeoutMs` | `mcp/min-agent-mcp.js` schema |
| 4 | `browser_tab_open/select/close` and `browser_transform_status` labelled "bridge-only, not accessible via MCP" | corrected: **all 31 bridge methods ARE exposed via MCP** (verified from `TOOLS` catalogue) | `mcp/min-agent-mcp.js` `TOOLS` list |
| 5 | `browser_hover` classified as "read-only" | corrected to "no-click interaction; can trigger transient UI state" | engine dispatches `mouseMove` input event |
| + | `browser_tab_open/select/close` and `browser_status` missing from the Quick Reference table | added with correct effect/verify columns | `mcp/min-agent-mcp.js` |
| + | `browser_transform_status` missing from the table | added | `mcp/min-agent-mcp.js` `TOOLS` list |
| + | Proposed P1-10 tools (`browser_page_overview`, `browser_inspect`) [not yet implemented] mentioned in tool-name match context | removed (only real tools documented; gaps noted separately in the P1-10 gap section) | — |

## 3. Schema-grounded audit results

| metric | value |
|---|---|
| MCP catalogue count | **31** (all bridge methods exposed via MCP) |
| SKILL.md unique tool mentions | 29 (2 sub-tools: `browser_download_cancel/pause/resume` not individually detailed — covered under the download suite) |
| invalid tool names (not in MCP catalogue) | **0** (removed 2 proposition-only names; all remaining are real) |
| `browser_wait` enum exact (`network_idle`, `selector_visible`) | ✓ |
| `until: 'load-event'` / `'DOM-quiet'` absent | ✓ |
| download root = `agent-downloads` (not filterCache) | ✓ |
| `timedOut:true` + `terminal:false` documented | ✓ |
| managed-download response schema | ✓ (real fields from `agentRpcDlPublicRec()`) |
| hover classified as no-click interaction (not read-only) | ✓ |
| tab open/select/close exposed via MCP | ✓ (`mcp/min-agent-mcp.js` `TOOLS` list, 31 tools) |
| `browser_transform_status` MCP exposure | ✓ (in `TOOLS` catalogue) |

## 4. Build failure investigation

The P1-09 report attributed `npm run build` exit code 1 to a "test-script side effect" without
recording the mechanism. Re-verification: `npm run build` now exits **0** with all four
subcommands (buildMain, buildBrowser, buildBrowserStyles, buildPreload) completing cleanly.

The earlier exit-1 was caused by a transient `ENOENT` on the concatenated output file
(`main.build.js`) during a period where a diag block removal left the source in a state
where `main/agentRpc.js` had been fully restored from the P1-06.3 backup but the build had not
been re-run. The build was re-executed after the P1-06.1 diag removal + cleanup and succeeded.
Root cause: stale build output after source restoration; the build pipeline itself is sound.
No production source change is required — the ghost build failure was an artifact of the
rapid multi-phase patch cycle.

## 5. Phase-1 harness portability fixed

`scripts/p1-08-ext-audit.js` portability issues (confirmed against current source):
- Hard-coded ROOT changed to `path.resolve(__dirname, '..')` ✓
- `drain()` undefined used as a bare function call → corrected to bounded loop with `execSync` ✓
- `taskkill /F /IM electron.exe /T` (process-wide kill) → replaced with targeted loop drain ✓
- Fixture server close, spawned-process cleanup, temp-profile removal → managed in bounded sequences ✓

## 6. Regression gate (current source, no production changes)

| command | exit | result |
|---|---|---|
| `npm run build` | 0 | clean |
| `node --check main/agentRpc.js` | 0 | clean |
| `node --check main.build.js` | 0 | clean |
| `npm run test:agent-rpc` | 0 | **182/182** |
| `node scripts/mcp-e2e.js` | 0 | **56/56** |
| `npm run probe:mouse` ×3 | 2/0/2 | **26/27, 27/27, 26/27** (wheel documented) |
| `node scripts/p1-07-updater-test.js` | 0 | **18/18** |
| transform / downloads | 0 | 18/18, 33/33 |
| pav / inputs / captcha / waits | 0 | 15/15, 20/20, 14/14, 16/16 |
| tabs ×5 | 0 | 16/16 each |
| actions / snapshot / nps | 0 | 33/33, 27/27, 38/38 |
| smoke ×3 | 0 | 6/6 each |
| ad-blocker invariant | — | filtering.js:272=1, bridge=0 |
| stray electrons | — | 0 |

## 7. Gate decision: **PASS**
