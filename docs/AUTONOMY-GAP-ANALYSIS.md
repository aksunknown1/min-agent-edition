# P1-02 Stage 1 — Autonomy Gap Analysis

Question answered here: **why did the P1-01F Atomic Mail signup run stop so often
for user guidance even though the goal was authorized?** Evidence base: the
actual P1-01F session (docs/REAL-SITE-REPORT.md, docs/atomic-recon.json, this
repo's tool inventory), not assumptions.

## Where the interruptions actually came from

### 1. Instruction-driven confirmation gates (the dominant cause —
### orchestration behavior, NOT browser capability)

During P1-01F the per-step stops happened because the governing rules of that
task required step-by-step confirmation ("show me the fields before
submitting", "ask before Submit"), not because any browser tool was missing.
When the user later granted a single blanket authorization ("authorized to
handle the normal signup steps, including its ordinary Submit actions"; later
"don't stop until the flow is complete"), the run advanced through SIX
consecutive steps (two submits, password fill, seed-phrase proceed,
sign-in) with **zero** browser-tool failures and **zero** clarifying
questions. Verified lesson: **the autonomous loop works; it must be declared
as the default for clearly-authorized tasks instead of being re-negotiated
per step.**

Classification: missing *agent planning/authorization-scope handling* —
corrected by the P1-02 loop contract (Stage 2, in mcp/README.md §"Autonomous
execution loop") and by the user's standing authorization rules
(Stage 3 interruption rules).

### 2. Genuinely user-required information (correct stops — will remain)

These stops were legitimate at the time and remain legitimate; the fix is
only to ask ONCE and consolidated:
- identity details (first/last name, mailbox name) — not inventable;
- password/secret entry — must never transit chat/logs; entered in the
  visible window or via handoff file at the user's explicit choice;
- irreversible/final-submission confirmation when not pre-authorized;
- optional marketing/consent choices — always refused silently-left-unchecked
  on the user's behalf.
- CAPTCHA challenges — human-only by policy; the agent polls `browser_state`
  and resumes automatically after user completion.

### 3. Missing browser capabilities (small, real — addressed in this task)

- **Round-trip cost**: a "navigate → wait → snapshot → act → verify" rhythm
  costs 1 MCP call per step even when every step is deterministic. The
  P1-01D evidence showed snapshot/act latencies of 2–14 ms, so transport
  round-trips, not browser time, dominate small workflows. → fixed by the
  typed `browser_batch` tool (Stage 4) — measured in the workflow evaluation.
- **Observation compaction**: full snapshots were taken even when a fresh
  one was only needed to re-locate one element after a DOM change. The
  compact patterns already exist in the bridge (`locate` is used by every
  action; `content` mode; `selcheck`) — what was missing was *agent
  behavior*: P1-01F already used `locate`-backed actions for steps 4–11, so
  the remaining gap is documentation + the batch tool making the efficient
  path the default.
- **Wait policy**: waits existed (P1-01D) but the P1-01F run used fixed
  `sleep()`s inside the driver scripts — an agent-side artifact, corrected by
  the loop contract ("no unconditional sleeps; use browser_wait / verified
  read-backs").

### 4. Security / human boundaries (preserved, not gaps)

- `sensitive_type` grants stay single-use, per-field, explicit — a batch
  cannot bundle grant issuance (browser_grant is excluded from batch).
- Seed phrase / recovery phrases: agent never reads, copies, or stores; the
  one seed-phrase exposure in P1-01F (a browser_content debug dump) is
  recorded and the loop contract forbids full-content reads on secret-bearing
  steps.
- Zero CAPTCHA automation; handoff + `browser_state` poll/resume.
- No arbitrary JS/shell/filesystem through any batch step.

## What P1-02 delivers against each gap

| gap | delivery |
|---|---|
| per-step authorization churn | Stage 2 loop contract (mcp/README.md) — one consolidated question session for missing info; blanket authorization for ordinary steps within the stated goal |
| round-trip cost | typed `browser_batch` (bridge + MCP), stop-on-error, bounded, per-step compact results, telemetry-measured |
| inefficient observation | loop contract: compact/focused observation by default; full snapshot only for unfamiliar/ambiguous/recovery |
| genuine user info | consolidated single question rule (Stage 3) |
| CAPTCHA/blocked/pause | unchanged handoff contract + automatic `browser_state` re-check + resume |

## Explicitly NOT automation gaps (kept human)

Password/secret entry (user preference), seed-phrase handling, CAPTCHA
solving, marketing consent, and any submission the user has not pre-authorized
within the task scope.
