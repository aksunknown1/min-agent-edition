# ADR-02A — Zini Chrome Backend: Broad CDP, Pipe Transport, Single-Controller Lease

**Status:** `OWNER-DECIDED` (product direction) · `TECHNICAL-GATE-PENDING` (prerequisites) · `IMPLEMENTATION-NOT-STARTED`
**Date:** 2026-10-20
**Product name:** **Zini** (owner-selected)
**Chrome profile label:** **`Min Agent Shared Chrome`** (owner-confirmed; retains the Min prefix deliberately)
**Amends:** ADR-02 (append-only addendum — the original ADR-02 text at `INTEGRATED-TARGET-ARCHITECTURE.md:100` is **not** edited)
**Supersedes:** the *recommendation* in `ADR-02-CHROME-TRANSPORT-DECISION.md` (that document proposed Option D/extension `chrome.debugger`; the owner instead chose a separate Chrome-for-Testing process with a private pipe and broad CDP)
**Related:** ADR-03 (three-stage truthfulness), ADR-04 (profiles), ADR-05 (loopback transport), ADR-06 (engine cadence), R5/D6 (`STAY_ELECTRON`), MB0 v2

> **This ADR records a decision. It does not authorize code.** Implementation may not begin until
> (a) this ADR is recorded — done here — and (b) every `TECHNICAL-GATE-PENDING` item in §12 has
> evidence. Nothing in Zini's Min surface changes.

---

## 1. Narrow purpose

Authorize a **Chrome-only** backend that exposes a **broad, caller-directed CDP interface**
(domains, methods and parameters) plus a **CDP event stream**, running in a dedicated
Chrome-for-Testing process over a **private pipe**, while:

- leaving **Min's existing three-command CDP allowlist byte-identical**;
- leaving Min as the default backend and the Electron pin unchanged;
- **not** adding host OS command execution of any kind.

**Out of scope, permanently:** OS/shell execution, arbitrary filesystem access beyond what a
narrowly-scoped upload/download policy allows, attaching to the user's ordinary Chrome profile or
any external Chrome process, CAPTCHA solving, token forgery, stealth evasion, access-control
bypass.

---

## 2. Recorded owner decisions (Q1–Q8 + concurrency + engine)

| # | Decision | Classification |
|---|---|---|
| **Q1** | **ADR-02 exception granted** for the Chrome backend. Recorded as an explicit, documented exception — **not** as pre-existing blanket authorization. Min's historical approved bounded CDP surface is unchanged. | `OWNER-DECIDED` |
| **Q2** | Raw CDP is **Chrome-only**. Min keeps exactly its three approved commands; no raw CDP is exposed for Min. | `OWNER-DECIDED` |
| **Q3** | Goal is **broad/unrestricted CDP domains and commands for Chrome**, including an **explicit raw-CDP MCP interface**. Dedicated Chrome for Testing process, persistent profile **`Min Agent Shared Chrome`**. | `OWNER-DECIDED` |
| **Q4** | The authorized agent may **subscribe to / read the CDP event stream** — events are not merely consumed internally. Bounds/lifecycle must be designed (§7), but the internal-only model must **not** be silently substituted. | `OWNER-DECIDED` |
| **Q5** | **Chrome for Testing**, with a deliberate version pin and an explicit security-update/re-pin policy. | `OWNER-DECIDED` |
| **Q6** | **Private CDP pipe**, not a TCP debugging port. | `OWNER-DECIDED` |
| **Q7** | The active controller may explicitly select **any tab inside the Zini-managed `Min Agent Shared Chrome` process/profile** — whether opened by the current agent, a prior agent, or the user. **No implicit attachment to external Chrome.** | `OWNER-DECIDED` |
| **Q8** | Delivery attestation is a **workstream** (investigate → design → implement). Never claim `delivered` without evidence; if no reliable renderer-receipt evidence exists, expose **`delivered: unavailable`**. A CDP command *response* alone never proves event delivery. Any schema change must be explicit. | `OWNER-DECIDED` |
| **Concurrency** | **One controlling agent at a time.** Others wait. Profile + saved session persist across authorized agents. **No concurrent control.** The latest decision supersedes the earlier conflicting selection. | `OWNER-DECIDED` |
| **Engine** | R5/D6 **`STAY_ELECTRON`** remains authoritative for Min. The Chrome backend neither replaces Min nor changes the Electron pin. | `OWNER-DECIDED` |

---

## 3. Approved scope and explicit out-of-scope

### 3.1 In scope (Chrome backend only)

Arbitrary CDP **within the protocol**, including the powers below, which are stated plainly
because they are the real risk surface:

| Capability | What it means |
|---|---|
| Page/JavaScript execution | `Runtime.evaluate`, `Runtime.callFunctionOn` — arbitrary code in any target's main world |
| DOM mutation | `DOM.*`, `DOMSnapshot.*`, `CSS.*` — read and rewrite the live document |
| Network inspection/interception | `Network.*`, `Fetch.*` — observe requests, headers, bodies; **intercept and modify** them |
| Target/session management | `Target.*` — create/close targets, attach to workers and out-of-process iframes |
| Storage and sensitive data | `Storage.*`, `Network.getAllCookies`, `DOMStorage.*` — **cookies, tokens, localStorage for the dedicated profile** |
| Input synthesis | `Input.*` — trusted mouse/keyboard events |
| Capture/print | `Page.captureScreenshot`, `Page.printToPDF` |
| Events | The full event stream, agent-subscribable per Q4 |

### 3.2 Explicitly out of scope

| Excluded | Reason |
|---|---|
| **Host OS / shell command execution** | The owner's "unrestricted" applies to **CDP within the transport**, not to the host. No `require('child_process')` tool, no shell tool, no exec |
| Arbitrary host filesystem read/write | Not granted. Uploads/downloads remain policy-scoped |
| The user's **ordinary Chrome profile** | Prohibited (Q3/Q7, and Chrome 136's own restriction) |
| Any **external/unrelated Chrome process** | No implicit or explicit attach |
| Concurrent control by multiple agents | Q "Concurrency": one controller |
| Min's three-command allowlist expansion | Q2: unchanged |
| CAPTCHA solving / token forgery / stealth / access-control evasion | Never a feature objective |

---

## 4. Runtime: Chrome for Testing, named profile, private pipe

| Element | Decision |
|---|---|
| Binary | **Chrome for Testing** (not Google Chrome stable, not the user's install) |
| Version | **Pinned deliberately**; see §10 for the re-pin policy |
| Profile | Persistent, labelled **`Min Agent Shared Chrome`** |
| Transport | **Private CDP pipe** (`--remote-debugging-pipe`), **no TCP port** |
| Startup | Child process owned by the Zini backend; `--user-data-dir` always set |
| Shutdown | Graceful `Browser.close` → bounded wait → `/PID`-targeted kill; never `/IM` |

### 4.1 Verified technical basis for the pipe (evidence, not assumption)

| Claim | Status | Evidence |
|---|---|---|
| A private CDP pipe exists as `--remote-debugging-pipe` | **DOCUMENTED** | Puppeteer `LaunchOptions.pipe`: *"Connect to a browser over a pipe instead of a WebSocket. Only supported with Chrome."* — https://pptr.dev/api/puppeteer.launchoptions |
| The pipe is used by a major cross-platform harness on Windows | **DOCUMENTED (source)** | `BrowserLauncher.ts`: `const usePipe = launchArgs.args.includes('--remote-debugging-pipe')` and `createCdpPipeConnection` — https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/node/BrowserLauncher.ts |
| Pipe wiring is stdio **fd 3 (write) / fd 4 (read)** | **DOCUMENTED (source)** | `BrowserLauncher.ts`: `const {3: pipeWrite, 4: pipeRead} = browserProcess.nodeProcess.stdio`. There is explicit Windows-specific handling elsewhere in the same file (ProcessSingleton/lockfile), which is why the pipe path is exercised on Windows |
| Framing is **NUL-terminated JSON** (`\0`) | **DOCUMENTED (source)** | `PipeTransport.ts`: `send()` writes `message` then `'\0'`; `#dispatch()` splits on `'\0'` — https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/node/PipeTransport.ts |
| Chrome 136+ restricts debugging on the **default** data directory, and Chrome for Testing keeps the previous behaviour | **DOCUMENTED** | https://developer.chrome.com/blog/remote-debugging-port |

**Not yet verified (gate, §12):** that *our specific pinned Chrome for Testing build on this
Windows host* accepts the pipe, that all **broad** domains/methods behave over it, and the exact
shutdown/EOF semantics. These are measured in G1/G2 — not assumed.

---

## 5. Single-controller lease, handoff, shared profile, tab selection

### 5.1 Lease model

- **Exactly one controlling agent at a time.** A lease is a lock file plus an in-process
  assertion, holding `{ agentId, pid, startedAt, profileLabel }`.
- Acquisition: create-if-absent. If present and the owner is **alive**, the waiter blocks with a
  bounded wait and a structured `controller_busy` status — it never steals.
- Stale lease (owner PID gone): reclaimed after a bounded grace period, with the reclaim recorded.
- Release: on graceful shutdown, on explicit release, and on crash detection.

### 5.2 Handoff

The **profile and saved session persist** across agents. "Handoff" means: agent A releases the
lease; agent B acquires it and finds the same Chrome process/profile (or restarts it against the
same `user-data-dir`). **Tabs are not migrated between agents as objects** — B may *select* an
existing tab by explicit id (§5.3), but refs/ids minted under A's control are invalidated.

### 5.3 Tab selection

- The controller may **explicitly select any tab** in the Zini-managed process (§7 of the task,
  Q7): tabs it opened, tabs a prior agent opened, tabs the **user** opened in that profile.
- Selection is always **explicit by id**. There is **no implicit "current tab"** and no
  auto-attach.
- **Never** attaches to a Chrome process/profile Zini did not launch.

### 5.4 Concurrency boundary

No concurrent control, by decision. Two agents wanting the browser serialize on the lease. This
deliberately gives up throughput in exchange for a single, auditable owner of a credential-bearing
profile.

---

## 6. Raw-CDP interface contract

### 6.1 Shape

```
cdp_call({ sessionId?, method, params })  -> { result } | structured error
cdp_events_subscribe({ sessionId?, domains[], maxQueue, ... })  -> subscription handle
cdp_events_read({ subscriptionId, max })  -> bounded batch
cdp_events_unsubscribe({ subscriptionId })
```

*(Names illustrative; MB3 finalizes. The properties below are contractual.)*

### 6.2 Contractual properties

| Property | Requirement |
|---|---|
| Method space | **Arbitrary CDP methods within the protocol** — the owner's choice. Validated structurally (domain + method shape, params is a JSON object), **not** against an allowlist |
| No OS execution | There is **no** method that runs a host command. CDP's `Browser.*` / `Target.*` operate on the browser, not the OS |
| Params | Must be a JSON object conforming to the protocol; **bounded size**; rejected before transit if malformed |
| Session | Every call is bound to the **lease holder**. `sessionId` enables flat child sessions (workers/OOPIF) |
| Transport | Private pipe only. **No port is ever opened**; a fallback to TCP is **prohibited without a new ADR** |
| Result bound | Results are size-capped; oversized results return a truncation marker, never an unbounded buffer |
| Errors | Structured: `invalid_method`, `invalid_params`, `target_not_found`, `session_detached`, `controller_busy`, `pipe_closed`, `protocol_error` |

### 6.3 The security trade this accepts

A raw-CDP surface is, by design, **not** a least-privilege surface. It can read cookies, execute
page JS, and intercept traffic **inside the `Min Agent Shared Chrome` profile**. The owner accepts
this. The **containment boundary is the profile and the process** — not the method set.

---

## 7. Event-stream contract

| Topic | Contract | Status |
|---|---|---|
| Subscription | Per `sessionId`, filtered by domain list; one subscription per controller | `TECHNICAL-GATE-PENDING` (shape) |
| Queue bound | **Bounded** per subscription (`maxQueue`), with an explicit **overflow policy** | gate |
| Backpressure | When the queue is full: **drop-oldest with a counted `dropped` field**, or block — must be chosen and documented, never silent | gate |
| Loss semantics | A counted, reported loss (`dropped`, `gapFrom`) — **never** a silent gap | gate |
| Replay | **No replay.** CDP events are live-only. `Network.enable` after the fact cannot recover earlier events. This must be stated to callers | gate (document) |
| Sensitivity | Event payloads **contain page content and possibly credentials** (e.g. `Network.requestWillBeSent` headers, `Network.getResponseBody`). Events are **never persisted by default**; any trace is ADR-10 opt-in with redaction | `OWNER-DECIDED` policy; gate for mechanism |
| Routing | Events are routed to the **lease holder only**. A non-controller cannot subscribe | `OWNER-DECIDED` |
| Lifecycle | Subscription ends on: unsubscribe, lease release, pipe close, target detach. All must be observable | gate |

**Explicitly rejected substitution:** an "internal-only" event model (the MB0/ADR-02-CHROME proposal)
is **not** what the owner chose. Events are agent-visible.

---

## 8. Honest dispatch / delivery / verification

| Stage | Chrome evidence | Rule |
|---|---|---|
| `dispatched` | The CDP command was accepted and returned a response | Report `true` on response — **the response itself is the dispatch evidence**, not delivery |
| `delivered` | Requires **renderer receipt** evidence | ⚠️ **No known mechanism yet.** If none is established → **`delivered: "unavailable"`**. Never inferred from a command response, from `Input.*` being "trusted", or from compositor activity |
| `verified` | Independent page-state re-read (DOM, value, URL, readyState) | Report `verified: true/false` with the verification kind |

**Workstream W1 (attestation) — `TECHNICAL-GATE-PENDING`.** Candidate evidence sources to
investigate: a page-side event counter installed via `Runtime.addBinding`/`Page.addScriptToEvaluateOnNewDocument`
(populated **before** dispatch, read **after**), or `Input.dispatchMouseEvent` followed by observing
the page's own trusted-event listener. Whether either proves *renderer receipt* (rather than
"the command was accepted") must be measured. **If not**: `delivered: unavailable`, permanently,
and that is the honest outcome.

Min's existing preload attestation is **not** portable to Chrome (different process, no preload).
Do not pretend otherwise.

---

## 9. Threat model and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | **Profile data exfiltration** (cookies, sessions, passwords in the shared profile) | Contained to `Min Agent Shared Chrome`; never the user's profile; lease prevents multi-agent races; no persistence of secrets in logs/evidence |
| T2 | **Broad network interception** (`Fetch.*`) modifying third-party traffic | Accepted risk within the profile; explicitly **not** an evasion tool; no stealth objectives |
| T3 | **Pipe handle leakage to another process** | Pipe is created by the parent and inherited by the child; no port to scan; child stdio is not shared |
| T4 | **Malformed / oversized params** | Structural validation + size caps before transit; oversize rejected with `invalid_params` |
| T5 | **Target/session identity confusion** | Every call carries an explicit `sessionId`/target; no ambient "current target"; unknown ids → `target_not_found`, never best-effort |
| T6 | **Event disclosure to a non-controller** | Routing bound to the lease; subscription requires the lease |
| T7 | **Crash mid-operation** | `pipe_closed`; no auto-replay; lease released or reclaimed; no grant replay |
| T8 | **Update / version drift** | §10 pin + re-pin policy; protocol version assertion at connect |
| T9 | **Reaching the host OS through CDP** | There is no such method; `Browser.*` is browser-scoped. Explicitly stated so no future maintainer "adds" one |
| T10 | **Accidental attachment to a user's Chrome** | Discovery is by **our own launched pid + pipe**, never by scanning ports or profile scan |

### 9.1 Preserved invariants

- **ADR-05** (loopback/ephemeral token) governs **Min**, and is untouched. Chrome uses a pipe, so
  ADR-05's loopback premise does not apply — this is stated, not silently violated.
- **ADR-03** is preserved in shape: three stages, independently reported, never conflated.
- **ADR-04** profile isolation: the shared Chrome profile is *deliberately* shared among
  authorized agents, which is a narrow, documented exception to "per-agent profiles", justified by
  the single-controller lease. It is **not** a precedent for Min.

---

## 10. Version pinning and security maintenance

| Rule | Detail |
|---|---|
| Pin | An exact Chrome for Testing build id (e.g. `Chrome for Testing 141.x.y.z`), recorded in one place |
| Security updates | Track Chrome stable security releases; when a **security-relevant** fix lands, schedule a re-pin |
| Re-pin procedure | Bump pin → run the full Chrome gate suite (§12) → roll forward deliberately |
| No indefinite pin | A pin older than the agreed window (e.g. one stable cycle behind current stable) triggers a mandatory re-pin review |
| Protocol drift | Assert CDP protocol version at connect; a mismatch is a structured error, not a silent degrade |

---

## 11. Compatibility, failure behavior, unsupported scenarios

| Scenario | Behavior |
|---|---|
| Chrome for Testing not installed | `chrome_unavailable` with the expected path; **no** fallback to Google Chrome |
| Pipe mode unsupported on the pinned build | **Stop and report.** Never silently switch to a TCP port (§13) |
| Another agent holds the lease | `controller_busy`, bounded wait, no steal |
| Target closes mid-call | `target_not_found` / `session_detached` |
| Pipe closes | `pipe_closed`; lease released; in-flight calls fail; no retry |
| Enterprise policy blocks debugging/screenshots | Surface as structured `unsupported_on_backend` |
| Tab outside the Zini profile | Never reachable — not a scenario, a guarantee |

---

## 12. Technical gates (all `TECHNICAL-GATE-PENDING`)

| Gate | Question | Milestone |
|---|---|---|
| **G1** | Does the pinned Chrome for Testing build accept `--remote-debugging-pipe` on **this Windows host**, with fd 3/4 wiring and NUL-framed JSON? (Puppeteer shows the pattern; our build is unproven) | MB3 preflight |
| **G2** | Do **broad** domains/methods behave over the pipe — including `Target.attachToTarget` flat sessions, `Network.enable`, `Fetch.enable`, `Page.captureScreenshot`? | MB3 preflight |
| **G3** | Correct multiplexing of responses and async events over one pipe; no interleaving corruption | MB3 |
| **G4** | Event queue bounds, backpressure policy, drop accounting, disconnect semantics | MB3 |
| **G5** | Profile startup/persistence, single-controller lease, stale-lease reclaim, agent handoff | MB4 |
| **G6** | Renderer-delivery attestation: does **any** mechanism prove receipt? (decides `delivered` vs `unavailable`) | MB4 |
| **G7** | MCP tool-count/schema change and regression strategy (adding raw-CDP tools to a 39-tool census) | MB2/MB3 |
| **G8** | Shutdown/EOF semantics: graceful `Browser.close`, pipe EOF, `/PID` cleanup, no orphaned Chrome | MB3 |

**No Chrome code ships until G1–G3 have evidence.** G1/G2 are the prereq checks that could still
invalidate the pipe choice; per the owner's instruction, a failure there is **reported, not
silently worked around**.

---

## 13. Reversion / disable plan and auditability

| Control | Detail |
|---|---|
| Default OFF | Zini starts in Min mode. The Chrome backend requires explicit configuration |
| Kill switch | Disabling the backend closes the pipe, releases the lease, terminates Chrome (`/PID`), and leaves the profile intact |
| No fallback | If the pipe fails, the backend **refuses**; it does not open a port |
| Removal | Deleting the backend module + config returns Zini to Min-only with no data migration |
| Auditability | Every raw CDP call is logged as `{ agentId, method, domain, paramsBytes, resultBytes, outcome }` — **never** params/result bodies, never tokens |
| Profile retention | `Min Agent Shared Chrome` persists by design; explicit purge command required before shipping |

---

## 14. Open questions

| # | Question | Owner/gate |
|---|---|---|
| O1 | Exact **pinned build** and re-pin window length | owner + G1 |
| O2 | Is `delivered` **ever** achievable on Chrome? If not, accept permanent `unavailable` | G6 |
| O3 | Event overflow policy: **drop-oldest** or **block**? | G4 |
| O4 | Raw-CDP tool **names and count** (census impact) | G7 |
| O5 | Does the raw interface expose `Browser.close` (self-termination) — allowed or filtered? | owner |
| O6 | Lease staleness grace period value | G5 |
| O7 | Where the profile lives (`%LOCALAPPDATA%` vs the Zini profile dir) | owner |
| O8 | Does `Fetch.*` interception require an additional policy acknowledgement? | owner |
| O9 | Is attaching to **user-opened** tabs (Q7) allowed without a per-tab consent prompt? | owner (currently: allowed by Q7) |

---

## 15. Corrections to historical documentation (append-only)

Per instruction, the original ADR-02 text is **not edited**. These are recorded here as factual
corrections:

| # | Defect | Current fact |
|---|---|---|
| C1 | `INTEGRATED-TARGET-ARCHITECTURE.md:100` ADR-02 **[SOURCE]** claims the bridge "uses no `webContents.debugger`" | **Stale.** `main/agentRpc.js:1297` uses it for the three approved bounded commands |
| C2 | `main/agentRpc.js:1279` comment says the allowlist "is exactly **two** commands" | **Stale.** It contains **three** |

**Min's allowlist is unchanged and verified this task** (`main/agentRpc.js:1282-1287`):

```js
const AGENT_RPC_CDP_ALLOWED = Object.freeze({
  'DOM.setFileInputFiles': true,
  'Accessibility.getFullAXTree': true,
  'Runtime.evaluate': true
})
```

---

## 16. What may proceed

| Milestone | Status |
|---|---|
| **MB1** — Min backend interface extraction (behaviour unchanged) | **MAY PROCEED** · gates: `agent-rpc-test` 306/306, `mcp-e2e` 93/93, Min probes green, census 39, no schema change, `probe:realweb` green |
| **MB2** — backend selection + session isolation | **MAY PROCEED**, Min-only operationally |
| **MB3** — Chrome pipe + raw CDP + events | **BLOCKED on G1–G4, G8** |
| **MB4** — lease/handoff/attestation | **BLOCKED on G5–G6** |
| **MB5–MB6** | **BLOCKED** behind MB3/MB4 |

Implementation may not begin until this ADR is recorded (**done**) **and** the gates have evidence.
