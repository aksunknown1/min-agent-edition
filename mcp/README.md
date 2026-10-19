# min-agent MCP adapter

Exposes the 30 Min agent-rpc tools (navigation, tabs, snapshot/content,
click/type/press/hover/scroll/select/check/wait, predict/verify,
screenshot, tab management, reversible transforms, agent-managed
downloads: `browser_download_start/wait/cancel/pause/resume` plus the
read-only `browser_downloads`) to any MCP client over stdio.

## Start-up order (always)

1. **Start Min first** (visible window, agent-rpc on, dedicated profile):

   ```
   node scripts/min-launch.js
   ```
   (optionally with start URLs: `node scripts/min-launch.js -- https://example.com`)
2. **Then start your MCP client.** The adapter reads the bridge token from the
   profile's `agent-rpc.json` on every call; the token rotates per launch.

Profile directory: `%USERPROFILE%\.min-agent-profile` by default; override per
launch with `--profile=<dir>`, and for the adapter with `--profile=<dir>` or the
`MIN_AGENT_PROFILE` environment variable (set only the launcher-style dir — the
adapter finds `<dir>-development/agent-rpc.json` itself).

## Generic mcpServers block

```json
{
  "mcpServers": {
    "min-agent": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp/min-agent-mcp.js"],
      "env": { "MIN_AGENT_PROFILE": "C:/Users/<you>/.min-agent-profile" }
    }
  }
}
```

`Claude Code CLI (verified against code.claude.com/docs/en/mcp, 2026-10)`

CLI, one-off (whole command after `--`; stdio is the default transport for
local commands):

```
claude mcp add min-agent -- node C:/Users/<you>/min-agent-edition/mcp/min-agent-mcp.js --profile=C:/Users/<you>/.min-agent-profile
```

Project-scoped JSON: put the generic block above (without the `"type"` field,
which Claude Code reads as stdio) in `.mcp.json` at the project root, then
approve it with `claude`.

`Cursor (verified against cursor.com/docs/mcp, 2026-10)`

Put the generic block above (Cursor requires `"type": "stdio"`) in
`C:/Users/<you>/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json`
(project). Then reload Cursor and enable the server under Customize → MCP.

## Notes

- Claude Code: **config-only, untested**.
- Cursor: **config-only, untested**.
- Generic stdio JSON-RPC clients: **tested** (see `docs/mcp-e2e-run.json`).
- The adapter never writes its token anywhere except the local loopback
  Authorization header. stdout carries MCP frames only.

## Autonomous execution loop (P1-02 contract)

When a user authorizes a browser goal, run this loop instead of asking for
step-by-step permission:

1. Understand the goal and the scope of authorization (what was explicitly
   allowed; what counts as completion).
2. Collect everything genuinely missing in ONE consolidated question. Missing
   information = identity details, secrets, choices, or an irreversible
   action that was not pre-authorized. Everything else is inferable.
3. Plan; always re-observe before acting on a stale assumption: a compact
   snapshot (or `browser_content`/`browser_state`) is enough for familiar
   pages; reserve full snapshots for ambiguity or recovery.
4. Act with the narrowest tool that does the job; verify the structured
   result (verified/verification fields — an executed action is not a
   completed task).
5. On failure: identify the category (`ref_stale`/`ref_not_found` →
   re-snapshot and retry; `view_not_attached` → browser_tab_select and
   retry; `timeout` → adjust once; `captcha_handoff_required` → hand the
   challenge to the user, then poll `browser_state` and resume automatically
   when cleared). One safe alternative strategy per failure is the norm.
6. Continue until the goal is verified complete by evidence (page state,
   not a dispatched event), then report outcome + limitations.
7. Only stop for: missing consolidated information, CAPTCHA/secondary auth
   the user must complete, irreversible submissions not covered by the
   original authorization, or genuine errors.

Efficiency rules (measured in docs/AUTONOMY-GAP-ANALYSIS.md and
docs/autonomy-workflows.json):
- Use `browser_batch` for deterministic action sequences (up to 20 steps,
  stop-on-error). Grants/CAPTCHA checks still apply per step; batch cannot
  bundle grant issuance.
- Never take unconditional sleeps; use `browser_wait` or verify read-backs.
- Reuse observations only while the page state has not materially changed;
  invalidate refs after navigation (the bridge does this automatically).
- Never read page bodies on steps that may display secrets (passwords, seed
  phrases, recovery codes) — content reads are for plain pages only.
