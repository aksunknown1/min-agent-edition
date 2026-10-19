# P1-06.2 — Production WebContentsView Input-Pipeline Investigation (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · Backups: unchanged files from `docs/backups/P1-06/` (this phase changed NO production source; only diagnostics + documentation)

## 1. Exact root cause (differential evidence, stage-by-stage)

**Decisive cursor-position diagnostic** (`scripts/p1-062-cursor-diag.js`) — production view, production input path, page records every mousemove with coordinates into DOM state read through the bridge:

```
page observed (last 30 moves): 814,938 / 815,939 / 814,938 / 815,939 ...
```

Two injected moves at **(400,400)** and **(500,500)** were dispatched (bridge logs confirm
`sendInputEvent` invocation). The page's event stream contains **only events at the real OS
cursor position (814,938 ± 1px of physical jitter) — the injected coordinates never appear**.
Corollary evidence: the earlier navigation-matrix run showed +20 events whose recorded position
was `(1030,678)` — again the physical cursor — after 10 dispatches at (60..168, 60..168).

**Root cause:** on Windows with this Electron build, Chromium's input pipeline for Min's
production page views continuously re-asserts the **real OS cursor position** to the renderer.
`sendInputEvent({type:'mouseMove'})` does not move the perceived pointer; every injected move is
followed (or replaced) by a re-delivery at the physical cursor position. Page-level mousemove,
hover, and drag-track features therefore follow **only the physical cursor**. Synthesized wheel
is dropped by the same pipeline (scroll offset stays 0 in production views; isolation harness
counter-contrast).

**Differential matrix ruling out other factors** (temp views inside Min's production window;
all delivered when the physical cursor was outside their bounds):
- A-control (fresh partition): delivered
- B-production session (`persist:webcontent`): delivered
- C-production prefs (preload + contextIsolation + sandbox + nodeIntegrationInSubFrames + ...): delivered
- D-session + preload combined: delivered

Preload, partition/session identity, webPreferences, the extension content scripts (benign
marker fixture), and Min's selection/z-order composition are all **ruled out**. The earlier
"isolation works" contrast is now fully explained: in the isolation harnesses the physical
cursor was outside their windows, so no real-cursor re-assertion raced the injected moves;
in Min's production window the cursor sat inside, and the re-assertion stream dominates.

## 2. Fix decision

A safe in-repo fix does not exist: page-level pointer movement on this platform requires either
(a) moving the real OS cursor (`SendInput` — **explicitly forbidden**: OS-global input, out of
scope), or (b) an upstream Chromium/Electron change (full Chromium build forbidden). Per the
mission ("stop with a precise root-cause/limitation report rather than adding an unsafe
workaround"), **no workaround was added**. The P1-06.1 structured contract
(`delivery:'unverified'` + `deliveryNote`; verified page effects only for button events) is
retained and now backed by this root-cause evidence.

## 3. Changed files

**No production source changed in this phase.** Temporary diagnostics were added and removed
(`scripts/p1-062-insert-matrix.js`, `p1-062-navmatrix.js`, `p1-062-fixturediag.js`,
`p1-062-cursor-diag.js`, `p1-062-wheel-diag.js` remain as documentation/evidence tooling).
Backups: unchanged from `docs/backups/P1-06/`.

## 4. Before/after + event counts

| case | mouseMove page events | wheel page events |
|---|---|---|
| fresh temp view in Min production window (cursor outside) | 15/15 delivered (P1-06.1 diag) | n/a |
| production Min view, cursor outside bounds | 3/10 (coalesced) | dropped; scrollY stays 0 |
| production Min view, cursor inside bounds | **0/injected; all events at real cursor pos (814,938)** | dropped; scrollY stays 0 |
| isolation harness windows (cursor outside) | delivered 30/30 at injected coords | (n/a) |

## 5. Regression gate (post-fix, same source as P1-06.1 final)

| command | exit | result |
|---|---|---|
| `npm run build` / `node --check main/agentRpc.js` | 0 | clean |
| `npm run test:agent-rpc` | 0 | 182/182 (census 31) |
| `node scripts/mcp-e2e.js` | 0 | 56/56 |
| `npm run probe:mouse` ×3 | 2 | **22/26 each** (4 stable fails: hover indication, path events, queued flush, drag-in-B — all the cursor-re-assertion limitation) |
| probe:transform / downloads / pav / inputs / waits | 0 | 18/18, 33/33, 15/15, 20/20, 16/16 |
| probe:tabs ×2 | 0 | 16/16 each |
| agent-actions / snapshot / nps | 0 | 33/33, 27/27, 38/38 |
| capture / detach / smoke ×3 | 0 | 0, 0, 6/6 each |
| electrons | — | 0 |
| ad-blocker | — | exactly 1 effective `onBeforeRequest` (filtering.js:272); bridge 0 |

(Note: hover-indication fails consistently in this final state — the physical cursor stood
outside the fixture box, page-hover follows the real cursor, exactly per the root cause. The
check is strict and was not weakened.)

## 6. Status summary per capability

| capability | status |
|---|---|
| clicks (down/up at explicit tabId+coords) | **PASS** (page-verified) |
| right-click → page contextmenu | **PASS** (page-verified) |
| screenshot image transport (MCP stdio `image` block) | **PASS** (56/56 includes it; live PNGs exported) |
| coordinate/staleness semantics | **PASS** (`ref_stale` live-verified) |
| move/movePath/drag page delivery | **PLATFORM_LIMITED** — follows only the physical cursor; structured `delivery:'unverified'` results prevent false success |
| wheel page delivery | **PLATFORM_LIMITED** — dropped; dispatch reported with honest note |
| DOM `browser_scroll` | **PASS** |
| OS-global cursor | **NOT_IMPLEMENTED** (and explicitly forbidden mechanism) |

## 7. Gate decision: **PARTIAL PASS** ✅⚠️

The mission's PASS requires production-view move/path page delivery — which is blocked by the
now-precisely-identified Windows/Chromium real-cursor re-assertion behavior (differential
evidence in section 1) and cannot be fixed safely in-repo (would require OS-global input —
forbidden — or upstream changes). All mandatory regression gates, invariants, screenshots,
stale/serialization/click/press semantics pass. No speculative changes were made; no P1-07 work
started. This constitutes the evidence needed for the architectural decision.
