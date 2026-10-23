# Test Strategy and Coverage — Min Agent Edition

Policy added 2026-10-19. **Deterministic tests stay the authority for fault isolation; every user-visible browser capability must also have a real-web acceptance test. Run tests by change impact; run the broad suite for large, cross-cutting or security-sensitive changes.**

Evidence labels used throughout:

| Label            | Meaning                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| **[RUN]**        | Executed during this task; the result quoted is what was observed now.                             |
| **[REPORT]**     | From a prior phase report (P1-15 / D1 / D2). Not re-executed here.                                 |
| **[UNVERIFIED]** | Claimed but not established. Must not be treated as passing.                                       |
| **[FLAKY]**      | Observed to vary across identical runs. Never quoted as a single pass.                             |
| **[BLOCKED]**    | Could not be evaluated (network, site, automation restriction, missing artifact). Reason recorded. |

---

## 1. Test inventory

42 executable files under `scripts/` plus 3 fixture mains. Classified by layer:

**A — fast deterministic (no browser, no Electron):**

| File                                                                         | Contract it covers                                                                                                                                                                                                                                | Does NOT cover           | Latest                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------- |
| `scripts/agent-rpc-test.js`                                                  | transport auth, Host/Origin guard, schema validation, unknown-key rejection, dispatch registry, batch exclusion + validator-bypass protections (D1-F1/F1b), stale-ref recovery (D1-F2), HTTP status map (D1-F7), `waitMs`, delivery-stage honesty | real Electron; real page | **[RUN] 217/217 exit 0**     |
| `scripts/proctools-test.js`                                                  | tracked-PID `killTree`, `spawnTracked` unbuffered stdio, readiness polling that never masks failure, `tabsStablePredicate`                                                                                                                        | the probes that use them | **[RUN] 9/9 exit 0**         |
| `scripts/p1-07-updater-test.js`                                              | filter-list updater resilience (local HTTP fixtures)                                                                                                                                                                                              | packaged updater         | **[REPORT] 18/18**           |
| `scripts/p112-publish-set.js`, `p112-secret-scan.js`, `p112-fix-scanners.js` | publish-set enumeration, secret scanning                                                                                                                                                                                                          | browser behaviour        | **[REPORT]** 0 hard findings |

**B — real browser / MCP integration on controlled fixtures:**

| File                                                                                                                                                                                               | Contract                                                                                                                                                                                                                                                                                    | Known limits                                             | Latest                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `scripts/mcp-e2e.js`                                                                                                                                                                               | shipped adapter over stdio: 35-tool census, dispatch, batch refusal, screenshot ladder, element crop (D1-F3), eval, D2-A delivery stages, D2-B health, D2-C ready_state/dialogs, D2-D SSE network-idle, D2-E metadata, single `onBeforeRequest`, token never on stderr, transcript scrubbed | local `file://` and a local SSE server only              | **[RUN] 93/93 exit 0**                                    |
| `scripts/agent-eval-probe.js`                                                                                                                                                                      | `browser_eval`: DOM/canvas/ImageData, promises, errors, truncation, tab targeting, no Node leak                                                                                                                                                                                             | real-web pages                                           | **[RUN] 22/22 exit 0**                                    |
| `scripts/agent-captcha-probe.js`                                                                                                                                                                   | detection is informational; challenge control clickable; detection ≠ clearance                                                                                                                                                                                                              | real challenges (deliberately not automated)             | **[RUN] 19/19 exit 0**                                    |
| `scripts/agent-tabs-probe.js`                                                                                                                                                                      | tab model, attach/select/close                                                                                                                                                                                                                                                              | —                                                        | **[RUN] 16/16 exit 0**                                    |
| `scripts/agent-inputs-probe.js`                                                                                                                                                                    | click/type/press/select semantics, sensitive fields                                                                                                                                                                                                                                         | compositor paint                                         | **[RUN] 20/20 exit 0**                                    |
| `scripts/agent-waits-probe.js`                                                                                                                                                                     | `network_idle` window semantics, selector waits, bounded timeouts                                                                                                                                                                                                                           | —                                                        | **[RUN] 16/16 exit 0**                                    |
| `scripts/agent-downloads-probe.js`                                                                                                                                                                 | managed download lifecycle, `relPath` policy, no process leak                                                                                                                                                                                                                               | —                                                        | **[RUN] 33/33 exit 0**                                    |
| `scripts/agent-transform-probe.js`                                                                                                                                                                 | transforms, drift, restore                                                                                                                                                                                                                                                                  | —                                                        | **[RUN] 18/18 exit 0**                                    |
| `scripts/agent-pav-probe.js`                                                                                                                                                                       | provenance/attachment/verification across navigation                                                                                                                                                                                                                                        | —                                                        | **[RUN] 18/18 exit 0**                                    |
| `scripts/agent-mouse-probe.js`                                                                                                                                                                     | coordinate mouse, drag, wheel                                                                                                                                                                                                                                                               | **hover is [FLAKY]**; wheel always dropped by compositor | **[RUN] 27–29/29 across identical runs; [FLAKY]**         |
| `scripts/p110-api-matrix.js`                                                                                                                                                                       | declared API scenario matrix incl. CAPTCHA policy                                                                                                                                                                                                                                           | agent reasoning                                          | **[RUN] 93 pass, 0 fail**                                 |
| `scripts/agent-snapshot-probe.js`, `agent-actions-probe.js`, `agent-nps-probe.js`, `agent-rpc-probe.js`, `capture-page-probe.js`, `detach-probe.js`, `two-url-argv-probe.js`, `extension-probe.js` | historical snapshot/actions/NPS/capture/detach/argv/extension contracts                                                                                                                                                                                                                     | —                                                        | **[REPORT]** / **[UNVERIFIED]** — not re-run in this task |

**C — real-web acceptance (NEW):** `scripts/realweb-accept.js` — see §3. **[RUN] 15 pass / 0 fail / 1 blocked, exit 0.**

**D — packaged acceptance:** `scripts/p111-coldstart-accept.js`, `p111-packaged-filter-test.js`, `p1111-coexistence.js`, `p111-space-path-test.js`, `p1131-packaged-captcha-check.js`, `scripts/smoke-baseline.js`. **`dist/app` predates P1-15, D1 and D2 — none of these may be cited as current evidence.**

**One-off diagnostics (not regression gates):** `p115-*` patch-application scripts, `p115-novellive-*`, `p110-dbg-*`, `p110-keeper.js`, `tmp-m4-grep.js`, `mcp-e2e.js.patched`.

**Not inspected in this task [UNVERIFIED]:** `agent-nps-probe.js`, `agent-rpc-probe.js`, `capture-page-probe.js`, `detach-probe.js`, `two-url-argv-probe.js`, `extension-probe.js`, `p110-agent-step.js`, `p110-lib.js` internals, `p111-*` internals, `smoke-baseline.js` internals. They are inventoried by name and size only; their assertions were not read line by line.

---

## 2. Test layers and when each runs

| Layer                              | Cost              | Determinism                    | Runs                                                                                                    |
| ---------------------------------- | ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **A** fast deterministic           | seconds           | high                           | on every change to the matching module                                                                  |
| **B** real-browser/MCP on fixtures | 1–5 min           | high (local fixtures)          | on every change to the affected capability                                                              |
| **C** real-web acceptance          | ~2–4 min, network | **medium** (third-party drift) | on any user-visible browsing/navigation/render/wait/download change; opt-in via `npm run probe:realweb` |
| **D** packaged acceptance          | minutes + build   | medium                         | only when packaging/preload/engine/startup changes, and **only against a fresh build**                  |
| **E** full-system regression       | 20–40 min         | —                              | on the triggers below                                                                                   |

A local fixture is **not** a real-world acceptance test. `mcp-e2e` proves the contract on a `file://` page; `realweb-accept` proves it on the live web. Both are required for a capability to be called covered.

---

## 3. Real-web coverage matrix

Sites are recorded with purpose, last-checked date and fallback in `scripts/realweb-accept.js` (`--list`).

| Capability                     | Deterministic (A) | Real-browser (B)                 | Real-web (C)                          | Full-suite trigger | Evidence asserted                                             | Status                                                  |
| ------------------------------ | ----------------- | -------------------------------- | ------------------------------------- | ------------------ | ------------------------------------------------------------- | ------------------------------------------------------- |
| Navigation + title/URL         | rpc-unit          | mcp-e2e                          | `example.com`                         | agentRpc           | `verified`, `finalUrl`, `title`                               | **Covered**                                             |
| Redirects                      | —                 | mcp-e2e (local 302)              | `httpbin.org/redirect/2`              | agentRpc           | final URL reaches `/get`                                      | **Covered**                                             |
| Content / exact public text    | —                 | mcp-e2e                          | `httpbin.org/html`                    | —                  | "Herman Melville / Moby-Dick" observed                        | **Covered**                                             |
| Snapshot + locator             | rpc-unit (schema) | mcp-e2e, tabs                    | `example.com`                         | agentRpc           | ≥1 link ref; selector+text verify                             | **Covered**                                             |
| Page-context eval              | rpc-unit          | probe:eval                       | `httpbin.org/html`                    | agentRpc/preload   | h1 text + p-count, `executionContext`                         | **Covered**                                             |
| Canvas inspection              | —                 | probe:eval                       | `w3schools.com/html/html5_canvas.asp` | preload            | live `<canvas>` 270×160, 64 px bytes                          | **Covered**                                             |
| Click delivery stages          | rpc-unit          | inputs, mcp-e2e                  | `httpbin.org/forms/post`              | preload            | `dispatched`/`delivery`/`verified` distinct                   | **Covered**                                             |
| Type + verification            | rpc-unit          | inputs, **keyboard**             | `httpbin.org/forms/post`              | agentRpc           | value verified (form **never submitted**)                     | **Covered**                                             |
| Press + delivery               | rpc-unit          | inputs                           | `httpbin.org/forms/post`              | preload            | `delivery:"attested"` on a real page                          | **Covered**                                             |
| Hover                          | —                 | mouse **[FLAKY]**                | forms/post (dispatch only)            | preload            | dispatched; page effect **not** asserted                      | **Partial**                                             |
| Wheel / drag                   | —                 | mouse (wheel always fails)       | not attempted                         | —                  | compositor drop is a platform limit                           | **Partial — documented limit**                          |
| Screenshot + metadata          | —                 | mcp-e2e                          | `example.com`                         | agentRpc           | real PNG bytes, `source`, `scaled`, `ladder`                  | **Covered**                                             |
| Element crop                   | —                 | mcp-e2e                          | `example.com`                         | agentRpc           | crop smaller than full; `cropLimited` label                   | **Covered**                                             |
| Viewport / zoom                | rpc-unit          | mcp-e2e                          | —                                     | agentRpc           | cssPerPixel                                                   | **Covered (zoom only; resize is NA)**                   |
| Batch semantics + security     | rpc-unit          | mcp-e2e                          | —                                     | **always full**    | excluded grant refused under `stopOnError:false`; no dispatch | **Covered**                                             |
| Stale-ref recovery             | rpc-unit          | —                                | —                                     | agentRpc           | unique recovery + ambiguous refusal                           | **Covered (A only)**                                    |
| Network idle incl. SSE         | rpc-unit (schema) | mcp-e2e (local SSE)              | `httpbin.org/delay/1`                 | agentRpc           | `satisfied`, `drained`, `openLongLived`                       | **Covered**                                             |
| ready_state                    | —                 | mcp-e2e                          | `httpbin.org/html`                    | agentRpc           | `readyState` reaches complete                                 | **Covered**                                             |
| Dialog state                   | —                 | mcp-e2e                          | —                                     | preload            | `observed:false` + honest note                                | **Partial (deliberate)**                                |
| Downloads                      | rpc-unit          | downloads                        | `httpbin.org/bytes/2048`              | agentRpc           | terminal `completed`, 2048 bytes                              | **Covered**                                             |
| Uploads                        | —                 | —                                | —                                     | —                  | not implemented (OD-3, D5)                                    | **Not applicable yet**                                  |
| Transforms + restore           | —                 | transform                        | —                                     | agentRpc           | apply/verify/restore                                          | **Covered (B only)**                                    |
| CAPTCHA detection vs clearance | —                 | captcha, api-matrix              | **[BLOCKED]** see below               | **always full**    | detection≠clearance; no blanket block                         | **Covered by B; C blocked**                             |
| Health / profile selection     | rpc-unit          | mcp-e2e                          | `local` (temp profile)                | agentRpc           | `overall`, profile path, no token                             | **Covered**                                             |
| Filter/updater                 | updater           | mcp-e2e (single onBeforeRequest) | —                                     | filtering.js       | handler count = 1                                             | **Covered (A/B)**                                       |
| Startup / shutdown / isolation | —                 | smoke                            | —                                     | build/main         | build+launch+tab+clean teardown                               | **Covered (dev build); packaged [BLOCKED: stale dist]** |

**CAPTCHA on the real web is deliberately [BLOCKED].** Routine acceptance does not attack a third-party challenge; doing so would be automating an access control. Detection-vs-clearance is covered deterministically (`probe:captcha`, `api-matrix`) and the Novellive Cloudflare case stays a separate diagnostic (D6).

---

## 4. Flakiness and site-failure handling

- **`probe:mouse` hover is [FLAKY]**: 27, 27, 28, 28, 29 across five identical builds. Never quote one run as a pass. The wheel failure is deterministic (compositor drop).
- Outcomes are classified as: **product failure**, **platform limitation**, **upstream site drift**, **network failure**, **rate limit**, **challenge/block**, **harness failure**. The Layer C harness distinguishes `PASS`/`FAIL`/`BLOCKED` and its failure text names the likely cause.
- **Observed real drift (this task):** `example.com` no longer contains an `<h1>`; it is now a single `<p>`. An earlier draft of the Layer C harness assumed `<h1>` and failed. The assertion was corrected to use the real, stable element — the **product was never at fault**. This is exactly the "report external drift rather than hiding it" case.
- No blind retries. Layer C has no retry loop; a `BLOCKED` result is reported with its cause.
- Evidence: `docs/realweb-accept.json` holds only ids, statuses and bounded detail strings — no cookies, tokens, headers or page bodies.
- **Artifact retention:** probe output JSON under `docs/` is regenerated evidence (tracked); `docs/p110-runs/*.png` accumulates duplicates (D8/OD-9 owns de-duplication). Nothing was deleted in this task.

---

## 5. Commands

```
npm run test:agent-rpc      # Layer A, bridge
node scripts/proctools-test.js
node scripts/test-impact.js                 # plan for the current working tree
node scripts/test-impact.js --run           # run the selected suites, serially
node scripts/test-impact.js --all --run     # full suite
npm run probe:realweb                       # Layer C (network, opt-in)
npm run probe:realweb -- --only=nav,eval    # a subset
node scripts/realweb-accept.js --list       # candidate sites
```

Prerequisites: Node 24.x, `node_modules` installed, no other Min instance on the same temp profile. All browser suites use a dedicated temp profile and finish with `/PID`-targeted cleanup; **never** use `/IM` kills.

---

## 6. Policy for interpreting labels

`[RUN]` is the only label that may be quoted as current evidence. `[REPORT]` must be re-run before it is relied on. `[FLAKY]` must be quoted with its range, never a single number. `[BLOCKED]` is not a pass and not a failure — it is an unrun check with a stated reason and an owner milestone.

---

## 7. Gaps and owners

| Gap                                                            | Owner                                     |
| -------------------------------------------------------------- | ----------------------------------------- |
| Packaged acceptance (Layer D) not run against a current build  | **D8**                                    |
| Hover/wheel compositor limits; hover flakiness uncharacterised | **D6** (engine)                           |
| Upload acceptance (no upload tool)                             | **D5 / OD-3**                             |
| Real-web CAPTCHA acceptance                                    | deliberately excluded; D6 diagnostic only |
| Stale-ref recovery has A-layer coverage only (no B/C)          | D3                                        |
| Transforms have B coverage only                                | D3                                        |
| 12 historical probes inventoried by name only                  | next task that touches them               |
| `docs/p110-runs` duplicate-image accumulation                  | **D8 / OD-9**                             |

---

## D3-A addition (2026-10-19)

New Layer B probe: `npm run probe:keyboard` (`scripts/agent-keyboard-probe.js`, 21 checks) covering native vs keyboard typing modes, trusted-key-event proof, framework-controlled fields, Unicode honesty (`physicalKeys:false`), replacement semantics, disabled/read-only refusal, stale refs, the 200-char bound and sensitive-field gating.

It found a real defect: typing into a `readonly` input **mutated its value** because Electron's synthetic input path ignores `readonly`. Fixed by reporting `readOnly` on snapshot nodes and refusing such targets with a structured `readonly` (HTTP 409) category. The D1-F7 mapping-completeness test caught the missing status code before it shipped.

## Real-web typing acceptance is unchanged and still runs through `probe:realweb` (`input.type` on the public test form, never submitted).

## ADR-09 Option C addition (2026-10-19)

Two curated **read-only** built-ins are now covered at all three layers:

| Capability            | Layer A                                            | Layer B                                                             | Layer C                                                                     |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| page_summary          | gent-rpc-test layer 5 (catalogue/allowlist/schema) |
| pm run probe:helper   | probe:realweb --only=helper on example.com         |
| orm_control_inventory | same                                               | probe:helper (password/email sentinels, no value or length leakage) | probe:realweb on httpbin.org/forms/post (13 real controls, never submitted) |

New suite probe-helper →
pm run probe:helper. Impact map routes scripts/agent-helper-probe.js, and both main/agentRpc.js and mcp/min-agent-mcp.js now include probe-helper.

**Snapshot-model finding:** the snapshot node reports
eadOnly:false for an element whose
eadOnly is rue in the page world. orm_control_inventory therefore reports
eadOnly as a boolean but **does not claim it reliable**; the probe asserts only disabled. This belongs to parity row **B4** (AX/snapshot model).

---

## Post-Option-C readonly gate (2026-10-19)

**readOnly is now tri-state** in the snapshot and helper projections: rue when the DOM establishes it, alse only when it establishes the negative, **
ull when unknown** — never a silent alse. Layer A locks this (RO-1…RO-7).

**Action guard changed:** rowser*type now prefers an authoritative **live** value (
eadOnlyLive, read from the actual element in locate mode) over the cached snapshot flag, and refuses
eadonly in **both** native and keyboard modes. Proven by probe:keyboard STALE cases: a field made readonly \_after* the snapshot is refused and its value is unchanged (:"zz").

**Layer C readonly: [BLOCKED].** No stable public page exposes a live readonly control (httpbin.org/forms/post: 0; W3Schools form-attributes:
eadonly only inside code samples). Recorded explicitly rather than passed; Layer B carries the coverage.

**mcp-e2e intermittency:** 5/5 serial runs at 93/93 in this task (plus 4/5 in the prior report = 9/10 green). The single original failure was not reproduced and its assertion is not recoverable from the transcript (which records tool calls, not failures). Recorded as **intermittent/unresolved**, not fixed.
