# Min — Baseline Audit (P0-01)

Audited: 2026-10-16 (UTC). Agent Edition workspace: `C:\Users\AKS-PC\min-agent-edition`
Method: **no-git**. Source obtained as a ZIP archive; no clone, branch, or commit was created.

---

## 1. Source provenance (no git)

| Item                        | Value                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream project URL        | https://github.com/minbrowser/min                                                                                                             |
| Archive download URL        | https://codeload.github.com/minbrowser/min/zip/refs/tags/v1.35.7                                                                              |
| Archive filename (local)    | `min-v1.35.7-source.zip`                                                                                                                      |
| Archive size                | 7,367,915 bytes                                                                                                                               |
| Archive SHA-256             | `a07293bf9bc5b6253ced0447f94ad8c77b80193609cca602f6a6c28b4b60cae0`                                                                            |
| Download date (UTC)         | `2026-10-16T05:53:56Z`                                                                                                                        |
| HTTP status                 | `200`                                                                                                                                         |
| Release tag                 | `v1.35.7` (GitHub release id 375326751, published 2026-08-23T21:22:49Z)                                                                       |
| Release `target_commitish`  | `1.35.x`                                                                                                                                      |
| Commit SHA embedded in ZIP  | `c92079cde045c38ab844e53501e9c5178d503a45`                                                                                                    |
| `package.json` `version`    | `1.35.7`                                                                                                                                      |
| Archive top-level directory | `min-1.35.7/`                                                                                                                                 |
| Archive file count          | 300 entries                                                                                                                                   |
| Main directory in workspace | **workspace root** — archive contents were flattened one level up, so `package.json` sits at `C:\Users\AKS-PC\min-agent-edition\package.json` |

Flatten command (Git Bash):

```bash
for e in min-1.35.7/* min-1.35.7/.[!.]*; do mv "$e" .; done; rmdir min-1.35.7
```

### Proof the source tree is unmodified

The archive was re-extracted to a pristine copy and diffed against the workspace:

```bash
diff -rq --exclude=node_modules --exclude=dist --exclude=main.build.js \
         --exclude=package-lock.json --exclude=min-v1.35.7-source.zip \
         "C:/Users/AKS-PC/min-agent-edition" /tmp/minpristine
# (no output)  -> exit 0, zero differing files
```

Zero tracked source files differ from the archive. No backups were created (none needed — nothing was overwritten).

---

## 2. Runtime versions

### Installed from PATH

| Tool                 | Version    | Path                           |
| -------------------- | ---------- | ------------------------------ |
| Node                 | `v24.19.0` | `C:\Program Files\nodejs\node` |
| npm                  | `11.17.0`  | `C:\Program Files\nodejs\npm`  |
| Electron (installed) | `43.4.1`   | `node_modules/electron`        |

### Declared by the repository

| Source                                              | Declared value                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `.nvmrc`                                            | `15.7.0`                                                                                        |
| `package.json` → `engines`                          | **absent** — no `engines` field exists                                                          |
| `package.json` → `electronVersion`                  | `43.4.1`                                                                                        |
| `package.json` → `devDependencies.electron`         | `43.4.1` (pinned, exact)                                                                        |
| `package.json` → `devDependencies.electron-builder` | `^24.13.3`                                                                                      |
| `.npmrc`                                            | `node-linker=hoisted`                                                                           |
| CI `.github/workflows/build-packages.yml`           | `actions/setup-node@v4` with **`node-version: 25`**, install step `npm install --omit=optional` |

### Runtime decision — Node 24 (the already-installed runtime) was used

Justification from repository evidence, not assumption:

1. **CI is authoritative.** The only workflow in the repo pins `node-version: 25`. Node 24 is the nearest even-LTS line to it, so the installed `v24.19.0` is inside the range upstream actually builds against.
2. **`.nvmrc` (`15.7.0`) is stale and provably wrong.** It contradicts CI, and it is internally inconsistent with the repo itself: `.npmrc` sets `node-linker=hoisted`, an npm 7+ option that Node 15.7.0's bundled npm 7.5.x barely supports and that Electron 43 does not work with. Electron 43's own minimum Node baseline is far above 15.
3. **No `engines` field** means npm performed no engine enforcement either way; the choice was ours to justify, and CI evidence pointed at modern Node.
4. **Empirically confirmed:** install, build, and a real GUI launch all succeeded on `v24.19.0` (see §4–§6). Node 24 is therefore _validated for this baseline_.

Node v24 was **not** assumed valid a priori — it was selected from CI evidence and then verified by a green install, build, and launch.

---

## 3. Architecture map — exact file paths

All paths relative to `C:\Users\AKS-PC\min-agent-edition\`.

### 3.1 Electron main process entry

| Item                                   | Path                                                             |
| -------------------------------------- | ---------------------------------------------------------------- |
| Declared entry (`package.json` `main`) | `main.build.js` — **generated**, not source                      |
| Real entry source                      | `main/main.js`                                                   |
| Bundle recipe (concatenation list)     | `scripts/buildMain.js` (`modules` array, lines 6–28)             |
| Window lifecycle                       | `main/windowManagement.js`                                       |
| Menu / keyboard                        | `main/menu.js`, `main/remoteMenu.js`, `js/defaultKeybindings.js` |

`scripts/buildMain.js` builds the main process by **naive string concatenation** of the listed files into `main.build.js`. There is no bundler, no module boundary, and no scope isolation between main-process modules — they share one global scope.

Boot anchors in `main/main.js`:

- `main/main.js:60` — dev-mode userData redirection (`app.setPath('userData', app.getPath('userData') + '-development')`)
- `main/main.js:64` — `app.commandLine.appendSwitch(...)`
- `main/main.js:157` — `createWindow(customArgs)`
- `main/main.js:192` — `createWindowWithBounds(bounds, customArgs)`
- `main/main.js:214` — `new WebContentsView(...)` (browser chrome view)
- `main/main.js:359` — `app.on('ready', ...)` primary startup
- `main/main.js:532` — second `app.on('ready', ...)` (places window)

### 3.2 BrowserWindow creation

| Purpose                   | Path:line                                                         |
| ------------------------- | ----------------------------------------------------------------- |
| Main browser window       | `main/main.js:496` (`placesWindow`) — see also `main/main.js:192` |
| Translation window        | `main/main.js:534`                                                |
| Prompt / dialog window    | `main/prompt.js:10`                                               |
| Window bounds persistence | `main/main.js:93` → `windowBounds.json`                           |

All three `new BrowserWindow(...)` sites use `nodeIntegration: true, contextIsolation: false`.

### 3.3 webContents / session creation

Min 1.35.7 renders tabs with **`WebContentsView`**, _not_ the legacy `<webview>` tag. (Comments in `js/webviews.js` still reference the webview tag; the implementation has moved on. Do not trust those comments.)

| Item                                     | Path:line                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| View factory                             | `main/viewManager.js:32` `createView(existingViewId, id, webPreferences, boundsString, events)`                                                     |
| `new WebContentsView(...)`               | `main/viewManager.js:53`; popup/adopt path `main/viewManager.js:110`                                                                                |
| Default webPreferences per view          | `main/viewManager.js:9` `getDefaultViewWebPreferences()`                                                                                            |
| Renderer → main view creation IPC        | `main/viewManager.js:331` `ipc.on('createView', ...)`; sender `js/webviews.js:196`                                                                  |
| Partition selection (private tabs)       | `js/webviews.js:191-201` — private tab ⇒ partition = tab id; otherwise `'persist:webcontent'`                                                       |
| Default session consumers                | `main/download.js:146-147`, `main/filtering.js:255`, `main/permissionManager.js:207-208`, `main/UASwitcher.js:68`, `main/minInternalProtocol.js:47` |
| `persist:webcontent` partition consumers | `main/remoteActions.js:45-73`                                                                                                                       |
| `min://` internal protocol               | `main/minInternalProtocol.js`                                                                                                                       |
| Permission gating                        | `main/permissionManager.js`                                                                                                                         |
| User-Agent switching                     | `main/UASwitcher.js`                                                                                                                                |

Note: `main/filtering.js:258` registers filtering via `app.on('session-created', registerFiltering)`, so **every** session (default + partitions) is covered — not just `defaultSession`.

### 3.4 Profile / session persistence

Min has **no profile abstraction**. There is exactly one Electron session partition for normal browsing plus ephemeral per-private-tab partitions.

| Item                           | Path:line                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| userData root                  | `app.getPath('userData')` — `main/main.js:66`; dev builds append `-development` (`main/main.js:60`)                                          |
| Settings store (main side)     | `js/util/settings/settingsMain.js` — file path set at line `70` → `<userData>/settings.json`; atomic write via `write-file-atomic` (line 20) |
| Settings store (renderer side) | `js/util/settings/settings.js`, `js/util/settings/settingsContent.js`, `js/util/settings/settingsPreload.js`                                 |
| Places / history DB            | `js/util/database.js:11` — `new Dexie('browsingData2')` → IndexedDB LevelDB                                                                  |
| Window bounds                  | `main/main.js:93` → `<userData>/windowBounds.json`                                                                                           |
| Custom filter rules            | `main/filtering.js:103` → `<userData>/customFilters.txt`                                                                                     |
| Saved credentials (encrypted)  | `main/keychainService.js:41` — `safeStorage.encryptString` → JSON file                                                                       |
| Session restore                | `js/sessionRestore.js`, `js/tabRestore.js`, `js/tabState/`                                                                                   |
| Userscript directory           | `js/userscripts.js:71` — `<userData>/userscripts` (watched by chokidar)                                                                      |

Observed on disk after first dev launch (`%APPDATA%\Min-development\`):
`Partitions\webcontent\`, `settings.json`, `IndexedDB\file__0.indexeddb.leveldb\`, `Local Storage\`, `WebStorage\`, `Network\`, `Preferences`, `Local State`, `Cache\`, `GPUCache\`, `IndexedDB\`.

### 3.5 Extension loading

**There is no extension system.** `session.loadExtension` appears nowhere in the repo. `ext/` is a directory of _vendored third-party libraries_, not extensions:

```
ext/abp-filter-parser-modified/   ext/filterLists/   ext/franc/
ext/httpsUpgrade/                 ext/icons/         ext/publicSuffixes/
ext/readability-master/           ext/textColor/     ext/xregexp/
```

The only `chrome.*` surface is a **site-unbreaking stub**, not a host:

- `js/preload/siteUnbreak.js:43-47` — defines `chrome.runtime` shims whose methods log `chrome.runtime is not implemented`.

Min's closest existing extension point is its **userscript** feature: `js/userscripts.js` (loaded into pages via `js/preload/`).

### 3.6 Ad / tracker blocker

| Item                                   | Path:line                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Blocker core (main process)            | `main/filtering.js`                                                                                               |
| Default on/off settings                | `main/filtering.js:1` `defaultFilteringSettings`, `:7` `enabledFilteringOptions`                                  |
| Parsed filter store (module-global)    | `main/filtering.js:79` `parsedFilterData`                                                                         |
| Filter list load                       | `main/filtering.js:81` `initFilterList()`                                                                         |
| Request decision                       | `main/filtering.js:164` `handleRequest(details, callback)`                                                        |
| Session registration                   | `main/filtering.js:250` `registerFiltering(ses)`; `:255` default session; `:258` `app.on('session-created', ...)` |
| Element-type mapping to Electron       | `main/filtering.js:67` `electronABPElementTypeMap`                                                                |
| Tracking-param stripping               | `main/filtering.js:13` `globalParamsToRemove`, `:31` `siteParamsToRemove`, `:147` `removeTrackingParams`          |
| Popup blocking                         | `main/filtering.js:126` `filterPopups`                                                                            |
| Parser (vendored, modified)            | `ext/abp-filter-parser-modified/abp-filter-parser.js`                                                             |
| Renderer toggle UI / exception domains | `js/navbar/contentBlockingToggle.js`                                                                              |
| Content-type blocking (JS etc.)        | `main/viewManager.js:28` (`javascript:` pref), `js/util/settings/`                                                |

### 3.7 Filter-list updates

**Filter lists are static, vendored, and never updated at runtime.** There is no auto-update, no network fetch, no cache, no version check in the shipped app.

| Item                                | Path                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Bundled blocklist (2,703,896 bytes) | `ext/filterLists/easylist+easyprivacy-noelementhiding.txt`                                                                           |
| Min-specific rules (41 bytes)       | `ext/filterLists/minFilters.txt`                                                                                                     |
| User rules                          | `<userData>/customFilters.txt` (read at `main/filtering.js:103`)                                                                     |
| Manual refresh script               | `ext/filterLists/updateEasylist.js` → `npm run updateFilters` (https GET, then `fs.writeFileSync` at line 52)                        |
| Related list updaters               | `ext/httpsUpgrade/updateHttpsList.js` (`npm run updateHttpsList`), `ext/publicSuffixes/updateSuffixes.js` (`npm run updateSuffixes`) |

Reload happens only by re-invoking `initFilterList()` (`main/filtering.js:242`), triggered by settings changes — the underlying text file is fixed at build time.

### 3.8 Tests and CI

| Item                       | Path                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Only "test" script         | `package.json` → `"test": "standard --verbose js/**/*.js main/*.js"` — **lint only, zero unit/integration tests**                           |
| Lint script (mutating)     | `package.json` → `"lint": "prettier --write ... && standard --fix ...                                                                       | snazzy"` |
| CI workflows               | `.github/workflows/build-packages.yml` — **the only workflow**                                                                              |
| CI trigger                 | `on: [workflow_dispatch]` — manual only; **nothing runs on push or PR**                                                                     |
| CI steps                   | checkout → setup-node 25 → `npm install --omit=optional` → one `build*` command → upload artifact                                           |
| Test/lint in CI            | **none.** No job runs `npm test` or `npm run lint`.                                                                                         |
| Build scripts              | `scripts/buildMain.js`, `buildBrowser.js` (browserify), `buildBrowserStyles.js`, `buildPreload.js`, `buildLocalization.js`, `watch.js`      |
| Packaging                  | `scripts/createPackage.js` (electron-builder API), `buildWindows.js`, `buildMac.js`, `buildDebian.js`, `buildRedhat.js`, `buildAppImage.js` |
| Post-install fuse flipping | `scripts/setupDevEnv.js` (`postinstall`) — `@electron/fuses`, disables `GrantFileProtocolExtraPrivileges`                                   |

### 3.9 Electron Builder configuration

There is **no `build` key in `package.json`** and no `electron-builder.yml`/`.json`. Configuration is constructed in code and passed to `builder.build({...})` at `scripts/createPackage.js:163`. Output paths per platform/arch are in `toPath()` at `scripts/createPackage.js:8-40` (e.g. Windows → `dist/app/win-unpacked`, `win-ia32-unpacked`, `win-arm64-unpacked`). An `afterPack` hook (`scripts/createPackage.js:44+`) flips the same Electron fuses as dev setup.

---

## 4. Dependency install

### 4.1 `npm ci` — FAILED (expected, no lockfile)

```
$ npm ci
npm warn Unknown project config "node-linker". This will stop working in the next major version of npm.
npm error code EUSAGE
npm error
npm error The `npm ci` command can only install with an existing package-lock.json or
npm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or
npm error later to generate a package-lock.json file, then try again.
```

**Exit code: 1. Duration: <1s.**

The upstream v1.35.7 archive ships **no lockfile at all** — verified absent: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`. `npm ci` is therefore impossible on a clean checkout; the documented command is `npm install` (README line 56), which matches CI (`npm install --omit=optional`).

### 4.2 `npm install` — SUCCEEDED

```
$ npm install

npm warn deprecated prebuild-install@7.1.3: No longer maintained...
npm warn deprecated eslint@6.8.0: This version is no longer supported...
npm warn gitignore-fallback No .npmignore file found, using .gitignore for file exclusion.

> min@1.35.7 postinstall
> node ./scripts/setupDevEnv.js

Downloading Electron binary...

added 796 packages, and audited 797 packages in 1m

140 packages are looking for funding
  run `npm fund` for details

28 vulnerabilities (6 low, 3 moderate, 17 high, 2 critical)
```

**Exit code: 0. Duration: 81s.** 796 packages installed; Electron 43.4.1 binary downloaded by the `postinstall` hook.

Side effect: this created `package-lock.json` (383,044 bytes) in the workspace. It is a generated artifact, not an upstream file — see §7.

---

## 5. Lint / typecheck / test

### 5.1 `npm test` — FAILED (pre-existing upstream failure)

```
$ npm test

> min@1.35.7 test
> standard --verbose js/**/*.js main/*.js

standard: Use JavaScript Standard Style (https://standardjs.com)
  js\bookmarkConverter.js:11:20: 'DOMParser' is not defined. (no-undef)
  js\browserUI.js:165:5: 'ipc' is not defined. (no-undef)
  main\windowManagement.js:6:42: 'getWindowWebContents' is not defined. (no-undef)
  main\windowManagement.js:32:9: 'app' is not defined. (no-undef)
  ...
```

**Exit code: 1. Duration: 3s. 643 reported problems.**

Breakdown by rule:

| Rule                           | Count |
| ------------------------------ | ----- |
| `no-undef`                     | 446   |
| `indent`                       | 35    |
| `spaced-comment`               | 20    |
| `semi`                         | 20    |
| `no-unused-vars`               | 16    |
| `space-before-function-paren`  | 14    |
| `object-curly-spacing`         | 14    |
| `no-redeclare`                 | 10    |
| `prefer-promise-reject-errors` | 4     |
| `no-unreachable`               | 4     |
| `operator-linebreak`           | 3     |
| others                         | 57    |

**This failure is upstream, not caused by this audit.** The tree is byte-identical to the archive (§1). The dominant cause is structural: 446 of 643 errors are `no-undef` for identifiers (`ipc`, `app`, `windows`, `destroyAllViews`, `getWindowWebContents`, `electron`, `DOMParser`) that exist only because `scripts/buildMain.js` concatenates files into one shared scope. `standard` lints each file in isolation and cannot see them. The `test` script cannot pass as written for this architecture.

### 5.2 Typecheck — none exists

No TypeScript, no `tsconfig.json`, no `tsc` script. There is **no typecheck step to run**.

### 5.3 `npm run lint` — DELIBERATELY NOT RUN

`npm run lint` is `prettier --write ... && standard --fix ...`. Both **rewrite source files in place**. Running it would violate the "do not change source files" constraint, so it was skipped by design. A read-only equivalent was run instead:

```
$ npx prettier --check "**/**/*.css" "**/**/*.md" "**/**/*.html" "**/**/*.json"
[warn] localization\languages\hu.json
[warn] localization\languages\lt.json
...
[warn] Code style issues found in 37 files. Forgot to run Prettier?
```

**Exit code: 1. Duration: 1s.** 37 files are not Prettier-formatted at baseline — another pre-existing upstream condition. Consequence: **never run `npm run lint` during feature work**; it would produce a 37-file formatting diff unrelated to the change under test.

---

## 6. Build and development startup

### 6.1 `npm run build` — SUCCEEDED

```
$ npm run build
> npm run buildMain && npm run buildBrowser && npm run buildBrowserStyles && npm run buildPreload
```

**Exit code: 0. Duration: 2s.** Artifacts produced:

```
main.build.js                     599,640 bytes
dist/build.js                     512,350
dist/bundle.js                  1,215,610
dist/bundle.css                    44,040
dist/localization.build.js      507,039
dist/preload.js                    31,434
```

### 6.2 `npm run start` — SUCCEEDED, app launched

```
$ npm run start
> min@1.35.7 build
...
[0] > min@1.35.7 watch
[0] > node ./scripts/watch.js
[1] > min@1.35.7 startElectron
[1] > electron . --development-mode
[1]
[1] (electron) 'webContents.canGoBack' is deprecated and will be removed. Please use 'webContents.navigationHistory.canGoBack' instead.
[1] (electron) 'webContents.canGoForward' is deprecated and will be removed. Please use 'webContents.navigationHistory.canGoForward' instead.
[1] (node:4816) UnhandledPromiseRejectionWarning: Error: UnknownVizError
```

**Launch verified, not inferred.** 40s after start, 6 `electron.exe` processes were live (main + GPU + utility + renderers), and a top-level window was enumerated:

```
WINDOW pid=4816 title=Min
```

The process tree was then terminated with `taskkill //F //IM electron.exe` (6 processes terminated successfully). `npm run start` is a long-running `concurrently` process and does not self-exit, so no exit code was recorded for it.

Runtime userData created at `C:\Users\AKS-PC\AppData\Roaming\Min-development\` (confirms the `-development` suffix from `main/main.js:60`).

### 6.3 Startup warnings

- `Error: UnknownVizError` as an `UnhandledPromiseRejectionWarning` — GPU/viz initialization. Non-fatal; the window rendered. Likely tied to the GPU stack on this machine. Worth watching if later phases run headless or in CI.
- `webContents.canGoBack` / `canGoForward` deprecation warnings — Min still calls APIs deprecated in Electron 43.
- `util._extend` `DEP0060` deprecation — from browserify tooling under Node 24.
- `npm warn Unknown project config "node-linker"` — npm 11 no longer recognises `node-linker` from `.npmrc`. Harmless today; will break under a future npm major.

---

## 7. Files created / changed

### Created by this audit

| Path                                                                                                  | Nature                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `docs/BASELINE.md`                                                                                    | **the only intentional addition**                                   |
| `min-v1.35.7-source.zip`                                                                              | downloaded archive (provenance artifact)                            |
| `package-lock.json`                                                                                   | generated by `npm install` (383,044 bytes) — did not exist upstream |
| `main.build.js`                                                                                       | generated by `npm run build`                                        |
| `dist/build.js`, `dist/bundle.js`, `dist/bundle.css`, `dist/localization.build.js`, `dist/preload.js` | generated by `npm run build`                                        |
| `node_modules/`                                                                                       | generated by `npm install`                                          |

### Modified

**None.** Verified by the pristine-archive diff in §1 (exit 0, zero differing files).

> P0-02 later modified `package.json` (one added script). See **§11** for that change, its backup, and its exact diff. §7 above records the P0-01 state only.

### Backups created

**None.** No source file was overwritten, so no backup was required.

### Git

No repository was initialised. No clone, branch, commit, tag, or stash was created. `.gitignore` is present from upstream but there is no `.git` directory.

---

## 8. Baseline failures and warnings (summary)

| #   | Item                                          | Status                                                      |
| --- | --------------------------------------------- | ----------------------------------------------------------- |
| F1  | `npm ci`                                      | **FAIL** — no lockfile exists upstream                      |
| F2  | `npm test` (`standard`)                       | **FAIL** — exit 1, 643 problems (446 `no-undef`)            |
| F3  | `prettier --check`                            | **FAIL** — exit 1, 37 unformatted files                     |
| F4  | `npm install`                                 | PASS — exit 0, but 28 vulnerabilities (17 high, 2 critical) |
| F5  | `npm run build`                               | PASS — exit 0                                               |
| F6  | `npm run start`                               | PASS — window `Min` confirmed on screen                     |
| W1  | `.nvmrc` `15.7.0` vs CI Node 25               | Contradictory, stale metadata                               |
| W2  | No `engines` field                            | Runtime is unenforced                                       |
| W3  | `UnknownVizError` at startup                  | Non-fatal GPU/viz rejection                                 |
| W4  | Electron 43 deprecation warnings              | `canGoBack` / `canGoForward`                                |
| W5  | `node-linker` unrecognised by npm 11          | Future npm breakage                                         |
| W6  | README lists `buildRaspi` / `buildLinuxArm64` | **Absent from `package.json`** — those commands fail        |
| W7  | No CI runs tests or lint                      | No regression safety net exists                             |

---

## 9. Risks for future phases

### 9.1 Extension API — highest risk

Min has **no extension host at all**. `session.loadExtension` is unused; `ext/` is vendored libraries; `chrome.runtime` exists only as a stub that logs "not implemented" (`js/preload/siteUnbreak.js:43-47`). Any extension-API work is a **new subsystem**, not an integration into an existing one. Compounding factors:

- Main-process code is **concatenated into one global scope** (`scripts/buildMain.js`). A new main-process module must be appended to that `modules` array or it silently won't load, and name collisions across files are possible with no bundler to catch them.
- `nodeIntegration: true` / `contextIsolation: false` at every `BrowserWindow` site, plus `enableRemoteModule`-era webPreferences in `main/viewManager.js:9-29`. Adding an extension surface widens an already-permissive trust boundary.
- Electron's `session.loadExtension` does not support MV3 service workers on Electron 43 the way Chrome does; expect gaps.
- `js/userscripts.js` is the lowest-cost existing hook if full Chrome-extension compatibility is not actually a requirement.

### 9.2 Blocker / filter lists

- Filter lists are **frozen at build time** (2.7 MB vendored text). There is no runtime update path, no ETag/Last-Modified handling, no on-disk cache of fetched lists. Adding live updates means new persistence, new failure modes (partial downloads, corrupt lists), and a re-parse strategy.
- `parsedFilterData` is a **module-global mutated in place** (`main/filtering.js:79`); `initFilterList()` clears and re-parses it asynchronously with no lock. Concurrent updates risk a window where the blocklist is empty — i.e. ads pass through. Serialize this before touching it.
- Re-parsing 2.7 MB blocks the main process; `initFilterList()` already runs there today.
- `npm run updateFilters` overwrites the vendored list in place — running it during feature work creates a huge unrelated diff.

### 9.3 Profile handling

- There is **no profile concept**. Normal tabs share one `'persist:webcontent'` partition (`js/webviews.js:201`); private tabs get a partition named by tab id. Per-profile isolation would require changing that partition scheme, which touches `js/webviews.js`, `main/viewManager.js`, and every `session.fromPartition('persist:webcontent')` call in `main/remoteActions.js:45-73`.
- Storage is split across four independent places — `settings.json`, Dexie/IndexedDB `browsingData2`, `<userData>/customFilters.txt`, and the encrypted keychain file (`main/keychainService.js:41`). A profile feature must migrate or namespace **all four** consistently; there is no single storage layer to intercept.
- Dev mode silently redirects userData to `<userData>-development` (`main/main.js:60`). Two environments, two data roots — easy to test against the wrong one.
- Settings writes are funnelled to the main process and queued behind a promise chain (`js/util/settings/settingsMain.js:8-20`) specifically to avoid corruption (upstream issue #1520). Do not add renderer-side writes.

### 9.4 No regression safety net

There are **zero automated tests** and CI runs only on manual `workflow_dispatch`, building packages without ever linting or testing. Every phase must therefore define its own manual verification, and "the app still starts and renders a window" is currently the strongest available signal.

---

## 10. Limitations and untested assumptions

- **`npm run lint` was never executed** because it mutates sources. Its actual behaviour on this tree is inferred from `prettier --check` (37 files) and `standard --verbose` (643 problems), not observed.
- **No packaging command was run** (`buildWindows`, `buildDebian`, etc.). electron-builder configuration was read at `scripts/createPackage.js` but never exercised, so packaging is unverified. README warns Windows builds may need Visual Studio plus `npm config set msvs_version`.
- **`npm install --omit=optional` (the exact CI invocation) was not used**; plain `npm install` was run, so optional-dependency resolution may differ from CI.
- **No lockfile existed before install.** The generated `package-lock.json` reflects today's registry state, not upstream's tested combination. Re-running install later may resolve differently.
- **Functional behaviour was not exercised.** The app launched and rendered a window, but browsing, ad-blocking effectiveness, translation, password manager, userscripts, session restore, and downloads were not tested. "Baseline functionality remains unchanged" is supported by the byte-identical source diff, not by functional testing.
- **`UnknownVizError` was not root-caused.** It did not block launch and was left as-is.
- **Node 24 is validated only for install/build/launch on Windows x64.** It is not proven equivalent to CI's Node 25 for packaging.
- **`.nvmrc` was not honoured.** Node 15.7.0 was never installed or tested; the conclusion that it is unusable is reasoned from CI metadata and Electron 43 requirements, not from a failed attempt.
- **Release `target_commitish` is `1.35.x`, not `master`.** The audited tree is the tag snapshot (`c92079cde045c38ab844e53501e9c5178d503a45`), which may differ from upstream `master`.
- **The `min-v1.35.7-source.zip` archive was retained** in the workspace root as provenance evidence; it is not part of the Min source and should not be committed if git is introduced later.

---

# P0-02 Addendum — Smoke harness and extension-host decision

Audited: 2026-10-16 (UTC). Builds on §1–§10 above. No git used.

## 11. Baseline smoke harness

> **§11 is the original P0-02 implementation and is superseded by §15 (P0-02A).** It is kept as the audit trail. Two parts are no longer current: the launch command (`npm run start`) and the run timings in §11.6. The tab-detection logic in §11.4 is unchanged and still correct. See **§15** for the current behaviour and the reason the old launch path could report `tabRenderers=0`.

### 11.1 What was added

| Path                              | Nature                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/smoke-baseline.js`       | **new file** — the harness. Not part of Min's product code; not referenced by any Min build step.                                               |
| `package.json`                    | **modified** — exactly one added script line (diff below)                                                                                       |
| `docs/backups/P0-02/package.json` | **backup** of `package.json` taken before the edit (byte-identical, SHA-256 `e393ebfdf3e1ed4101ea28da88fc5edc85cc70e6217c56511dc9e4923e988e39`) |
| `docs/smoke-baseline.json`        | generated evidence file, overwritten each run                                                                                                   |

No other file was touched. `main.build.js`, `dist/`, `node_modules/` were regenerated by the build but are generated artifacts.

### 11.2 Exact `package.json` diff

```diff
--- docs/backups/P0-02/package.json
+++ package.json
@@ -64,6 +64,7 @@
   "scripts": {
     "postinstall": "node ./scripts/setupDevEnv.js",
     "test": "standard --verbose js/**/*.js main/*.js",
+    "smoke:baseline": "node ./scripts/smoke-baseline.js",
     "watch": "node ./scripts/watch.js",
     "startElectron": "electron . --development-mode",
     "start": "npm run build && concurrently \"npm run watch\" \"npm run startElectron\"",
```

One added line. No existing script, dependency, version, or `main` entry was altered. `main.build.js` as the entry path is unchanged. `package.json` re-validated as parseable JSON after the edit.

### 11.3 How to run

```bash
npm run smoke:baseline          # exit 0 = all checks pass, 1 = a check failed, 2 = harness error
```

Optional: `SMOKE_TIMEOUT_MS=120000 npm run smoke:baseline` to lengthen the launch wait (default 90000 ms).

### 11.4 What it checks

| #   | Check                                   | How it is verified                                                                                |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `npm run build` exits 0                 | `spawnSync` exit code + duration                                                                  |
| 2   | Electron main process is running        | an `electron.exe` whose command line contains `--development-mode` and **no** `--type=`           |
| 3   | A top-level window title contains `Min` | Win32 `MainWindowTitle` via `Get-Process`                                                         |
| 4   | ≥1 loaded `webContents` (a real tab)    | an `electron.exe` renderer with `--type=renderer` **and** `--enable-sandbox`                      |
| 5   | Process tree terminated cleanly         | post-teardown snapshot: 0 workspace-owned `electron.exe`, 0 workspace-owned dev-helper `node.exe` |

**Why check 4 needs no instrumentation.** Min creates tab views with `sandbox: true` (`main/viewManager.js:19`), while its own privileged UI windows (`BrowserWindow` sites in `main/main.js`, `main/prompt.js`) run with `nodeIntegration` and appear as `--no-sandbox` renderers. So a renderer carrying `--enable-sandbox` is a genuine web-content view. Observed steady state: `tabRenderers=1 uiRenderers=2`. No code is injected into the app, no debugging port is opened, and no Min source is modified to observe this.

### 11.5 Safety properties of the harness

- Takes **no arguments**; nothing is interpolated into a command string.
- Never uses `shell: true`. On Windows it spawns `cmd.exe /d /s /c npm …` with a **static argv array**; on POSIX it spawns `npm` directly.
- Opens **no remote debugging port** — no CDP surface is created.
- No `eval`, no dynamic code, no privileged API exposure to the browser runtime.
- Filesystem writes: exactly one file, `docs/smoke-baseline.json`, inside the repo.
- Process kills are **path-scoped** to this workspace (`cmd` contains the workspace root), so unrelated `node.exe`/`electron.exe` processes on the machine are never touched. Verified: 12 unrelated `node.exe` processes were present during development and were left running.
- Teardown is `taskkill /F /T /PID <root>` (whole tree), plus a path-scoped fallback reap for orphans from interrupted runs.

### 11.6 Smoke evidence — two consecutive runs

Run 1 (cold; also reaped orphans from an earlier manual probe):

```
=== P0-02 smoke-baseline ===
PASS  npm run build exit 0  [exit=0 in 1520ms]
PASS  electron main process running  [main=1]
PASS  top-level window title contains "Min"  [["extension at DuckDuckGo | Min"]]
PASS  >=1 loaded webContents (sandboxed tab renderer)  [tabRenderers=1 uiRenderers=2]
PASS  process tree terminated cleanly  [electron=0 devHelpers=0]

SMOKE_EXIT=0  DURATION=73s
```

Run 2 (warm):

```
PASS  npm run build exit 0  [exit=0 in 1544ms]
PASS  electron main process running  [main=1]
PASS  top-level window title contains "Min"  [["extension at DuckDuckGo | Min"]]
PASS  >=1 loaded webContents (sandboxed tab renderer)  [tabRenderers=1 uiRenderers=2]
PASS  process tree terminated cleanly  [electron=0 devHelpers=0]

SMOKE_EXIT=0  DURATION=11s
```

Determinism: the two runs produced an **identical process shape** — `{allPassed:true, build:0, main:1, tabs:1, ui:2, electron:7, after:[0,0]}`. The 73s vs 11s difference is cold-start plus orphan reaping, not assertion variance.

Window title observed: `extension at DuckDuckGo | Min`. This is Min's own title format `<tab title> | Min` (`js/browserUI.js:157-161`), i.e. a real remote page finished loading in the restored tab. The assertion only requires the title to _contain_ `Min`, so it still passes if the restored tab fails to load (title would then be exactly `Min`).

### 11.7 Teardown evidence

`taskkill /F /T /PID 25320` → exit code **0**, 20 processes terminated, including the full chain `cmd.exe → npm → concurrently → node (watch) → electron main → gpu/utility/crashpad/renderers`. The follow-up path-scoped stray reap killed **nothing** (`killed: []`), proving the tree kill was complete rather than relying on the fallback.

Post-teardown snapshot: `electron=0 devHelpers=0`. Independently re-verified from the shell after the run: 0 `electron.exe` system-wide, 0 workspace-owned `node.exe`.

The pre-flight reap in run 1 did kill leftovers of an earlier interrupted manual launch (`killed: [9 pids]`), which confirms the orphan-cleanup path works — that is the situation the harness protects against.

### 11.8 Note on `launch.exitCode`

The recorded `launch.exitCode` is **1**. That is _not_ a failure: it is `concurrently` reporting that its children were force-killed by the harness. The harness deliberately ignores it and asserts on window/process evidence instead. Do not treat it as a regression signal.

Launch warnings captured (same as §6.3, unchanged): `util._extend` DEP0060, `webContents.canGoBack`/`canGoForward` Electron 43 deprecations.

## 12. Intentional baseline exclusions

These are **excluded on purpose**, not fixed. Do not add them to a pass/fail gate.

| Command            | Status            | Evidence                                                                                       | Why excluded                                                                                                                                                                                              |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`           | **impossible**    | `EUSAGE … can only install with an existing package-lock.json or npm-shrinkwrap.json` (exit 1) | Upstream v1.35.7 ships **no lockfile of any kind**. Use `npm install` (README line 56) / `npm install --omit=optional` (CI).                                                                              |
| `npm test`         | **known failing** | exit 1, **643 problems**, **446 `no-undef`**                                                   | Upstream failure on an unmodified tree (§5.1). `standard` lints files in isolation but the main bundle relies on a shared global scope from `scripts/buildMain.js`, so the script cannot pass as written. |
| `prettier --check` | **known failing** | exit 1, **37 files** unformatted                                                               | Upstream formatting drift (§5.3).                                                                                                                                                                         |
| `npm run lint`     | **never run**     | —                                                                                              | It is `prettier --write` + `standard --fix`; it **rewrites sources**. Running it would create a 37-file unrelated diff and violate the no-source-change constraint.                                       |

The smoke harness deliberately gates on **build + launch + window + tab + teardown** only. It does not invoke `npm test`, `npm run lint`, or `prettier`.

## 13. Extension-host route decision

Design-level evaluation only. **No extension API, manager UI, or product code was implemented.**

### 13.1 What Electron 43.4.1 actually offers

Electron 43.0.0 ships Chromium `150.0.7871.46`. Citations are from the pinned `43-x-y` branch.

| Capability                                                                                                                                                   | Status in 43.4.1                                                                                                                                                                                                                                                                                                   | Source                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ses.loadExtension()`                                                                                                                                        | **Deprecated** since Electron 36 → use **`ses.extensions.loadExtension()`**                                                                                                                                                                                                                                        | [session.md](https://github.com/electron/electron/blob/43-x-y/docs/api/session.md), [breaking-changes.md](https://github.com/electron/electron/blob/43-x-y/docs/breaking-changes.md) |
| Packed `.crx`                                                                                                                                                | **Not supported** — unpacked only                                                                                                                                                                                                                                                                                  | [extensions-api.md](https://github.com/electron/electron/blob/43-x-y/docs/api/extensions-api.md)                                                                                     |
| Persistence across boots                                                                                                                                     | **None** — must re-call every boot; persistent sessions only; not before `app` ready                                                                                                                                                                                                                               | same                                                                                                                                                                                 |
| MV3 service workers                                                                                                                                          | **Work, CI-tested** (register/launch/restart, can call extension APIs)                                                                                                                                                                                                                                             | [extensions.spec.ts](https://github.com/electron/electron/blob/43-x-y/spec/extensions.spec.ts)                                                                                       |
| MV3 `webRequest` bindings bug                                                                                                                                | Fixed in **43.3.0** ([#52265](https://github.com/electron/electron/issues/52265) / PR [#52503](https://github.com/electron/electron/pull/52503)) → **43.4.1 includes the fix**                                                                                                                                     | [v43.3.0 notes](https://github.com/electron/electron/releases/tag/v43.3.0)                                                                                                           |
| Content scripts + content CSS                                                                                                                                | **Work, CI-tested** incl. `run_at` (document_start/idle/end) and `all_frames`, in a real isolated world                                                                                                                                                                                                            | [extensions.spec.ts](https://github.com/electron/electron/blob/43-x-y/spec/extensions.spec.ts)                                                                                       |
| `chrome.scripting` (incl. `executeScript`, `insertCSS`, `registerContentScripts`)                                                                            | **Documented, all supported**                                                                                                                                                                                                                                                                                      | [extensions.md](https://github.com/electron/electron/blob/43-x-y/docs/api/extensions.md)                                                                                             |
| `chrome.runtime` (sendMessage/onMessage/getURL/connect/id/getManifest)                                                                                       | **Documented, supported**                                                                                                                                                                                                                                                                                          | same                                                                                                                                                                                 |
| `chrome.storage.local`                                                                                                                                       | Supported — but **`storage.sync` and `storage.managed` are NOT**                                                                                                                                                                                                                                                   | same                                                                                                                                                                                 |
| `chrome.tabs`                                                                                                                                                | **Partial** (query/update/sendMessage/reload/executeScript); `-1` tabId errors                                                                                                                                                                                                                                     | same                                                                                                                                                                                 |
| `chrome.webRequest` (observing)                                                                                                                              | Supported; Electron's own `ses.webRequest` takes precedence                                                                                                                                                                                                                                                        | same                                                                                                                                                                                 |
| `chrome.webRequest` **blocking**                                                                                                                             | **MV2 only.** Chromium 150 gates `webRequestBlocking` to `max_manifest_version: 2`, or MV3 only when `location: "policy"` — `loadExtension()` is not a policy install                                                                                                                                              | [\_permission_features.json](https://raw.githubusercontent.com/chromium/chromium/main/extensions/common/api/_permission_features.json)                                               |
| `declarativeNetRequest`                                                                                                                                      | **Unverifiable / treat as unsupported** — no Electron docs, no tests, no wiring. Electron is designing its own replacement (`session.webRequest.setHeaderRules()`, PR [#53222](https://github.com/electron/electron/pull/53222), still open)                                                                       | —                                                                                                                                                                                    |
| `chrome.action` / `browserAction` / `pageAction`                                                                                                             | **Hard no-op.** Every method logs `"chrome.action.X is not supported in Electron"`; `isEnabled`→false, `openPopup`→`""`                                                                                                                                                                                            | [extension_action_api.cc](https://github.com/electron/electron/blob/43-x-y/shell/browser/extensions/api/extension_action/extension_action_api.cc)                                    |
| Extension **popup UI**                                                                                                                                       | **Not rendered.** `AllowPopup()` returns `false`; there is no toolbar                                                                                                                                                                                                                                              | [electron_extensions_renderer_client.cc](https://github.com/electron/electron/blob/43-x-y/shell/renderer/extensions/electron_extensions_renderer_client.cc)                          |
| Options page (`options_ui`, `runtime.openOptionsPage`)                                                                                                       | Not in supported manifest keys — **unverified, likely non-functional**. Extension pages work only if you load the `chrome-extension://` URL yourself                                                                                                                                                               | [extensions.spec.ts](https://github.com/electron/electron/blob/43-x-y/spec/extensions.spec.ts)                                                                                       |
| `cookies`, `contextMenus`, `commands`, `notifications`, `alarms`, `downloads`, `history`, `bookmarks`, `omnibox`, `sidePanel`, `offscreen`, `contentScripts` | **Undocumented ⇒ "provisional and may be removed"**; `cookies` PR [#22464](https://github.com/electron/electron/pull/22464) never merged; `contextMenus` [#50331](https://github.com/electron/electron/issues/50331) closed `not_planned`; `sidePanel` [#49830](https://github.com/electron/electron/issues/49830) | —                                                                                                                                                                                    |
| Enumeration / removal                                                                                                                                        | `ses.extensions.removeExtension()`, `getExtension()`, `getAllExtensions()`. **There is no `session.getExtensions()`**                                                                                                                                                                                              | [session.md](https://github.com/electron/electron/blob/43-x-y/docs/api/session.md)                                                                                                   |

Supporting extension-store installs is an explicit Electron **non-goal** ([extensions.md](https://github.com/electron/electron/blob/43-x-y/docs/api/extensions.md)).

### 13.2 Min's actual main-process session surface

Verified in this tree, not assumed:

- **No extension host exists.** `loadExtension` appears nowhere. `ext/` is vendored libraries (§3.5).
- Sessions are created implicitly by Electron, not by a Min factory. Tab views get `partition: 'persist:webcontent'` (`js/webviews.js:201`) and `sandbox: true` (`main/viewManager.js:19`). `viewManager.js:22` still contains a commented-out `// partition: partition || 'persist:webcontent'`.
- Min already hooks sessions globally: `main/filtering.js:258` `app.on('session-created', registerFiltering)`. **This is the natural place to attach an extension host** — it already enumerates every session.
- Min handles auth itself: `main/viewManager.js:155` `view.webContents.on('login', ...)`.
- Min's own credential/autofill stack is a de-facto plugin pattern: `js/passwordManager/{bitwarden,keychain,onePassword}.js` + `js/preload/passwordFill.js`.
- Min's existing per-page injection is a **concatenated preload**: `scripts/buildPreload.js` lists `js/preload/*.js` and concatenates them into `dist/preload.js`, loaded at `main/viewManager.js:17`.

**Concrete collision to resolve in the first slice:** `js/preload/siteUnbreak.js:37-53` runs `window.chrome = { runtime: { … } }` — an **unconditional overwrite** of `window.chrome` in the page's **main world**, deferred via `setTimeout(…, 0)` and executed with `electron.webFrame.executeJavaScript` (line 110). Its methods log `"chrome.runtime is not implemented"`. Because it is deferred, it will very likely land **after** any extension main-world injection and clobber it, and it also destroys `loadTimes`/`csi`/`app` that sites feature-detect. Any extension slice must gate this stub (or make it additive: define only when absent).

### 13.3 Do the unsupported Chrome APIs matter for the first Feasibility Slice?

**No — provided the slice is scoped to content-script capability.** The unsupported set is concentrated in **UI** (`action`, popups, options pages) and **request-blocking** (`declarativeNetRequest`, MV3 blocking `webRequest`). Neither is required for a first slice, because:

- Min **already has its own blocker** (`main/filtering.js`, `ses.webRequest.onBeforeRequest`, `parsedFilterData`). The brief requires preserving that behaviour, so extension-based blocking is deliberately out of scope — which sidesteps the DNR / `webRequestBlocking` gap entirely.
- Toolbar/popup UI is out of scope by instruction ("do not implement manager UI"). Any UI would have to be Min's own regardless, since Electron renders none.

What **is** available and CI-tested upstream — content scripts + CSS with `run_at`/`all_frames` in a real isolated world, `chrome.scripting`, `chrome.runtime` messaging, `chrome.storage.local`, observing `chrome.webRequest` — is exactly a content-script feasibility slice.

### 13.4 Decision

**Use Electron's extension host — `ses.extensions.loadExtension()` (the non-deprecated 43 API) — for the first Feasibility Slice.** Do **not** build the slice on `js/userscripts.js`.

Rationale — Min's userscript host is the smaller change but is materially weaker, and the gaps are in the exact places a feasibility slice must prove:

| Gap in Min's userscript host                                                                                                                               | Evidence                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **No `GM_*` API surface at all** — real-world Tampermonkey scripts using `GM_xmlhttpRequest`/`GM_setValue` throw immediately                               | `grep GM_ js/` → zero hits      |
| Match patterns are a **naive ordered-substring test**, not Chrome/Tampermonkey match patterns; `https://*.example.com/*` over-matches                      | `js/userscripts.js:57-68`       |
| `run-at` is parsed but **explicitly not honoured** — upstream `// TODO run different types of scripts at the correct time`; everything runs at `dom-ready` | `js/userscripts.js:194`, `:214` |
| Injection is `executeJavaScript` in the page's **main world** — no isolated world, so page script can see/tamper with the userscript                       | `js/userscripts.js:184`         |
| No extension storage, no messaging channel, no CSS injection API                                                                                           | —                               |
| Gated behind `userscriptsEnabled`, which has **no default in code** (only `settings.listen`)                                                               | `js/userscripts.js:205`         |

Electron's host gives isolated worlds, CI-tested `run_at`/`all_frames`, `chrome.scripting`, `chrome.storage.local` and `chrome.runtime` messaging **for free**, on the platform's supported path. Attaching it is small: `app.on('session-created')` is already used at `main/filtering.js:258`.

**Fallback (documented, not chosen):** if the slice turns out to require toolbar buttons, popups, or an options page, `loadExtension` cannot deliver them and the userscript path (plus Min-native UI) becomes the pragmatic route. Decide this _before_ writing slice code, not after.

### 13.5 Approval-ready next scope (P0-03)

Smallest slice that proves the route, with explicit exclusions:

1. Load one **unpacked MV3** fixture extension via `ses.extensions.loadExtension()` from a `session-created` hook alongside `main/filtering.js:258`.
2. Prove: a content script injects into a real tab, content CSS applies, `run_at: document_start` fires, and `chrome.storage.local` round-trips.
3. Re-invoke the load on every boot (Electron does not persist it) and confirm `ses.extensions.getAllExtensions()` enumerates it.
4. Gate `js/preload/siteUnbreak.js`'s `window.chrome` overwrite so it does not clobber a real `chrome.runtime`.
5. Re-run `npm run smoke:baseline` — the tab-renderer assertion must still report `tabRenderers>=1` and teardown must stay clean.

**Explicitly out of scope:** `chrome.action`/popups/options UI (Electron no-ops), `declarativeNetRequest` and MV3 blocking `webRequest` (Min's blocker stays authoritative), `storage.sync`, `cookies`, `contextMenus`, `.crx` install, extension-store installs, and any manager UI.

**Acceptance for P0-03:** content-script + CSS + storage evidence observed in a live tab, `smoke:baseline` still green, Min's blocker behaviour unchanged (`parsedFilterData` untouched).

## 14. P0-02 changed files (summary)

| Path                              | Change                                    |
| --------------------------------- | ----------------------------------------- |
| `scripts/smoke-baseline.js`       | created                                   |
| `package.json`                    | modified — 1 added line (§11.2)           |
| `docs/backups/P0-02/package.json` | created (pre-edit backup, byte-identical) |
| `docs/smoke-baseline.json`        | created (generated evidence)              |
| `docs/BASELINE.md`                | modified — §7 cross-ref + §11–§14 added   |

Verified product diff against the pristine archive:

```
Only in .../docs: BASELINE.md
Only in .../docs: backups
Only in .../docs: smoke-baseline.json
Files .../package.json and /tmp/minpristine/package.json differ
Only in .../scripts: smoke-baseline.js
```

No Min product source file was modified. No formatting changes were applied anywhere.

### 14.1 Packaging impact (verified, not assumed)

`scripts/createPackage.js:69-89` defines electron-builder `files` as `'**/*'` plus exclusions. Relevant exclusions:

- `'!scripts/'` (line 83) → **`scripts/smoke-baseline.js` is excluded from packaged builds.** It cannot ship.
- `'!**/*.md'` (line 75) → `docs/BASELINE.md` is excluded.
- `'!localization/'` etc. — unaffected.

Not excluded: `docs/smoke-baseline.json` and `docs/backups/P0-02/package.json` would be included in a packaged asar. Neither is referenced by Min at runtime and neither changes behaviour (electron-builder reads only the root `package.json`), so **no product code was changed to fix this**. If a clean package tree is ever required, add `'!docs/'` to that exclusion list — one line, in product code, so it needs its own approval.

As of P0-02A, `docs/smoke-baseline.json` contains **no machine-specific absolute paths** (`grep -c AKS-PC docs/smoke-baseline.json` → `0`); the workspace is recorded as a basename and the temp tab file as a path relative to the OS temp directory.

---

# P0-02A Addendum — Deterministic tab evidence in the smoke harness

Audited: 2026-10-16 (UTC). Fixes a state-dependent false failure in the §11 harness. **No Min product code changed.** No git.

## 15. Why the prior run could report `tabRenderers=0`

The detection regex was never the problem. The problem was that the harness **did not control whether a tab existed** — it inherited whatever the profile's session-restore state produced, and launched through a wrapper that could exit early.

### 15.1 Reproduced race window

Launching the Electron dev entry directly against a **fresh empty profile** and sampling every ~1s:

```
t=469ms    main=1 tabRenderers=0 uiRenderers=2 titles=Min
t=1836ms   main=1 tabRenderers=1 uiRenderers=2 titles=Welcome to Min | Min
t=3224ms   main=1 tabRenderers=1 uiRenderers=2 titles=Welcome to Min | Min
```

At t=469ms the main process and the window already exist, and the window title is exactly `Min` — which **passes** the "title contains Min" check — while `tabRenderers` is still 0. That is precisely the false-failure signature: window check green, tab check red. The tab renderer only commits somewhere between ~0.5s and ~1.8s after launch.

### 15.2 The state dependency

Under `npm run start` the tab set came from **session restore**, not from the harness. The P0-02 runs prove it — the observed window title changed run to run (`extension at DuckDuckGo | Min`, then `Chrome Web Store | Min`), i.e. the harness was asserting on user profile state it neither created nor controlled. Min does normally create a tab (`js/sessionRestore.js:84-104`: first run opens the tour, a non-restorable state falls back to `browserUI.addTab(tasks.getSelected().tabs.add())`, and a task with zero tabs gets `tabs.add()`), but _which_ tab, whether it had committed by the time of evaluation, and whether the internal `min://newtab` view loaded were all outside the harness's control.

### 15.3 The early-break amplifier

The old launch root was `cmd.exe → npm → concurrently`. The poll loop breaks on `launchExit !== null`. If that wrapper chain exited for any reason before the tab view committed, the loop stopped with `tabRenderers=0` and the run failed — a harness artefact, not a product regression.

## 16. The fix

### 16.1 Controlled tab

Before launch the harness writes one static HTML file into the OS temp directory:

```
<OS_TEMP>\min-agent-edition-smoke\min-agent-edition-smoke-tab.html
```

Contents are only a marker — `<title>Min Agent Smoke Tab</title>` and the same string in the body. No script, no network reference.

### 16.2 New launch command

After `npm run build`, the harness spawns the Electron dev entry directly with the file passed as a URL argument:

```
node_modules\electron\dist\electron.exe . --development-mode file:///<OS_TEMP>/min-agent-edition-smoke/min-agent-edition-smoke-tab.html
```

This works through Min's own argv handling, not through any new mechanism: `main/main.js:136` — `handleCommandLineArguments` turns any argv containing `://` into a `sendIPCToWindow(..., 'addTab', { url: arg })`. The absolute path is printed to the console at runtime and is deliberately **not** written into the evidence file.

> **This is not identical to `npm run start`.** It is the same Electron dev entry that `npm run startElectron` uses (`electron . --development-mode`), plus a controlled local URL that guarantees a tab. It does **not** start the chokidar `watch` process, and it does not depend on restored tabs. `npm run start` itself remains unverified by this harness and is still covered by §6.2.

### 16.3 What did not change

- Detection logic is byte-for-byte the same predicates: `mainProcesses >= 1`, window title containing `Min`, `tabRenderers >= 1`.
- Teardown is still `taskkill /F /T /PID <root>` plus the path-scoped stray reaper.
- Security properties all retained: static argv only, no `shell: true`, no remote debugging port / CDP, no `eval` / `runInMainWorld` / JavaScript injection, no app instrumentation, no `.crx`, no extension loading, no window/protocol manipulation. Writes are one project evidence file plus one OS temp file.
- `package.json` was **not** touched again — `smoke:baseline` already points at the script.

## 17. Three consecutive successful runs

All three invoked as `npm run smoke:baseline`.

| #   | Exit  | Wall | `npm run build` | main | tabRenderers | uiRenderers | Window title                 | After teardown (electron, devHelpers) | `taskkill /F /T` exit | Strays reaped | Temp file cleanup                    |
| --- | ----- | ---- | --------------- | ---- | ------------ | ----------- | ---------------------------- | ------------------------------------- | --------------------- | ------------- | ------------------------------------ |
| 1   | **0** | 7s   | 0 (1531ms)      | 1    | **1**        | 2           | `Min Agent Smoke Tab \| Min` | (0, 0)                                | 0                     | none          | `{removed:true, stillPresent:false}` |
| 2   | **0** | 7s   | 0 (1519ms)      | 1    | **1**        | 2           | `Min Agent Smoke Tab \| Min` | (0, 0)                                | 0                     | none          | `{removed:true, stillPresent:false}` |
| 3   | **0** | 6s   | 0 (1524ms)      | 1    | **1**        | 2           | `Min Agent Smoke Tab \| Min` | (0, 0)                                | 0                     | none          | `{removed:true, stillPresent:false}` |

Representative output:

```
launching: node_modules\electron\dist\electron.exe . --development-mode file:///C:/Users/<user>/AppData/Local/Temp/min-agent-edition-smoke/min-agent-edition-smoke-tab.html

=== P0-02A smoke-baseline ===
PASS  npm run build exit 0  [exit=0 in 1518ms]
PASS  electron main process running  [main=1]
PASS  top-level window title contains "Min"  [["Min Agent Smoke Tab | Min"]]
PASS  >=1 loaded webContents (sandboxed tab renderer)  [tabRenderers=1 uiRenderers=2]
PASS  process tree terminated cleanly  [electron=0 devHelpers=0]
PASS  temporary tab file removed  [{"removed":true,"stillPresent":false}]
```

The window title is now **deterministic** (`Min Agent Smoke Tab | Min`) instead of tracking restored session state, and runs dropped from 11–84s to 6–7s because the harness no longer waits on session restore or network loads. A sixth check, `temporary tab file removed`, was added.

`launch.exitCode` is **1** in every run — that is the force-killed Electron process reporting a non-zero exit, not a failure. Same caveat as §11.8.

## 18. Temp URL and cleanup evidence

- URL used at runtime: `file:///<OS_TEMP>/min-agent-edition-smoke/min-agent-edition-smoke-tab.html` (recorded in the evidence file in machine-neutral form as `file://<OS_TEMP>/min-agent-edition-smoke/min-agent-edition-smoke-tab.html`).
- After each of the three runs the temp **directory** was gone, not just the file: `ls "$TEMP/min-agent-edition-smoke"` → `No such file or directory`.
- **Cleanup on failure was proven, not assumed.** A sentinel file was pre-seeded at the exact temp path, then the harness was run from a location where `require('electron')` cannot resolve, forcing an exception after the file was created:

```
sentinel before: SENTINEL
smoke harness error: Cannot find module 'electron'
EXIT=2
sentinel after: ls: ... No such file or directory
```

The `finally` block removed the pre-existing sentinel and its directory even though the harness exited with code 2.

## 19. P0-02A changed files and backups

| Path                                            | Change                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/smoke-baseline.js`                     | **modified** — controlled tab file, direct Electron launch, `try/finally` cleanup, machine-neutral evidence fields, one extra check     |
| `docs/backups/P0-02A/scripts-smoke-baseline.js` | **created** — pre-edit backup, byte-identical (`cmp` clean), SHA-256 `af779e3535bd03bf487ee308b7e3ecc413a2bdc48a3d9ed6ac1157101862de63` |
| `docs/BASELINE.md`                              | modified — §11 superseded banner, §14.1 note, §15–§19 added                                                                             |
| `docs/smoke-baseline.json`                      | regenerated by the runs                                                                                                                 |

`package.json` was **not** modified in P0-02A (its P0-02 backup in `docs/backups/P0-02/package.json` remains the relevant one).

Product diff against the pristine archive after P0-02A:

```
Only in ./docs: BASELINE.md
Only in ./docs: backups
Only in ./docs: smoke-baseline.json
Files ./package.json and /tmp/minpristine/package.json differ
Only in ./scripts: smoke-baseline.js
```

Unchanged from P0-02: no Min product source file differs, and no formatting change exists anywhere.

---

# P0-03 Addendum — Extension-host feasibility in Min's runtime

Audited: 2026-10-16 (UTC). Gate for Phase 2. Full capability matrix lives in **`docs/EXTENSION-COMPATIBILITY.md`**; this section records provenance, the diff, and the regression evidence.

## 20. What was built

A **gated, development-only** extension host plus a feasibility fixture. No manager UI, no install/remove path, no CRX, no store integration, no blocker changes.

| Path                                                                                       | Nature                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `main/extensionHost.js`                                                                    | **new** — shared-global style, no `module.exports`; loads exactly one hard-coded path |
| `extensions/test-min-agent-extension/{manifest.json,content.js,content.css,background.js}` | **new** — MV3 feasibility fixture                                                     |
| `scripts/buildMain.js`                                                                     | **modified** — one module appended                                                    |
| `js/preload/siteUnbreak.js`                                                                | **modified** — `window.chrome` stub made conditional                                  |
| `scripts/extension-probe.js`                                                               | **new** — dev-only evidence generator (`'!scripts/'` excludes it from packages)       |
| `docs/EXTENSION-COMPATIBILITY.md`                                                          | **new**                                                                               |
| `docs/extension-probe.json`                                                                | generated evidence                                                                    |

Backups taken before editing: `docs/backups/P0-03/scripts_buildMain.js`, `docs/backups/P0-03/js_preload_siteUnbreak.js`, `docs/backups/P0-03/js_util_settings_settingsMain.js` (all `cmp`-verified; settingsMain was ultimately left unchanged), and `docs/backups/P0-03/Min-development_settings.json` (the dev profile settings, temporarily flipped for one smoke run and then **restored byte-identical**).

### 20.1 Exact diffs

`scripts/buildMain.js` — one line, appended last so the electron globals from `main/main.js` are already initialised:

```diff
   'js/util/proxy.js',
-  'main/themeMain.js'
+  'main/themeMain.js',
+  'main/extensionHost.js'
 ]
```

`js/preload/siteUnbreak.js` — the stub becomes additive instead of an unconditional overwrite:

```diff
+  /* P0-03: install the stub only when the page has no real chrome.runtime.
+     An unconditional `window.chrome = {...}` clobbered an extension-provided
+     chrome.runtime, and also dropped loadTimes/csi/app that sites feature-detect. */
   scriptsToRun.push(`
-    window.chrome = {
-      runtime: {
-        connect: () => {
-          return {
-            onMessage: {
-              addListener: () => {console.warn('chrome.runtime is not implemented')},
-              removeListener: () => {console.warn('chrome.runtime is not implemented')},
-            },
-            postMessage: () => {console.warn('chrome.runtime is not implemented')},
-            disconnect: () => {console.warn('chrome.runtime is not implemented')},
+    if (!window.chrome || !window.chrome.runtime) {
+      window.chrome = Object.assign(window.chrome || {}, {
+        runtime: {
+          connect: () => {
+            return {
+              onMessage: {
+                addListener: () => {console.warn('chrome.runtime is not implemented')},
+                removeListener: () => {console.warn('chrome.runtime is not implemented')},
+              },
+              postMessage: () => {console.warn('chrome.runtime is not implemented')},
+              disconnect: () => {console.warn('chrome.runtime is not implemented')},
+            }
           }
         }
-      }
+      })
     }
   `)
```

No other product file differs.

## 21. Gating and safety

- Enabled only when **`--development-mode` AND `settings.get('experimentalExtensionHost') === true`**. Default is off; a production build can never enable it.
- The loaded path is hard-coded to `path.join(__dirname, 'extensions', 'test-min-agent-extension')`. No setting, download, or store can point it elsewhere.
- `loadExtension(path, { allowFileAccess: false })`; a rejected load is never retried with weaker flags.
- Per-session duplicate loads prevented via a `Set` of session objects; failures evict the entry so a later session can still try.
- Registration uses the same hook the blocker already uses: `app.on('session-created', …)` plus an explicit `session.defaultSession` and `session.fromPartition('persist:webcontent')` at `app.on('ready')`.
- Filtering, download, permission and WebContents creation code untouched.

**Packaging gap (reported, not fixed):** `scripts/createPackage.js:69-89` includes `'**/*'` and excludes `'!scripts/'`, but there is **no exclusion for `extensions/`**, so `extensions/test-min-agent-extension/` would be bundled into a packaged asar. It cannot load there (dev-mode + setting gate), so behaviour is unaffected, but shipping a test extension is undesirable. The fix is one line — `'!extensions/'` — in product code, so it needs its own approval. Same class as the `docs/` note in §14.1.

## 22. Feasibility result (summary)

Observed with `node scripts/extension-probe.js` (two launches, same throwaway profile):

- Loaded into **default** and **persist:webcontent**; `id=lgjffmdghonadknllapamfdomolbabig`.
- **Same ID after restart**, reloaded from settings with no install step.
- `chrome.storage.local` counter `1,2` on launch 1 → `3,4` on launch 2: **storage persists across restart**.
- Content script injected on both `file://` and `https://` (`senderUrl: "https://example.com/"`), and content CSS confirmed applied via a custom property only the extension defines.
- MV3 `background.service_worker` ran and completed a storage read-back round-trip.

**Failed / not as documented:** `run_at: document_start` did **not** precede the page's own inline `<head>` script (`documentStartSeenByPage: "no"` on every record); `all_frames: true` never produced a non-zero `senderFrameId`; content-script `document.title` never reached Min's window title; extension service-worker `console.log` never reached the main process stdout.

Details and the untested-but-documented API list are in `docs/EXTENSION-COMPATIBILITY.md` §§1–3.

## 23. siteUnbreak gating verified against the shipped bundle

The stub string was extracted from the built `dist/preload.js` and executed against three synthetic pages:

```
extracted 621 chars from the shipped bundle
1) real extension runtime preserved: true
2) loadTimes/csi preserved: true | stub runtime added: true
3) no chrome at all -> stub installed: true
```

A real extension-provided `chrome.runtime` is no longer clobbered, `loadTimes`/`csi` survive, and the original behaviour is retained when the page has no `chrome` object at all. Note the stub only ever applies on `google.com`/`*.google.com` (excluding `hangouts`/`drive`), unchanged.

## 24. Regression evidence

`npm run build` → exit 0. `npm run smoke:baseline` three consecutive runs, all **6/6 PASS**, exit 0, 6–7s each, `tabRenderers=1`, teardown `[0,0]`.

Additionally, one smoke run with the extension host **enabled** in the dev profile: **6/6 PASS**, `tabRenderers=1`, teardown `[0,0]`, and 7 `[extension-host]` lines present in the captured launch output — so the host is active without regressing the gate. The dev profile `settings.json` was then restored byte-identical to its backup.

---

# P0-04 Addendum — Host hardening and definite capability results

Audited: 2026-10-16 (UTC). Resolves P0-03's two "not observed" results and the packaging gap. No manager UI, no Phase 1 feature work.

## 25. Packaging exclusion applied

`scripts/createPackage.js` — one exclusion, next to the existing `'!scripts/'`:

```diff
       '!localization/',
       '!scripts/',
+      // feasibility fixtures and dev probes only; never shipped
+      '!extensions/',
       // These are bundled in.
       '!**/main',
```

Backup: `docs/backups/P0-04/scripts_createPackage.js` (`cmp`-verified before editing).

**Why this cannot alter runtime behaviour.** `files` is an electron-builder packaging filter: it decides which paths are copied into the packaged `app.asar`. It is not read at runtime. The only code that ever referenced `extensions/` is `main/extensionHost.js`, and that path is reachable only when `isDevelopmentMode && settings.get('experimentalExtensionHost') === true` (`main/extensionHost.js:37`). A packaged build is never in development mode, so the directory was already unreachable; removing it from the package changes no reachable code path. `main.build.js`, `dist/preload.js` and the bundle graph are unaffected — `npm run build` exits 0 and produces identical artefact sets.

**Packaging command not run — documented limitation.** `npm run buildWindows` invokes electron-builder, which on first run downloads its Windows tooling (winCodeSign / NSIS) and attempts code signing. That is installing and signing new tools, which this task's constraints exclude. Evidence is therefore glob-level: the exclusion is byte-identical in form to the pre-existing `'!scripts/'` entry, and P0-03 had already established that no other glob in the list matches `extensions/test-min-agent-extension/manifest.json`.

## 26. document_start: definite result

New fixture `extensions/test-min-agent-docstart/` — MV3, `content_scripts` with `"world": "MAIN"`, `run_at: "document_start"`, `all_frames: false`, matching only `http://127.0.0.1/*` and `https://example.com/*`. Kept in a **separate** extension so a manifest rejection cannot take down the ISOLATED control.

Ordering is measured _inside the page's own inline `<head>` script_, which is the exact question being asked.

| Target                               | ISOLATED world                                  | MAIN world                                | Result                                            |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| `http://127.0.0.1:<port>/probe.html` | `pageSawIsolated: "yes"` on every record        | `pageSawMainWorld: "yes"` on every record | **PASS — both worlds arrive before page scripts** |
| `file://` probe page (P0-03)         | `documentStartSeenByPage: "no"` on every record | not tested then                           | **FAIL for `file://`**                            |

`"world": "MAIN"` is **accepted** by Chromium 150 in Electron 43.4.1 — the fixture loaded with **no manifest error**, `id=nkhdbhbikdgokhjabbfpplhphopnpchl`, and its script reached the page's JS context (the page script read `window.__minAgentSeq[0]`).

**Conclusion:** the `document_start` ordering guarantee holds for `http(s)` and does **not** hold for `file://`. It is not "unreliable" in general — the discriminator is the scheme.

One fixture artefact is recorded rather than hidden: the `seq` attribute showed only `"ext-main-document-start"` (missing the page's `"page-head"` entry) because the MAIN-world script publishes at `document_start` and again at `DOMContentLoaded`, and cross-world `DOMContentLoaded` listener order is not guaranteed. `pageSawIsolated` / `pageSawMainWorld` are the authoritative signals.

## 27. all_frames: definite result

A loopback-only HTTP server (`127.0.0.1`, ephemeral port, two fixed routes, closed on every exit path) served a page containing a **same-origin iframe**.

| Target                                     | Result                  | Evidence                                                                                                                                                                    |
| ------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| same-origin iframe over `http://127.0.0.1` | **PASS**                | `url: "http://127.0.0.1:<port>/frame.html"`, `senderFrameId: 5`, `isTop: false`, `cssMarkerSeen: "yes"` — repeated on both launches                                         |
| same-origin iframe over `file://` (P0-03)  | **FAIL (not observed)** | only `senderFrameId: 0`                                                                                                                                                     |
| `https` page with an iframe                | **NOT TESTED**          | `https://example.com/` has no controllable iframe; top-frame injection on `https` was confirmed (`senderFrameId: 0`, `css: "yes"`) but nothing about frames may be inferred |

So P0-03's "not observed" was a **`file://` artefact**, not an Electron limitation.

## 28. Hardening made

- `main/extensionHost.js` now loads a **hard-coded list** of two fixture paths instead of one, still never derived from a setting, download, or store.
- Duplicate suppression moved to a per-session `WeakMap` of attempted fixture indices. The previous `Set` keyed on the session object alone would have loaded each fixture once per session but could not track per-fixture retries; a string-coerced session key was avoided because `String(session)` is not unique across sessions.
- A rejected fixture is evicted and never blocks the others; `allowFileAccess` stays `false` on every attempt.
- Probe gained retrying profile removal and a post-kill settle: a killed Electron holds LevelDB `LOCK` handles briefly, which caused an `EPERM` on the first probe run.

## 29. Regression evidence (P0-04)

`npm run build` → exit 0.

`npm run smoke:baseline`, three consecutive runs: **6/6 PASS**, exit 0, 6–7s each, `main=1`, `tabRenderers=1`, teardown `[0,0]`, title `Min Agent Smoke Tab | Min`.

Gate preserved both ways, with the dev-profile `settings.json` flipped and then restored byte-identical:

| Gate                              | Smoke                                          | Host activity observed                                                                        |
| --------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `experimentalExtensionHost: true` | 6/6 PASS, `main=1`, `tabs=1`, teardown `[0,0]` | 13 `[extension-host]` lines; **both** fixtures loaded into `default` and `persist:webcontent` |
| setting removed (restored)        | 6/6 PASS, `tabs=1`, teardown `[0,0]`           | **0** `[extension-host]` lines — nothing loads                                                |

Post-run: 0 `electron.exe`, probe temp dir removed (`runDirRemoved: true`).

## 30. P0-04 changed files and backups

| Path                                                               | Change                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `scripts/createPackage.js`                                         | **modified** — one `'!extensions/'` exclusion                                             |
| `main/extensionHost.js`                                            | **modified** — fixture list, per-session slot tracking                                    |
| `extensions/test-min-agent-docstart/{manifest.json,main-world.js}` | **new** — MAIN-world fixture                                                              |
| `extensions/test-min-agent-extension/{content.js,background.js}`   | **modified** — ordering report + `minAgentOrder` storage key                              |
| `scripts/extension-probe.js`                                       | **rewritten** — loopback server, ordering, frame records, https control, retrying cleanup |
| `docs/EXTENSION-COMPATIBILITY.md`                                  | **modified** — §1/§2 definite results, §6 Phase-4 design note                             |
| `docs/extension-probe.json`                                        | regenerated                                                                               |

Backups (all `cmp`-verified before editing): `docs/backups/P0-04/{scripts_createPackage.js, main_extensionHost.js, scripts_extension-probe.js, extensions_test-min-agent-extension_manifest.json, extensions_test-min-agent-extension_content.js, extensions_test-min-agent-extension_background.js}`.

Min product files still differ from the pristine archive only at `js/preload/siteUnbreak.js`, `scripts/buildMain.js`, `scripts/createPackage.js`, and the one-line `package.json` script. No formatting changes anywhere.

---

# P0-05 addendum — closing the last extension unknowns

## 31. removeExtension mid-session: PASS, but per-session

Probe run C (`scripts/extension-probe.js`) loaded both fixtures, let them inject, then removed them from `persist:webcontent` at t=12000ms. Main-process log:

```
[extension-host] before remove [persist:webcontent] count=2 ids=lgjff…,nkhdb…
[extension-host] removed: Min Agent Test Extension lgjffmdghonadknllapamfdomolbabig persist:webcontent
[extension-host] after remove [persist:webcontent] count=1 ids=nkhdb…
[extension-host] removed: Min Agent Docstart Test nkhdbhbikdgokhjabbfpplhphopnpchl persist:webcontent
[extension-host] after remove [persist:webcontent] count=0 ids=none
```

Absence was measured **independently of the extension**: the probe page reports the extension's own markers in its `<title>`, so absence is observable after the extension is gone. The page also self-reloads every 5s, producing post-removal documents without touching Min.

```
t=11536ms  EXT ds=no css=yes sw=ok n=5 f=5 v=P0-03 | Min      <- extension alive
t=13208ms  EXT ds=no css=yes sw=ok n=5 f=5 v=P0-03 | Min
t=14879ms  EXT ds=no css=yes sw=ok n=5 f=5 v=P0-03 | Min
t=16552ms  PROBE iso=no css=no main=no | Min                   <- removed: no dataset, no CSS, no MAIN-world global
t=19913ms  PROBE iso=no css=no main=no | Min
```

**No restart is needed.** `getAllExtensions()` reflects removal immediately and the next document is clean.

Two things that still need care:

1. **Removal is per-session.** Only `persist:webcontent` was unloaded. The fixtures stayed loaded in the **default** session, and a document in that session produced a full `EXT … sw=ok n=3 f=3` title at t=18240ms — inside the post-removal window. One `removeExtension` call does **not** disable an extension app-wide; Min loads into at least two sessions.
2. **Removal is not forgetting.** `chrome.storage.local` LevelDB under `Partitions/webcontent/Local Extension Settings/<id>/` survives `removeExtension`. Disable ≠ clear.

Probe hook added to `main/extensionHost.js`: `experimentalExtensionRemoveProbe` (a positive millisecond value). It is honoured only when the existing host gate is already on (`--development-mode` **and** `experimentalExtensionHost === true`), fires once, and is absent from default settings. Smoke with it unset produces zero `[extension-host]` lines.

## 32. all_frames over https: PASS

Run B served a page with a same-origin iframe over **`https://127.0.0.1:<ephemeral>`** using a throwaway self-signed certificate (`CN=127.0.0.1`, `SAN IP:127.0.0.1`, 1 day) generated by system openssl 3.2.3 into the OS temp dir, and launched Electron with `--ignore-certificate-errors` **for that run only**. Server bound to `127.0.0.1`, ephemeral port, closed on every exit path; certificate deleted afterwards.

Observed frame records (exact URLs, not inferred):

```
{"run":"B loopback https","url":"https://127.0.0.1:58944/probe.html","senderFrameId":0,"pageSawIsolated":"yes","pageSawMainWorld":"yes"}
{"run":"B loopback https","url":"https://127.0.0.1:58944/frame.html","senderFrameId":5}
```

`https non-top-frame injections: 3` — reproduced on every launch in that run. So **`all_frames: true` works over https**. The P0-04 NOT TESTED row is now closed.

Bonus from the same run: `pageSawIsolated: "yes"` and `pageSawMainWorld: "yes"` on every https probe-page record, so `document_start` ordering holds for **https** as well as http. The only scheme where ordering and frame injection fail remains **`file://`**.

## 33. Phase 1 bridge design

`docs/PHASE1-DESIGN.md` — design only, nothing implemented. It maps all eight commands onto existing primitives with exact paths (`global.getView` at `main/viewManager.js:468`, `loadURLInView` at `:366`, `focusView` at `:290`, `capturePage()` at `:440`, `getNavigationHistory` at `:421`, tab model at `js/tabState/tab.js`), and records two corrections/constraints found during the audit:

- **There is no `js/store`** in this tree. Tab data is `js/tabState/{tab,task,windowSync}.js` plus the main-process mirror at `main/main.js:461`.
- **`callViewMethod` (`main/viewManager.js:387`) performs `webContents[data.method](...data.args)` with a caller-chosen method and args.** Pre-existing and used by Min's own trusted renderer. The bridge must never route to it — it is exactly the unrestricted privileged-API access the design forbids.
- `js/webviews.js:19` records that `capturePage()` does not work while a view is hidden, and `main/viewManager.js:449` already guards the zero-size case. Background-mode screenshots are therefore an open measurement, not a given.

## 34. Regression evidence (P0-05)

| Step                        | Result                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`             | exit **0**                                                                                                                                        |
| `npm run smoke:baseline` ×3 | exit **0, 0, 0** — **6/6 PASS** each, 6–7s each                                                                                                   |
| `main` / `tabRenderers`     | `main=1`, `tabRenderers=1`, `uiRenderers=2`                                                                                                       |
| teardown                    | `[0, 0]` (`electron=0 devHelpers=0`), `strayReap.killed=[]`                                                                                       |
| host gate **enabled**       | 6/6 PASS, 13 `[extension-host]` lines, both fixtures in `default` **and** `persist:webcontent`, remove probe **did not fire** (its setting unset) |
| host gate **disabled**      | 6/6 PASS, **0** `[extension-host]` lines                                                                                                          |
| dev profile `settings.json` | restored **byte-identical** (`cmp` clean)                                                                                                         |
| after all runs              | 0 `electron.exe`, no `min-agent-ext-probe` temp dir, loopback servers closed                                                                      |

Note on method: the smoke harness captures Electron stdout into `docs/smoke-baseline.json`, not into the console. Counting `[extension-host]` lines from the console log yields 0 even when the host is active — count them from the evidence file.

## 35. P0-05 changed files and backups

| File                                               | Change                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `main/extensionHost.js`                            | **modified** — dev-only `experimentalExtensionRemoveProbe` hook + `removeLoadedExtensionsFromSession()` |
| `extensions/test-min-agent-docstart/manifest.json` | **modified** — added `https://127.0.0.1/*` to matches                                                   |
| `scripts/extension-probe.js`                       | **rewritten** — three runs (http / https / removal), self-signed loopback TLS, title sampling           |
| `docs/EXTENSION-COMPATIBILITY.md`                  | **modified** — https frames PASS, https ordering PASS, removeExtension PASS + §2.1 per-session trap     |
| `docs/PHASE1-DESIGN.md`                            | **new**                                                                                                 |
| `docs/BASELINE.md`                                 | **modified** — this addendum                                                                            |
| `docs/extension-probe.json`                        | regenerated                                                                                             |

Backups (all `cmp`-verified before editing): `docs/backups/P0-05/{main_extensionHost.js, scripts_extension-probe.js, extensions_test-min-agent-docstart_manifest.json, extensions_test-min-agent-docstart_main-world.js}`.

Min product files still differ from the pristine archive only at `js/preload/siteUnbreak.js`, `scripts/buildMain.js`, `scripts/createPackage.js`, and the one-line `package.json` script. No formatting changes anywhere.

---

# P0-06 addendum — Phase 1 agent-control bridge (transport + status/tabs)

## 36. What was built

`main/agentRpc.js` — a loopback JSON-RPC endpoint using Node `http` only. No new dependency, no Express, no websocket. Wired last in `scripts/buildMain.js`.

Enable gate: the literal argv `--agent-rpc`, following `--development-mode` / `--debug-browser` (`main/main.js:35-36`). Never a persisted setting. `--agent-rpc` contains no `://` and is not preceded by `-s`, so `handleCommandLineArguments` (`main/main.js:131`) ignores it rather than opening it as a tab.

Implemented: transport, auth, validation, `browser_status`, `browser_tabs`. Not implemented: snapshot, navigate, click, type, press, screenshot, any DOM control, any extension change.

## 37. Transport and security evidence

Unit + live transport: `npm run test:agent-rpc` — **89/89 checks**. The product file is loaded into a Node `vm` with stubbed Electron globals; the real server is then started and driven with real loopback requests.

| Check                                                                      | Result                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| bound to `127.0.0.1`, ephemeral port                                       | `127.0.0.1:52821`                                             |
| non-loopback interface refused                                             | `192.168.0.150` → `ECONNREFUSED`                              |
| per-launch token is random, 64 hex                                         | yes; hard-coded test token → `401`                            |
| missing / wrong / short / non-Bearer auth                                  | `401` each                                                    |
| token never echoed                                                         | confirmed in error body and response body                     |
| Host tampering, bare `127.0.0.1` without port, empty Host, rebinding Host  | `403` each                                                    |
| `Origin` present                                                           | `403`                                                         |
| `Sec-Fetch-Site: cross-site` present                                       | `403`                                                         |
| GET / wrong path / path traversal                                          | `405`, `404`, `404`                                           |
| wrong content-type                                                         | `415`                                                         |
| malformed JSON, empty body, array/scalar envelope, bad `jsonrpc`, bad `id` | `400` each, no crash                                          |
| oversize body (>64 KiB)                                                    | `413`                                                         |
| raw malformed request line                                                 | `HTTP/1.1 400 Bad Request` via `clientError`                  |
| rate limit (20/s)                                                          | engages, `429`                                                |
| unknown method / camelCase injection                                       | `404 -32601` / `400 -32600` (pattern rejects before dispatch) |
| `params` on a no-param command                                             | rejected, not ignored                                         |
| no CORS header ever sent                                                   | `access-control-allow-origin` absent                          |
| discovery file written / removed on stop                                   | yes / yes                                                     |

End-to-end against **real Min**: `npm run probe:agent-rpc`, evidence `docs/agent-rpc-probe.json`.

| Launch                     | Result                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| without `--agent-rpc`      | discovery file absent, **0** `[agent-rpc]` stdout lines                                                                                                                       |
| with `--agent-rpc`         | file appears, `url` loopback, token 64 hex, `pid` matches the spawned child, `version 1.35.7`; stdout contains only `[agent-rpc] listening on 127.0.0.1:57497` — **no token** |
| tampering against real Min | `noAuth 401, wrongToken 401, badHost 403, badOrigin 403, badSecFetch 403, GET 405, unknownMethod 404, malformedJson 400`                                                      |
| after force-kill           | server closed (`ECONNREFUSED`); discovery file **left behind** — see §38                                                                                                      |

## 38. New findings

1. **Stale discovery file after force-kill/crash.** `before-quit` and `process.on('exit')` do not run under `taskkill /F`. Mitigated: `agentRpcStartServer()` unlinks any existing file before publishing a new one. Verified by planting a stale file with a bogus token — the new launch replaced it (`staleFileReplaced: true`).
2. **`windowId` is null for tabs that are not a window's selected view.** Real Min returned the selected tab with `windowId: "1"` and the background welcome tab with `windowId: null`, because `windows.getState(win).selectedView` (`main/viewManager.js:280`) stores one view id per window. Any multi-window tab attribution needs the renderer tab model or a new main-side mirror.
3. **`active` ≠ `focused`.** Observed `active: true, focused: false` while the address bar held focus. Both reported, neither inferred.
4. **`capturePage()` on a hidden window rejects rather than returning a zero-size image** — see §39.

## 39. Background screenshot measurement

`npm run probe:capture` runs `scripts/fixtures/capture-probe-main.js`, a throwaway Electron app (not Min) reproducing Min's exact shape: `BrowserWindow` + `WebContentsView` attached through `win.contentView`. Electron 43.4.1. Evidence: `docs/capture-page-probe.json`.

| Case                                            | Result                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| A `show: false`, view attached                  | **rejected** — `Current display surface not available for capture` |
| B `show: false` + `backgroundThrottling: false` | **rejected** — same error; disabling throttling does not help      |
| C view removed from the view tree               | **rejected** — same error                                          |
| D visible window (control)                      | **works** — 2420×1513, 9 distinct colours                          |
| E visible, then minimised                       | **works** — 2420×1513, 9 distinct colours                          |

**Conclusion: background/hidden capture is not available as designed.** A never-shown window cannot be captured. A window that was shown and then minimised can be. Phase 1 acceptance must therefore either require a visible launch, or create the window shown and immediately minimise/move it off-screen.

Corollary, pre-existing and not fixed here: Min's guard at `main/viewManager.js:449` tests for a zero-size image, which is not this failure mode, and `getCapture` (`main/viewManager.js:440`) has no `.catch()` — so capturing a hidden view produces an unhandled promise rejection. This must be addressed before `browser_screenshot` ships.

## 40. Lint delta

`npm test` still exits 1 (known baseline failure). Counts:

|                | Baseline | Now | Delta |
| -------------- | -------- | --- | ----- |
| total findings | 643      | 677 | +34   |
| `no-undef`     | 446      | 480 | +34   |
| non-`no-undef` | 197      | 197 | **0** |

The +34 are `main/agentRpc.js` (18) and `main/extensionHost.js` (16, added in P0-03), all references to the shared globals that the concatenation build in `scripts/buildMain.js` provides. `main/agentRpc.js` introduces **no new lint category**; three genuine issues found in it (control-character regex literal, unhandled `clientError` argument, redundant escape) were fixed rather than suppressed.

## 41. Packaging diff review — one gap found, not fixed

`scripts/createPackage.js` was **not modified** in P0-06. Pattern-level review of the `files` list:

| Path                                                                    | Ships?                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `main.build.js` (contains the bridge)                                   | yes — intended                                                                                   |
| `main/agentRpc.js` source                                               | covered by the pre-existing `'!**/main'` rule, same as `main/main.js` — no new packaging surface |
| `scripts/agent-rpc-test.js`, `scripts/fixtures/capture-probe-main.js`   | excluded by `'!scripts/'`                                                                        |
| `extensions/**`                                                         | excluded by `'!extensions/'` (P0-04)                                                             |
| `docs/*.md`                                                             | excluded by `'!**/*.md'`                                                                         |
| **`docs/*.json` evidence (4 files) and `docs/backups/**` (18 files)\*\* | **NOT excluded — would ship**                                                                    |

22 files / 298 KB under `docs/` are not matched by any exclusion. Pristine Min's `docs/` contains only `statistics.md`, so upstream never hits this; it is entirely an artefact of this audit workspace. It includes `docs/backups/P0-03/Min-development_settings.json`, a copy of a real settings file. Proposed one-line fix, **awaiting approval** (same approval route as P0-04's `'!extensions/'`):

```diff
       '!scripts/',
+      // audit evidence and pre-edit backups only; never shipped
+      '!docs/',
```

The full package build was again not run: electron-builder's first Windows run downloads winCodeSign/NSIS and attempts signing, which the task constraints exclude.

## 42. Regression evidence (P0-06)

| Step                                  | Result                                       |
| ------------------------------------- | -------------------------------------------- |
| `npm run build`                       | exit **0**                                   |
| `npm run smoke:baseline` ×3           | exit **0, 0, 0** — **6/6 PASS** each, 6–7s   |
| `[agent-rpc]` lines during smoke      | **0** — the bridge is inert without the flag |
| `[extension-host]` lines during smoke | **0** — P0-03 gate still inert               |
| teardown                              | `electronProcesses: 0`                       |
| `npm run test:agent-rpc`              | **89/89**, exit 0                            |
| `npm run probe:agent-rpc`             | exit 0, temp profile removed                 |
| `npm run probe:capture`               | exit 0                                       |
| leftover `electron.exe`               | 0                                            |

## 43. P0-06 changed files and backups

| File                                                                      | Change                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `main/agentRpc.js`                                                        | **new** — product code, gated by `--agent-rpc`                                     |
| `scripts/buildMain.js`                                                    | **modified** — one module entry, placed last                                       |
| `package.json`                                                            | **modified** — three scripts: `test:agent-rpc`, `probe:agent-rpc`, `probe:capture` |
| `scripts/agent-rpc-test.js`                                               | **new** — 89-check unit + live transport test                                      |
| `scripts/agent-rpc-probe.js`                                              | **new** — real-Min end-to-end probe                                                |
| `scripts/capture-page-probe.js`, `scripts/fixtures/capture-probe-main.js` | **new** — hidden-view capture measurement                                          |
| `docs/PHASE1-DESIGN.md`                                                   | **modified** — §14 implementation status, deviations, measured findings            |
| `docs/BASELINE.md`                                                        | **modified** — this addendum                                                       |
| `docs/agent-rpc-probe.json`, `docs/capture-page-probe.json`               | **new** evidence                                                                   |

Backups (all `cmp`-verified before editing): `docs/backups/P0-06/{scripts_buildMain.js, package.json}`.

Min product files still differ from the pristine archive only at `js/preload/siteUnbreak.js`, `scripts/buildMain.js`, `scripts/createPackage.js`, `package.json`, plus the new `main/agentRpc.js` and `main/extensionHost.js`. No formatting changes anywhere.

---

# P0-07 addendum — packaging exclusion + capture rejection hardening

## 44. Part A: docs/ excluded from packages

`scripts/createPackage.js` gained one entry next to the existing directory exclusions:

```diff
       // feasibility fixtures and dev probes only; never shipped
       '!extensions/',
+      // audit evidence, probe output, and pre-edit backups only; never shipped
+      '!docs/',
```

Glob-level verification (minimatch, same method as P0-04/P0-06):

```
EXCLUDED (required)  docs/backups/P0-06/main_agentRpc.js
EXCLUDED (required)  docs/backups/P0-03/Min-development_settings.REDACTED.txt
EXCLUDED (required)  docs/agent-rpc-probe.json
EXCLUDED (required)  docs/capture-page-probe.json
EXCLUDED (required)  extensions/test-min-agent-extension/manifest.json
EXCLUDED (required)  scripts/agent-rpc-test.js
shipped  (required)  main/main.js
shipped  (required)  main/agentRpc.js
shipped  (required)  main.build.js
shipped  (required)  dist/bundle.js
```

`main/*.js` source remains covered by the pre-existing `'!**/main'` rule (bundled into `main.build.js`, which ships). The full electron-builder package build was again **not** run: its first Windows run downloads winCodeSign/NSIS and attempts signing, which the task constraints exclude.

## 45. Part B: sensitive artifact hygiene

- `docs/backups/P0-03/Min-development_settings.json` (190 bytes, sha-256 `899f4cdf678685505f1e8c00049d19886c1bfdf0d30b8e0722c913069bece513`) was a copy of a real settings file containing identifiers (`1passwordDeviceID`, `clientID`). Keys were inspected only; no values are reproduced here.
- It was **deleted** and replaced by `docs/backups/P0-03/Min-development_settings.REDACTED.txt` containing only: the statement, filename, sha-256, and byte count. No settings contents survive anywhere in the workspace tree.
- Token hygiene: `grep` found **zero** 64-hex token values and zero non-redacted `token` keys across `docs/*.json` (`agent-rpc-probe.json` stores `tokenLength`/key names only). The per-launch token exists only in the throwaway discovery file under the OS temp dir.

## 46. Part C: capture rejection hardening

`main/viewManager.js` — both `capturePage()` call sites now handle rejection:

```diff
   view.webContents.capturePage().then(function (img) {
     var size = img.getSize()
     if (size.width === 0 && size.height === 0) {
       return
     }
     img = img.resize({ width: data.width, height: data.height })
     e.sender.send('captureData', { id: data.id, url: img.toDataURL() })
-  })
+  }).catch(handleCaptureRejection)
```

and identically for `saveViewCapture` (`view.webContents.downloadURL(image.toDataURL())`), which had the same defect. The visible path is byte-identical inside `.then()`.

New shared handler, placed above `getCapture`:

```js
var captureUnavailableCount = 0;
function handleCaptureRejection() {
  captureUnavailableCount++;
  /* Rate-limited: tab previews can retry hidden views many times a session. */
  if (captureUnavailableCount <= 5 || captureUnavailableCount % 50 === 0) {
    console.warn(
      "[capture]",
      "CAPTURE_UNAVAILABLE",
      "count=" + captureUnavailableCount
    );
  }
}
```

Semantics on rejection: nothing thrown, nothing sent — the renderer's `captureData` handler (`js/webviews.js:517`) consumes only `{ id, url }` and has no error channel, so forwarding an error would require renderer changes and an empty data URL would be treated as a real preview. The log carries a fixed category only; no page content, URL, or error message. The zero-size guard is retained because a second failure mode does resolve 0x0 (see §47).

A dev-gated probe hook was appended to `main/viewManager.js` (`experimentalCaptureProbe`, requires `--development-mode` AND the setting; packaged builds cannot enable it) so the behaviour could be observed **inside Min**, not only in the standalone fixture. It registers no commands and changes no product behaviour.

## 47. What the probe found (docs/capture-page-probe.json)

Real Min, gated probe run — all three expectations met:

```
[capture-probe] NEVER_ATTACHED_CAPTURE_RESOLVED {"width":0,"height":0}
[capture-probe] CAPTURE_UNAVAILABLE
[capture-probe] VISIBLE_CAPTURE_OK {"width":3841,"height":2010}
```

This refines the P0-06 conclusion. On Electron 43.4.1 there are **two distinct hidden-capture failure modes**:

| State of the view                                                                                         | capturePage() result                                              | Covered by                                                       |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Never attached to any window (never rendered)                                                             | resolves with **0x0** image                                       | Min's original zero-size guard (`main/viewManager.js:449`), kept |
| Attached + rendered, then detached (the state of **every non-selected tab view** after `hideCurrentView`) | **rejects** — `Current display surface not available for capture` | the new `.catch`                                                 |
| Hidden window (`show: false`, view attached, rendered)                                                    | **rejects** — same error                                          | the new `.catch`                                                 |
| Window shown, then minimized                                                                              | **works** — 2420×1513, 9 colours                                  | n/a                                                              |

Corroborating evidence that the handler fires in ordinary use: a **plain** Min dev launch (no probe settings) logged `[capture] CAPTURE_UNAVAILABLE count=1` naturally during startup, with no `UnhandledPromiseRejection` anywhere — previously this was an unhandled rejection.

New pre-existing product bugs found during verification (reproduced, **not fixed** — outside P0-07 scope):

1. **Two positional URL args crash Min at startup.** `electron . --development-mode --user-data-dir=<dir> <fileA> <fileB>` produces **no window, no output, exit code 4294967295**; the same launch with one URL works. Reproduced repeatedly with distinct files; smoke/agent-rpc are unaffected because they pass exactly one URL. The capture probe therefore launches one tab and produces its detached-view case from Min's own non-selected background view rather than a second URL.
2. **Detaching the selected view from inside the probe hook** (equivalent to `hideCurrentView` on the live view) also made the process vanish mid-run; the hook renders the detached case from Min's existing background view instead. May be the same native-level fragility as (1); flagged for upstream diagnosis.
3. **Min stamps identifiers into any fresh profile on first run** — a throwaway `--user-data-dir` received `clientID`, `1passwordDeviceID`, and `installTime` seconds after creation (consistent with `main/registryConfig.js` registry seeding). Machine-scoped, not credentials, but "throwaway profile" does not mean "no identifiers".

## 48. Regression evidence (P0-07)

| Step                                | Result                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                     | exit **0**                                                                                                                                                        |
| `npm run test:agent-rpc`            | **89/89**, exit 0                                                                                                                                                 |
| `npm run smoke:baseline` ×3         | exit **0, 0, 0** — **6/6 PASS** each, 6–7s, title `Min Agent Smoke Tab &#124; Min`                                                                                |
| gated features in smoke             | `[capture]`=0, `[capture-probe]`=0, `[agent-rpc]`=0, `[extension-host]`=0 — all inert                                                                             |
| `npm run probe:capture`             | exit **0**; conclusions: visibleCaptureWorks ✓, hiddenCaptureRejectedByElectron ✓, minHiddenRejectionHandled ✓, minNoUnhandledRejections ✓, minimizedStillWorks ✓ |
| leftover `electron.exe` / temp dirs | 0 / none                                                                                                                                                          |
| `npm test` deltas                   | total 677 → **685** (+8), non-no-undef **197 → 197** (unchanged)                                                                                                  |

The +8 `no-undef` are the probe hook's shared-scope references (`app`, `settings`, `isDevelopmentMode`, `WebContentsView`, `windows`, `viewMap`) — same concatenation class as all prior deltas. No new lint category; every non-`no-undef` finding in `main/viewManager.js` sits on pre-existing lines (17–370; additions start at 440).

## 49. P0-07 changed files and backups

| File                                                       | Change                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `scripts/createPackage.js`                                 | **modified** — `+ '!docs/'` (one hunk, two lines)                                             |
| `main/viewManager.js`                                      | **modified** — `handleCaptureRejection`, `.catch` on both capture sites, dev-gated probe hook |
| `scripts/capture-page-probe.js`                            | **modified** — real-Min phase, crash/exit tracking, raw-output tail, distinct-file launch     |
| `scripts/fixtures/capture-probe-main.js`                   | **modified** — explicit `unhandledRejection` recording, D-case retry                          |
| `docs/backups/P0-03/Min-development_settings.REDACTED.txt` | **new** (original settings copy deleted)                                                      |
| `docs/capture-page-probe.json`                             | regenerated                                                                                   |
| `docs/BASELINE.md`, `docs/PHASE1-DESIGN.md`                | updated                                                                                       |

Backups (`cmp`-verified before editing): `docs/backups/P0-07/{scripts_createPackage.js, main_viewManager.js, scripts_capture-page-probe.js, scripts_fixtures_capture-probe-main.js}`. One-off diagnostic scripts (`tmp-diag*.js`) were used, documented, and deleted; the two-URL repro is a one-line command recorded in §47.

Min product files still differ from the pristine archive only at `js/preload/siteUnbreak.js`, `scripts/buildMain.js`, `scripts/createPackage.js`, `package.json`, `main/viewManager.js`, plus the new `main/agentRpc.js` and `main/extensionHost.js`. No formatting changes anywhere.

---

# P0-08 addendum — two-URL argv crash + detach hang: diagnosed, guarded, probed

## 50. Part A: the two-URL crash is a native Electron runtime bug, below Min

Bisection chain (all evidence produced by throwaway launches, no product code changes):

1. **A minimal Electron app with zero Min code reproduces the death.** `scripts/fixtures/argv-bisect-main.js` (one window, lifecycle markers) launched with two positional `file://` args: exit 4294967295, no window, no output. One arg: runs.
2. **Argv-shape matrix** pins the trigger exactly: death occurs iff a positional URL/path argument is **followed by another positional argument** (`url url`, `url word-file`, `url https://...` all die). A URL followed by a flag (`--no-sandbox`), preceded by `--`, followed by a plain word, or followed by nothing, all survive.
3. **`default_app.js` is exonerated from JS involvement after selection.** Its parse loop assigns the FIRST positional to `option.file` and `break`s (runtime source extracted to `docs/backups/P0-08/default_app_main_extracted.js`); args after the app path are forwarded untouched, and the loop never sees the URLs.
4. **No logging layer survives** — zero stderr under `--enable-logging=stderr`, zero Crashpad/WER dumps, and a **synchronous marker file written at the first line of application JS is absent** after every crashing launch, proving death before any application JavaScript executes.
5. **Pristine upstream sources crash identically.** A bundle rebuilt from the pristine v1.35.7 extract (verified to contain none of this workspace's additions: no `agentRpc`, no `handleCaptureRejection`) launched with two URLs → exit 4294967295. Our bundle changes are ruled out.

**Conclusion: no fix is possible anywhere in this repository** — Min's `handleCommandLineArguments` (and all JS) never executes in the crashing form. Per the acceptance criteria, the outcome is documentation + a minimal safe invocation + automated probe coverage:

- **Safe multi-URL invocation: `--` before the URLs.** Real Min launched with `-- urlA urlB` (or three URLs) opens every argv tab; verified through the existing bridge (`browser_tabs`), no unhandled rejections. Min's `handleCommandLineArguments` already tolerates N URLs.
- Main.js required **no change**; still byte-identical to pristine apart from nothing (it was never modified in this workspace).

`npm run probe:two-url-argv` (evidence `docs/two-url-argv-probe.json`, exit 0) asserts the current documented behaviour:

| Scenario                 | Verdict                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| one bare URL             | runs; window; argv tab loads; title correct                              |
| two bare positional URLs | **runtime death exit 4294967295 pre-JS — documented, unfixable in-repo** |
| two URLs after `--`      | runs; **both** argv tabs load                                            |
| three URLs after `--`    | runs; **all three** argv tabs load                                       |
| unhandled rejections     | none anywhere                                                            |

## 51. Part B: the detach "crash" is a native hang, now guarded

With the deterministic `--probe-detach` hook (development mode + literal argv flag, never persisted; `scripts/detach-probe.js`, evidence `docs/detach-probe.json`, scenarios D0/D1/D2/D3/G):

| Scenario                                                        | Outcome                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D0 capture the selected view **while attached**                 | resolves 3841×2010 — safe                                                                        |
| D1 **detach** the selected view, wait 4s, reattach (no capture) | completes — **detach alone is safe**                                                             |
| D2 detach + `capturePage()` **same tick**                       | **main process hangs**: markers stop, no DONE, no exception, no exit event, no render/child gone |
| D3 capture an **already-settled detached** background view      | clean rejection (`CAPTURE_UNAVAILABLE`, handled)                                                 |
| G the product guard's attachment check in the exact D2 state    | returns `false` → **guard blocks the deadly call**                                               |

**Classification: pre-existing native fragility of `capturePage()` in the same tick after `removeChildView`** — neither the detach itself (D1) nor settled detached capture (D3) is unsafe. The main process never returns (not a JS exception; the earlier "silent crash" label was a hang misread from lost markers).

**Fix (smallest correct change, `main/viewManager.js`):** `isViewAttachedToAnyWindow(view)` — checks the view against every live window's `contentView.children` — and both `getCapture` and `saveViewCapture` now call it before `capturePage()`; a detached view routes to the existing `handleCaptureRejection()` (same user-visible outcome as P0-07's rejection path). Views that cannot be assessed are treated as attached, so behaviour only tightens. Min reaches this state via `hideCurrentView` on every tab switch, so the guard converts a potential real-user hang into a skipped preview. The direct-call probe scenario D2 is left unguarded on purpose: it is the regression sentinel proving the native hazard still exists below the guard.

`npm run probe:detach` exits 0 with all classification flags true. Same-tick caveat: the guard's check and the capture call are in one JS turn, so no detach can interleave between them.

## 52. Part C: regression evidence

| Step                               | Result                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                    | exit **0**                                                                                                                                                                                                                               |
| `npm run test:agent-rpc`           | **89/89**, exit 0                                                                                                                                                                                                                        |
| `npm run probe:capture`            | exit 0 — **all 5 conclusions true**                                                                                                                                                                                                      |
| `npm run probe:two-url-argv` (new) | exit 0 — 5/5 verdicts true                                                                                                                                                                                                               |
| `npm run probe:detach` (new)       | exit 0 — full classification incl. guard verdict                                                                                                                                                                                         |
| `npm run smoke:baseline` ×3        | exit **0,0,0** — **6/6 PASS** each, 6–7s, title `Min Agent Smoke Tab &#124; Min`                                                                                                                                                         |
| gated features in smoke            | `[agent-rpc]`=0, `[extension-host]`=0, `[capture-probe]`=0, `[detach-probe]`=0 — all inert                                                                                                                                               |
| leftover electron / temp dirs      | 0 / none (incl. pristine test dirs)                                                                                                                                                                                                      |
| `npm test` deltas                  | 685 → **692** (+7, all no-undef from the detach hook/guard), non-no-undef **197 → 197 unchanged**                                                                                                                                        |
| diff vs pristine                   | product files changed now: `js/preload/siteUnbreak.js`, `scripts/buildMain.js`, `scripts/createPackage.js`, `package.json`, `main/viewManager.js`; new: `main/agentRpc.js`, `main/extensionHost.js`. **`main/main.js` remains pristine** |

## 53. P0-08 changed files and backups

| File                                                     | Change                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `main/viewManager.js`                                    | **modified** — `isViewAttachedToAnyWindow` guard in `getCapture`/`saveViewCapture`; argv-gated detach probe hook (D0–D3, G) |
| `scripts/two-url-argv-probe.js`                          | **new** — Part A acceptance probe                                                                                           |
| `scripts/detach-probe.js`                                | **new** — Part B deterministic probe                                                                                        |
| `scripts/fixtures/argv-bisect-main.js`                   | **new** — minimal zero-Min repro fixture (kept for upstream report)                                                         |
| `package.json`                                           | **modified** — two scripts (`probe:two-url-argv`, `probe:detach`)                                                           |
| `docs/two-url-argv-probe.json`, `docs/detach-probe.json` | **new** evidence                                                                                                            |
| `docs/BASELINE.md`, `docs/PHASE1-DESIGN.md`              | updated                                                                                                                     |

Backups (`cmp`-verified before editing): `docs/backups/P0-08/{main_main.js, main_viewManager.js, package.json, default_app_main_extracted.js}`. Temp instrumentation scripts were used, documented, and deleted; the two-URL completions determinism is fully covered by `npm run probe:two-url-argv`.

---

# P0-09 addendum — browser_snapshot on the agent-rpc bridge

## 54. Execution path decision

Option 1 (fixed-source executeJavaScript), hardened to **zero interpolation**: the only string built for the page is `'(' + AGENT_SNAPSHOT_PAGE_FN.toString() + ')()'` — the page function takes no arguments, the constant is this file's own source, and `maxNodes` is applied by main-side slicing over the page's own ≤500-node cap. Rationale and the option-2 rejection (extension host: `file://` unreliability, dev-gate, first-document races) are recorded in PHASE1-DESIGN §17.

## 55. Implementation notes and fixes made during verification

- Params are no longer "none allowed" globally: declarative per-method schemas in `main/agentRpc.js` (`AGENT_RPC_PARAM_SCHEMAS`); unknown keys are rejected with the offending field named. `browser_snapshot` accepts only `tabId` (numeric string ≤20 digits, required), `format` (`json`|`text`), `maxNodes` (integer 1–500, default 200).
- JSON serialization of `NaN` yields `null`; a declared parameter arriving as `null` is now explicitly rejected (`parameter must not be null`) instead of being treated as absent — found by the test harness, fixed in the validator.
- Ref-store clearing could not rely on `listenerCount('did-navigate') === 0`: **Min already attaches `did-navigate` listeners to every tab webContents** during `createView`, so the bridge tracks its own attachment by webContents id. Verified: meta-refresh at t+4s clears that tab's refs immediately.
- `browser_status.bridge.refStore` reports **live** refs (TTL and destroyed-view filtered at read time); the 30s sweep (`sweepRuns` counter also exposed) remains the memory-hygiene pass. The original sweep-only semantics made a 60s-TTL check timing-dependent (a sweep never fired between expiry and probe end) — read-time filtering removed that race.
- The response byte cap may bind before the node cap (≈250 bytes/node with boxes), so a `maxNodes: 500` request can legitimately return fewer nodes with `truncated: true` and `bytes ≤ 65536`; `pageTruncated` vs `truncated` distinguish the page's own cap from the envelope cap.
- Nameless interactive nodes are enumerated (empty name); nameless headings are dropped.

## 56. Probe and regression evidence

`npm run probe:agent-snapshot` (`docs/agent-snapshot-probe.json`) — **27/27, exit 0** (83s; includes a 75s TTL window). Real Min, `--agent-rpc`, two controlled pages + a self-refreshing page:

| Asserted                                                                                                                                         | Result                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| interactive roles (button/link/textbox/checkbox/combobox/heading) enumerated                                                                     | ✓ (5 buttons, 1 link, 3 textboxes, 1 combobox, 1 heading) |
| password + email redacted end-to-end (length-only; `S3cretPW!7` absent from the raw body)                                                        | ✓                                                         |
| caps: page 500 cap, requested-200 slice, byte cap with `truncated` flags, ≤ 66000 on the wire                                                    | ✓                                                         |
| 120-char name truncation; control chars stripped from title                                                                                      | ✓                                                         |
| duplicate names → distinct refs, `nameIndex` 0/1; disabled state; checkbox state on a nameless node                                              | ✓                                                         |
| hostile text (`eval("PWNED-TOKEN-1")`, `"><img onerror…>`) returned as inert data, exact equality                                                | ✓                                                         |
| refs opaque, fresh per snapshot, disjoint across tabs, refStore self-status, navigate-clear at t+4s, TTL expiry at read time                     | ✓                                                         |
| unknown tabId → `-32002 not_found`; text format bounded with `ref=` handles; single-window attribution marked (`active`/`windowId`), not guessed | ✓                                                         |
| no page content in `[agent-rpc]` stdout                                                                                                          | ✓                                                         |

Regression: `npm run build` exit 0; `test:agent-rpc` **102/102** (13 new schema/cap assertions); `probe:capture` all 5 conclusions true; `probe:detach` exit 0 (run in-task); `smoke:baseline` ×3 **6/6 PASS**, `[agent-rpc]`=0, `[extension-host]`=0, `[capture-probe]`=0, `[detach-probe]`=0 — all gated features inert. Lint: total 692 → 700, `no-undef` 495 → 501 (+6, all shared-scope refs in the new code), **non-no-undef 197 → 197** (two transient findings introduced and fixed in-task: control regex in generated page source, a stray indent; the delta is again exactly the concatenation class).

`browser_tabs` create/close/select was not used by the probe (tab layout came from `--` argv per P0-08); destroyed-tab snapshots are covered by the readiness checks + sweep in code but could not be triggered without tab-close tooling — recorded as a limitation.

---

# P0-10 addendum — browser_click / browser_type on the agent-rpc bridge

## 57. Surface and safety mechanics

`browser_click {tabId, ref}` and `browser_type {tabId, ref, text ≤1000}` joined the closed method set (now 5). No selector/CSS/JS/coordinate parameter is accepted — schema-tested, including dedicated rejections for `x`/`y`/`css`/`script` keys. `text` rejects control characters including newlines (no regex: charCode loop; the schema also grew `maxLength` + `noControl` rule support in the validator).

Dispatch is native-only: `sendInputEvent` mouseDown/Up at the located box center (click / focus), ctrl(meta)-A + Backspace key events + `webContents.insertText` (type; fixed replace semantics — no `clearFirst` parameter exists in this task's schema). No `element.click()`, no JS injection; page text is data, never echoed into logs.

## 58. Locator resolution — strict / weak / ambiguous / expiry / cross-tab / detached

Refs resolve by re-enumerating the page in `locate` mode of the SAME page function that snapped it (page-side argument: fixed `'locate'` literal + validated integer ordinal only), then matching server-side:

| Case                                                                                         | Behaviour                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| strict (enumeration length unchanged AND stored-ordinal element matches role+name+nameIndex) | resolved                                          |
| page changed, exactly one role+name match in the current enumeration                         | resolved (element moved), `moved: true`           |
| zero role+name matches                                                                       | `ref_stale` (404)                                 |
| multiple role+name matches                                                                   | **`ambiguous` (-32011, 409) — fail, never guess** |
| TTL expired (60s, live semantics)                                                            | `ref_expired` (410)                               |
| ref present only in another tab's store                                                      | `ref_mismatch` (404)                              |
| view not attached to any live window                                                         | `view_not_attached` (409)                         |
| unknown/malformed ref                                                                        | `ref_not_found` / schema `invalid_params`         |

Pre-dispatch policy: disabled elements (`disabled`, 409); typing into password/email/tel/sensitive-autocomplete (`sensitive_field`, 403 — no bypass exists); purchase/payment-named clicks (`risky_action`, 403 by default) with `--agent-rpc-allow-risky` as the launch-time approval literal.

## 59. Probe and regression evidence

`npm run probe:agent-actions` (`docs/agent-actions-probe.json`) — **22/22, exit 0** (81s, three launches: default policy, fresh page set, allow-risky):

| Asserted                                                                                                                | Result |
| ----------------------------------------------------------------------------------------------------------------------- | ------ |
| click on changing button → `dom-change`, verified                                                                       | ✓      |
| click on link → `navigation`, verified                                                                                  | ✓      |
| type into text field (existing value replaced) → `value`, verified                                                      | ✓      |
| type into password → `sensitive_field` 403 (refused pre-dispatch)                                                       | ✓      |
| click disabled → `disabled` 409                                                                                         | ✓      |
| ambiguous after live mutation (Add-Ambiguous click shifts enumeration; old ref → role+name matches 2) → `ambiguous` 409 | ✓      |
| expired ref (61s) → `ref_expired` 410                                                                                   | ✓      |
| cross-tab ref → `ref_mismatch` 404; detached (background) view → `view_not_attached` 409                                | ✓      |
| no-effect click → honest `focus` kind (verified)                                                                        | ✓      |
| `Pay Now` refused by default; allowed with `--agent-rpc-allow-risky` → `dom-change`                                     | ✓      |
| unknown/malformed ref structured errors; typed text + page content absent from `[agent-rpc]` stdout                     | ✓      |

Regression: `npm run build` exit 0; `test:agent-rpc` **114/114** (+12: click/type schemas incl. rejected coordinate/css/js params, control-char and length rejections with real `String.fromCharCode` payloads); `probe:capture` 5/5; `probe:detach` exit 0 (guard intact); `probe:agent-snapshot` 27/27 (run in-task); `smoke:baseline` ×3 **6/6 PASS**, all gated features 0 lines. Lint: total 701, `no-undef` 504 (+3 shared-scope), **non-no-undef 197 → 197 unchanged**.

Probe-harness bugs found and fixed during iteration (kept visible): error-response assertions read `.status` off the parsed body instead of the transport result (the product's statuses were correct throughout — verified with a raw one-off reproduction); a control-char test literal lost its escape through an edit and silently asserted the wrong input. No product behaviour changed for any of these.

---

# P0-11 addendum — browser_navigate / browser_press / browser_screenshot

## 60. What was built

Three commands joined the closed set (8 total) with no new dependencies and no product-behaviour changes outside `main/agentRpc.js`:

- `browser_navigate {tabId, url}`: allowed protocols {http, https, file, min, about} enforced against the PARSED url (javascript:/data:/vbscript:/otherwise unknown → `blocked` 403); ≤300 chars; whitespace stripping by the WHATWG parser is preempted (leading/trailing whitespace → 400); ref store cleared before and after (`did-navigate`); dispatch through Min's own `loadURLInView` (`main/viewManager.js:366`); one `did-finish-load`/`did-fail-load` wait; success → `navigation` verified with final URL + title; main-frame `did-fail-load` → `load_failed` 502.
- `browser_press {tabId, key}`: 13-key closed enum (Enter, Tab, Escape, ArrowUp/Down/Left/Right, PageUp/Down, Home, End, Backspace, Delete); NO chords/modifiers; lowercase or invented keys → 400. Runs `agentRpcTranslateKey` first — measured with `scripts/fixtures/keymap-probe-main.js`: DOM-style `ArrowDown/Left/Right/Up` produce EMPTY key events in this Electron while accelerator-style `Down/Left/Right/Up` deliver real ones (`e.key` verified). Verification: `focus` (focused-ordinal changed — evaluated BEFORE the DOM marker, because a key-logging page flips the marker for every key), then `dom-change`, else `dispatched-unverified`.
- `browser_screenshot {tabId}`: attached-view guard (`view_not_attached` 409 for detached/hidden/never-shown), inline base64 PNG only (no filesystem write), `screenshot_too_large` 413 above 5 MiB encoded (boundary unit-tested), zero-size → retried then rejected.

## 61. New measured finding: capturePage can WEDGE

`docs/agent-nps-probe.json`: after several rapid navigations, `capturePage()` on the attached, selected, fully-loaded view **never settled** — no resolve, no reject, no event (the P0-08 hang family again, this time on a live view; the main process stayed responsive). The 8s deadline converts the wedge into a structured `timeout`/`unsupported` error, and the screenshot command retries: each attempt has a 2.5s soft timeout, a wedged attempt is abandoned, and a fresh one is issued (6 attempts inside the overall 8s deadline; screenshot-only because the call is read-only — input dispatch retrying would double-act). With the retry loop, the probe's visible-view capture succeeds.

## 62. Verification model addition

`agentRpcRunVerification` gained a press mode. Full kinds now returned: `navigation`, `dom-change`, `value`, `focus`, `dispatched-unverified` (never verified). Precedence per mode: press → focus movement first (key-logging pages flip the marker for every key, so the marker check is second); type → value first; click → marker first. All balance under one deadline with fixed poll beats and exactly one dispatch.

## 63. Probe and regression evidence

`npm run probe:nps` (`docs/agent-nps-probe.json`) — **26/26, exit 0**:

| Section    | Asserted                                                                                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| navigate   | allowed file URL → navigation + finalUrl/title; SECOND navigation clears the tab's refs (refStore live count → 0); `javascript:`/`data:`/`vbscript:`/`telnet://` → 403 blocked; >300 chars → 400; unreachable host → `load_failed` 502; unknown tabId → 404                                        |
| press      | form field click → focus; Tab → focus moves (focus kind); Enter → delivered and verified via the page keylog marker (dom-change; implicit submission documented as a runtime limitation); Escape on a keylog-free page → `dispatched-unverified`, verified=false; `Meta+A`/lowercase `enter` → 400 |
| screenshot | PNG magic + width/height + ≤5 MiB on the attached view; detached view → `view_not_attached` 409; zero files written; nothing page-derived in stdout                                                                                                                                                |

Regression (all on the final code state): `test:agent-rpc` **137/137** (+23); `probe:capture` 5/5; `probe:detach` exit 0; `probe:agent-actions` 22/22; `probe:agent-snapshot` 27/27; `smoke:baseline` ×3 **6/6 PASS**, gated features 0 lines, teardown 0. Lint: `no-undef` +8 (shared-scope refs: loadURLInView, new command names), **non-no-undef 197 → 197 unchanged** (one transient indent + unused-var pair introduced and fixed in-task).

## 64. P0-11 changed files and backups

| File                                    | Change                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main/agentRpc.js`                      | **modified** — navigate/press/screenshot commands, URL validator, key translator, screenshot size gate + per-attempt retry, press-mode verification |
| `scripts/agent-nps-probe.js`            | **new**                                                                                                                                             |
| `scripts/fixtures/keymap-probe-main.js` | **new** — key-translation measurement fixture (kept; documents the accelerator vocabulary)                                                          |
| `package.json`                          | **modified** — `probe:nps`                                                                                                                          |
| `docs/*`                                | PHASE1-DESIGN §19, BASELINE this addendum, `docs/agent-nps-probe.json`                                                                              |

Backups (`cmp`-verified): `docs/backups/P0-11/{main_agentRpc.js, scripts_agent-rpc-test.js, package.json}`. `main/main.js` and `main/viewManager.js` untouched this task. Temporary diagnostics removed; findings recorded in §60-61.

---

## 65. Usage (P0-12)

# P0-12 addendum — MCP usage

`node scripts/min-launch.js` starts a visible Min (dev mode, `--agent-rpc`, dedicated profile `%USERPROFILE%\.min-agent-profile`, URLs only after `--`) and prints profile/discovery-file/ready. `mcp/min-agent-mcp.js` forwards the 8 tools over MCP stdio; tool schemas mirror the bridge; errors map to `isError`. Client setup: `mcp/README.md`. Evidence: `docs/mcp-e2e-run.json` (24/24 incl. missing-Min, unknown-tool, malformed-JSON and full 7-tool-call e2e). No bridge or Min behaviour changed in P0-12.

# P0-13 addendum — intent-scoped grants replace the launch-flag bypass

`--agent-rpc-allow-risky` removed. `browser_grant` (single-use, action+tabId(+ref)-bound, 30-300s TTL) added to bridge + MCP adapter; `policy.json` per profile gives durable defaults (`allowRiskyClicks`, `allowSensitiveTyping`, `allowedSchemes` restrict-only). Unprompted actions stay 403. See PHASE1-DESIGN §21 for the verified matrix (docs/agent-actions-probe.json 32/32; docs/mcp-e2e-run.json 35/35 — tools/list now 9). mcp/README.md section 3 documents the hard rule: browser_grant only on an explicit user instruction.
