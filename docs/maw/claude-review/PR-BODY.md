Remediates the original 19 Claude audit findings and three defects found during remediation. Release activation verifies readiness by release ID, preserves verified rollback targets, and keeps staging separate from activation. Live snapshots exclude closed history; frontend loading and terminal backpressure improvements retain the earlier measured gains.

Final independent AGY corrections:

- Prevent closed-tab resurrection after interrupted history/live writes: timestamp runtime tab changes and prefer closed history on equal timestamps. Regression uses real closes and abrupt process exit between writes, rapid changes and two restarts.
- Document single-file downgrade behavior and explicitly distinguish executable rollback from historical-data compatibility. Dormant history remains intact and is available after upgrading again.
- Install the unit renderer and template; prove installed scripts render, update, activate and retrieve readiness after the installer-source copy is removed.

Local verification: **235/235 server tests**, including history 9, runtime 40, updater/installer 36 and host 6; **2/2 isolated real-systemd tests**; typecheck, full checks and build pass. `check-docs` skips its absent internal guide; the existing bundle-size warning remains. Hosted CI is blocked before startup by account billing/spending limits.

Details, changed files, earlier browser/Neko/PTY evidence and remaining limitations: [remediation report](https://github.com/user/My-Amazing-Workspace/blob/fix/maw-claude-audit-remediation/docs/maw/claude-review/REMEDIATION-FINAL.md) and [matrix](https://github.com/user/My-Amazing-Workspace/blob/fix/maw-claude-audit-remediation/docs/maw/claude-review/REMEDIATION-MATRIX.md). The live MAW process and application data are preserved. PR remains unmerged; no production deployment or feature-branch changes.
