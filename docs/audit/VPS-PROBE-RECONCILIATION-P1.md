# VPS Probe-Findings Reconciliation (Audit Addendum — post-P1-13)

Date: 2026-10-19 · Branch `main @ 2b8088e`, changes local/uncommitted (no commit/push per constraints)

## 1. Verified issues and evidence (inspected in THIS tree; the VPS diff was not available and was not copied)

| #   | issue                                                                                                                                                                                                                                       | evidence in this tree                                               | verified defect?                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | `agent-tabs-probe.js` broad pre-kill `taskkill /IM electron.exe /F` (line 60) could terminate unrelated Electron/Min instances (user sessions, the VPS session)                                                                             | grep hit; pre-kill was unconditional at every run start             | YES — fixed                     |
| 2   | `agent-mouse-probe.js` had 4 broad-kill sites (start drain-loop with `execSync taskkill /F /IM electron.exe /T`, 2 exit-path kills, 1 catch-path kill) plus `proc.unref()` on the spawned Min                                               | grep hits at 92/239/240/245; unref at 104                           | YES — fixed                     |
| 3   | `agent-downloads-probe.js` broad kill loop at start **and** a real Min process leak: the spawner used `detached: true` + `unref()` and no exit path ever terminated it                                                                      | code inspection; no killTree anywhere; `process.exit` on both paths | YES (leak + broad kill) — fixed |
| 4   | `agent-pav-probe.js` startup-readiness race: bridge/discovery file exists before sessionRestore/viewManager enumerate tabs → single immediate `browser_tabs` read yields empty list/empty-shell tabs → `.tabId` of undefined → 3/16 cascade | code path `(tabs.find(t.active)                                     |                                 | tabs[0]).tabId` crashes on empty; earlier observed related cascade (buffer-block fix in P1-12 was a different, additional race) | YES — fixed |

## 2. Changes (smallest correct, all in `scripts/`)

- **`agent-tabs-probe.js`**: broad pre-kill removed; dedicated-profile isolation + already-present tracked `launcher.pid` targeted cleanup relied on instead (exit paths unchanged, still targeted `/PID launcher.pid`).
- **`agent-mouse-probe.js`**: drain-loop + 3 broad kill sites removed; `procHandle` hoisted, tracked at spawn (`procHandle = proc.pid`), targeted `killTree()` on both exit paths; `proc.unref()` removed.
- **`agent-downloads-probe.js`**: killTree added (success + failure exit paths); spawn changed `detached:true + unref()` → in-tree tracked process (leak fix); broad loop removed.
- **`agent-pav-probe.js`**: bounded readiness poll after bridge discovery — tolerates transient **empty tab lists** and **empty-shell** entries, requires the launcher's start-URL tab enumerated **and not loading**, then proceeds; fails after the bound if the browser never becomes ready (does not mask genuine failures). 3 new regression checks.

PID-reuse/pre-existing-process handling: PIDs are captured immediately after spawn and killed only within the same run; every probe uses dedicated temp profiles, so pre-existing foreign instances can never absorb or be absorbed by a run.

## 3. CAPTCHA correction preserved (explicit verification)

- `main/agentRpc.js`: `nearCaptcha === true` guard count = **0** (both hard refusals gone); the two "P1-13 follow-up (CAPTCHA policy correction)" fences are present.
- `SKILL.md`: "Detection is **informational**" policy section intact.
- `scripts/agent-captcha-probe.js` re-run: **19/19** (challenge-control click through normal path, detection-persists check green).
- `scripts/p110-api-matrix.js`: policy-correction checks present and green (matrix 93/93 in this session's earlier run; captcha probe re-ran 19/19 after the probe fixes).
- No solving services / stealth / token forgery / unverified bypass introduced.

## 4. Tests actually executed (serial; exact commands)

| command                              | result                                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/agent-pav-probe.js`    | **18/18** (15 legacy + 3 readiness; includes live example.com read-only step)                                                                                                                      |
| `npm run probe:tabs`                 | **16/16**                                                                                                                                                                                          |
| `npm run probe:downloads`            | **33/33** and **0** electron/Min processes after exit (leak fix proven)                                                                                                                            |
| `npm run probe:mouse`                | **27/29** — the 2 fails are the documented P1-06.4 platform limits (durable hover, wheel delivery); the 2 new readiness checks PASS; note: totals are up 27→29 because of the new readiness checks |
| `npm run probe:captcha`              | **19/19** (CAPTCHA correction intact on the real bridge)                                                                                                                                           |
| `node scripts/p1-07-updater-test.js` | 18/18 (unrelated sanity)                                                                                                                                                                           |
| `npm run build` (earlier in session) | exit 0                                                                                                                                                                                             |

Environment limitations: Windows VPS results (3/16→16/16, packaged app behavior, Linux) were NOT re-tested on a VPS/Linux — only the Windows original-project environment was exercised.

## 5. Evidence & backup classification (no deletions)

| item                                                                                                    | role                                                                                            | disposition recommendation                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `docs/backups/captcha-policy-fix/` (7 files)                                                            | pre-change snapshot feeding the CAPTCHA policy audit addendum                                   | keep local; excluded from publish set via `docs/backups/` gitignore; retain until the CAPTCHA change is committed, then optional |
| `docs/*.json` probe/evidence files (regenerated each run, tracked in git)                               | ongoing regression evidence for the audit addenda; the P1-13 commit intentionally included them | keep in the product repo; refreshed by every probe run                                                                           |
| 3 new `docs/p110-runs/api-s1-*.png` (from the latest matrix run)                                        | duplicate-identical fixture screenshots                                                         | benign; candidates for a future de-dup pass                                                                                      |
| `dev-archive/`, `docs/backups/`, `docs/demo-atomic-mail/`, `extensions/real/`, `min-v1.35.7-source.zip` | local-only via `.gitignore`                                                                     | unchanged; stay local-only                                                                                                       |

## 6. Repository-hygiene recommendation (next task, not executed here)

1. Split script directories by purpose: `scripts/` (product build + package-referenced probes), optional `qa/live/` (probes that touch the real network/live sites), keeping all in-repo — no deletion.
2. Add a shared `scripts/lib/proctools.js` (tracked-PID killTree + readiness poll) and refactor the standalone probes to consume it (deduplicates the fix applied 4×).
3. Decide policy for auto-generated `docs/*.json` evidence: either commit refreshed evidence per phase or commit only curated artifacts and add the volatile ones to `.gitignore`.
4. De-duplicate identical screenshots under `docs/p110-runs/`.
5. Rename `scripts/p1-064-note.txt`/`p1-07-baseline-perf.json` into `docs/` so `scripts/` contains only executable tooling.
