# MAW implementation checkpoint

## Checkpoint zero — 2026-10-28

Branch: feat/maw-persistent-workspace. Worktree: /home/alteixeira20/Projects/My-Amazing-Workspace-next.
Baseline and fetched origin/main: af7df497ede5495aaad8696cd5cdac3a05a82355. Original main is clean and untouched.
Read HANDOFF.md and docs/agency/CONTRACT.md. Preserve internal Agency identifiers and existing config paths.
Node: /home/alteixeira20/.nvm/versions/node/v24.22.0/bin/node, v24.22.0.
Corepack: 0.36.0. pnpm: /home/alteixeira20/.local/bin/pnpm, 11.24.0.
No maw executable or MAW/Agency/workbench systemd user unit found. Linger=yes already; no lingering changes required.
Existing native processes include AGY, Codex and test CLI PTYs. Existing test server PID 4173951 listens on loopback port 34187. None signaled or altered.
No delegation or Jev tools exposed in this session. Do not launch authenticated CLIs or consume paid model tokens for tests.

Architecture: atomic project/workspace JSON store, separately queued durable session store; server-owned TerminalRegistry; one authenticated /ws; runtime reserves agent/terminal slots. Startup currently marks live metadata exited without native recovery. Frontend attaches existing terminal IDs. Native identity and Codex home isolation already exist and must remain enforced.

## Pending

A: branding, sidebar controls, shared dropdown behavior, breadcrumbs, persistent tabs, exited state, browser acceptance.
B: verify pnpm release/compatibility; defensive maw wrapper and tests.
C: isolated service lifecycle/readiness/single owner tests before live activation; user unit and operations instructions.
D: durable recovery eligibility/status, provider-specific validation, bounded recovery, race and restart tests.
E: full required suites, screenshots, installed package smoke, guarded activation/rollback, draft PR.

## Recovery instructions

Continue only in the feature worktree above. Read this file, OPERATIONS.md and RECOVERY.md first; inspect git status and latest commits. Never reset the original main worktree. Do not stop existing providers or activate a service against real stores until isolated checks pass. Commit and push verified phases without force. No merge authorized.
