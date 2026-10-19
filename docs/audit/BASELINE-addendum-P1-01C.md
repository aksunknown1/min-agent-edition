# P1-01C Addendum — Reliable Inputs and Shadow DOM Support

## 1. React-controlled inputs (P1-01C)

`browser_type` no longer reports dispatched input as accepted. The result now
carries `strategy` + read-back-driven `verification`:

| verification | verified | meaning |
|---|---|---|
| `value` | true | read-back matched the sanitized typed text exactly (non-sensitive) |
| `value-length` | true | sensitive (password/email/phone/autofill) field: read-back LENGTH matches; the value itself never leaves the page |
| `navigation` | true | a navigation fired during the verification window (e.g. implicit submit) |
| `rejected-input` | false | framework controlled-rejected the text (length/content mismatch after both strategies) |
| `unreadable-state` | false | post-dispatch state could not be read back or the target identity drifted |
| `focus` / `dispatched-unverified` | true/false | field focused / no signal within the 5 s bounded window (pre-fallback only) |

`strategy`: `native-insert` (click focus + select-all + insertText — trusted
input events) or `native-setter-fallback`. **Fallback**: exactly ONE retry
when the first strategy could not be verified; it re-enumerates, verifies the
target's identity (role+name+nameIndex at the stored ordinal — a drift is
reported `ref_stale`, never a wrong-element write), sets the value through the
element's own prototype `value` setter and dispatches `input`+`change`.

- Sensitive values are never logged, never returned (`value: null` with
  `valueLength` only), and the probe evidence contains no sensitive text.
- The previous sensitive-typing verification kind was `value` for both
  classes; it is now `value-length` for sensitive fields (two probe
  assertions updated).

## 2. Shadow DOM (P1-01C fixes)

Open shadow-root traversal, dedup and deterministic doc-order existed since
P1-01; this task fixed three gaps:

1. `label[for]` lookup used `ownerDocument.querySelector` — labels inside
   shadow roots were invisible (nested shadow field was named ''). Now the
   lookup walks `el.getRootNode()` first, then the document.
2. Snapshot envelope dropped `shadowPath`; it is now exposed per node
   (`null` for light DOM, `'::shadow'`/`'::shadow::shadow'` for nested roots).
3. Click/type results embed `target.shadowPath` — locator context survives
   into action evidence.

Closed shadows: `attachShadow({mode:'closed'})` content is NOT enumerated and
NOT claimed inspectable — asserted by fixture.

## 3. Fixtures & evidence (scripts/agent-inputs-probe.js → probe:inputs, 20/20)

Fixtures (local file:// only, submission is JS-local — no live signup):
- **Controlled React-emulation form** (listener reads DOM value → updates
  state → resets DOM value from state, i.e. React's controlled render cycle).
- **Hostile input** (trusted `beforeinput` preventDefault blocks insertText) —
  fallback must engage and win: `verified:true, value, strategy:native-setter-fallback`.
- **Rejecting controlled input** (resets to '' on every change) — both
  strategies rejected: `verified:false, rejected-input`.
- **Nested open shadow roots** (depth 1 + 2) + **closed shadow root**.
- **Stale reference**: element removed after snapshot →
  `browser_type` with the old ref → HTTP 404 `ref_stale` in 1 ms (clear
  failure, never a wrong-element action).
- **Ordinary form** verifies without fallback.

Framework-state proof: typing into the controlled field, then a click that
writes `SUBMIT-STATE-ci-len:<len>` from JS **state** (not DOM), read back via
`browser_content` — proves framework state, not just value persistence.

Timings (docs/agent-inputs-probe.json): snapshots 1–4 ms; first-strategy type
2–5 ms; fallback-path types ≈5010 ms (bounded 5 s verification must exhaust
before the fallback engages — honest cost of a failing first strategy, no
sleeps added); clicks 2–4 ms.

## 4. Changed files & backups (all pre-edit copies in docs/backups/P1-01C/)

| File | Change |
|---|---|
| `main/agentRpc.js` | `setvalue` page-fn mode; type rewrite (verification taxonomy + one bounded fallback); `getRootNode()` label lookup; envelope `shadowPath` |
| `mcp/min-agent-mcp.js` | browser_type description (verification/strategy semantics) |
| `scripts/agent-inputs-probe.js` | NEW probe (probe:inputs npm script added to package.json) |
| `scripts/agent-actions-probe.js` | sensitive assertions `value` → `value-length` |
| `package.json` | `probe:inputs` script |

## 5. Regression (all commands actually run)

- `npm run build` + `node --check main.build.js` — OK
- `npm run test:agent-rpc` — **161/161**
- `npm run probe:inputs` — **20/20** (exit 0)
- `npm run probe:tabs` ×5 — **16/16 each, exit 0**
- `npm run probe:agent-actions` — **33/33**; `probe:agent-snapshot` — **27/27**
- `probe:nps` — **38/38**; `probe:capture` exit 0; `probe:detach` exit 0
- `smoke:baseline` ×3 — **6/6 each**
- 0 electron processes remain; symbol check OK

## 6. Real-site checkpoint (READ-ONLY — no typing, no clicks, no form submits)

Navigate result / snapshot (docs/real-site-checkpoint-P1-01C.json):

| Site | navigate | snapshot |
|---|---|---|
| example.com | verified:true, navigation, urlChanges 0, 4206 ms | 1 node (1 link), 5 ms |
| news.ycombinator.com | verified:true, urlChanges 0, 5501 ms | 200 nodes (199 links + 1 textbox, requestedMaxNodes 200), 14 ms |
| account.proton.me/login | verified:true, urlChanges 0, 6346 ms | 17 nodes: 8 buttons, 5 links, 2 textboxes, 1 checkbox, 1 heading; **1 redacted field** (password); heading 'Sign in' |

Proton's login page renders its sign-in form and the password field is
correctly flagged `redacted` (its value can never be read).

## 7. Limitations

- Fallback latency ≈5 s (verification window) when the first strategy cannot
  verify — by design (no sleeps; the window also serves first-strategy
  verification). A per-request "expect rejection" hint could shorten it, but
  that provides no value to an honest caller.
- Verified acceptance for non-sensitive fields compares the sanitized value;
  a framework that transforms typed text (e.g. auto-formatting like IBAN
  spacing) verifies as `rejected-input` even though events were accepted.
  Callers should re-snapshot for transformed-input sites.
- `unreadable-state` covers both "cannot enumerate post-dispatch" and
  "identity drifted during fallback"; the failReason field disambiguates.
- Closed shadow roots remain invisible (bounded claim: open roots only).
- Real-site checkpoint is read-only; no React input was verified against a
  REAL production React site in this task (fixtures emulate the controlled
  pattern faithfully; production React adds delegation on a shared root,
  which untrusted events DO reach).

## 8. Next recommended task

Stage E gate — CAPTCHA handoff (`probe:captcha` on an hCaptcha-shaped local
fixture; assert `-32021 captcha_handoff_required` from click/type near the
widget and `browser_state` recovery after manual solve), then the Stage-D
waits probe (`probe:waits`), before any further real-site work.
