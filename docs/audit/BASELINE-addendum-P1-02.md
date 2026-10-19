# P1-02 Addendum — Autonomous Workflow Engine

## Stage 1 — autonomy gap analysis
`docs/AUTONOMY-GAP-ANALYSIS.md` (evidence-based): the P1-01F per-step stops were
instruction-driven confirmation gates (orchestration behavior), not missing
browser capability; genuinely user-required information (identity, secrets,
CAPTCHA solving, unpre-authorized irreversible actions) remains human.

## Stage 2/3 — autonomous execution loop
Contract written into `mcp/README.md` §"Autonomous execution loop":
goal+scope reading, ONE consolidated question for genuinely missing info,
compact observation by default, verified-action-≠-completed-task rule,
category-based recovery (ref invalidation → re-snapshot; view detachment →
tab_select → retry; captcha → user handoff + `browser_state` poll → resume),
no unconditional sleeps, no secret-bearing content reads.

## Stage 4 — `browser_batch` (implemented, measured)
- Bridge: `browser_batch {tabId, actions: JSON-array-string}` — max 20 steps,
  60 s budget, stop-on-error, order-preserving; EVERY step re-validated with
  the transport's own schema machinery (input verification, single-use grant
  consumption, tab identity, navigation stability, CAPTCHA handoff all
  behave identically to standalone calls); per-step compact results.
- Allowlist: all 21 registered tools EXCEPT `browser_grant` and
  `browser_batch` (no grant bundling, no nesting). No JS/shell/filesystem.
- MCP adapter: typed array schema (adapter serializes for the bridge).
- Transport validation subtleties fixed: synthetic per-step verdicts now
  carry the `host` header and a string `id` (both enforced by the request
  validator).
- Tests: `test:agent-rpc` 6 new schema checks (175/175 total).

## Stage 5 — autonomous workflow evaluation (live, `docs/autonomy-workflows.json`)

| workflow | MCP calls | verified | recovery |
|---|---|---|---|
| W1 HN search+extraction | **1** (batch: navigate+snapshot) | 5 real titles extracted | — |
| W2 PlayLab form fill | **2** (batch + type) | read-back verified on a real field | — |
| W3 SPA + network settle | **1** (batch: navigate+wait+snapshot; waitedMs≈3050) | wait satisfied | — |
| W4 multi-tab research | 4 | opened/snapshotted/closed by id | — |
| W5 stale/detached recovery | 8 | recovery loop completed | view_not_attached→tab_select→retry; ref invalidation→re-snapshot→retry |

Comparative note: W1–W3 pre-P1-02 would have needed 3 separate MCP calls
each (navigate, wait, snapshot) plus model round-trips between them; the
batch collapses each to one call with per-step results. W5 demonstrates
autonomous recovery (the earlier view-detachment was a hard stop in P1-01F).

## Gates (all actually run on this build)
build OK; `test:agent-rpc` 175/175; `probe:inputs` 20/20; `probe:captcha`
14/14; `probe:waits` 16/16 (ad-blocker single-registrant + live-block gates
PASS); `probe:tabs` ×5 16/16; `probe:agent-actions` 33/33;
`probe:agent-snapshot` 27/27; `probe:nps` 38/38; capture/detach 0;
smoke ×3 6/6; workflows eval 5/5 verified; 0 hung electrons.

## Changed files & backups
`docs/backups/P1-02/` (agentRpc.js, mcp adapter, agent-rpc-test, package.json,
mcp/README.md). Changed: `main/agentRpc.js` (batch command + 21-method census
+ schema), `mcp/min-agent-mcp.js` (browser_batch tool, 21 tools),
`scripts/agent-rpc-test.js`, `mcp/README.md`, `package.json`
(`probe:waits`/`probe:captcha` existed; no new npm scripts needed — the eval
is scripts/p1-02-workflows.js), plus four new docs. A real bug found during
evaluation (missing `host` header + null id in synthetic per-step validation
requests) was fixed before proceeding.

## Known limitations
- batch is atomic-stop-on-error; mid-batch partial success returns per-step
  results (callers re-plan from the failure step).
- `browser_batch` not yet used through the MCP stdio e2e (bridge-level tested
  live; adapter schema added — e2e extension recommended next).
- The workflow evaluation measures MCP-call reduction; model round-trip
  accounting is observational (the agent-side planner is this README's
  contract, executed by the driving agent).

## Next recommended task
Wire `browser_batch` into `scripts/mcp-e2e.js` + finish the roadmap items in
order: `browser_batch` MCP e2e, then Predict→Act→Verify (evidence/confidence
on navigations), keeping P1-01F's Atomic Mail account as the live end-to-end
verification target for the batch-driven signup.
