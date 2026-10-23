# ADR-02 Gate: Chrome Transport Decision

**Status: `PROPOSAL — NOT YET APPROVED`**
**Date:** 2026-10-20
**Related:** ADR-02 (no raw CDP), ADR-03 (three-stage truthfulness), ADR-05 (loopback transport), MB0 v2, R5/D6
**Task type:** architecture/ADR review only. **No source, schema, test, setting, or package change was made.**

---

## 1. The exact decision question

> Does ADR-02 prohibit **all** use of the CDP protocol internally, or does it prohibit
> **exposing a generic/raw CDP capability to agents** while permitting browser-specific,
> fixed, bounded, internally authored commands against an isolated Chrome process?

The question is narrow on purpose. It is **not** "may Min use CDP?" (it already does, in three
approved places) and **not** "should Min become a CDP client?" The question is what the existing
record already permits, and what it does not.

---

## 2. Current ADR-02 text and linked source-of-truth

### 2.1 The ADR itself (verbatim)

`docs/audit/INTEGRATED-TARGET-ARCHITECTURE.md:100`:

| Field | Text |
|---|---|
| **ID** | **ADR-02** |
| **Decision** | **"No raw CDP / no generic event drain."** Typed tools only. |
| **Rationale** | "Raw CDP is an unbounded channel into the renderer and defeats every grant, scheme, and path control. This is a deliberate, documented refusal, not a gap." |
| **Evidence** | **[REPORT]** Phase B B6/E4. **[SOURCE]** "the bridge registers zero `webRequest.onBeforeRequest` and uses no `webContents.debugger`; page access is exclusively `executeJavaScript` (22 sites) + `sendInputEvent`." |

Two further restatements, both scoped to the *agent-facing* surface:

- `:691` — parity row B6 "Raw CDP / event drain": **"Never."** (column: agent capability)
- `:787` — "B6 · Raw CDP pass-through · Not applicable by design · **NA forever** · ADR-02. Never."

### 2.2 Direct text vs interpretation

**Direct from the record:** the ban is written against **"raw CDP"** and **"generic event drain"**,
and the rationale names **"an unbounded channel into the renderer"** and **"defeats every grant,
scheme, and path control"**. The parity restatements are in the *capability/agent-surface* context
(B6 is a Browser-Harness parity feature = "arbitrary CDP from the agent").

**Interpretation (mine, flagged as such):** ADR-02 targets *unbounded, caller-authored* CDP
surfaced to agents. Nothing in the text bans a fixed, reviewed, internal command.

**But** the ADR's own **[SOURCE]** claim — "uses no `webContents.debugger`" — is **now factually
stale** (§3). That matters: part of ADR-02's stated evidence no longer describes the code.

### 2.3 Canonical source of truth

| Item | Path | Note |
|---|---|---|
| Canonical register | `docs/audit/Min-Agent-Edition-Master-Scope-Register.md` | **the only register on disk** (verified) |
| Stale path | `docs/audit/Master-Scope-Register.md` | **does not exist** — earlier references were stale |
| Architecture/ADRs | `docs/audit/INTEGRATED-TARGET-ARCHITECTURE.md` | ADR-02 at `:100`, OD-3 at `:5.1` |
| MB0 audit | `docs/audit/MULTI-BROWSER-BACKEND-ARCHITECTURE.md` | §10 names this ADR as the MB3 blocker |
| Runtime decision | `docs/audit/D6-RUNTIME-EVALUATION.md` | `STAY_ELECTRON` |

### 2.4 Fresh baseline

| Item | Value |
|---|---|
| Branch / HEAD | `main` / `2b8088e` |
| Staged | **0** |
| Tracked modified / untracked | 155 / 125 |
| Electron processes | 0 |
| Stashes | 0 |
| Tool census (registry/schemas/dispatch/adapter) | **39 / 39 / 39 / 39** |

---

## 3. Existing bounded-CDP precedent — and whether it transfers

### 3.1 The precedent is explicit and was approved three times

`Min-Agent-Edition-Master-Scope-Register.md:1848-1856` records a table headed **"Decisions taken
before code (stop-conditions resolved by explicit approval)"**:

| Question | Decision (as recorded) |
|---|---|
| C6 upload executor | "**Single allowlisted CDP command** (approved)" |
| B4 AX source | "**Second scoped CDP allowlist entry** (approved)" |
| C6 node handle | "**`Runtime.evaluate` added** (approved)" |

And the closing line, verbatim:

> "**Resulting CDP surface is a closed, three-command allowlist** (`AGENT_RPC_CDP_ALLOWED`):
> `DOM.setFileInputFiles`, `Accessibility.getFullAXTree`, `Runtime.evaluate`. **ADR-02's ban on
> generic raw CDP stands** — no caller can name a command or pass arbitrary CDP params; every
> expression is bridge-assembled from validated integers."

The architecture had already anticipated this shape at `:704`: adopting CDP for upload "is a
**scoped exception, not a general CDP opening**. It must be a closed allowlist of exactly that
command".

### 3.2 The live implementation

`main/agentRpc.js:1282-1287`:

```js
const AGENT_RPC_CDP_ALLOWED = Object.freeze({
  'DOM.setFileInputFiles': true,
  'Accessibility.getFullAXTree': true,
  'Runtime.evaluate': true
})
```

`agentRpcCdpOnce` (`:1290`) rejects any command not on the object before touching the debugger
(`:1292-1295`), attaches with protocol `1.3`, and every call site passes bridge-assembled
params only (`:1398`, `:1402`, `:2557`).

### 3.3 What transfers to Chrome, and what does not

| Precedent property | Transfers to Chrome? | Why |
|---|---|---|
| Closed allowlist **in source** | **Yes** — template to copy | Same shape, larger set |
| Caller never names a command | **Yes** — mandatory | The core of ADR-02 |
| Caller never supplies raw params | **Partially** | Some commands need validated *values* (selector, rect); they must be bridge-assembled from typed inputs |
| Same-process, per-`webContents` attach | **No** | Chrome backend is a different process |
| "Three commands total" | **No** | A Chrome backend needs whole method *families* |
| No event subscription | **Breaks here** | `network_idle` and waits need events — this is the real gap, see §6 |

### 3.4 Two documentation defects found (reported, not fixed)

Per the task's "do not edit ADR-02's historical text":

1. ADR-02's **[SOURCE]** cell claims the bridge "uses no `webContents.debugger`". It now does
   (`main/agentRpc.js:1297`, one occurrence). The evidence line is stale relative to the approved
   exceptions in §3.1.
2. `main/agentRpc.js:1279` says "it is exactly **two** commands" while the frozen list contains
   **three**. A comment-only drift.

**Neither is corrected here**; both need an owner-approved doc correction, because ADR-02's text
is append-only history.

---

## 4. Options A/B/C/D comparison

### Option A — Strict ADR-02

No CDP transport for Chrome at all.

| | |
|---|---|
| **Benefit** | Zero new transport risk; no ADR change; ADR-02 untouched |
| **Risk** | Chrome support does not ship. The only non-CDP path (extension content scripts) cannot produce trusted input or full-page capture, so `click`/`type` would violate ADR-03 or be permanently unusable |
| **Compatibility** | Perfect — nothing changes |
| **Verdict** | **Viable but product-empty.** Honest outcome: Chrome is read-only forever, or deferred |

### Option B — Narrow browser-driver exception (new ADR)

CDP inside a dedicated Chrome adapter, attached to a **separately launched, isolated** Chrome
(For Testing preferred), no generic CDP over MCP, commands fixed in reviewed source.

| | |
|---|---|
| **Benefit** | Genuine Chrome parity; reuses the proven allowlist pattern |
| **Risk** | Debug port exposure; much larger method surface than 3 commands; event subscriptions needed for waits |
| **Compatibility** | **Requires a formal amendment/exception.** It is **not** already allowed merely because 3 commands were |
| **Verdict** | **Works, but with real exposure** (§5) |

### Option C — Defer interaction; read-only Chrome only

Extension + native messaging, or another vetted channel, for observation only.

| | |
|---|---|
| **Benefit** | No debug port, no CDP-for-interaction; honest scope |
| **Risk** | Cannot do `click`/`type` (`isTrusted:false`), cannot do full-page capture (visible-tab only) |
| **Compatibility** | Fully compatible with ADR-02 (no CDP) |
| **Verdict** | **Honest, limited**; ships a partial backend |

### Option D — Extension `chrome.debugger` transport (**new, from source evidence**)

Use the **extension** `chrome.debugger` API as the transport instead of a debugging port.

| | |
|---|---|
| **Benefit** | **No debug port, no token, no loopback listener.** Google documents it as "an alternate transport for Chrome's remote debugging protocol" with a **restricted domain list** enforced by Chrome itself. Trusted `Input.*` is available, so ADR-03 can be honoured |
| **Risk** | Still CDP semantics (so still needs the exception); requires a `"debugger"` permission the user must grant; **Chrome shows an infobar while attached**; enterprise policy can block `attach()` |
| **Compatibility** | Still **requires** an ADR-02 exception, but the *transport* attack surface is materially smaller than an open port |
| **Verdict** | **Strongest technical option** — recommended for MB3 |

Documented facts for Option D (checked 2026-10-20,
`developer.chrome.com/docs/extensions/reference/api/debugger`):

- `chrome.debugger` "serves as an alternate transport for Chrome's remote debugging protocol";
  targets are addressed by `tabId`/`targetId` and events routed by `tabId`.
- Requires the `"debugger"` manifest permission.
- **"For security reasons, the `browser.debugger` API does not provide access to all Chrome
  DevTools Protocol Domains."** Allowed domains include `Accessibility`, `DOM`, `DOMSnapshot`,
  `Emulation`, `Input`, `Network`, `Overlay`, `Page`, `Runtime`, `Target`, `Storage`, `Log`,
  `Fetch`, `CSS`, `Performance`, `Tracing`, `WebAudio`, `WebAuthn`, `Debugger`, `Console`,
  `Inspector`, `IO`, `CacheStorage`, `Database`, `DOMDebugger`, `Audits`.
- **Enterprise policy can block attach**: `runtime_blocked_hosts` yields *"Host access is
  restricted by policy."*; `DisableScreenshots`/DLP yields *"Screenshot capture is restricted by
  policy."*
- `onDetach` fires with reason `target_closed` or **`canceled_by_user`**.
- Flat sessions (Chrome 125+) allow child-target commands via `sessionId`.

**Note the domain restriction cuts both ways:** it *removes* several dangerous domains
(e.g. `Browser` domain is **not** in the allowed list, which is why
`download_pause`/`download_resume` and `Browser.setDownloadBehavior` are **not available** via
Option D — see §6).

### 4.1 Comparison table

| | A: Strict | B: Port + allowlist | C: Read-only ext | **D: `chrome.debugger` ext** |
|---|---|---|---|---|
| ADR-02 change needed | none | **yes** | none | **yes** |
| New network listener | no | **yes** (loopback) | no | **no** |
| Token/session binding needed | n/a | **yes** | per-port | via extension port |
| Trusted input (`click`/`type`) | impossible | yes | **no** (`isTrusted:false`) | yes |
| Full-page capture | no | yes | **no** (visible tab only) | yes (`Page.captureScreenshot`) |
| Event-based waits | no | yes | limited | yes (allowed domains) |
| Chrome-imposed domain cap | n/a | **no** (all domains) | n/a | **yes** |
| User consent artifact | — | flag + token | extension install | extension install + visible infobar |
| Chrome 136 port restriction | n/a | isolated profile required | n/a | **not applicable** |
| ADR-03 compliance ceiling | honest `unavailable` | full | **delivery unusable** | full |

**Recommendation: Option D** (with Option B as fallback if `chrome.debugger` proves unusable on a
target Chrome build). Both require the same amendment; D is strictly smaller surface.

---

## 5. Option B threat model and guardrails (required even for D)

Option D removes the port but keeps **all** the protocol-level risks. Both are addressed here.

### 5.1 Threat model — the debug channel is privileged

| # | Threat | Option B exposure | Option D exposure | Control (required for either) |
|---|---|---|---|---|
| T1 | Anything on the host connects to the debug port | **High** (open TCP) | **None** (no port) | B: loopback-only + ephemeral port + per-launch 32-byte token re-read per call (ADR-05 pattern) |
| T2 | Local malware attaches as a *second* debugger | High | Low | B: token + single-client enforcement. D: Chrome allows one debugger session per tab; `onDetach` reason `canceled_by_user` visible |
| T3 | DNS-rebinding / browser-driven request to the port | High | None | B: `Host` must equal `127.0.0.1:<port>`, reject `Origin`/`Sec-Fetch-*` (existing ADR-05 validator) |
| T4 | Attaching to the **user's everyday profile** | Prohibited (Chrome 136 forces custom dir, but must not be worked around) | **Must not** attach to arbitrary user tabs without consent | Launch an **isolated** profile; D must attach only to tabs the adapter opened |
| T5 | Command/param injection from the agent | n/a (no path) | n/a | **Single place** in source writes command names; params bridge-assembled from typed inputs |
| T6 | Policy/grant bypass by doing it "in CDP" | High if unconstrained | Same | `agentRpcPolicyAllows` → single-use `agentRpcConsumeGrant` **before** any command (unchanged order) |
| T7 | Origin/frame confusion, stale refs | High | Same | Refs namespaced `(backend, tabId, generation)`; `stale_backend` distinct from `ref_stale` (MB0 §7.1) |
| T8 | Secrets in results/snapshots/logs | Same as Min | Same | Existing redaction at write time; no page values; no tokens logged |
| T9 | Evading access controls / automating human verification | **Prohibited** | **Prohibited** | No challenge interaction; CAPTCHA detection remains informational |
| T10 | Crash/restart mid-operation | Same | Same | `lost` state; no auto-retry; grants never replayed |
| T11 | Extension compromise (D only) | — | Medium | Exact `allowed_origins`; validate `sender.origin` (documented guidance); no wildcards |
| T12 | Enterprise-blocked attach | — | Medium | Surface `attach()` policy errors as structured `unsupported_on_backend`, never as success |

### 5.2 Guardrails (non-negotiable, for either option)

1. **One constant, in source.** `CHROME_CDP_ALLOWED` mirrors `AGENT_RPC_CDP_ALLOWED`: a frozen
   object literal. No string arrives from a caller.
2. **No generic method/param passthrough.** No tool accepts `method` or `params`.
3. **Bounded families only.** Permitted domains must be justified one by one in the ADR annex;
   anything requiring `Browser`, `Debugger.pause`, or `Target.setDiscoverTargets` is **out**.
4. **No event stream to the agent.** Events may be consumed internally for bounded waits; they
   are never surfaced as a subscription tool (that is the "generic event drain" ADR-02 forbids).
5. **Policy before dispatch.** Existing ordering preserved exactly.
6. **Isolated profile only.** Never attach to a user's default data directory (Chrome 136), never
   to tabs the adapter did not open without explicit consent.
7. **`/PID`-targeted cleanup only.**

### 5.3 Tests that must exist before Chrome ships (Layer A/B)

- unknown command → denied, never forwarded;
- malformed/oversized params → rejected by the bridge validator;
- wrong session id → denied;
- port/token failure (B) or attach failure / `canceled_by_user` (D) → structured error;
- process cleanup leaves zero processes;
- grant consumed exactly once, and **not** consumed on a rejected call;
- ref from another backend → `stale_backend`;
- pinned allowlist: an assertion that the constant's **keys** equal a documented list.

---

## 6. Tool-family impact and the evidence contract

ADR-03 requires `dispatched` / `delivered` / `verified` to be reported independently. Mapping
each family for **Option D** (Option B is equivalent except where noted):

| Family | Chrome mechanism (D) | `dispatched` | `delivered` | `verified` | Honest outcome |
|---|---|---|---|---|---|
| Read-only observation (`status`, `tabs`, `snapshot`, `content`, `state`, `frames`, `predict`) | `Runtime.evaluate`, `DOMSnapshot`, `Page.getFrameTree` | n/a | n/a | n/a | full |
| `browser_eval` | `Runtime.evaluate` | n/a | n/a | n/a | full; **CSP-honest** (same `csp_blocked` class) |
| Navigation | `Page.navigate` + load events | yes | n/a | URL/title/readyState | full |
| `click` / `type` / `press` / `hover` / `mouse` | `Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent` | yes | **`Input` is trusted browser input** — but *no page-side attestation counter exists* | DOM change / value / focus-diff | **`delivered` = `unavailable`** unless an attestation channel is added; `verified` from page state only |
| `scroll` | `Input.dispatchMouseEvent` wheel or `Runtime.evaluate` | yes | wheel: **unavailable** (compositor, same as Min) | `scrollY` delta | partial, honest |
| `select` / `check` | DOM set + synthetic events | yes | **unavailable** (synthetic) | value/checked re-read | `delivered: unavailable`, `verified` from state |
| `wait` (`ready_state`, `selector_visible`) | `Page` + `Runtime` polling | n/a | n/a | satisfied/not | full |
| `wait` (`network_idle`) | `Network.*` events (domain **allowed**) | n/a | n/a | drained | full **if** internal event consumption is approved |
| `screenshot` | `Page.captureScreenshot` | n/a | n/a | metadata | full, incl. honest `completeCapture` |
| `screenshot` fullPage | `captureBeyondViewport: true` | n/a | n/a | `completeCapture` | full (Chrome does natively what Min stitches) |
| `pdf` | `Page.printToPDF` | n/a | n/a | bytes | full |
| `upload` | `DOM.setFileInputFiles` | yes | **unavailable** | `input.files` re-read | same as Min |
| `downloads` (list/wait) | adapter ledger | n/a | n/a | terminal state | full |
| `download_start` | **`Browser.setDownloadBehavior` — domain NOT available in D** | — | — | — | **`unsupported_on_backend`** in D; available in B |
| `download_pause` / `resume` | **no CDP command** | — | — | — | **`unsupported_on_backend`** in both |
| `transform` / `transform_status` | `Runtime.evaluate` + shared bookkeeping | n/a | n/a | re-read | full |
| `verify` | page inspection | n/a | n/a | boolean | full |
| `grant` / `batch` | adapter-side | n/a | n/a | n/a | full (shared) |
| Min-only (window/menu/settings, `min://`, last-tab, dialog observation, ad-block counters, preload attestation) | — | — | — | — | **never faked; `unsupported_on_backend`** |

**Consequence for ADR-03:** the Chrome backend can report `dispatched` and `verified` honestly,
but **`delivered` has no equivalent to Min's preload attestation counter** unless a separate
attestation channel (e.g. an extension content-script counter) is built. The contract does **not**
need weakening: `delivered` is simply reported as `unavailable`. If a future design wants
`delivered` on Chrome, that is a **separately reviewed schema/ADR change**, not an implicit one.

---

## 7. Recommended option and rationale

> **Recommend `Option D` — extension `chrome.debugger` transport, under a new ADR-02 amendment**
> (fallback: Option B if `chrome.debugger` is unusable for a required family).

Evidence-based reasoning:

1. **The precedence is already established in the record.** Three scoped CDP exceptions were
   explicitly approved, each recorded as an exception, with ADR-02's generic ban preserved
   (§3.1). A fourth exception is a *decision of the same kind*, not a reversal — provided it is
   explicitly approved, which is why this document exists.
2. **Option D is materially smaller than Option B.** No listening port, no loopback token, no
   rebinding surface (T1–T3). Chrome itself enforces a **domain allowlist** the project does not
   have to maintain.
3. **Option D can satisfy ADR-03** where extension content scripts cannot: `Input.*` is trusted,
   so `dispatched` is real. Option C leaves `click`/`type` permanently unable to report delivery
   honestly.
4. **Option A is safe but product-empty** and would strand Chrome support forever.
5. **The remaining gap is `delivered`, and it is honestly reportable as `unavailable`** — no
   contract weakening required.

---

## 8. Unresolved questions requiring **owner approval**

| # | Question | Why it blocks |
|---|---|---|
| **Q1** | **Does the owner grant an ADR-02 amendment for a fourth CDP exception (Option D)?** | The entire MB3 path. Without an explicit yes, Option A/C are the only lawful outcomes |
| **Q2** | Is the exception scoped to **extension `chrome.debugger`** (D), a **loopback port** (B), or both? | Determines the threat model actually adopted |
| **Q3** | Which **CDP domains** are approved for the constant? (proposed: `Runtime`, `DOM`, `DOMSnapshot`, `Page`, `Input`, `Network`, `Accessibility`, `Emulation`, `CSS`, `Log`) | Every domain is a capability; this list *is* the security boundary |
| **Q4** | May events be **consumed internally** for bounded waits (`Network.*`) while remaining unavailable to the agent? | ADR-02 bans "generic event drain"; internal bounded use is arguably different and needs a ruling |
| **Q5** | Is Chrome-for-Testing the required target, or is installed `chrome.exe` acceptable? | Chrome 136 port restriction and consent story differ |
| **Q6** | Consent model for the `"debugger"` permission + the visible Chrome infobar while attached | User-facing, cannot be assumed |
| **Q7** | May the adapter attach to tabs it did **not** open (same isolated profile)? | Determines T4 |
| **Q8** | If `delivered` must exist on Chrome, is a new attestation channel in scope? | Otherwise `delivered: unavailable` is permanent for Chrome |

---

## 9. Consequences for MB1–MB6

| Milestone | Status under this proposal |
|---|---|
| **MB1** — extract the Min backend interface, behaviour unchanged | **MAY PROCEED NOW.** It touches no Chrome transport and no ADR. Gates: `agent-rpc-test` **306/306**, `mcp-e2e` **93/93**, all Min probes green, census **39**, **no schema change**, `probe:realweb` green |
| **MB2** — backend selection + session isolation, Min-only operationally | **MAY PROCEED**, with one caveat: `backend.json` must accept only `min` until Q1 is answered, so an approved-outcome cannot leak early |
| **MB3** — first Chrome path | **BLOCKED** pending Q1 (+ Q3, Q5, Q6) |
| **MB4–MB6** | **BLOCKED** behind MB3 |

**You may start MB1 immediately.** Nothing in this document authorises Chrome code.

---

## 10. Status and final state

**`PROPOSAL — NOT YET APPROVED`**

### Files written by this task

| File | Nature |
|---|---|
| `docs/audit/ADR-02-CHROME-TRANSPORT-DECISION.md` | this document (new) |
| `docs/audit/Min-Agent-Edition-Master-Scope-Register.md` | **appended** pointer only; marked proposed/pending |

### Final Git state

| Item | Value |
|---|---|
| HEAD | `2b8088e` |
| Branch | `main` |
| Staged | **0** |
| Tracked modified / untracked | 155 / 125 → 125 (no source file changed) |
| Electron processes | **0** |
| Tool census | **39 / 39 / 39 / 39** |
| Commit / push | **none** |

### Confirmations

- **No production code, schema, test, setting, or package changed.** Verified by mtime.
- **ADR-02's historical text was not edited**, nor was any R0–R5/MB0 register history. The two
  documentation defects in §3.4 are **reported, not fixed**.
- Nothing restored, nothing formatted, nothing staged, committed, or pushed.
- No Chrome was launched, no CDP connection was made, no prototype was built.
- The three-command allowlist was **not** broadened.

### Untested assumptions

1. That `chrome.debugger`'s allowed-domain list is stable across Chrome releases.
2. That trusted `Input.*` through an extension satisfies ADR-03's `dispatched` in practice — this
   needs measurement, not assertion.
3. That internal (agent-invisible) `Network.*` consumption is compatible with ADR-02's intent.
4. That no approved domain hides an unbounded capability (e.g. `Tracing`, `Fetch`) — **each domain
   needs its own review before inclusion**.
