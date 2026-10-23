# Multi-Browser Backend Architecture (MB0 v2)

**Date:** 2026-10-20
**Status:** architecture + portability audit. **Documentation only.**
**Scope:** Min/Electron stays the default backend; Google Chrome becomes an explicit,
session-scoped opt-in behind the *same* MCP tool surface.

> **No application code, MCP schema, or test was changed by this task.** The MCP tool
> surface remains exactly 39 tools. ADR-02 (no generic raw CDP) is unchanged. No engine
> migration is reopened. No CloakBrowser integration.

---

## 1. Decision summary and accepted context

| Item | Value |
|---|---|
| Runtime decision (R5/D6) | **`STAY_ELECTRON`** — accepted, not revisited |
| Default backend | **`min`** |
| Opt-in backend | **`chrome`** |
| MCP tool census (verified, all four surfaces) | **39 / 39 / 39 / 39** |
| Machine baseline | `main` @ `2b8088e`; 0 staged; 155 modified; 125 untracked; 0 Electron processes |
| Min runtime | Electron 43.4.1 / Chromium 150.0.7871.224 / Node 24.18.1 |

The R5/D6 Novellive result (User-Agent product token, single site, not a general
anti-bot fix) is **context only**. It is not a justification for a Chrome backend, and
this document makes no claim that Chrome "passes Cloudflare". The Chrome backend exists
because some users and agents hold a *Chrome* identity, profile, or extension set.

**Non-goals restated:** no CloakBrowser bundling; no challenge solving, token forgery,
stealth, or access-control bypass; no generic CDP passthrough; no CAPTCHA behaviour change.

---

## 2. Architecture diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ MCP client / agent  (OpenCode, Claude Code, Cursor, …)                       │
│   stdio JSON-RPC · tools/list · tools/call                                   │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  UNCHANGED 39-tool schema
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ mcp/min-agent-mcp.js  — SHIPPED ADAPTER                                     │
│   · tool catalogue (39)          · schema validation mirror                  │
│   · per-call discovery re-read   · bounded retry (restart states only)       │
│   · NEW (MB2): resolves the agent's backend binding, then forwards           │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  backend chosen per SESSION, never per call
        ┌───────────────────────┴────────────────────────┐
        │                                                │
┌───────▼─────────────────────────┐   ┌──────────────────▼──────────────────────┐
│ MIN BACKEND (default)           │   │ CHROME BACKEND (opt-in, MB3+)           │
│ bridge: 127.0.0.1:0 + token     │   │ separate process, own user-data-dir,    │
│ discovery: agent-rpc.json       │   │ restricted channel, token-bound         │
│                                 │   │                                         │
│ ┌─────────────────────────────┐ │   │ ┌─────────────────────────────────────┐ │
│ │ SHARED LAYER (backend-agnostic, unchanged in Min)               │ │
│ │  · request validation     · error categories                    │ │
│ │  · policy + grants        · ref/ID namespaces                   │ │
│ │  · capability negotiation · dispatched/delivered/verified       │ │
│ └─────────────────────────────┘ │   │ └─────────────────────────────────────┘ │
│                                 │   │                                         │
│ Electron WebContentsView        │   │ Chrome tab / extension-mediated page    │
│ executeJavaScript ·             │   │ (model TBD at MB3 — see §5)             │
│ sendInputEvent · capturePage ·  │   │                                         │
│ printToPDF · downloads · debugger(3) │                                       │
└─────────────────────────────────┘   └─────────────────────────────────────────┘
```

**Key structural point:** the adapter, schemas, validation, policy, grants, error
categories and the three-stage envelope are **already backend-independent** in Min. What
is backend-specific is a relatively small surface (§4). MB1 extracts that surface; it does
not rewrite the bridge.

---

## 3. Backend selection and session lifecycle

### 3.1 Recommendation — the smallest maintainable design

**MCP configuration selects the backend; there is no per-call `backend` field.**

| Mechanism | Verdict |
|---|---|
| `<profile>/backend.json` read by the adapter (`{"backend":"chrome"}`) | **RECOMMENDED** |
| Separate MCP server entry per backend (e.g. `min-agent-chrome`) | Works, but duplicates 39-tool schemas per client config — rejected for MB2 |
| Tool pair `browser_backend_select` / `browser_backend_status` | **Rejected** — adds 2 tools and breaks the frozen 39 census for a *configuration* concern |
| Desktop setting (Min UI) | Insufficient alone: cannot express *per-agent* choice |
| Per-call `backend` parameter on every tool | **Rejected** — 39 schema changes, and per-call switching defeats session binding |

**Why a file, not a tool:** backend choice is a property of *the agent's session*, which
is one MCP server process. The adapter already re-reads a per-agent profile on every call
(ADR-05 pattern). A file keeps the tool surface frozen at 39 and reuses an audited
mechanism. Selection becomes observable through the **existing** `browser_status`
(extended with `backend` + `capabilities`), not a new tool.

**Session binding.** The MCP server process *is* the session:
- the adapter reads `backend.json` **once per `tools/call`** (so a restart is picked up);
- the chosen backend is pinned to that adapter process for the lifetime of a *backend
  generation* (see 3.3);
- **a second agent runs a second adapter process with its own profile directory and its
  own `backend.json`.** One agent therefore cannot switch another's backend — there is no
  shared mutable "current backend".

### 3.2 Selection algorithm

```
on tools/call:
  cfg = read <profile>/backend.json        # missing/invalid -> {"backend":"min"}
  if cfg.backend not in {"min","chrome"}:  -> structured error `invalid_backend`
  if no live binding for cfg.backend:
      binding = start_backend(cfg.backend)     # bounded; see 3.3
  if binding.generation != process.bindingGeneration:
      # the backend was restarted outside this call
      -> backend_changed_unexpectedly (no silent retarget)
  forward call to binding
```

### 3.3 Lifecycle states, and what switching means

| State | Meaning | Behaviour |
|---|---|---|
| `unbound` | no backend started yet | first call starts the configured backend |
| `starting` | process launched, discovery/channel not ready | bounded wait, then `backend_unavailable` |
| `ready` | usable | normal operation |
| `degraded` | reachable, capability subset | calls proceed; capability-gated tools return `unsupported_on_backend` |
| `lost` | process died mid-call | in-flight tools fail `backend_lost`; **no automatic retry** |
| `disposed` | cleaned up | adapter exits or waits for a new selection |

**Explicit switch semantics (the important part):**

1. A change to `backend.json` takes effect **only when no operation is in flight**.
2. On the next call the adapter observes the change and **starts a NEW binding**. It does
   **not** migrate anything: no tab is carried over, no ref is reused, no download
   continues, no grant survives.
3. All IDs from the previous backend become invalid. A stale ref returns
   `stale_backend` (a *distinct* category from `ref_stale`), never `ref_not_found`, so a
   client can tell "wrong backend" from "element moved".
4. `browser_status` reports `backend`, `backendVersion`, `generation` and `capabilities`.
5. Switching back does not restore the old tabs. The old Min instance may still be running
   (it is a GUI app); the agent simply no longer drives it.

**No implicit migration. No reuse of backend-specific IDs. No silent retargeting.**

### 3.4 Startup, cleanup, timeout

| Concern | Rule |
|---|---|
| Min startup | unchanged (`scripts/min-launch.js`, discovery file, 60 s bound) |
| Chrome startup | per §5 model: bounded launch + readiness poll; no infinite wait |
| Attach to an existing backend | **not automatic**; the adapter starts/uses only what it owns |
| Timeout | per-call bound already exists; backend start gets its own bound with `backend_timeout` |
| Cleanup | adapter owns the process it started; `/PID`-targeted kill only, never `/IM` |
| Crash | `lost` state; the client must re-select/re-run; the adapter never resurrects implicitly |

---

## 4. Adapter interface proposal

### 4.1 The backend-specific surface (measured from source)

The bridge's Electron coupling is concentrated. Across `main/agentRpc.js`, handlers use:

```
wc.getURL  wc.getTitle  wc.isLoading  wc.isCrashed  wc.isDestroyed  wc.isFocused
wc.id      wc.session   wc.executeJavaScript  wc.sendInputEvent  wc.insertText
wc.capturePage  wc.printToPDF  wc.downloadURL  wc.setZoomFactor
wc.getZoomFactor  wc.focus  wc.close  wc.destroy  wc.mainFrame  wc.on  wc.removeListener
wc.debugger (3 allowlisted commands)   viewMap / windows (composition, attach)
```

Everything else — validation, policy, grants, refs, batch, transforms bookkeeping,
download ledger, capability reporting, error shaping — is plain JS and **already shared**.

### 4.2 Interface (proposal, not implemented)

```ts
interface BrowserBackend {
  id: 'min' | 'chrome'
  version(): Promise<{ backend, runtime, chromium, node? }>

  // identity
  listTabs(): Promise<Tab[]>              // Tab.id is backend-namespaced
  openTab(url, {background}): Promise<Tab>
  selectTab(id): Promise<void>
  closeTab(id): Promise<void>

  // observation
  navigate(id, url, opts): Promise<NavResult>
  state(id): Promise<PageState>
  content(id, {maxChars}): Promise<string>
  snapshot(id, {format,maxNodes}): Promise<Snapshot>
  frames(id): Promise<Frame[]>
  eval(id, {expression, timeoutMs}): Promise<EvalResult>

  // interaction (must fill dispatched/delivered/verified independently)
  click(id, ref, opts): Promise<ActionEnvelope>
  type(id, ref, text, opts): Promise<ActionEnvelope>
  press(id, key, opts): Promise<ActionEnvelope>
  hover(id, ref): Promise<ActionEnvelope>
  scroll(id, opts): Promise<ActionEnvelope>
  select(id, ref, value): Promise<ActionEnvelope>
  check(id, ref, checked): Promise<ActionEnvelope>
  mouse(id, opts): Promise<ActionEnvelope>
  upload(id, ref, relPath): Promise<ActionEnvelope>

  // waiting & media
  wait(id, opts): Promise<WaitResult>
  screenshot(id, opts): Promise<ImageResult>
  pdf(id, opts): Promise<PdfResult>

  // downloads
  downloads(): Promise<DownloadRow[]>
  downloadStart(opts): Promise<DownloadHandle>
  downloadWait(id, opts): Promise<DownloadRow>
  downloadCancel(id) / downloadPause(id) / downloadResume(id)

  // lifecycle
  capability(): Promise<CapabilitySet>
  dispose(): Promise<void>
}
```

**Deliberately NOT in the interface** (these stay in shared orchestration):
validation, schema, routing, grants, policy, ref namespace registry, batch planning,
transform bookkeeping, evidence assembly, error-category mapping.

### 4.3 Pseudocode

```js
// adapter (already exists) — the change MB2 makes is small
const binding = await resolveBinding(profileDir)        // {backend, generation, client}
const res = await binding.client.call(tool, params)     // identical tool names
return mcpToolResultFor(tool, res)

// shared orchestration, backend-agnostic
function runAction (backend, tabId, action) {
  const resolved = refs.resolve(backend.id, tabId, action.ref)   // namespace check first
  if (!resolved) throw error('stale_backend' | 'ref_stale')      // distinct categories
  policy.assert(action, resolved)                                // unchanged
  const envelope = { dispatched: false, delivered: null, verified: null }
  envelope.dispatched = await backend[action.kind](tabId, action)
  return envelope    // backend fills delivered/verified only from its own evidence
}
```

### 4.4 Responsibilities that stay backend-specific

| Area | Min | Chrome |
|---|---|---|
| Composition/attach | `WebContentsView` in a window | browser tab; may be **not visible** |
| Page execution | `executeJavaScript` main world | model-dependent (§5) |
| Input | `sendInputEvent` (trusted) | CDP or extension-mediated; trust differs |
| Capture | `capturePage` / `printToPDF` | CDP screenshot / `Page.printToPDF` |
| Downloads | `session` + `downloadURL` + ledger | Browser.setDownloadBehavior (CDP) |
| Attestation | preload `contextBridge` counter | **no equivalent** unless an extension provides it |
| Frames | Electron frame tree | CDP `Page.getFrameTree` |
| AX tree | CDP `Accessibility.getFullAXTree` | same CDP command |

---

## 5. Chrome connection models

### 5.1 Documented facts (official sources, checked 2026-10-20)

| # | Fact | Source |
|---|---|---|
| F1 | **From Chrome 136, `--remote-debugging-port` / `--remote-debugging-pipe` "will no longer be respected if attempting to debug the default Chrome data directory". A non-default `--user-data-dir` is required.** | https://developer.chrome.com/blog/remote-debugging-port |
| F2 | Google recommends **Chrome for Testing** for automation, which "will continue to respect the existing behavior". | same |
| F3 | Native messaging requires a manifest with `allowed_origins` (**no wildcards**), `type:"stdio"`, and on Windows a registry key under `HKCU`/`HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\<name>`. | https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging |
| F4 | Native messaging message size: **host→Chrome max 1 MB**, Chrome→host max 64 MiB; 32-bit native-order length prefix; Windows requires `O_BINARY`. | same |
| F5 | The host is started per `connectNative()` port; `sendNativeMessage()` starts a process per message. | same |
| F6 | Extension **content scripts share a renderer with untrusted pages**; the official guidance is to validate `sender.origin` and sanitize before forwarding to the native host. | same |
| F7 | Native messaging APIs are **not available in content scripts**, only in extension pages/service worker. | same |

### 5.2 Comparison

| Criterion | Model A — extension + native messaging on the **user's existing Chrome** | Model B — separately launched **isolated Chrome** with restricted debugging |
|---|---|---|
| Existing profile | **Yes** — the whole point | No (fresh `user-data-dir`) |
| Install/consent | Extension install + registry key + host binary; user must accept | Launch a process with flags; no extension, no registry |
| Tab identity/lifecycle | `chrome.tabs` events; reconnection via the service worker | Target list from the debugging channel |
| Navigation | `chrome.tabs.update` | `Page.navigate` |
| DOM observation | content script injected per tab (`executeScript`) | `Runtime.evaluate` |
| Click/type | **Not truly possible**: content-script events are `isTrusted:false`; trusted input requires the debugger | `Input.dispatchMouseEvent` / `insertText` (trusted) |
| Page evaluation | content-script world / `MAIN` world via `executeScript` | main world via `Runtime.evaluate` |
| Waits | content-script polling | CDP events (`Page.loadEventFired`, `Network`) |
| Screenshot | `chrome.tabs.captureVisibleTab` (**visible tab only**) | `Page.captureScreenshot` (`captureBeyondViewport` supported) |
| Downloads | `chrome.downloads` | `Browser.setDownloadBehavior` |
| Upload | content script cannot set files (security) | `DOM.setFileInputFiles` |
| Frames | content script per-frame via `all_frames` | `Page.getFrameTree` |
| Verification/attestation | `isTrusted:false` for a container-injected script unless using `userScripts`/`debugger` | CDP input is trusted; still not paint-level |
| Update/protocol risk | Extension must keep pace with Chrome MV3 changes | CDP version drift |
| Windows | registry + `O_BINARY` + AV/binary-signing friction | ordinary process launch |
| ADR-02 fit | **Would need a per-tab debugger for trusted input** — conflicts | **Would need generic CDP** — conflicts *unless* bounded by an allowlist |
| **Verdict** | **Excluded for MB3** (cannot honour the existing `dispatched/delivered/verified` contract without weakening it) | **Recommended starting model** |

### 5.3 Recommendation and exclusions

> **Start with Model B: a separately launched, isolated Chrome (Chrome for Testing
> preferred) with its own `user-data-dir`, driven through a *fixed, closed* command set.**

Rationale, tied to facts: F1 makes "attach to the user's normal Chrome via remote
debugging" **impossible without a custom `user-data-dir`** — so the "existing profile"
model is already not available by the debugging route. Model A remains possible only via
extension messaging, but cannot deliver trusted input or full-page capture without adding
a debugger connection, which fails the truthfulness contract.

**Excluded scenarios (explicit):**
- Attaching to the user's everyday Chrome profile (F1 — not supported since 136).
- Controlling a *pre-existing* Chrome instance the adapter did not launch.
- Reading or copying a user's cookies/passwords/profile data.
- Presenting extension-injected `isTrusted:false` events as trusted delivery.
- Any bypass of a challenge or access control.

---

## 6. Tool-by-tool portability matrix (all 39, enumerated from source)

Legend: **SL** shared logic · **MO** Min-only · **CI** Chrome-implementable ·
**PC** partial on Chrome · **UC** unsupported on Chrome · **NI** needs investigation.

| # | Tool | Class | Chrome mechanism | Safety / parity notes |
|---|---|---|---|---|
| 1 | `browser_status` | **SL** | backend reports its own identity | must add `backend` + `capabilities`; no new tool |
| 2 | `browser_health` | **SL** (shape) | backend-specific checks | Min checks (discovery/token/profile) do not exist for Chrome → per-backend checks |
| 3 | `browser_tabs` | **CI** | target list | tab id namespaced |
| 4 | `browser_tab_open` | **CI** | `Target.createTarget` | `background` semantics differ |
| 5 | `browser_tab_select` | **CI** | `Target.activateTarget` | headless: no visible activation |
| 6 | `browser_tab_close` | **CI** | `Target.closeTarget` | last-tab rule is Min UI policy → `MO` part |
| 7 | `browser_navigate` | **CI** | `Page.navigate` + load event | stability window reimplemented |
| 8 | `browser_content` | **CI** | `Runtime.evaluate` innerText | CSP blocks it (same class as Min) |
| 9 | `browser_snapshot` (json/text) | **CI** | injected snapshot fn | needs the same DOM walker ported |
| 10 | `browser_snapshot` (`format:'ax'`) | **CI** | `Accessibility.getFullAXTree` | identical command |
| 11 | `browser_eval` | **CI** | `Runtime.evaluate` | main-world only; CSP-honest |
| 12 | `browser_click` | **CI** | `Input.dispatchMouseEvent` | trusted; verification must be re-derived |
| 13 | `browser_type` | **CI** | `Input.insertText` / key events | `mode:'keyboard'` possible |
| 14 | `browser_press` | **CI** | `Input.dispatchKeyEvent` | |
| 15 | `browser_hover` | **CI** | mouse move | hover delivery already `[FLAKY]`/unverified |
| 16 | `browser_scroll` | **CI** | `Input.dispatchMouseEvent` wheel **or** `Runtime.evaluate` scroll | wheel drop is a compositor issue on both |
| 17 | `browser_select` | **CI** | DOM set + events | |
| 18 | `browser_check` | **CI** | DOM set + events | |
| 19 | `browser_mouse` | **PC** | CDP input | `screenshotId`-relative coords depend on capture parity |
| 20 | `browser_wait` (`ready_state`) | **CI** | `Page` load state | |
| 21 | `browser_wait` (`selector_visible`) | **CI** | `Runtime.evaluate` poll | |
| 22 | `browser_wait` (`network_idle`) | **PC** | `Network.*` events | Min has per-webContents counters; Chrome needs event draining (which ADR-02 bans *inside Min*) |
| 23 | `browser_screenshot` | **CI** | `Page.captureScreenshot` | |
| 24 | `browser_screenshot` (`fullPage`) | **PC→CI** | `captureBeyondViewport` | Chrome can do this *natively*; must still report `completeCapture` honestly |
| 25 | `browser_screenshot` (element/`selector`) | **CI** | clip rect | |
| 26 | `browser_pdf` | **CI** | `Page.printToPDF` | |
| 27 | `browser_viewport` | **PC** | `Emulation.setPageScaleFactor` / device metrics | Min's is per-tab zoom, not resize — semantics must not silently change |
| 28 | `browser_frames` | **CI** | `Page.getFrameTree` | |
| 29 | `browser_upload` | **CI** | `DOM.setFileInputFiles` | path policy reuses the same validator |
| 30 | `browser_downloads` | **CI** | download behavior + own ledger | ledger lives in the adapter (shared) |
| 31 | `browser_download_start` | **CI** | `Browser.setDownloadBehavior` | |
| 32 | `browser_download_wait` | **SL** | adapter-side wait over ledger | |
| 33 | `browser_download_cancel` | **CI** | `Browser.cancelDownload` | |
| 34 | `browser_download_pause` | **UC** | no CDP pause | must return `unsupported_on_backend` |
| 35 | `browser_download_resume` | **UC** | no CDP resume | same |
| 36 | `browser_grant` | **SL** | adapter-side state | unchanged semantics; must be backend-scoped |
| 37 | `browser_batch` | **SL** | adapter-side planner | inherits per-tool support |
| 38 | `browser_transform` | **CI** | `Runtime.evaluate` (injected CSS/DOM) | restore contract ported |
| 39 | `browser_transform_status` | **SL** | adapter-side bookkeeping | |
| — | `browser_predict` | **CI** | DOM inspection | pure page logic |
| — | `browser_verify` | **CI** | page inspection | |
| — | `browser_state` | **PC** | mixed | CAPTCHA/dialog/focus signals are Min-observed; Chrome must report `unavailable` per field |

**Min-only surface that must NOT be faked on Chrome:** window/menu/settings operations,
the last-tab UI rule, profile-level ad-blocker counters, Min's own `min://` pages, the
preload-based delivery attestation, and dialog observation.

**Census impact: none.** MB0 changes no schema; Chrome support is expressed as per-tool
capability values, not new tools.

---

## 7. IDs, profiles, permissions, security model

### 7.1 Namespaces

| Entity | Rule |
|---|---|
| Agent/session | one MCP adapter process = one session; own profile dir (ADR-04) |
| Backend | `"min"` \| `"chrome"`, immutable within a binding generation |
| Tab | `min:<tabId>` / `chrome:<targetId>` internally; wire form keeps the existing opaque string |
| Element ref | `r…` scoped to `(backend, tabId, snapshot generation)` |
| Frame | backend-namespaced frame id |
| Download | adapter-assigned id; ledger row records backend |
| Grant | bound to `(backend, tabId, ref?)`, single-use, already consumed-in-command |

**Cross-backend rule:** a ref minted by Min is **never** resolvable by Chrome. Resolution
checks the `(backend, tabId)` tuple first and fails **`stale_backend`** before any element
lookup. Switching backends rotates the generation, so every prior ref is invalid.

### 7.2 Security model (threats → controls)

| Threat | Control |
|---|---|
| Extension spoofing / rogue host | `allowed_origins` must name **exactly** our extension id (no wildcards, F3); host validates the extension origin argument |
| Debug endpoint exposure | Model B binds to a **per-launch token**; port ephemeral; loopback only; never the default profile (F1) |
| Native host message abuse | enforce 1 MB host→Chrome cap (F4); validate `sender.origin` server-side (F6) |
| Arbitrary page evaluation | same policy as Min: `browser_eval` is agent-authored but token-gated; **no** arbitrary CDP command passthrough (ADR-02) |
| Upload/download path access | reuse `agentRpcDlValidateRelPath` + containment + symlink walk; one validator, never a second weaker one |
| Secret leakage | same redaction at write time; no page text/values in evidence; screenshots are images, never OCR'd |
| Concurrent agents | separate profiles + per-session binding; no shared writable profile |
| Crash/restart mid-operation | `lost` state; no auto-retry; explicit re-run; grants never replayed |

**Preserved unchanged:** ADR-05 loopback/ephemeral-port/per-launch-token/discovery;
ADR-02 no *generic* raw CDP. **New constraint needed at MB3:** the Chrome backend's command
set must itself be a **closed allowlist constant** in source — the same shape as
`AGENT_RPC_CDP_ALLOWED` — with no caller-supplied command names or parameters.

---

## 8. Migration plan MB1–MB6 with acceptance gates

| Milestone | Work | Acceptance gate (must be green before the next) |
|---|---|---|
| **MB1** | Extract the backend-specific surface behind an internal interface; Min behaviour byte-identical | `agent-rpc-test` 306/306 · `mcp-e2e` 93/93 · all Min probes unchanged · census 39 · **no schema change** · `probe:realweb` green |
| **MB2** | `backend.json` selection, session binding, `stale_backend`, `browser_status` reports backend+capabilities. **Operationally Min-only** | two concurrent adapters on two profiles cannot affect each other · switching invalidates all refs (proven) · Min probes still green · Layer C green |
| **MB3** | First Chrome path: launch/attach + `browser_status`, `browser_tabs`, `browser_snapshot`, `browser_content` (read-only subset) | Chrome-backed Layer B probe + **Layer C on a real public page**; capability set honest; unsupported tools return `unsupported_on_backend` |
| **MB4** | `browser_navigate`, `click`, `type`, `press`, `scroll`, `select`, `check` with honest `dispatched/delivered/verified` | real-web acceptance per tool; delivery claims never exceed evidence; no CAPTCHA policy change |
| **MB5** | waits, screenshots (incl. honest full-page), downloads, upload, frames, transforms, predict/verify | per-tool real-web evidence; `download_pause/resume` documented `UC` |
| **MB6** | Real-web acceptance matrix, documentation, explicit Min-only/partial inventory | full Layer A/B/C; MTX published; no tool claimed beyond its evidence |

Every milestone that adds a capability ships a **vetted real public-web test plus
assertions in the same change**. Where no safe public target exists, Layer C is marked
**BLOCKED** with the reason.

---

## 9. Test strategy (Layer A/B/C separation preserved)

| Layer | Role | Backend scope |
|---|---|---|
| **A** | pure logic: validation, policy, grants, namespaces, capability negotiation | both (shared code) |
| **B** | deterministic fixtures through the shipped MCP adapter | per backend; Min fixtures stay authoritative |
| **C** | real public pages through the shipped adapter | **required** per tool per backend; BLOCKED if unsafe |

Additional gates specific to multi-backend:
- **Isolation test:** two adapters, two profiles, different backends, interleaved calls — no
  cross-talk, no ref accepted by the wrong backend.
- **Switch test:** refs from generation N are rejected with `stale_backend` after a switch.
- **Honesty test:** every `UC`/`PC` tool returns its declared status, asserted negatively
  (it must **not** silently succeed).

Fixtures never substitute for Layer C. Tests that rewrite `docs/*.json` are only run when a
milestone requires it, and the writes are accounted for.

---

## 10. Open questions, constraints, unsupported scenarios

**Blocking questions (must be answered before MB3 coding):**

1. **Which exact Chrome build?** `chrome.exe` (F1 forces a custom profile) vs **Chrome for
   Testing** (F2, automation-sanctioned). Recommendation: Chrome for Testing; needs a
   download/distribution decision.
2. **Is CDP acceptable for the Chrome backend at all?** ADR-02 bans *generic raw CDP inside
   Min*. A Chrome backend driven by a closed allowlist is arguably a different thing, but it
   is a **new ADR decision**, not an interpretation. This is the single largest unresolved
   item.
3. **Where does the Chrome backend client live?** Inside the adapter (Node) or a separate
   helper process? Affects process ownership and cleanup.
4. **Extension vs no extension.** Model A is excluded for MB3; if the user's *existing*
   profile is ever required, that needs a new design and a new consent story.

**Constraints carried forward:** no formatter; no bundling of CloakBrowser; no CAPTCHA
behaviour change; no broad `/IM` kills; register append-only.

**Unsupported on Chrome (by design, not by omission):** Min window/menu/settings
operations, Min `min://` internal pages, last-tab UI policy, preload-based delivery
attestation, dialog observation, ad-blocker counters, `download_pause`/`download_resume`.

**Unverified / needs investigation:** whether extension-mediated DOM events can ever be
trusted without a debugger (believed **no**; F6 implies content-script context); whether
`network_idle` can be honoured without event draining; whether `browser_mouse`
`screenshotId` semantics survive a different capture pipeline; Chrome CDP version drift
against the pinned allowlist.

---

## Appendix A — verified census (from source, this task)

All four surfaces agree at **39**:

| Surface | Source | Count |
|---|---|---|
| Registry | `main/agentRpc.js` `AGENT_RPC_METHODS` | 39 |
| Schemas | `main/agentRpc.js` `AGENT_RPC_PARAM_SCHEMAS` | 39 |
| Dispatch | `main/agentRpc.js` `AGENT_RPC_DISPATCH_TABLE` | 39 |
| Adapter | `mcp/min-agent-mcp.js` `TOOLS` | 39 |

No tool appears in one surface and not another (verified programmatically).

## Appendix B — existing bounded CDP allowlist (unchanged)

```js
const AGENT_RPC_CDP_ALLOWED = Object.freeze({
  'DOM.setFileInputFiles': true,
  'Accessibility.getFullAXTree': true,
  'Runtime.evaluate': true
})
```

Three commands, hard-coded, no caller-supplied command or parameter name. Any Chrome
backend must copy this shape, not generalise it.
