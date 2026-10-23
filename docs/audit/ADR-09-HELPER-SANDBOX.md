# ADR-09 — Agent Helper / Domain-Skill Sandbox (Design Gate)

**Status: PROPOSED — DESIGN ONLY. NOT APPROVED. NO HELPER RUNTIME IS IMPLEMENTED.**

Date: 2026-10-19 · Phase E design gate · **no application code, tests, probes or processes were touched by this document.**

This ADR exists because the integrated architecture makes agent extensibility (Browser Harness parity rows **B7, B8, I1, I2**) the content of **architecture-D3**, and gates it behind a written security design. That gate is this document.

> **Read this first — it prevents the exact confusion that already happened once.**
> "**prompt D3**" (the D3-A…G implementation prompt) and "**architecture D3**" are **different things**.
> Architecture-D3 = the helper workspace this ADR governs. prompt-D3-A…G = Browser Harness _parity_ rows owned by other milestones. See §1.

---

## 1. Milestone crosswalk (Part A) — authoritative

Stable feature IDs are the `ID` column of `docs/audit/BROWSER-HARNESS-FEATURE-PARITY.md`. **IDs are not renumbered or renamed here.** Where a prior prompt label misdescribed an item, the correction is recorded in the last column and the original label is preserved for history.

| Prompt label (Phase E "D3")                                    | Stable parity ID                             | Actual milestone owner                                                  | Current status                                                    | Evidence                                                                               | Prerequisite                                                          | Next action / acceptance                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| D3-A Keyboard-event typing / framework-aware fill              | **C2** (+ **C3** for the physical key model) | **Parity milestone** (was listed as D2 row C2; executed as prompt-D3-A) | **Verified complete (opt-in mode)**                               | `npm run probe:keyboard` **21/21 [RUN]**; adapter+bridge schema; `mcp-e2e` 93/93 [RUN] | none                                                                  | Keep. C3 (shifted chars, punctuation codes, modifier chords) remains **not implemented**                    |
| D3-B `browser_upload`                                          | **C6**                                       | **Parity milestone**, blocked on **OD-3**                               | **Deferred**                                                      | none                                                                                   | **OD-3 undecided** + ADR-02 (no raw CDP without an explicit decision) | Decide OD-3, then single-command allowlist or human chooser; probe + Layer C with a harmless generated file |
| D3-C Full-page / beyond-viewport capture                       | **D1**                                       | **Parity milestone**                                                    | **Deferred**                                                      | element crop is visible-area-only [RUN, labelled]                                      | none (but needs scroll-restore semantics)                             | `captureBeyondViewport` + restore/stitch; honest `source:'page'`; probe with tall/lazy pages                |
| D3-D Debug-click overlay                                       | **D3**                                       | **D4 (observability)** — reassigned                                     | **Deferred**                                                      | none                                                                                   | D4 trace/redaction design                                             | Opt-in only; must not intercept input or contaminate verification screenshots                               |
| D3-E Accessibility-tree option                                 | **B4**                                       | **Parity milestone**                                                    | **Partial** (snapshot exists, closed 11-role list — finding F-18) | snapshot probes [RUN]                                                                  | none                                                                  | `format:'ax'` option + widened roles **with** characterization tests, since it changes snapshot semantics   |
| D3-F Frames / iframes                                          | **C8**                                       | **Parity milestone**                                                    | **Deferred**                                                      | none                                                                                   | explicit Electron-mechanism decision; **ADR-02 forbids raw CDP**      | Frame targeting by frame id, never implicit; cross-origin limits reported honestly                          |
| D3-G Layer C for stale-ref + transforms                        | _(no single parity row; test-coverage work)_ | **D7 / test strategy**                                                  | **Deferred**                                                      | Layer C exists (`probe:realweb` 15/0/1) [RUN]; those two scenarios absent              | none                                                                  | Two vetted real-web scenarios; must assert the real page effect and restoration                             |
| **Architecture-D3**: helper workspace + domain-skill catalogue | **B7, I1** (helpers) / **B8, I2** (skills)   | **Architecture-D3** — _this ADR's subject_                              | **BLOCKED pending this design's approval**                        | none — nothing executes helpers                                                        | **ADR-09 approval** (§5)                                              | Implement only after approval + §6 test gates                                                               |
| I3 Claude plugin / Codex skill registration                    | **I3**                                       | Deferred, low value for a bundled app                                   | Not applicable-for-now                                            | —                                                                                      | —                                                                     | Revisit only if a plugin marketplace is wanted                                                              |

### Corrections recorded (append-only, history preserved)

1. **Phase D's D2 section listed C2 under D2.** Execution happened later under the prompt heading "D3-A". Both labels are preserved; the **stable ID is C2** and its evidence is `probe:keyboard`. No renumbering occurred.
2. **The previous report's phrase "D3 = interaction/inspection parity" was prompt-local.** The architecture's D3 is the extensible programming model. This table is now the single place that distinguishes them.
3. **D2 remains PARTIAL.** Its own open items are unchanged and are _not_ re-labelled by this ADR: dialog observation (deliberately not observed — hover-intermittency risk), delivery attestation for `type`/`scroll` (inherently `unsupported`), wheel `unverified`, and the parity items above.

---

## 2. Problem statement

Long-term the agent should create, persist, inspect, version and reuse **its own** helpers and domain skills. Today Min offers exactly one extensibility surface: `browser_eval`, which runs **in the page's main world** with the page's own authority.

That is **not a helper runtime**. `browser_eval`:

- executes in the _page_ sandbox, not the host — so it cannot reach Min's bridge, profile or filesystem;
- but it _can_ read page content, including anything the user can see;
- and its result is opaque to any policy: there is no allowlist, no review, no persistence, no versioning.

Reusing `browser_eval` as the helper mechanism would therefore give us **all of the persistence/abuse risks with none of the control**, and would blur the page boundary that ADR-02 protects. This ADR rejects that path explicitly.

---

## 3. Design options compared

Three defensible designs, plus the status quo.

### Option 0 — Status quo: no persistent helpers (baseline)

|                      |                                                        |
| -------------------- | ------------------------------------------------------ |
| What the agent gets  | `browser_eval` per call; `SKILL.md` as static guidance |
| Persistence          | none                                                   |
| Attack surface added | none                                                   |
| Verdict              | **Safe, and insufficient for the product goal**        |

### Option A — Declarative helpers over a fixed capability allowlist _(recommended)_

A helper is **data**, not code: an ordered list of calls to a **closed set of existing typed bridge tools**, with parameters that may reference earlier results by name.

```jsonc
// <profile>/agent-helpers/<name>/manifest.json   (illustrative shape only)
{
  "schema": "min.helper/v1",
  "name": "fill-login",
  "version": "3",
  "description": "Type credentials into the login form and submit",
  "params": { "user": { "type": "string" }, "pass": { "type": "secret" } },
  "steps": [
    { "tool": "browser_snapshot", "as": "s" },
    {
      "tool": "browser_type",
      "ref": "$s.nodes[name=User].ref",
      "text": "$user"
    },
    {
      "tool": "browser_type",
      "ref": "$s.nodes[name=Password].ref",
      "text": "$pass"
    },
    { "tool": "browser_click", "ref": "$s.nodes[name=Sign in].ref" }
  ],
  "requires": {
    "grants": ["sensitive_type"],
    "policy": ["allowSensitiveTyping"]
  }
}
```

- **Execution boundary:** the existing bridge. No new runtime, no new process. Each step goes through **the same validator, grants, risk policy and batch exclusion** that a direct call does — the helper is a _macro_, not a privilege.
- **No host access by construction:** there is no code to escape. `fs`, `process`, `require`, `child_process`, network and CDP are simply not in the vocabulary.
- **Page-tool-only:** every capability available to a helper is one an agent could already call one-by-one with the same authority.
- **Persistence:** plain JSON under the profile; trivially reviewable, diffable, versionable.
- **Cost:** cannot express arbitrary logic (loops over N elements, computed parsing) — those remain `browser_eval` call sites the _agent_ orchestrates, not the helper.

### Option B — Executable JS/TS helpers in an isolated runtime with a capability broker

- **Execution boundary:** a separate Node process (or `node:worker_threads`) holding **no** Electron objects, talking to the bridge over loopback with a **scoped, short-lived token**, plus a broker that mediates every capability.
- **Capability model:** helper code receives only a broker object (`read(ref)`, `type(...)`, `screenshot()`, …). No `require`, no `fs`, no `process.env`, frozen globals, `vm`-free (a `vm` context is _not_ a security boundary).
- **Risks that must be solved:** PID/port lifecycle; a second auth surface; resource limits enforced _outside_ the isolate; child-process spawn risk if `node` is used naively; dependency installs.
- **Benefit:** real expressiveness (loops, transforms, multi-step recovery).
- **Cost:** this is a second runtime to secure, package, version and test — materially larger than Option A.

### Option C — Stricter: no agent-authored persistence at all

Ship only **curated, versioned built-in skills** (reviewed with the product). The agent composes them per call; nothing agent-authored is ever saved.

- **Security:** highest — no untrusted code or data is ever persisted or re-executed.
- **Product cost:** loses the "agent grows its own toolkit" goal entirely.
- **Verdict:** the correct **fallback** if Option A's review proves too costly, and the correct **initial ship** while Option A's storage/versioning is built.

### Comparison

| Criterion                     | 0 Status quo         | **A Declarative**             | B Executable               | C Curated only       |
| ----------------------------- | -------------------- | ----------------------------- | -------------------------- | -------------------- |
| Page world reachable          | per-call only        | via typed tools only          | via broker only            | via typed tools only |
| Browser core / host reachable | **no**               | **no (structural)**           | no, _if_ broker perfect    | no                   |
| Filesystem                    | no                   | no                            | broker-mediated only       | no                   |
| Shell / child processes       | no                   | **no**                        | must be actively denied    | no                   |
| Credentials reachable         | page-visibility only | page-visibility only + grants | broker-mediated            | same as A            |
| New process / auth surface    | none                 | **none**                      | **yes**                    | none                 |
| Expressiveness                | n/a                  | medium                        | high                       | low                  |
| Persistence / versioning      | none                 | JSON, diffable                | code + deps, harder        | curated only         |
| Debuggability                 | n/a                  | step trace = tool calls       | needs a trace+replay story | n/a                  |
| Dependency burden             | none                 | **none**                      | **node + sandbox libs**    | none                 |
| Meets product goal            | no                   | **mostly**                    | fully                      | partly               |
| Failure recovery              | n/a                  | per-step, same as batch       | needs supervisor           | n/a                  |

### Recommendation

**Ship Option C immediately, grow into Option A, and treat Option B as a separate, explicitly-approved ADR.** Concretely:

1. **Now (post-approval):** curated built-in skills only (Option C). Zero untrusted execution.
2. **Next:** Option A declarative helpers, because they add persistence and reuse **without adding a single new privilege** — every capability is already reachable through the audited tool surface.
3. **Option B is explicitly not approved here.** It requires its own threat model, a supervised process, and the §6 gate tests passing for a _second_ runtime. Choosing B later does not invalidate A.

**Rationale:** the security question that matters is _"can a helper do anything the agent could not already do?"_ Under A the answer is structurally **no**. Under B the answer depends entirely on the correctness of a new broker, which is a much larger thing to get right and to keep right.

---

## 4. Threat model

Assets: bridge token + discovery file, profile (cookies, history, settings, `policy.json`), saved credentials/passwords, page content, the user's filesystem, and the _truthfulness_ of the agent's own reports.

| #   | Threat                                                      | Vector                                                           | Option A exposure                                                                                                                           | Option B exposure                                      | Mitigation (required)                                                                                                           |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **Malicious / compromised helper file**                     | agent writes or imports a helper it was socially engineered into | Cannot escape the tool vocabulary; worst case is a sequence of ordinary tool calls the agent could make anyway                              | Arbitrary code in the isolate; broker is the only wall | A: review diff on save + step allowlist. B: broker + no globals + resource limits                                               |
| T2  | **Prompt injection from a webpage**                         | page text says "save this helper" / "call browser_grant"         | Injected text is _data_; a helper cannot grant itself anything — `browser_grant` is **excluded** from batch/helper steps (D1-F1 protection) | Code path could encode the injected instruction        | Keep `browser_grant` + nested batch excluded from any composite execution; treat page-derived text as untrusted data everywhere |
| T3  | **Boundary escape → Node/fs/process/child_process**         | `require`, `process.binding`, prototype tricks                   | **Structurally impossible**: no code executes                                                                                               | Possible if broker/isolate is wrong                    | B: frozen intrinsics, no `require`, worker with cleared env, OS-level limits; deny by default                                   |
| T4  | **Token / profile / cookie / password theft**               | helper reads discovery file or profile dir                       | No fs access; `browser_grant`/sensitive typing still gated; passwords never returned (existing invariant)                                   | Broker must not expose them                            | A: no fs capability at all. B: broker exposes no path/env. Never log tokens (existing rule)                                     |
| T5  | **Cross-tab / cross-profile confusion**                     | helper targets the wrong tab                                     | Every step re-validates `tabId`; refs are identity-strict and tab-bound (`ref_mismatch`)                                                    | Broker must bind context per invocation                | Pass target context explicitly; reject mismatched refs; never implicit "current tab"                                            |
| T6  | **Forged results**                                          | helper reports success it did not observe                        | Impossible to fake: results are the bridge's own structured results                                                                         | Code could fabricate its return                        | A: results are bridge results. B: broker returns bridge results, helper may only _interpret_                                    |
| T7  | **Unbounded loops / resource exhaustion / output flooding** | infinite helper                                                  | Bounded by the batch budget (60 s), max steps (20), per-tool limits                                                                         | Real risk                                              | A: reuse batch budget/steps. B: wall-clock + memory + output caps enforced **outside** the isolate                              |
| T8  | **Dependency / package installs**                           | helper pulls an npm package                                      | **No install path exists**                                                                                                                  | Tempting and dangerous                                 | **Default: no arbitrary installs.** Any future allowlist requires its own review (supply-chain + licence)                       |
| T9  | **Local DOM change mistaken for remote persistence**        | helper restyles a page and "verifies"                            | Existing distinguishability preserved (`browser_transform` vs remote state)                                                                 | same                                                   | Every helper result must label local-vs-remote explicitly; type verification is page-state, never site-saved proof              |
| T10 | **Logging / artifact privacy**                              | helper saves screenshots or page text                            | Saved artifacts inherit D4 redaction rules                                                                                                  | same                                                   | Opt-in recording, redaction at write time, bounded retention (ADR-10)                                                           |
| T11 | **Helper versioning / rollback abuse**                      | swap a reviewed helper for a malicious revision                  | Diff + content hash on save                                                                                                                 | same                                                   | Content-addressed versions; review on change; explicit delete/purge                                                             |

---

## 5. Decisions and conditional gates

| Question                                              | Decision                                                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where stored                                          | `<profileRoot>/profiles/<agent-id>/agent-helpers/<name>/<version>/` — **per profile**, never global. Curated built-ins ship read-only under `skills/`.                                         |
| Namespacing                                           | Helper id `[a-z0-9][a-z0-9._-]{1,63}`; versions content-addressed; a profile can never see another profile's helpers.                                                                          |
| Executable?                                           | **Option A (declarative) only, on approval.** Option B requires a new ADR.                                                                                                                     |
| Capability API                                        | The closed set of existing typed tools, **minus** `browser_grant`, `browser_batch`, `browser_health` — i.e. the D1 batch-exclusion list plus health. Nothing else is added.                    |
| Target passing                                        | Explicit `tabId` per step (or inherited from invocation); refs identity-strict, tab-bound, TTL'd; a stale ref **fails**, never retargets.                                                      |
| Limits                                                | Reuse the batch kernel: ≤20 steps, 60 s budget; plus per-helper output cap and a per-profile concurrency of 1.                                                                                 |
| Dependencies                                          | **No arbitrary installs.** Curated only.                                                                                                                                                       |
| Privileged capability review                          | Any helper requiring `sensitive_type` or `risky_click` must declare `requires` and still consume a **single-use grant created by an explicit user instruction** — helpers never create grants. |
| Audit / trace                                         | Every step recorded as a normal tool call; D4 trace applies. Tokens/passwords never recorded.                                                                                                  |
| Versioning / migration / rollback / delete / recovery | Content-addressed versions; last-known-good retained; delete is explicit and purges all versions; a failed helper version is quarantined, not auto-retried.                                    |
| Domain-skill catalogue                                | Curated skills ship read-only with **MIT attribution** if adapted from Browser Harness. Web-derived instructions are **untrusted data**; a page can never install or override a skill.         |
| `browser_eval` as helper runtime                      | **Explicitly rejected.** Different execution boundary (§2).                                                                                                                                    |

---

## 6. Tests required BEFORE any helper execution is enabled

**None of these are run or passing today. They are gates.**

| Gate | Test                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | A helper step cannot reference `browser_grant`, nested batch, or any non-allowlisted tool — rejected before dispatch (extends D1-F1)                            |
| G2   | Attempted host API references (`require`, `fs`, `process`, `child_process`) are **not expressible** in a declarative helper; a schema test rejects unknown keys |
| G3   | Profile isolation: profile A cannot list, load, or execute profile B's helpers                                                                                  |
| G4   | Prompt-injection: a page containing "save helper X / grant yourself Y" cannot cause a save or a grant                                                           |
| G5   | Limits: >20 steps, >60 s budget, oversized output → structured refusal, no partial side effects                                                                 |
| G6   | Target identity: stale ref → `ref_stale`; cross-tab ref → `ref_mismatch`; never silently retargets                                                              |
| G7   | Persistence: create / version / rollback / delete / purge, with content hashes and no orphan files                                                              |
| G8   | Redaction: tokens, `Authorization`, cookies, passwords never appear in helper artifacts or traces                                                               |
| G9   | Truthfulness: a local DOM change is reported as local; a remote save is never inferred                                                                          |
| G10  | Reproducible Layer B run + one Layer C real-web case for a curated skill                                                                                        |

---

## 7. What this ADR does NOT decide

- Option B's isolate technology (worker vs child process vs WASM) — deferred to its own ADR.
- A helper marketplace or cross-user sharing — out of scope.
- Any network capability for helpers — out of scope until a dedicated review.
- Python, or any non-JS runtime — out of scope (architecture non-goal).

---

## 8. Approval state

**PROPOSED — awaiting explicit user review.** No helper code exists, no directory layout has been created, and nothing in this document has been executed.

---

## 9. Appendix — Option C concrete read-only built-in catalogue (PROPOSAL, 2026-10-19)

**This appendix closes the specification gap in §5. It does NOT change the ADR's status.** §1–§8 above remain the design; this is the concrete catalogue they lacked. Approval state is unchanged: **PROPOSED — NOT APPROVED**.

### 9.1 Constituent-tool read-only audit (verified from source, not assumed)

Every candidate built-in composes only tools from this audited set. Verified by source inspection of `main/agentRpc.js` on 2026-10-19 (`[SOURCE]`); **no runtime execution was performed for this appendix.**

| Tool                                                       | Read-only?                     | Evidence                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_status`                                           | **Yes**                        | returns `agentRpcCommandStatus()` summaries; no mutation                                                                                                         |
| `browser_tabs`                                             | **Yes**                        | `agentRpcCommandTabs` L1133 returns `agentRpcTabSummaries()` only                                                                                                |
| `browser_snapshot` (default mode)                          | **Yes**                        | page fn performs no DOM writes; `scrollIntoView` exists **only** in `scrollinto` mode (L1518) and the element-screenshot path (L5539), neither of which is used  |
| `browser_content`                                          | **Yes**                        | `content` mode builds text from `innerText` + shadow-root walk; no writes                                                                                        |
| `browser_state`                                            | **Yes**                        | `state` mode has no DOM writes; the dialog observer called at L4530 is **intentionally inert** (L4492)                                                           |
| `browser_verify`                                           | **Yes**                        | `verify` mode reads selector/visibility/text only                                                                                                                |
| `browser_eval`                                             | **NO — excluded**              | caller-supplied arbitrary expression (L3596). It runs in the page world and **can mutate page state**. Not read-only in principle regardless of how it is called |
| `browser_pdf`, `browser_screenshot`                        | Read-only but **excluded**     | large binary payloads; convenience value does not justify catalogue surface                                                                                      |
| `browser_tab_open/select/close`                            | **NO — mutating**              | changes tab set/selection                                                                                                                                        |
| `browser_viewport`                                         | **NO — mutating**              | `setZoomFactor` L3688                                                                                                                                            |
| `browser_click/type/press/mouse/scroll/hover/select/check` | **NO — mutating**              | input dispatch                                                                                                                                                   |
| `browser_transform*`                                       | **NO — mutating**              | DOM/CSS mutation                                                                                                                                                 |
| `browser_navigate`, `browser_wait`                         | **NO — mutating / blocking**   | navigation; wait blocks for seconds                                                                                                                              |
| `browser_download*`                                        | **NO**                         | filesystem + network transfer                                                                                                                                    |
| `browser_grant`                                            | **NO — excluded by ADR-09 §5** | creates authorization                                                                                                                                            |
| `browser_batch`                                            | **NO — excluded by ADR-09 §5** | composite execution primitive                                                                                                                                    |
| `browser_health`                                           | **NO — excluded by ADR-09 §5** | profile diagnostics; not page-scoped                                                                                                                             |

**Allowlist for Option C (closed):** `browser_status`, `browser_tabs`, `browser_snapshot`, `browser_content`, `browser_state`, `browser_verify`.

**Note on the ADR-09 §5 exclusion list.** §5 said the capability set is "existing typed tools **minus** `browser_grant`, `browser_batch`, `browser_health`" — that was written for Option A's broader macro capability. Option C is stricter: it uses the six-item read-only allowlist above. This is a **narrowing**, not a contradiction, and it is recorded here so the two never conflict.

### 9.2 Candidate decisions

| Candidate              | Decision                            | Rationale                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page_summary`         | **KEEP**                            | Highest value/risk ratio: one snapshot + one state answers "where am I and is the page usable". Composes 2 read-only tools.                                                                                                                                                       |
| `link_inventory`       | **KEEP**                            | Distinct value over a raw snapshot: a bounded, de-duplicated, destination-focused list an agent can reason over (“which link goes to X?”). Filtering is done **server-side over snapshot data**, no page code.                                                                    |
| `form_inventory`       | **KEEP**                            | High value for form work, and the redaction discipline is the point: names/types/labels/required/disabled/read-only, **never values**.                                                                                                                                            |
| `page_outline`         | **DEFER → Option A**                | Genuinely useful, but the current snapshot role list is a closed 11-role set that **does not emit landmark/region nodes** (finding F-18 / parity row B4). Building an outline on it would silently omit major page structure. Defer until B4 widens the role model, then revisit. |
| `interactive_elements` | **REJECT (as a separate built-in)** | It would be a thin projection of `browser_snapshot` with no added semantics — exactly the "duplicate an existing tool without value" case the task warns about. Its intended use is served by `page_summary` + a direct `browser_snapshot`.                                       |
| `page_diagnostics`     | **REJECT**                          | Overlaps `browser_health` (excluded) and `browser_state` (already callable). It would either duplicate them or smuggle diagnostics into a "page" helper. Not worth the surface.                                                                                                   |

**Minimal Option C catalogue: three built-ins — `page_summary`, `link_inventory`, `form_inventory`.**

### 9.3 Specification — `page_summary`

|                           |                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / name**             | `page_summary` — "Page summary"                                                                                                                                                                                                                                                                                                                     |
| **Purpose**               | Answer "what page is this and is it usable" in one call.                                                                                                                                                                                                                                                                                            |
| **Tool sequence (fixed)** | 1. `browser_state({tabId})` → 2. `browser_snapshot({tabId, maxNodes})`                                                                                                                                                                                                                                                                              |
| **Read-only proof**       | both tools audited read-only in §9.1                                                                                                                                                                                                                                                                                                                |
| **Inputs**                | `tabId` (required, `^[0-9]{1,20}$`); `maxNodes` (optional int 1–200, default 40)                                                                                                                                                                                                                                                                    |
| **Output contract**       | `{ helper:'page_summary', version:1, tabId, url, title, readyState, dialogs:{observed,pageDialogsSuppressed}, captcha:{detected,kind,policy}, blocked:{apparently,signals}, counts:{interactiveNodes,totalNodes}, topNodes:[{role,name,ref,disabled,readOnly}] (≤20), truncated:boolean, steps:[{tool,ok,error?}], evidence:{stateOk,snapshotOk} }` |
| **Target identity**       | `tabId` is required and passed to **both** steps verbatim; no "current tab" fallback. A ref from step 2 is bound to that `tabId`.                                                                                                                                                                                                                   |
| **Errors / partial**      | If `browser_state` fails → `ok:false`, `error` = its structured error, **no snapshot attempted**, `evidence.stateOk:false`. If state succeeds but snapshot fails → `ok:'partial'`, `evidence.snapshotOk:false`, and the summary still returns the state half — clearly labelled. Never reports `ok:true` with missing evidence.                     |
| **Sensitive data**        | Node `value` is **never** included; only role/name/ref/disabled/readOnly. Names are the existing truncated accessible names. `captcha.policy` is the existing static string.                                                                                                                                                                        |
| **Bounds**                | ≤2 tool calls; snapshot capped at `maxNodes`; output ≤20 nodes; total ≤32 KiB (server-side trim of `topNodes`).                                                                                                                                                                                                                                     |
| **Limitations**           | Snapshot is the 11-role interactive model (F-18), so headings/landmarks are largely absent; `captcha.detected` is detection only, never clearance.                                                                                                                                                                                                  |

### 9.4 Specification — `link_inventory`

|                           |                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **ID / name**             | `link_inventory` — "Link inventory"                                                                                                                                                                                                                                                                                                                               |
| **Purpose**               | Bounded, de-duplicated list of visible links with accessible name + destination.                                                                                                                                                                                                                                                                                  |
| **Tool sequence (fixed)** | 1. `browser_snapshot({tabId, maxNodes})` → 2. `browser_verify({tabId, selector, textContains})` **only** if `verifySelector` supplied                                                                                                                                                                                                                             |
| **Read-only proof**       | both audited read-only                                                                                                                                                                                                                                                                                                                                            |
| **Inputs**                | `tabId` (required); `maxNodes` (optional 1–300, default 120); `limit` (optional 1–50, default 25); `filter` (optional string ≤80, case-insensitive substring on name **or** href, applied in the bridge, never in page code)                                                                                                                                      |
| **Output contract**       | `{ helper:'link_inventory', version:1, tabId, url, total, returned, truncated, links:[{name,ref,hrefPresent:boolean,href:string                                                                                                                                                                                                                                   | null}], steps:[...] }` |
| **Href handling**         | The snapshot node model carries `role`/`name`/`ref`; it does **not** carry `href`. Therefore the helper reports `hrefPresent`/`href:null` **unless** the caller supplies `verifySelector` — it must **not** claim destinations it did not read. _This is a real limitation of the current snapshot model and is stated rather than worked around with page code._ |
| **Target identity**       | `tabId` required, passed to every step                                                                                                                                                                                                                                                                                                                            |
| **Errors / partial**      | snapshot failure → structured error, `ok:false`; empty result → `ok:true` with `links:[]` and `note:'no link nodes matched'` (a true empty is not an error)                                                                                                                                                                                                       |
| **Sensitive data**        | names only; no page text, no query strings echoed beyond the link name                                                                                                                                                                                                                                                                                            |
| **Bounds**                | ≤2 calls; `limit` ≤50; output ≤16 KiB                                                                                                                                                                                                                                                                                                                             |
| **Limitations**           | Cannot report real hrefs without widening the snapshot model (future parity row B4). Duplicate names are collapsed by `(name, href)` and counted in `truncated`.                                                                                                                                                                                                  |

### 9.5 Specification — `form_inventory`

|                           |                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID / name**             | `form_inventory` — "Form inventory"                                                                                                                                                                                           |
| **Purpose**               | Read-only inventory of form controls and their state, **without any values**.                                                                                                                                                 |
| **Tool sequence (fixed)** | 1. `browser_snapshot({tabId, maxNodes})`                                                                                                                                                                                      |
| **Read-only proof**       | `browser_snapshot` audited read-only                                                                                                                                                                                          |
| **Inputs**                | `tabId` (required); `maxNodes` (optional 1–300, default 150); `limit` (optional 1–60, default 30)                                                                                                                             |
| **Output contract**       | `{ helper:'form_inventory', version:1, tabId, url, total, returned, truncated, controls:[{role,name,ref,disabled,readOnly,redacted}], steps:[...] }`                                                                          |
| **Which nodes**           | roles `textbox`, `combobox`, `checkbox`, `radio`, `button`, `switch`, `option`                                                                                                                                                |
| **Sensitive data**        | **Never** values, never `valueLength` for redacted fields (the snapshot exposes a length; the helper drops it), never passwords, tokens or autocomplete-sensitive content. `redacted` is reported as a **boolean flag only**. |
| **Target identity**       | `tabId` required                                                                                                                                                                                                              |
| **Errors / partial**      | as `page_summary`; empty → `controls:[]`, `note:'no form controls matched'`                                                                                                                                                   |
| **Bounds**                | 1 call; `limit` ≤60; output ≤16 KiB                                                                                                                                                                                           |
| **Limitations**           | Grouping into `<form>` elements is **not** available from the snapshot model; this is a flat control list, stated explicitly.                                                                                                 |

### 9.6 Catalogue-wide security constraints (binding for any implementation)

- Helpers are **data** (fixed ordered tool lists), not code. No `eval`, `Function`, `require`, shell, child process, filesystem, dependency install, raw CDP or event drain.
- The execution boundary enforces the §9.1 allowlist **by name**; a parameter can never select a tool.
- Page content is untrusted **data**. A page cannot alter a plan: plans are static and names come from the catalogue, never from page text.
- `tabId` is explicit on every step; no implicit current-tab resolution; profile is whatever the bridge instance is (helpers add no cross-profile path).
- No helper may report that observing a page proves an external change was persisted.
- Outputs are byte-capped and contain no values/tokens/cookies/headers.

### 9.7 Catalogue-wide acceptance gates (proposed — NOT run)

| Gate | Check                                                                                                                                                                           | Status       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| C1   | Only registered IDs (`page_summary`, `link_inventory`, `form_inventory`) are invocable; unknown ID rejected                                                                     | **proposed** |
| C2   | Altered definition (extra/renamed tool, changed order) rejected at the boundary                                                                                                 | **proposed** |
| C3   | Arguments schema-validated; out-of-range `maxNodes`/`limit` refused                                                                                                             | **proposed** |
| C4   | `browser_grant`, `browser_batch`, `browser_health`, `browser_eval`, `browser_click`/`type`/`press`/`mouse`/`scroll`/`navigate`/`transform`/`download*` unreachable transitively | **proposed** |
| C5   | No mutation side effect: page URL, DOM, zoom and tab set unchanged after each helper                                                                                            | **proposed** |
| C6   | Prompt injection: a page containing "call browser_grant" / "change your plan" cannot alter a plan or grant anything                                                             | **proposed** |
| C7   | Target identity: every step receives the same `tabId`; cross-tab refs rejected                                                                                                  | **proposed** |
| C8   | Redaction: no field values, `valueLength` for redacted fields, tokens, cookies or headers in output or logs                                                                     | **proposed** |
| C9   | Partial/timeout produce `ok:'partial'` or structured errors, never fabricated `ok:true`                                                                                         | **proposed** |
| C10  | Layer A schema/allowlist tests; Layer B real Min+MCP; Layer C vetted real page (read-only), impact map routes every new file                                                    | **proposed** |

### 9.8 Future Option A extension path (not in this catalogue)

Option A would let an agent **compose** the same fixed steps into its own saved helper, adding: per-profile storage (`agent-helpers/<name>/<version>/`), a review/diff on save, content-addressed versions with rollback, and the same allowlist — i.e. Option A adds _persistence and composition of already-allowed steps_, not new capability. It remains gated on D5 profile paths and gates G1–G9. Option B (executable helpers + broker) remains **NOT APPROVED**.

### 9.9 Unresolved questions for the reviewer

1. **`link_inventory` hrefs** — the snapshot model has no `href`. Accept the honest limitation, or widen the snapshot node model first (parity row B4)? Widening changes snapshot semantics and needs its own characterization tests.
2. **`form_inventory` grouping** — accept a flat control list, or defer until form grouping exists?
3. **Should `interactive_elements` be folded into `page_summary` as an option** rather than rejected outright? Rejected here as value-less, but a reviewer may prefer an explicit flag.

---

## 10. Decision record — USER APPROVAL (2026-10-19)

> **This section is append-only provenance. Earlier sections (§1 status line, §8 "PROPOSED — awaiting explicit user review") remain as written; they record the state _before_ this decision. The current status is stated here.**

**Status change: PROPOSED → APPROVED (Option C only).**

On **2026-10-19** the user explicitly approved **ADR-09 as designed** and the **narrowed Option C catalogue** (response to the approval question: "haan, sab kar do").

### Scope of the approval — and its limits

| Approved                                                                                        | Not approved                                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| ADR-09 security design (this document)                                                          | Option A (declarative user-authored helpers) — future, gated milestone                         |
| **Option C**, catalogue **narrowed to two built-ins**: `page_summary`, `form_control_inventory` | Option B (executable helpers + broker) — **NOT APPROVED**                                      |
| Read-only composition of the six-tool allowlist                                                 | Arbitrary code execution, `eval`/`Function`, shell, child process, filesystem, package install |
| —                                                                                               | Raw CDP, event drain, CAPTCHA bypass                                                           |
| —                                                                                               | Any host privilege beyond the audited typed-tool allowlist                                     |

**This approval record is provenance, not a claim that any implementation gate (C1–C10) has passed.** Gates are implemented and _run_ in the implementation task; their results are recorded there.

### Catalogue decisions as approved

| Candidate                | Decision                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `page_summary`           | **Implement**                                                                                                           |
| `form_control_inventory` | **Implement** — flat control inventory; **no** `<form>` grouping claim. (Renamed from the proposal's `form_inventory`.) |
| `link_inventory`         | **Defer** until the snapshot model exposes real `href` destinations with characterization tests                         |
| `page_outline`           | **Defer** until landmark/region structure exists and is tested                                                          |
| `interactive_elements`   | **Rejected** (thin projection of `browser_snapshot`); reconsider only if it adds semantics                              |
| `page_diagnostics`       | **Rejected** (overlaps `browser_health` / `browser_state`)                                                              |

### Corrections to §9 from this approval

- §9.2/§9.4 proposed **keeping** `link_inventory`; the user **deferred** it. §9.4 is superseded for implementation purposes and retained for history.
- §9.5's helper is implemented under the approved name **`form_control_inventory`**.
- The approved minimal catalogue is **two** built-ins, not three.

---

## 11. Implementation status — Option C (2026-10-19, appended)

**Status: OPTION C IMPLEMENTED (two built-ins).** §10 recorded the approval; this section records what was built and what the gates actually returned.

| Built-in                 | Sequence (fixed)                     | Result                                                   |
| ------------------------ | ------------------------------------ | -------------------------------------------------------- |
| `page_summary`           | `browser_state` → `browser_snapshot` | implemented, verified                                    |
| `form_control_inventory` | `browser_snapshot`                   | implemented, verified (flat; no `<form>` grouping claim) |

**Deferred/rejected as approved:** `link_inventory` (no `href` in the snapshot model), `page_outline` (no landmark nodes), `interactive_elements` (rejected), `page_diagnostics` (rejected). Option A and Option B remain **not approved / not implemented**.

**Enforcement (source-verified):** `AGENT_RPC_HELPER_ALLOWED_TOOLS` is a frozen six-tool allowlist (`browser_status`, `browser_tabs`, `browser_snapshot`, `browser_content`, `browser_state`, `browser_verify`). `AGENT_RPC_HELPER_CATALOGUE` is deep-frozen and its steps are validated against the allowlist **at load time**. Both the catalogue lookup and the per-step dispatch use own-property checks. `browser_eval`, `browser_grant`, `browser_batch`, `browser_health`, all input tools, navigation, transforms, viewport, downloads, pdf/screenshot and raw CDP are **absent from the allowlist** and cannot be reached through any parameter.

**Gate results (C1–C10):** see the implementation report; results are recorded in the Master Scope Register, not here, to keep this ADR a design record.

**New finding (parity row B4):** the snapshot node reports `readOnly:false` for an element whose `readOnly` is `true` in the page world. `form_control_inventory` therefore exposes `readOnly` as a boolean but **does not claim it reliable**, and the probe asserts only `disabled`. Widening/fixing the snapshot model remains B4.
