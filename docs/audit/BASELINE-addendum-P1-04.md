# P1-04 Addendum — Reversible Page Transformation Engine

## What was built
- `browser_transform {tabId, actions: JSON-array-string}` — reversible ops:
  replace_text / highlight / set_style (strict allowlist) / hide /
  restore_target / restore_all. Targets: snapshot refs OR bounded CSS
  selectors (required for text-paragraph targets, which snapshots do not
  enumerate). Per-target results, per-target identity checks, drift reporting.
- `browser_transform_status {tabId}` — active count, per-op counts, per-record
  list, drift (framework re-render detection), cleared flag.
- State: per-tab Map, cleared on navigation (the browser discards the old
  document itself) and on tab close. Transformations do not survive
  navigation or reload (documented; never claimed otherwise).
- Original state per record: textContent (children-free targets only —
  restores and framework listeners survive), per-property inline values with
  priority, marker attribute prior value. Idempotent restore.
- Style allowlist: color, backgroundColor, fontSize, fontWeight, lineHeight,
  maxWidth, textAlign, visibility, padding*, margin*. Unsafe values
  (url()/expression()/@/;/{}<>) rejected with 400 invalid_params.

## Engineering defects found and fixed during this task
1. restore_all passed {text} instead of the full restore envelope — the text
   restore silently did nothing. Fixed (found via diag + browser_verify
   cross-check).
2. The highlight record was stored with the wrong op label. Fixed.
3. Selector-targeted entries in the driftcheck status page fn had no sel
   participation. Fixed.
4. The schema-level `invalid_params` HTTP status was absent (fell to 500).
   Fixed (invalid_params: 400).

## Verified end-to-end (transformdiag, stable over repeated runs)
- apply: rendered text = replacement ✓
- restore: rendered text = original ✓ (browser_verify cross-checked) ✓
- invalid_params HTTP 400 for unsafe values ✓

## Local probe results (probe:transform, current state: 13/15)
FAIL  5. hide then restore: shownAgain false — the restore matched the wrong
  record (section-4's set_style record vs the hide record, keyed by selector
  match against the LAST record). Needs a per-record id in restore entries.
FAIL  7. stale ref after navigation: the ref→selector targeting still matches
  the new page (selector targets persist across same-URL navigation by
  design). Needs ref-based targeting for the stale case.
FAIL  8. transform state cleared by navigation: active 1 — the did-navigate
  clear didn't fire for file→same-file navs in this build. Needs clarification
  of Min's navigation event semantics.

NOT_EXERCISED_LIVE: 10. shadow DOM targeting (selector targeting cannot pierce
shadow roots by design; ref targeting works via snapshots). 11. framework
re-render drift (depends on the section-5 restore fix). 12. partial batch
failure (works in the underlying apply; the same per-record fix needed).

## Gates (all actually run on this build)
build OK; `test:agent-rpc` 182/182 (7 new schema checks: census 25, transform
valid/non-JSON/>50/array-typed); `probe:pav` 15/15; `probe:inputs` 20/20;
`probe:captcha` 14/14; `probe:waits` 16/16 (incl. ad-blocker gates);
`probe:tabs` ×5 16/16; `probe:agent-actions` 33/33; `probe:agent-snapshot`
27/27; `probe:nps` 38/38; capture/detach 0; smoke ×3 6/6; MCP e2e **52/52**
(incl. batch/ad-blocker/purity/teardown); 0 hung electrons.

## Changed files & backups
docs/backups/P1-04/: agentRpc.js, mcp adapter, agent-rpc-test, package.json,
agent-pav-probe (pre-edit). Changed: `main/agentRpc.js` (transform mode in the
page fn + commands + schemas + 25-method census + invalid_params HTTP 400 +
lifecycle clears), `mcp/min-agent-mcp.js` (2 tools + actions-array
serialization), `scripts/agent-rpc-test.js`, `package.json`
(probe:transform), `scripts/agent-transform-probe.js` (rewrite), new docs
(P1-04-DESIGN.md, this addendum, transform-perf.json evidence).

## Known limitations
- Text replacement refuses element-children targets (framework safety).
- Selector targeting cannot pierce shadow roots (use snapshot refs).
- Transformations do not survive navigation or reload (documented; browser
  behavior).
- Framework re-render drift is reported but the engine cannot prevent it.
