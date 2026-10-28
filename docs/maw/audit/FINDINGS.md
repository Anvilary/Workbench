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
