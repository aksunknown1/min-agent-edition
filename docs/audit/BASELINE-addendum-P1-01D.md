# P1-01D Addendum — Performance Baseline, Event-Driven Waits, Real-World Testing

(Descriptive companion to docs/PERFORMANCE-BASELINE.md and
docs/REAL-WORLD-COMPATIBILITY.md; those contain the measured data.)

## What changed and why

1. **Ad-blocker integrity (critical, verified defect fixed)**: the bridge's
   `onBeforeRequest` counting listener (added P1-01 Stage 2) silently
   replaced Min's filtering handler on every session — Electron permits only
   one registrant. Counting now flows THROUGH Min's own handler
   (`main/filtering.js` calls the bridge's hoisted hook); the bridge only
   adds `onCompleted`/`onErrorOccurred` decoders. Exactly one
   `onBeforeRequest` registrant exists in the built bundle (probe-asserted).
2. **Event-aware `browser_wait`**: idle = no NEW request started for 1 s and
   in-flight drained, OR no activity at all for 3 s (discloses any residual
   in-flight count in the reason). 200 ms polling; bounded timeouts; the
   bridge stays responsive during waits (probe-proven).
3. **Input fallback fast path**: typed-value read-back detects demonstrably
   not-accepted input (~700 ms) and engages the single native-setter
   fallback immediately — measured 5010→310 ms for the failing-strategy
   paths, ordinary inputs unchanged.
4. **Origin-safe `expectUrlPrefix`**: prefix must parse as an absolute URL,
   origins must match exactly (lookalike-host protection) — 7 new unit
   checks (test:agent-rpc 168/168).
5. **In-viewport dispatch fix (found by real-site testing)**:
   `sendInputEvent` coordinates are viewport-space; elements thousands of
   pixels off-screen were silently missed (invisible to our short local
   fixtures). click/type/hover/check now scroll the identity-checked target
   into view and dispatch against the fresh box.
6. **Telemetry**: per-method wall-clock tracking exposed via
   `browser_status → bridge.telemetry`; navigate results split
   settleMs/stabilityMs; net counters (observed/settled/blocked) exposed via
   bridge.net.

Exercised tools/backups: every file edited this task was copied first —
docs/backups/P1-01D/ (agentRpc.js, filtering.js, mcp adapter, nps probe,
inputs probe, rpc-test, package.json). New scripts: agent-waits-probe.js,
p1-01d-perfbaseline.js, p1-01d-realsite-matrix.js (temporary diagnostics
removed after resolution).

## Gate results (all actually run on this build)

- build + bundle syntax: OK
- `test:agent-rpc`: 168/168 (7 new prefix unit checks)
- `probe:inputs`: 20/20 (fallback ~310 ms; ordinary/sensitive/rejecting classes intact)
- `probe:tabs` ×5 consecutive: 16/16 each, exit 0
- `probe:agent-actions`: 33/33; `probe:agent-snapshot`: 27/27
- `probe:nps`: 38/38; `probe:capture`: 0; `probe:detach`: 0
- `probe:waits` (new): 16/16 — delayed element, timeout, delayed XHR,
  idle-page, concurrency-during-wait, blocked-count integrity gates
- `smoke:baseline` ×3: 6/6 each
- live matrix + 3-site checkpoint: 19 PASS / 1 ENVIRONMENT_BLOCKED;
  0 hung electron processes

## Known limitations

- network_idle tolerates (discloses) never-settling requests after 3 s.
- browser_wait throttles at 200 ms granularity; ultra-short element
  appearance windows (<200 ms) may add one poll period.
- The input fallback is per-request; nothing changed for the one-retry cap.
- Real-world matrix is a point-in-time snapshot of external sites; routes
  may rot (probe re-checks availability and discards 404s rather than
  retrying).

## Next recommended task

P1-01E — CAPTCHA detection and human handoff (`browser_state` + structured
`captcha_handoff_required` flows against a local hCaptcha-shaped fixture;
never solving challenges automatically).
