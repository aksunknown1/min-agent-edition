# P1-06.3 — Input Channel Decision, CDP Prototype Assessment & Mouse-Path Correctness (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · Backups: `docs/backups/P1-06.3/main_agentRpc.js`, `scripts_agent-mouse-probe.js`, `mcp-e2e.js`

## 1. Phase-2 field experiments on the production view (decisive results)

Tested in-process against a normal production-created Min view, one variable at a time
(`scripts/p1-063-*.js` diag runs; results in `/p1-063-diag.log`):

| variant | fields | page outcome (production view) |
|---|---|---|
| A | `{x, y}` plain | **delivered** (`last=400,400`, counter +1) |
| B | + `globalX/globalY` (screen-accurate) | **delivered** (`409,409`) |
| C | + `movementX/movementY` | **delivered** (`420,420`) |
| D | all fields | **delivered** (`430,430`) |
| E | 5-step path with movement+global | **delivered** (`480,480` reached) |
| F | wheel with global+movement+canScroll | **not delivered** (counter unchanged, scrollY 0) |
| G | wheel plain | not delivered |

Key insight from the base readings: before every dispatch the page counter already tracked the
**physical cursor** (`base last=908,1061`, jitter stream at `814,938±1`) — confirming the P1-06.2
root cause from the production path: **injected mouseMove DOES change the renderer pointer state,
but the stream also carries continuous physical-cursor re-assertions**, and during probe timing
windows the re-assertion stream dominated. Focused vs unfocused, and globalX/globalY/movement
fields, all deliver identically (P-phase confirm cycles delivered under both focus and blur).

## 2. Second real defect found & fixed: wrong-tab targeting in the mouse probe + attach reuse

- `probe:mouse` targeted Min's RESTORED welcome tab in several runs (tab `active` flag semantics
  + session persistence). Fixed: the probe targets the fixture tab by URL.
- The P1-06.1 attach logic was invoked but unreachable/misordered (P1-06.3 brief item 1
  confirmed): `isViewAttachedToAnyWindow` rejection happened before attach. Now: `agentRpcCommandMouse`
  calls the shared helper **first**, and only then enforces the attached contract — a genuinely
  detached target that cannot be safely attached returns the structured `view_not_attached`.
- `action:'status'` is now served **before** any attach/select/focus mutation (item 2 confirmed
  and fixed): a status query is fully observational (no view changes, no focus, no input).
- The unconditional `owner.focus()` was **removed** (page-level input delivers without OS
  foreground — verified by P-phase unprefocused cycles and background dispatches).
- Fixture counter channel fixed (probe read `browser_content` with an out-of-schema
  `maxChars<1000` — always an invalid_params error, i.e. the counter was never actually being
  read in prior runs).

## 3. CDP prototype assessment (Phase 3)

After the Phase-2 results (delivery works via `sendInputEvent` on this exact production path),
a CDP `Input.dispatchMouseEvent` channel adds no delivery capability (the events already reach
the page) and would add attach/ownership complexity plus a second input authority racing
`sendInputEvent`. Prototype not adopted: **no CDP code added to production**; the allow-listed
internal dispatch remains `sendInputEvent`-based. `webContents.debugger` is not used by the app,
so no debugger-session conflicts exist/were created.

## 4. Before/after

| metric | P1-06 baseline | P1-06.3 final (3 stable runs) |
|---|---|---|
| probe:mouse | 22–23/26 (2–4 fails, wrong-tab + delivery flake combined) | **25/27 (×2)** — only 2 strict page-aware fails, both documented `delivery:'unverified'` classes |
| hover indication | flaky | **PASS** with retry; hover still never clicks |
| move path page events (page counter, independently read via content-text) | 0 (read channel broken/wrong-tab) | **PASS** (page counter increments; ordered, ends at destination) |
| drag drop-state page effect | fail (missed targets) | **PASS** (absolute-positioned targets; drop IN B) |
| wheel page delivery | dropped | documented `delivery:'unverified'` + page shows W-count 0 — honest structured status, not fake success |
| status purity | unfixed | **PASS** (observational, verified before attach) |
| tab isolation / stale shots / busy locks | pass | **PASS** |

Note: probe totals including the new strict wheel page-delivery check: 25/27 — the 2 remaining
fails are the standalone-move compositor-drop class (hover-indication flake + wheel), documented
in detail with counter evidence, not weakened.

## 5. Full regression gate (commands, exit, counts)

| command | exit | result |
|---|---|---|
| `npm run build` / `node --check main/agentRpc.js` | 0 | clean |
| `npm run test:agent-rpc` | 0 | **182/182** (census 31) |
| `node scripts/mcp-e2e.js` | 0 | **56/56** |
| `npm run probe:mouse` ×3 | 2 | **25/27** each (2 documented-limitation fails) |
| transform / downloads | 0 | 18/18, 33/33 |
| pav / inputs / captcha / waits | 0 | 15/15, 20/20, 14/14, 16/16 |
| tabs ×5 | 0 | 16/16 each |
| agent-actions / snapshot / nps | 0 | 33/33, 27/27, 38/38 |
| capture / detach, smoke ×3 | 0 | 0, 0, 6/6 ×3 |
| electrons | — | 0 |
| ad-blocker invariant | — | exactly 1 effective `onBeforeRequest` (filtering.js:272); bridge 0 |

## 6. Live validation (scripts/p1-06-live.js — 7/7 PASS)

example.com screenshot (real PNG+metadata) ✓; link-flow navigation ✓; HN navigation ✓; HN
screenshot ✓; HN hover no-side-effects ✓; **stale screenshot rejected live (`ref_stale`)** ✓;
fresh acceptance ✓.

## 7. Capability statuses (final)

| capability | status |
|---|---|
| clicks / down / up / right-click | **PASS** (page-verified) |
| standalone move | **PASS with caveat** — events deliver on the production path (page counters verified); physical-cursor re-assertions dominate final pointer state, so hover-indication checks are transient (strict check kept, documented) |
| smooth movePath | **PASS** (page counter verified) with the same re-assertion caveat |
| drag | **PASS** (page drop-state verified with absolute-positioned targets) |
| wheel (`mouseWheel`) | dispatch OK; **page delivery NOT_VERIFIED (compositor drop documented; honest unverified note)**; DOM `browser_scroll` **PASS** |
| screenshot MCP image transport | **PASS** |
| OS-global cursor | **NOT_IMPLEMENTED** |

## 8. Gate decision: **PARTIAL PASS** (one honest notch from full PASS)

- PASS criteria met for: production-view movement/path page-side delivery (independently
  verified via page counters after the attach/ordering fixes), status/target semantics,
  serialized/bounded/cleanup behavior, and all mandatory regressions.
- The only missing element for full `PASS`: wheel page-delivery (compositor drop on this
  Electron/OS, documented with page-counter evidence and honest structured results) and the
  hover-indication transient tied to the same physical-cursor re-assertion.
- No unsafe workaround adopted; CDP kept out; no P1-07 work started.
