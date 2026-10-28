# Findings

No confirmed defects recorded at baseline. Hypotheses remain in the checkpoint
risk map until reproduced. Record severity, code location, reproduction, evidence,
impact, correction and verification for each confirmed finding.

Documentation mismatch: production integration guide is under `docs/maw/neko/`,
not the requested `infra/neko/` path. No runtime impact.

## A01 — P1 — malformed unauthenticated cookie crashes WebSocket listener — FIXED

- Location: `packages/server/src/security.ts:readCookie`; synchronous caller
  `packages/server/src/terminal-socket.ts:onUpgrade` (baseline lines 84/1020).
- Reproduction: `node scripts/audit/security-probe.mjs`. Disposable loopback HTTP
  process calls the actual authorization function in the same synchronous upgrade
  path; send Upgrade with `Cookie: agent_workbench_token=%`, no token required.
- Before: child exit 1, uncaught `URIError: URI malformed` at decodeURIComponent.
  Evidence `/tmp/maw-audit-cookie-before.log`; after: exit 0 and HTTP 403.
- Impact: a local unauthenticated client can terminate the MAW host, consequently
  disrupting native PTYs. Host/Origin checks do not protect against malformed
  cookies from a loopback client. No remote Internet exploit is claimed.
- Fix: treat undecodable credential cookies as missing credentials, including
  paired-device cookies. No exception escapes the synchronous listener.
- Verification: 1 focused test covers four invalid encodings, device verifier
  exclusion, valid auth and foreign Origin rejection; child probe returns 403.

## A02 — P2 — failed browser rename leaked uncommitted state — FIXED

- Location: `browser-tab-adapter.ts:renameTab` (baseline line 403).
- Repro: new production regression replaces fixture store.save with disk-full
  failure. rename rejects but getTabState returns `Unsaved` instead of `Original`.
  Coordinator's finally snapshot exposes that uncommitted title to clients.
- Impact: false persisted name; next restart silently loses it.
- Fix: restore title/timestamp on persistence failure under existing workspace lock.
- Verification: before test fails (`Unsaved != Original`); after passes, retry and
  fresh adapter/store reload retain new title, stable tab ID and target reference.

## A03 — P2 — Codex stays Working after evidence disappears — FIXED

- Location: `agents/codex/turn-watcher.ts:poll/read` (baseline lines 45–62).
- Repro: fixture session_meta + task_started, poll, move rollout to backup, poll
  twice. Before emits only Working; after emits Working then Unknown exactly once.
- Impact: misleading indefinite Working after missing/inaccessible/rotated evidence.
- Fix: emit Unknown for active turns on evidence loss; no fabricated completion,
  no repeated Unknown events each poll. Explicit completion still required.
- Verification: activity suite and production browser tests 19 PASS; original
  replay, failure, abort, scope and real Bash/Zsh tests remain passing.
