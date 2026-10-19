# Min Agent Edition — Browser Operating Policy

## Quick Reference (verified against `main/agentRpc.js` and `mcp/min-agent-mcp.js`)

All 31 bridge methods are exposed via MCP. Tool names and parameter schemas below
match the actual `TOOLS` catalogue at the time of writing.

| tool | effect | verify afterward with |
|---|---|---|
| `browser_tabs` | read-only: lists tabs with `tabId`, `url`, `title` | — |
| `browser_status` | read-only: Min bridge status, app/extension versions, counts | — |
| `browser_tab_open` | opens a new tab (optionally with a URL); explicit targeting via `tabId` | `browser_snapshot` on the new tab |
| `browser_tab_select` | selects a tab by `tabId` (real tab model); the target view becomes visible; its page becomes the current context | verify via `browser_content` |
| `browser_tab_close` | closes one tab by `tabId` | — |
| `browser_navigate` | loads URL; returns `finalUrl`, `verified`, `title`; timing/stability fields | `browser_content` or `browser_verify` |
| `browser_snapshot` | accessibility tree with `ref` handles (60 s TTL), `maxNodes` bounded | `browser_screenshot` if sparse or inconsistent |
| `browser_content` | full page text (`document.body.innerText` + open shadow roots) + `title`, `url` | compare with task |
| `browser_screenshot` | real image (MCP image content block); returns `screenshotId`, `viewport {width, height, dpr, scrollX, scrollY}`, `cssPerPixel`, `zoom`, `timestamp`, `data` (base64) | visually inspect the image |
| `browser_click` | clicks at semantic `ref` (from snapshot) or explicit `x,y` with `tabId`; **up/right-click supported** | `browser_content` / URL change |
| `browser_type` | types text into field at `ref` | `browser_verify` `textContains` |
| `browser_press` | single key (`Enter`, `Tab`, `Escape`, etc.) or combo at `ref` | page state changed |
| `browser_hover` | hovers at `ref` or coordinates; does **not** click; may trigger transient UI state | not for durability asserts |
| `browser_scroll` | DOM-level scroll by `dx`/`dy` or `to: 'top'|'bottom'`; **reliable scroll** | re-snapshot; this is the correct way to scroll |
| `browser_verify` | checks `textContains` / `selector` / `url` on the live page; returns `verified: true|false` | — (this IS the verification) |
| `browser_predict` | advisory element classification (`click`, `type`, `navigate`); never dispatches | — |
| `browser_check` | presence-only check (selector match count, visibility); no interaction | `browser_snapshot` for detail |
| `browser_wait` | event-driven wait: `until: 'network_idle'` (default, 1 s quiet) or `until: 'selector_visible'`; `timeoutMs` 1000–20000 (default 8000); optional `selector` for `selector_visible` mode | — |
| `browser_state` | returns focus state, CAPTCHA widget detection, content-type/content-blocking state, `captchaHandoffRequired` | use for CAPTCHA detection |
| `browser_mouse` | typed mouse: `click`, `rightClick`, `down`, `up`, `move`, `hover`, `scroll`, `movePath`, `drag`, `status`; viewport CSS-pixel coords; explicit `tabId` | accepted dispatch ≠ page-side proof — see notes |
| `browser_transform` | reversible page mutation: `replace_text`, `highlight`, `set_style`, `hide`; returns `transformId` | use exact ID to restore via `restore_target` |
| `browser_transform_status` | lists active transform records with drift detection | — |
| `browser_batch` | up to 20 deterministic steps, 60 s budget, stop-on-error; one `tool` + `args` per step; **excludes `browser_grant`** | — |
| `browser_select` | selects an option in a `<select>` by `ref` + `opt` | verify via `browser_content` |
| `browser_downloads` | lists managed download jobs + observation records: `downloadId`, `state`, `bytes`, `relPath`, `delivery` | `browser_download_wait` for terminal |
| `browser_download_start` | starts agent-managed download; two modes: direct (`url` + optional `relPath` under `userData/agent-downloads/` root) or adopt (`armMs`: the next page-triggered download in that tab is adopted) | `browser_download_wait` |
| `browser_download_wait` | waits for terminal state; `timeoutMs` 100–120000 (default 30000); timeout returns `{terminal:false, timedOut:true}` — re-check status | confirm per the real schema |
| `browser_download_cancel` | cancels one managed job; confirmed via DownloadItem `done` event | other jobs unaffected |
| `browser_download_pause` | pauses; returns `paused:false` + reason if not in a pausable state | honest refusal |
| `browser_download_resume` | resumes; requires `canResume()`; returns `resumed:false` + reason if transfer doesn't support it | honest refusal |
| `browser_grant` | HIGH-RISK: explicit user opt-in only, one grant = one action; `risky_click` or `sensitive_type`; TTL 30–300 s | requires explicit user instruction |

**All 31 bridge methods are exposed via MCP.** No bridge-only methods exist for external-tool purposes.

---

## The core loop

For every unfamiliar page or uncertain state:

```
1. OBSERVE    browser_content (full text) + browser_snapshot (interactivity tree)
              or browser_screenshot (real image)
2. DECIDE     identify the target or the next action from the evidence
3. ACT        one action or a small deterministic batch
4. WAIT       browser_wait (event-driven, bounded timeout)
5. VERIFY     browser_verify or browser_content or URL change —
              an accepted dispatch is NOT page-side proof
6. RE-PLAN    if reality differs from expectation, discard the assumption
              and observe again — do not repeat or guess
```

---

## Sparse DOM → visual fallback (the hdhub4u pattern)

The accessibility tree (browser_snapshot) is **not** the entire page. Treat it as
incomplete if any of these are observed:

- few nodes or only headings/generic links on a page you expected to have listings or controls
- empty or short `browser_content` text after a confirmed navigation
- the target control is missing despite the page appearing to be a gate, landing page, or app
- previous action changed the URL but the snapshot/content do not reflect the concept
- snapshot, content, and navigation result disagree

**What to do:** take `browser_screenshot` and **actually inspect the real image content**.
This is not a last resort — it is a mandatory second observation when the DOM is insufficient.

### Verified example: hdhub4u.kg "View Full Site" gate

1. Navigate to a user-provided URL using `browser_navigate` — `verified: true`.
2. `browser_snapshot` returns 18 nodes: headings + 1 self-referencing link.
3. `browser_content` returns the site's info text — no search box, no listings.
4. **Do NOT** conclude "no search/listings." Take `browser_screenshot`.
5. The screenshot shows a "View Full Site" button (not in the accessibility tree).
6. Identify the gate button's position **in the current screenshot**: read its pixel position,
   convert to CSS pixels with the response's `cssPerPixel` / `viewport` metadata
   (`cssX = px / cssPerPixel` etc.), and click at those freshly computed coordinates with
   `browser_mouse {action:'click', x: <cssX>, y: <cssY>}` — never reuse coordinates from a
   previous screenshot or another site.
7. `browser_wait {until: 'network_idle'}` → snapshot now returns the full movie listing/search tree.

This pattern generalizes to any SPA, visual gate, consent wall, or domain-wall page.

---

## Semantic interaction (default)

If a `browser_snapshot` clearly shows the target with a semantic `ref`, use the ref-based tools.

```
browser_snapshot → find <input id="search-q"> as ref=r5
browser_type     → { tabId, ref: "r5", text: "my query" }
browser_press    → { tabId, ref: "r5", key: "Enter" }
browser_wait     → { tabId, until: "network_idle", timeoutMs: 5000 }
browser_verify   → { tabId, textContains: "search results for my query" }
```

No screenshot needed when DOM evidence is sufficient.

---

## Screenshots when DOM is insufficient

`browser_screenshot` returns a real image content block through MCP. Use it when:
- The page is visually rich, canvas-based, or uses CSS-styled non-semantic elements
- The snapshot is sparse or inconsistent with the page concept
- A boundary/gate/page state is present but not represented in the accessibility tree
- The target was found visually in a previous step but the page state may have changed

The result includes `screenshotId`, `viewport` (CSS-pixel w×h + dpr), `cssPerPixel`
conversion for `browser_mouse` coordinates, `zoom`, and a `timestamp`.

**When to re-screenshot:** after navigation, scrolling, zoom, tab switch, or document state
change if the coordinates from a previous screenshot will be reused.

---

## Coordinate mouse: the honest contract

| action | delivers to page? | note |
|---|---|---|
| `click`, `rightClick`, `down`, `up` | **yes** (verified with page-side click counters) | — |
| `move`, `hover`, `movePath` | delivered but **transient** — physical cursor re-assertion can override final position on Windows | not for durability asserts |
| `scroll` (wheel) | **dutifully not verified** on this Electron/OS build — compositor drops; treat as not delivered | use `browser_scroll` (DOM) for reliable scrolling |
| `drag` | down/up deliver; intermediate move events may be overridden | verify drop-state via page content |
| `status` | observational only; dispatch guaranteed not to fire | — |

**Rule:** use `browser_scroll` for scrolling and `browser_click` for clicking. Use `browser_mouse`
`move/movePath/hover` only for hover-dependent UI where no semantic alternative exists, and always
verify the resulting page state independently via `browser_content` or `browser_verify`.

---

## Independent verification

Every accepted dispatch is not proof that the intended page change occurred.

### Navigation
Check the tool's `finalUrl` AND `browser_content`'s text for the expected content.

### Click / type
Check `browser_verify` (`textContains`) or `browser_content` for the expected result.

### Transforms
Store the exact `transformId`; use `restore_target` with that ID; verify both the applied change
and the restored state via `browser_content`.

### Downloads
`browser_download_wait` until terminal state. The result carries `downloadId`, `filename`,
`relPath`, `state` (`completed`, `cancelled`, `interrupted`), `received`, `total`, `startedAt`.
If `timedOut:true` and `terminal:false`, re-check status with `browser_downloads` rather than
declaring the download complete. Download files live under `userData/agent-downloads/`
(the approved download root), not `the filter cache/`.

### Scroll / mouse
`browser_scroll` has a DOM-level effect (scrollY changes). `browser_mouse scroll` may not
deliver on this build. Never assume a dispatched wheel event scrolled.

---

## CAPTCHA

```
browser_state → returns captchaBoxes, captchaDetected, captchaHandoffRequired
```
If CAPTCHA detected, **pause and tell the user the tab is waiting for manual completion.**
After the user finishes, verify clearance (`browser_verify` or `browser_content` for a
post-CAPTCHA marker) before continuing. Never auto-solve or bypass.

---

## Recovery

- After timeout: retrieve current URL + fresh `browser_content` before retrying.
- Retry only if there is evidence the first action didn't take effect and the retry is safe.
- Avoid duplicate submissions (check for the result before re-clicking submit).
- On repeated failure, change strategy **once** based on new evidence, then report the blocker.
- Every loop must have a bounded iteration cap or timeout.

---

## Batching rules

- Batch only a known, deterministic sequence with no decision points.
- **Do not batch through redirects, visual gates, unknown states, or un-observed pages.**
- `browser_batch` caps at **20 steps / 60 seconds**, stop-on-error, **excludes `browser_grant`**.
- Observe (snapshot/content/screenshot) before the first batch step.
- Verify (content/verify) after the last batch step.

---

## Scenarios

### Scenario 1: Sparse DOM on an unfamiliar page (the hdhub4u.kg pattern)

```
1. browser_navigate  → target URL, verified: true
2. browser_snapshot  → 18 nodes: headings + 1 self-link. No search/listings.
3. browser_content   → text is the site's "about" landing page
4. DO NOT conclude "no search." Take browser_screenshot.
5. Screenshot shows a "View Full Site" gate → browser_mouse click at its visual position
6. After navigation settles, browser_snapshot returns the real movie/search content
7. Continue the task with the newly accessible content
```

### Scenario 2: Semantic form (identified from snapshot)

```
browser_snapshot  → <input id="q"> (ref=r5), <button id="s"> (ref=r6)
browser_type      → { tabId, ref: "r5", text: "my query" }
browser_press     → { tabId, ref: "r5", key: "Enter" }
browser_wait      → { tabId, until: "network_idle", timeoutMs: 5000 }
browser_verify    → { tabId, textContains: "search results for my query" }
```

### Scenario 3: Visually rendered canvas or CSS-styled control

```
browser_screenshot → real image shows the target at (x, y)
browser_mouse      → { action: 'click', x, y }
browser_screenshot → verify the effect
```

### Scenario 4: Empty content after navigation

```
browser_navigate → verified: true
browser_content  → text: ""
→ wait 2 s, re-read once
→ if still empty: browser_screenshot, re-plan
→ never guess a URL pattern
```

### Scenario 5: CAPTCHA pause and resume

```
browser_state   → captchaDetected: true
                → PAUSE: tell the user the tab is waiting for manual CAPTCHA completion
→ (user completes CAPTCHA)
browser_verify  → post-CAPTCHA marker confirmed
→ resume the authorized task
```

### Scenario 6: Batch vs re-plan

**Batch (deterministic):** form already observed with 3 fields and submit button confirmed.
```
browser_batch → [
  browser_type (field 1), browser_type (field 2), browser_click (submit)
]
Then: browser_verify (result)
```

**Not batch (unknown redirect):** after step 1 the page redirected to an unseen gate.
Stop; observe (screenshot + content); re-plan.

---

## What NOT to do

- **Don't** treat `browser_snapshot` as the complete page inventory on an unfamiliar domain.
- **Don't** guess URL patterns (`/search`, `/category/...`) unless evidenced by the page's own links.
- **Don't** repeat the same blind mouse click after it fails — observe, screenshot, re-plan.
- **Don't** batch through unknown redirect states, visual gates, or unseen pages.
- **Don't** use `browser_mouse scroll` instead of `browser_scroll` for scrolling.
- **Don't** assume a click succeeded because the tool returned `dispatched: true`.
- **Don't** auto-solve CAPTCHAs or fabricate credentials.
- **Don't** screenshot after every trivial click when the DOM is reliable.
- **Don't** declare a download complete when `browser_download_wait` returned `timedOut:true`.
- **Don't** describe a managed download as living under `filterCache/` — it lives under
  `userData/agent-downloads/`.

---

## P1-10 gaps (documented, not implemented in this phase)

- `browser_page_overview` / `browser_inspect` — not needed: `browser_content` (text) +
  `browser_screenshot` (real image) + `browser_snapshot` (interactivity) already cover the loop.
- Durable synthetic hover — **PLATFORM_LIMITED** (physical cursor re-assertion).
- Wheel page delivery — **PLATFORM_LIMITED** (`browser_scroll` is the reliable path).
- OS-global cursor — NOT_IMPLEMENTED (upstream scope).
- Real-network EasyList fetch — environment-limited (P1-07).
