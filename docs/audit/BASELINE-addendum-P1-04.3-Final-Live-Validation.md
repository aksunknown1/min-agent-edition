# P1-04.3 — Final Live Validation & Close-Out (Addendum)

Date: 2026-10-18 · Pre-task backup: `docs/backups/P1-04.3/main_agentRpc.pre-task.js` (= P1-04.2 build) · Post-task: `docs/backups/P1-04.3/main_agentRpc.post-task.js`

## 1. Current state audit (verified, not assumed)

- `package.json` → `"probe:transform": "node ./scripts/agent-transform-probe.js"` (confirmed by read).
- The 18 reported checks are **real assertions**: 18 `check()` call sites, no `skip`/`.only`/disabled assertions, no mock substitutes, no error swallowing; the only regex matches for "skip" were `process.exit` and a code comment.
- `agentRpcCommandNavigate`: the stray bare `return new Promise` is gone; exactly one Promise; `agentRpcClearTransforms(String(tabId))` verified **after** the missing-view, URL-policy and view-attached checks and **immediately before** the first `attempt()` (character offsets confirmed).
- `docs/agent-transform-probe.json` evidence: ranAt 2026-10-18T04:59:02Z, script field matches package.json target, 18/18.

## 2. Live-site matrix (production tools only; independent verification = fresh
`browser_verify` / `browser_content` page reads, never the transform's self-report)

| site | navigate | targets (independent discovery via `browser_verify` selector probes) | apply | independent verify | restore by exact transformId | post-restore independent verify | cross-target safety |
|---|---|---|---|---|---|---|---|
| example.com | PASS (finalUrl https://example.com/, verified) | `p:nth-of-type(1)` + `a:nth-of-type(1)` | PASS ×2 | PASS ×2 (marker in content, absent pre-apply) | PASS tf2 → tf1 (reverse order) | PASS ×2 (original back, marker gone) | PASS |
| news.ycombinator.com | PASS | `span.titleline > a` (1st candidate refused — see note) | PASS | PASS | PASS tf3 | PASS | n/a (1 target usable) |
| developer.mozilla.org | PASS | `h2` (1st candidate refused — see note) | PASS | PASS | PASS tf4 | PASS (whitespace-normalized content match) | n/a (1 target usable) |

Steps per site recorded raw in `docs/live-transform-validation.json` (ranAt 2026-10-18T05:36:35Z).
Two encoded `FAIL` rows are **expected framework-safety refusals**, not defects: `a:nth-of-type(1)`
(HN) and `h1` (MDN) are non-leaf elements (contain element children); the engine refuses text
replacement on them ("target has element children; text replacement refused (framework safety)")
and correctly listed the failure per-target while the alternate target applied cleanly.
Note: example.com no longer contains an `<h1>` (IANA parked page redesign); the probe discovers
targets from the live DOM instead of assuming a fixed selector.

Renderer console logs are not exposed by the bridge; tool-level statuses and did-fail-load codes
are recorded instead (all navigations verified, no load failures).

## 3. Lifecycle matrix — **FIXTURE-ONLY evidence** (not live-site evidence)
(`docs/live-transform-lifecycle.json`, ranAt 2026-10-18T05:32:xx, 7/7)

- L1 genuine cross-document navigation clears records — PASS
- L2 same-URL reload leaves no stale records — PASS
- L3 stale/fabricated transformId refused on restore — PASS
- L3b records never survive into another document — PASS
- L4 rejected navigation (blocked `javascript:` URL) preserves active records — PASS
- L5 tab close discards its records; sibling tab unaffected — PASS
- L6 hash change follows the documented URL-diff lifecycle contract — PASS

## 4. Targeted regression gates (exact commands, after the P1-04.3 code change)

| command | result | exit |
|---|---|---|
| `npm run build` | OK | 0 |
| `node --check main/agentRpc.js` | clean | 0 |
| `npm run test:agent-rpc` | 182/182 | 0 |
| `npm run probe:transform` | 18/18 | 0 |
| `npm run probe:waits` | 16/16 | 0 |
| `npm run probe:captcha` | 14/14 | 0 |
| `npm run probe:tabs` ×5 | 16/16 each | 0 ×5 |
| `npm run probe:pav` | 15/15 | 0 |
| `npm run probe:agent-actions` | 33/33 | 0 |
| `npm run probe:agent-snapshot` | 27/27 | 0 |
| `npm run probe:nps` | 38/38 | 0 |
| `node scripts/mcp-e2e.js` | 52/52 | 0 |
| `npm run probe:capture` / `probe:detach` | exit 0 | 0 |
| `npm run smoke:baseline` ×3 | 6/6 PASS each | 0 ×3 |
| leftover electron processes | 0 | — |

Differences vs the P1-04.2 report: none in totals; all gates re-verified on the current source.

## 5. Ad-blocker invariant

Exactly **one** effective `onBeforeRequest` registrant: `main/filtering.js` line 272
(`ses.webRequest.onBeforeRequest(handleRequest)`). `main/agentRpc.js` registers **zero** webRequest
listeners (grep-verified). Network-observation telemetry still exercised (browser_wait idle-drain
checks in `probe:waits` 16/16 and e2e ad-blocker checks within 52/52).

## 6. Changed files & backups

`main/agentRpc.js` — two minimal changes (both fix operations the task explicitly requires):
1. entry validation for `restore_target` now accepts transformId-only targeting
   (`restore using that exact transformId` was previously impossible to invoke — rejected as
   "requires ref or selector");
2. resolver gained the transformId-only restore arm (mirrors the selector-arm envelope).
Backups: pre-task `docs/backups/P1-04.3/main_agentRpc.pre-task.js`, post-task
`.../main_agentRpc.post-task.js`. New scripts (not wired into package.json):
`scripts/p1-043-live-validate.js`, `scripts/p1-043-lifecycle.js`, two throwaway diags.

## 7. Known limitations / environmental notes

- Renderer console capture is not a bridge capability (statuses recorded instead).
- Transforms survive only within the URL recorded at apply time (documented URL-diff contract);
  SPA/hash changes therefore discard records by design (L6).
- MDN's React re-render after restore was ruled out as a defect: a dedicated diagnostic
  (`scripts/p1-043-mdnh2diag.js`) showed the restore writes the original textContent back exactly
  (whitespace-faithful) and the page content matches pre-apply content byte-for-byte; the earlier
  mismatch was the probe comparing raw whitespace against innerText-normalized text.

## Gate decision: **PASS**

All mandatory local gates pass; real-site apply → independent verify → restore-by-transformId →
independent post-restore verify demonstrated on all three reachable targets with reverse-order,
cross-target-safe restoration.
