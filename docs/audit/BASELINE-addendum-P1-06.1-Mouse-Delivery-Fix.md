# P1-06.1 — Mouse Delivery Fix & Gate Recheck (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · Backups: `docs/backups/P1-06/` (P1-06.1 changes rebuild on those; pre-task state identical to `main_agentRpc.js` there)

## 1. Root cause of move-delivery loss (production-path evidence)

The P1-06 in-process diagnostic (temp `WebContentsView` created INSIDE Min's production window, counting fixture, `scripts/p1-061-insert-diag.js` + `p1-061-launch-diag.js`) proved:

- A **fresh view attached to Min's production window receives synthetic moves**: 15/15 delivered
  (`TEMP VIEW counter page: n=n:15;last:189,189`). Window/process state is NOT the blocker.
- **Min's own production page views receive 0** standalone moves (title counter stays at
  `moves:0`; later runs again 0 with coalesced-burst variants), while their clicks press/release
  fine. No stale-focus, coordinates, or DPR issue involved (focus verified `focused=true`,
  bounds `{x:0,y:36,2032x1063}` verified healthy).
- Per-view sweeps (`dispatching to all N views`) reproduce this every run.
- Electron builds in general are fine: minimal harnesses (single window, WebContentsView,
  dual-view, frameless, Min-shaped webPreferences, 30-step cadence at 16 ms) delivered 100%.

So the drop is a renderer-side/compositor-level behavior specific to Min's existing production
page views (created through Min's full `createView` pipeline with its preload bundle and
navigation history). It is _not_ a coordinate, focus, schema, or bridge issue, and _not_ the
`preventDefault` bug from P1-05 (that class was already fixed).

## 2. Additional verified root cause + fix found this phase

During re-testing, a second real defect surfaced and was FIXED: a spawned-URL tab can exist in
Min with its view **detached** (Min's window keeps a different `selectedView`; the renderer
never re-attaches programmatic tabs). Such a detached view still processes mouseDown/Up — which
is why clicks "worked" — and collapses to a 2032x200 bounds state on programmatic re-attach,
which threw `toX/toY out of bounds (2032x200)` for every movePath. Fixed in
`agentRpcCommandMouse`:before dispatch, the target view is attached+selected through Min's own
selection semantics (`viewManager.setView` logic replicated without the sender webContents),
with healthy-bounds capture/restore and a fixed-source `resize` dispatch into Min's UI script
so Min itself recomputes correct GPUs bounds. A dispatch-time bounds guard also corrects the
renderer's late collapsed update. After this fix, the out-of-bounds class is gone (bounds
2032x1063; full 300,300 path usable).

## 3. Wheel/scroll semantics (Phase 3)

- `type: 'scroll'` is not a valid Electron input type (harness: `Invalid event object`) — never
  used by the implementation.
- `browser_mouse scroll` dispatches `{type:'mouseWheel', x, y, deltaX, deltaY, canScroll:true}`
  per the installed Electron 43 signature, and the result carries an honest delivery note:
  synthesized wheel events are dropped by the compositor in Min production windows (verified by
  page counters + isolation counter-contrast), so `browser_scroll` (DOM-level) stays the
  reliable scrolling method. No rejected-event-translated-into-success exists: `dispatched:true`
  describes only the API acceptance, with the limitation stated in the same result.

## 4. Honest delivery contract (implemented)

Every move-family result now reports `delivery: 'unverified'` + `deliveryNote` documenting that
standalone mouseMove path events are dropped in Min production windows on this build, while
button events (down/up/click) deliver reliably. Click/down/up/rightClick results are unchanged
(their page effects are real and verified). No assertion in `probe:mouse` was weakened: the
page-delivery assertions still run and still FAIL (now 3, all one root cause; a queued-flush
diagnostic check was added as further evidence).

## 5. Before/after probe results

- P1-06 baseline: `probe:mouse` **23/25** (3 stable runs), failing:
  - `page received ordered path events (>=80% delivered)` [target=30 received=0]
  - `page registered drop INSIDE B`
- P1-06.1 final: `probe:mouse` **23/26** (3 stable runs), failing (same root cause, plus an
  added queued-flush evidence check):
  - `page received ordered path events (>=80% delivered)` [target=30 received=0]
  - `queued moves flushed by trailing button event` [after-path=0 after-flush=0]
  - `page registered drop INSIDE B` (same standalone-move limitation; down/up deliver)
  * fixed this phase: the 2032x200 out-of-bounds collapse class (was blocking even syntax-valid
    paths after programmatic re-attach).

## 6. Full regression gate (exact commands, exit codes, counts)

| command                                              | exit | result                                                                                                                         |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build` (+ `node --check main/agentRpc.js`)  | 0    | clean                                                                                                                          |
| `npm run test:agent-rpc`                             | 0    | 182/182 (census 31)                                                                                                            |
| `node scripts/mcp-e2e.js`                            | 0    | **56/56** (image content + mouse transport over stdio)                                                                         |
| `npm run probe:mouse` ×3                             | 2    | **23/26** each (above)                                                                                                         |
| `npm run probe:transform`                            | 0    | 18/18                                                                                                                          |
| `npm run probe:downloads`                            | 0    | 33/33                                                                                                                          |
| `npm run probe:pav` / `inputs` / `captcha` / `waits` | 0    | 15/15, 20/20, 14/14, 16/16                                                                                                     |
| `npm run probe:tabs` ×5                              | 0    | 16/16 each                                                                                                                     |
| `probe:agent-actions` / `agent-snapshot` / `nps`     | 0    | 33/33, 27/27, 38/38                                                                                                            |
| `probe:capture` / `detach`                           | 0    | exit 0                                                                                                                         |
| `npm run smoke:baseline` ×3                          | 0    | 6/6 each                                                                                                                       |
| stray electrons                                      | —    | 0                                                                                                                              |
| ad-blocker invariant                                 | —    | exactly 1 effective `onBeforeRequest` (main/filtering.js:272); bridge registers 0; network observation works (nps/waits green) |

## 7. Live validation (scripts/p1-06-live.js — 7/7 PASS after the fix)

Screenshots with metadata on example.com + HN; link-flow navigation verified; HN hover no
side-effects; stale rejection live (`ref_stale`); fresh acceptance (`hover dispatched`). Since
the attach fix, mouse actions also auto-attach the target view — no behavior change needed by
callers; `browser_scroll` works independently.

## 8. Invariants

MCP image transport (e2e image block ✓), transforms (18/18), downloads (33/33), navigation
(38/38), extension host (probes green), screenshots (metadata + real bytes), ad-blocker single
handler — all confirmed.

## 9. Remaining limitations

- Standalone sanitized mouseMove/mouseWheel delivery into Min's production page views: dropped
  by the renderer/compositor on this Electron build (evidence above). Click/press/release
  delivery works. Structured `delivery: 'unverified'` + notes now prevent any false "success"
  semantics for the affected actions.
- Delivery verification inside a fresh view attached to the same window works 15/15 — pointing
  to the preloaded/navigated page-view pipeline as the drop site; fixing it would require
  changes to Min's view pipeline (out of scope for this fix task).
- OS-global Windows cursor: **NOT_IMPLEMENTED** (unchanged).

## 10. Gate decision: **PARTIAL PASS**

The mission's fix requirement ("genuinely fixed and independently verified page-side") is met
for root-cause isolation, the attach/bounds defect (fully fixed and verified with page-side
counters), and the wheel-semantics correction; the core standalone-move delivery remains
environmentally blocked by Min's renderer pipeline on this Electron build. Per the mission's own
gate rule ("If one issue remains demonstrably blocked, report PARTIAL PASS"), the gate is
**PARTIAL PASS** with the blocker precisely identified and no falsified results. Regressions,
invariants, and all other surfaces are intact. No P1-07 work started.
