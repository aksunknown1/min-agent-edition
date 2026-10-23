# P1-10 — Intelligent End-to-End Browser Workflows (Audit Addendum)

Date: 2026-10-18 · Gate: **PASS** (with one agent-environment caveat, honest below)

## 1. Changed files & backups

| file                                          | change                                                                                                                                                                                                             | backup                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `SKILL.md`                                    | Phase-1 accuracy edits only: fixed `dusrfully`→`dutifully not verified`; hdhub example's fixed coords `(x:500,y:200)` replaced with "compute from CURRENT screenshot + cssPerPixel/viewport metadata" instructions | `docs/backups/P1-10/SKILL.md.pre-p110`           |
| `scripts/agent-pav-probe.js`                  | TEST-HARNESS FIX (why: see §5) — child pipe drain added; no assertions weakened                                                                                                                                    | `docs/backups/P1-10/agent-pav-probe.js.pre-p110` |
| `scripts/p110-fixture-server.js`              | NEW: benign local fixture server (gate v1/v2, gate2, 302 redirect route, form, delayed, known, known2, linkpage, captcha-sim with locator markers only - no provider code)                                         | new file                                         |
| `scripts/p110-lib.js` / `p110-keeper.js`      | NEW: reusable stack launcher (min-launch + REAL `mcp/min-agent-mcp.js` stdio adapter) + localhost control port for one-call-at-a-time agent driving; per-call trace + real PNG capture                             | new                                              |
| `scripts/p110-api-matrix.js`                  | NEW: deterministic API-level matrix, 7 scenarios × 3 runs, pre-declared assertions                                                                                                                                 | new                                              |
| `scripts/p110-agent-step.js`, `p110-dbg-*.js` | NEW: one-MCP-call-per-invocation driver + diagnostics                                                                                                                                                              | new                                              |

**No production source changes** (`main/`, `mcp/`, `ext/` untouched this phase).

## 2. Evidence levels, clearly separated

- **A. API-level (deterministic)**: `docs/p110-api-matrix.json` — 7 scenarios × 3 runs = 21 runs, **90/90 assertions PASS**. Proves the browser/API contracts (sparse-tree detection, real image blocks, single-registrant invariants, batch limits 20-steps/grant-exclusion, CAPTCHA refusal, event-driven waits).
- **B. Agent-level (real decisions, real MCP path, live image inspection)**: an actual reasoning agent (this evaluator, SKILL.md policy loaded) drove all 7 scenarios through the REAL configured path — `min-launch.js` + `mcp/min-agent-mcp.js` stdio adapter — one tool call per decision step (`scripts/p110-agent-step.js` is transport only; every decision, coordinate computation, screenshot inspection, and re-plan was made by the agent between calls, not scripted). Screenshots arrived as real MCP image blocks (saved to `docs/p110-runs/agent-*.png`) and were **genuinely visually inspected** (coordinate derivation from actual image content ×1.92 device scale ÷ 1.8903 cssPerPixel). Traces: `docs/p110-runs/trace-p110-*.jsonl`.

## 3. Scenario results (agent-level; API matrix confirms ×3)

| #   | scenario                                                 | outcome | process quality                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1a | sparse gate v1 (bottom-right ctrl)                       | PASS    | snapshot nodeCount=1 → screenshot received+inspected → 1 grounded click (1840,954 from THAT image) → `GATE-UNLOCKED-v1` verified; 0 blind clicks, 0 guessed URLs, 0 fixed sleeps                                                                                                                                                |
| S1b | gate v2 (control relocated top-left, smaller, relabeled) | PASS    | fresh screenshot + fresh coordinate derivation (203,146); same click-verify loop; proves no coordinate memorization                                                                                                                                                                                                             |
| S2  | semantic form                                            | PASS    | refs from snapshot (r1 textbox, r3 submit); type value-verified (`native-insert`); click dom-verified; content verified; **0 screenshots**                                                                                                                                                                                      |
| S3  | delayed content                                          | PASS    | single event-driven `browser_wait until=selector_visible` (satisfied) → verify; 0 fixed sleeps                                                                                                                                                                                                                                  |
| S4  | unexpected redirect                                      | PASS    | clicked page link → `/gate2?v=RED` (302, unseen state) → destination diffed vs expectation → re-observe → verify; no route guessing                                                                                                                                                                                             |
| S5  | known page efficiency                                    | PASS    | DOM-first semantic click (`verification:"navigation"` self-verified) → 1 cheap verify; **0 screenshots, 0 extra snapshots**                                                                                                                                                                                                     |
| S6  | CAPTCHA handoff                                          | PASS    | `browser_state` → `captcha{detected:true,kind:turnstile,confidence:high}`; click on challenge **refused** `captcha_handoff_required -32021`; agent paused for user (fixture button = user proxy); post-completion `browser_state detected:false widgetCount:0` (policy: re-run to confirm cleared) → `CAPTCHA-CLEARED` verified |
| S7a | deterministic batch (observed form)                      | PASS    | **one honest re-plan**: stale ref → `ref_stale -32016` stop-on-error → fresh snapshot (refs r?→ri/rk) → batch ok (2 steps, self-verified) → content verified                                                                                                                                                                    |
| S7b | batch vs re-plan on unknown page                         | PASS    | sparse snapshot (nodeCount=1) → **decision: NO batch** (evidence insufficient) → screenshot → grounded click → verified; 0 batch calls on unknown state                                                                                                                                                                         |

Honest S1/S7 coordinates: computed per-run from the current screenshot's image content + its `cssPerPixel`/`viewport` metadata (dims 2032×1063 css @ dpr 1.89); never copied from a prior run.

## 4. Latency & counts (exact counting rules: keeper trace timestamps, tool-call wall time)

API matrix (n=115 calls): navigate mean 1557 ms (max 1598), wait 1674 ms (max 3910 — includes page delay), click 346 ms, batch 192 ms, screenshot **103 ms mean** (57-77 KB PNGs), snapshot/state/verify/type **3-8 ms**.
Agent-level: 67 decision-driven calls across 3 keeper sessions (mean 357-721 ms/call incl. live-network MDN/example.com), **3 screenshot images received and visually inspected**, 0 blind-coordinate repeats, 0 guessed URL patterns, 0 fixed sleeps (S3/S4 waits were event-driven), 1 legitimate re-plan after a structured `ref_stale` error.
Policy-off baseline: the same reasoning agent cannot be run "without the skill" in an isolated A/B in this environment — **no invented improvement percentage is claimed**.

## 5. Test-harness root cause found & fixed (P1-10 side discovery)

`probe:pav` regressed 2/15 during the battery: `scripts/agent-pav-probe.js` spawned Min with `stdio:['ignore','pipe','pipe']` and **never drained stderr/stdout**; Min's startup logging filled the 64KB pipe buffer and blocked the Electron child mid-startup (discovery written, start-URL tab never opened → active tab stuck on Welcome; `nodes=0` cascade). Verified by isolation reproduction: identical spawn WITH drain opens the fixture tab correctly. Fix: add two drain listeners (harness-only; backup taken). Re-run: **15/15**. This was an environment/harness blocker, not production-source defect — no production change made.

## 6. Live validation (real MCP path)

| site                  | navigate                  | DOM-first action                                                                    | independent verification                              | screenshot to agent                                                    |
| --------------------- | ------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| example.com           | verified `Example Domain` | clicked semantic "Learn more" link (`r0`)                                           | `iana.org/help/example-domains` URL + title read back | — (not needed)                                                         |
| developer.mozilla.org | verified `MDN Web Docs`   | rich snapshot (20 nodes, shadow-piercing `::shadow` refs for search/theme controls) | content text + title                                  | **738KB PNG received and visually inspected** (real rendered MDN page) |

No fabricated live tests: the visual-gate scenario remains on the local fixture (public pages have no suitable a11y-invisible control).

## 7. Regression matrix (exact commands, current package.json)

| command                                                   | result                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run build`                                           | exit 0 (all 4 subcommands clean)                                                              |
| `npm run test:agent-rpc`                                  | 182/182                                                                                       |
| `node scripts/mcp-e2e.js`                                 | 56/56 (incl. real image content)                                                              |
| `npm run probe:mouse` ×2                                  | 26/27, 26/27 (documented wheel platform limit)                                                |
| `npm run probe:transform`                                 | 18/18                                                                                         |
| `npm run probe:downloads`                                 | 33/33                                                                                         |
| `node scripts/p1-07-updater-test.js`                      | 18/18                                                                                         |
| `npm run probe:pav`                                       | 2/15 → **15/15** after §5 harness fix                                                         |
| `npm run probe:agent-actions` / `agent-snapshot` / `nps`  | 33/33, 27/27, 38/38                                                                           |
| `npm run probe:tabs` / `waits` / `captcha` / `inputs`     | 16/16, 16/16, 14/14, 20/20                                                                    |
| `npm run smoke:baseline`                                  | 6/6                                                                                           |
| `probe:capture` / `detach` / `two-url-argv` / `agent-rpc` | visibleCaptureOk + hiddenRejectionHandled + allPassed×2 (report-style, exit 0 design)         |
| `node scripts/extension-probe.js`                         | 26/27 (1 platform-limited, unchanged from P1-08.x baseline)                                   |
| ad/tracker invariant                                      | `onBeforeRequest` sole registration at `main/filtering.js:293`; agentRpc.js has comments only |
| stray electrons                                           | 0                                                                                             |

## 8. API gaps / limitations (unchanged, honestly stated)

- Durable synthetic hover / mouse-wheel page delivery remain platform-limited (P1-06.4 evidence); `browser_scroll` is the reliable scroll path. Accepted, documented in SKILL.md.
- No new tools added; none needed — `browser_content` + `browser_snapshot` + `browser_screenshot` + `browser_wait` + `browser_mouse` cover all 7 scenarios including the visual-gate fallback.
- CAPTCHA: real third-party providers NOT exercised (`NOT_EXERCISED_LIVE` for actual provider challenges by design/ethics); the handoff contract (detect → refuse interaction → pause → user completes → re-verify clearance) was fully exercised end-to-end on the locator-marker fixture through the real MCP path.
- Real-world-network filter-list fetch remains environment-limited (P1-07).

## 9. Gate decision: **PASS**

Local scenarios pass with decision/process assertions (not just end-state), the agent-level gate was genuinely exercised (live decisions + real screenshot inspection through the real MCP path, recorded traces), mandatory regressions pass (one harness root cause found, fixed, re-proven), and both safe live-site checks completed. Residual: real-provider CAPTCHA `NOT_EXERCISED_LIVE` (deliberate), no policy-off baseline A/B (would require a second isolated agent run; explicitly not invented).
