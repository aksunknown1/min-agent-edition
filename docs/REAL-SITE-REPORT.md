# P1-01F — Atomic Mail Real-World Signup (REAL-SITE-REPORT)

Final run completed: 2026-10-17 (single live session, dedicated temp automation
profile `min-atomic-live`). Target at start:
`https://atomicmail.io/app/auth/sign-up/` (URL verified after every navigation).

## RESULT: ✅ ACCOUNT CREATED AND VERIFIED WORKING

The strongest available evidence: after signup the flow landed in the live
mailbox — URL `https://atomicmail.io/app/mailbox/<userId>`
(title `(4) Inbox | Atomic Mail`) rendering the real inbox UI (folders
Inbox(4)/Drafts/Junk/Sent/Trash, Compose, welcome mail from Atomic Mail Team).

## Executed steps (tool → verified outcome)

| #   | action                          | tool                                                        | outcome                                                                                                                                                                     |
| --- | ------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | navigate to signup              | browser_navigate (stability 3000, dcl)                      | verified:true, urlChanges 0, ≈4.9 s                                                                                                                                         |
| 2   | state check                     | browser_state                                               | page complete; **hcaptcha iframes preloaded (never became a visible challenge)**                                                                                            |
| 3   | snapshot → controls             | browser_snapshot                                            | 9 nodes: 2 textboxes, Submit, nav links                                                                                                                                     |
| 4   | user-delegated details filled   | browser_type                                                | First name `Alex` verified:value; last name skipped (user choice)                                                                                                           |
| 5   | Submit (step 1)                 | browser_click                                               | dom-change verified → step 2 "Create an Atomic Mail address"                                                                                                                |
| 6   | mailbox claim `min.agent.demo`  | browser_type                                                | verified:value (14 chars) → advanced                                                                                                                                        |
| 7   | Submit (step 2)                 | browser_click                                               | dom-change verified → step 3 "Create a strong password"                                                                                                                     |
| 8   | **password + confirm**          | browser_grant(sensitive_type, single-use ×2) + browser_type | both `verified:true, verification:value-length`, 22-char generated password; value never in logs/chat; handed to user via `C:\Users\AKS-PC\atomic-mail-account-details.txt` |
| 9   | Submit (final account creation) | browser_click                                               | verified → "Save your Seed Phrase" step                                                                                                                                     |
| 10  | "Download & Proceed"            | browser_click                                               | seed file downloaded (browser_downloads: `Atomic Mail Seed Phrase for min.agent.demo@atomicmailio.txt`, completed) → "Welcome to Atomic Mail!"                              |
| 11  | "Sign in now!"                  | browser_click                                               | verified:navigation → **live mailbox** (evidence above)                                                                                                                     |

## Manual intervention / user decisions

- User delegated: names/username values ("your own choice"), and the password
  (typed by the bridge under single-use `sensitive_type` grants; content never
  printed into any chat/log; delivered via one local handoff file which the
  user should copy into a password manager and delete).
- No CAPTCHA was manually solved: the preloaded hCaptcha iframes never became
  a visible challenge during signup (distinguished explicitly per task rules).

## Secrets handling

- Password: generated locally; exists in the browser session, and once in the
  handoff file `C:\Users\AKS-PC\atomic-mail-account-details.txt` — copy to a
  password manager, then delete. NOT stored in the repo, chat, or evidence.
- Seed phrase: **the site's own step was used** (site-generated, downloaded by
  the user's own browser action). CAUTION: a `browser_content` text read
  during debugging rendered the phrase into this session's tool transcript —
  treat the phrase as exposed to that local transcript (it never left this
  machine), consider rotating via the account if concerned. There are two
  seed files in `C:\Users\AKS-PC\Downloads` — secure one, delete the extra.
- No credentials in probes, JSON evidence, or source files.

## Blockers

None external. The preloaded-hCaptcha never materialized as a visible
challenge; no CAPTCHA handoff was required.

## Account state left in browser

The Min window is left OPEN and signed in at the new mailbox
(min.agent.demo@atomicmail.io). Recovery email is recommended by the site
(banner) — intentionally not configured without the user's decision.
