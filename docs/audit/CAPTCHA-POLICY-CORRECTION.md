# CAPTCHA Interaction Policy Correction (Audit Addendum — P1-13 follow-up)

Date: 2026-10-19 · Branch `main `@ `2b8088e` (fix in working tree, **uncommitted — no commit/push unless requested**)

## 1. Files/functions responsible for the old behavior

| file:location                                                 | old behavior                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main/agentRpc.js` → `agentRpcCommandClick()`                 | `if (t.nearCaptcha === true) throw captcha_handoff_required (-32021)` — refused ANY ref-targeted click whose element rect intersected a detected widget box |
| `main/agentRpc.js` → `agentRpcCommandType()`                  | identical hard refusal for text targets overlapping a widget                                                                                                |
| page-fn `locate` mode (`AGENT_SNAPSHOT_PAGE_FN`)              | computed `nearCaptcha` per node (rect ∩ widget box from `CAPTCHA_SEL`) — informational, but the flag fed the guards above                                   |
| `SKILL.md` (CAPTCHA section + Scenario 5 + browser_state row) | encoded "pause on detection / never touch challenge" as policy                                                                                              |
| `scripts/agent-captcha-probe.js` (`probe:captcha` check 2)    | asserted type-over-widget → 409 refusal                                                                                                                     |
| `scripts/p110-api-matrix.js` Scenario 6                       | asserted challenge-control click refused; also implied "detection ⇒ pause"                                                                                  |
| `mcp/README.md` (step 5) + `RELEASE_NOTES.md`                 | documented `captcha_handoff_required` as the handoff contract                                                                                               |

Scope note: the guard was **target-scoped** (only near-widget targets), not page-wide —
the probe itself proved unrelated content/status stayed available. But challenge-control
interaction (e.g. a visible "Solve challenge" button inside the widget box) was refused
unconditionally, and the docs/skill overstated it as a blanket pause-and-never-touch rule.

## 2. Minimal changes made

1. **`main/agentRpc.js` `agentRpcCommandClick()`** — removed the `nearCaptcha` throw
   (replaced by a policy-correction comment). Challenge-control clicks now go through the
   normal verified interaction path; unrelated guards (disabled targets, risky-name grant
   policy, single-use grants, origin/auth checks) unchanged.
2. **`main/agentRpc.js` `agentRpcCommandType()`** — removed the identical `nearCaptcha`
   throw (sensitive-field grants, role/disabled checks, value verification unchanged).
3. **Kept**: `CAPTCHA_SEL` detection, `captchaBoxes`, `nearCaptcha` informational marker,
   `browser_state` `captcha{detected,kind,confidence,basis,widgetCount,policy}` reporting,
   and the (now unused) `captcha_handoff_required` error-map entry for client compatibility.
4. **`SKILL.md`** — CAPTCHA section + Scenario 5 + `browser_state` row rewritten:
   detection is informational; challenge controls inspectable/clickable through the
   normal path when the task explicitly requires it; clearance claims require independent
   page-state verification; human handoff remains a first-class option; no bypass tooling.
5. **`scripts/agent-captcha-probe.js`** — fixture gained an in-widget visible button
   ("Open challenge"); refusal expectation replaced with: type-into-overlapping-field
   succeeds (`verification:"value"`), challenge-control click dispatches (no
   `captcha_handoff_required`), unrelated button clickable while widget present with
   content-verified effect, detection persists after a challenge click (detection ≠
   clearance), post-navigation cleared state, unreachable-navigation "apparent block"
   reporting, live example.com not flagged. Now **19/19 checks**.
6. **`scripts/p110-api-matrix.js` Scenario 6** — refusal expectation replaced with
   not-rejected + detection-persists checks (93 checks total, was 90+3-refusal).
7. **`mcp/README.md`** + **`RELEASE_NOTES.md`** — handoff contract wording updated.

Backups: `docs/backups/captcha-policy-fix/` (all 7 modified files, pre-change).

## 3. Before/after

| behavior                                                                      | before                           | after                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| click on unrelated page control while challenge present                       | allowed (never blocked)          | allowed (regression-covered explicitly)                                                                     |
| type into field overlapping widget                                            | **409 captcha_handoff_required** | normal verified path (`verification:"value"`)                                                               |
| click visible challenge control (e.g. "Solve challenge")                      | **409 refusal**                  | normal verified path; effect must be verified from page state                                               |
| detection ⇒ clearance                                                         | no (but probe didn't cover)      | explicit regression: detection persists after challenge clicks                                              |
| human handoff                                                                 | available                        | available (browser_state reporting unchanged; REQUIRED before claiming cleared on genuine human challenges) |
| unrelated bridge security (auth, origin/host, grants, single-onBeforeRequest) | —                                | unchanged, verified by suite                                                                                |

## 4. Validation (real bridge paths — Electron launched by probes, no mocked policy)

`npm run build` exit 0 → `npm run probe:captcha` **19/19** → `p110-api-matrix` **93/93**
(S6 ×3 re-verified on live MCP path) → `test:agent-rpc` **182/182** → `mcp-e2e` **56/56** →
transform 18/18 · downloads 33/33 · mouse 26/27 (documented wheel limit) · updater 18/18 ·
pav 15/15 · tabs 16/16 · inputs 20/20 · waits 16/16 · actions 33/33 · smoke 6/6 ·
`onBeforeRequest` single effective registrant (`main/filtering.js:293`) upheld · 0 strays.

## 5. Still requiring human interaction / remaining limitations

- Real provider challenges (Cloudflare/hCaptcha/reCaptcha) cannot be solved by the agent —
  no solving services/stealth/token forging, by design. For those, human handoff +
  page-state-verified clearance remains the (still available) path.
- `browser_state` detection is locator/box heuristics: challenges without a recognized
  marker are "unknown/low" — the agent verifies from page state regardless.
- The **packaged Windows artifacts** still embed the pre-fix `main.build.js`; re-run
  `npm run buildWindows` before the next packaged release to pick up the policy change.
- Fixtures simulate widget markers only (no provider code) — real-provider _behavior_ is
  NOT exercised beyond detection/marker tests.
- Changes are **local, uncommitted** on `main @ 2b8088e` (git commit deferred unless you ask).
