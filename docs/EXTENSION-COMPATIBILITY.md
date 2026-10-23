# Extension compatibility — what is proven in Min's runtime

Task: P0-03. Scope: feasibility of an Electron extension host in **Min 1.35.7 on Electron 43.4.1**, Windows x64.

This file records **only what was actually observed in this runtime**, plus a clearly separated list of things that are documented elsewhere but were **not** exercised here. Nothing in the "not tested" section may be treated as working.

Reproduce with:

```bash
npm run build
node scripts/extension-probe.js      # writes docs/extension-probe.json
```

The probe starts a **loopback-only** HTTP server (`127.0.0.1`, ephemeral port, two fixed routes) so it can serve a controlled page with a same-origin iframe. It is closed on every exit path. Fixtures: `extensions/test-min-agent-extension/` (ISOLATED world) and `extensions/test-min-agent-docstart/` (MAIN world). The host is `main/extensionHost.js`, gated off by default (requires `--development-mode` **and** `experimentalExtensionHost: true`).

---

## 1. Proven in this runtime (observed evidence)

| Capability                                                                                | Status                | Evidence                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ses.extensions.loadExtension(path, {allowFileAccess:false})`                             | **PASS**              | Loaded into both the default session and `persist:webcontent`. `id=lgjffmdghonadknllapamfdomolbabig`                                                                                        |
| Load into Min's **tab** session                                                           | **PASS**              | `[extension-host] loaded: … session=persist:webcontent`                                                                                                                                     |
| `ses.extensions.getAllExtensions()`                                                       | **PASS**              | `after load [persist:webcontent] count=1 ids=lgjffmdghonadknllapamfdomolbabig`                                                                                                              |
| Extension **ID stable across app restart**                                                | **PASS**              | Same ID on launch 1 and launch 2; `idStableAcrossRestart: true`                                                                                                                             |
| Reload from settings on restart (no install step)                                         | **PASS**              | Second launch loaded with no install command, driven only by the persisted setting                                                                                                          |
| MV3 `background.service_worker` starts                                                    | **PASS**              | Service worker handled `runtime.onMessage` and completed a storage read-back                                                                                                                |
| `chrome.runtime.sendMessage` content→service worker, async `sendResponse` (`return true`) | **PASS**              | Round-trip returned `ok` with the read-back value                                                                                                                                           |
| `chrome.storage.local` set + get                                                          | **PASS**              | `{"count":N,"marker":"P0-03"}` written and read back                                                                                                                                        |
| `chrome.storage.local` **persists across restart**                                        | **PASS**              | Counter went `1,2` on launch 1 → `3,4` on launch 2, same profile                                                                                                                            |
| `content_scripts.js` on a `file://` page                                                  | **PASS**              | Content script ran with `allowFileAccess: false`                                                                                                                                            |
| `content_scripts.js` on `https://` pages                                                  | **PASS**              | `senderUrl: "https://example.com/"` and `"https://minbrowser.org/min/tour/"`                                                                                                                |
| `content_scripts.css` applied                                                             | **PASS**              | `cssMarkerSeen: "yes"` — `--min-agent-css-marker: rgb(251, 191, 36)` is defined only by the extension's `content.css`                                                                       |
| Extension visible DOM marker injected                                                     | **PASS**              | `#min-agent-extension-marker` created by the content script                                                                                                                                 |
| Host does not regress Min                                                                 | **PASS**              | `npm run smoke:baseline` 6/6 with the host **enabled**; `tabRenderers=1`, clean teardown                                                                                                    |
| `content_scripts` `"world": "MAIN"` accepted by this runtime                              | **PASS**              | `test-min-agent-docstart` loaded with **no manifest error**; `id=nkhdbhbikdgokhjabbfpplhphopnpchl`                                                                                          |
| MAIN-world script reaches the page's JS context                                           | **PASS**              | the page's own inline `<head>` script read `window.__minAgentSeq[0] === 'ext-main-document-start'` → `pageSawMainWorld: "yes"`                                                              |
| `run_at: document_start` **before page scripts**, over `http://127.0.0.1`                 | **PASS**              | ISOLATED control: `pageSawIsolated: "yes"` on every probe-page record                                                                                                                       |
| `run_at: document_start` **before page scripts**, MAIN world, over `http://127.0.0.1`     | **PASS**              | `pageSawMainWorld: "yes"` on every probe-page record                                                                                                                                        |
| `all_frames: true` into a **same-origin `http` iframe**                                   | **PASS**              | `url: "http://127.0.0.1:<port>/frame.html"`, `senderFrameId: 5`, `isTop: false`, `cssMarkerSeen: "yes"`                                                                                     |
| Two fixtures loaded side by side, both sessions                                           | **PASS**              | both IDs present in `default` and `persist:webcontent`                                                                                                                                      |
| Both fixture IDs stable across restart                                                    | **PASS**              | isolated `lgjff…` identical on launches 1 and 2; docstart `nkhdb…` identical across all three runs                                                                                          |
| `all_frames: true` into a same-origin **`https`** iframe                                  | **PASS**              | P0-05 run B: `url: "https://127.0.0.1:<port>/frame.html"`, `senderFrameId: 5`, three times. Cert was a throwaway self-signed loopback cert, `--ignore-certificate-errors` for that run only |
| `run_at: document_start` before page scripts over **`https`**                             | **PASS**              | P0-05 run B: `pageSawIsolated: "yes"` and `pageSawMainWorld: "yes"` on every `https://127.0.0.1` probe-page record                                                                          |
| `ses.extensions.removeExtension(id)` mid-session                                          | **PASS, per session** | P0-05 run C: `before remove count=2` → `after remove count=0 ids=none`, no restart; the next document reported `PROBE iso=no css=no main=no`                                                |

## 2. Proven NOT to work as expected (observed evidence)

| Capability                                                              | Status                  | Observed                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_at: "document_start"` before page scripts **on `file://` pages**   | **FAIL**                | P0-03: a `file://` probe page with an inline `<head>` script reported `documentStartSeenByPage: "no"` on every record. The same fixture on `http://127.0.0.1` reports `"yes"` (see §1). **The ordering guarantee holds for `http(s)` and does not hold for `file://`.** |
| `all_frames: true` into a same-origin **`file://`** iframe              | **FAIL (not observed)** | P0-03: only `senderFrameId: 0`. Over `http://127.0.0.1` the same fixture produces `senderFrameId: 5` (see §1). **Works for `http(s)` iframes; not observed for `file://` iframes.**                                                                                     |
| Content-script `document.title` reaching Min's window title             | **FAIL**                | Window title stayed `Min` although the content script's callback demonstrably ran (it wrote the second storage record). Do not use the window title as an extension evidence channel.                                                                                   |
| Extension service-worker `console.log` reaching the main process stdout | **FAIL (not observed)** | `[min-agent-test-extension] service worker started` never appeared on stdout. Extension SW console output is not forwarded to the parent process.                                                                                                                       |
| `all_frames` on an **`https`** page with an iframe                      | **NOT TESTED**          | `https://example.com/` was used as a top-frame control only; no controllable `https` page with an iframe was available. Do not infer either way.                                                                                                                        |

### 2.1 removeExtension is per-session — a real trap

P0-05 run C removed both fixtures from `persist:webcontent` only. The tab session then reported `count=0` and its next document showed no marker, no CSS and no MAIN-world global — **no restart required**. But the same extensions remained loaded in the **default** session, and a document in that session still produced a full `EXT … sw=ok` title mid-way through the post-removal sampling window.

So "disable an extension" is not one call: every session it was loaded into must be unloaded, and Min loads them into at least two (`default` and `persist:webcontent`). Any future enable/disable surface must iterate sessions, and must not assume a single call disables the extension app-wide.

Also note the reverse: removal does not delete the extension's `chrome.storage.local` data. The LevelDB under `Partitions/webcontent/Local Extension Settings/<id>/` survives `removeExtension`, so "disable" is not "forget".

### 2.2 Fixture artefact worth recording, not a capability failure

The `seq` attribute captured `"ext-main-document-start"` without the page's own `"page-head"` entry. The MAIN-world script publishes the shared array at `document_start` and again at `DOMContentLoaded`; the ISOLATED script reads the attribute at its own `DOMContentLoaded`, and listener order across worlds is not guaranteed, so the earlier snapshot was captured. The **authoritative** ordering signal is `pageSawIsolated` / `pageSawMainWorld`, measured _inside the page's own head script_, and both were `"yes"` on every probe-page record.

## 3. Documented elsewhere but NOT tested here — treat as unsupported

Sourced from Electron `43-x-y` docs/source and Chromium 150 (P0-02 research, §13.1). **None of these were exercised in Min.** Until tested, plan as if unavailable:

- `chrome.action` / `browserAction` / `pageAction` — Electron source logs `"… is not supported in Electron"`; `openPopup` returns `""`.
- Extension **popup UI** and any toolbar — `AllowPopup()` returns `false`. Any UI must be built by Min.
- `options_ui` / `runtime.openOptionsPage` — not in Electron's supported manifest keys.
- `chrome.storage.sync`, `chrome.storage.managed` — only `storage.local` is documented.
- `declarativeNetRequest` — no Electron docs, tests, or wiring. **Do not plan extension-based ad blocking on it.**
- MV3 blocking `chrome.webRequest` — Chromium 150 gates `webRequestBlocking` to `max_manifest_version: 2`, or MV3 only for `location: "policy"` installs. `loadExtension()` is not a policy install, so **MV3 extensions cannot block requests here.** Min's own blocker (`main/filtering.js`) remains the only request-blocking path.
- `chrome.cookies`, `contextMenus`, `commands`, `notifications`, `alarms`, `downloads`, `history`, `bookmarks`, `omnibox`, `sidePanel`, `offscreen`, `chrome.contentScripts` — undocumented in Electron ⇒ officially "provisional and may be removed".
- Packed `.crx` install and any extension-store integration — unsupported, and out of scope by decision.
- `ses.loadExtension` (the old top-level form) — deprecated since Electron 36; use `ses.extensions.*`.

## 4. Runtime facts worth keeping

- Electron's `Session` object exposes **no `.partition` property**. Labelling sessions requires tracking it yourself, otherwise every session logs as the default one.
- `app.on('session-created')` does fire for Min's sessions, and it is the same hook Min's blocker already uses (`main/filtering.js:258`).
- The tab session must be touched explicitly at `app.on('ready')` (`session.fromPartition('persist:webcontent')`) or the first tab's document can beat extension registration.
- Extension storage lives at `<userData>/Partitions/webcontent/Local Extension Settings/<extension-id>/` (LevelDB). Values are readable as plain bytes, which is a useful non-invasive debugging channel — note the value is prefixed by a length varint, so the JSON does not start immediately after the key.
- Unpacked extension IDs are derived from the load path, so the ID is stable as long as the path is.

## 5. Recommendation

**Treat everything in §3 as unsupported. Do not approximate a browser extension store.**

The evidence supports a narrow, honest host: load unpacked MV3 extensions from a fixed, gated path; rely on content scripts, content CSS, `chrome.runtime` messaging, `chrome.storage.local`, and `chrome.scripting`. Build any UI in Min, keep Min's own blocker authoritative, and surface unsupported APIs to the user as unsupported rather than silently stubbing them.

Do not add: extension install/remove commands, CRX handling, store integration, popup rendering, `declarativeNetRequest`, or `storage.sync` emulation. Each of those is a browser-chromium project, not a Min feature.

Before Phase 2 commits to any specific extension, spike that extension against this fixture harness and record its result in §1 or §2 — not in a design document.

---

## 6. Phase-4 minimal manager — design note (decision only, not implemented)

No manager UI exists and none is proposed here. This is the smallest enable/disable surface the evidence supports.

**Storage: a settings allowlist only.**

- One setting, e.g. `enabledExtensions`: an array of **absolute paths that the user added**, persisted through Min's existing settings pipeline (`js/util/settings/settingsMain.js`, atomic write, already serialised through the main process).
- Nothing else. No database, no extension metadata cache, no download state.

**Loading.**

- Reuse the existing path: `app.on('session-created', …)` plus the explicit `defaultSession` / `persist:webcontent` calls at `app.on('ready')` (`main/extensionHost.js`). That already covers every session Min uses.
- Load the allowlist on **every** launch. Electron does not persist loaded extensions, so there is no "installed" state to reconcile — the allowlist _is_ the state.
- Enable/disable therefore means: edit the list, then restart. Electron 43 has `ses.extensions.removeExtension(id)`, but unloading mid-session is untested here and must not be assumed to work; **do not promise live enable/disable** until it is spiked.

**Failure handling — must be explicit, never silent.**

- Missing path → log and skip that entry; other entries still load. Already implemented.
- Invalid or unsupported manifest → `loadExtension` rejects; log the message and skip. Already implemented, and a rejected entry is evicted so a later session can retry.
- Never retry a rejected load with weaker flags. `allowFileAccess` stays `false`.

**Explicitly out of scope for Phase 4.**

- No background download, no update check, no store browsing or search UI.
- No CRX handling, no `declarativeNetRequest`, no blocker changes.
- No popup/toolbar rendering — Electron renders none (§3); any extension UI is Min's own and is a separate decision.
- No permission-prompt emulation. Extensions get whatever the session already grants; that must be surfaced in the UI text, not hidden.

**The one thing Phase 4 must decide first:** whether the allowlist is _paths_ (simple, matches today's host, but requires the user to place files on disk) or _copied-into-userData_ extensions (nicer, but then Min owns a copy step, a de-dup step, and a deletion path — real product surface). The evidence does not force either; it only shows path-based loading works and is stable across restart.
