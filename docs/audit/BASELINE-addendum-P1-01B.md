# P1-01B Addendum — Navigation Reliability and Delayed Redirect Detection

## What changed

`browser_navigate` (main/agentRpc.js) now verifies navigation completion with a
**bounded, reset-on-change URL-stability window** instead of the previous
single 1500 ms two-point URL re-read.

### Parameters (all optional, documented defaults)
- `waitUntil` — `"load"` (default; did-finish-load) | `"domcontentloaded"` (dom-ready).
- `expectUrlPrefix` — non-empty string, max 300 chars, no control chars.
  **Full-URL prefix semantics** (must be a prefix of the absolute final URL).
  Path-only prefixes are deliberately refused by matching: a path-only match
  across hosts would let a redirect to a different origin satisfy the
  expectation (host-confusion risk). waitForPrefix wait is bounded at 5 s;
  the prefix is re-checked against the FINAL url after the stability window.
- `stabilityWindowMs` — integer 0–15000, default 1500. The URL must stay
  unchanged for this long after settle before the result is `verified: true`;
  **every URL change restarts the quiet window** (delayed redirects and SPA
  `history.pushState` route changes are detected, not just instant hops). A
  hard cap (window + 10 s) bounds pathological flip-flopping pages.

**Trade-off (documented):** the default window covers Proton-class bounces
landing ~1–3 s after load at the cost of ≈window latency on every verified
navigate. Raising it detects later bounces at linear latency cost; lowering it
(via stabilityWindowMs) reduces latency for known-static pages.

### Structured results (verification kinds)
- `navigation` + `verified:true` — URL settled and stayed stable (and matched
  `expectUrlPrefix` when supplied). `urlChanges` is 0 for a clean load.
- `redirected` + `verified:false` — prefix supplied and the final URL did not
  match: either never matched within the 5 s prefix window, or the page left
  the prefix after a late bounce inside the stability window (never hidden
  behind the earlier match).
- `unstable` + `verified:false` — URL changed after settle (delayed redirect
  or SPA route change) without a prefix contract, or kept changing past the
  hard cap. `routeChangeKind` distinguishes `same-document` (pushState) from
  `cross-document` (redirect) using `did-navigate-in-page` vs `did-navigate`
  events (falls back to `unclassified` when no event was observed).
- `timeout` + `verified:false` — the load event never arrived inside the
  navigation deadline (AGENT_RPC_SNAPSHOT_TIMEOUT, 8 s).
- `load_failed` + `verified:false` — main-frame did-fail-load with failCode.

All results carry `finalUrl`, `urlChanges`, `routeChangeKind`,
`stabilityWindowMs`, `waitedMs`; no page contents are returned (only URL/title
envelope data; spot-checked by the probe).

### Retry policy
At most one retry, ONLY when `expectUrlPrefix` was supplied and the
classification is `redirected`. The retry is a fresh top-level GET of the
requested URL (idempotent; cannot repeat page actions). `unstable`,
`load_failed`, and `timeout` are never retried.

### Min internal-page handling
Min swaps its own internal pages (e.g. `min://app/pages/error/...`) into a tab
asynchronously after refused navigations; a settle firing during such a swap
mis-anchored the monitor (observed as a false `unstable` on the following
static navigation). Transitions where either endpoint is a `min://` URL are
absorbed as re-anchors and never counted as page-side changes.

### webRequest / ad blocker
The ad blocker (main/filtering.js `onBeforeRequest`) and UASwitcher
(`onBeforeSendHeaders`) were inspected and are untouched; the stability
monitor uses only webContents lifecycle events (`did-navigate`,
`did-navigate-in-page`, `did-finish-load`, `dom-ready`, `did-fail-load`) and
250 ms URL polling.

## Changed files & backups
| File | Backup | Change |
|---|---|---|
| `main/agentRpc.js` | `docs/backups/P1-01B/agentRpc.js` | stability monitor, classification, schemas (waitUntil/expectUrlPrefix/stabilityWindowMs), 4 nav constants |
| `mcp/min-agent-mcp.js` | `docs/backups/P1-01B/min-agent-mcp.js` | navigate inputSchema: waitUntil/expectUrlPrefix/stabilityWindowMs + docs |
| `scripts/agent-nps-probe.js` | `docs/backups/P1-01B/agent-nps-probe.js` | loopback HTTP nav matrix: 13 new assertions |
| `scripts/agent-rpc-test.js` | `docs/backups/P1-01B/agent-rpc-test.js` | 6 new schema checks for stabilityWindowMs (161 total) |

## Evidence (actual runs)

| Test | Result |
|---|---|
| static page | `verified:true, navigation, finalUrl=/static, urlChanges:0` |
| immediate 302 | `verified:true` at `/static` (chain completes pre-settle) |
| delayed redirect (~1.2 s JS bounce) | `verified:false, verification:unstable, finalUrl=/landed, urlChanges>=1` |
| SPA pushState | `verified:false, unstable, routeChangeKind:same-document, finalUrl=/spa-route` |
| hung server | `verified:false, timeout, waitedMs≈8100` |
| expectUrlPrefix match | `verified:true` |
| delayed bounce INTO prefix | `verified:true` at `/landed` (stable for full window) |
| prefix match then bounce away | `verified:false, redirected, finalUrl=/landed` (NOT hidden) |
| impossible prefix | `verified:false, redirected` after bounded wait |
| stabilityWindowMs echo/bounds | `stabilityWindowMs:300` honored; 15001 → 400 invalid_params; 0 and 3000 accepted at schema |
| leak spot-check | no page text in any navigate response body |

Regression: build OK; `test:agent-rpc` **161/161**; `probe:nps` **38/38**;
`probe:tabs` **16/16 ×5 consecutive** (exit 0 each); probe:agent-actions
**33/33**; probe:agent-snapshot **27/27**; probe:capture exit 0; probe:detach
exit 0; smoke:baseline ×3 = 6/6 each; 0 electron processes remain.

## Known limitations
- A bounce that lands on a suffix-compatible URL on a DIFFERENT host within
  the window is reported as `unstable` (no prefix) — correct, but the caller
  sees only URLs to judge it. With expectUrlPrefix (full URL) the
  cross-host case is always classified.
- SPA pages that ornament the hash immediately after load are reported
  `unstable` with `same-document`; callers that accept SPA behavior can pass
  `stabilityWindowMs: 0` and read `finalUrl`.
- The `timeout` verdict reuses AGENT_RPC_SNAPSHOT_TIMEOUT (8 s) and is not
  separately configurable.
- `routeChangeKind` is `unclassified` if Chromium delivers no navigation
  event between two polls (rare).

## Next recommended task
P1-01 Stage C — React-controlled input verification (value-length + native
setter retries), now that navigation to and post-settle classification of
real signup flows is trustworthy. (Restage: waits probe, CAPTCHA handoff,
Atomic Mail step re-run.)
