# MCP stdio E2E validation (P1-03 Stage 1)

Command: `node scripts/mcp-e2e.js` (single suite; ~90–120 s incl. two Min
launch cycles). Evidence: `docs/mcp-e2e-run.json` (token-redacted) and
`docs/mcp-unit-summary.json`.

## Method
- **Real transport**: the suite spawns `mcp/min-agent-mcp.js` over stdio and
  speaks newline-delimited JSON-RPC (initialize → initialized → tools/list →
  ping → tools/call...). Nothing imports bridge functions directly.
- Phase 1 (Min down): handshake, tool census (21 tools incl. browser_batch +
  browser_state), unknown-tool −32602, graceful "run min-launch" error,
  malformed-JSON-RPC survival, stdout purity (only MCP frames).
- Phase 2 (real Min + launcher, visible window): launcher protocol
  (profile/discovery-file/ready; token never printed), then real tool calls
  over the adapter against a local fixture page + live public pages.

## browser_batch coverage over real stdio (all PASS)

| check | verified behavior |
|---|---|
| schema discovery | tools/list exposes browser_batch, typed `actions` array, exclusion noted |
| short safe batch vs https://example.com/ | 1 MCP call = navigate+snapshot+content; all three steps ok; snapshot URL = example.com; content matched the page |
| 5-step multi-page sequence (HN → wait → state → example.com → snapshot) | per-step ok flags, wait satisfied mid-batch, every step verified |
| stop-on-error | `browser_grant` inside a batch fails at its own step; the later step never runs (22→ no early-rejection: steps run in order and halt at the excluded tool) |
| nesting smuggle | `browser_batch` inside a batch → per-step invalid_params exclusion |
| per-step schema | `javascript:` URL → per-step `blocked` category; stop-on-error |
| step limit | 21 entries → structured `invalid_params` ("1-20 entries") |
| non-JSON actions | structured `invalid_params` ("not valid JSON") |
| transport signaling | wrapper-level failures surface as MCP `isError:true` content; per-step failures as structured `error.category`/`code` inside the batch result |
| stdout purity | re-asserted after the batch phase (only MCP frames; stderr carries diagnostics; no tokens) |
| ad-blocker | exactly ONE `onBeforeRequest` registration in the running bundle; `bridge.net.observedTotal` grew during the run (handler alive); block-count gate covered by `probe:waits` (google-analytics blocked live) |
| process cleanup | launcher tree shut down with the client (no hung Electron) |

## Discrepancies found and fixed during this stage
1. Unit-phase census asserted **9 tools** (stale since P0-12; source has 21).
2. `browser_batch` was **not reachable over stdio at all**: the adapter relayed
   actions as a raw array while the bridge schema takes a bounded JSON string
   → every batch failed with `invalid_params`. Fixed by the single per-tool
   transform (`prepareArgs`) in the adapter — the only serialization needed.
3. The launcher-protocol check raced the bridge's own diagnostic lines
   (`[agent-rpc …] listening…`) when the check evaluated late; it now
   asserts the 3 protocol lines + no token instead of exact line count.
4. The sensitive-typing assertion still expected P1-01B semantics (`value`);
   the correct P1-01C value for redacted fields is `value-length` (length-only
   evidence). Updated to the current documented semantics.

## Timings (observed, from the telemetry in docs/mcp-e2e-run.json / run log)
- initialize+tools/list: < 50 ms combined
- 3-step batch (navigate+snapshot+content vs example.com): ~2.5–4 s
  (dominated by the 500 ms navigation stability window + page load)
- 5-step batch (2× public nav + wait + state + snapshot): ~5–7 s
- all other standalone calls: 2–20 ms

## Limitations
- The suite is a point-in-time contract against external pages (Hacker News,
  example.com); availability was verified per run and failures are reported
  as observed, not retried into false green.
- Batch per-step results include full step outputs (bounded by the snapshot
  node cap + the 256 KiB snapshot budget); no truncation beyond that.
- The seed of the fixtures lives in the suite itself; production pages must
  not be submitted.
