# R3 Post-Run Diff Triage

**Date:** 2026-10-20
**Scope:** forensic read-only audit of the working-tree expansion caused by an accidental
`npm run lint` during R3, plus validation of the R3 real-web work.
**Outcome:** **no files were modified, restored or reverted.** Classification and the
recovery decision are below.

---

## 1. Fresh baseline and final status

Captured at the start of this task (not taken from the R3 report):

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD | `2b8088e0838524cad5cba92d77a0680897f75429` (`Initial Min Agent Edition source import`) |
| Staged files | **0** |
| Tracked modified | **155** |
| Untracked | **104** |
| Deleted | 0 |
| Total porcelain entries | 259 |
| Electron processes | **0** |
| Stashes | **0** |
| Commits | 1 total (`git log --all`), 4 reflog entries, all pointing at `2b8088e` |

No commit, no push, no stage, no reset, no clean, no stash. All commands run in this task
were read-only (`git show`, `git diff`, `git status`, `git log`, `git fsck`, Node scripts
that only read files and print/measure).

End state is identical to the start: **0 staged, HEAD unchanged, 155 tracked modified,
104 untracked, 0 Electron processes.**

---

## 2. Exact `npm run lint` behaviour, and why it is unsafe as a check

From `package.json`:

```
lint = prettier --write **/**/*.css **/**/*.md **/**/*.html **/**/*.json && standard --fix js/**/*.js main/*.js | snazzy
```

Three separate hazards:

1. **`prettier --write` rewrites in place.** It is not a check. Running it across
   `**/**/*.css|md|html|json` reformatted **100 of the 155** modified tracked files,
   including 17 localization files, 20 Markdown tables, 19 JSON evidence files, and
   entire UI stylesheets. A dry check would have been `prettier --check`.
2. **`standard --fix` also writes.** It rewrites `js/**/*.js` and `main/*.js` — the
   renderer and main-process source.
3. **The pipeline masks failure.** `... | snazzy` pipes `standard` through a formatter;
   the exit status of the pipeline is `snazzy`'s, not `standard`'s. Worse, because
   `--fix` already applied fixes, a plain run reports fewer findings than the tree
   actually had. It cannot serve as a pass/fail gate.

Additional context: `prettier` 2.8.8 is installed, **no** `prettier` config key exists in
`package.json`, and `.prettierignore` excludes only `dist` and `ext`. So the formatter ran
with its defaults (2-space, double→single quote normalisation, prose wrap, Markdown table
alignment) over files that had never been formatted to that standard.

I did **not** run `npm run lint` again in this task.

---

## 3. Tracked / untracked census

**Tracked modified: 155** by extension:
`json 52 · md 43 · js 42 · css 11 · html 6 · jsonl 1`

**Untracked: 104.** Evidence for provenance:

- `git log --all` contains exactly **one** commit; every tracked file therefore has
  exactly one HEAD version. Untracked files have no git history at all.
- The R3 work created: `scripts/lib/realweb-harness.js`, the rewritten
  `scripts/realweb-accept.js` (untracked because it was created earlier in the session),
  `docs/realweb-accept.json`, and the temporary `scripts/tmp-*-experiment.js` probes
  (52 of them, since deleted during R3 cleanup).
- The remaining untracked entries are documentation/audit artefacts produced by earlier
  R0–R2 phases and prior sessions; they cannot be attributed to the formatter because
  prettier only rewrites files matching its globs and leaves new files it created
  indistinguishable from hand-written ones. **No untracked file was deleted or moved.**

**Formatter target check:** the 100 files proven formatting-only all match prettier's
globs (`*.css`, `*.md`, `*.html`, `*.json`). The 42 modified `.js` files are split: 17
proven format-only (touched by `standard --fix`), 25 carry real content. `jsonl` is not
in prettier's globs, so its diff is **not** formatter output (see §4).

---

## 4. Per-file classification with evidence

Method (all read-only, all reproducible from HEAD + working tree):

- **JSON**: parsed both sides, walked every leaf path, compared `type:value` per path.
  Two-tier: (a) all leaves identical → **layout/key-order only**; (b) leaves differ →
  real content change.
- **JS/CSS/HTML**: comment-stripped token stream comparison; then a second normalisation
  removing whitespace, optional semicolons before line-break/`}` and trailing commas.
  Identical under that normalisation → formatting-only.
- **Markdown**: table-cell padding normalisation (cells trimmed, separator rows
  collapsed) plus whitespace-collapsed prose; identical → table-alignment only.
- **CSS**: explicit "missing trailing semicolon" diff inspection.

Result: **100 of 155 tracked diffs are proven formatting-only. 55 are not proven and were
left untouched.**

### 4a. Proven formatting-only (100)

| class | count | meaning |
|---|---|---|
| `FORMAT_INDENT_ONLY_PROVEN` | 38 | token stream identical; only indentation/line-wrapping differs (incl. 17 localization `.json` files) |
| `FORMAT_CSS_SEMICOLON_ONLY_PROVEN` | 3 | prettier added a trailing `;` to the last declaration |
| `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 20 | Markdown table alignment padding only |
| `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 19 | every parsed leaf identical; only whitespace/key layout changed |
| `FORMAT_ONLY_PROVEN` | 17 | comment-stripped token stream identical after removing whitespace/optional semicolons/trailing commas (`standard --fix` output) |
| `FORMAT_LAYOUT_ONLY_PROVEN` | 2 | HTML indentation/attribute wrapping only |
| `FORMAT_JSON_PLUS_R3_KEYS` | 1 | `package.json`: formatting **plus** the six legitimately added R3 scripts |

Full per-file list with add/delete counts is in the machine-generated table at the end of
this document.

### 4b. NOT proven — left untouched (55)

These contain a real content difference from HEAD. That difference is either R3 work or
legitimate pre-existing uncommitted work. Because HEAD predates both, **no automatic
reconstruction is possible** and per the task rules these were left alone.

**R3_INTENTIONAL / mixed (9)**

| file | why it differs |
|---|---|
| `main/agentRpc.js` (+2649/−548) | R3 bridge fixes: window anchoring, tab-open readiness, activation semantics, fullPage compositing + downscale, `csp_blocked` |
| `mcp/min-agent-mcp.js` (+195/−14) | R3 adapter: `fullPage`/`maxSlices` schema, fullPage metadata projection, `csp_blocked` docs |
| `js/menuRenderer.js` (+29/−1) | R3 `agentSelectTab` renderer command + `addTab` background flag |
| `js/preload/default.js` (+29/−0) | R2/D2 preload attestation (pre-existing from an earlier phase) |
| `main/filtering.js` (+6/−6) | passes `webContentsId` to the network counter (pre-existing) |
| `main/viewManager.js` (+5/−5) | view-preference annotation + R3-adjacent changes |
| `js/webviews.js` (+3/−3) | `const` + spacing in `setSelected` |
| `scripts/min-launch.js` (+10/−3) | R3 `--ignore-certificate-errors` |
| `SKILL.md` (+158/−90) | R2/R3 tool-reference updates **plus** formatter prose reflow |

**PREEXISTING_OR_MIXED — test/tooling sources (10)**

`scripts/agent-rpc-test.js` (+455/−6) · `scripts/mcp-e2e.js` (+267/−20) ·
`scripts/agent-captcha-probe.js` · `scripts/agent-downloads-probe.js` ·
`scripts/agent-mouse-probe.js` · `scripts/agent-pav-probe.js` ·
`scripts/agent-tabs-probe.js` · `scripts/agent-transform-probe.js` ·
`scripts/p110-api-matrix.js` · `scripts/p111-coldstart-accept.js`

These carry substantive earlier-phase edits (process-ownership hardening, diagnostics,
new assertions) **and** formatter changes in the same hunks. Separating them would require
reconstructing pre-task files that HEAD cannot supply.

**PREEXISTING — evidence/JSON records (13)**

`docs/agent-actions-probe.json`, `docs/agent-captcha-probe.json`,
`docs/agent-inputs-probe.json`, `docs/agent-nps-probe.json`, `docs/agent-pav-probe.json`,
`docs/agent-transform-probe.json`, `docs/agent-waits-probe.json`,
`docs/mcp-unit-summary.json`, `docs/p110-api-matrix.json`, `docs/p112-publish-set.json`,
`docs/p112-secret-scan.json`, `docs/smoke-baseline.json`, `docs/tabs-probe.json`

Each is a **re-run artefact**: same schema, different `ranAt`/`startedAt` timestamps and
result values. That is recorded evidence of tests executed during earlier phases, not
formatter output. They were left untouched — rewriting them would fabricate history.

**PREEXISTING — larger diffs (4)**

`docs/mcp-e2e-run.json` (+413/−65, gained a `failures` key) ·
`docs/p110-runs/trace-api.jsonl` (+118/−115, **not** a prettier-glob file) ·
`docs/statistics.md` · `localization/languages/ar.json` (**does not parse as JSON in
either HEAD or the working tree** — pre-existing invalid content, deliberately untouched)

**FORMAT_OR_CONTENT — mixed Markdown (19)**

`CONTRIBUTING.md`, `README.md`, `RELEASE_NOTES.md`, `docs/AUTONOMY-GAP-ANALYSIS.md`,
`docs/BASELINE.md`, `docs/EXTENSION-COMPATIBILITY.md`, `docs/MCP-STDIO-E2E.md`,
`docs/P1-05-DESIGN.md`, `docs/PHASE1-DESIGN.md`,
`docs/audit/BASELINE-addendum-P1-00A.1.md`, `.../P1-02.md`,
`.../P1-06.1-Mouse-Delivery-Fix.md`, `.../P1-06.3-Input-Channel-Decision.md`,
`.../P1-06.4-Hover-Wheel-Closure.md`, `.../P1-09-SKILL-Intelligent-Browsing.md`,
`docs/audit/HONEST-REPORT-P1-06-through-P1-07.md`, `mcp/README.md`

These contain **both** genuine content edits from earlier phases **and** formatter table
alignment/prose reflow in the same files. Example: `docs/PHASE1-DESIGN.md` gains a
formatted JSON discovery example **and** reformatted code-reference tables. Some appear
purely cosmetic in isolated hunks (e.g. `...P1-06.3` is table alignment only), but
because a sibling hunk in the same file carries prose edits, the file as a whole is not
provably format-only.

### 4c. Discrepancy found in my own R3 report

The R3 register entry (and my final message) said **"eight defects"**, but §3 of that
entry enumerates **ten** numbered items. Verified programmatically:

```
numbered items: 1,2,3,4,5,6,7,8,9,10
count: 10
prose claim: the 8 product defects the real web exposed
```

**This is a counting error in the report, not a product defect.** Items 7/8/9 are three
distinct defects in the fullPage path (schema omission → silently-unreachable feature;
compositing budget → silently-cropped image; adapter projection → discarded metadata),
and item 10 (CSP) is a fourth. The correct count is **ten**. The register is append-only
and was **not** edited; this triage records the correction instead.

---

## 5. Safe narrow reversals performed

**None.** No file, hunk or byte was written in this task.

Reason: for all 100 proven-format-only files the *only* sound reconstruction source would
be the pre-formatter working tree, which does not exist (one commit; no stash; no dangling
blobs except a single 3,995-byte untracked-looking audit blob that is not any of these
files). Reversing from HEAD would silently discard any legitimate uncommitted edit in
those files — and HEAD demonstrably predates real work in at least the 55 unproven files,
so HEAD is not a trustworthy baseline. Per the task's own safety conditions, that
uncertainty means **no reversal**.

---

## 6. Files/hunks left untouched due to uncertainty

All **55** files in §4b. The three categories that most need a human decision:

1. **The 19 mixed Markdown files** — content edits and formatter reflow are interleaved;
   only the author knows which prose changes were intended.
2. **The 17 localization `.json` files** — proven format-only *today*, but they are
   translation data; if any translation is later edited, the formatter's 290-line
   re-indent will obscure it in review.
3. **`localization/languages/ar.json`** — invalid JSON in both HEAD and the working tree.
   Pre-existing breakage; flagged, not fixed (fixing it is out of scope for this task).

---

## 7. R3 live real-web status, separated from stand-in

From `docs/realweb-accept.json` (`network.mode = LIVE`):

| bucket | result |
|---|---|
| **LIVE** assertions | **55 pass · 0 fail · 0 blocked · 1 drift** of 56 |
| **stand-in** assertions | **0** (none ran — the network was live) |
| harness/census | `harness.launch` PASS, 39-tool adapter census |

The single DRIFT is the `wheel` assertion: synthesized `mouseWheel` is dropped by the
compositor on this Electron/OS build (pre-existing limitation; `browser_scroll` delivers
separately and passes).

R3 files verified present in the working tree: `scripts/lib/realweb-harness.js`,
`scripts/realweb-accept.js`, `scripts/lib/test-impact-map.json`.

---

## 8. Discrepancy audit of the "eight defects" count

See §4c. **Report-counting error, not a product defect.** Ten distinct defects are listed
and all ten fixes are present in the working tree (verified by symbol presence:
`AGENT_RPC_FULLPAGE_MAX_SLICES`, `scaledBy`, `completeCapture`, `captureMode`,
`csp_blocked`, `agentRpcWindowForTabs`, `agentRpcLooksLikeCspBlock`). The register remains
append-only and unedited.

---

## 9. Targeted checks run

Per the task, only read-only inspection and **no repository-wide writes**. I deliberately
did **not** re-run the test suites in this task, because:

- `npm run probe:realweb` writes `docs/realweb-accept.json`;
- `npm run smoke:baseline` writes `docs/smoke-baseline.json`;
- `node scripts/mcp-e2e.js` writes `docs/mcp-e2e-run.json`;
- each probe writes its own `docs/*.json` evidence file.

Any of those would *add* to the very churn this task is auditing.

What was verified instead, read-only:

- Syntax of every R3-modified source file: `node --check` on
  `main/agentRpc.js`, `mcp/min-agent-mcp.js`, `js/menuRenderer.js`,
  `scripts/lib/realweb-harness.js`, `scripts/realweb-accept.js` → **all exit 0**.
- Last recorded live evidence: `docs/realweb-accept.json` →
  `verdict.ok: true`, 55 pass / 0 fail / 0 blocked.
- Last recorded `mcp-e2e` evidence: `failures: 0` (`docs/mcp-e2e-run.json`).
- Last recorded smoke evidence: `allPassed: true` (`docs/smoke-baseline.json`).
- `docs/agent-rpc-test.js` last evidence: `docs/mcp-unit-summary.json` present.

These are **recorded results from the last runs**, not a fresh execution; they are
labelled as such and are not claimed as a re-verification.

---

## 10. Confirmations

- **0 staged files** (`git status --porcelain` shows no `M`/`A`/`R`/`C` in column 1).
- **HEAD unchanged**: `2b8088e0838524cad5cba92d77a0680897f75429`.
- **No commit, no push, no reset, no clean, no stash.**
- **0 Electron processes** left running.
- **No broad formatter run** in this task; `npm run lint` was not executed again.
- Working tree preserved exactly as found: 155 tracked modified, 104 untracked.

---

## Appendix — full per-file classification

Generated from HEAD + working-tree comparison (read-only). `adds / deletes` are
`git diff --numstat` values, i.e. relative to HEAD, not to the pre-formatter tree.

| file | class | adds / deletes |
|---|---|---|
| `package.json` | `FORMAT_JSON_PLUS_R3_KEYS` | 7 / 1 |
| `CONTRIBUTING.md` | `NEEDS_HUNK_REVIEW` | 12 / 0 |
| `docs/agent-actions-probe.json` | `NEEDS_HUNK_REVIEW` | 6 / 6 |
| `docs/agent-captcha-probe.json` | `NEEDS_HUNK_REVIEW` | 33 / 8 |
| `docs/agent-inputs-probe.json` | `NEEDS_HUNK_REVIEW` | 15 / 15 |
| `docs/agent-nps-probe.json` | `NEEDS_HUNK_REVIEW` | 12 / 12 |
| `docs/agent-pav-probe.json` | `NEEDS_HUNK_REVIEW` | 21 / 6 |
| `docs/agent-transform-probe.json` | `NEEDS_HUNK_REVIEW` | 18 / 13 |
| `docs/agent-waits-probe.json` | `NEEDS_HUNK_REVIEW` | 24 / 24 |
| `docs/audit/BASELINE-addendum-P1-00A.1.md` | `NEEDS_HUNK_REVIEW` | 10 / 9 |
| `docs/audit/BASELINE-addendum-P1-02.md` | `NEEDS_HUNK_REVIEW` | 21 / 13 |
| `docs/audit/BASELINE-addendum-P1-06.1-Mouse-Delivery-Fix.md` | `NEEDS_HUNK_REVIEW` | 18 / 18 |
| `docs/audit/BASELINE-addendum-P1-06.3-Input-Channel-Decision.md` | `NEEDS_HUNK_REVIEW` | 41 / 41 |
| `docs/audit/BASELINE-addendum-P1-06.4-Hover-Wheel-Closure.md` | `NEEDS_HUNK_REVIEW` | 29 / 29 |
| `docs/audit/BASELINE-addendum-P1-09-SKILL-Intelligent-Browsing.md` | `NEEDS_HUNK_REVIEW` | 14 / 14 |
| `docs/audit/HONEST-REPORT-P1-06-through-P1-07.md` | `NEEDS_HUNK_REVIEW` | 42 / 15 |
| `docs/AUTONOMY-GAP-ANALYSIS.md` | `NEEDS_HUNK_REVIEW` | 11 / 9 |
| `docs/BASELINE.md` | `NEEDS_HUNK_REVIEW` | 433 / 431 |
| `docs/EXTENSION-COMPATIBILITY.md` | `NEEDS_HUNK_REVIEW` | 36 / 36 |
| `docs/mcp-e2e-run.json` | `NEEDS_HUNK_REVIEW` | 413 / 65 |
| `docs/MCP-STDIO-E2E.md` | `NEEDS_HUNK_REVIEW` | 21 / 17 |
| `docs/mcp-unit-summary.json` | `NEEDS_HUNK_REVIEW` | 202 / 17 |
| `docs/P1-05-DESIGN.md` | `NEEDS_HUNK_REVIEW` | 2 / 1 |
| `docs/p110-api-matrix.json` | `NEEDS_HUNK_REVIEW` | 28 / 28 |
| `docs/p110-runs/trace-api.jsonl` | `NEEDS_HUNK_REVIEW` | 118 / 115 |
| `docs/p112-publish-set.json` | `NEEDS_HUNK_REVIEW` | 39 / 39 |
| `docs/p112-secret-scan.json` | `NEEDS_HUNK_REVIEW` | 3 / 3 |
| `docs/PHASE1-DESIGN.md` | `NEEDS_HUNK_REVIEW` | 218 / 115 |
| `docs/smoke-baseline.json` | `NEEDS_HUNK_REVIEW` | 13 / 15 |
| `docs/statistics.md` | `NEEDS_HUNK_REVIEW` | 9 / 8 |
| `docs/tabs-probe.json` | `NEEDS_HUNK_REVIEW` | 6 / 6 |
| `js/menuRenderer.js` | `NEEDS_HUNK_REVIEW` | 29 / 1 |
| `js/preload/default.js` | `NEEDS_HUNK_REVIEW` | 29 / 0 |
| `js/webviews.js` | `NEEDS_HUNK_REVIEW` | 3 / 3 |
| `localization/languages/ar.json` | `NEEDS_HUNK_REVIEW` | 15 / 15 |
| `main/agentRpc.js` | `NEEDS_HUNK_REVIEW` | 2649 / 548 |
| `main/filtering.js` | `NEEDS_HUNK_REVIEW` | 6 / 6 |
| `main/viewManager.js` | `NEEDS_HUNK_REVIEW` | 5 / 5 |
| `mcp/min-agent-mcp.js` | `NEEDS_HUNK_REVIEW` | 195 / 14 |
| `mcp/README.md` | `NEEDS_HUNK_REVIEW` | 15 / 7 |
| `README.md` | `NEEDS_HUNK_REVIEW` | 6 / 6 |
| `RELEASE_NOTES.md` | `NEEDS_HUNK_REVIEW` | 6 / 2 |
| `scripts/agent-captcha-probe.js` | `NEEDS_HUNK_REVIEW` | 34 / 10 |
| `scripts/agent-downloads-probe.js` | `NEEDS_HUNK_REVIEW` | 33 / 16 |
| `scripts/agent-mouse-probe.js` | `NEEDS_HUNK_REVIEW` | 26 / 17 |
| `scripts/agent-pav-probe.js` | `NEEDS_HUNK_REVIEW` | 37 / 4 |
| `scripts/agent-rpc-test.js` | `NEEDS_HUNK_REVIEW` | 455 / 6 |
| `scripts/agent-tabs-probe.js` | `NEEDS_HUNK_REVIEW` | 8 / 4 |
| `scripts/agent-transform-probe.js` | `NEEDS_HUNK_REVIEW` | 18 / 0 |
| `scripts/mcp-e2e.js` | `NEEDS_HUNK_REVIEW` | 267 / 20 |
| `scripts/min-launch.js` | `NEEDS_HUNK_REVIEW` | 10 / 3 |
| `scripts/p110-api-matrix.js` | `NEEDS_HUNK_REVIEW` | 8 / 2 |
| `scripts/p111-coldstart-accept.js` | `NEEDS_HUNK_REVIEW` | 2 / 2 |
| `scripts/p112-publish-set.js` | `NEEDS_HUNK_REVIEW` | 1 / 1 |
| `scripts/p112-secret-scan.js` | `NEEDS_HUNK_REVIEW` | 1 / 1 |
| `SKILL.md` | `NEEDS_HUNK_REVIEW` | 158 / 90 |
| `css/newTabPage.css` | `FORMAT_INDENT_ONLY_PROVEN` | 33 / 33 |
| `css/passwordViewer.css` | `FORMAT_INDENT_ONLY_PROVEN` | 4 / 2 |
| `css/tabBar.css` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `css/taskOverlay.css` | `FORMAT_INDENT_ONLY_PROVEN` | 2 / 1 |
| `css/windowControls.css` | `FORMAT_INDENT_ONLY_PROVEN` | 6 / 3 |
| `docs/audit/BASELINE-addendum-P1-03.md` | `FORMAT_INDENT_ONLY_PROVEN` | 8 / 0 |
| `docs/audit/BASELINE-addendum-P1-04-Closeout.md` | `FORMAT_INDENT_ONLY_PROVEN` | 5 / 0 |
| `docs/audit/BASELINE-addendum-P1-04.md` | `FORMAT_INDENT_ONLY_PROVEN` | 16 / 9 |
| `docs/P1-04-DESIGN.md` | `FORMAT_INDENT_ONLY_PROVEN` | 10 / 1 |
| `js/navbar/bookmarkStar.js` | `FORMAT_INDENT_ONLY_PROVEN` | 16 / 16 |
| `js/preload/siteUnbreak.js` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `js/searchbar/searchSuggestionsPlugin.js` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `js/webviewMenu.js` | `FORMAT_INDENT_ONLY_PROVEN` | 0 / 1 |
| `localization/languages/be.json` | `FORMAT_INDENT_ONLY_PROVEN` | 290 / 290 |
| `localization/languages/bg.json` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `localization/languages/bn.json` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `localization/languages/de.json` | `FORMAT_INDENT_ONLY_PROVEN` | 12 / 12 |
| `localization/languages/el.json` | `FORMAT_INDENT_ONLY_PROVEN` | 293 / 294 |
| `localization/languages/en-US.json` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `localization/languages/es.json` | `FORMAT_INDENT_ONLY_PROVEN` | 8 / 8 |
| `localization/languages/fa.json` | `FORMAT_INDENT_ONLY_PROVEN` | 2 / 2 |
| `localization/languages/fr.json` | `FORMAT_INDENT_ONLY_PROVEN` | 13 / 13 |
| `localization/languages/hr.json` | `FORMAT_INDENT_ONLY_PROVEN` | 4 / 4 |
| `localization/languages/hu.json` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `localization/languages/lt.json` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `localization/languages/nl.json` | `FORMAT_INDENT_ONLY_PROVEN` | 3 / 3 |
| `localization/languages/pt-BR.json` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `localization/languages/tr.json` | `FORMAT_INDENT_ONLY_PROVEN` | 5 / 5 |
| `localization/languages/uz.json` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `localization/languages/vi.json` | `FORMAT_INDENT_ONLY_PROVEN` | 285 / 285 |
| `main/filterUpdate.js` | `FORMAT_INDENT_ONLY_PROVEN` | 55 / 55 |
| `main/prompt.js` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `pages/pdfViewer/index.html` | `FORMAT_INDENT_ONLY_PROVEN` | 5 / 8 |
| `pages/pdfViewer/viewer.css` | `FORMAT_INDENT_ONLY_PROVEN` | 4 / 3 |
| `pages/settingsDropdown.css` | `FORMAT_INDENT_ONLY_PROVEN` | 1 / 1 |
| `pages/translateService/index.html` | `FORMAT_INDENT_ONLY_PROVEN` | 5 / 7 |
| `reader/index.html` | `FORMAT_INDENT_ONLY_PROVEN` | 5 / 5 |
| `reader/readerContent.css` | `FORMAT_INDENT_ONLY_PROVEN` | 4 / 3 |
| `js/defaultKeybindings.js` | `FORMAT_ONLY_PROVEN` | 1 / 1 |
| `js/navbar/permissionRequests.js` | `FORMAT_ONLY_PROVEN` | 2 / 2 |
| `js/navbar/tabContextMenu.js` | `FORMAT_ONLY_PROVEN` | 1 / 1 |
| `js/places/placesService.html` | `FORMAT_ONLY_PROVEN` | 13 / 14 |
| `js/places/tagIndex.js` | `FORMAT_ONLY_PROVEN` | 25 / 25 |
| `js/searchbar/customBangs.js` | `FORMAT_ONLY_PROVEN` | 2 / 2 |
| `js/sessionRestore.js` | `FORMAT_ONLY_PROVEN` | 7 / 7 |
| `js/statistics.js` | `FORMAT_ONLY_PROVEN` | 1 / 1 |
| `js/tabState/windowSync.js` | `FORMAT_ONLY_PROVEN` | 13 / 13 |
| `js/taskOverlay/taskOverlayBuilder.js` | `FORMAT_ONLY_PROVEN` | 2 / 2 |
| `js/util/autocomplete.js` | `FORMAT_ONLY_PROVEN` | 2 / 2 |
| `js/webviewGestures.js` | `FORMAT_ONLY_PROVEN` | 8 / 8 |
| `main/menu.js` | `FORMAT_ONLY_PROVEN` | 5 / 5 |
| `main/minInternalProtocol.js` | `FORMAT_ONLY_PROVEN` | 1 / 1 |
| `main/permissionManager.js` | `FORMAT_ONLY_PROVEN` | 4 / 4 |
| `main/remoteActions.js` | `FORMAT_ONLY_PROVEN` | 3 / 3 |
| `main/windowManagement.js` | `FORMAT_ONLY_PROVEN` | 4 / 4 |
| `docs/audit/BASELINE-addendum-P1-01B.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 27 / 19 |
| `docs/audit/BASELINE-addendum-P1-01C.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 21 / 20 |
| `docs/audit/BASELINE-addendum-P1-04.2-Navigation-Hotfix.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 27 / 27 |
| `docs/audit/BASELINE-addendum-P1-04.3-Final-Live-Validation.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 28 / 25 |
| `docs/audit/BASELINE-addendum-P1-05-Agent-Downloads.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 27 / 27 |
| `docs/audit/BASELINE-addendum-P1-06-Mouse-Vision.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 22 / 21 |
| `docs/audit/BASELINE-addendum-P1-06.2-Production-Input-Pipeline.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 29 / 28 |
| `docs/audit/BASELINE-addendum-P1-07-Adblocker-Audit-Updates.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 33 / 32 |
| `docs/audit/BASELINE-addendum-P1-08-Extension-Compatibility.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 31 / 29 |
| `docs/audit/BASELINE-addendum-P1-08.1-Real-Extension-Compatibility.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 28 / 28 |
| `docs/audit/BASELINE-addendum-P1-09.1-SKILL-Accuracy-Build-Closeout.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 46 / 45 |
| `docs/audit/BASELINE-addendum-P1-10-Intelligent-Workflows.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 40 / 40 |
| `docs/audit/BASELINE-addendum-P1-11-Windows-Packaging.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 48 / 46 |
| `docs/audit/BASELINE-addendum-P1-11.1-Identity-Coexistence.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 30 / 30 |
| `docs/audit/P1-12-GITHUB-PUBLISH-PREFLIGHT.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 12 / 5 |
| `docs/audit/REPOSITORY-CLEANUP-P1.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 40 / 40 |
| `docs/PERFORMANCE-BASELINE.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 35 / 33 |
| `docs/REAL-SITE-REPORT.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 17 / 13 |
| `docs/REAL-WORLD-COMPATIBILITY.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 34 / 34 |
| `docs/RESTRICTION-AUDIT.md` | `FORMAT_TABLE_LAYOUT_ONLY_PROVEN` | 68 / 68 |
| `docs/agent-rpc-probe.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 2 / 9 |
| `docs/agent-snapshot-probe.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/autonomy-workflows.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 4 / 11 |
| `docs/capture-page-probe.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/detach-probe.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/extension-probe.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 3 / 7 |
| `docs/live-downloads-validation.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/live-mouse-vision-validation.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/live-transform-lifecycle.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/live-transform-validation.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/p111-coldstart-accept.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/p1111-coexistence.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/performance-baseline-measurements.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 3 / 17 |
| `docs/real-site-checkpoint-P1-01C.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 2 / 4 |
| `docs/real-world-compat-data.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/transform-perf.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `docs/two-url-argv-probe.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `extensions/test-min-agent-docstart/manifest.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 5 / 1 |
| `scripts/p1-07-baseline-perf.json` | `FORMAT_JSON_LAYOUT_ONLY_PROVEN` | 1 / 1 |
| `css/passwordCapture.css` | `FORMAT_CSS_SEMICOLON_ONLY_PROVEN` | 1 / 1 |
| `css/searchbar.css` | `FORMAT_CSS_SEMICOLON_ONLY_PROVEN` | 2 / 2 |
| `reader/readerUI.css` | `FORMAT_CSS_SEMICOLON_ONLY_PROVEN` | 1 / 1 |
| `index.html` | `FORMAT_LAYOUT_ONLY_PROVEN` | 30 / 25 |
| `pages/settings/index.html` | `FORMAT_LAYOUT_ONLY_PROVEN` | 31 / 14 |
