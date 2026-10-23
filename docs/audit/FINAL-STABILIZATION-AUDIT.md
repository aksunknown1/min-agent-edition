# Final Stabilization & Release-Readiness Audit (Audit Addendum — P1-14 final)

Date: 2026-10-19 · HEAD unchanged: `main @ 2b8088e` — all work local/uncommitted (41 changed/new files), **no commit, no push**.

## 1. Changes inspected & made

Preserved (verified, uncommitted): CAPTCHA policy correction (bridge fences ×2, SKILL.md, probe 19/19, matrix, docs) + VPS probe reconciliation (4 probes, proctools pattern) + prior hygiene.

Changes made in THIS task:
| file | change |
|---|---|
| `scripts/agent-pav-probe.js` | restored the 3rd readiness check (count back to **18/18**, see §2 TDZ cause); + added the earlier-missing success-path check |
| `mcp/README.md` | tool count 30 → **31** + enumeration now includes browser mouse / transform-status / state reporting |
| `docs/MCP-STDIO-E2E.md` | census count 21 → **31** (+ historical note) |
| `CONTRIBUTING.md` | added `proctools-test` and the probe safety contract + lint/audit as separate follow-up items |
| `scripts/p112-publish-set.js`, `scripts/p112-secret-scan.js` | exclude `.git/` internals (scanner artifact discovered: repo now has Git history, scan count inflated 410→893; fixed, publish set re-verified **420 files / 15.2 MB**) |
| `scripts/p1131-packaged-captcha-check.js` (**NEW**) | packaged runtime validation of the corrected CAPTCHA policy through the shipped adapter (6/6, see §5) |
| `dist/app/*` | regenerated via `npm run buildWindows` (packs the latest policy; see §5) |

## 2. Test-count reconciliation (PAV 18/18 → 17/17 → 18/18)

Root cause: while migrating the PAV readiness block to the shared `proctools.pollReadiness`
helper, three readiness assertions were reduced to two (the "startup tab enumerated"
check ended up only in the `PT_TIMEOUT` failure branch, so the success path lost it).
Likely trigger: the check originally anchored to a code path that the helper replaced;
during the rewrite one of the three was dropped with its inline loop.

Resolution: the success-path check was restored (now backed directly by the helper
result); readiness **and** timeout coverage verified:

- success/transient-empty/loaded-tab checks registered on every run;
- the `PT_TIMEOUT` branch registers a FAILING check and exits non-zero when the browser
  never becomes ready (`proctools-test` 9/9 also pins the poll's timeout contract);
- latest run: **18/18**.

## 3. Mouse result recorded accurately

Latest executed run: **26/29**. The 3 failing checks this run were `hover`, `ordered path
events (22/30 delivered)`, and `wheel page-side delivery` — all in the documented
P1-06.4 platform-limit family (Electron/Windows compositor event delivery). Prior runs
ranged 26–29/29 with the wheel check as the persistent failure. NOT marked as full pass.

## 4. Documentation consistency fixes

- `mcp/README.md`: 30 → 31 tools (+ enumeration updated; count cross-checked against the
  authoritative `TOOLS` catalogue: 31).
- `docs/MCP-STDIO-E2E.md`: census 21 → 31 (+ historical note for the P0-12-era text).
- `SKILL.md` / `mcp/README.md` failure-policy / `RELEASE_NOTES.md`: verified consistent
  with the corrected CAPTCHA behavior (detection informational; challenge clicks via the
  normal verified path; clearance only from page evidence; handoff available).

## 5. Packaged Windows validation (rebuilt this task)

- `npm run build` exit 0; `npm run buildWindows` **exit 0**.
- Artifacts: `dist/app/Min-Agent-Edition-1.35.7-setup.exe`
  (sha256 prefix `d47d10149278dd93c14a6c1b…`), `Min-Agent-Edition-v1.35.7-windows.zip`
  (`6bc058b9b23f33e42c6bf81c…`) + ia32/arm64 variants.
- Packaged-bundle verification: 2 policy-correction markers in
  `resources/app/main.build.js`; **0** `nearCaptcha === true` guards; shipped MCP adapter
  present; `resources/SKILL.md` carries the detection-informational wording.
- **Runtime validation performed** (not inferred from packaging success):
  `scripts/p1131-packaged-captcha-check.js` — packaged app launched with a fresh
  profile, driven through the **shipped** MCP adapter on the local fixture:
  **6/6 PASS** (detection reported; challenge-control click NOT refused; challenge click
  ≠ clearance — detection persisted; ordinary control clicked and independently
  verified; targeted cleanup, 0 strays). Additional limitation: x64 runtime-only —
  ia32/arm64 packages built but not launch-tested; no VPS/Linux runs.

## 6. Artifact audit (Phase 5) — classification, no broad changes

| group                                                                                 | classification                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/audit/*.md` (incl. this addendum)                                               | intentional audit documentation — publish                                                                                            |
| `docs/*.json` probe evidence                                                          | maintained test outputs — publish (regenerated by runs; scanned: no secrets/session tokens; only temp-path references)               |
| `docs/p110-runs/`, `p111-runs/` traces + PNGs                                         | run-specific captures — mostly local fixtures + benign public pages; tracked; recommend de-dup of identical screenshots (later pass) |
| `scripts/fixtures/`                                                                   | required test inputs — publish                                                                                                       |
| `docs/backups/` (incl. `captcha-policy-fix/`)                                         | traceability — retained, gitignored (publish-excluded)                                                                               |
| `dev-archive/`, personal screenshots, account artifacts, vendored zip/ubol/darkreader | local-only, gitignored — do not publish                                                                                              |

## 7. Deferred items (reconfirmed, unchanged)

`qa/` black-box harness implementation (design: `docs/QA-ARCHITECTURE.md`) · `qa/live/`
physical move · `npm test` lint failures (upstream style, single follow-up) · `npm audit`
upstream advisories · ia32/arm64 launch tests · VPS/Linux acceptance runs · commit/push
of the accumulated local work (user-gated).
