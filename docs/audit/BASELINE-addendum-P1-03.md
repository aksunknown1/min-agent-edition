# P1-03 Addendum — Real stdio MCP validation + Predict → Act → Verify

## Stage 0 (verification before work)
- Source census: bridge **21 methods**, adapter **21 tools** at start; syntax OK;
  `test:agent-rpc` **175/175** — matched the P1-02 report.
- Discrepancy found INSIDE scripts/mcp-e2e.js (not reported before): its unit
  census asserted **9 tools** (stale since P0-12) and it had not been rerun
  since P1-01B. Both fixed during Stage 1.

## Stage 1 — real stdio `browser_batch` validation (complete: docs/MCP-STDIO-E2E.md)
Suite extended and now passes **52/52** (`node scripts/mcp-e2e.js`). New
coverage over real stdio: schema discovery; a 3-step live batch against
https://example.com (navigate+snapshot+content, per-step ok); a 5-step
two-site sequence incl. mid-batch `browser_wait` (network_idle satisfied);
stop-on-error with an excluded tool (`browser_grant`) failing AT its step;
nested-batch rejection; per-step blocked-scheme (`javascript:`);
step-limit (21 entries → structured invalid_params); non-JSON actions
(structured invalid_params); stdout purity re-assertions; ad-blocker gates
(exactly one `onBeforeRequest` registrant; `net.observedTotal` grew); no hung
Electron processes after teardown.

Two real defects found by the real-transport test (invisible at unit level):
1. **`browser_batch` was unreachable over stdio** — the adapter relayed
   `actions` as a raw array while the bridge schema takes a bounded JSON
   string. Fixed by one per-tool transform (`prepareArgs`) in the adapter.
2. Launcher-protocol check raced the bridge's own diagnostic lines → hardened
   to assert the 3 protocol lines + no token (not exact line count).
3. (Pre-existing) the sensitive-typing assertion expected P1-01B `value`
   semantics; P1-01C's documented `value-length` for redacted fields is
   asserted now.

## Stage 2 — Predict → Act → Verify (implemented)

New tools (bridge + MCP adapter; 23 methods/tools):
- `browser_predict {tabId, ref, action?}` — **static** prediction from a
  dedicated `predict` page mode: tag/role/name, resolved href (with target
  attr), enclosing form (action/method), inputType (EXPLICIT attribute only —
  a bare <button>'s DOM default `submit` is NOT used as evidence), disabled
  and contentEditable state. Classification:
  `navigation` / `navigation-external` (origin-differing href) / `form-submit`
  (submit-control inside a form; JS submit handlers explicitly called out as
  undetectable) / `input` / `read-only` (disabled) / `unknown`
  (button outside a form; JS-driven effects). Confidence high/medium/low.
  `requiresUserInput:true` ONLY for unknown effects. The action is never
  triggered during prediction (probe-verified via unchanged DOM).
- `browser_verify {tabId, urlPrefix?, selector?, textContains?}` — the
  cheapest combined post-action check in ONE bounded page pass (origin-safe
  prefix matching; selector visibility; body-text expectation — the caller's
  own expectation string, never returned). Escalation to snapshots stays the
  caller's choice.
- Navigating clicks now carry `finalUrl` (bounded 3 s settle read at 250 ms).
- Batch semantics: a step whose structured result has `verified === false`
  counts as a step failure for stop-on-error (an unexpected state invalidates
  later actions) while still returning the full step result for re-planning.

Tests: `probe:pav` (scripts/agent-pav-probe.js, 15/15): link prediction
(href-derived, no action triggered), unknown-effect honesty, form-submit
semantics without submission, stale-ref prediction error, cheap-verify after
click/type, batch + failing-verify stop-on-error, sensitive length-only, live
example.com link (`navigation-external` — destination origin differs, exactly
as intended).

## Stage 3 — live Atomic Mail read-only checkpoint (PASS)

`docs/atomic-stage3.json` + `docs/REAL-SITE-REPORT.md`: the existing session
was still valid (no re-login). SPA rename classified honestly (`unstable`;
post-state used). Welcome mail from 'Atomic Mail Team' identified; prediction
`navigation/high` with the message URL as static evidence; opening verified
(`/message/4`); `browser_verify` confirmed in 5 ms with no full snapshot. No
sends/deletes/settings; no message bodies logged.

## Gates (all actually run on this build)
build OK; `test:agent-rpc` **180/180**; `probe:pav` **15/15** (new);
`probe:inputs` 20/20; `probe:captcha` 14/14; `probe:waits` 16/16 (incl.
ad-blocker single-registrant + live-block gates); `probe:tabs` ×5 16/16;
`probe:agent-actions` 33/33; `probe:agent-snapshot` 27/27; `probe:nps` 38/38;
capture/detach 0; smoke ×3 6/6; **MCP stdio e2e 52/52**; 0 hung electrons.

## Changed files & backups
`docs/backups/P1-03/` (agentRpc.js, mcp adapter, agent-rpc-test, mcp-e2e,
package.json, mcp/README.md). Changed: `main/agentRpc.js` (predict/verify page
modes + commands + schemas; 23-method census; finalUrl on navigating clicks),
`mcp/min-agent-mcp.js` (browser_predict/browser_verify tools; prepareArgs
transform), `scripts/mcp-e2e.js` (P1-03 sections + census + semantics fix),
`scripts/agent-rpc-test.js`, `package.json` (probe:pav), docs
(`MCP-STDIO-E2E.md`, `REAL-SITE-REPORT.md`, `atomic-stage3.json`,
`autonomy docs`, this addendum).

## Known limitations
- Prediction is static only: script-driven handlers are reported as unknown
  (never guessed); iframes, canvas, and closed shadows are invisible.
- browser_verify's textContains works on body innerText — typed values are
  not in innerText (fixtures must render them; the loop contract covers this).
- The stdio e2e is a point-in-time snapshot against external pages.
- min://newtab script-execution limitation unchanged.

## Next recommended task
`SKILL.md` installable agent-skill package (portable MCP configuration +
usage guide validated with a second MCP client), per the roadmap — the loop
contract and toolset are now stable enough to make the skill meaningful.
