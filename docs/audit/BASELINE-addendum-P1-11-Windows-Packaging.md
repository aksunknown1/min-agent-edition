# P1-11 — Windows Packaging & Final Release Validation (Audit Addendum)

Date: 2026-10-18 · **Gate: PASS** (release-ready with documented, honest limitations)

## 1. Artifacts (`dist/app/`, all `npm run buildWindows` exit 0)

| artifact | bytes | sha256 (prefix) |
|---|---|---|
| Min-v1.35.7-windows.zip (x64) | 169,858,160 | 2fd0dda339dced96b907f47a3ce46de206878c1e052b4ca6b20d34b783eef902 |
| min-1.35.7-setup.exe (x64 Squirrel installer) | 161,914,368 | 77e13bd9fca2ab9f4efdfcf7009a0e7ef6966c7c3a8f3a9e821169d4d67d82e4 |
| Min-v1.35.7-windows-ia32.zip / min-1.35.7-ia32-setup.exe | 146,934,483 / 140,392,960 | 388f81a8… / 8a97b428… |
| Min-v1.35.7-windows-arm64.zip / min-1.35.7-arm64-setup.exe | 167,824,032 / 158,418,944 | 58536690… / ae179e6c… |
- Architecture: x64 (validated), ia32 + arm64 (built, not launch-validated — no hardware/VM).
- **Code signing: NOT performed** (honest). electron-builder `signAndEditExecutable:false`
  was required because the winCodeSign tool archive contains darwin symlinks that 7-Zip
  cannot create without Windows admin/Developer-Mode privilege; the shipped Min.exe keeps
  the stock Electron icon/version resource. Product identity verified via packaged
  metadata + runtime (`browser_status` app.name=Min, version 1.35.7, dedicated
  user-data root).
- Packaged from `dist/app/win-unpacked/resources/app` — `main.build.js` at root with all
  3 P1-11 markers, `SKILL.md` shipped at `resources/SKILL.md`.

## 2. Changed files & backups

| file | change | backup |
|---|---|---|
| `scripts/createPackage.js` | win.signAndEditExecutable:false (env blocker, documented in-file); extraResources → ships SKILL.md (electron-builder cannot un-ignore `!**/*.md`) | `docs/backups/P1-10/createPackage.js.pre-p111` |
| `main/agentRpc.js` | 3 minimal typed fixes (see §5) | `docs/backups/P1-11/agentRpc.js.pre-p111` |
| `mcp/min-agent-mcp.js` | schema: expose transform restore via transformId/selector | `docs/backups/P1-11/min-agent-mcp.js.pre-p111` |
| `scripts/agent-pav-probe.js` | pipe-drain (P1-10, reused) | `docs/backups/P1-10/agent-pav-probe.js.pre-p110` |
| repo root junk removed | `%TMP%`, `%TMP%p63-cdr7.log`, `%TMP%p63-cdr8.log` (stray probe logs), `404"` (0-byte, filename with quote = invalid OPC part → Squirrel installer crash), `p1-04-tr-cmd-dump.txt` (debug dump shipped in package) | deleted (accidental artifacts; contents quoted in work log) |
| `RELEASE_NOTES.md` | new | new file |
| new test scripts | `scripts/p111-*.js` (coldstart-accept, packaged-filter-test, space-path-test, api/jig debuggers) | new files |

**No agent-browser contract changes beyond the documented transform restore fixes.**

## 3. Packaged-resource audit

| resource | status |
|---|---|
| `main.build.js` + all preloads/renderer (`dist/preload.js` etc.) | present, syntax OK |
| `filterUpdate.js` resolved from packaged main process | ✓ (runtime updater ran inside packaged app) |
| `ext/abp-filter-parser-modified/` + bundled lists (`minFilters.txt`, combined EasyList+EasyPrivacy 108,444 non-comment rules) | present & readable |
| runtime filter cache under `userData/filterCache/` | ✓ (created by packaged updater) |
| managed downloads under `userData/agent-downloads/` | ✓ (file verified on disk) |
| `SKILL.md` | `resources/SKILL.md` |
| exclusions | docs/, scripts/, extensions/, main/ (bundled), private data — none present |
| install path with spaces | PASS (dedicated test: launch + bridge up from `…p111 spaced dir\Min\Min.exe`) |

## 4. Cold-start acceptance (packaged app + SHIPPED MCP adapter, fresh profile): **30/30**

Production flags (development:false), discovery, 31 tools, tabs/navigate
`https://example.com` verified, content, snapshot refs, **real screenshot image block
received and saved**, SKILL-policy workflow on a local fixture, transform
apply→verify→restore_target→verify-original, managed download (direct mode) completed
with `relPath` under the approved root + `browser_downloads` managed-list entry, no dev
extension fixtures, no experimental settings, targeted PID cleanup, **no orphan
processes**. Evidence: `docs/p111-runs/packaged-screenshot.png`,
`docs/p111-coldstart-accept.json`.

## 5. Transform-restore API gap found and fixed (production, justified by Phase 8 rules)

Reproducible blocker: through MCP, `replace_text` could never be restored — record
stored no `ref` (op envelope dropped it), record also lacked role/name/nameIndex, the
identity check treated the transform's own text change as drift, and the documented
transformId restore path was stripped by the MCP schema. Fixes (all typed, all
verified in source AND packaged artifact):
1. op envelope carries `ref` (`main/agentRpc.js`)
2. record persists role/name/nameIndex (`main/agentRpc.js`)
3. `restore_target` identity check keeps ordinal+role, tolerates self-transformed name (`main/agentRpc.js`)
4. MCP schema exposes `transformId` + `selector` targeting (`mcp/min-agent-mcp.js`)

Regressions after fixes: build 0, transform probe 18/18, RPC 182/182, MCP e2e 56/56,
P1-10 API matrix re-run 90/90, packaged restore proven end-to-end.

## 6. Filtering + updater in the packaged app

- Cold start on the block fixture: known-harmless request **blocked** from the bundled
  list (page-side DOM error evidence), benign loopback image loads (scoped blocking).
- Runtime updater (startupDelayMs 30s) performed a **real HTTPS update inside the
  packaged app** → `userData/filterCache/`: combined 2,906,612B sha256(seen 16)
  124c6a57…, part-easylist 2,192,380B, part-easyprivacy 1,509,923B, meta.json.
- Updater failure → last-known-good: 18/18 engine tests (`scripts/p1-07-updater-test.js`).
- Offline-boot simulation: **ENVIRONMENT_BLOCKED** (no admin/OS network control path);
  impact low (failed-fetch rollback proven; bundled fallback ships).
- Listener invariant: single `onBeforeRequest` registration (`main/filtering.js:293`);
  bridge registers none (comments only).

## 7. Extensions in production

Core browsing fully functional with the experimental extension host disabled (default,
settings verified); no fixture pages; no sandbox weakening; extension-host failure never
crashed launch. Claims kept honest per RELEASE_NOTES (Dark Reader one recorded test,
uBOL unattributed, no manager/store, not universal CWS).

## 8. Full regression matrix (exact commands, post-fix)

| command | result |
|---|---|
| `npm run build` / `node --check main.build.js` | exit 0 / OK |
| `npm run buildWindows` (final) | exit 0 |
| `npm run test:agent-rpc` | 182/182 |
| `node scripts/mcp-e2e.js` | 56/56 (image content) |
| `node scripts/p110-api-matrix.js` (re-run post-fix) | 90/90 |
| `node scripts/p111-coldstart-accept.js` | 30/30 |
| `node scripts/p111-packaged-filter-test.js` | 2/2 + updater evidence |
| `node scripts/p111-space-path-test.js` | PASS |
| `npm run probe:transform` / `probe:downloads` | 18/18 / 33/33 |
| `npm run probe:pav` | 15/15 (isolated; chain-run flake documented) |
| `probe:tabs` / `probe:inputs` / `probe:waits` / `probe:captcha` | 16/16 / 20/20 / 16/16 / 14/14 |
| `probe:agent-actions` / `agent-snapshot` / `probe:nps` | 33/33 / 27/27 / 38/38 |
| `npm run probe:mouse` | 26/27 (documented wheel platform limit) |
| `node scripts/p1-07-updater-test.js` | 18/18 |
| `npm run smoke:baseline` | 6/6 |
| `probe:capture` / `probe:detach` / `probe:two-url-argv` | visibleCaptureOk+hiddenRejectionHandled / guardBlocksDeadlyCapture:true / allPassed:true (report-style) |
| `node scripts/extension-probe.js` | report-style evidence, runs completed, cleanup true |
| P1-09.1 schema audit | 0 invalid tool names (SKILL.md) |
| lingering processes | 0 (targeted kills throughout) |

## 9. Remaining limitations (honest)

- Unsigned artifacts; no exe icon/version stamping (env blocker documented above).
- ia32/arm64 built but not launch-validated (no target hardware).
- OS-level offline boot not exercisable (no admin); failed-fetch rollback proven at engine level.
- Mouse wheel/durable hover platform-limited; `browser_scroll` reliable; no OS-global cursor.
- Extensions: dev-only loading, no manager, attribution limits — per RELEASE_NOTES.
- `probe:pav` shows occasional startup contention when run inside long probe chains with
  back-to-back Electron launches; isolated runs are stable 15/15.

## 10. Gate: **PASS**

Real Windows artifact (x64 zip + unsigned installer) launches cold with a dedicated
profile and completes mandatory core workflows (navigation, MCP image delivery,
transforms, managed downloads, filtering with bundled fallback + real update), correct
packaged-resource resolution (including the filterUpdate.js + parser/list fix that
required the API repair), mandatory regressions pass, and all known limitations are
documented rather than hidden.
