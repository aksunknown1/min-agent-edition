# Independent VPS QA Architecture — Min Agent Edition (Proposal)

Status: DESIGN ONLY — not implemented in this task. Documented per the P1-14 hygiene
task so implementation can follow in a dedicated phase. Windows-native evidence from
P1-14's OpenCode session is acknowledged; it did NOT establish Linux or packaged-Linux
behavior and this proposal does not claim it.

## Goal

Black-box acceptance QA of the **packaged application** and its real **shipped MCP
adapter** (`resources/app/mcp/min-agent-mcp.js`), independent of the development probes
(`scripts/agent-*.js`), which remain the product-level regression authority.

## Components

```
qa/
  live/                        # future home for live-network probes (recommendation, §3)
  acceptance/
    qa-launcher.js             # spawns ONLY its own packaged app instance:
                               #   dist/app/win-unpacked/Min Agent Edition.exe
                               #   --user-data-dir=%TEMP%/qa-<ts> --agent-rpc
                               # tracked PID; targeted /PID cleanup in try/finally;
                               # duplicate-profile guard (temp dir per run id)
    qa-mcp-client.js           # stdio JSON-RPC client for the SHIPPED adapter
                               # (initialize → tools/list → tools/call), 31-tool census
    qa-acceptance.js           # the acceptance scenarios below, ≥N runs each
    qa-report.md / qa-out/*.png|json   # artifacts (gitignored; local only)
```

Prerequisites: built package (`npm run buildWindows`), Node 24.x, no other packaged
instance using the same temp profile (per-run profile dirs make collisions impossible).
Network needed for the example.com/MDN scenarios (marked and skipped otherwise).

## Acceptance scenarios (each with pre-declared assertions)

1. **Cold start** — no missing-module/preload errors on stderr; 39 tools; production
   flags (`development:false`); dedicated userData root.
2. **Navigation + content + snapshot** — `browser_navigate` verified on
   `https://example.com/`, content marker, snapshot refs (≥1), url/title consistency.
3. **Screenshot delivery** — real MCP image block received and saved; assert PNG magic
   bytes + minimum size + metadata (`screenshotId`, `cssPerPixel`).
4. **Semantic workflow** — snapshot-ref interaction on a local fixture form; verify by
   page evidence (no screenshots needed).
5. **Visual fallback workflow** — local visual-gate fixture (aria-hidden control):
   sparse snapshot → screenshot → coordinate from current image metadata → one grounded
   click → page marker verified. Two fixture variants so coordinates cannot be memorized.
6. **CAPTCHA policy** — detection reported (`captcha.detected/kind`); unrelated controls
   clickable during detection; explicit challenge-control click goes through the normal
   path; detection alone ≠ clearance; clearance only after real page-state evidence;
   human-handoff path available (fixture-simulated user step).
7. **Transforms** — apply → verify → restore by ref/transformId → verify original.
8. **Downloads** — managed start/wait terminal under `userData/agent-downloads/`;
   `browser_downloads` listing; hostile-relPath policy rejections.
9. **Recovery** — unexpected redirect (real 302 fixture) → re-observe → re-plan; empty
   content → bounded readiness wait → screenshot fallback.
10. **Stop & leak detection** — targeted /PID termination of the spawned instance;
    process snapshot before/after must show zero leaked `Min Agent Edition`/electron
    children from this run; temp profile removed.

## Relationship to existing suites

- `scripts/agent-*.js` probes + `npm run test:agent-rpc` + MCP e2e = **product
  regression** (they keep running on every change).
- `qa/acceptance` = **platform-specific acceptance** on packaged artifacts, intended to
  run per release (manually first; optionally a workflow_dispatch CI job on
  windows-latest with the packaging step).
- Development probes are NEVER the sole pass/fail authority for release acceptance;
  their captions stay in the product regression suite.

## Guarantees & limits

- Only processes spawned by the harness are terminated (tracked PIDs; no `/IM` kills).
- No CAPTCHA solving/bypass; human handoff semantics remain (§ scenario 6).
- Linux/macOS acceptance requires their packaged artifacts and a compatible host —
  NOT covered by current evidence; add hosts before claiming cross-platform QA.
- Timeouts per scenario (default 60 s per call, 120 s per scenario); all artifacts local;
  secrets never recorded (tokens are per-run discovery values, only lengths logged).
