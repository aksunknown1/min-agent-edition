# Contributing to Min Agent Edition

This is a developer fork of [Min](https://github.com/minbrowser/min) (v1.35.7) that adds
an agent bridge, an MCP stdio adapter and browser-automation regression harnesses. It is
a separate product ("Min Agent Edition") and must not be installed over, or confused
with, the official Min browser (see `RELEASE_NOTES.md`).

## Requirements

- Node.js: the repository carries an inherited `.nvmrc` (15.7.0, from upstream); the
  tree is actually developed and verified on **Node v24.19.0** with the Electron version
  pinned in `package.json` (`electronVersion: 43.4.1`). Any modern Node ≥ 18 should work;
  24.x is the tested engine.
- Windows (tested), macOS/Linux pipelines exist via the inherited build scripts.
- Dependencies: `npm install` (the `postinstall` hook runs `scripts/setupDevEnv.js`).
  The lockfile (`package-lock.json`, P1-12: now versioned) pins the verified tree; do not
  upgrade dependencies casually — `npmRebuild: false` is intentional (upstream note in
  `scripts/createPackage.js`).

## Build

```
npm run build            # buildMain + buildBrowser + buildBrowserStyles + buildPreload
                         #   -> regenerates main.build.js and dist/ renderer bundles
npm run buildWindows     # + electron-builder dir target -> dist/app/win-unpacked,
                         #   zip + Squirrel setup.exe per arch (x64/ia32/arm64)
```

- `main.build.js` is **generated** (concatenated by `scripts/buildMain.js`) and is
  gitignored; a clean checkout recreates it byte-for-byte with `npm run build`
  (proven: P1-12 clean-copy reproduction, byte-identical).
- `dist/` is **purely generated packaging output** (gitignored). Distributables
  (`Min-Agent-Edition-*.zip` / `-setup.exe`) belong in GitHub Releases or CI workflow
  artifacts (`.github/workflows/build-packages.yml`), never in source commits.
- The agent bridge needs `--agent-rpc` (the dev launcher `npm run launch:agent -- …` /
  `scripts/min-launch.js` handles profile + discovery token file; never commit tokens).

## Test

```
npm run test:agent-rpc      # bridge/RPC schema tests (182 checks)
node scripts/mcp-e2e.js     # MCP stdio end-to-end incl. real image delivery (56)
npm run probe:pav           # predict/act/verify (15)   npm run probe:tabs        (16)
npm run probe:transform     # reversible transforms (18) npm run probe:downloads   (33)
npm run probe:mouse         # mouse/image (26-27; documented wheel limitation)
npm run probe:inputs        # 20    probe:waits 16    probe:captcha 14   probe:nps 38
node scripts/p1-07-updater-test.js   # filter updater resilience (18)
npm run smoke:baseline      # app cold-start smoke (6)
node scripts/extension-probe.js      # extension-host compatibility evidence
node scripts/proctools-test.js       # shared process-cleanup/readiness helper tests (9)
```

Probe safety contract (P1-14 hygiene): all probes terminate ONLY processes they
spawned themselves (targeted `taskkill /PID <pid> /T` via `scripts/lib/proctools.js`);
process-name-wide kills (`/IM electron.exe`) are forbidden — they can destroy
unrelated user sessions. Readiness polls are bounded and fail when the browser never
becomes ready.

Known platform limitations (documented honestly, not bugs to "fix" here): mouse-wheel
page delivery is unreliable on this Electron/OS build (use `browser_scroll`); durable
synthetic hover is not guaranteed; the installer is unsigned; agent extension loading is
an experimental development path.

Known separate follow-up items (outside the runtime suite): `npm test` (standard lint)
currently reports upstream style problems — separate hygiene task; `npm audit` reports
inherited upstream advisories — evaluate on a dependency-update task, not during
feature work.

## Repository layout notes

- `scripts/` holds only package-referenced build/test tooling and the P1-10/11/12
  harnesses; one-off phase diagnostics live in the local-only `dev-archive/`.
- `docs/` carries the design docs, per-phase audit addenda (`docs/audit/`) and
  regression-evidence JSONs. `docs/backups/`, personal screenshots and
  account-creation artifacts are local-only (gitignored) and must stay that way.
- `SKILL.md` (agent operating policy) is shipped to `resources/SKILL.md` by the
  packager (`extraResources`) — keep it accurate with schema changes.
- Ad/tracker blocking invariant: exactly ONE `webRequest.onBeforeRequest` registrant
  per session (`main/filtering.js`); the agent bridge must never register one.
