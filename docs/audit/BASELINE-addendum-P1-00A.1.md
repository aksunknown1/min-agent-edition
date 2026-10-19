# P1-00A.1 Addendum — Tab Lifecycle Failures Resolved, Reliable Baseline Established

## Root cause (verified facts, not hypotheses)

The tab lifecycle failures had **five independent contributing defects**. All were
proven by live diagnosis (raw HTTP against the bridge, bridge-side logs):

1. **`agentRpcClearSnapshotRefs` was called at 3 sites but never defined.**
   Lost in an earlier corrupted edit (the same one that removed
   `agentRpcSweepSnapshotRefs`). Every `browser_tab_close`,
   `did-navigate` invalidation, and snapshot invalidation threw
   `ReferenceError`s → the close promise settled via a late internal timeout,
   which the client saw as a 45 s hang while the bridge stayed alive.

2. **`agentRpcSessionForView` was called (browser_wait) but never defined** —
   same corruption event. Any browser_wait call threw synchronously.

3. **Snapshot page function referenced undeclared variables** (`nodes`,
   `state.elementByIndex`): a casualty of the same edit. *Every*
   `browser_snapshot` returned `-32004` ("could not be collected"), which
   cascaded into the tabs probe (snapshots on newly opened / URL / startup
   tabs all nulled out).

4. **`AGENT_RPC_METHODS` (validation registry) listed 12 methods while the
   dispatcher handled 19.** The 7 P1-01 Stage-2 primitives
   (browser_content/hover/scroll/select/check/wait/downloads) were rejected at
   the validation layer with "method not found"-class errors; additionally
   **they had no `AGENT_RPC_PARAM_SCHEMAS` entries**, so any params they sent
   were rejected as "unknown or unsupported parameter".

5. **Missing feature flag in the locate page mode**: `focused` was set only on
   the requested target ordinal, but press/hover verification compares focused
   ordinals across ALL nodes → `browser_press Tab` misreported verification
   kind (`dom-change` instead of `focus`).

## Probe-side corrections (assertions aligned to documented behavior)

- **Tabs probe**: closes are now performed **by explicit tabId** for the
  bridge-opened tabs first (independent of inventory order), then Min's own
  auto-created tabs are drained, verifying **absence by ID after every close**
  and **bridge responsiveness (status round-trip) after every close**. Final
  visibility count is asserted once (exactly one tab) only after ID-based
  verification passes. Per-tab absence is the primary criterion; the count is
  downstream of it. The probe now also **exits properly** (kills the launcher
  tree; Node held the JSON-RPC/stdio handles open, which made even a PASSING
  run hang until timeout — previously masked).
- **Snapshot probe**: node cap 500 → 1000, byte budget 64 KiB → 256 KiB
  (P1-01 C3/C4 caps); truncation flag now correctly required as
  `pageTruncated` (the page-fn flag), not the main-process slice flag.
- **NPS probe**: URL cap 300 → 2048 (P1-01 A2); unreachable-host navigation is
  now asserted as the structured `verified:false / load_failed` result
  (P1-01 Stage B semantics) rather than a 502 classification.
- **Nameless interactive nodes** (icon-only buttons/checkboxes) are kept again
  in snapshots — the P1-01 nameless filter was too aggressive and hid real
  click targets (the snapshot probe's checkbox assertion caught this).

## Files changed in this task

| File | Backup (pre-edit) |
|---|---|
| `main/agentRpc.js` | `docs/backups/P1-00A.1/main_agentRpc.js` |
| `scripts/agent-tabs-probe.js` | `docs/backups/P1-00A.1/scripts_agent-tabs-probe.js` |
| `mcp/min-agent-mcp.js` | `docs/backups/P1-00A.1/mcp_min-agent-mcp.js` |
| `scripts/agent-snapshot-probe.js` | no pre-edit copy (process deviation; exact edits documented above) |
| `scripts/agent-nps-probe.js` | no pre-edit copy (process deviation; exact edits documented above) |
| `scripts/agent-rpc-test.js` (method-set closure list 12 → 19) | no pre-edit copy (same deviation) |

New permanent helpers (not temporary diagnostics):
- `scripts/p1-00a1-symbolcheck.js` — asserts every `agentRpc*` symbol and
  `AGENT_*` constant referenced in the bridge is defined (guards against the
  corruption class that caused this task).
- `scripts/p1-00a1-inventory.js` — dumps the tool/schema inventory used in reports.

All temporary diagnostic scripts were removed after resolution.

## Tool inventory (verified from source, 2026-10-17)

- Bridge `AGENT_RPC_METHODS`: **19** (browser_status, browser_tabs,
  browser_snapshot, browser_click, browser_type, browser_navigate,
  browser_press, browser_screenshot, browser_grant, browser_tab_open,
  browser_tab_select, browser_tab_close, browser_content, browser_hover,
  browser_scroll, browser_select, browser_check, browser_wait,
  browser_downloads).
- `AGENT_RPC_PARAM_SCHEMAS`: **19** (one per method; unknown keys rejected).
- MCP adapter tools: **19** `browser_*` tools (was 12; 7 added this task).

## Evidence

- `probe:tabs` **five consecutive fresh runs: 16/16 each, exit 0** (previously
  8/14 → 11/14 → 16/16 over the session).
- Single close returns `{tabId, closed:true}` in ≤5 ms (was a 45 s timeout).
- Closed tab demonstrably absent by ID; structured `-32020 last_tab` refusal
  on the final tab; bridge responsive after each close.
- `probe:agent-snapshot` 27/27; `probe:agent-actions` 33/33; `probe:nps` 26/26;
  `probe:capture` exit 0; `probe:detach` exit 0; `smoke:baseline` ×3 = 6/6 each;
  `npm run test:agent-rpc` 155/155; `npm run build` + bundle syntax check OK;
  symbol check OK; **0 electron processes remain**.

## Remaining limitations (unchanged, documented)

- `browser_snapshot` on `min://newtab` (Min's internal start page) returns
  `-32004` in this Electron build — `executeJavaScript` does not settle on
  that internal page (even a trivial wrapped script never returns). Real
  pages (file:// / http(s)) snapshot correctly. Documented, not worked
  around; the tabs probe therefore snapshots URL-bearing tabs.
- `press Enter` implicit form submission remains a documented runtime
  limitation (NPS probe asserts the honest `dom-change` fallback).
- MCP adapter does not yet expose `browser_grant`'s ref binding in schema
  enumeration output (visual-only; the bridge validates it).
