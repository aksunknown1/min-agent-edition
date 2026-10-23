# Min Agent Edition — RELEASE NOTES (v1.35.7 fork, agent edition)

Windows build 2026-10-18. This is a fork of Min 1.35.7 that adds an agent-facing
browser bridge and MCP adapter. **No security audit has been performed and the
artifacts are not code-signed.**

## What this fork adds

- **Agent bridge + 31 browser tools** over a runtime-token protected local HTTP bridge
  (`--agent-rpc`), with a standard **MCP stdio adapter** (`mcp/min-agent-mcp.js`) so any
  MCP-capable agent client can drive the browser: tabs, navigation (with post-load URL
  stability verification), DOM-first interaction (click/type/press/select/check via
  snapshot refs), semantic scrolling (`browser_scroll`), real screenshots, reversible
  page transforms, verification tools, CAPTCHA state reporting (detection is
  informational; challenge-control clicks go through the normal verified
  interaction path, with human handoff and page-state-verified clearance for
  genuine human challenges), and agent-managed
  downloads under `userData/agent-downloads/`.
- **MCP screenshot image delivery**: `browser_screenshot` returns a real image content
  block plus `screenshotId`, viewport and `cssPerPixel` metadata for grounded coordinate
  math.
- **Portable operating policy** shipped at `resources/SKILL.md` in the package (also at
  the repository root): an observe → decide → act → verify → re-plan loop with a
  DOM-first preference and an explicit screenshot fallback for sparse or contradictory
  observations (the "sparse DOM gate" pattern).
- **Reversible page transformations** (`replace_text`, `highlight`, `set_style`, `hide`)
  with exact original-state capture, drift reporting, and restore by snapshot ref,
  selector, or `transformId` (`restore_all` also available). Restore targeting now works
  through both the bridge and the MCP schema, including text restores of the transform's
  own target.
- **Agent-first downloads**: managed direct/adopt download modes with a bounded,
  structured wait (timeout returns `terminal:false` / `timedOut:true`; success returns a
  completed record with sanitized URL). Normal human downloads continue to flow through
  Min's own download handler.
- **Single-registrant content blocking**: exactly one effective
  `webRequest.onBeforeRequest` handler per session (`main/filtering.js`); the agent
  bridge never registers a competing handler.
- **Filter list runtime updater**: loads a bundled known-good
  EasyList/EasyPrivacy (no element hiding) list (≈108k non-comment rules), then updates
  from the approved HTTPS sources about 30s after startup (24h interval) into
  `userData/filterCache/` with atomic promote and last-known-good rollback. Verified in
  the packaged app: harmless test request blocked from the bundled list and a live
  HTTPS update fetched successfully (part files ≈2.2MB+1.5MB, combined ≈2.9MB).

## Known limitations (explicit)

- **Mouse-wheel page delivery is unreliable** on this Electron/OS combination
  (compositor-level drop); `browser_scroll` remains the reliable scrolling method.
- **Durable synthetic hover is not guaranteed** (transient physical-cursor re-assertion);
  **OS-global cursor movement is not implemented**.
- **Extension compatibility is limited and not universal**: there is **no user-facing
  extension manager or store-installation flow**. The experimental extension host (with
  fixtures/load-extension flows) is a development feature and is **off by default** in
  production launches. Dark Reader v4.9.103 darkened a real page through the development
  extension path in one recorded test; uBlock Origin Lite loaded but its blocking effect
  was not independently attributed (native blocker competes); popup UI, restart
  persistence and unload cleanup are incompletely tested. Do not assume universal
  Chrome Web Store compatibility.
- **Bounded ABP parser syntax support**: the fork bundles the same modified ABP parser
  Min uses; full ABP rule compatibility is not claimed.
- Real **offline-boot** validation (OS-level network cut with a pre-populated cache) was
  not exercised: environment lacks an admin/network-control path. The failed-fetch →
  keep-last-known-good path is covered at engine level (18/18 updater tests), and the
  bundled fallback list ships in the package, so offline boot degrades to bundled rules.
- **Mouse-wheel / hover** caveats as above; everything else in the regression matrix
  passed on the shipped artifact.

## Packaging status

<!-- P1-12 pending: package.json repository URL intentionally removed until the
     Min Agent Edition GitHub repository is created; re-add repository/homepage/bugs
     then. Distribution intent: GitHub Releases or workflow artifacts for installers. -->

- Pipeline: repository `npm run buildWindows` (electron-builder `dir` target →
  `dist/app/win-unpacked*`, then zip + `electron-installer-windows` setup.exe),
  architectures x64, ia32, arm64.
- **Distinct product identity (P1-11.1):** package id `min_agent_edition`, product name
  `Min Agent Edition`, executable `Min Agent Edition.exe`, default profile
  `%APPDATA%/Min Agent Edition`, artifacts `Min-Agent-Edition-*`. This fork never
  installs into, updates, uninstalls, or adopts the official Min install directory
  (`%LOCALAPPDATA%/min`), Squirrel package identity (`min`), or user profile
  (`%APPDATA%/Min`). Verified in the embedded Squirrel nuspec of the produced installer
  and by launch tests on a host where an original-Min profile was present (original
  profile byte-identical after launches).
- **Code signing: NOT performed.** Windows may show an unknown-publisher/SmartScreen
  warning for both the installer and the portable zip; unsigned does not mean unsafe,
  but signature alone must not be trusted either. electron-builder executable
  editing/signing was disabled in this environment (the winCodeSign tool archive
  contains darwin symlinks that 7-Zip cannot create without Windows
  admin/Developer-Mode privilege); the exe keeps the stock Electron icon/version
  resource — an intentional temporary limitation, replaceable through the existing
  pipeline once signing/rcedit tooling is unblocked. Do not interpret signature presence
  or absence as a security verdict.
- Resources verified in the package: `main.build.js` (root), `filterUpdate.js` (root),
  `dist/preload.js`, `ext/abp-filter-parser-modified/` + bundled filter lists
  (`minFilters.txt`, `easylist+easyprivacy-noelementhiding.txt`), `mcp/` adapter,
  `resources/SKILL.md`. Excluded: `docs/`, `scripts/`, `extensions/`, `main/` (bundled),
  private data, test accounts/fixtures and temporary artifacts.

## Verification summary (2026-10-18, this repository, Windows x64 host)

- Cold-start acceptance on the packaged app with a fresh dedicated profile: **30/30**
  (production flags, discovery, tabs/navigate https://example.com, content, snapshot,
  real screenshot image block, transform apply→verify→restore, managed download under
  `userData/agent-downloads/`, no dev extension fixtures, targeted cleanup, no orphans).
- CPU-adjacent probes: RPC 182/182, MCP E2E 56/56, transform 18/18, downloads 33/33,
  PAV 15/15 (isolated), inputs 20/20, waits 16/16, tabs 16/16, CAPTCHA 19/19 (P1-13
  policy-correction suite), actions
  33/33, snapshot 27/27, NPS 38/38, updater 18/18, smoke 6/6, mouse 26/27 (documented
  wheel limitation).
