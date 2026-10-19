# P1-01D — Performance Baseline, Event-Driven Waits, Real-World Compatibility

Task window: P1-01D. All numbers below are measured runs of this workspace's
current build; medians are computed from `docs/performance-baseline-measurements.json`
(3 repeats per site over one Min session). No numbers are estimates.

## 1. Stage 1 baseline (measured AFTER P1-01D instrumentation)

Per-tool totals now recorded in the bridge (`browser_status → bridge.telemetry`,
per method `{count, avgMs, maxMs, lastMs, errors}`) and per-navigation split in
every `browser_navigate` result (`settleMs` = time to the load event,
`stabilityMs` = post-settle URL-stability verification; `stabilityWindowMs`
echoed). Snapshots remain sub-10 ms.

### Live sites (medians of 3, default navigation settings)

| site | navigate total | settle (load event) | stability verify | snapshot | snapshot nodes |
|---|---|---|---|---|---|
| https://example.com/ | 1589 ms | 16 ms | 1561 ms | 2 ms | 1 |
| https://news.ycombinator.com/ | 1859 ms | 301 ms | 1556 ms | 11 ms | 200 |
| https://account.proton.me/login | 1876 ms | 288 ms | 1575 ms | 10 ms | 17 |

Raw runs (incl. per-run values, `waitedMs`, `finalUrl`): see
`docs/performance-baseline-measurements.json` (`liveSites.*.runs`).

### Local fixtures

| fixture | tool | median | note |
|---|---|---|---|
| controlled React-style input (`resolve`) | browser_type | 6–8 ms | first-strategy verified, `native-insert` |
| hostile input (beforeinput-blocked) | browser_type | ~310 ms | fallback path ≈ 5 s BEFORE P1-01D (measured 5010/5019 ms in P1-01C evidence); fast-path detects demonstrably-not-accepted input at ~700 ms |
| rejecting controlled input | browser_type | ~310 ms | structured `rejected-input`, verified=false |
| snapshot over fixtures | browser_snapshot | 2–5 ms | |

## 2. Stage 2 — browser_wait

`browser_wait {tabId, until: 'network_idle'|'selector_visible', selector?, timeoutMs?}`
(verified structured result `{satisfied, waitedMs, reason?}`).

### network_idle — non-conflicting counting (the important fix)

**Verified defect found and fixed during this task:** Electron allows only ONE
`onBeforeRequest` listener per session and a second registration REPLACES the
first. Since P1-01 Stage 2 the bridge registered its counting listener AND
Min's blocker registered its own (bundle order: filtering first, agentRpc
second) — so **the bridge silently disabled ad blocking on every session**
(the blocker's handler was replaced). The probe rumor "additive counting
listener" in old comments was never true for `onBeforeRequest`.

New architecture (structurally guaranteed):
- `main/filtering.js` remains the ONLY `onBeforeRequest` registrant (asserted
  by a probe check against the built bundle: exactly 1 match).
- filtering's `handleRequest` calls the bridge's hoisted
  `agentRpcNetworkRequestObserved()` for http(s) requests (start signal),
  `agentRpcNetworkRequestBlocked()`/`...Settled()` on cancel decisions.
- The bridge registers only `onCompleted`/`onErrorOccurred` decoders (unused
  by any other module).
- `browser_status → bridge.net` exposes `{inflight, observedTotal,
  settledTotal, blockedTotal, filteringBlockedCount}` —
  `filteringBlockedCount` is Min's own persisted counter, read through the
  settings store.

Semantics: idle = **no NEW request started for 1 s AND in-flight drained**, OR
**no activity at all for 3 s** (tolerates forever-pending long-poll/SSE or
other sessions' stuck counters; the reason string discloses the residual
in-flight count). Both conditions are bounded by the wait timeout (≤20 s);
waits poll at 200 ms and never block other bridge calls (probe-checked).

### selector_visible

Validated plain CSS selector (≤200 chars, control-char/brace rejected at the
schema), executed through the fixed page function (`selcheck` mode — see the
fixed call-site bug below), bounded `timeoutMs` 500–20000 (default 8000).

### `waitMs` on snapshot

Exists (bounded 0–5000 ms) and is documented in the schema description;
prefer `browser_wait` for real conditions.

### Waits probe results (`npm run probe:waits` → 16/16)

| check | result |
|---|---|
| selector_visible on an element appearing 900 ms after load | satisfied, waitedMs within [600, 7500] |
| selector_visible timeout (never-appearing selector) | satisfied=false ≤2 s, reason present |
| network_idle across a delayed XHR (starts 1.2 s post-load, server holds 800 ms) | satisfied only after the XHR drained; `observedTotal` grew → blocker-handler integration proven |
| network_idle on an idle http page | satisfied < 3.5 s |
| bridge responsiveness during a pending 6 s wait | status round-trip completed < 1.5 s while the wait was pending |
| pending wait completes honestly after the concurrency check | satisfied=false |

## 3. Stage 3 — measured optimizations

### B. Input fallback latency — measured before/after

| scenario | before (P1-01C) | after (P1-01D) | how |
|---|---|---|---|
| hostile input (first strategy demonstrably not accepted) | 5010 ms | ~310 ms | typed-value read-back detects "located target, identity strict, length 0 while non-empty text dispatched" at two consecutive early polls (~700 ms) → the ONE bounded native-setter fallback engages immediately |
| rejecting controlled input | 5017 ms | ~310 ms | same early signal; final structured `rejected-input` unchanged |
| ordinary + delayed-acceptance inputs | 6–8 ms | 6–8 ms | unchanged (first-poll acceptance) |

All four input fixture classes still pass (`probe:inputs` 20/20). Retry count
is still ≤1 with a different strategy.

### C. Navigation fast path — measured

- `domcontentloaded` vs `load`: both supported; default `load` kept. Measured
  settle times: example.com 16 ms, HN 301 ms, Proton 288 ms (medians) — the
  settle phase is dominated by the site's own load behavior, and the largest
  remaining latency component is the 1500 ms stability window (1561/1556/1575
  ms), which is intentional delay-redirect coverage and configurable via
  `stabilityWindowMs` (0–15000, doc in the P1-01B addendum).
- No default was changed; redirect checks are untouched; every navigation
  wait remains bounded (settle deadline 8 s + window ≤15 s + poll slack).
- **`expectUrlPrefix` hardened**: raw `indexOf === 0` matching could accept a
  lookalike host (`https://example.com` would prefix-match
  `https://example.com.evil.com`). New `agentRpcPrefixMatchesUrl`: the prefix
  must parse as an absolute URL, both origins must be EXACTLY equal
  (scheme + host incl. port), and the href must start with the prefix.
  7 unit checks in `agent-rpc-test` (168/168).

### A. Snapshot/observation efficiency — measured, not guessed

- Repeated snapshot HTTP cost on real sites is already 7–14 ms (HN: 200
  nodes; Proton 17 nodes) — no full-page reimagination needed in this task.
- Actions use the pre-existing `locate` single-target re-enumeration path
  (NOT a client-side full snapshot fetch) — MEASURED in the live matrix a
  click+verify round trip on playwrightlab is 2–4 ms tool time.
- Stale/ambiguous handling: unchanged (strict identity, weak unique match,
  `ref_stale`/`ambiguous` structured errors; refs invalidated on
  navigation).
- **Real-world gap found and fixed (was invisible to local fixtures):**
  coordinate-based dispatch (click/type/hover/check) used snapshot boxes
  taken at document scale; multiline/long pages (playwrightlab's `#forms`
  lives at document-y≈18 000 px) made `sendInputEvent` silently miss because
  its coordinates are viewport-space. All four dispatch paths now run a
  fixed, identity-checked `scrollinto` page step first and use the fresh
  in-viewport box (probes unchanged; PlayLab type/select/check/downloads
  switched from FAIL to PASS after the fix).

### D. Batching design proposal (design only — not implemented)

`browser_batch` proposal (deferred to the roadmap task it belongs to):
- Input: `actions: [{tool, params}, ...]` — ONLY typed browser actions from
  the fixed ENUM of existing bridge methods (validated by the same
  AGENT_RPC_PARAM_SCHEMAS); arbitrary JS/shell/CDP are impossible by
  construction.
- Execution: sequential on one tab unless `perStep.tabId` overrides; stop on
  first error by default (`stopOnError: true`), optional bounded continuation
  (`maxSteps ≤ 20`, total time budget ≤ 60 s).
- Output: per-step `{tool, ok, result|error}` array + aggregate `ok`.
- Waits/steps that would block the bridge remain bounded; the batch runs
  through the normal single dispatch path so telemetry/grants still apply
  (a batched risky/sensitive action still requires its own grant).
- Value: real workflows today need 3–6 round trips (navigate, wait, snapshot,
  act, verify) — a batch saves 2 transport round trips per step over stdio
  MCP; measure when implemented.

## 4. Stage 4 — real-world compatibility

See `docs/REAL-WORLD-COMPATIBILITY.md` (19 PASS / 1 ENVIRONMENT_BLOCKED with
evidence; every registered tool mapped to an externally-hosted target,
read-only rules, no submits). The three-site read-only checkpoint was
repeated on this build as part of the baseline measurement (medians in
§1, raw runs in `docs/performance-baseline-measurements.json`).

## 5. Stage 5 — before/after summary

| metric | before P1-01D | after P1-01D | evidence |
|---|---|---|---|
| input fallback latency (hostile fixture) | 5010 ms | ~310 ms | P1-01C evidence vs docs/agent-inputs-probe.json |
| live navigate+snapshot (per site, incl. stability window) | 4.2–6.3 s (P1-01C checkpoint, window=4000) | 1.6–1.9 s + 2–10 ms (window=1500, medians of 3) | performance-baseline-measurements.json |
| navigation duration split | single waitedMs | settleMs + stabilityMs + stabilityWindowMs | navigate results |
| ad blocking with bridge active | **silently disabled** (webRequest replacement bug) | structurally preserved (single registrant + live block-count gate) | waits probe binary check + blockedTotal 0→2 |
| selector_visible reliability | always "not found" (call-site arg bug) | monitored honestly (16/16 waits incl. delayed element + timeout) | waits probe |
| offscreen-element actions | silently missed (viewport coords) | scrolled into view first, fresh box used | real-world matrix before/after (PlayLab type/checkbox switched to PASS) |
| MCP round trips for a wait+act workflow | n/a (no waits coverage) | waits measured 0.9–6.9 s tool time; batch tool proposed, not implemented | waits probe timings |
