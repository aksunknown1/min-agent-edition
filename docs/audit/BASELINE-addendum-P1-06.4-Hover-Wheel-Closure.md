# P1-06.4 — Final Hover/Wheel Triage & Phase Closure (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · Production source changes: **none** (temporary diagnostics only, removed after evidence capture)

## 1. Baseline (exact two failures, strict)

`npm run probe:mouse` ×3 pre-experiment (AI source state): consistent **25/27**; the two persistent
strict failures: `hover state visible (Hover: on box) without click` and `wheel page-side delivery
(page counter, independently read)`. Event-field audit: Electron 43.4.1 `MouseWheelInputEvent`
supports `accelerationRatioX/Y`, `canScroll`, `deltaX/deltaY`, `hasPreciseScrollingDeltas`,
`wheelTicksX/Y` (+ inherited `globalX/globalY/movementX/Y`); the implementation dispatches with
`canScroll:true` but does not send the optional-variant fields (they become the B/C variants).
`status` verified observational-first; no unconditional window focus (P1-06.3 fixes intact).

## 2. Wheel experiments A–D (scripts/p1-064-clean-diag.js → p1-064-diag.log)

Production view + fixture with page-side wheel counter, delta log, and independent scrollY:

| variant | payload additions                                                                       | page wheel event | scroll |
| ------- | --------------------------------------------------------------------------------------- | ---------------- | ------ |
| A       | current (`canScroll:true`)                                                              | **0**            | 0      |
| B1      | +`hasPreciseScrollingDeltas:true`                                                       | **0**            | 0      |
| B2      | +`wheelTicksX/Y`                                                                        | **0**            | 0      |
| D       | CDP `Input.dispatchMouseEvent type:mouseWheel` (diagnostic, no port, own attach/detach) | **0**            | 0      |

All wheel variants incl. **CDP** are dropped in the production view on this Electron/OS —
`mouseWheel page delivery: PLATFORM_LIMITED / NOT_VERIFIED (drops in Min production windows; the
identical payload delivered in minimal fresh windows in P1-06.3-era checks intermittently)`.
Harness note: one earlier run (P1-06.4 probe run1) did show compositor delivery once
(`wheelEvents>=1`) — delivery is **intermittent**, not reliable; `browser_scroll` (DOM) remains
the reliable semantic scroll and is unchanged.

## 3. Hover investigation (production view, accumulating event-coordinate log)

Recorded timeline (`p1-064-hover-diag.js`), physical cursor at 1600,1036:

```
base:            MLOG:1600,1036                 (physical cursor stream)
T+150 (inject move to 139,150):  still 1600,1036            ← injected move pending/dropped
T+750:           1600,1036 | 139,150 | 1600,1036            ← transient delivery, then re-assertion
T+1750:          1600,1036 | 139,150 | 1600,1036            ← stable state: physical cursor
after away+back: ... 139,150 | 1600,1036 | 1599,1035 ...   ← repeats identically; INBOX:1 transient
```

**Conclusion**: synthetic movement _does_ transiently enter the hover target and establish
`:hover` for one sampled instant, then the physical cursor re-assertion immediately overrides it.
**Durable synthetic hover is not possible on this platform without moving the physical OS
cursor (forbidden/OS-global)** — classified as a platform limitation; no simulation via DOM
events was adopted. No safe existing input path to durable hover was found (CDP listed for
completeness; its wheel events were dropped, so no separate input authority was adopted).

## 4. Changes

**No production source changes.** Temporary diagnostics added and removed:
`scripts/p1-064-*.js` (evidence retained in `C:/Users/AKS-PC/AppData/Local/Temp/p1-064-diag.log`
contents quoted above). Backup dir: `docs/backups/P1-06.4/main_agentRpc.js`.

## 5. Final regression matrix (raw counts)

| command                                                     | exit  | result                                                                         |
| ----------------------------------------------------------- | ----- | ------------------------------------------------------------------------------ |
| `npm run build`, syntax checks                              | 0     | clean                                                                          |
| `npm run test:agent-rpc`                                    | 0     | 182/182 (census 31)                                                            |
| `node scripts/mcp-e2e.js`                                   | 0     | 56/56                                                                          |
| `npm run probe:mouse` ×3 (post-experiment source identical) | 0/2/2 | **27/27, 26/27, 26/27** (intermittent wheel-page delivery; hover passed all 3) |
| `npm run probe:transform` / `downloads`                     | 0     | 18/18, 33/33                                                                   |
| pav / inputs / captcha / waits                              | 0     | 15/15, 20/20, 14/14, 16/16                                                     |
| tabs ×5                                                     | 0     | 16/16 each                                                                     |
| actions / snapshot / nps                                    | 0     | 33/33, 27/27, 38/38                                                            |
| capture / detach, smoke ×3                                  | 0     | 0, 0, 6/6 ×3                                                                   |
| stray electrons                                             | —     | 0                                                                              |
| ad-blocker                                                  | —     | 1 effective `onBeforeRequest` (filtering.js:272); bridge 0                     |

## 6. Final capability contract for downstream phases

| capability                                                                                      | contract                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| click / down / up / right-click (`explicit tabId+coords`)                                       | **Trusted page-level input, verified page-side.**                                                                                                                                                                |
| standalone move / smooth path                                                                   | Dispatched and **page-observed** (verified with page counters); pointer state is transient — physical cursor re-assertions override final pointer position; hover-dependent assertions are inherently transient. |
| drag                                                                                            | Down/up deliver; intermediate move events subject to the same transient behavior (drop verified with absolute-positioned targets when moves deliver).                                                            |
| durable hover                                                                                   | **NOT POSSIBLE SAFELY** without moving the physical OS cursor (forbidden). CSS `:hover`/mouseenter effects must not be asserted as persistent by agents.                                                         |
| Electron wheel page delivery                                                                    | Dispatch per contract; **delivery intermittent-to-dropped** in production views (document).                                                                                                                      |
| DOM `browser_scroll`                                                                            | **PASS** — the reliable semantic scroll method.                                                                                                                                                                  |
| screenshot/MCP image transport, downloads, transforms, tabs, navigation, extensions, ad-blocker | All **intact** (verified this phase).                                                                                                                                                                            |
| OS-global cursor                                                                                | NOT_IMPLEMENTED (forbidden by roadmap scope).                                                                                                                                                                    |

## 7. Gate decision: **PARTIAL PASS — P1-06 CLOSED with accepted limitations**

Durable hover and reliable wheel page delivery are demonstrably platform-limited (A–D evidence +
timeline), everything else sound. Stop here; P1-07 not started.
