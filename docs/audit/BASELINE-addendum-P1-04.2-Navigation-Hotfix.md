# P1-04.2 — Navigation Regression Hotfix (Close-Out Addendum)

Date: 2025-10-18 · Scope: fix the `browser_navigate` regression + transform-lifecycle defects surfaced by the corrected `probe:transform` · Backup: `docs/backups/P1-04.2/main_agentRpc.js`

## 1. Exact code changes (main/agentRpc.js only)

| #   | Location                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `agentRpcCommandNavigate`               | Removed the bare `return new Promise` (a broken statement that threw `TypeError: Promise resolver undefined is not a function` on **every** `browser_navigate`, before the real Promise body was ever reached)                                                                                                                                                                                                                                                                    |
| H2  | `agentRpcCommandNavigate`               | Moved `agentRpcClearTransforms(String(tabId))` from the top of the function (it ran even on rejected requests) to just before the first `attempt()` call — after all validation (missing view, URL policy, params, view-attached). Rejected navigations no longer destroy active transform records; retries reuse the already-cleared state (single clear per navigation)                                                                                                         |
| E1  | `agentRpcResolveTargetForTransformPlan` | Selector-targeted ops now carry a unique synthetic `ordinal: 'sel' + pi`. Previously every selector op had `ordinal: undefined`, so the command's `planById` map collided on `'undefined:<op>'` (last-wins): earlier batch targets' records were labeled with the LAST plan entry's selector, and restore envelopes could restore target A's original text into target B (observed: `"sel":"#p2"` + `"restoredText":"Original paragraph one"`). Data-integrity bug (engine-level) |
| E2  | `agentRpcCommandTransformStatus`        | driftcheck ops now include `sel: rec.selector` — without it, selector-targeted records can never be resolved page-side and would false-positive drift                                                                                                                                                                                                                                                                                                                             |
| E3  | page fn `driftcheck` mode               | `entryDC` now carries `op: dc.op` — the status command filters on `p.op === 'driftcheck'`, which never matched before, so **drift was never reported** (always `[]`)                                                                                                                                                                                                                                                                                                              |
| E4  | page fn `content` mode                  | Bounded open-shadow-root text walk (≤2000 hosts / 200 shadow elements, same TEXT_CAP) — `innerText` never includes shadow roots, so the previously documented claim that `browser_content` surfaces shadow text was not implemented in this mode                                                                                                                                                                                                                                  |

## 2. Root cause of the pre-hotfix regression wave

The stray `return new Promise` threw synchronously for every `browser_navigate` call. Navigation- dependent probes failed in cascading fashion: waits probe recorded `browser_navigate → status 500`; NPS probe died with a fatal parse error; captcha capture 7/14; agent-actions 32/33; MCP e2e tool-flow failures. **This was the entire cause** — no global-scope pollution. All restored with H1/H2 alone.

## 3. Corrected transform probe reconciliation

`package.json` → `"probe:transform": "node ./scripts/agent-transform-probe.js"`. History: the
"11/16" and "13/20" figures came from two different intermediate probe scripts, both non-runnable
on the current build (the file package.json pointed at crashed with `ReferenceError: PAGE is not
defined` before executing any check). The corrected 18-check strict-assertion suite (CSS-selector
targeting, one genuine snapshot ref for the stale case, bounded 429 backoff only, no skipped or
weakened checks) now reports **18/18**.

## 4. Full regression matrix (post-hotfix, actual results)

| gate                             | result                                                                                 | exit |
| -------------------------------- | -------------------------------------------------------------------------------------- | ---- |
| `npm run build`                  | OK (`node --check main.build.js` clean)                                                | 0    |
| `node --check main/agentRpc.js`  | clean                                                                                  | 0    |
| `npm run test:agent-rpc`         | **182/182**                                                                            | 0    |
| `npm run probe:pav`              | **15/15**                                                                              | 0    |
| `npm run probe:inputs`           | **20/20**                                                                              | 0    |
| `npm run probe:captcha`          | **14/14** (was 7/14)                                                                   | 0    |
| `npm run probe:waits`            | **16/16** (was 8/16)                                                                   | 0    |
| `npm run probe:tabs` ×5          | **16/16 each**                                                                         | 0 ×5 |
| `npm run probe:agent-actions`    | **33/33** (was 32/33)                                                                  | 0    |
| `npm run probe:agent-snapshot`   | **27/27**                                                                              | 0    |
| `npm run probe:nps`              | **38/38** (was fatal)                                                                  | 0    |
| `node scripts/mcp-e2e.js`        | **52/52** (was fatal)                                                                  | 0    |
| `probe:capture` / `probe:detach` | exit 0 / exit 0                                                                        | 0    |
| `smoke:baseline` ×3              | 6/6 PASS each                                                                          | 0 ×3 |
| `npm run probe:transform`        | **18/18**                                                                              | 0    |
| electrons after gates            | 0                                                                                      | —    |
| ad-blocker invariant             | exactly one effective `onBeforeRequest` (filtering.js line 272; bridge registers none) | ✓    |

## 5. Transform defects — now fixed, no residual engine failures

The three remaining probe failures from the pre-hotfix run were real engine defects (not
probe-only): wrong-selector restore (E1), drift never reported (E2+E3), shadow text invisible to
`browser_content` (E4). All fixed and covered by probe checks 6, 15 and 14 respectively.

Gate decision: **PASS**.
