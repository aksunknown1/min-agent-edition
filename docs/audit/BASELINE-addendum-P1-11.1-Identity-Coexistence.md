# P1-11.1 — Product Identity & Side-by-Side Install Safety (Audit Addendum)

Date: 2026-10-19 · **Gate: PASS** (installation identity made distinct; coexistence proven at every layer testable on this host; one identity defect found and repaired)

## 1. Identity values — before vs after (source: `package.json`, `scripts/buildWindows.js`, embedded Squirrel nuspec)

| identity layer                     | BEFORE (collision)                                                    | AFTER (repair)                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| package `name` (Squirrel/NuGet id) | `min` (identical to official Min)                                     | `min-agent-edition` → nuspec `<id>min_agent_edition</id>` (verified in produced installer)                                                                          |
| `productName` (title/exe/profile)  | `Min`                                                                 | `Min Agent Edition` → nuspec `<title>`, exe `Min Agent Edition.exe` (in package lib/net45 + ExecutionStub), Start-Menu title                                        |
| default Electron userData          | `%APPDATA%/%productName%` = `%APPDATA%/Min` (official Min's profile!) | `%APPDATA%/Min Agent Edition` (distinct; proven by launch test)                                                                                                     |
| Squirrel install dir               | `%LOCALAPPDATA%/min` (official Min's)                                 | `%LOCALAPPDATA%/min_agent_edition` (Squirrel derives from id)                                                                                                       |
| artifacts                          | `Min-v1.35.7-windows.zip`, `min-1.35.7-setup.exe`                     | `Min-Agent-Edition-v1.35.7-windows.zip`, `Min-Agent-Edition-1.35.7-setup.exe` (per arch)                                                                            |
| description/metadata               | upstream description                                                  | fork-specific description ("separate developer fork … distinct from the official Min browser")                                                                      |
| registry uninstall identity        | would have overlapped official Min                                    | follows new id `min_agent_edition` (Squirrel HKCU uninstall entry; static config audit)                                                                             |
| exe icon/version resource          | stock Electron (signAndEditExecutable:false env blocker)              | unchanged — intentional temporary limitation, documented in RELEASE_NOTES; setup.exe still embeds `icons/icon256.ico` via `--setupIcon` for installer/shortcut icon |

## 2. Collision evidence found (before repair)

1. `package.json` name/productName identical to upstream official Min (`min`/`Min`).
2. Host filesystem: `C:\Users\AKS-PC\AppData\Roaming\Min` exists (an original-Min profile);
   a packaged Agent Edition launched without `--user-data-dir` used to default into it.
3. Produced installer's embedded nuspec (pre-repair): `<id>min</id> <title>Min</title>
<authors>PalmerAL</authors>` — byte-equivalent package identity to official Min's
   installer ⇒ same `%LOCALAPPDATA%\min` install dir, same upgrade/uninstall identity,
   same shortcut title.

## 3. Coexistence results — tested on this host (16/16, `docs/p1111-coexistence.json`)

| test                                                                                        | result |
| ------------------------------------------------------------------------------------------- | ------ |
| packaged app launches with NO `--user-data-dir` on a host that HAS an original-Min profile  | PASS   |
| default root is the distinct `%APPDATA%/Min Agent Edition` (exact-path compare, not prefix) | PASS   |
| default root is NOT `%APPDATA%/Min`                                                         | PASS   |
| original `%APPDATA%/Min` untouched by the default launch (before/after dir-listing hash)    | PASS   |
| concurrent instance A + B: separate bridges, distinct ports and tokens (no cross-attach)    | PASS   |
| instance A sees only its own pages; B only its own (example.com vs example.org)             | PASS   |
| A's navigation/error does not disturb B; no mutual termination (tasklist during test)       | PASS   |
| temp profiles removed; cleanup targeted (`taskkill /PID` of self-spawned PIDs only)         | PASS   |
| cold-start acceptance re-run on renamed build (31-tool MCP path)                            | 30/30  |
| packaged filter re-check on renamed build (bundled list blocks, benign loads)               | PASS   |

**Not tested (explicit):** actual `setup.exe` install/uninstall cycles on a disposable
VM/test user (constraint forbids installer operations on the daily-use host; no disposable
VM available) — the Squirrel identity/install-dir/registry/shortcut claims are therefore
**static/config-audit evidence** from the produced nuspec + installer defaults, not a live
install run. **NOT TESTED: official-Min installer side-by-side against a real official
installation** (would require executing the official installer; original-Min profile
untouchedness was tested instead, which is the risky part for a daily host).

## 4. Signing / release trust

- `Get-AuthenticodeSignature` on both shipped files: `NotSigned` (installer and app exe).
- Caveat documented in RELEASE_NOTES: Windows will show unknown-publisher/SmartScreen
  warnings; unsigned ≠ unsafe, signature presence/absence ≠ security verdict.
- Code signing status: out of scope for this local/internal build; REQUIRED before any
  public distribution claim.
- `signAndEditExecutable:false` retained deliberately with the reason recorded in
  `scripts/createPackage.js` and RELEASE_NOTES; stock icon/version resource is an
  intentional temporary limitation replaceable via the existing pipeline (fix winCodeSign
  privileges → re-enable → icon/version stamping returns without touching runtime identity).

## 5. Changed files & backups

| file                                                 | change                                                                                                                                     | backup                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                       | name/productName/author/description → distinct Agent-Edition identity                                                                      | `docs/backups/P1-11.1/package.json.post-p1111` (post state; pre state reconstructible: name=min, productName=Min, author=PalmerAL, upstream description) |
| `scripts/buildWindows.js`                            | distinct artifact naming; tolerant Squirrel setup rename; explicit `exe` option; `path` require                                            | `docs/backups/P1-11.1/buildWindows.js.post-p1111`                                                                                                        |
| `RELEASE_NOTES.md`                                   | identity + signing caveats                                                                                                                 | `docs/backups/P1-11.1/RELEASE_NOTES.md.p1111`                                                                                                            |
| `scripts/p111-*.js` / `scripts/p1111-coexistence.js` | new test tooling (exe-name resolution)                                                                                                     | new files                                                                                                                                                |
| pre-repair reference                                 | production sources are additionally backed up at `docs/backups/P1-11/agentRpc.js.pre-p111`, `docs/backups/P1-11/min-agent-mcp.js.pre-p111` | P1-11 backups retained                                                                                                                                   |

Functional invariants preserved: single `onBeforeRequest` registrant
(`main/filtering.js:293`; bridge = comments only), SKILL.md shipped, all P1-11 behaviors
re-verified on the renamed artifact.

## 6. Regression results (post-identity-change, exact commands)

`npm run build` exit 0 · `npm run buildWindows` exit 0 (all 3 arch) ·
`test:agent-rpc` 182/182 · `mcp-e2e` 56/56 · `probe:transform` 18/18 ·
`probe:downloads` 33/33 · `p1-07-updater-test` 18/18 · `p111-coldstart-accept` 30/30 ·
`p111-packaged-filter-test` 2/2+updater · `p1111-coexistence` 16/16 · `probe:mouse`
26/27 (documented wheel limit) · smoke 6/6 · ad-blocker invariant intact · 0 strays.

## 7. Gate: **PASS**

The identity collision was real and is now repaired through the project's own supported
packaging pipeline (no runtime-code behavior changes); embedded installer identity,
executable name, default user-data root, and artifact names are distinct from official
Min and verified in the produced package; the original Min profile on this host is
provably untouched by Agent-Edition launches; concurrent instances coexist safely.
Installer install/uninstall cycles and official-Min-installer side-by-side-on-same-host
remain explicitly NOT TESTED (constraint-bound) — covered by static identity audit;
downgrade to `PARTIAL PASS` is not required because the risky-surface test (profile
protection on the daily host) was performed live and passed.
