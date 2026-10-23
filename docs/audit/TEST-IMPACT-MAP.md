# Test Impact Map — change to test selection

Machine-readable source of truth: **`scripts/lib/test-impact-map.json`**. This document explains it and is the human-reviewable policy. Keep both in sync; a change to one without the other is a defect.

Selector: `node scripts/test-impact.js` (dry run) / `--run` / `--all` / `--realweb`.

---

## 1. How selection works

1. The selector reads `git status --porcelain --untracked-files=all`.
2. Each changed path is matched against the **first** rule in `impact[]` that matches.
3. The union of those rules' suites is run **serially** (suites share Electron runtime state).
4. A path that matches **no** rule is reported **UNBOUNDED**, and the tool refuses to run a partial plan: run `--all`.
5. Layer C real-web is added only when a matched rule sets `realweb: true` **and** `--realweb` is passed.

The selector never guesses. If it cannot bound the change, it says so.

---

## 2. Module → suite map

| Changed path                                                                                                          | Suites selected                                                                                            | Layer C | Full suite |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| `main/agentRpc.js`                                                                                                    | rpc-unit, mcp-e2e, api-matrix, eval, captcha, tabs, inputs, waits, downloads, transform, pav, **keyboard** | yes     | **yes**    |
| `js/preload/default.js`                                                                                               | mcp-e2e, inputs, mouse                                                                                     | yes     | **yes**    |
| `mcp/min-agent-mcp.js`                                                                                                | mcp-e2e, rpc-unit                                                                                          | yes     | **yes**    |
| `main/filtering.js`                                                                                                   | mcp-e2e, waits                                                                                             | yes     | **yes**    |
| `main/viewManager.js`, `main/main.js`, `main/download.js`, `main/permissionManager.js`, `main/prompt.js`              | smoke, mcp-e2e, tabs, downloads                                                                            | no      | **yes**    |
| `scripts/lib/proctools.js`, `scripts/min-launch.js`                                                                   | proctools, smoke                                                                                           | no      | no         |
| build scripts, `package.json`                                                                                         | smoke                                                                                                      | no      | **yes**    |
| `filterUpdate.js`, `ext/**`                                                                                           | updater                                                                                                    | no      | no         |
| each `scripts/agent-*-probe.js`                                                                                       | that probe                                                                                                 | no      | no         |
| `scripts/p110-api-matrix.js`                                                                                          | api-matrix                                                                                                 | no      | no         |
| `scripts/p111-*`, `p1131-*`                                                                                           | smoke                                                                                                      | no      | **yes**    |
| `scripts/mcp-e2e.js`, `agent-rpc-test.js`, `proctools-test.js`, `realweb-accept.js`, `test-impact.js`, the map itself | rpc-unit, mcp-e2e, proctools                                                                               | no      | **yes**    |
| `scripts/agent-keyboard-probe.js` (D3-A)                                                                              | probe-keyboard                                                                                             | no      | no         |
| `scripts/agent-helper-probe.js` (ADR-09 Option C)                                                                     | probe-helper                                                                                               | no      | no         |
| `p112-*` publish/secret-scan                                                                                          | none (manual before publish)                                                                               | no      | no         |
| `p115-*`, `p110-dbg-*`, scratch artifacts                                                                             | none (provenance/one-off)                                                                                  | no      | no         |
| `SKILL.md`, `docs/**`, `mcp/README.md`, `CONTRIBUTING.md`, `RELEASE_NOTES.md`                                         | none                                                                                                       | no      | no         |

---

## 3. Always-full triggers

These are listed in the map under `always_full` and are **not** waivable by the selector:

- Electron/Chromium version change.
- Anything touching authentication, grants, batch dispatch, or the preload/renderer boundary.
- A tool-census or schema migration.
- Profile/launcher/bridge lifecycle or isolation.
- Shared test-helper or process-management code.
- Packaging/release configuration.
- A refactor spanning more than one capability group.
- Any incident suggesting a security-policy bypass or silent cross-tab action.

---

## 4. Worked examples

**Docs-only edit** — `docs/audit/*.md` → _no suites_. Do not run anything.

**Single filter-list fix** — `filterUpdate.js` → _updater_. ~10 s.

**New probe assertion** — `scripts/agent-waits-probe.js` → _probe:waits_. No full suite.

**Bridge tool change** — `main/agentRpc.js` → 11 suites + Layer C + **full**. This is deliberate: one file owns dispatch, auth, grants, batch and every tool.

**Preload tweak** — `js/preload/default.js` → mcp-e2e, inputs, mouse, Layer C, **full**. The preload is the delivery-attestation trust boundary.

---

## 5. Maintenance

Add a rule when a new module/test lands. If a rule is removed, say why in the commit/report. If a rule's suites change, update both this file and the JSON in the same change.

A **new** source file with no rule is not "safe by default" — it is UNBOUNDED until a rule exists.
