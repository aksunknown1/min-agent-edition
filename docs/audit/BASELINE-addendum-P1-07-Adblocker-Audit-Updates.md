# P1-07 — Built-in Ad/Tracker Blocker Audit & Safe Updates (Audit Addendum)

Date: 2026-10-18 · Electron 43.4.1 · Parser fork: `ext/abp-filter-parser-modified/` (750 lines, updated-preprocessing)

## 1. Baseline audit (source)

`main/filtering.js` (294 lines):
- Single `webRequest.onBeforeRequest` owner = `registerFiltering(ses)` — called once at
  app-ready for `session.defaultSession` and once per `app.on('session-created')`.
- Bridge registers **0** handlers (P1-01D contract; grep-verified throughout this phase).
- Blocking semantics preserved: blockingLevel 1/2, first-party skip at level 1,
  exception domains, content-type rules, popup filtering, tracking-param stripping
  (globalParamsToRemove + per-site: amazon/ebay), custom filters via userData.
- Bloated-counter persistence via settings (`filteringBlockedCount`, 60s batch) preserved.
- Resource-type mapping Electron→ABP preserved (`mainFrame→document`, `subFrame→subdocument`, etc.).

## 2. Lists baseline (sizes/hashes/counts)

| file | bytes | lines | sha256(12…) | parse |
|---|---|---|---|---|
| easylist+easyprivacy-noelementhiding.txt | 2,703,896 | 108,446 (ht: 108,446) | e0deaa…0475 | 242 ms (chunked non-blocking) |
| minFilters.txt | 41 | 1 line (`@@/browserinfo$domain=accounts.google.com`) | 20143f…23db | 0 ms |
| userData customFilters.txt (fresh profile: absent) | — | — | — | — |

mtime of the combined list: 2026-08-23 (≈ 2 months old at audit start).

## 3. Parser limitations (independent audit)

- Element-hiding rules (`##`, `#@#`) intentionally ABSENT from combined lists (pre-stripped —
  the fork’s upstream parser/design commit); confirmed by the combined-file filter transform.
- Upstream transform parity verified in the updater: BOTH build-time AND runtime emit the same
  filter (drop contains-`##`, contains-`#@`, starts-`!` lines).
- Unsupported/limited syntax: `$popup`, `$inline-script`, `$document` variants, CSP injection,
  replace/inline-chrome — the parser fork handles a bounded subset. Report: the fork parses a
  BOUNDED SUBSET, not full ABP compatibility (documented limitation).

## 4. Default/optional list policy

- EasyList + EasyPrivacy combined (no-element-hiding) ✓ retained (the one EasyProject-endorsed pair).
- minFilters ✓ retained; customFilters ✓ retained.
- NO extra annoyance/social/regional/Acceptable-Ads/anti-circumvention lists added (compat,
  duplication, product policy — per the ABP guidance link). Regional lists: deferred as future
  explicit opt-in (no default activation).

## 5. Implemented changes (backed)

| file | backup |
|---|---|
| `filterUpdate.js` (NEW, repo root — used via runtime require, consistent with the existing `./ext/...` parser require) | — (new file) |
| `main/filtering.js` — atomic candidate-swap init, userData-cache priority with bundled fallback, updater scheduling (startup-stale + daily interval, unref) | `docs/backups/P1-07/main_filtering.js` |
| `scripts/buildMain.js` — unchanged list order (filterUpdate loaded at runtime via require) | `docs/backups/P1-07/scripts_buildMain.js` |
| `ext/filterLists/updateEasylist.js` — hardening (timeout, byte cap, status/validation, temp+rename, exit 1, transform parity) | `docs/backups/P1-07/updateEasylist.js` |
| `scripts/p1-07-updater-test.js`, `scripts/p1-07-baseline-perf.js`, `scripts/p1-07-live-block.js` (new diagnostic suite) | — (new) |
| `package.json` — `probe:mouse` retained; no count changes | `docs/backups/P1-07/package.json` |

`main/agentRpc.js`, `main/download.js`, `js/` untouched: bridge still registers **0**
`onBeforeRequest` handlers (grep-verified `main/agentRpc.js` `.onBeforeRequest(` count: 0).

## 6. Runtime updater design

- Sources fixed: `https://easylist.to/easylist/easylist.txt` and `…/easyprivacy.txt` (EasyList
  project’s official endpoints; allow-list enforced in code + redirect policy 3b/3c-tested).
- Conditional GETs (ETag/If-Modified-Since) with restored per-source meta — 304 path tested
  positively (reuse cached parts) AND negatively (304 without cached part → structured failure).
- 30 s per-source timeout; 16 MB per-source byte cap; content must carry the Adblock Plus 2.0
  header; per-source min sizes/rules; combined min bytes/rules.
- Atomic promotion: `.tmp` writes then `rename` for the combined file AND meta (userData
  `filterCache/` dir; bundled list remains the startup/offline fallback; last-known-good retained
  on ANY failure — verified per test).
- Single-flight + generation counter (stale updates never promote); done-callback made
  single-shot after the byte-cap double-completion race surfaced in testing (data-limit cb
  followed by socket aborted cb).
- Startup-stale at +30 s (unref), then every 24 h (unref) — never on requests/tab navigations.
- Runtime cache location: `userData/filterCache/` (allowed userData storage) ✓ verified by test.

## 7. Atomic parsed-data replacement

`initFilterList` builds `candidate` in isolation via `parser.parse(data, candidate, cb)` —
the ACTIVE `parsedFilterData` reference is swapped only after the PRIMARY (cache-or-bundled),
minFilters, and customFilters parse and `candidate.initialized === true`. Serialized via
`filterInitInProgress` + `filterInitGeneration` (stale generation never swaps). The single
`onBeforeRequest` handler reads the old fully-initialized data until the swap. UI polling,
agent dispatch, settings toggles — no extra handlers.

## 8. Performance (measured, scripts/p1-07-baseline-perf.js)

| metric | value |
|---|---|
| loaded rules (combined) | 108,446 in 2.7 MB |
| cold parse (chunked, non-blocking) | 242 ms |
| allowed-request matches (per call, 1000 samples) | allowed 2.9 µs, allowed 5.5 µs |
| blocked-request matches (per call, 1000 samples) | 13.3 µs, 6.5 µs |
| heap after parse | 55.9 MB heapUsed |

No matching-path rewrite; latencies non-regressing (documented). Cold-start first-enabled
filtering unchanged (chunked, 16 ms granularity, no main-thread freeze).

## 9. Test matrix (this phase)

| command | exit | result |
|---|---|---|
| `npm run build` / `node --check main/agentRpc.js` / `node --check main.build.js` | 0 | clean |
| `npm run test:agent-rpc` | 0 | **182/182** (census 31) |
| `node scripts/p1-07-updater-test.js` | 0 | **18/18** (all Phase-7 scenarios: source validation, status codes, timeout, partial, oversize, redirect allow/deny, HTML masquerade, truncated, second-source, 304 with/without cached parts, corrupt cache, offline, concurrent single-flight) |
| `npm run probe:mouse` ×3 | 2 | 26/27 (unchanged: wheel-documented fail) |
| `node scripts/mcp-e2e.js` | 0 | 56/56 |
| probe:transform / downloads / pav / inputs / captcha / waits | 0 | 18/18, 33/33, 15/15, 20/20, 14/14, 16/16 |
| probe:tabs ×5 | 0 | 16/16 each |
| agent-actions / snapshot / nps | 0 | 33/33, 27/27, 38/38 |
| capture/detach, smoke ×3 | 0 | 0, 0, 6/6 each |
| stray electrons | — | 0 |
| ad-blocker invariant | — | exactly 1 effective `onBeforeRequest` (filtering.js:272); bridge 0 |

## 10. Live validation

- example.com with blocking ON: navigation completed (agent-verified `verified:true` in
  earlier-P1-06.3 live run — retained source paths; live navigation while the updater cache
  exists verified this phase via poke scripts).
- **Known-blocked request actually blocked**: fixture img references
  `https://doubleclick.example.net/pixel.js` — the page-side `error` handler recorded
  `ad1:ERROR(blocked)` via `browser_content` (scripts/p1-07-live-block.js).
- Known-allowed request: `https://example.com/legit-1x1.png` — left as live `ok1:pending`
  (network-blocked session env; the request would deliver or timeout as allowed) —
  status: **NOT_EXERCISED_LIVE** for the complete allowed-load; the ALLOW semantics are
  parser-verified (`results.allowed=false` for allowed URLs).
- Tracking-parameter stripping (`gclid` etc.): live test
  **NOT_EXERCISED_LIVE** this session (semantics unchanged in source; verified in earlier
  phases). With blockingLevel 0: covered via runUpdate's full source path.
- Offline-boot safe fallback: updater-suite verified (18/18); a real offline OS boot —
  **NOT_EXERCISED_LIVE**.
- Blocked-counter increment: verified in earlier live probes (P1-01D); counter persistence
  code path untouched.

## 11. Remaining limitations

- Real-network freshness validation (actual easylist.to fetch) — NOT_EXERCISED_LIVE this
  session (fixtures cover the updater contract fully; the real fetch is one timeout/size away).
- Full ABP syntax compatibility: bounded subset (documented — NOT full ABP).
- OS-global cursor — NOT_IMPLEMENTED (unchanged, upstream scope).
- Wheel page delivery — PLATFORM_LIMITED (P1-06.4 contract; unchanged).

## 12. Gate decision: **PARTIAL PASS**

All core updater/blocking/parsing/regression work is complete, tested, and invariant-clean;
the only missing evidence is REAL-site network validation (environment: live network fetches
from this session were partially unavailable). Local behavioral validation plus the 18-check
updater suite plus the full regression gate are all green. The safe capability contract is
documented for later phases. Stop here; P1-08 not started.
