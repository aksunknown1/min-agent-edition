# P1-15 — Agent-Native Browser Capabilities (Audit Addendum)

Date: 2026-10-19 · Branch `main @ 2b8088e` + accumulated local/uncommitted work (CAPTCHA correction, VPS reconciliation, hygiene, and now the P1-15 capability set). **No commit, no push.**

## M0 — Baseline verification (current tree, not the VPS checkout)

| reported issue                                            | status in this tree                                                                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| blanket captcha click/type lock                           | **reproduced & already fixed in the working tree** (P1-13 follow-up correction; preserved everywhere)                                   |
| unconditional 5 s settling                                | **reproduced** (`AGENT_RPC_VERIFY_WINDOW_MS = 5000` + fixed beats, no opt-out)                                                          |
| batch stopOnError hard-wired                              | **reproduced** (no stopOnError/recoverStale params)                                                                                     |
| ref_stale with no recovery                                | **reproduced** (batch reported the failure and stopped)                                                                                 |
| screenshot single-shot cap failure left page unverifiable | **reproduced** (`screenshot_too_large` rejected outright; no ladder, no element capture)                                                |
| profile-blind MCP adapter launch error                    | **reproduced** (adapter error message did not identify the configured profile)                                                          |
| content maxChars minimum 1000                             | **reproduced** (`min: 1000` in both schema layers)                                                                                      |
| password verification length-only                         | **reproduced** (sensitive set used valueLength comparison for verification vocabulary)                                                  |
| `received === total` treated as completion                | **not reproduced** in the current tree (done event already drives terminal state) — hardened anyway against the done-before-attach race |
| mouse reporting distinction                               | already truthful (`dispatched:true` + `delivery:'unverified'` + documented compositor notes)                                            |

## M1 — `browser_eval` (implemented + tested)

- Bridge: `agentRpcCommandEval()` + `AGENT_EVAL_PAGE_FN` (transported via `.toString()`, the same mechanism as the snapshot page-fn). Expression runs in the **target tab's main world** via `webContents.executeJavaScript` with the expression passed as a JSON-string argument and evaluated with `new Function` inside the page — never in Node.
- Per-webContents evaluation queue (bounded 24; busy surfaced otherwise).
- Serialization **inside the page**: cycles → `circular`, functions → name, Errors → name/message, DOM nodes → nodeType/tag/id/text/box, ImageData → dims + bounded preview, strings truncated at tier caps, depth 6, two-tier (full → tight) output with `truncated` flag.
- Bounded timeout race; timeout error states the honest limitation (endless SYNCHRONOUS expressions keep the renderer busy — reload to recover).
- MCP catalogue: `browser_eval` schema (tabId/expression/awaitPromise/timeoutMs/maxResultChars).
- Census: **33 tools** (31 + browser_eval + browser_viewport); all census assertions updated (`mcp-e2e`, `agent-rpc-test`, `p111-coldstart-accept`, docs).
- Tests: `scripts/agent-eval-probe.js` → **22/22** (DOM props, canvas getImageData summary, localStorage http-origin real read + file://-denied honest exclusion, mutation + independent verify, awaited/rejected promises, exceptions, oversize truncation, circular, missing tab, timeout, tab targeting, no Node/process leak, result shape).

## M2 — Truthful input execution + batch semantics

- `verification: 'standard' | 'none'` on `browser_click` and `browser_press` (both layers):
  - `standard` keeps the ≤5 s window (unchanged).
  - `none` returns immediately: `{dispatched:true, verified:false, verification:'none', note}` — an honest dispatch-only status; never implies landing.
  - Measured effect: click-with-none returns without the verify window (deterministic check in mcp-e2e).
- `browser_batch`: `stopOnError` (default true — unchanged behavior) and `recoverStale` (default false):
  - `stopOnError:false` — failing step reported, later steps continue (verified: mcp-e2e two-step case).
  - `recoverStale:true` — on `ref_stale`: re-snapshot once, re-resolve the ORIGINAL target by its unique identity (role+name+nameIndex) and retry once; ambiguity raises an actionable error (unknown identity case verified: structured recovery failure, never silently re-targeted).
- Keyboard ordering: per-webContents bounded press queue (ordered keyDown/keyUp pairs; concurrency-safe chain that never poisons later presses; busy beyond 24).
- Old fixed-5s settling is now opt-out (verification:'none'); the standard bounded window remains available and is the default.

## M3 — Screenshot fallback ladder + element capture + viewport

- `browser_screenshot`: new params `maxBytes` (5000–5242880) and `selector`.
  - Adaptive ladder: full-detail first; then 0.5 scale/jpeg80, 0.35/jpeg60, 0.25/jpeg45, 0.2/jpeg35 until one rung fits the cap; response metadata reports `source` (full/element), `scaled`, `attempts`, `ladder` rung list.
  - All-rungs-fail → `screenshot_too_large` with the cap and attempts (page never becomes permanently unverifiable via reload/browser_viewport options).
  - Element capture: bounded selector → in-page rect resolve+scrollIntoView+clamp → NativeImage crop → ladder. Invalid selector/zero-size → structured invalid_params.
  - Noise-canvas real-image test and low-cap rung behavior verified in mcp-e2e (real image bytes delivered; scaled rung used).
- `browser_viewport`: per-tab zoom scale (0.25–3) via `wc.setZoomFactor`; returns previousZoom for restore; cssPerPixel/screenshots reflect it. Window-level resize is not per-tab in Min's architecture (documented).

## M4 — Correctness fixes

1. Profile-aware failure: both adapter failure messages now name the configured profile directory, the discovery paths tried, and the exact per-profile launch command (no tokens).
2. Downloads: done-before-attach race hardened (state re-checked immediately after event attach; `received === total` never treated as terminal). Existing behavior otherwise verified correct.
3. `browser_content.maxChars` minimum lowered 1000 → 200 in both schema layers (verified: 300-char excerpt honored).
4. Password verification: sensitive types use exact internal comparison with non-secret outcomes — `verification:'value'` on exact match (value never returned), `match:false` mismatch surfaces via native-setter fallback (exact), length fallback only when comparison is unavailable. Locate-mode page-fn computes `matchExact` without exposing the value.
5. Mouse reporting remains truthful (dispatch/delivery distinction; wheel/hover/drag documented); P1-06.1/06.4 tests preserved — mouse probe re-ran **28/29** (wheel failure persisted, honestly recorded).

## CAPTCHA correction preserved (verified)

zero `nearCaptcha === true` guards; policy fences ×2 in bridge; `probe:captcha` **19/19**; challenge-click-not-refused + detection-persists checks included in the suite again this task; no solving/stealth/bypass.

## Final validation (executed in this task)

| suite                                                                                       | result                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `probe:eval` (new)                                                                          | **22/22**                                     |
| `mcp-e2e.js` (33-tool census + P1-15 acceptance block)                                      | **56/56**                                     |
| `test:agent-rpc`                                                                            | **182/182** (census updated to 33)            |
| `p1-07-updater-test` / `probe:transform` / `probe:tabs` / `probe:waits` / `probe:downloads` | 18/18 · 18/18 · 16/16 · 16/16 · 33/33         |
| `probe:captcha` / `probe:pav`                                                               | 19/19 · 18/18                                 |
| `probe:mouse`                                                                               | **28/29** (documented wheel compositor limit) |
| smoke / proctools-test                                                                      | 6/6 · 9/9                                     |
| single-effective `onBeforeRequest`                                                          | 1 (`main/filtering.js:293`)                   |
| secret scan (436-file publish set)                                                          | 0 hard findings                               |

## Remaining limitations (honest)

- Browser_eval timeout cannot cancel an endless synchronous expression (V8 has no external interruption); recovery = reload. Awaited promise racing likewise returns but the page continuation may still complete later.
- `new Function` in the page may be blocked by a page's strict CSP (`unsafe-eval` absence) — eval then fails with a structured error; documented.
- Viewport tool is zoom-based (per tab); window resizing is not per-tab in this architecture.
- Element-crop coordinates derive from the viewport-relative rect after scrollIntoView; extremely tall elements (> viewport) capture only the visible portion (by design of crop semantics).
- Packaged artifacts are pre-P1-15 (rebuild before claiming packaged parity); VPS/Linux not tested.

Deferred scope honored: no `qa/` harness implementation, no `qa/live/` move, no lint/audit fixes (documented as follow-ups). Working tree: ~59 local changes, uncommitted.
