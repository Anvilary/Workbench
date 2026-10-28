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

## A04 — P2 — failed native selection leaked state; historical attempts selected — FIXED

- Location: `agency-session-runtime.ts:tabAction` (baseline line 578).
- Evidence: code mutated session tabs before awaiting disk and emitted every
  session. New failure-injection test verifies previous selection after rejected
  write; a stable tab's historical attempts no longer become selected.
- Impact: rejected selection could still appear in coordinator finally snapshots;
  unnecessary change events amplified frontend work.
- Correction: commit changed metadata only; restore tab fields on failure without
  rolling back live process state. Regression and benchmark in O01.

## A05 — P2 — reconnecting viewer autofocus discards inline rename — FIXED

- Location: `TabNameInput.tsx:onBlur` (introduced in checkpoint 0).
- Real reproduction: at 390px select browser B then A; switch to 768px and rename
  while viewer reconnects. Screenshot contains typed `Research 768`, followed by
  old `ChatGPT A` after viewer autofocus, and save cannot find editor.
- Impact: user loses uncommitted text during background connection establishment.
- Correction: blur to another MAW control cancels; embedded viewer focus is
  returned to the editor until save/Escape. The same-origin Neko document only
  is involved; no ChatGPT DOM or conversation access.
- Verification: real React/Chromium test explicitly focuses an input inside the
  viewer while editing and verifies parent input focus returns; 2 PASS. A trial
  iframe inert attribute did not protect focus across browsing contexts and was
  discarded. Six-viewport real rerun pending at this checkpoint.

## Boundaries and unverified risks (not confirmed vulnerabilities)

- Shared Neko is one global desktop. Controller ownership isolates mutations,
  not independent visual desktops for concurrent MAW viewers. Do not advertise
  multi-user/workspace confidentiality for one shared browser stream.
- Browser navigation URL policy is not proof of subresource/network egress
  isolation. No packet-level local-network isolation experiment in this audit.
- TypeScript atomic rename avoids partial JSON but lacks explicit fsync; sudden
  power-loss durability is not established by process restart tests. Python
  ownership registry does fsync. No power-cut test on host performed.
- Antigravity hook completion and authenticated ChatGPT completion UNVERIFIED.
- Neko guest reconnect surfaced a transient upstream display-name login overlay
  in an unsuccessful run. Reconnect reliability needs a longer dedicated soak;
  do not count media-ready alone as a fully interactive page.
