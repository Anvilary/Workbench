# Desktop validation

How to validate the Electron desktop on Linux. Suite tiers and conventions for the whole repository are in [testing architecture](../architecture/testing.md); the CI and release checklist is in [CI and release](../operations/ci-and-release.md).

## Automated checks

From the repository root:

```sh
pnpm typecheck
pnpm build
pnpm check
pnpm --filter @anvilary/workbench-web test:integration
pnpm --filter @anvilary/workbench-desktop test:unit
xvfb-run -a pnpm --filter @anvilary/workbench-desktop test:electron
```

Further desktop suites: `test:integration`, `test:security`, `test:e2e`, `test:runtime`, `test:terminal`, `test:staging` and `test:production`. Run Electron suites on an isolated display (Xvfb) with the sandboxed Electron runtime, disposable HOME and XDG directories, and `WORKBENCH_UNSAFE_LOCAL_NO_AUTH` unset. Use Playwright with at most two workers on shared machines.

From `packages/server`:

```sh
pnpm test:unit && pnpm test:integration && pnpm test:security
```

Fixtures use synthetic pages and fake CLIs. They do not prove real provider authentication; check that manually (see below).

## Memory measurements

Use `/proc/<pid>/smaps_rollup` and compare PSS, not summed RSS: summed RSS counts shared pages once per process. The read-only helper samples known process trees without reading command lines, cookies or page content:

```sh
python3 packages/desktop/tools/measure-memory.py --group desktop:PID --group baseline:PID --samples 3
```

Record the actual workload with every result, take several samples, and report medians. Compare like-for-like workloads only. The methodology for repeatable benchmarks is in [benchmark methodology](../performance/benchmark-methodology.md); runtime limits are in the [budget policy](../performance/budget-policy.md).

## Manual acceptance

Before a release, on a real desktop session:

- sign in to each provider in its partition, including a security-key sign-in if used ([WebAuthn](../security/webauthn.md));
- switch, reorder and close tabs; confirm background pages keep streaming and that typed text never reaches a terminal ([input isolation](../browser/input-isolation.md));
- download a file, open DevTools, change spellcheck languages ([browser profiles](../browser/profiles.md));
- restart the backend and confirm terminals survive and browser pages reconnect; reboot once and confirm restoration ([startup acceptance](../operations/startup-acceptance.md)).
