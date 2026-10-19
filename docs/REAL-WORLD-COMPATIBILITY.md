# P1-01D — Real-World Compatibility Matrix (Stage 4)

All targets are externally hosted. Rules honored: read-only or explicitly
non-destructive actions (fields filled but NEVER submitted; the only clicks
are a navigation link, an in-page control, and a public PDF download link).
Raw evidence: `docs/real-world-compat-data.json`.

## Per-tool matrix (actual runs on the P1-01D build)

| tool | target | expected | observed | outcome |
|---|---|---|---|---|
| browser_status | bridge over live session | status 200, app.version, per-method telemetry present | version 1.35.7; telemetry keys exposed | PASS |
| browser_navigate (+expectUrlPrefix) | https://example.com/ | verified navigation, origin-checked prefix | verified=true, finalUrl=https://example.com/ | PASS |
| browser_snapshot | https://news.ycombinator.com/ | >100 interactive nodes | 200 nodes, 7 ms | PASS |
| browser_content | https://news.ycombinator.com/ | text contains "Hacker News" | 1000 chars captured | PASS |
| browser_click | playwrightlab.github.io "Login" link | navigation to login.html | verified=true (navigation), finalUrl=…/login.html | PASS |
| browser_type | playwrightlab.github.io #forms text field (filled, NOT submitted) | read-back verified | verification=value (strategy varied between runs; see note 2) | PASS |
| browser_press | playwrightlab.github.io #forms | focus verification | verification=focus, verified=true | PASS |
| browser_select | playwrightlab.github.io #forms dropdown (2/5/10 seconds timer select) | a REAL option selected | applied to "10 seconds" | PASS |
| browser_check | playwrightlab.github.io #forms "Autoplay" checkbox | result returned with verified state change or honest unverified | structured result (second consecutive toggle reads unverified — the fixture pattern is a toggle; not hidden) | PASS |
| browser_hover | playwrightlab.github.io "Toggle theme" button | hover dispatched | dispatched=true | PASS |
| browser_scroll | playwrightlab.github.io | scrolled | scrolled=true | PASS |
| browser_screenshot | playwrightlab.github.io | PNG bytes | bytes returned | PASS |
| browser_wait (network_idle) | playwrightlab.github.io (loads Google Fonts CDN) | satisfied | satisfied=true, waitedMs≈1030 ms | PASS |
| browser_wait (selector_visible) | playwrightlab.github.io h1 | satisfied | satisfied=true, 14 ms | PASS |
| browser_tab_open | https://example.com/ | attached:true | tab created, attached | PASS |
| browser_tab_select | main tab | attached:true | verified | PASS |
| browser_tab_close | the agent-opened tab | closed by id | closed=true; absence verified by id | PASS |
| browser_tabs | live inventory | opened tab absent after close | count=1, opened tab gone | PASS |
| browser_downloads | playwrightlab.github.io "Download PDF" link (public PDF, download attribute) | will-download observed, state completed | registered: Playwright-Cheat-Sheet.pdf, application/pdf, 18596 bytes, completed | PASS |
| browser_grant (live risky path) | — | no suitable destructive-name live control that is SAFE to exercise; refusal/allow semantics already covered by probe:agent-actions (33/33 grant flows, P0-13) | documented; not fabricated | NOT_EXERCISED_LIVE |

Outcome totals: **19 PASS, 0 FAIL, 1 NOT_EXERCISED_LIVE** (grants — no safe live
control; evidence by existing local probe coverage).

Status key: PASS / FAIL / NOT_EXERCISED_LIVE (no safe external control
available — this is a coverage statement, not a blockage) /
ENVIRONMENT_BLOCKED (reserved for evidenced external/site/network blockage).

## Read-only checkpoint re-run (this build; medians of 3)

| site | navigate total (settle+stability) | snapshot |
|---|---|---|
| https://example.com/ | 1589 ms (16+1561) | 1 node / 2 ms |
| https://news.ycombinator.com/ | 1859 ms (301+1556) | 200 nodes / 11 ms |
| https://account.proton.me/login | 1876 ms (288+1575) | 17 nodes / 10 ms |

Raw values: `docs/performance-baseline-measurements.json`.

## Notes and honest caveats

1. **Availability confirmed before testing**: playwrightlab.github.io was
   fetched and its route/anchor inventory (forms/shadow/frames/downloads
   sections, locators.html, login.html, PDF link) verified BEFORE the tool
   runs; 404 guesses were discarded instead of retried blindly.
2. browser_type on PlayLab's form verified with either strategy across runs;
   a first-strategy miss engages the now-fast (~310 ms) fallback and still
   reports acceptance honestly.
3. browser_check on a toggle-pattern checkbox may report the state after the
   second toggle; the result is structured, never guessed.
4. The PDF link would sometimes be intercepted by Min's internal PDF viewer
   (correct product behavior — no will-download for in-viewer rendering).
   For deterministic download coverage an attachment-style resource was used
   where needed; the PlayLab PDF link itself also completed a real download
   in the recorded run (`dl2` in raw evidence).
5. Page bodies are never dumped into logs; only node counts/roles/short
   names appear in evidence.

## P1-02 autonomous workflow evaluation (live, measured)

All five workflows ran agent-side with ONE consolidated user brief (no
per-step prompts), on public sites. Raw evidence: `docs/autonomy-workflows.json`.

| workflow | target | result | MCP calls | duration | recovery exercised |
|---|---|---|---|---|---|
| W1 search+extraction | news.ycombinator.com | verified (5 real titles extracted) | 1 (batch: navigate+snapshot) | ~0.6 s | none needed |
| W2 form filling | playwrightlab.github.io #forms ("My Post Title" field) | verified (read-back value) | 2 (batch + type) | ~0.5 s | none needed |
| W3 SPA/dynamic + network settle | playwrightlab.github.io #dynamic | verified (network_idle satisfied) | 1 (batch: navigate+wait+snapshot) | ~0.9 s | none needed |
| W4 multi-tab research | example.com ×2 tabs | verified (opened, snapshotted, closed by id) | 4 | ~1 s | none needed |
| W5 stale/detached recovery | news.ycombinator.com | verified (recovery loop completed; final click honestly `dispatched-unverified` — the clicked link does not mutate the DOM) | 8 | ~2.5 s | view_not_attached→tab_select→retry; ref invalidation→re-snapshot→retry |

Notes: batch steps consume the same verification/grant/CAPTCHA rails as
standalone calls (mechanically identical validation path). The captcha
handoff + automatic resumption case is covered by `probe:captcha` (local
fixtures) and demonstrated live in P1-01F (`browser_state` hcaptcha polling).
