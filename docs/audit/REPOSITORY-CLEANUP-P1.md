# Repository Cleanup & GitHub Preparation (Audit Addendum)

Date: 2026-10-19 · Gate: **READY_WITH_CAVEATS**

## 1. Inventory classification (Phase 1)

| category                              | location                                                                                                                                                                                         | status                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| production source + runtime resources | `main/`, bundled `main.build.js`, `js/`, `css/`, `pages/`, `reader/`, `localization/`, `icons/`, `index.html`, `ext/` (incl. abp parser + filter lists), `filterUpdate.js`, `mcp/`               | KEEP                                                                                 |
| build/packaging files                 | `scripts/build*.js`, `scripts/createPackage.js`, `package.json`, `.github/workflows/`, `icons/`                                                                                                  | KEEP                                                                                 |
| agent docs                            | `SKILL.md` (root + shipped via extraResources), `mcp/README.md`, `RELEASE_NOTES.md`, `docs/*.md` designs/audits                                                                                  | KEEP                                                                                 |
| regression tests + fixtures           | `scripts/agent-*.js`, `mcp-e2e.js`, `smoke-baseline.js`, `capture-page-probe.js`, `detach-probe.js`, `two-url-argv-probe.js`, `extension-probe.js`, `p1-07-updater-test.js`, `scripts/fixtures/` | KEEP                                                                                 |
| package-referenced scripts            | `setupDevEnv.js`, `watch.js`, `min-launch.js`, all `build*.js`                                                                                                                                   | KEEP                                                                                 |
| historical backups + audit evidence   | `docs/backups/` (38 dirs), `docs/audit/`                                                                                                                                                         | KEEP on disk, gitignored for publish                                                 |
| temporary diagnostics                 | 124 `p1-*`/`tmp-*` one-off scripts, 13 atomic-live/demo scripts                                                                                                                                  | ARCHIVED to `dev-archive/`                                                           |
| generated outputs                     | `dist/` (2.4 GB incl. installers), `main.build.js`                                                                                                                                               | already gitignored                                                                   |
| dependencies                          | `node_modules/`, `package-lock.json`                                                                                                                                                             | module dir ignored; lockfile preserved on disk (upstream gitignores it deliberately) |
| sensitive/user data                   | personal screenshots, demo-atomic-mail, one credential script, `extensions/real/`                                                                                                                | see §3                                                                               |
| unknown/pre-existing                  | `min-v1.35.7-source.zip` (vendored upstream reference), `p1-064-note.txt`, `p1-07-baseline-perf.json`                                                                                            | KEEP (evidence/reference)                                                            |

## 2. Actions executed (Phase 5)

- **ARCHIVED → `dev-archive/`** (new, gitignored): 124 p1-/tmp- diagnostic scripts, 13 atomic-live/demo scripts, 11 personal screenshots. Reference-checked first: zero `require()`/`spawn`/package.json dependencies on any moved file (only prose mentions). See `dev-archive/MANIFEST.md`.
- **REMOVED (secure exclusion)**: `scripts/atomic-live-passwords.js` (real credential literal — never archived; account is a throwaway test account, treat as abandoned); 13 root-level tmp logs/dumps (`tmp-*.log/txt/json` — scanned for secret patterns first: 0 matches).
- **ADD_TO_GITIGNORE**: `/dev-archive/`, `/min-v1.35.7-source.zip`, `/extensions/real/`, `/docs/demo-atomic-mail/`, `/docs/backups/`, `/tmp-*`, `*.log`, `/dist/` (pre-existing).
- **Restored**: `scripts/p1-07-updater-test.js` (accidentally matched the archive sweep; restored, `18/18` re-verified).
- No production source, MCP schemas, filters, download policy, or security settings changed.

## 3. Sensitive-file audit summary (values redacted — none printed anywhere)

| path                                                                                     | category                                                                 | action                                                                                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `scripts/atomic-live-passwords.js`                                                       | credential literal (email+password, throwaway test account)              | REMOVED from disk (not archived); account treated as abandoned; **never entered any Git history (no repository exists)** |
| `docs/demo-atomic-mail/`                                                                 | account-creation screenshots                                             | kept locally, gitignored; do not publish                                                                                 |
| `docs/hdhub4u-*.png`, `live-*.png`, `hinglish-live-demo.png`, `p1081-mdn-darkreader.png` | personal browsing-session screenshots                                    | moved to gitignored `dev-archive/personal-screenshots/`                                                                  |
| `docs/atomic-live-*.json`                                                                | session metadata only (temp paths, PIDs) — no tokens                     | KEEP                                                                                                                     |
| `docs/agent-*.json`, `mcp-e2e-run.json`, `p111*-*.json`                                  | probe evidence; bridge tokens verified redacted by the probes themselves | KEEP                                                                                                                     |
| `%APPDATA%/Min`, `%APPDATA%/Min Agent Edition`, temp harness profiles                    | user data outside repo — never touched/copy"ed                           | out of scope; P1-11.1 proven-untouched evidence retained in JSON                                                         |

## 4. Recommended GitHub structure

Publish the cleaned tree as-is (single repo, upstream-compatible layout):
production code roots at top level; `scripts/` = package-referenced tooling + regression probes;
`docs/` = design docs, audit addenda (incl. this file), probe evidence JSONs;
`SKILL.md` + `RELEASE_NOTES.md` at root; distributables **out of Git** — attach
`Min-Agent-Edition-*.zip`/`-setup.exe` from `dist/app/` to GitHub Releases or build via the
existing `.github/workflows/build-packages.yml` (workflow_dispatch). `dev-archive/`,
`docs/backups/`, `extensions/real/`, `min-v1.35.7-source.zip` stay local-only via .gitignore.
Note: `package-lock.json` is ignored by the inherited upstream rule — preserve locally;
decide before first commit whether to start committing it (recommended) — NEEDS_REVIEW.
Do not publish under a name/identity claiming to be official Min (identity is already
distinct per P1-11.1 and RELEASE_NOTES).

## 5. Post-cleanup verification (exact commands, actual runs)

| command                                                         | result                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run build` / `node --check main.build.js`                  | exit 0 / OK                                                                           |
| `npm run test:agent-rpc`                                        | **182/182**                                                                           |
| `node scripts/mcp-e2e.js`                                       | **56/56**                                                                             |
| `npm run probe:transform`                                       | 18/18                                                                                 |
| `npm run probe:downloads`                                       | 33/33                                                                                 |
| `npm run probe:pav`                                             | 15/15                                                                                 |
| `npm run probe:tabs`                                            | 16/16                                                                                 |
| `npm run probe:inputs`                                          | 20/20                                                                                 |
| `npm run probe:waits`                                           | 16/16                                                                                 |
| `npm run probe:captcha`                                         | 14/14                                                                                 |
| `npm run probe:mouse`                                           | **27/27** (wheel check passed this run; known platform limitation remains documented) |
| `node scripts/p1-07-updater-test.js`                            | 18/18 (after restore)                                                                 |
| `npm run probe:agent-actions` / `agent-snapshot` / `probe:nps`  | 33/33 / 27/27 / 38/38                                                                 |
| `npm run smoke:baseline`                                        | 6/6                                                                                   |
| `node scripts/extension-probe.js`                               | exit 0, evidence written                                                              |
| `npm run probe:capture` / `probe:detach` / `probe:two-url-argv` | visibleCaptureOk+hiddenRejection / guardBlocks`DeadlyCapture`:true / `allPassed`:true |
| `node scripts/p1111-coexistence.js`                             | **16/16** (re-verified post-cleanup)                                                  |
| lingering Min/electron processes                                | 0                                                                                     |

## 6. NEEDS_REVIEW items (unresolved, non-blocking)

1. `package-lock.json` upstream gitignore rule — decide whether first commit includes it (preserved on disk either way).
2. `docs/backups/` retained locally but excluded from publish — confirm before first push whether provenance history should ever be published.
3. PAV-in-chain startup-contention flake (passes isolated) — candidate for a follow-up harness isolation improvement.
4. Atomic Mail throwaway test account left abandoned — no action possible post-removal; do not reuse.

## 7. Decision: **READY_WITH_CAVEATS**

Repository content is clean, referenced-only-by-evidence files are preserved (archive + backups), one real credential was securely removed before any Git history could exist, and the full regression suite passes on the cleaned tree. Caveats are documentation-level (SmartScreen/unsigned distribution, upstream lockfile policy, VM-bound installer tests) — no blocking defect.
