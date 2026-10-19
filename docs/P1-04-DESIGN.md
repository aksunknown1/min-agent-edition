# P1-04 Design — Reversible Page Transformation Engine

Scope note: transformations apply ONLY to the rendered DOM of the local
browser session. Nothing here touches a website's server-side source, storage,
or other visitors.

## Tools (final schemas)

### `browser_transform`
```
input : { tabId: string(20 digits, required),
          actions: string(required, ≤ 24000 chars, noControl) }
        actions = JSON array, 1–50 entries:
          { op: 'replace_text',    ref, text: string(≤ 1200) }
          { op: 'highlight',       ref }
          { op: 'set_style',       ref, style: { prop: value, ... } }  // allowlisted props
          { op: 'hide',            ref }
          { op: 'restore_target',  ref }
          { op: 'restore_all' }
output: { ok, applied, failed, totalMs, results: [ { ordinal, op, ok, rendered?{text|styles}, error?{category,message}, transformedId? } ] }
```
`ref`Targeting: entries take **ref** (interactive elements from snapshots) OR a **validated CSS selector** (≤120 chars, bounded charset) resolved against the CURRENT page — required for text-paragraph targets, which snapshots do not enumerate.  entries are resolved against the tab's live ref store the same way every
action tool does; per-target failures (stale refs, element children in
replace_text, unsafe style values, drift) are per-target results — earlier
targets stay applied.

### `browser_transform_status`
```
input : { tabId: string(required) }
output: { tabId, active: count, ops: {op: count}, drift: [ transformedIds with mismatched rendered text ], cleared: bool }
```

## State model
`AGENT_RPC_TRANSFORMS = Map(tabId → { records: Map(transformId → record), createdAt })`
record = `{ id, ref, ordinal, role, name, nameIndex, op, original: {…}, appliedText? }`
- replace_text original: the element's previous `textContent` (children-free targets only; per-target refusal otherwise — never replaces outerHTML, never recreates nodes, so framework listeners survive).
- set_style/hide/highlight originals: per touched CSS property → `{ hadInlineProp, inlineValue, inlinePriority, computedValue }`. Restore: if inline existed → setProperty(value,priority) else removeProperty; highlight also removes its marker attribute (original attribute value or absence recorded).
- Lifecycle: cleared on `did-navigate` (the browser discards the old document itself; no restore of stale records is attempted or claimed) and on tab close. Transformations explicitly do NOT survive navigation or reload.
- Idempotency: `restore_target`/`restore_all` on missing records resolve cleanly with `restored: 0`; applying restore twice cannot corrupt the DOM.

## Execution path
ONE `executeJavaScript` call per browser_transform invokes the existing
AGENT_SNAPSHOT_PAGE_FN with mode `'transform'` (identity-checked like
setvalue/predict; no second execution route). Per-target identity: role+name+
nameIndex at the stored ordinal; drift (role/name mismatch) → per-target
`ref_stale`. Rendered post-state (text/property values) is returned and
re-checked on `browser_transform_status` (drift) and on restore.

## Style allowlist
color, backgroundColor, fontSize, fontWeight, lineHeight, maxWidth, textAlign,
visibility, padding, paddingTop, paddingBottom, marginTop, marginBottom, margin.
Value validation: ≤120 chars, no control chars, must match
`/^[A-Za-z0-9#,.%()\s\/-]+$/`, and REJECT anything containing `url(`, `expression(`,
`@`, `;`, `{`, `}`, `<`, `>` (covers url()/expression()/@import injections).

## Failure behavior
- Whole-call invalid_params: schema breaches (size, malformed JSON, bad entry shapes).
- Per-target: `ref_stale` (identity drift), `unsafe_style_value`, `target_has_element_children`,
  `already_cleared` (restore), `framework_overwrite_suspected` (drift reported by status).
- Errors never abort unrelated valid targets (except unbounded execution errors).

## Files likely to change
main/agentRpc.js (transforms, state, commands, schemas, METHODS 23→25,
clear hooks), mcp/min-agent-mcp.js (2 tools; actions-array serialization),
scripts/agent-rpc-test.js (census + schema checks),
scripts/agent-transform-probe.js (new; 12 fixture cases),
scripts/p1-04-live-check.js (live transform+restore on public pages),
package.json (probe:transform), docs/REAL-WORLD-COMPATIBILITY.md,
docs/REAL-SITE-REPORT.md, docs/audit/BASELINE-addendum-P1-04.md.
