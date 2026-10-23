# Restriction audit — agent-rpc bridge + MCP adapter (P1-01 Stage 1)

Scope: every restriction in the browser-control surface (bridge `main/agentRpc.js`, MCP adapter `mcp/min-agent-mcp.js`, tool schemas), with exact location, behavior, reason, and classification:

- **REMOVE** — artificial, no protective value.
- **IMPROVE** — genuine technical limitation; replace with a better implementation.
- **RETAIN** — essential security/privacy protection.

Method: full read of the current control surface + the measured evidence from P0-09..P1-00A probes.

---

## A. Navigation and URL policy — `main/agentRpc.js` → `agentRpcValidateUrl`, `agentRpcEffectiveProtocols`, `AGENT_RPC_ALLOWED_PROTOCOLS`

| #   | Restriction                                        | Location                                                     | Behavior                                                                                                     | Why                                                                                        | Classification                                  |
| --- | -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| A1  | Scheme allowlist `{http, https, file, min, about}` | `AGENT_RPC_ALLOWED_PROTOCOLS`, used by `agentRpcValidateUrl` | `javascript:`/`data:`/`vbscript:`/anything else → `blocked` 403                                              | script/data URLs are the classic XSS/credential-handler vectors                            | **RETAIN (essential)**                          |
| A2  | URL length cap 300 chars                           | `agentRpcValidateUrl` (also schema `maxLength`)              | longer → 400                                                                                                 | none found: URLs >300 chars are common (login flows, UTM-tagged pages). Blocks real tasks. | **REMOVE** (keep noControl; cap schema at 2048) |
| A3  | Leading/trailing-whitespace rejection              | `agentRpcValidateUrl`                                        | WHATWG strips it silently; bridge rejects                                                                    | invisible-character discipline                                                             | **RETAIN** (cheap, deterministic)               |
| A4  | `policy.json → allowedSchemes` restrict-only       | `agentRpcReadPolicy` / `agentRpcEffectiveProtocols`          | unknown schemes dropped; can only narrow the built-in set                                                    | per-profile restriction must not be able to re-enable script URLs                          | **RETAIN**                                      |
| A5  | No SPA-redirect stability check                    | `agentRpcCommandNavigate`                                    | returns `navigation verified` on `did-finish-load`; a redirect 3s later is invisible → false "task complete" | P1-00 Stage B (never implemented)                                                          | **IMPROVE (this task)**                         |
| A6  | No same-URL guard                                  | `agentRpcCommandNavigate`                                    | navigating to the current URL is allowed (reload)                                                            | none — reload is a legitimate primitive                                                    | none                                            |

## B. Actions — click/type/press — `agentRpcCommandClick/Type/Press`, `agentRpcResolveTarget`, `AGENT_RPC_RISKY_NAME`, `AGENT_RPC_KEY_TRANSLATION`

| #   | Restriction                                                         | Location                                                 | Behavior                                                                                        | Why                                                                               | Classification                                                    |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| B1  | password/email/tel/sensitive-autocomplete typing refused            | `agentRpcCommandType` redacted check                     | 403 `sensitive_field` unless grant/policy                                                       | credential privacy; passwords must be the user's (typed in the visible window)    | **RETAIN (essential)**; length-only verify already supported      |
| B2  | purchase/payment-named click refused                                | `AGENT_RPC_RISKY_NAME` + grant check                     | 403 `risky_action` unless grant/policy                                                          | high-impact financial action                                                      | **RETAIN** (grant/policy controls are the approved bypass)        |
| B3  | press key closed enum, NO modifiers/chords                          | `AGENT_RPC_PRESS_KEYS` schema enum                       | `Meta+A`, `F1` etc → 400                                                                        | chords collide with Min UI shortcuts; modifier coordination is a correctness risk | **RETAIN now; revisit when real workflows need chords**           |
| B4  | press translation table (Arrow→Up/Down…, Enter→works)               | `agentRpcTranslateKey` + `keymap-probe-main.js` evidence | runtime maps DOM keys → accelerator codes                                                       | Electron vocabulary mismatch                                                      | **RETAIN** (mechanism, not restriction)                           |
| B5  | typing verification: non-redacted value-match; redacted length-only | `agentRpcRunVerification` inspect()                      | React-controlled inputs that revert state may verify as `focus`/`dom-change` instead of `value` | unverified against real React (P0-10 known risk)                                  | **IMPROVE (this task)** — retry with native-setter event dispatch |
| B6  | click verification precedence: marker → focus (nav via events)      | `agentRpcRunVerification`                                | no in-page "state accepted" verification                                                        | the honest-signal rule                                                            | RETAIN; improved marker in this task                              |
| B7  | no hover/scroll/select/check primitives                             | absent                                                   | cannot interact with dropdowns, hover menus, scrollable pages, toggling checkboxes              | missing capability, not a protection                                              | **REMOVE (implement now)**                                        |
| B8  | ref expiry 60s, single-use-on... refs expire per TTL                | `AGENT_RPC_REF_TTL_MS`, sweep                            | refs die after 60s                                                                              | stale-ref protection: page may mutate                                             | **RETAIN** (probe re-snapshot is the designed recovery)           |
| B9  | ambiguous role+name → 409 no guess                                  | `agentRpcResolveTarget` weak fallback                    | fail rather than pick                                                                           | stale-ref protection                                                              | **RETAIN**                                                        |

## C. Snapshot / content / shadow DOM / frames — `AGENT_SNAPSHOT_PAGE_FN`, `agentRpcBoundSnapshot`

| #   | Restriction                                                                        | Location                                                | Behavior                                        | Why                                                      | Classification                                                 |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| C1  | No shadow-DOM traversal                                                            | `AGENT_SNAPSHOT_PAGE_FN` (`body.querySelectorAll('*')`) | shadow DOM content invisible; P0-09 documented  | never implemented                                        | **IMPROVE (this task)**                                        |
| C2  | No iframe traversal                                                                | same (light DOM only)                                   | iframes invisible; P0-09/P1-00 audit documented | main-frame-executed JS cannot cross origins              | **IMPROVE (this task, via `webFrameMain` iteration in main)**  |
| C3  | node cap 200/hard 500                                                              | `AGENT_RPC_SNAPSHOT_DEFAULT_NODES/HARD_NODES`           | excess nodes dropped, `truncated` flagged       | bounded response                                         | **IMPROVE** (raise hard cap to 1000; bounded response remains) |
| C4  | response cap 64 KiB                                                                | `agentRpcBoundSnapshot`                                 | drops nodes to fit                              | bounded response (agents choke on huge payloads)         | **RETAIN, raise to 256 KiB**                                   |
| C5  | name truncated 120 chars                                                           | `NAME_MAX`, `agentRpcSafeText`                          | long names cut                                  | bounded response                                         | **RETAIN**                                                     |
| C6  | sensitive values never leave the page (length-only)                                | page fn redaction                                       | password value not returned                     | credential privacy                                       | **RETAIN (essential)**                                         |
| C7  | control chars stripped everywhere                                                  | `clean()`, `agentRpcSafeText`                           | titles/labels sanitized                         | untrusted page content discipline                        | **RETAIN**                                                     |
| C8  | script/style/noscript/template skipped; headless-hidden skipped; scanned>30000 cap | page fn                                                 | decor/dead nodes excluded                       | bounded enumeration; hidden elements are not interactive | **RETAIN**                                                     |
| C9  | no page-text reading tool                                                          | absent                                                  | agent cannot READ the page, only enumerate      | missing capability                                       | **REMOVE (implement `browser_content` now)**                   |
| C10 | frames not merged; cross-origin frames skipped                                     | snapshot                                                | iframe nodes invisible                          | implementation gap (see C2)                              | **IMPROVE (this task)**                                        |

## D. Waits — absent (P1-00 Stage D never implemented)

| #   | Restriction                                         | Location                  | Behavior                                                                 | Why                | Classification             |
| --- | --------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ | ------------------ | -------------------------- |
| D1  | no `browser_wait` (network_idle / selector_visible) | absent                    | agent polls browser_tabs/snapshot externally with sleeps → flaky on SPAs | missing capability | **REMOVE (implement now)** |
| D2  | snapshot has no `waitMs`                            | `agentRpcCommandSnapshot` | snapshot races late-rendering content                                    | missing capability | **REMOVE (implement now)** |
| D3  | navigate has no post-load stability re-read         | (see A5)                  | covered by A5                                                            | duplicate          | (see A5)                   |

## E. Tabs — `agentRpcCommandTabOpen/Select/Close`, `AGENT_SNAPSHOT_PENDING_DESTROYS`

| #   | Restriction                                                                  | Location                                    | Behavior                                                                       | Why                                                         | Classification                          |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------- |
| E1  | last-tab close refused                                                       | tab_close guard                             | 409 `last_tab`                                                                 | Min window with zero views wedges this Electron             | **RETAIN**                              |
| E2  | closing detaches + defers `wc.destroy()` into the 30s sweep                  | tab_close + `agentRpcSweepSnapshotRefs`     | wc lives ≤30s after visual close                                               | mass `wc.destroy()` wedges this Electron (measured, P1-00A) | **RETAIN (essential wedge mitigation)** |
| E3  | single-window scope for select/attach (startup-tab `view_not_attached` case) | tab_select uses `windows.getCurrent()`      | select attaches into the FOCUSED window only                                   | multi-window scope deferred                                 | **RETAIN (documented scope decision)**  |
| E4  | select refuses views whose first URL hasn't loaded                           | `agentRpcAttachView` loadedInitialURL check | 409 `unsupported` for slow first paint; tab_open self-heals via `min://newtab` | attaching an unrendered view is a crash/wedge family        | **RETAIN**                              |
| E5  | tab_close of an UNLOADED view (empty wc) refused with unsupported            | n/a path inside destroy flow                | honest refusal until first paint                                               | same wedge/crash family                                     | **RETAIN**                              |

## F. Screenshots — `agentRpcCommandScreenshot`

| #   | Restriction                                      | Location                   | Behavior                                          | Why                                          | Classification |
| --- | ------------------------------------------------ | -------------------------- | ------------------------------------------------- | -------------------------------------------- | -------------- |
| F1  | attached-view only                               | attachment guard           | detached/hidden/never-shown → `view_not_attached` | P0-07/08 measured: capture wedges or rejects | **RETAIN**     |
| F2  | >5 MiB encoded → 413                             | `agentRpcScreenshotSizeOk` | bounded response                                  | huge PNGs break MCP stdio payloads           | **RETAIN**     |
| F3  | captured content never written to disk by bridge | command                    | inline base64 only                                | privacy: no screenshots accumulate           | **RETAIN**     |

## G. Downloads / uploads — session hooks

| #   | Restriction                                | Location                                         | Behavior                                                                             | Why                        | Classification                                                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| G1  | downloads NOT tracked/listed by the bridge | absent (`main/download.js` is Min's own UI flow) | agent cannot discover downloaded files                                               | missing capability         | **REMOVE (implement `browser_downloads` now, read-only listing)**                                                       |
| G2  | file uploads not supported                 | absent                                           | Electron lacks a main-process file-chooser injection API; CDP is forbidden by design | Electron/Chromium boundary | **RETAIN as documented impossibility** (manual upload in the visible window; revisit only via an official Electron API) |

## H. CAPTCHA / anti-bot — `browser_click`/`browser_type` (P1-00 Stage E design, partially implemented)

| #   | Restriction                      | Location  | Behavior                                                           | Why                                                             | Classification                                                                                                                |
| --- | -------------------------------- | --------- | ------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| H1  | NO captcha detection             | absent    | agent cannot detect a challenge; clicks near widgets are attempted | P1-00 Stage E never implemented                                 | **IMPROVE (this task): detect known widget patterns, refuse INTERSECTING click/type targets with `captcha_handoff_required`** |
| H2  | can never solve/bypass a CAPTCHA | by design | no tool attempts it                                                | user said: never bypass; handoff to human in the visible window | **RETAIN (essential)**                                                                                                        |

## I. Core protections (all RETAIN, essential)

| #   | Protection                                                                                                                        | Location                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| I1  | stdio/loopback-only control endpoints + per-launch token                                                                          | bridge HTTP server; discovery file in profile                              |
| I2  | no eval / new Function / request-derived page source                                                                              | fixed page-function sources only; data passes validated scalars            |
| I3  | page text is data, never logged, never instructions                                                                               | redaction/sanitization at every hop; content capped, control-char stripped |
| I4  | automation profile separate from everyday profile                                                                                 | launcher `--user-data-dir`, default `~/.min-agent-profile`                 |
| I5  | eligible-scheme grants (intent-scoped, single-use) + policy.json                                                                  | P0-13 commands                                                             |
| I6  | ad/tracker blocker untouched (webRequest listener chain preserved; bridge counter listeners are additive on the tab session only) | `main/filtering.js` untouched in P1-0x                                     |

## J. Flags / probes

| #   | Restriction                                | Location                                      | Classification |
| --- | ------------------------------------------ | --------------------------------------------- | -------------- |
| J1  | `--agent-rpc-allow-risky`                  | REMOVED in P0-13 (verified: zero occurrences) | resolved       |
| J2  | browser_grant hard rule (user instruction) | `mcp/README.md` §3, adapter log               | **RETAIN**     |

---

## Summary (drives Stage 2)

**REMOVE/implement now:** A2 (300-char URL cap), A5+D3 (navigate stability + SPA-redirect report + bounded retry), B5 (React/native-setter retry + `value-length`), B7 (hover/scroll/select/check), C1+C2+C10 (shadow DOM + frames + meta), C3/C4 raises (cap 1000 nodes / 256 KiB), C9 (`browser_content`), D1+D2 (`browser_wait`, `waitMs`), G1 (`browser_downloads`), H1 (captcha detect + intersect guard).

**RETAIN (essential):** A1, A3, A4, B1, B2, B3, B8, B9, C5, C6, C7, C8, E1–E5, F1–F3, G2, H2, I1–I6, J2.
