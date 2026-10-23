# D6 / R5 — Browser Runtime Evaluation

**Date:** 2026-10-20
**Type:** decision gate (no production engine switch)
**Decision:** **`STAY_ELECTRON`**

---

## 1. Baseline and source-of-truth paths

| Item | Value |
|---|---|
| Canonical register | `docs/audit/Min-Agent-Edition-Master-Scope-Register.md` |
| Architecture | `docs/audit/INTEGRATED-TARGET-ARCHITECTURE.md` (ADR-06 engine cadence; ADR-02 no raw CDP) |
| Phase C investigation | `docs/audit/CLOAKBROWSER-PHASE-C-INVESTIGATION.md` |
| Parity matrix | `docs/audit/BROWSER-HARNESS-FEATURE-PARITY.md` |
| Branch / HEAD | `main` / `2b8088e0838524cad5cba92d77a0680897f75429` |
| Staged / modified / untracked | **0** / 155 / 108 (preserved, unchanged by this task) |
| Electron processes | 0 |
| Node / npm | v24.19.0 / 11.17.0 |

**Working tree preserved exactly.** No commit, push, stage, reset, clean, stash, restore, or
repository-wide formatter. No production code, test, config, or documentation content was
changed in this task; only new D6 evidence scripts + evidence files + this report were added.

---

## 2. Current runtime versions — VERIFIED, not assumed

Read from a live Min instance through the shipped MCP adapter (`browser_status`), not from
`package.json`:

| Runtime | Version |
|---|---|
| Min Agent Edition | 1.35.7 |
| **Electron** | **43.4.1** |
| **Chromium** | **150.0.7871.224** |
| Node (in Electron) | 24.18.1 |
| Platform | win32 x64 |

The reported baseline was accurate. Cross-checks: `node_modules/electron/package.json` = 43.4.1,
`dist/version` = 43.4.1, and the official `electron/electron` `DEPS` for tag `v43.4.1` declares
`chromium_version = 150.0.7871.224`.

Control runtimes present on this machine: **Google Chrome 155.0.8059.84**, Edge 155.0.4283.62.

---

## 3. Official CloakBrowser license analysis

Checked **2026-10-20** against the live repository and raw license file:

| Source | URL |
|---|---|
| Repository | https://github.com/CloakHQ/CloakBrowser |
| Binary license (full text read) | https://raw.githubusercontent.com/CloakHQ/CloakBrowser/main/BINARY-LICENSE.md |
| Wrapper license | https://github.com/CloakHQ/CloakBrowser/blob/main/LICENSE (MIT) |
| Release/diagnostic docs | repo `README.md` (PyPI/npm badges), `cloakbrowser.dev` |

`BINARY-LICENSE.md` is **v1.3 — July 2026** (unchanged from the Phase C audit).

| Term | Where | Effect on Min Agent Edition |
|---|---|---|
| Grant of Use | "Grant of Use" | non-exclusive, non-transferable, non-sublicensable; personal/commercial/internal |
| **Restriction 1** | "Restrictions" §1 | **"You may NOT: Redistribute the Binary, in whole or in part"** → **bundling/embedding in Min is prohibited** |
| Restriction 2 | §2 | no resale/sublicense/repackage or inclusion in a product distributed to third parties |
| Restriction 3 | §3 | no reverse engineering/decompiling/deriving source |
| Restriction 4 | §4 | no modifying the Binary or creating derivative works |
| Internal use | "Cloud, Container, OEM/SaaS" | self-hosted internal operation (incl. Docker/CI/internal repos) **permitted** |
| **OEM/SaaS** | same section | **separate license required** when the Binary is "bundled, embedded, exposed through an API, or used to provide browser functionality to third-party customers" |
| Dependency listing | same section | listing CloakBrowser as a dependency is **not** redistribution, provided end users download the Binary from CloakHQ directly |
| Data collection | "Data Collection" | no intentional telemetry; **license validation and concurrent-session monitoring are built in** |
| Liability cap | "Limitation of Liability" | lesser of US $150 or amount paid in prior 3 months |

**Free entitlement (from the official README, 2026-10-20):** the latest binary (Chromium 154) is
free with a GitHub sign-in at **one concurrent session**; the older **v146** binary "stays free
on GitHub Releases" with no key.

**Permission for the test performed here:** running an already-cached binary locally, on one
machine, for internal evaluation, is within "Grant of Use" + "internal use". It is **not**
redistribution, embedding, or reverse engineering.

### Unresolved / ambiguous (flagged, not guessed)

1. Whether the OEM/SaaS clause would treat "a user's own agent driving their own local Min"
   as third-party access to browser functionality. This is an OEM/SaaS-review question.
2. Whether the v146 GitHub-Releases download is governed **solely** by `BINARY-LICENSE.md` or
   also by separate `cloakbrowser.dev` ToS.
3. If Min ever built its **own** Chromium/ungoogled-chromium engine, BSD-3-Clause
   Chromium + ungoogled notices and source-availability obligations would apply
   independently of CloakHQ.

### Provenance of the binary used

A v146 build was already cached at `%USERPROFILE%\.cloakbrowser\chromium-146.0.7680.177.5\`
(`chrome.exe` ProductVersion `146.0.7680.177`). The extracted `chrome.exe` carries **no
Authenticode signature**; authenticity is established instead at **download** time by the
wrapper, which verifies `SHA256SUMS` against a detached Ed25519 signature using **pinned public
keys** before extraction (`cloakbrowser/download.py`, `_verify_download_checksum`). Recorded
honestly: the on-disk file's provenance is the wrapper's pinned-key check, not an OS signature.

---

## 4. Test matrix, environment, repetitions, raw observations

**Environment (identical for every run):** Windows x64, 2026-10-20, same machine, same network,
same URL set, fresh profile per run, headed unless stated. Repetitions noted per probe.
Scripts and raw JSON evidence are listed in §7.

### 4a. Fair runtime comparison — general pages (`docs/d6-runtime-compare-headed.json`)

2 reps × 5 targets, Min vs Chrome 155, headed, median time to a usable title:

| Target | Min (Chromium 150) | Chrome 155 | Observation |
|---|---|---|---|
| example.com | 590 ms | 418 ms | both correct |
| httpbin.org/html | 1231 ms | 1051 ms | both correct |
| en.wikipedia.org/wiki/CSS | 883 ms | 634 ms | both correct |
| iana.org/help/example-domains | 612 ms | 423 ms | both correct |
| novellive.com | challenge, no clear | **cleared rep 1; challenge rep 2** | **the only divergence** |

**Observed:** on ordinary pages the two runtimes are equivalent within run-to-run noise;
Min is consistently a little slower to a stable title (extra settle window + view attach).
The only behavioural divergence is the Cloudflare-challenged page.

### 4b. Challenge-clearance, headed (`docs/d6-novellive-probe.json`)

3 reps, 30 s timeout, fresh profile each, polling the page title:

| Runtime | Cleared | Typical |
|---|---|---|
| Min (Electron 43 / Chromium 150) | **0 of 3** | stayed on "Just a moment..." |
| Chrome 155.0.8059.84 | **3 of 3** | 2562 / 2551 / 3048 ms |

Reproduces the Phase C observation on today's binaries.

### 4c. Headless control (`docs/d6-novellive-headless.json`)

2 reps, Chrome launched `--headless=new`:

| Runtime | Cleared |
|---|---|
| Min | 0 of 2 |
| Chrome 155 headless | **0 of 2** |

**This is a crucial control:** Chrome in **headless** mode also fails the same challenge. Any
future comparison MUST be headed, or it measures headless detection rather than the runtime.

### 4d. Third runtime — CloakBrowser v146, no stealth flags (`docs/d6-novellive-cloak.json`)

2 reps, headed, launched exactly like the Chrome control (no wrapper, no
`--fingerprint*` flags, no `humanize`):

| Runtime | Cleared |
|---|---|
| Min (Chromium 150) | 0 of 2 |
| **CloakBrowser 146** | **2 of 2** (4221 / 2534 ms) |

**Observed:** a **lower** Chromium (146) on a non-Electron runtime clears the challenge that
Chromium 150 inside Electron does not. This alone falsifies "the Chromium version is the cause".

### 4e. Electron upgrade control (`docs/d6-electron-compare.json`)

Same minimal Electron main, same machine/network, headed, fresh profile, 2 reps. Electron 44.9.1
was installed into a **throwaway directory under `%TEMP%`** (project dependency untouched) and
verified to report Chromium 152.0.7977.167:

| Build | Cleared |
|---|---|
| Electron **43.4.1** / Chromium 150.0.7871.224 | **2 of 2** (~3.04 s) |
| Electron **44.9.1** / Chromium 152.0.7977.167 | **2 of 2** (~3.05 s) |

**Decisive:** a *bare* Electron 43 app — the exact engine the product ships — clears the
challenge in ~3 s. The upgrade changes nothing. **The Chromium version is not the cause.**

### 4f. User-Agent inspection (`docs/d6-useragent.json`)

| Runtime | User-Agent |
|---|---|
| Min | `… MinAgentEdition/1.35.7 Chrome/150.0.0.0 Safari/537.36` |
| Chrome 155 | `… Chrome/155.0.0.0 Safari/537.36` |
| CloakBrowser 146 | `… Chrome/146.0.0.0 Safari/537.36` |

`main/UASwitcher.js` strips `Min/x` and `Electron/x` and zeroes the Chromium minor/patch, but
**does not strip the edition's own product token** (`MinAgentEdition/1.35.7`), which no real
Chrome sends.

### 4g. Controlled single-variable attribution (`docs/d6-ua-controlled.json`)

Same Electron 43 binary, 2 reps, headed; **only** the UA product token differs:

| Variant | Cleared |
|---|---|
| control — default Electron UA | **2 of 2** (~3.06 s) |
| treatment — default UA + `MinAgentEdition/1.35.7` | **0 of 2** ("Just a moment...") |

### 4h. Fix verification (`docs/d6-ua-fix-verify.json`)

Same Electron 43 binary, 2 reps each, headed; UA variants:

| Variant | User-Agent tail | Cleared |
|---|---|---|
| A — exactly as Min sends today | `MinAgentEdition/1.35.7 Chrome/150.0.0.0` | **0 of 2** |
| B — product token removed | `Chrome/150.0.0.0` | **2 of 2** (~3.08 s) |
| C — token removed, full Chromium version | `Chrome/150.0.7871.224` | **2 of 2** (~3.05 s) |

**Causal conclusion (observed, not inferred):** for this site the operative difference is the
**`MinAgentEdition/1.35.7` User-Agent product token**, an application-layer string, not the
engine. Removing it clears the challenge on the *same* Electron 43 / Chromium 150. The
Chromium minor/patch revision is irrelevant (B and C both pass).

---

## 5. Live-site results, separated from fixtures and historical reports

| Category | What it is |
|---|---|
| **Live (this task)** | §4a–4h: real public pages, real Cloudflare challenge, headed, fresh profiles, repeated. Raw JSON in `docs/d6-*.json`. |
| **Historical (Phase C)** | Novellive "Min 90 s vs Chrome 3 s" observation and the **HIGH-confidence** root cause ("Electron/Chromium TLS/protocol version gap"). |
| **Fixtures / loopback** | none used for the runtime comparison. The R3/R4 loopback stand-ins are irrelevant here and were not used as acceptance. |
| **R3 real-web / R4 evidence** | **historical, not re-run** for this task. |

**Correction to the historical record:** the Phase C root-cause hypothesis is **not supported**.
A bare Electron 43 (same Chromium) clears the challenge (§4e), and removal of a UA token flips
the outcome on that same binary (§4g/4h). The engine version was a plausible but incorrect
inference. This report supersedes that specific hypothesis; the Phase C *licensing* findings
stand unchanged and were re-verified today.

Not evaluated on live sites, and why:

- **CAPTCHA solving / bypass** — prohibited. The challenge was never interacted with, clicked or
  solved. Where it did not clear, that is reported as the result.
- **Account creation, posting, purchasing, destructive actions** — prohibited and unnecessary.
- **Downloads, frames, MCP-shaped workflow parity across runtimes** — CloakBrowser/Chrome expose
  only a CDP/Playwright path; Min exposes its MCP bridge. A "comparable documented path" for the
  others would be raw CDP, which **ADR-02 forbids inside Min**. Comparing those surfaces would
  measure different APIs, not the runtimes.

---

## 6. Electron-upgrade alternatives and risks (Workstream C)

Verified against the official npm registry and each tag's `DEPS`:

| Electron | Chromium | Status | Notes |
|---|---|---|---|
| **43.4.1 (current)** | 150.0.7871.224 | supported 43.x line | ships today |
| 43.8.1 | 150.0.7871.250 | newest 43.x | patch-level Chromium only |
| **44.9.1** (`latest`) | **152.0.7977.167** | current stable major | **installed and launched successfully in a temp dir** (§4e) |
| 45.0.0-beta.5 | 156.0.8078.36 | beta | not appropriate for a stability-sensitive browser |

Risks and impact:

- **API/ABI:** the product uses `WebContentsView`, `webContents.capturePage`, `printToPDF`,
  `executeJavaScript`, `sendInputEvent`, `session` webRequest, and an isolated preload. Electron
  43→44 is a normal major; those APIs are stable, but every one needs a smoke + full probe pass.
- **Native modules:** the only native-ish dependency is `node-abi` (a version-mapping helper, no
  compiled addon). **No `node-gyp`/prebuild module is rebuilt**, which removes the usual upgrade
  risk here.
- **Packaging:** `buildWindows/Mac/Debian/Redhat/AppImage` must be regenerated; `dist/app` is
  already stale (D8).
- **Profiles:** Chromium major bumps can migrate on-disk profile data. Upgrade testing must use a
  **disposable profile copy**, never a user profile in place.
- **Security cadence:** staying on a supported major is the security-relevant action. 43.4.1 is
  current-ish, but 43.x receives fewer fixes than the current stable major.
- **Rollback:** pin the exact Electron version in `package.json`, keep `package-lock.json`
  committed, and keep a `dist/app` artifact from the last known-good build. Rollback = revert the
  pin + `npm ci`; no data migration is needed if profiles are never opened by the new build.

**But:** §4e shows the upgrade does **not** change the observed challenge outcome.

---

## 7. Decision

> ### `STAY_ELECTRON`

Basis, in order of strength:

1. **The compatibility driver is not the engine.** A bare Electron 43 app clears the challenged
   page in ~3 s on the exact shipping engine (§4e), and the product's failure is reproduced and
   fixed by changing a **User-Agent token** on that same binary (§4g/4h). Migrating engines would
   not address the observed defect.
2. **CloakBrowser cannot be embedded.** `BINARY-LICENSE.md` v1.3 Restriction 1 prohibits
   redistribution in whole or in part; embedding/exposing requires a separate OEM/SaaS license.
   Min is a distributed desktop product, so bundling is out of scope absent that license
   (§3).
3. **Its advantage is not reproducible in-house.** The 87 C++ patches are compiled into the
   proprietary binary and are absent from the public repo (Phase C, re-confirmed: repo tree has
   no `chromium/`, `patches/`, or `.patch` files). Restriction 3 forbids deriving them.
4. **Upgrading Electron is cheap and available when needed** (§6) — we measured that 44.9.1
   installs and launches on this machine — so "no engine change now" does not close the door.
5. Everything else measured is at parity (§4a).

**No migration. No prototype. No new dependency.** A production engine switch would still
require separate explicit approval after this gate.

---

## 8. Prototype prerequisites (why none is proposed)

A CloakBrowser prototype would require, at minimum:

- an **OEM/SaaS licence determination** before any product-adjacent use (unresolved, §3);
- a separate process/profile with no shared writable profile and no copied user data;
- a CDP-based automation path — which **contradicts ADR-02** for anything inside Min, and would
  make the comparison measure a different API than the product's MCP bridge;
- a bounded acceptance suite and artifact-retention plan.

Given §4e/§4g (the defect is ours, in the UA), the prototype would answer a question we no longer
need answered. **Not proposed.**

---

## 9. Untested assumptions and limitations

1. **Novellive is a compatibility case, not a CAPTCHA feature** (ADR-07). The UA finding explains
   the observed failure on this site; it does **not** generalise to all Cloudflare sites, and no
   claim is made that stripping the token "passes Cloudflare".
2. Only **one** challenged site was tested. The UA effect may be specific to that site's rules.
3. The UA test changed `app.userAgentFallback` in a minimal app. It did not test Min's full
   `UASwitcher` code path (custom UA settings, `enableGoogleUASwitcher`, per-session swaps).
4. `client hints` (`navigator.userAgentData.brands` = `Not;A=Brand 8`, `Chromium 150`) were
   recorded (§4f) but **not** varied; a detector that cross-checks UA string vs client hints
   would still see `Chromium 150` with no branded Chrome entry.
5. Headless vs headed is a **proven confound** (§4c); all headline numbers here are headed.
6. No long-run stability, crash-recovery, or memory comparison across runtimes was performed —
   only the single challenge case justified diverging runtimes at all.
7. Chrome/Edge/CloakBrowser were driven through CDP **for measurement only**; nothing was added to
   the product.
8. CloakBrowser binary provenance rests on the wrapper's pinned-key Ed25519 check at download
   time; the on-disk executable has no OS signature.

---

## 10. Final Git state

| Item | Value |
|---|---|
| HEAD | `2b8088e0838524cad5cba92d77a0680897f75429` |
| Staged | **0** |
| Electron processes | **0** |
| Commit / push | **none** |
| Files added by this task | 6 D6 scripts, 9 `docs/d6-*.json` evidence files, this report, one register entry |

Project dependency versions are unchanged (`electron` remains `43.4.1`); the Electron 44 probe
was installed under `%TEMP%` and deleted. The 155 tracked modifications and the formatter churn
are preserved untouched.
