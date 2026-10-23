# Integrated Target Architecture — Min Agent Edition

**Phase D. Design and roadmap only. No application, test, configuration, or packaging code was created, altered, or removed in this phase.**

Prepared: 2026-10-19 · Repository `aksunknown1/min-agent-edition` · Branch `main` · HEAD `2b8088e0838524cad5cba92d77a0680897f75429` · all work local and uncommitted.

Authoritative planning ledger: `docs/audit/Min-Agent-Edition-Master-Scope-Register.md` (verified to exist at this exact path; §8 required confirmation and this is it).
Evidence inputs read in full for this document: `docs/audit/BROWSER-HARNESS-FEATURE-PARITY.md`, `docs/audit/CLOAKBROWSER-PHASE-C-INVESTIGATION.md`, `docs/audit/P1-15-AGENT-NATIVE-CAPABILITIES.md`, `docs/audit/VPS-PROBE-RECONCILIATION-P1.md`, `docs/QA-ARCHITECTURE.md`, plus direct source inspection of `main/agentRpc.js`, `mcp/min-agent-mcp.js`, `scripts/min-launch.js`, `scripts/lib/proctools.js`, `scripts/proctools-test.js`, `scripts/agent-eval-probe.js`, `main/viewManager.js`, `main/main.js`, `main/filtering.js`, `main/download.js`, `main/permissionManager.js`, `main/prompt.js`, `main/minInternalProtocol.js`, `js/webviews.js`, `js/preload/default.js`, `scripts/buildMain.js`, `scripts/buildPreload.js`, `package.json`, and `SKILL.md`.

**Evidence vocabulary used throughout this document:**

| Marker           | Meaning                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[SOURCE]**     | Verified by direct inspection of the repository source in this phase, with `file:line` citation.                                                        |
| **[REPORT]**     | Derived from a prior phase report or audit document; not independently re-executed here.                                                                |
| **[PROPOSAL]**   | An architecture decision or design made in this phase. Nothing is implemented.                                                                          |
| **[UNVERIFIED]** | Could not be established from the current tree or environment. Must not be upgraded without evidence.                                                   |
| **[FINDING]**    | A source-inspection observation produced during this phase. Not reproduced by an executed test. Requires confirmation before being treated as a defect. |

**Status vocabulary (from the Master Scope Register §6, unchanged):** Verified complete · Partial · Implemented, not adequately verified · Missing · Not applicable · Unverified · Deferred.

---

## 0. Phase D reconciliation of current project state

### 0.1 Repository inventory observed (read-only)

| Item                                       | Observed value                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| HEAD                                       | `2b8088e0838524cad5cba92d77a0680897f75429` — single commit, `Initial Min Agent Edition source import` |
| Branch                                     | `main`                                                                                                |
| Remote                                     | `https://github.com/aksunknown1/min-agent-edition.git` (fetch + push)                                 |
| Stashes                                    | none                                                                                                  |
| Unpushed commits                           | none (HEAD equals origin's base per prior reports)                                                    |
| Working-tree entries                       | **67** — **32 modified, 35 untracked, 0 staged**                                                      |
| Tracked diff                               | 32 files, **+1189 / −533**                                                                            |
| Dominant change                            | `main/agentRpc.js` **+671/−** (the P1-15 body)                                                        |
| `node_modules`                             | present                                                                                               |
| Node                                       | v24.19.0                                                                                              |
| Electron                                   | 43.4.1 (`package.json` devDependency, confirmed in `node_modules/electron/package.json`)              |
| Chromium (reported)                        | 150.0.7871.224 (Phase C, from `browser_status`)                                                       |
| Live Electron processes at inspection time | **0**                                                                                                 |
| Audit register path                        | `docs/audit/Min-Agent-Edition-Master-Scope-Register.md` — confirmed                                   |

### 0.2 Discrepancies against prior reports

| #   | Prior claim                                                                        | Actual                                                                                                                                                                                        | Classification                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Phase C: "62 local entries" (handoff §3 and §8)                                    | **67** (32 modified, 35 untracked)                                                                                                                                                            | **[FINDING]** Report drift. The handoff itself instructed a fresh `git status`. Cause: the Phase C snapshot was taken before the final P1-15 probe/helper scripts and audit docs landed. **Baseline for this phase is 67.** |
| 2   | P1-15: "`probe:eval` 22/22" (P1-15 report §Final validation)                       | `scripts/agent-eval-probe.js` exists (22-check probe, real bridge path) but **`package.json` has no `probe:eval` script**                                                                     | **[FINDING]** Test-discoverability / reproducibility gap. See §0.3.                                                                                                                                                         |
| 3   | P1-15: "Working tree: ~59 local changes"                                           | 67                                                                                                                                                                                            | Same drift class as #1.                                                                                                                                                                                                     |
| 4   | Phase B: "approximately 50 relevant feature rows"                                  | Counting the actual `ID` column of `BROWSER-HARNESS-FEATURE-PARITY.md` §2 gives **61 rows** (A1–A7, B1–B8, C1–C11, D1–D4, E1–E4, F1, G1–G3, H1–H3, I1–I3, J1–J3, K1–K4, L1–L5, M1-row–M5-row) | **[FINDING]** Undercount in the Phase B summary. The matrix body is authoritative; **61 rows is the correct denominator** for Phase D coverage accounting.                                                                  |
| 5   | Phase C: packaged artifacts "pre-date P1-15"                                       | Confirmed: `dist/app/*.exe` written 2026-10-19 10:34–10:38; `main/agentRpc.js` last modified 12:05; `mcp/min-agent-mcp.js` 11:57                                                              | **[SOURCE]** Confirmed. Those installers do **not** contain `browser_eval`, `browser_viewport`, the screenshot ladder, batch semantics, or the CAPTCHA correction. Never cite them as evidence of current behaviour.        |
| 6   | Handoff §4.2: broad `taskkill /F /IM electron.exe /T` removed                      | Confirmed. Every one of the ~40 `taskkill` call sites in `scripts/` is `/PID`-targeted; the string `/IM` does not appear in any probe                                                         | **[SOURCE]** Confirmed.                                                                                                                                                                                                     |
| 7   | Handoff §8: "current tool census reported 33"                                      | 33 distinct `browser_*` names in `mcp/min-agent-mcp.js`; `AGENT_RPC_METHODS` (`main/agentRpc.js:36`) holds 33 entries; dispatcher has 33 branches (`main/agentRpc.js:843-944`)                | **[SOURCE]** Confirmed 33, registry and dispatcher in sync.                                                                                                                                                                 |
| 8   | Handoff §7: `darkMode: 1` ⇒ `nativeTheme.themeSource = 'dark'` (older VPS version) | Not re-verified against current source in this phase                                                                                                                                          | **[UNVERIFIED]** Must not be treated as current product contract. Scheduled for D1 verification (§5, §7 V-1).                                                                                                               |

### 0.3 Addendum item 1 — `probe:eval` discoverability gap

`package.json` currently declares `probe:agent-rpc`, `probe:capture`, `probe:two-url-argv`, `probe:detach`, `probe:agent-snapshot`, `probe:agent-actions`, `probe:nps`, `probe:tabs`, `probe:inputs`, `probe:waits`, `probe:captcha`, `probe:pav`, `probe:downloads`, `probe:mouse`, `probe:transform`. There is **no `probe:eval`**.

The P1-15 report's `probe:eval 22/22` was therefore produced by invoking `node scripts/agent-eval-probe.js` directly, not through the documented npm surface. Both statements can be true at once: the probe likely passed _and_ the result is not reproducible through the standard entry point.

**Classification: Partial — test discoverability gap, not evidence that the 22/22 result is false.** Until a controlled run reproduces it, the P1-15 eval result stays **[REPORT]**, not **[SOURCE]**.

**Scheduled:** D1 item **D1-T1** — add `probe:eval` to `package.json`, then execute it once and record the observed count. Do not edit `package.json` in Phase D.

### 0.4 Addendum item 2 — stray artifacts: review, do not delete

Nothing was deleted, moved, or modified. Classification below is advisory input to D8.

| File                                                                                                                                                                                                                           | Size                  | Purpose (evidence)                                                                                                                                                                                                                                                                                                                                                                  | References                                                                                                 | Recommendation                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/mcp-e2e.js.patched`                                                                                                                                                                                                   | 32 B                  | Entire content is the literal text `patched 2026-10-19T06:30:07.639Z` **[SOURCE]**. A sentinel/marker written to confirm a patch step ran, not a program — no `require`, no shebang, no code.                                                                                                                                                                                       | 0 across the repo **[SOURCE]**                                                                             | **Disposable generated artifact.** Candidate for deletion or `.gitignore`. No evidence value beyond a timestamp.                                                                                                                                                                                                                 |
| `scripts/tmp-m4-grep.js`                                                                                                                                                                                                       | 370 B                 | A one-off developer grep helper that prints matching lines from `main/agentRpc.js` for P1-15 M4 anchors (`pre, true,`, `pre.redacted`, `var pre = {`, `mode === "locate"`) **[SOURCE]**. Scratch tool.                                                                                                                                                                              | 0 across the repo **[SOURCE]**                                                                             | **Disposable.** Its findings are already embodied in the applied M4 change.                                                                                                                                                                                                                                                      |
| `scripts/p112-fix-scanners.js`                                                                                                                                                                                                 | 1,084 B               | One-shot source patcher: rewrites two exact strings in `scripts/p112-publish-set.js` and `scripts/p112-secret-scan.js` to exclude `/.git/` from the publish-set walker **[SOURCE]**. Its effect is already present in both scanners.                                                                                                                                                | 2 — `docs/audit/FINAL-PRECOMMIT-REVIEW.md:8`, `docs/audit/REPO-HYGIENE-QA-ARCHITECTURE.md:51` **[SOURCE]** | **Provenance record, not scratch.** Referenced by two audit documents. Keep, or reclassify into `docs/audit/artifacts/` with a pointer. Do **not** silently drop an audit-cited file.                                                                                                                                            |
| `scripts/p115-m1-bridge.js`, `p115-m1-eval-impl.js`, `p115-m2-e2e-consolidated.js`, `p115-m2-e2e-extension.js`, `p115-m2-e2e-fixture.js`, `p115-m3-screenshot-handler.js`, `p115-m3-screenshot-patch.js`, `p115-m4-dl-race.js` | 1.4–10.8 KB           | Anchored, idempotent **patch-application scripts** whose headers state they inject the P1-15 eval/viewport, mcp-e2e acceptance block, screenshot ladder and download-race code into tracked files **[SOURCE]**. Several are required by another (`p115-m1-eval-impl.js` referenced at `p115-m1-bridge.js:43`; `p115-m3-screenshot-handler.js` at `p115-m3-screenshot-patch.js:26`). | internal only **[SOURCE]**                                                                                 | **Provenance records for the current uncommitted diff.** They are the only explanation of _how_ the P1-15 body was produced. Keep until the P1-15 work is committed. Then archive under `docs/audit/artifacts/` or delete with a register note.                                                                                  |
| `docs/p110-runs/api-s1-v1-1792383599173.png`, `api-s1-v1-1792383602603.png`, `api-s1-v2-1792383600887.png` (untracked)                                                                                                         | 57 KB / 57 KB / 53 KB | Latest `scripts/p110-api-matrix.js` run artifacts                                                                                                                                                                                                                                                                                                                                   | —                                                                                                          | **Generated, volatile.** See below.                                                                                                                                                                                                                                                                                              |
| `docs/p110-runs/` — 20 PNGs total, of which **17 are already tracked** and 3 untracked                                                                                                                                         | 53–738 KB             | Fixture screenshots regenerated on every matrix/probe run                                                                                                                                                                                                                                                                                                                           | —                                                                                                          | **MD5 grouping [SOURCE]: 12 files are byte-identical (57,341 B), 7 are byte-identical (53,516 B), 1 is unique (738 KB).** So 19 of 20 files encode only **two distinct images**. This confirms and quantifies the pre-existing `docs/p110-runs` de-duplication recommendation in `docs/audit/VPS-PROBE-RECONCILIATION-P1.md:52`. |

**D8 recommendation (not executed here):** decide one policy for generated evidence — either keep a curated set and `.gitignore` the volatile raws, or accept the duplication knowingly. Do not delete anything as a Phase D action.

### 0.5 Addendum item 4 — stale installers

Carried as a first-class **release blocker**, not a cleanup item. `dist/app` (x64 / ia32 / arm64 installers plus three `win-*-unpacked` trees) reflects source state as of ~10:35–10:38 on 2026-10-19 and **predates every P1-15 source edit** (`main/agentRpc.js` 12:05, `mcp/min-agent-mcp.js` 11:57). Rebuild + packaged runtime validation is **D8**, gated on D7. No claim about packaged behaviour may cite these artifacts.

---

## 1. Executive architecture decision record

### 1.1 Product boundary

Min Agent Edition is an **agent-native browser**: the browser _is_ the agent's execution environment. It is not a wrapper around someone else's browser and not a headless automation library. The agent drives a real, user-visible, persistent Chromium through a narrow, authenticated, loopback-only, typed RPC bridge.

### 1.2 Decisions taken in this phase

| ADR        | Decision                                                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                                            | Source basis                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-01** | **Keep the Min Electron app as the only local browser stack.** No second browser, no CDP attachment to external Chrome.                                                                                                                                                                            | Min owns its own `webContents` lifecycle, download ownership, filtering slot, and window composition. An external-Chrome design would forfeit all of it.                                                             | **[SOURCE]** tab creation `main/viewManager.js:32-53`; download hook `main/download.js:22`; single `onBeforeRequest` at `main/filtering.js:293`. **[REPORT]** Phase B A1/A2/A3 already classified these Not applicable.       |
| **ADR-02** | **No raw CDP / no generic event drain.** Typed tools only.                                                                                                                                                                                                                                         | Raw CDP is an unbounded channel into the renderer and defeats every grant, scheme, and path control. This is a deliberate, documented refusal, not a gap.                                                            | **[REPORT]** Phase B B6/E4. **[SOURCE]** the bridge registers zero `webRequest.onBeforeRequest` and uses no `webContents.debugger`; page access is exclusively `executeJavaScript` (22 sites) + `sendInputEvent`.             |
| **ADR-03** | **The three-stage truthfulness contract — `dispatched` → `delivered` → `verified` — is the spine of the tool API.** Every mutating tool must report all three, never conflate them.                                                                                                                | This is the single most load-bearing product truth in the project. `verification:'none'` currently returns `dispatched:true, verified:false` with no delivery stage at all.                                          | **[SOURCE]** `main/agentRpc.js:3755-3763` (click) and `:4791-4800` (press) short-circuit path; honesty note at `:3132-3136`.                                                                                                  |
| **ADR-04** | **One canonical installed app; many isolated profiles.** Per-agent profile directories are mandatory; sharing one profile between concurrent agents is unsafe by default and opt-in only.                                                                                                          | Tabs, settings, cookies and `persist:webcontent` partition state are shared inside a profile; two agents driving the same window produce cross-talk and ref confusion.                                               | **[SOURCE]** partition default `persist:webcontent` (`js/webviews.js:201`), private tabs per-tab partition (`:193-194`), discovery file is per-`userDataPath` (`main/agentRpc.js:5214`). **[REPORT]** handoff §7 VPS finding. |
| **ADR-05** | **Loopback + ephemeral port + per-launch token + discovery file is the correct transport. Keep it.**                                                                                                                                                                                               | Ephemeral port removes port-scan targeting; a 32-byte random token re-read on every call removes stale-token races; `0600` + NTFS advisory is stated honestly.                                                       | **[SOURCE]** `listen(0, '127.0.0.1')` `main/agentRpc.js:5278`; token `:5256`; `timingSafeEqual` `:325-337`; discovery `:5213-5232`; re-read per call `mcp/min-agent-mcp.js:11-12`, `:545`.                                    |
| **ADR-06** | **Add an engine-upgrade cadence as a first-class product concern (D6).** No native Chromium patch set now; revisit only against a reproducible requirement with a cost case.                                                                                                                       | Phase C proved the CloakBrowser patches are not publicly available and their binary license forbids bundling.                                                                                                        | **[REPORT]** Phase C §2, §3, §6.                                                                                                                                                                                              |
| **ADR-07** | **Novellive is a named compatibility acceptance case, not a CAPTCHA feature.** The target architecture gains _diagnostics_, never evasion.                                                                                                                                                         | The Phase C root cause is an unproven engine-version hypothesis. Building stealth first would be building the wrong thing.                                                                                           | **[REPORT]** Phase C §5 hypotheses H1–H6, only H1 at HIGH.                                                                                                                                                                    |
| **ADR-08** | **External/cloud services stay outside the core.** Optional integrations must be a separate module with explicit licensing, privacy, cost, and failure semantics.                                                                                                                                  | Keeps the browser core auditable and dependency-light; mirrors the boundary Browser Harness itself draws.                                                                                                            | **[REPORT]** Phase B §4 external-provider rows; Phase C §3 licence gate.                                                                                                                                                      |
| **ADR-09** | **Agent-extensibility (helpers, domain skills) is D3 and gated behind a security design, not shipped with `browser_eval`.**                                                                                                                                                                        | `browser_eval` is documented as _authorized agent automation, not a sandbox_ (`mcp/min-agent-mcp.js:435`). Adding persistent helper code before the workspace has resource limits and a trust story multiplies risk. | **[SOURCE]** `mcp/min-agent-mcp.js:435`; **[REPORT]** Phase B B7/I1/B+3.                                                                                                                                                      |
| **ADR-10** | **Observability defaults OFF and is per-session opt-in, with redaction before persistence.**                                                                                                                                                                                                       | Screenshots and traces contain page content. Consent must precede capture, not follow it.                                                                                                                            | **[REPORT]** Phase B H2/H3; register §5.                                                                                                                                                                                      |
| **ADR-11** | **Split the monolith before adding features.** `main/agentRpc.js` is 5,319 lines with a 33-branch flat dispatcher, a 639-line inlined page function, duplicated attach logic, and intermingled subsystem state. New work must land in modules, not extend the chain.                               | Adding ~15 new tools (D1–D4) into this structure will make the security review of each one materially worse.                                                                                                         | **[SOURCE]** `main/agentRpc.js` structure — see §2.2 "seams".                                                                                                                                                                 |
| **ADR-12** | **The `agentRpc.js` header comment is materially false and must be corrected** (`agentRpc.js:1-8` still says snapshot/click/type/press/screenshot are "Deliberately NOT implemented", "no executeJavaScript", "no navigation"). Documentation that contradicts source is a security-review hazard. | Found during Phase D source inspection. Fix is a comment change — scheduled for D1, not done here.                                                                                                                   | **[SOURCE]** header `:1-8` vs 22 `executeJavaScript` sites and `agentRpcCommandNavigate` `:4209`.                                                                                                                             |

### 1.2.1 ADR-11 execution record (appended 2026-10-19 — evidence, not a new decision)

**Seam 1 extracted:
egistry-as-data (the dispatch routing table).**

|                                                                                                                                             |                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boundary                                                                                                                                    | ADR-11 §1.2 item 1 and §2.2 L1 registry.js — "method table (data, not an if-chain)"                                                                                                                                                |
| Change                                                                                                                                      | the 35-branch `if (method === 'x') return agentRpcCommandY(params)` chain inside gentRpcDispatch became a 35-row AGENT_RPC_DISPATCH_TABLE plus a 4-line lookup                                                                     |
| Location                                                                                                                                    | same file (main/agentRpc.js). No new module file: the bridge is concatenated into one bundle scope, so a separate file would require a build-order change and would break the established "no                                      |
| equire() between main/\* modules" rule. The seam is real (data instead of control flow) even though the file count did not change.          |
| Not moved                                                                                                                                   | authorization, validation order, grants, batch exclusion, error shapes, timeouts, page code, fs — all remain in their original positions. gentRpcDispatch is only reached AFTER the transport validator accepts a request.         |
| Equivalence evidence                                                                                                                        | pre/post **prefix byte-identical**, **suffix byte-identical**, all **35 (method → handler, arg) mappings identical**, same key set. Automated in the RPC suite.                                                                    |
| Regression caught during extraction                                                                                                         | a bare table lookup routed 'constructor'/'toString' to Object.prototype members instead of returning                                                                                                                               |
| ull (the if-chain compared strings and was immune). Fixed with an own-property check; the characterization test that found it is permanent. |
| Characterization tests                                                                                                                      | gent-rpc-test.js layer 4 (D4/ADR-11:\*), written **before** the move: registry uniqueness, unknown→null, prototype-name→null, every registered method routed, table keys == registry, params forwarded with preserved error shape. |

**Why the earlier attempt was recorded as blocked, corrected.** The D2 report described the blocker as "string surgery over 16 duplicated page-function source builders". On re-inspection that diagnosis was accurate for _that_ seam but irrelevant to ADR-11's approved order: the page-fn builder is not seam 1. The registry seam is a uniform 35-branch chain and transforms mechanically. **The real blocker was that the first attempt targeted the wrong seam**, not that modularization is infeasible.

**Seam 2 (errors.js) and seam 3 (policy.js) remain unstarted and are explicitly deferred** — see the register's D3-readiness block. This record does not claim general modularization or security improvement.

---

### 1.2.2 ADR-09 helper-sandbox design gate (appended 2026-10-19 — design only)

**Full design: [docs/audit/ADR-09-HELPER-SANDBOX.md](./ADR-09-HELPER-SANDBOX.md). Status: PROPOSED, not approved, nothing implemented.**

Architecture-D3 (rows B7/B8/I1/I2) is gated on this. Summary of the decision:

- **Option A (declarative helpers over the existing typed-tool allowlist) is recommended**, shipped _after_ Option C (curated built-ins only). A helper is data — an ordered list of existing tool calls — so **it can do nothing the agent could not already do**, and rowser_grant, nested batch and rowser_health stay excluded.
- **Option B (executable JS in an isolated runtime + capability broker) is explicitly NOT approved here**; it needs its own ADR, a supervised process and the §6 gates passing for a second runtime.
- rowser*eval is **rejected** as a host-side helper runtime: it is a \_page*-world boundary, not a host one.
- No arbitrary dependency installs; per-profile storage; content-addressed versions; no network/filesystem/shell capability.

#### Milestone naming correction (prevents a repeat of the prompt-D3 vs architecture-D3 mix-up)

"**prompt D3**" (D3-A…G) and "**architecture D3**" are different. The authoritative crosswalk — prompt label → stable parity ID → real owner → status → evidence — lives in ADR-09-HELPER-SANDBOX.md §1. In brief:

| prompt label                      | parity ID      | real owner                                                      |
| --------------------------------- | -------------- | --------------------------------------------------------------- |
| D3-A keyboard typing              | C2 (+C3)       | parity milestone — **verified complete** (probe:keyboard 21/21) |
| D3-B upload                       | C6             | parity milestone, blocked on **OD-3**                           |
| D3-C full-page capture            | D1             | parity milestone                                                |
| D3-D debug overlay                | D3             | **D4**                                                          |
| D3-E AX-tree option               | B4             | parity milestone                                                |
| D3-F frames                       | C8             | parity milestone                                                |
| D3-G Layer C stale-ref/transforms | —              | **D7 / test strategy**                                          |
| _(architecture-D3)_               | B7, B8, I1, I2 | blocked on this ADR                                             |

#### Dependency graph for ADR-09 / architecture-D3

| Item                                                                                                                                                               | Relationship to ADR-09                                                                                                                              | Evidence                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **ADR-09 approval (this doc)**                                                                                                                                     | **Hard prerequisite** for any helper implementation                                                                                                 | architecture §1.2 ADR-09; register D3-readiness                                                                  |
| ADR-11 seam 1 (registry-as-data)                                                                                                                                   | **Done**; not a prerequisite                                                                                                                        | 35-row table + own-property lookup; 227/227                                                                      |
| **ADR-11 seam 2 (errors.js)**                                                                                                                                      | **Not a hard prerequisite** for Option A. Becomes a _quality_ prerequisite for Option B (a second runtime needs a stable, complete error taxonomy). | AGENT_RPC_ERRORS L292 and the status map L416 already exist and are complete (D1-F7 test enforces total mapping) |
| **ADR-11 seam 3 (policy.js)**                                                                                                                                      | **Subfeature prerequisite**: a helper that declares                                                                                                 |
| equires needs the policy evaluator to be addressable as a unit. Option A can call the existing gentRpcReadPolicy (L515) directly, so it is **not** a hard blocker. | gentRpcReadPolicy L515, gentRpcEffectiveProtocols L539, risky-name L451                                                                             |
| **D2 dialog observation (partial)**                                                                                                                                | Independent                                                                                                                                         | observed:false at L4496; blocked by hover intermittency                                                          |
| **D2 delivery attestation for type/scroll**                                                                                                                        | Independent (inherently unsupported)                                                                                                                | mcp-e2e 93/93                                                                                                    |
| **D2 wheel unverified**                                                                                                                                            | Independent                                                                                                                                         | probe:mouse 27–29/29 [FLAKY]                                                                                     |
| **D4 trace/redaction**                                                                                                                                             | **Subfeature prerequisite** for helper artifacts + audit (§5 audit row)                                                                             | architecture D4                                                                                                  |
| **D5 profile resolution**                                                                                                                                          | **Subfeature prerequisite** for per-profile helper storage paths                                                                                    | architecture §4.4                                                                                                |
| **OD-3 (upload executor)**                                                                                                                                         | Independent of ADR-09; blocks C6 only                                                                                                               | register OD-3                                                                                                    |
| **ADR-02 (no raw CDP)**                                                                                                                                            | **Hard constraint** carried into ADR-09                                                                                                             | architecture §1.2                                                                                                |
| **D7 black-box harness**                                                                                                                                           | Not a prerequisite; will be the gate for Option B                                                                                                   | architecture D7                                                                                                  |

**Unresolved (requires inspection before Option B only):** whether
ode:worker*threads in Electron's main process gives a usable hard boundary for an untrusted isolate on Windows. \_Not inspected — Option B is not approved, so this is deliberately deferred.*

#### Sequence

1. **ADR-09 design approval** — this document. Nothing else in architecture-D3 moves first.
2. **Option C** (curated built-in skills, read-only) may ship with **no** new privilege.
3. **Option A** (declarative helpers) requires: D5 profile paths, the §6 gates G1–G9 green, and a reviewed save/version UX.
4. **Option B** (executable helpers) requires its own ADR + D7 harness + the worker-isolate question resolved.
5. **Any helper gaining filesystem / network / external-tool / privileged-browser capability** requires a further, separate ADR. None is proposed.

---

### 1.3 Non-decisions deliberately left open

Chromium fork / native patch set (deferred to D6 with an evidence bar); signed installers and SmartScreen (D8); cross-platform support expansion (D8); whether any external provider is ever integrated (open-decision **OD-7**).

---

## 2. Component and trust-boundary architecture

### 2.1 Current-state component diagram (as built, `[SOURCE]`)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ main process (Node)                                                              │
│                                                                                  │
│  main.build.js  = string-concatenation of 23 files (scripts/buildMain.js:6-30)   │
│  agentRpc.js is concatenated LAST — one global scope, no require() between files │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ TRUST BOUNDARY 1 — privileged host                                       │  │
│  │  app, fs, path, session, permission handlers, dialog, shell, extensions   │  │
│  │                                                                            │  │
│  │  main/main.js        window lifecycle, BaseWindow, chrome view             │  │
│  │  main/viewManager.js WebContentsView (TAB) + attach/setView composition   │  │
│  │  main/filtering.js   single onBeforeRequest  <-- AD BLOCK OWNS THIS SLOT  │  │
│  │  main/download.js    will-download -> agentRpcDownloadManagedHook hook     │  │
│  │  main/permissionManager.js  permission request/check handlers              │  │
│  │  main/prompt.js      HTTP-basic-auth modal (nodeIntegration:false)         │  │
│  │  main/extensionHost.js, UASwitcher.js, themeMain.js, keychainService.js    │  │
│  │                                                                            │  │
│  │  main/agentRpc.js  <-- 5,319 lines. AGENT_RPC_METHODS:36. flat dispatcher  │  │
│  │      :843-944. 33 subsystems inline.                                      │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                             │
│   TR-2 loopback HTTP      ┌────────┴─────────────────────────┐                   │
│   POST /rpc               │  127.0.0.1:0 (ephemeral)         │                   │
│   Host allowlist :350     │  Bearer <32-byte hex>            │                   │
│   no Origin/Sec-Fetch-Site│  rate 40 rps, 10 fails → 15s CD  │                   │
│   body ≤ 64 KiB           │  discovery: <userData>/          │                   │
│                           │    agent-rpc.json  (mode 0600)   │                   │
│                           └────────┬─────────────────────────┘                   │
└────────────────────────────────────┼─────────────────────────────────────────────┘
                                     │
                     ┌───────────────┴────────────────┐
                     │ TRUST BOUNDARY 3 — the agent   │
                     │ (untrusted-by-default client)  │
                     ▼                                ▼
        ┌────────────────────────────┐   ┌──────────────────────────────┐
        │ mcp/min-agent-mcp.js       │   │ any other loopback client    │
        │ 710 lines, 33 tool schemas │   │ (curl, script, second agent)  │
        │ TOOLS :45-507              │   │ must present the token       │
        │ stdio MCP 2024-11-05 /     │   │ → full peer authority         │
        │   2025-03-26 / 2025-06-18  │   │                              │
        │ no retry, 1 attempt/call   │   └──────────────────────────────┘
        └─────────────┬──────────────┘
                      │ stdio JSON-RPC (newline-framed) :680-699
                      ▼
        ┌───────────────────────────────────────────────────────────┐
        │ MCP client: OpenCode 1.19.2, Claude Code, Cursor, ...      │
        │ *** OpenCode default MCP request timeout = 5000 ms ***     │
        └───────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│ TRUST BOUNDARY 2 — renderer / page                                                  │
│                                                                                     │
│  chrome/UI view   main/main.js:214-229   nodeIntegration TRUE, contextIsolation FALSE│
│                    (trusted app UI; will-navigate locked to min://app/index.html    │
│                     :340-344 precisely so remote pages never get node access)        │
│                                                                                     │
│  TAB view         main/viewManager.js:9-30                                          │
│                    nodeIntegration false · nodeIntegrationInSubFrames true           │
│                    contextIsolation TRUE · sandbox TRUE · enableRemoteModule false   │
│                    allowPopups false · enableWebSQL false · minimumFontSize 6        │
│                    safeDialogs TRUE ("Prevent this page from creating more dialogs") │
│                    preload dist/preload.js                                           │
│                    partition persist:webcontent (or per-tab for private)            │
│                                                                                     │
│  ┌───────────────────────────────────────────────────────────────────────────┐       │
│  │ UNTRUSTED PAGE WORLD — main world, reached by webContents.executeJavaScript │       │
│  │   AGENT_SNAPSHOT_PAGE_FN  :966-1604  (639 lines, 12 modes, inlined)         │       │
│  │   AGENT_EVAL_PAGE_FN      :3140-3206 (new Function + bounded serializer)   │       │
│  │   NO contextBridge.exposeInMainWorld anywhere in js/preload/default.js     │       │
│  └───────────────────────────────────────────────────────────────────────────┘       │
│                                                                                     │
│  Input ingress: webContents.sendInputEvent (mouse/key) + insertText                  │
│  No preload bridge → renderer CANNOT acknowledge receipt of a trusted event today  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Target-state component diagram (ADR-11 modularisation)

```
┌─ L0 HOST (unchanged, trusted) ──────────────────────────────────────────────────┐
│  Min Electron main process — window, session, permissions, filtering, downloads  │
└──────────────────────────────────────────────────────────────────────────────────┘
        │  calls only through a narrow internal façade
┌─ L1 BRIDGE CORE (main/agent/rpc/) — new modules, replaces the flat chain ──────┐
│  transport.js   loopback, auth, rate, body cap, discovery file                 │
│  registry.js    method table (data, not an if-chain) → agentRpc.js:36 source   │
│  errors.js      code table + HTTP status map (closes FINDING D7)               │
│  policy.js      grants, risky/sensitive policy, policy.json (agentRpc.js:469)  │
│  validate.js    param schemas (agentRpc.js:42-237)                             │
│  observability/ trace writer (opt-in), redaction, retention                   │
└───────────────────────────────────────────────────────────────────────────────┘
        │                        │                          │
┌─ L2a ACTIONS ───────┐ ┌─ L2b READ ────────────┐ ┌─ L2c MEDIA ───────┐
│  input/ click type   │ │ snapshot/ state/      │ │ screenshot/       │
│  press mouse scroll  │ │ content/ verify/     │ │ viewport/ pdf/    │
│  select check select │ │ predict/ wait        │ │ upload            │
│  queue.js (≤24)      │ │ tabs/                │ │ ladder.js         │
└──────────┬───────────┘ └──────────┬───────────┘ └──────────┬─────────┘
           │                        │                          │
           └────────────────────────┴──────────────────────────┘
                                    │ executeJavaScript / sendInputEvent / capturePage
┌─ L3 PAGE FACETS (main/agent/page/) — separately testable page scripts ─────────┐
│  snapshot.facet.js  locate/content/state/select/transform/verify/predict       │
│  eval.facet.js      bounded evaluation + two-tier serializer                   │
│  observe.facet.js   NEW (D1): dialog/permission/frame/lifecycle observation     │
│  attest.facet.js    NEW (D1): preload-side trusted-event receipt attestation   │
└───────────────────────────────────────────────────────────────────────────────┘
        │
┌─ L4 ADAPTER (mcp/) — unchanged protocol, thin translation only ────────────────┐
│  catalog.js (from TOOLS) · client.js (transport, retry) · framing · errors      │
│  MUST contain zero OpenCode/Claude/Cursor knowledge — verified absent today     │
└───────────────────────────────────────────────────────────────────────────────┘
        │
┌─ L5 CLI / LAUNCHER (scripts/min-agent-cli.js) — NEW in D5 ────────────────────┐
│  launch · status · doctor · stop · profile create|list|migrate · client install │
└───────────────────────────────────────────────────────────────────────────────┘
        │
┌─ L6 AGENT PROGRAMMING MODEL (D3, deferred behind security ADR) ────────────────┐
│  skills/ (versioned built-in) · helpers/ (sandboxed recipes) · domain-skills/    │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Boundary rule:** no layer may reach past its neighbour. `L2` must not touch `fs` directly except through `policy.js`/`download` path validators; `L3` receives only fixed-function source plus JSON-string arguments (the existing zero-interpolation discipline, `main/agentRpc.js:955-959`); `L4` must never `require()` a bridge symbol.

### 2.3 Component responsibilities, current owners and failure modes

| #   | Component                              | Current implementation (`file:line`)                                                                                                                         | Target responsibility                                                                                                                          | State/lifecycle owner                                                                      | Failure modes & recovery                                                                                                                            | Acceptance signals                                                                                                 | Security/privacy constraints                                                                                                                                                                               |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Min Electron app / main process**    | `main/main.js` (window `:192`, chrome view `:214`), `main/viewManager.js:32-53` (tab view)                                                                   | App lifecycle, `webContents`, profile selection, native APIs, permissions, download lifecycle, native events                                   | `main.js` owns windows; `viewManager` owns tab views                                       | Tab attach races (already caused the PAV 3/16 cascade) → bounded readiness poll `scripts/lib/proctools.js:83-97`                                    | Tab enumerated, attached, not loading; `browser_tabs` non-empty and shell-free                                     | Never load a remote page into the nodeIntegration:true chrome view (`main.js:339-344`). Tab views stay `sandbox:true`/`contextIsolation:true`.                                                             |
| 2   | **Renderer / page execution boundary** | `AGENT_SNAPSHOT_PAGE_FN` `:966-1604`; `AGENT_EVAL_PAGE_FN` `:3140-3206`; `safeDialogs:true` `viewManager.js:15`; preload `dist/preload.js`                   | Page-context evaluation, DOM/AX inspection, interaction delivery attestation, screenshot/canvas hooks; untrusted code isolated from host       | Bridge owns the injected functions; the page owns nothing                                  | CSP blocks `new Function` → structured error (honest, documented); synchronous infinite loop cannot be cancelled — renderer stays busy until reload | `executionContext:'main-frame-page-world'` `:3276`; bounded two-tier output `:3177-3183`; new D1 attestation field | No `contextBridge` host capability may exist without a namespaced, read-only, audited contract. Page JS must never gain `fs`, `process`, `require` — D1 must add a regression test asserting the negative. |
| 3   | **Agent RPC bridge**                   | `main/agentRpc.js` (5,319 lines); server `:5260`; validate `:539-648`; dispatch `:843-944`; discovery `:5213-5232`; grants `:411`; `policy.json` `:469-491`  | Loopback transport, auth/discovery, per-profile identity, schema validation, dispatch, risk/grant checks, event correlation, structured errors | Bridge owns grants, refs, screenshots registry, download records, per-webContents queues   | 401/429/413 structured; stale discovery file unlinked pre-publish `:5252-5254`; token never logged `:5291`                                          | 401/429/413/404 mapping; error code↔HTTP table `:380-399`                                                          | Loopback-only; ephemeral port; `timingSafeEqual`; unknown JSON keys rejected `:595-600`; log fixed labels/counts only `:301-305`.                                                                          |
| 4   | **MCP adapter**                        | `mcp/min-agent-mcp.js`: `TOOLS` `:45-507` (33), `profileDir()` `:517-523`, `readDiscovery()` `:527-540`, `mcpToolResultFor()` `:587-597`, framing `:680-699` | Portable tool schemas, adapter config, reconnection, diagnostics, client discovery                                                             | Adapter owns protocol negotiation + stdio framing only                                     | No retry today; transport failure → `isError:true` text result `:620-632`; discovery race handled by two-candidate read `:529`                      | `tools/list` returns 33; `initialize` negotiates `:661-672`; screenshot returns a real `type:'image'` block `:591` | Zero client-specific logic — verified absent. Token never written anywhere except the loopback header (`mcp/README.md:65-66`). stdout carries MCP frames only.                                             |
| 5   | **CLI / launch runtime**               | `scripts/min-launch.js` (138 lines): args `:32-55`, spawn `:63-78`, killTree `:98-106`, readiness `:117-138`                                                 | Canonical install location, start/stop/status/doctor/recovery, profile provisioning, logs, safe cleanup                                        | Launcher owns the child PID in memory only; the bridge writes `pid` into discovery `:5219` | 60 s discovery deadline → `killTree()` + exit 1 `:132-137`; Ctrl-C/SIGTERM targeted kill                                                            | 3 stdout lines + `ready`; PID-scoped cleanup only                                                                  | Never `/IM` kills. Never print the token.                                                                                                                                                                  |
| 6   | **Profile / session layer**            | per-`userDataPath` discovery `:5214`; `persist:webcontent` partition `js/webviews.js:201`; `policy.json` `:469-491`; `agent-downloads` root `:2022-2033`     | Per-agent isolation, settings, cookies/storage, concurrency policy, naming, migration/backup, cross-agent tab-control prevention               | `userDataPath` owns all of it                                                              | Two agents on one profile → tab/ref cross-talk (reported)                                                                                           | Profile path is echoed in every adapter error `:536-537`, `:630-632`                                               | `0600` advisory on Windows is stated, not assumed strong `:5224-5225`. Shared-profile mode must be opt-in and warned.                                                                                      |
| 7   | **Skills / helper workspace**          | **Absent.** `SKILL.md` (310 lines) is the only agent-facing surface.                                                                                         | Versioned built-in skills, optional domain-skill catalog, user/agent helpers, controlled persistence                                           | Not applicable yet                                                                         | Not applicable yet                                                                                                                                  | Not applicable yet                                                                                                 | **Blocked behind ADR-09.** `browser_eval` is explicitly _not_ a sandbox (`mcp/min-agent-mcp.js:435`). Helpers must not inherit host capability.                                                            |
| 8   | **Observability & evidence**           | Per-run probe JSON under `docs/`; `setInterval(agentRpcDlPrune)` `:2128`; no product trace                                                                   | Opt-in JSONL action traces, screenshot/recording policy, redaction, retention, failure evidence, reproduction metadata                         | D4 owns                                                                                    | Recording must be opt-in before capture                                                                                                             | Trace replayable to reproduce a failure                                                                            | Opt-in + consent + redaction before write. No cookies, `Authorization` headers, challenge tokens, or credentials — `docs/p110-runs` currently holds only fixture screenshots.                              |
| 9   | **Packaging / update / test**          | `scripts/buildMain.js`, `buildPreload.js`, `buildWindows.js`; `package.json`; `dist/app/*` stale                                                             | Version pinning, Electron upgrade cadence, generated artifacts, installer identity, signing, per-platform test matrix                          | D6/D8                                                                                      | `dist/app` predates P1-15 (§0.5)                                                                                                                    | Fresh build + packaged runtime validation (D7/D8)                                                                  | Unsigned installer → SmartScreen friction (reported, unfixed).                                                                                                                                             |
| 10  | **External integrations boundary**     | **None present.** No HTTP client beyond the loopback bridge; no `http_get` tool; no cloud path.                                                              | Optional remote browser / cloud / provider, strictly separated                                                                                 | D-n/a until approved                                                                       | Provider outage / latency / cost / licensing                                                                                                        | Not applicable yet                                                                                                 | CloakBrowser binary: **redistribution/bundling prohibited** (Phase C §3). No stealth, proxy rotation, token forgery, or CAPTCHA-solving service is an approved component.                                  |

### 2.4 Source-inspection findings to verify in D1 (`[FINDING]` — not reproduced by an executed test)

These came out of reading the current source in Phase D. They are **not** claims of observed failure. Each needs a reproduction test before it becomes a defect; each is scheduled in D1.

| #        | Finding                                                                                                                                                                                                                                    | Evidence                                                                 | Why it matters                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-1**  | Excluded batch tools (`browser_grant`, `browser_batch`) still execute when `stopOnError:false`. The exclusion block pushes a failure step and conditionally `break`s, but has no `continue`/`return`; execution falls through to dispatch. | `main/agentRpc.js:3369-3374` vs `:3388`; exclusion set `:3120`           | An authorization primitive could run inside a batch the caller believes is blocked from granting. Security-relevant.                              |
| **F-2**  | `recoverStale` retries with a **Promise object as the `ref`**. `agentRpcReResolveRef` returns a Promise; the call site does not `await`, and the retry dispatch bypasses schema validation.                                                | `:3316-3330`, `:3412-3415`; ref pattern validated at schema + `:595-600` | Stale-ref recovery is a headline P1-15 feature; if this path is broken or type-confused it must be known before D7 acceptance.                    |
| **F-3**  | Element-scoped screenshot appears to fail unconditionally: the injected snippet declares `r, iw, ih, x, y` but the return expression references undeclared `w` and `h`, which `catch` converts into `invalid_params`.                      | `:4936-4940` (return), `:4945` (reject)                                  | **Directly conflicts** with the P1-15 report's claim that element-scoped capture was tested. Must be resolved before either statement is trusted. |
| **F-4**  | Batch response hardcodes `stopOnError: true` regardless of the caller's value.                                                                                                                                                             | `:3438`                                                                  | Caller is told the opposite of what they asked for. Truthfulness defect.                                                                          |
| **F-5**  | `browser_snapshot`'s `waitMs` path is unreachable: the handler reads `params.waitMs`, but the schema declares only `tabId`/`format`/`maxNodes` and unknown keys are rejected.                                                              | `:1661` vs schema `:45-49` and rejection `:595-600`                      | Silent dead parameter.                                                                                                                            |
| **F-6**  | `AGENT_RPC_NET_INFLIGHT` is declared and assigned twice.                                                                                                                                                                                   | `:1980` and `:2812`                                                      | Harmless today; a trap for the D1 network-idle work (E3).                                                                                         |
| **F-7**  | `download_not_found`, `invalid_results`, `eval_rejected`, `eval_exception` are absent from the code→HTTP status map, so they fall through to HTTP 500.                                                                                     | `:2310`, `:3266-3271` vs `:380-399`, fallbacks `:5184`/`:5200`           | Clients cannot distinguish an expected structured error from an internal crash. Directly undercuts the honesty goal (ADR-03).                     |
| **F-8**  | A synchronous `appendFileSync` to a temp debug log runs per interpolated mouse-move step, inside the input hot loop.                                                                                                                       | `:2780`                                                                  | Latency and blocking I/O in the input path; leftover debug code.                                                                                  |
| **F-9**  | Adapter throws `ReferenceError: t0 is not defined` after every successful tool call; swallowed by `uncaughtException`.                                                                                                                     | `mcp/min-agent-mcp.js:644` (only occurrence), handler `:706-708`         | Duration logging is dead; noisy stderr on every success.                                                                                          |
| **F-10** | Adapter accumulates the HTTP response body with **no size cap**.                                                                                                                                                                           | `mcp/min-agent-mcp.js:559`                                               | Unbounded memory from a loopback peer. Low practical risk given auth, but inconsistent with the bridge's own 64 KiB inbound cap.                  |
| **F-11** | `setInterval(agentRpcDlPrune, 60000).unref()` and `app.on('session-created', …)` execute at module load regardless of whether `--agent-rpc` was passed.                                                                                    | `:2128`, `:2876-2879`                                                    | The agent surface is not fully inert when disabled — relevant to ADR-01's "opt-in" claim and to a security review.                                |
| **F-12** | Adapter has no retry/reconnect: exactly one discovery read + one HTTP attempt per call.                                                                                                                                                    | `mcp/min-agent-mcp.js:545`, `:549-567`; no retry anywhere                | Explains user-visible flakiness when Min restarts under a running agent. D1/D5 scope.                                                             |
| **F-13** | `min-launch.js --help/-h` precedence bug: `!afterDash && a === '--help' \|\| a === '-h'` lets a start URL of `-h` after `--` abort the launch with exit 0.                                                                                 | `scripts/min-launch.js:45`                                               | Cosmetic/edge, but it is the launcher that D5 will productise.                                                                                    |
| **F-14** | `min-launch.js` uses only the `<profile>-development` discovery spelling, while the adapter searches `<profile>-development` then `<profile>`.                                                                                             | `min-launch.js:59` vs `mcp/min-agent-mcp.js:529`                         | A packaged (non-dev) launch has no working launcher-side discovery path today. Direct input to D5.                                                |
| **F-15** | `agentRpc.js` header (`:1-8`) still describes the Phase-1 bridge and denies the existence of `executeJavaScript`, navigation, screenshot, and fs access.                                                                                   | `:1-8` vs 22 `executeJavaScript` sites, `:4209`, `:5226`                 | ADR-12. Reviewer-hostile.                                                                                                                         |
| **F-16** | Duplicated attach/composition logic between `agentRpcEnsureViewAttachedAndSelected` and an inline re-implementation inside `agentRpcCommandMouse`.                                                                                         | `:2509-2539` vs `:2629-2656`                                             | ADR-11 seam.                                                                                                                                      |
| **F-17** | `AGENT_SNAPSHOT_PAGE_FN` is 639 lines / 12 modes and is `.toString()`-serialised and re-assembled independently at ~14 call sites.                                                                                                         | `:966-1604`; call sites e.g. `:3520`, `:3595`, `:4160`, `:4630`          | Cost on every call, and a single edit can desynchronise callers. ADR-11.                                                                          |
| **F-18** | Snapshot role mapping is a closed 11-role list; unrecognised `<input>` types return `null` and are dropped from enumeration entirely.                                                                                                      | `:1049`, `:1055-1060`, `:1100`                                           | Real coverage limit for parity row B4; explains some "element not found" agent failures.                                                          |
| **F-19** | Only **open** shadow roots are traversed (`el.shadowRoot`); closed shadow roots are structurally unreachable.                                                                                                                              | `:1087-1095`                                                             | Limit to document, not a defect. Feeds parity row C9 wording.                                                                                     |
| **F-20** | `min-launch.js` header claims stdout carries "exactly three startup lines" but a fourth (`min exited (code N)`) is emitted on child exit.                                                                                                  | `:16-17` vs `:94`                                                        | Doc/behavior mismatch in the launcher contract.                                                                                                   |

---

## 3. Concrete operation flows

### 3.1 Navigation — `browser_navigate`

```
agent            MCP adapter              bridge (main)                    tab view
  │ tool call       │                          │                              │
  │───────────────► │ prepareArgs (no-op)      │                              │
  │                 │ readDiscovery() :545     │  (token re-read EVERY call)   │
  │                 │ POST /rpc {url,...}      │                              │
  │                 │─────────────────────────►│ agentRpcValidate :539         │
  │                 │                          │  path → Host → Origin/SecFetch│
  │                 │                          │  → Bearer(timingSafeEqual)    │
  │                 │                          │  → ct → JSON → jsonrpc/method│
  │                 │                          │  → in AGENT_RPC_METHODS :36   │
  │                 │                          │  → UNKNOWN KEYS REJECTED :597 │
  │                 │                          │  → per-field schema :601-642  │
  │                 │                          │ agentRpcDispatch :843 → :859  │
  │                 │                          │ agentRpcCommandNavigate :4209 │
  │                 │                          │  scheme allowlist :3931       │
  │                 │                          │  (http/https/file/min/about) │
  │                 │                          │  whitespace/len/ctl :3952-75  │
  │                 │                          │  view attached? :4233         │
  │                 │                          │  loadURLInView ──────────────►│
  │                 │                          │  record AGENT_RPC_LAST_NAV    │
  │                 │                          │  clear refs/transforms :4302  │
  │◄────────────────│◄─────────────────────────│  {tabId, finalUrl, title}     │
```

**Target (D1):** add an explicit `dispatched` / `delivered` / `verified` triple to the result envelope. Today `finalUrl` + `browser_content` is the documented verification path (`SKILL.md:150-151`).

### 3.2 `browser_eval` — bounded page-context evaluation

```
tool call → validate (timeoutMs 1000–30000, default 10000 :3219)
         → per-webContents queue; len ≥ 24 → `busy` :3230
         → executeJavaScript('(' + AGENT_EVAL_PAGE_FN.toString() + ')(JSON args)') :3243
            └── page main world ONLY (never Node) :3125-3126
                └── new Function('EPS', ...) :3184   ← BLOCKED by strict CSP
                └── awaitPromise honoured
                └── safe(): cycles→circular, depth 6, DOM→box+text,
                            ImageData→preview, Map/Set→size :3142-3176
                └── two-tier caps: full → tight → errorNote :3177-3183
         ← race against bounded timer :3238-3242
            `settled` flag prevents late double-resolve :3239
            TIMEOUT MESSAGE STATES THE LIMIT: renderer may stay busy; reload :3241
         ← {executionContext:'main-frame-page-world'} :3276
```

**Known limits carried unchanged:** cannot cancel an endless synchronous expression; strict-CSP `new Function` fails structurally; `maxResultChars` default 60000 `:3220`.

### 3.3 Click / keypress delivery — the honesty contract

```
CURRENT (verified)                                  TARGET (D1, ADR-03)
──────────────────                                  ──────────────────────
browser_click {ref, verification:'standard'}         click → sendInputEvent down/up :3746
  policy pre-auth (risky_name regex :405) :3712      │
  single-use grant required :454-461                 ├─ dispatched:  sendInputEvent returned
  agentRpcRunVerification :3575                       │
    beats [300,700,1200,2000,3000,4000,5000] :3573  ├─ delivered:   NEW — preload-side
    window 5000 ms :3572                             │  attestation (attest.facet.js)
    kinds: navigation/focus/dom-change/value/         │  "the page's handler fired"
            mismatch/framework-unchanged/             │  "compositor painted" stays UNVERIFIED
            dispatched-unverified :3663-3673          └─ verified:    existing verifier
verification:'none'                                          (page-state evidence)
  → {dispatched:true, verified:false} :3755-3763
    ← NO delivery stage exists at all

press: per-webContents queue ≤24 :4775, ordered
       keyDown/keyUp pairs, chain never poisoned :4788
keyCode translation {ArrowUp→'Up',…} :4198 — empirical,
  documented: Arrow* produce EMPTY key events; Up/Down/
  Left/Right deliver Arrow* (:4193-4197)
mouse wheel: synthesized, DROPPED by compositor on this
  Electron build (:2701) → browser_scroll (DOM) is the
  documented reliable path
```

**Decision:** delivery attestation comes from a **sandboxed preload + namespaced `contextBridge` read-only channel**, not from CDP and not from the page world. It reports _"the renderer dispatched a trusted event of this type to the page"_ — never _"the compositor painted"_. Wheel and hover stay `delivery:'unverified'` permanently on this engine, and that is stated in the tool output, not hidden.

### 3.4 Screenshot capture and image return

```
browser_screenshot {tabId, selector?, maxBytes?, maxDim?}
 → maxBytes default 5 MiB :4872/:4202, floor 5000 :4881-4884, ceiling 5242880 :90
 → retry wedge: ≤6 attempts × 2500 ms, 200 ms backoff :4949-4968, overall 8 s :4907
 → capturePage() → NativeImage :4961
 → selector? resolve rect in page :4930-4941, scrollIntoView, clamp
      [FINDING F-3: this path appears to fail — undeclared w/h]
 → element? img.crop({x,y,width,height}) :4981   (visible-area crop by design)
 → LADDER :4873-4879  scale 1 as-req → .5/jpeg80 → .35/jpeg60 → .25/jpeg45 → .2/jpeg35
      first rung that fits wins :5017-5020
 → none fit → screenshot_too_large -32019 (413) :5023
 → cssPerPixel = outMeta.w / vp.width :5042-5043
 → zoom recorded from wc.getZoomFactor() :5031, returned :5045
 → screenshotId 'ss<N>' :5029 stored :5033, consumed by mouse :2568
 → base64 :5027, mimeType :5038
 → ADAPTER mcpToolResultFor :587-597 → [ {type:'image', data, mimeType},
                                          {type:'text',  metadata JSON} ]
```

**Target (D2):** `captureBeyondViewport` full-page mode, `maxDim` pixel-side cap, and a decision on whether element capture should use `captureBeyondViewport` + crop rather than visible-area crop.

### 3.5 Download completion (including the hardened race)

```
browser_download_start {url | armMs}
  → scheme http/https only :2337; embedded creds rejected :2340
  → XOR url/armMs :2330 · intent TTL 30 s :2355 · adoption timeout 20 s :2361
  → wc.downloadURL(url) :2369   OR   arm for adoption
 → main/download.js:13 downloadHandler(event,item,wc)
     :22  agentRpcDownloadManagedHook(...)  ← FIRST, before any human-flow effect
          :2218 setSavePath(agent-downloads/<relPath>)   ← setSavePath ONLY;
                preventDefault() would ABANDON Electron's transfer (:2213-2217)
          :2263-2282 done-before-attach hardening — on nextTick re-check
                getState()/isDone(); a fast download that finished BEFORE the
                listeners attached would otherwise stay 'progressing' forever
          :2186-2198 relPath re-validated inside the hook (defence in depth)
 → browser_download_wait → waiter list; timeout returns {terminal:false, timedOut:true}
 → cancel (5 s confirm :2430) / pause (requires 'progressing' :2457)
       / resume (requires paused|interrupted AND item.canResume() :2478)
 → agentRpcDlPrune setInterval 60 s :2128  [FINDING F-11: runs even when bridge off]
 → public record redacts URL to origin+pathname, never query/hash :2144
```

### 3.6 Stale-reference recovery

```
browser_batch {actions[], stopOnError?, recoverStale?}
  → ≤20 steps :3119, 60 s budget :3118
  → each step re-run through the FULL transport validator :3378-3382
  → ref_stale (60 s TTL :244) → re-snapshot → resolve ORIGINAL identity
     (role+name+nameIndex) → retry ONCE
     ambiguity → `ambiguous` :3559 (never guessed) :3507-3509
  [FINDING F-2: retry passes a Promise as ref; no await, no re-validation]
  [FINDING F-1: excluded tools still execute when stopOnError:false]
  [FINDING F-4: response hardcodes stopOnError:true]
```

### 3.7 Startup, reconnection, and profile selection

```
min-launch.js --profile=<dir> [-- URL ...]
  :42  path.resolve(v); empty → exit 2
  :64  electron ['.', '--development-mode', '--agent-rpc', '--user-data-dir='+profile]
  :59  discovery = <profile>-development/agent-rpc.json     [F-14: dev spelling only]
  :117 stdout: profile: / discovery-file: / (ready)
  :123 poll every 500 ms up to 60 s :122 for the file to APPEAR (no JSON parse)
  :132 deadline → killTree() + exit 1
  bridge: app.on('ready') :5306 → agentRpcEnabledByArgv() :297 → start :5244
          unlink stale discovery :5252 · listen(0,'127.0.0.1') :5278
          randomBytes(32) :5256 · write 0600 :5226 · stop :5296
  adapter: profileDir() :517  --profile= → MIN_AGENT_PROFILE → ~/.min-agent-profile
           readDiscovery() :527  tries <p>-development\agent-rpc.json then <p>\agent-rpc.json
           re-read on EVERY call :545
  MISMATCHED --profile between launcher and adapter ⇒ adapter finds no/other
  discovery ⇒ "Min bridge unreachable (...)" :630-632 naming the configured profile
```

**Target (D5):** the launcher and adapter must derive the profile from ONE source (§4.4), eliminating the mismatch class rather than documenting it.

### 3.8 Action recording (proposed, D4 — not implemented)

```
agent opts in (per session, per profile)
  → TraceWriter opens <profile>/agent-traces/<sessionId>.jsonl  (append-only)
  → for each dispatched action: {seq, ts, tool, sanitisedParams, dispatched,
                                 delivered?, verified?, effect?, errorCode?, durationMs}
  → REDACTION AT WRITE TIME (not at read time): token/Authorization/Set-Cookie/
      cf_clearance/challenge markers, input values for sensitive field types,
      download query+hash, full page content bodies
  → screenshots: metadata + sha256 + path; image bytes on disk, not in the JSONL
  → retention: bounded ring (default 50 MB / 30 days), delete-on-expiry, explicit purge
  → OFF by default; consent recorded before first capture; SKILL.md must state it
```

---

## 4. Multi-agent, global-installation and profile-isolation architecture

### 4.1 What the current code actually guarantees

| Property                                             | Evidence                                                                                                   | Verdict                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Bridge instance identity is per-`userDataPath`       | discovery path `main/agentRpc.js:5214`; written `:5213-5232`                                               | **Yes** — two Min instances on two profiles cannot collide.                                 |
| Bridge identity is per-`userDataPath`                | `pid` in discovery `:5219`, `agent-rpc.js:2119`, `app.getPath('userData')` `:2029`                         | Yes                                                                                         |
| Port is globally unique                              | ephemeral `listen(0,...)` `:5278`                                                                          | Yes — no port contention ever.                                                              |
| Token is unique per launch                           | `randomBytes(32)` `:5256`; adapter re-reads per call                                                       | Yes                                                                                         |
| Adapter profile resolution                           | `profileDir()` `mcp/min-agent-mcp.js:517-523`; `--profile=` > `MIN_AGENT_PROFILE` > `~/.min-agent-profile` | Yes, but **launcher and adapter each resolve independently** → mismatch class (F-14, §3.7). |
| Session/cookie isolation between profiles            | different `userDataPath` → different `persist:webcontent` partition store                                  | Yes, by construction                                                                        |
| Tab isolation between two agents on one profile      | shared `windows` / `viewMap` globals                                                                       | **No** — both drive the same window                                                         |
| Lock file preventing duplicate launch on one profile | none exists; discovery file is overwritten (`:5252`)                                                       | **No** — F-11/duplicate-launch class                                                        |
| Clean restart recovery                               | stale discovery unlinked pre-publish `:5252-5254`; launcher 60 s deadline                                  | Partial — good for restart, absent for duplicate launch                                     |

### 4.2 Recommended deployment model — ADR-04

**One canonical installed application. One adapter file. Many isolated profiles. One OS-level process per concurrent agent.**

Rationale for _process per agent_ rather than one shared process with isolated contexts: Min's own architecture already ties settings, windows, and the `persist:webcontent` partition to the process. Isolating by Electron `session.fromPartition()` inside one process would still share `windows`, `viewMap`, `settings`, the single `onBeforeRequest` slot, and the ad-blocker. Sharing a window between two agents makes `browser_ref` semantics meaningless for both. The isolation boundary Min already has clean and audited is **`userDataPath`**, so that is the boundary to use.

### 4.3 Installation options compared

| Option                                                       | Reliability                                                                                                               | Upgrade safety                                                      | Uninstall safety        | Verdict                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm link` / global npm install of the adapter               | Depends on the user's Node + npm state; conflicts with other global packages; does not solve the _browser_ install at all | Breaks on npm major upgrades                                        | Leaves npm shims behind | **Rejected.** The browser is a packaged Electron app; npm-linking only the adapter creates a second, divergent source of truth. |
| Stable absolute path to the adapter inside the installed app | High. MCP clients spawn `node <abs>/resources/app/mcp/min-agent-mcp.js`. Verified model in `mcp/README.md:26-39`.         | Path is version-stable in an NSIS install (`Min Agent Edition` 1.x) | Installer owns it       | **Recommended core.**                                                                                                           |
| PATH-based `min-agent` shim                                  | High for humans; **unreliable for MCP clients** (do not assume a GUI client's environment inherits the user's PATH)       | Fine                                                                | Clean                   | **Recommended for humans and for `install-client`, never as the MCP `command` itself.**                                         |
| A second browser install per agent                           | n/a                                                                                                                       | n/a                                                                 | n/a                     | **Rejected** — contradicts ADR-01 and the product requirement.                                                                  |

**Recommendation: (b) + (c).** A `min-agent` CLI (D5) installed on PATH by the Windows installer, used by humans and by `min-agent client install`; MCP client configuration always references the **absolute path** to the shipped adapter with an **absolute profile path**.

### 4.4 Single source of truth for the profile (removes the mismatch class)

```
profileRoot = MIN_AGENT_HOME            (default: %USERPROFILE%\.min-agent)
           \ profiles \ <agent-id> \
                 ├ agent-rpc.json      (written by the bridge)
                 ├ agent.lock          (NEW, D5: {pid, startedAt, version})
                 ├ agent-downloads\    (download root, agentRpc.js:2022)
                 ├ policy.json         (agentRpc.js:469)
                 └ agent-traces\       (NEW, D4)

<agent-id> ::= [a-z0-9][a-z0-9._-]{1,31}    (deterministic, human-readable, validated)

Resolution order — IDENTICAL in launcher, CLI and adapter:
  1. explicit --profile=<abs>          (highest precedence, must exist)
  2. MIN_AGENT_PROFILE                 (per-process, for IDE clients)
  3. MIN_AGENT_AGENT_ID + MIN_AGENT_HOME
  4. <profileRoot>\profiles\<agent-id derived from MCP server name>
  5. <profileRoot>\profiles\default    (last resort, warn once)
```

Because steps 1–5 are one shared resolution function, the launcher's `--profile` and the adapter's `--profile` can no longer disagree. `[PROPOSAL]` implemented once in a module both require.

### 4.5 Launch, lock, duplicate detection, and recovery

| Concern                                  | Design                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter starts before Min                | **Default: do not auto-spawn.** Fail fast with the existing profile-aware message (`mcp/min-agent-mcp.js:630-632`) plus the exact `min-agent launch --agent <id>` command.                                                                                                                                                                                                                                                                         |
| Optional auto-spawn                      | `MIN_AGENT_AUTOSTART=1` only. Must spawn **detached**, log to `<profile>/min-agent.log`, and never block the stdio channel. Default remains off because a surprise browser window is a privacy/UX event.                                                                                                                                                                                                                                           |
| Duplicate launch on one profile          | `agent.lock` holds `{pid, startedAt, version}`. On start, if the pid is alive **and** its start time matches, refuse to start and report the owning pid/command. PID-reuse guard by start-time comparison, not by name.                                                                                                                                                                                                                            |
| Crash                                    | Discovery file removed on `process.on('exit')` `:5317-5319`; `agent.lock` validated by liveness+start-time, so a stale lock self-heals.                                                                                                                                                                                                                                                                                                            |
| Restart under a running agent            | Adapter has **no retry today** (F-12). D1/D5 add bounded retry with backoff on _discovery-missing_ and _connection-refused_ only, capped (e.g. 3 attempts / 10 s), because those are the two states a Min restart produces.                                                                                                                                                                                                                        |
| Concurrent agents                        | One process + one profile per agent. No shared window. Enforced by policy, documented, detectable via `browser_health` reporting the profile path.                                                                                                                                                                                                                                                                                                 |
| Opt-in single-user session sharing       | `MIN_AGENT_ALLOW_SHARED_PROFILE=1`, off by default. When on, `browser_health` and `browser_status` MUST emit a `sharedSession:true` warning and every snapshot result carries a `sessionId` hint, because refs from two agents over one tab are indistinguishable. **Why unsafe by default:** two agents can select the same tab, close each other's tabs, invalidate each other's refs on navigation, and race the single `onBeforeRequest` slot. |
| Upgrade                                  | Installer must never delete `<profileRoot>`; it lives under `%USERPROFILE%`, outside the install directory. Uninstall removes the app and PATH shim, leaves profiles + traces; a separate `min-agent profile purge` is explicit.                                                                                                                                                                                                                   |
| Paths with spaces                        | Every emitted command/config value is absolute and JSON-quoted; `min-launch.js:42` already `path.resolve`s. Windows `cmd` quoting must be exercised by a D5 test with a deliberately space-containing profile root.                                                                                                                                                                                                                                |
| Instance discovery without token leakage | Discovery file carries `{v, url, token, pid, version, launchedAt}` `:5215-5222`. Diagnostic output MUST emit `tokenSource:'per-launch file'` (the pattern already used at `:792`, `:797`) and never the value. File is `0600` — stated as advisory on Windows, exact on POSIX `:5224-5225`.                                                                                                                                                        |

### 4.6 Client configuration — validated examples

**Validation basis (this phase, `[SOURCE]`):** OpenCode **1.19.2** installed (`opencode --version`); configs at `~/.config/opencode/opencode.jsonc` and `~/.opencode/opencode.json`, both carrying `"$schema": "https://opencode.ai/config.json"`. The `mcp` property of that schema was fetched and read: it accepts `mcp.servers.<name>` of type `McpLocalConfig` with fields `type:"local"`, `command:string[]`, `cwd`, `environment:Record<string,string>`, `enabled:boolean`, `timeout:integer(ms)`. A top-level `mcp.<name>` form also exists but is marked **deprecated** in the schema.

> **Critical validated detail:** the OpenCode schema documents the default MCP server request timeout as **5000 ms**. Min's adapter allows up to **30000 ms** per call (`mcp/min-agent-mcp.js:556`) and `browser_eval` alone defaults to **10000 ms** (`main/agentRpc.js:3219`). **Without an explicit `timeout`, OpenCode will abandon long Min calls.** This is a concrete, schema-verified, production-affecting requirement — not a guess.

#### OpenCode (schema-verified for 1.19.2)

```jsonc
// ~/.config/opencode/opencode.jsonc  — MERGE into the existing file, do not replace.
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "timeout": { "startup": 20000, "catalog": 20000, "execution": 60000 },
    "servers": {
      "min-agent": {
        "type": "local",
        "command": [
          "node",
          "C:\\Program Files\\Min Agent Edition\\resources\\app\\mcp\\min-agent-mcp.js",
          "--profile=C:\\Users\\<you>\\.min-agent\\profiles\\opencode"
        ],
        "enabled": true,
        "timeout": 60000
      }
    }
  }
}
```

Client-specific fields: `mcp.servers` (not the deprecated top-level `mcp`), `type:"local"`, `command` as an **array**, and `timeout` in **milliseconds**. `cwd` and `environment` are optional — `environment` is the right place for `MIN_AGENT_PROFILE` if a path would otherwise need shell quoting.

#### Generic MCP client (common denominator)

```json
{
  "mcpServers": {
    "min-agent": {
      "command": "node",
      "args": [
        "<ABS>/resources/app/mcp/min-agent-mcp.js",
        "--profile=<ABS_PROFILE_DIR>"
      ]
    }
  }
}
```

Variants already documented in-repo: `claude mcp add min-agent -- node … --profile=…` (`mcp/README.md:41-48`), `.mcp.json` (`:50-52`), Cursor `.cursor/mcp.json` (`:54-58`). **Support matrix is `mcp/README.md:62-64`: generic stdio JSON-RPC = tested; Claude Code and Cursor = "config-only, untested".** That status is unchanged by this phase; promoting those rows requires a live client test (D5).

**Unvalidated and deliberately left open:** whether any specific client needs an `env` block, a `cwd`, or a different timeout default. Nothing in this document asserts a universal schema.

---

## 5. Engine / application / external-service responsibility matrix

| Capability                                    | Application layer (Electron API)                                                                                     | Renderer/page layer                                                      | Small native patch set                                    | External service      | Agent helper layer | **Decision**                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser health / doctor (A4, J3)              | ✅ `app.getPath`, session, policy, grants, discovery                                                                 | —                                                                        | —                                                         | —                     | —                  | **Application.** D1 `browser_health`, read-only, no secrets.                                                                                                                                                                                                                                                                                                        |
| Page dialog state (B3, C7)                    | ✅ `webContents.on('dialog')`, `will-prevent-unload`                                                                 | partial: `safeDialogs:true` already set (`viewManager.js:15`)            | —                                                         | —                     | —                  | **Application.** D1. **Note `[SOURCE]`: no `dialog`/`beforeunload` handler exists anywhere in the repo today** — grep returns zero matches; behaviour today is governed solely by the `safeDialogs` flags. Runtime behaviour of that flag for agent workflows is **[UNVERIFIED]** and must be established in D1 before `browser_dialog` accept/dismiss is designed. |
| Browser PDF (G2)                              | ✅ `webContents.printToPDF`                                                                                          | —                                                                        | —                                                         | —                     | —                  | **Application.** D2. Lowest-cost row in the matrix.                                                                                                                                                                                                                                                                                                                 |
| File upload (C6)                              | ✅ `webContents.debugger.sendCommand('DOM.setFileInputFiles')` **or** a main-process `<input type=file>`-driven path | resolves the target input                                                | —                                                         | —                     | —                  | **Application, with an explicit decision required** (§5.1).                                                                                                                                                                                                                                                                                                         |
| Framework-aware fill (C2)                     | —                                                                                                                    | ✅ per-char key events + native setter fallback (exists at `:3851-3896`) | —                                                         | —                     | —                  | **Renderer, opt-in mode.** D2. Current `browser_type` uses native `insertText`; upstream uses per-char key events. Different failure modes on custom editors.                                                                                                                                                                                                       |
| Physical key model (C3)                       | ✅ `sendInputEvent` keyCode translation `:4198-4201`                                                                 | —                                                                        | —                                                         | —                     | —                  | **Application.** Already adequate; extend only if D2 tests demand.                                                                                                                                                                                                                                                                                                  |
| Full-page / offscreen screenshot (D1)         | ✅ `captureBeyondViewport`                                                                                           | —                                                                        | —                                                         | —                     | —                  | **Application.** D2.                                                                                                                                                                                                                                                                                                                                                |
| Viewport resize (D4)                          | ⚠️ `setZoomFactor` only (`:3300`)                                                                                    | —                                                                        | —                                                         | —                     | —                  | **Application, partially.** Zoom ≠ resize; documented limitation persists. A true window-dimension change is a _window_ operation and affects all tabs in that window. **Decision: keep zoom; document window resize as Not applicable for per-tab semantics.**                                                                                                     |
| Wheel / hover / drag (C4, C5)                 | ⚠️ `sendInputEvent` mouseWheel — compositor drops it (`:2701`)                                                       | ✅ DOM-level `browser_scroll` works (`:2921-2923`)                       | only a native patch could fix the compositor path         | —                     | —                  | **Application, with an honest ceiling.** Keep DOM scroll as the reliable path; permanently label wheel delivery `unverified`. Re-test on every Electron upgrade (D6).                                                                                                                                                                                               |
| Renderer-delivery acknowledgement             | ❌ Electron exposes no compositor ack                                                                                | ✅ NEW preload-side attestation (D1)                                     | would be needed for _paint_-level truth                   | —                     | —                  | **Renderer.** D1. Deliberately does not claim paint-level truth.                                                                                                                                                                                                                                                                                                    |
| JS eval under CSP + hard timeout (B5)         | ⚠️ cannot cancel sync-infinite; `new Function` blocked by CSP                                                        | ✅ bounded serializer, queue, honest timeout message                     | V8 interrupt would need native support — **out of scope** | —                     | —                  | **Renderer, with documented limits.** No evasion. A CSP-failing page gets a structured error; that is the correct outcome.                                                                                                                                                                                                                                          |
| Raw CDP / event drain (B6, E4)                | 🚫 deliberately absent                                                                                               | —                                                                        | —                                                         | —                     | —                  | **Never.** ADR-02.                                                                                                                                                                                                                                                                                                                                                  |
| Helper workspace / domain skills (B7, I1, I2) | —                                                                                                                    | —                                                                        | —                                                         | —                     | ✅ D3, sandboxed   | **Agent layer**, gated behind ADR-09 security design.                                                                                                                                                                                                                                                                                                               |
| Traces / recordings (H1, H2, H3)              | ✅ write JSONL, retention                                                                                            | —                                                                        | —                                                         | —                     | —                  | **Application**, opt-in + consent. D4.                                                                                                                                                                                                                                                                                                                              |
| Electron/Chromium upgrade policy              | ✅ npm devDependency pin                                                                                             | —                                                                        | —                                                         | —                     | —                  | **Application.** D6. Native patches stay deferred behind an evidence bar.                                                                                                                                                                                                                                                                                           |
| CAPTCHA detection vs clearance                | ✅ detection present (`:1507-1552`), interaction allowed, state string `:4027`                                       | —                                                                        | —                                                         | 🚫 no solving service | —                  | **Detection only, permanently.** No clearance claim.                                                                                                                                                                                                                                                                                                                |
| Remote/cloud browser (A5, K1, K4)             | —                                                                                                                    | —                                                                        | —                                                         | 🚫 not approved       | —                  | **Deferred (OD-7).**                                                                                                                                                                                                                                                                                                                                                |
| HTTP fetch helper (C11)                       | —                                                                                                                    | —                                                                        | —                                                         | —                     | —                  | **Not applicable.** Agent-side networking is the agent's business.                                                                                                                                                                                                                                                                                                  |
| Telemetry (K3)                                | —                                                                                                                    | —                                                                        | —                                                         | —                     | —                  | **Not applicable — deliberately absent.** Keep absent unless the user asks.                                                                                                                                                                                                                                                                                         |

### 5.1 Upload (C6) — explicit sub-decision required

Two viable executors, and they are **not** equivalent:

- **(i) CDP `DOM.setFileInputFiles`** — matches upstream exactly, but requires `webContents.debugger`, which ADR-02 currently forbids. Adopting it for _this single method_ is a scoped exception, not a general CDP opening. It must be a closed allowlist of exactly that command, with the same path validation as downloads (`agentRpcDlValidateRelPath` `:2038-2060` and the symlink walk `:2093-2112`) reused — never a second, weaker validator.
- **(ii) Renderer-driven file selection** — open a real file chooser via `ipc` and let the human pick. No new privilege, but it is not automatable, so it does not satisfy agent-driven parity.

**Recommendation: (i) as a single-command allowlisted exception, reusing the download path validator verbatim**, with paths restricted to an explicit upload allowlist directory (default `<profile>/agent-uploads`). Decision recorded as **OD-3**, to be settled at the start of D2, not now.

---

## 6. Security, privacy, and licensing decision record

### 6.1 Privileged operation → authorization map (current state, `[SOURCE]`)

| Privileged operation                       | Authorization check                                                                                                                                      | Executor                                       | Output schema guard                      | Tests                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| Any bridge call                            | Host allowlist `:350-356`; rejects `Origin`/`Sec-Fetch-Site` `:360-365`; `timingSafeEqual` bearer `:325-337`; rate 40 rps `:28`                          | `agentRpcValidate` `:539-648`                  | HTTP 401/403/429/413                     | `scripts/agent-rpc-test.js` (reported 182/182)            |
| Unknown RPC method                         | `AGENT_RPC_METHODS` membership `:584-586`                                                                                                                | dispatcher `:843-944`                          | `-32601` / 404                           | census assertions `mcp-e2e.js:129`                        |
| Unknown request key                        | **Rejected**, not ignored `:595-600`                                                                                                                     | validator                                      | `-32602`                                 | RPC test                                                  |
| Click on a "risky" name                    | `AGENT_RPC_RISKY_NAME` `:405` → single-use grant `:450-461` (120 s TTL `:510`)                                                                           | `agentRpcCommandClick` `:3712-3717`            | `risky_action -32014`                    | `probe:mouse`, api-matrix                                 |
| Type into a sensitive field                | in-page detection `:983`, `:1123`; grant `sensitive_type` `:127`                                                                                         | `agentRpcCommandType` `:3806-3812`             | `sensitive_field -32013`                 | `probe:inputs`                                            |
| Password verification                      | exact in-page comparison, boolean only — the secret never crosses the bridge                                                                             | page `locate`/`setvalue` `:1160-1165`, `:1584` | `verification:'value'` / `match:false`   | P1-15 M4                                                  |
| Navigation / tab_open / download_start URL | scheme allowlist `:3931`; length/control/whitespace `:3952-3975`; origin-safe prefix `:3938-3950`                                                        | three call sites                               | `-32005 blocked`                         | api-matrix                                                |
| Download destination                       | `relPath` validator `:2038-2060` + containment incl. case-insensitive + symlink walk `:2093-2112`, **re-checked inside the ownership hook** `:2186-2198` | `agentRpcDownloadManagedHook` `:2160`          | `-32005`                                 | `probe:downloads` (reported 33/33)                        |
| `browser_grant` outside a batch            | excluded in batch `:3120` — **[FINDING F-1: exclusion does not hold when `stopOnError:false`]**                                                          | batch loop `:3369-3388`                        | —                                        | **D1 regression test required**                           |
| Page JS capability                         | `browser_eval` runs in the page main world with page authority only; no Node `require`/`process` reachability                                            | `AGENT_EVAL_PAGE_FN` `:3140-3206`              | token-gated; `executionContext` reported | `probe:eval` check 9 — **not npm-discoverable (F: §0.3)** |
| Transform values                           | 15-property allowlist `:4473`; value charset rejects `url(`, `expression(`, `@`, `;`, braces `:4484-4485`; ≤50 entries `:4474`                           | `agentRpcCommandTransform` `:4576`             | `invalid_params`                         | `probe:transform`                                         |
| Risk policy persistence                    | `policy.json` `{allowRiskyClicks, allowSensitiveTyping, allowedSchemes}`, both **default false** `:469-491`; re-read per call                            | `agentRpcReadPolicy`                           | —                                        | D1                                                        |

### 6.2 Privacy rules (binding on D1–D8)

1. **No token, `Authorization` header, `Set-Cookie`, `cf_clearance`, or challenge token in any log, tool output, screenshot metadata, trace, or diagnostic bundle.** Current discipline to preserve: `agentRpcLog` takes fixed labels and counts only `:301-305`; the port is logged but never the token `:5291`; `browser_status` returns `tokenSource` only `:792`. `agentRpcDlPublicRec` strips query and hash from URLs `:2144`.
2. **Additive, non-interfering main-process listeners only.** The bridge must never take a slot it does not own. Two precedents must be preserved: the ad blocker keeps the single `onBeforeRequest` (`main/filtering.js:293`, asserted as exactly one effective handler) and the download hook is called _first_ inside the existing human flow (`main/download.js:22`). Any new listener in D1 (e.g. `dialog`) must follow the same shape: observe by default, act only on explicit agent request.
3. **Recording consent precedes capture.** Off by default, opt-in per session, redacted at write time, bounded retention, explicit purge.
4. **Process cleanup is scoped to PIDs this run spawned.** Never `/IM`. Preserved and regression-tested by `scripts/lib/proctools.js` (5 exports, `:114`) and `scripts/proctools-test.js` (9/9).
5. **Challenge vocabulary stays separated.** Detection ≠ interaction ≠ clearance ≠ compatibility ≠ provider. `browser_state`'s existing string — _"never solved, bypassed or automated by the agent"_ `:4027` — is the contract and must survive every milestone.
6. **CSP failure is an honest structured error, not a workaround.** No script shim, no policy mutation, no flag injection.
7. **No capability grants to helper code** until D3's security design exists.

### 6.3 Licensing decision record

| Artefact                                                       | Licence (per the audits)                       | Decision                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Min Agent Edition source                                       | Min's licence + this fork                      | Maintain.                                                                                                                                                                                                                                                                                                                                                       |
| Electron                                                       | MIT                                            | Maintain. Pin and upgrade on a cadence (D6).                                                                                                                                                                                                                                                                                                                    |
| Browser Harness (`browser-harness`, rev `c6a9412…`, v0.1.13)   | MIT (Python)                                   | **Ideas may be adapted; attribution required if code or the ~150 domain-skill playbooks are adopted (B8/I2).** No code copied in Phase D. Upstream bodies of `admin.py`, `daemon.py`, `auth.py`, `recorder.py`, `video*.py`, `telemetry.py`, `_ipc.py` and many test/skill bodies remain **Unverified (bodies)** and must not be upgraded without reading them. |
| CloakBrowser wrapper                                           | MIT                                            | Could be independently re-implemented if ever needed.                                                                                                                                                                                                                                                                                                           |
| **CloakBrowser binary**                                        | proprietary; `BINARY-LICENSE.md` v1.3          | **Bundling, embedding and redistribution prohibited** (Restriction 1); reverse engineering prohibited (Restriction 3); OEM/SaaS licence required to expose browser functionality to third-party customers. **Not installed, not executed, not bundled, not a dependency.**                                                                                      |
| Chromium / ungoogled-chromium (if a fork were ever considered) | BSD-3-Clause + source-availability obligations | **Out of scope.** Not pursued.                                                                                                                                                                                                                                                                                                                                  |
| Upstream cloud CAPTCHA/stealth/proxy services                  | n/a                                            | Not present in the local open-source package; not integrated.                                                                                                                                                                                                                                                                                                   |
| User credentials, cookies, private profile data                | user-owned                                     | Never recorded in any artefact.                                                                                                                                                                                                                                                                                                                                 |

---

## 7. Feature-to-milestone coverage map

### 7.1 Stable row IDs

`docs/audit/BROWSER-HARNESS-FEATURE-PARITY.md` **already has stable IDs** in its `ID` column: `A1…A7`, `B1…B8`, `C1…C11`, `D1…D4`, `E1…E4`, `F1`, `G1…G3`, `H1…H3`, `I1…I3`, `J1…J3`, `K1…K4`, `L1…L5`, and `M1-row…M5-row` (M-section rows are the only ones without numeric suffixes).

**Proposal, for a later controlled documentation change (NOT performed in Phase D — the parity matrix was not edited, per §8 of the Phase D task):**

1. Keep every existing ID verbatim — they are already stable and are referenced by two audit documents.
2. Rename only `M1-row…M5-row` → `M1…M5` for consistency (pure label change, no row added or removed).
3. Add a `Milestone` column and a `Phase D target status` column, and freeze IDs as a documented contract: **IDs are append-only and never reused.**
4. Count the matrix as **61 rows** (§0.2 #4), correcting the "approximately 50" figure in the Phase B summary.
5. Add rows for capabilities Phase B could not see because they do not exist upstream but do exist in Min's real problems: the three-stage truthfulness contract, packaged-artifact parity, and the shared-profile safety case.

### 7.2 Complete mapping — all 61 parity rows

Legend for **Target** column: `D1…D8` milestone · `NA` not applicable (with rationale) · `DEF` explicitly deferred (with milestone).

| ID  | Feature (abbrev.)                               | Phase B status                         | Target                               | Milestone / decision                                                       |
| --- | ----------------------------------------------- | -------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| A1  | Attach to real logged-in Chrome                 | Not applicable                         | NA                                   | Min is the browser (ADR-01). UX ideas only.                                |
| A2  | Persistent daemon / horse marker                | Not applicable                         | NA                                   | Single process; Min _is_ persistent.                                       |
| A3  | Daemon reattach/recovery                        | Not applicable/Partial                 | **D5**                               | Min restart recovery, lock files, bounded adapter retry.                   |
| A4  | `--doctor` diagnostics                          | **Missing**                            | **D1**                               | `browser_health`.                                                          |
| A5  | Cloud/remote daemons, auth, billing             | Not applicable/Deferred                | DEF                                  | **OD-7.** External-service boundary only.                                  |
| A6  | Multiplexed named daemons                       | Partial                                | **D5**                               | Per-agent profile isolation + SKILL.md tab-reuse rules.                    |
| A7  | macOS accessibility helper                      | Not applicable                         | NA                                   | No macOS build exercised. Revisit with macOS packaging (D8).               |
| B1  | Navigate + wait_for_load + SPA readiness        | Verified complete                      | D1 (harden)                          | Add delivery/verified stages.                                              |
| B2  | Tabs list/create/attach/switch/close            | Verified complete                      | D1/D5                                | Profile-scoped isolation.                                                  |
| B3  | Page info + page size + native-dialog detection | **Partial**                            | **D1**                               | `browser_state.dialogs[]`.                                                 |
| B4  | Full AX tree with backendNodeId                 | **Partial**                            | **D2**                               | `format:'ax'` option; `[FINDING F-18]` closed role list is the real limit. |
| B5  | Page JS eval, promises, serialization           | Implemented, not adequately verified   | **D1** (verify)                      | Re-verify via `probe:eval` (F: §0.3). Limits stay documented.              |
| B6  | Raw CDP pass-through                            | Not applicable by design               | **NA forever**                       | ADR-02. Never.                                                             |
| B7  | Agent-authored reusable helpers                 | **Missing**                            | **D3**                               | Blocked by ADR-09 security design.                                         |
| B8  | Domain skills (~150 playbooks)                  | **Missing**                            | **D3**                               | Content adoption with MIT attribution.                                     |
| C1  | Coordinate clicks                               | Verified complete                      | D1 (harden)                          | Delivery attestation.                                                      |
| C2  | Framework-aware fill / per-char keys            | **Partial**                            | **D2**                               | Opt-in keyboard-event typing mode.                                         |
| C3  | Physical key model                              | **Partial**                            | D2                                   | Extend only if D2 tests require.                                           |
| C4  | Scroll wheel via CDP                            | **Partial**                            | **D1 (document)** + **D6 (re-test)** | Compositor ceiling is real; DOM scroll is the supported path.              |
| C5  | Drag & drop                                     | **Partial**                            | D6                                   | Re-test per Electron upgrade.                                              |
| C6  | Upload files                                    | **Missing**                            | **D2**                               | **OD-3** (§5.1).                                                           |
| C7  | Native dialogs                                  | **Missing**                            | **D1**                               | Handler + `browser_dialog`, risk-gated.                                    |
| C8  | Iframes / cross-origin frames                   | **Missing**                            | **D2** (scope)                       | Frame targeting for eval/click, if D2 capacity allows.                     |
| C9  | Shadow-DOM recipe                               | Verified complete                      | D1 (doc)                             | `[FINDING F-19]` open roots only — restate the claim honestly.             |
| C10 | Dropdowns recipe                                | Verified complete                      | —                                    | none.                                                                      |
| C11 | `http_get` incl. cloud proxy                    | Not applicable/Deferred                | **NA**                               | Agent-side networking.                                                     |
| D1  | Full-page / beyond-viewport screenshot          | **Partial**                            | **D2**                               | `captureBeyondViewport`.                                                   |
| D2  | `max_dim` downscaling                           | Verified complete                      | D2 (minor)                           | Add `maxDim` pixel-side cap.                                               |
| D3  | Debug click overlay                             | **Missing**                            | **D2**                               | Probe/dev aid only, never in the shipped agent path.                       |
| D4  | Viewport recipe                                 | Partial→Verified                       | **D1 (doc)**                         | Zoom ≠ resize; state it once, correctly.                                   |
| E1  | `wait_for_load` (readyState)                    | **Partial**                            | **D1**                               | Add `until:'ready_state'`.                                                 |
| E2  | `wait_for_element` + visibility                 | Verified complete                      | D1 (minor)                           | Optional visibility toggle.                                                |
| E3  | `wait_for_network_idle` w/ event drain          | **Partial**                            | **D1**                               | Test under SSE/polling; `[FINDING F-6]` is a live hazard here.             |
| E4  | `drain_events` CDP buffer                       | **Missing** (boundary)                 | **NA**                               | Same decision as B6. ADR-02.                                               |
| F1  | Stale-ref identity recovery                     | Verified complete                      | **D1 (verify/fix)**                  | `[FINDING F-2]` may invalidate this row.                                   |
| G1  | Downloads                                       | Verified complete                      | D1 (harden)                          | Race already hardened; keep.                                               |
| G2  | Print-as-PDF                                    | **Missing**                            | **D2**                               | Cheapest new row.                                                          |
| G3  | Network-requests observation                    | **Missing**                            | **D4** (via trace)                   | Observe-only counters already exist; no raw CDP.                           |
| H1  | Local action traces                             | **Partial**                            | **D4**                               | Opt-in JSONL.                                                              |
| H2  | Recordings + video render                       | **Missing**                            | DEF                                  | Privacy-sensitive; consent model first (H3). **OD-8.**                     |
| H3  | Recording consent flow                          | Not applicable yet                     | **D4**                               | Binding prerequisite for H2.                                               |
| I1  | Agent-editable helpers                          | **Missing**                            | **D3**                               | ADR-09.                                                                    |
| I2  | Domain-skill catalog                            | **Missing**                            | **D3**                               | Content, MIT attribution.                                                  |
| I3  | Claude plugin / Codex skill registration        | Deferred                               | DEF                                  | Low value for a bundled app.                                               |
| J1  | MCP stdio server exposing tools                 | Verified complete                      | D1 (harden)                          | Keep 33; adapter must stay client-agnostic.                                |
| J2  | CLI (heredoc exec)                              | Not applicable                         | **NA**                               | D5 CLI is a _launcher_, not an eval CLI.                                   |
| J3  | Doctor/health JSON                              | **Missing**                            | **D1**                               | Same artefact as A4.                                                       |
| K1  | Cloud auth                                      | Not applicable/Deferred                | DEF                                  | OD-7.                                                                      |
| K2  | Protected core                                  | Verified complete                      | D1 (preserve)                        | ADR-09.                                                                    |
| K3  | Telemetry                                       | Not applicable (deliberate)            | **NA**                               | Keep absent.                                                               |
| K4  | Cloud-proxied HTTP helper                       | Not applicable/Deferred                | **NA**                               | OD-7.                                                                      |
| L1  | pytest unit+integration                         | Verified complete (different strategy) | D7                                   | Independent black-box harness.                                             |
| L2  | Windows UTF-8 stdout fix                        | Not applicable                         | **NA**                               | Min is not a CLI.                                                          |
| L3  | Snap doctor workaround                          | Not applicable                         | **NA**                               | Windows target.                                                            |
| L4  | Brave/Chromium origin support                   | Not applicable                         | **NA**                               | Min is its own browser.                                                    |
| L5  | Packaging/CI                                    | Verified complete (Min-specific)       | **D8**                               | Signing, rebuild, matrix.                                                  |
| M1  | Workspace state/config dir                      | Equivalent exists                      | D5                                   | `MIN_AGENT_HOME` model (§4.4).                                             |
| M2  | Internal-page/url filtering                     | **Partial**                            | **D1**                               | Verify `min://` exclusion parity.                                          |
| M3  | `wait(seconds)` helper                          | Not applicable                         | **NA**                               | `browser_wait` covers it.                                                  |
| M4  | Horse-marker tab branding                       | Not applicable                         | **NA**                               | Different product philosophy.                                              |
| M5  | Benchmark / eval methodology                    | Not applicable                         | **NA**                               | Marketing/eval.                                                            |

**Coverage accounting: 61/61 rows mapped. 0 unmapped rows.**

- Implemented in a milestone: **37**
- Not applicable with rationale: **14** (A1, A2, B6, C11, E4, J2, K3, K4, L2, L3, L4, M3, M4, M5)
- Explicitly deferred with a named milestone or open decision: **10** (A5, A7, H2, I3, K1 → OD-7/OD-8; C4/C5 → D6 re-test; B5/B7/B8/I1/I2 → D1/D3)

No "miscellaneous later" bucket exists. Each deferral names a milestone or an open decision.

### 7.3 Open P1-15 items → milestone

| Open item                                                             | Evidence                               | Target                                             |
| --------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| Cannot cancel endless synchronous page JS                             | `:3132-3136`, `:3241`                  | **D1** (document + test) / permanent limit         |
| Strict-CSP `new Function` blocked                                     | `:3184`; P1-15 report                  | **D1** (document) / permanent limit                |
| `verification:'none'` ≠ renderer-delivery ack                         | `:3755-3763`, `:4791-4800`             | **D1** ADR-03 attestation                          |
| Per-tab zoom ≠ window resize                                          | `:3289-3310`                           | **D1** (documented as NA for per-tab)              |
| Element screenshot = visible-area only                                | `:4981`                                | **D2**                                             |
| **Element screenshot may be entirely broken**                         | `[FINDING F-3]`                        | **D1** — resolve the conflict with the P1-15 claim |
| Mouse 28/29, wheel compositor                                         | `:2701`, probe                         | **D1** (doc) + **D6** (re-test)                    |
| Packaged artifacts pre-date P1-15                                     | §0.5, timestamps                       | **D8**, gated on D7                                |
| Linux/VPS unverified                                                  | reported                               | **D8**                                             |
| ia32/arm64 runtime unverified                                         | installers exist; never validated      | **D8**                                             |
| `npm test` lint failures (~1,219 reported)                            | reported                               | **D8**                                             |
| `npm audit` advisories                                                | reported                               | **D8**                                             |
| Unsigned installer / SmartScreen                                      | reported                               | **D8**                                             |
| `qa/` black-box harness not implemented                               | `docs/QA-ARCHITECTURE.md`              | **D7**                                             |
| Batch excluded-tool behaviour                                         | `[FINDING F-1]`                        | **D1**                                             |
| `recoverStale` Promise ref                                            | `[FINDING F-2]`                        | **D1**                                             |
| Batch response lies about `stopOnError`                               | `[FINDING F-4]`                        | **D1**                                             |
| `waitMs` dead parameter                                               | `[FINDING F-5]`                        | **D1**                                             |
| Error codes → HTTP 500                                                | `[FINDING F-7]`                        | **D1**                                             |
| `probe:eval` not npm-discoverable                                     | §0.3                                   | **D1-T1**                                          |
| Stray/unclassified artifacts                                          | §0.4                                   | **D8**                                             |
| Adapter `t0` defect                                                   | `[FINDING F-9]`                        | **D1**                                             |
| Adapter has no retry                                                  | `[FINDING F-12]`                       | **D1/D5**                                          |
| Inertness gap (intervals run when bridge off)                         | `[FINDING F-11]`                       | **D1**                                             |
| `agentRpc.js` header is false                                         | `[FINDING F-15]`, ADR-12               | **D1**                                             |
| `darkMode` old-version finding                                        | §0.2 #8                                | **D1** (recheck source)                            |
| Monolith (5,319 lines, flat dispatch)                                 | ADR-11                                 | **D0 → D1** incremental split                      |
| Typo/corruption in Phase B row A2 (`проблему`)                        | `BROWSER-HARNESS-FEATURE-PARITY.md:27` | **D0** — documentation-only fix, noted not applied |
| Duplicate keys `"provider"` in the user's `~/.opencode/opencode.json` | observed during config validation      | Advisory, outside this repository. Noted only.     |

---

## 8. Ordered milestones

Ordering is dependency-driven. Nothing in D3 may start before D1's attestation design exists; nothing in D8 may be claimed before D7 runs against a fresh build.

### D0 — Baseline, decisions, and documentation contract

- **Covers:** no parity rows implemented. Establishes IDs (§7.1) and the ADR set (§1.2).
- **Depends on:** Phase D (this document).
- **Files:** `docs/audit/*` only.
- **Actions:** freeze the 61 IDs; add `Milestone` + `Phase D target status` columns to the parity matrix in a **separate, controlled documentation task**; correct the `A2` text typo; record the row count.
- **Acceptance:** parity matrix carries stable IDs and a milestone column; register updated append-only.
- **Non-goals:** no source change of any kind.
- **Open afterwards:** all rows.

### D1 — Core observability, truthfulness and reliability

The highest-value milestone. Everything else depends on it being honest.

- **Rows covered:** A4, J3, B1, B3, B5 (verify), B9-style truthfulness, C1, C4 (document), C7, C9 (doc), D4 (doc), E1, E2, E3, F1, G1, J1, K2 (preserve), M2.
- **Findings addressed:** F-1, F-2, F-4, F-5, F-7, F-9, F-11, F-12, F-15, plus §0.3 (`probe:eval` wiring, D1-T1) and the stale header (ADR-12).
- **Modules:** split `main/agentRpc.js` incrementally into the L1/L2 layout (ADR-11) — registry-as-data, errors module, policy module. Incremental, behaviour-preserving, one subsystem at a time.
- **Key changes:**
  1. **ADR-03 three-stage envelope** on every mutating tool: `dispatched`, `delivered`, `verified`, each independently populated and never inferred from another.
  2. **Delivery attestation** via a sandboxed preload + namespaced read-only `contextBridge` channel (`attest.facet.js`). Reports _"the page received a trusted event"_; never claims paint-level truth. Wheel/hover stay permanently `unverified`.
  3. `browser_health` — read-only diagnostics: bridge identity/version, profile path, catalog count, `policy.json` state (booleans only), active grant **count**, download root, filtering enabled, partitions, free disk space, pending permissions count. **Never returns a token, cookie, or URL query.**
  4. `browser_state.dialogs[]` from a main-process `dialog` + `will-prevent-unload` observer (additive, non-interfering), and `browser_dialog` accept/dismiss under the existing grant model.
  5. Complete the code→HTTP status map (F-7); make every structured error distinguishable from an internal crash.
  6. Fix F-1/F-2/F-4/F-5, each with a named regression test.
  7. Wire `probe:eval` into `package.json`; add a single `verify` script that runs the serial suite in the documented order.
  8. Bounded adapter retry for the two Min-restart states only (discovery-missing, connection-refused), capped.
  9. Gate the load-time `setInterval`/listeners behind the `--agent-rpc` flag (F-11).
- **Tests:** unit (validator, errors, policy, attestation), plus `probe:eval`, `probe:mouse`, `probe:pav`, `probe:captcha` (regression for the CAPTCHA correction), `mcp-e2e`, `test:agent-rpc`. Every F-finding gets a test that **fails before and passes after**.
- **Platform:** Windows x64 only. No new platform claim.
- **Non-goals:** no new parity capability; no full file reorganisation; no engine change.
- **Security review points:** attestation channel must be read-only and namespaced; `browser_health` must not leak; batch authorization must hold under `stopOnError:false`.
- **Open afterwards:** everything in D2+.

### D2 — Browser capability parity

- **Rows covered:** C2, C6, C8 (scope), D1, D2, D3, G2, B4.
- **Depends on:** D1 (must be honest before new tools are added).
- **Key changes:** `browser_pdf` (`printToPDF`); `browser_upload` per **OD-3**; opt-in keyboard-event typing mode; full-page/`captureBeyondViewport` screenshot; `maxDim`; debug-click overlay (**probes only**); `format:'ax'` full-tree option; frame targeting if capacity allows.
- **Tests:** each new tool gets a probe; mcp-e2e census grows from 33 → N and every census assertion updates (`mcp-e2e.js:129`, `agent-rpc-test.js:193`, `p111-coldstart-accept`, docs, `SKILL.md`) **in the same change**.
- **Platform:** Windows x64.
- **Non-goals:** no window resize (NA for per-tab); no raw CDP.
- **Open afterwards:** D3+.

### D3 — Extensible agent programming model

- **Rows covered:** B7, B8, I1, I2. K2 preserved.
- **Entry gate:** a written security design (ADR-09) approved **before** any helper can execute. Minimum: resource limits (time, bytes, eval count), a restricted API surface (only the bridge's own typed tools), no host `fs`/`process`/`shell`/`require`, versioned manifests, opt-in per profile.
- **Key changes:** `skills/` versioned built-ins; optional domain-skill catalogue with **MIT attribution**; sandboxed helper workspace with bounded persistence.
- **Tests:** negative tests asserting a helper **cannot** reach host capability; resource-limit enforcement; version-migration tests.
- **Platform:** Windows x64.
- **Non-goals:** no Python; no arbitrary code execution in the host; no plugin marketplace.
- **Open afterwards:** D4+.

### D4 — Observability and recording

- **Rows covered:** H1, H3, G3 (observe-only).
- **Depends on:** D1 error codes and D2 tool set.
- **Key changes:** opt-in per-session JSONL action trace; redaction **at write time**; bounded retention; explicit purge; screenshot metadata + hash; consent prompt and recorded preference.
- **Tests:** redaction unit tests (token, `Authorization`, `Set-Cookie`, `cf_clearance`, sensitive input values, URL query/hash); consent-default-off test; retention/purge test.
- **Platform:** Windows x64.
- **Non-goals:** **no video** (H2/OD-8); no telemetry (K3 stays NA).

### D5 — Multi-agent distribution and integration

- **Rows covered:** A3, A6, M1, plus F-12/F-13/F-14.
- **Depends on:** D1 (health), D4 (profile-scoped trace dirs).
- **Key changes:** `min-agent` CLI (`launch`, `status`, `doctor`, `stop`, `profile create|list|migrate|purge`, `client install`); the single shared profile-resolution function (§4.4); `agent.lock` with PID+start-time validation; PATH shim installed by the installer; `MIN_AGENT_HOME`; space-containing-path tests.
- **Client validation:** the OpenCode 1.19.2 schema is validated (§4.6). `claude mcp add` and Cursor remain **"config-only, untested"** (`mcp/README.md:62-64`) until a live test promotes them.
- **Tests:** two concurrent agents on two profiles with no cross-talk; duplicate-launch refusal; stale-lock self-heal; crash-then-restart under a running agent; upgrade preserves profiles; uninstall preserves profiles; space-in-path round trip.
- **Platform:** Windows x64; PATH/quoting behaviour explicitly Windows-verified.
- **Non-goals:** no auto-spawn by default; no shared-session default.
- **Open afterwards:** D6+.

### D6 — Engine and runtime compatibility

- **Rows covered:** C4, C5 (re-test); Novellive case.
- **Depends on:** D7 harness exists to give an independent verdict; D1 truthfulness to measure it honestly.
- **Key changes:** an Electron upgrade cadence (patch-minor security cadence + a Chromium-version-gap review each quarter); a controlled upgrade experiment (§9.2); regression matrix across the supported matrix; re-test wheel/drag delivery on the new engine; record a Chromium-version delta in `browser_status` output.
- **Explicitly deferred:** native Chromium patch set — stays deferred unless a reproducible requirement appears **and** a cost/maintenance case is written. ADR-06.
- **Tests:** full suite on each candidate Electron before promotion; profile-migration check; performance delta (cold start, snapshot latency, capture latency) recorded with numbers.
- **Platform:** Windows x64 primary; the matrix states exactly what was tested.
- **Non-goals:** no fork; no fingerprint work; no version change in Phase D.

### D7 — Independent black-box acceptance harness

- **Rows covered:** L1.
- **Depends on:** a **fresh** build containing D1–D5 (not the stale `dist/app`).
- **Key changes:** implement `docs/QA-ARCHITECTURE.md` as designed — `qa/acceptance/qa-launcher.js` (own PID, temp profile per run), `qa-mcp-client.js` (drives the **shipped** `resources/app/mcp/min-agent-mcp.js`), `qa-acceptance.js` (the 10 declared scenarios), local artifacts only.
- **Acceptance:** cold start with 33+ tools and no preload errors; navigation/content/snapshot; real image bytes with PNG/JPEG magic + metadata; semantic workflow; **visual fallback workflow with two non-memorisable fixture variants**; CAPTCHA policy (detection reported, unrelated controls clickable, detection ≠ clearance); transforms apply/verify/restore; downloads terminal + hostile-`relPath` rejection; recovery; **leak check — zero orphaned processes from the run**.
- **Security:** per-run token, only its length logged; targeted `/PID` termination only; nothing recorded.
- **Platform:** the packaged artifact on the host under test; **no cross-platform claim without a host per platform**.
- **Non-goals:** development probes are never the sole pass/fail authority.

### D8 — Release readiness

- **Rows covered:** L5, A7 (if macOS is ever claimed).
- **Depends on:** D7 green against a fresh build.
- **Key changes:** rebuild all installers **after** D1–D5; runtime-validate the packaged artifact; decide which platforms are **actually** claimed (x64 Windows is the only one with evidence today; ia32/arm64 exist as artifacts but are unvalidated; Linux/VPS unvalidated); code signing / SmartScreen decision; version and config migration; documentation including an honest known-limitations page.
- **Test-surface debt:** `probe:eval` discoverability verified; artifact policy decided (§0.4 — de-duplicate the 19-of-20 identical `docs/p110-runs` PNGs, classify the patch-provenance scripts, retire the `.patched` sentinel and the `tmp-*` scratch file); decide whether the one-shot patch scripts are archived or deleted **with a register note**, since `p112-fix-scanners.js` is cited by two audit documents.
- **Lint/audit:** triage the reported ~1,219 `standard` findings and `npm audit` advisories by severity and ownership — inherited vs introduced. Do not suppress silently.
- **Non-goals:** no new features; no signature forgery; no platform claims without evidence.
- **Open afterwards:** the honest known-limitations list becomes the release note.

---

## 9. Novellive — named compatibility acceptance case

### 9.1 Standing rules

Design for **diagnostics**, never for evasion. Prohibited in this and every subsequent milestone: stealth patches, fingerprint spoofing, token forgery, proxy rotation, CAPTCHA-solving services, permanently disabling the ad blocker, or copying cookies/tokens between profiles. A legitimate challenge may still require provider-side verification or human assistance, and that is an acceptable outcome.

**Vocabulary stays separated (register §5):** (1) detection, (2) ordinary interaction during a challenge, (3) user-assisted completion + independently verified clearance, (4) compatibility changes that reduce false positives, (5) external providers, (6) engine consistency. This architecture delivers (1), (2), (4) and reporting for (6). It does not claim (3) or (5).

### 9.2 Controlled Electron upgrade experiment (D6)

```
BASELINE   Electron 43.4.1 / Chromium 150.0.7871.224      [REPORT, Phase C]
           fresh temp profile, same host, same network, same exact URL
           record: elapsed-to-transition, HTTP status, cf-* response headers,
                   sanitized console errors, sanitized network outcomes,
                   whether challenges.cloudflare.com requests were BLOCKED
CONTROL    installed Chrome, fresh temp profile               [REPORT: cleared ~3 s]
           same host/network/URL; record only to characterise the gap
TREATMENT  Electron N+1 (latest stable), freshly built, fresh temp profile,
           identical instrumentation, no other variable changed
COMPARE    T0=time-to-transition; blocked-resource set; console error set;
           UA/client-hints; TLS/HTTP2 signature *captured, not spoofed*
DECIDE     (a) T0 normalises → engine gap confirmed, promote the upgrade
           (b) T0 unchanged → H1 falsified; escalate to H2/H3/H9/H10
                 (filtering, 3p cookie/iframe, CDP exposure, IP reputation)
           (c) partial → keep both hypotheses open; do NOT ship a "fix" story
```

**Explicitly not promised:** that an Electron upgrade solves it. The experiment is designed so that a negative result is as informative as a positive one, and the report will state which hypotheses were eliminated as well as which survived.

### 9.3 Diagnostics the architecture must support (no new capability beyond §6.2's additive-listener rule)

| Need                                    | Available today                                                                                                     | Gap                                                                     | D                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Which requests were blocked and by what | `agentRpcNetworkRequestBlocked/Settled` called from `main/filtering.js:193-254`; single `onBeforeRequest` at `:293` | No agent-facing view of _why_ a request was blocked                     | D4 trace                                                                  |
| Console errors                          | not bridged                                                                                                         | **No console bridge exists**                                            | D1 (sanitized, opt-in)                                                    |
| Page/frame state during challenge       | `browser_state` captcha classification `:1507-1552`, blocked-signal `:4009-4015`                                    | Challenge iframe is invisible to main-frame `browser_eval` (Phase C §5) | D1 (diagnostic-only observation, no iframe targeting unless D2 grants it) |
| Browser/engine version                  | `browser_status` reports Chromium                                                                                   | —                                                                       | D1 (expose the delta explicitly)                                          |
| Profile cleanliness                     | fresh temp profiles per run                                                                                         | —                                                                       | exists                                                                    |

### 9.4 Acceptance

Either **(a)** the legitimate verification flow completes under comparable conditions with the transition independently checked from resulting-page evidence (not a vanished spinner), or **(b)** a specific unresolved limitation is documented with sanitized evidence plus an honest user-assisted fallback (e.g. "use Chrome for this domain"). Neither outcome permits a claim of CAPTCHA solving or universal bypass.

---

## 10. Risk, dependency, trade-off and open-decision register

### 10.1 Risks

| ID   | Risk                                                                                                                                                                       | Impact                                                   | Likelihood              | Mitigation                                                                                         | Owner milestone |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- | --------------- |
| R-1  | A `[FINDING]` from §2.4 is real and invalidates a reported passing feature (F-2 stale-ref, F-3 element screenshot)                                                         | Reported evidence credibility                            | Medium                  | Each finding gets a failing-then-passing test in D1; the register re-states affected rows honestly | D1              |
| R-2  | Monolith growth during D2 (≈8 new tools into a 5,319-line file)                                                                                                            | Reviewability, security audit quality                    | **High**                | ADR-11 modular split precedes new tools                                                            | D1              |
| R-3  | Attribution error: a "Verified complete" claim that rests on a probe that cannot be re-run (`probe:eval`)                                                                  | False green                                              | **High**                | D1-T1 + a single serial `verify` entry point                                                       | D1              |
| R-4  | Electron upgrade regresses something (probes, filtering, key mapping)                                                                                                      | Product breakage                                         | Medium                  | Full suite per candidate + performance deltas + profile-migration check before promotion           | D6              |
| R-5  | Packaged artifact diverges from source again (already happened once, §0.5)                                                                                                 | Release ships stale capability                           | Medium                  | D7 gate: acceptance only against a build whose commit/state is recorded                            | D7/D8           |
| R-6  | Multi-agent shared-profile misuse despite policy                                                                                                                           | Cross-agent tab/ref chaos, possible wrong-target actions | Medium                  | Opt-in env var + loud `sharedSession` warning + `sessionId` on results                             | D5              |
| R-7  | Long calls vs client timeouts (OpenCode default 5000 ms, validated)                                                                                                        | Silent failures for users on default config              | **High if unaddressed** | Documented `timeout` in every example config; surface adapter-side timing in D1                    | D5              |
| R-8  | Novellive hypothesis H1 falsified and no clean cause found                                                                                                                 | Compatibility gap persists                               | Medium                  | Experiment designed for negative results; H2–H6 kept open                                          | D6              |
| R-9  | Recording/trace leaks page content                                                                                                                                         | Privacy harm                                             | Low (opt-in)            | Redaction at write time + consent + retention + purge; negative tests                              | D4              |
| R-10 | Unverified upstream bodies (`admin.py`, `daemon.py`, `auth.py`, `recorder.py`, `video*.py`, `telemetry.py`, `_ipc.py`, many test/skill bodies) quietly treated as complete | Parity claims overstated                                 | Medium                  | They remain **Unverified (bodies)**; D3 must read the bodies it actually intends to adopt          | D3              |
| R-11 | Scope creep back into stealth/fingerprint work                                                                                                                             | Legal, ethical, licensing exposure                       | Medium                  | ADR-06/ADR-07 + §6.3 licensing record                                                              | D6              |
| R-12 | ia32/arm64 artifacts imply support that was never validated                                                                                                                | False platform claim                                     | Medium                  | D8 states exactly which platforms are claimed                                                      | D8              |

### 10.2 Open decisions

| ID        | Decision                                                                                                                          | Needed by    | Default if undecided                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| **OD-1**  | Is a shared profile between two concurrent agents ever supported, or permanently unsupported?                                     | D5           | Unsupported. Opt-in flag only.                                                                        |
| **OD-2**  | Does `browser_viewport` ever gain true window-dimension control, or is per-tab zoom the permanent contract?                       | D2           | Zoom is the contract; window resize is NA for per-tab semantics.                                      |
| **OD-3**  | Upload executor: allowlisted single CDP command (upstream-parity) vs human-driven chooser (no new privilege)?                     | **D2 start** | Allowlisted CDP command reusing the download path validator, restricted to `<profile>/agent-uploads`. |
| **OD-4**  | Delivery attestation: is `contextBridge` in the sandboxed preload acceptable, or must the read-only channel be another mechanism? | **D1**       | Namespaced read-only `contextBridge`, negative-tested against host capability.                        |
| **OD-5**  | Frame targeting (C8) in or out of D2?                                                                                             | D2           | Out if it jeopardises the census/QA schedule; recorded as deferred, not dropped.                      |
| **OD-6**  | Which platforms does the product **claim** in release notes — Windows x64 only, or also ia32/arm64/Linux?                         | **D8**       | Windows x64 only. Nothing else is claimed until a host validates it.                                  |
| **OD-7**  | Will any external/cloud provider ever be integrated (A5, K1, K4)?                                                                 | Post-D8      | No. Boundary documented and unused.                                                                   |
| **OD-8**  | Video recording (H2) — ever, or permanently declined?                                                                             | D4           | Deferred; consent model (H3) ships first if at all.                                                   |
| **OD-9**  | Artifact policy: commit generated evidence, or curate and ignore volatile raws?                                                   | D8           | Curate; keep audit-cited files.                                                                       |
| **OD-10** | When to split `main/agentRpc.js` further — before every subsequent milestone, or one full refactor?                               | D1           | Incremental, behaviour-preserving, subsystem by subsystem.                                            |

### 10.3 Dependency chains that constrain ordering

```
D1 (truthfulness + errors + modules)
 ├──> D2 (new tools)  ──┐
 ├──> D3 (helper security needs the attestation/limits model)
 ├──> D4 (trace schema needs stable error codes)
 └──> D5 (CLI/doctor needs health; adapter retry needs D1)

D6 (engine upgrade) ── needs D7 to give an independent verdict
D7 (black-box QA)  ── needs a FRESH build (D8 rebuild), NOT dist/app as it stands
D8 (release)       ── needs D7 green
```

**The single most important sequencing fact: D7 must not be run against the artifacts currently in `dist/app`, because they predate every P1-15 change.**

---

## 11. What remains unverified after Phase D

Carried forward unchanged, using the register's vocabulary:

- **Unverified (bodies)** — Browser Harness `admin.py`, `daemon.py`, `auth.py`, `recorder.py`, `video*.py`, `telemetry.py`, `_ipc.py`, individual `tests/unit/*` bodies, and remaining `interaction-skills/*.md` bodies. **Not upgraded to complete.** Must be read before D3 adopts any of it.
- **Unverified (upstream coverage)** — no claim of complete upstream-source coverage or full parity.
- **Unverified (reported results)** — every test count in this document (`probe:eval 22/22`, MCP E2E 56/56, RPC 182/182, updater 18/18, transform 18/18, tabs 16/16, waits 16/16, downloads 33/33, CAPTCHA 19/19, PAV 18/18, proctools 9/9, smoke 6/6, mouse 28/29) is **[REPORT]**, carried forward unchanged. **None was re-executed in Phase D.** Phase D executed no probes, started no Electron instance, and terminated no process.
- **Unverified** — the 20 `[FINDING]` items in §2.4 require reproduction tests before they are defects or dismissed.
- **Unverified** — practical behaviour of `safeDialogs:true` for agent workflows (`main/viewManager.js:15`).
- **Unverified** — the old `darkMode: 1 ⇒ nativeTheme.themeSource='dark'` finding against current source.
- **Unverified** — Linux/VPS, ia32, arm64 runtime behaviour. No packaged-artifact runtime validation has occurred since P1-15.
- **Unverified** — the OpenCode 5-second default-timeout behaviour was read from the schema; it has **not** been observed against a live long-running Min call. Scheduled for D5.
- **Deferred** — raw CDP / event drain (B6, E4), permanently declined by ADR-02.
- **Deferred** — native Chromium patch set, behind an evidence bar (ADR-06).
- **Deferred** — video recording (H2/OD-8), external providers (OD-7), macOS accessibility helper (A7).

---

## 12. Phase D file inventory

**Created (2 files, documentation only):**

| Path                                                    | Bytes     | Note                                                        |
| ------------------------------------------------------- | --------- | ----------------------------------------------------------- |
| `docs/audit/INTEGRATED-TARGET-ARCHITECTURE.md`          | this file | new                                                         |
| `docs/audit/Min-Agent-Edition-Master-Scope-Register.md` | appended  | **append-only**; every prior phase block preserved verbatim |

**Not modified:** `main/agentRpc.js`, `mcp/min-agent-mcp.js`, `scripts/**`, `package.json`, `SKILL.md`, `docs/audit/BROWSER-HARNESS-FEATURE-PARITY.md`, `docs/audit/CLOAKBROWSER-PHASE-C-INVESTIGATION.md`, `docs/audit/P1-15-AGENT-NATIVE-CAPABILITIES.md`, `docs/QA-ARCHITECTURE.md`, `dist/**`, and every other existing file.

**Not performed:** no stage, no commit, no push, no tag, no reset, no revert, no cleanup, no deletion of any file, no Electron version change, no probe execution, no process termination, no CloakBrowser binary installed/executed/bundled, no parity-matrix edit.

---

**Phase D status: COMPLETE (architecture + roadmap).** Next: **Phase E — Milestone implementation and acceptance**, beginning with **D0 → D1**. Awaiting explicit instruction.
