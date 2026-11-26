# Privacy gate

The repository must not contain personal identifiers of its maintainers or users: home paths, usernames, host names, private repository URLs or personal agent profile names. Tests, fixtures and docs use synthetic values (`user`, `/home/user`, `example-host`, `codex-a`, `~`, `<workspace>`).

## CI gate

`.github/scripts/privacy-gate.mjs` runs in the CI `verify` job:

```sh
node .github/scripts/privacy-gate.mjs paths      # tracked text files must not contain personal home paths
node .github/scripts/privacy-gate.mjs gitleaks   # pinned, checksum-verified gitleaks scan of the tree (downloads gitleaks)
node .github/scripts/privacy-gate.mjs all        # both
```

The path check flags `/home/<name>/` and `/Users/<name>/` unless `<name>` is a generic placeholder (`user`, `runner`, `example`, `test`, `ubuntu`, `node`). Failures are printed with the name redacted, so a failing gate never republishes the identifier in CI logs. Binary files are skipped.

`.github/privacy-gate-allowlist.txt` can list repo-relative paths that are temporarily exempt. Keep it empty; the gate warns about entries that are no longer needed.

## What the gate does not cover

The path check is pattern based. It does not detect bare usernames, host names, personal profile names or private repository URLs, and it does not read text inside images. Before adding screenshots or recordings, check them for shell prompts, paths, account names and conversation content.

## Documentation links

`node scripts/check-doc-links.mjs` (`pnpm check:docs`) verifies relative links and anchors in every tracked markdown file. It runs in the same CI job.
