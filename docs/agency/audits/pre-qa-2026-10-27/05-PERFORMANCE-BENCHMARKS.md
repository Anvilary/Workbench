NOT_STARTED

# Performance Benchmarks

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


## Preliminary build output (not a startup benchmark)

Production Vite build, offline installed dependencies, Node 24.22.0, pnpm 11.24.0: 238 modules, main JS 1,126.92 kB raw / 310.00 kB gzip, CSS 99.80 kB / 19.09 kB gzip; Vite reported build duration 2.69 s. Main bundle size agrees with prior report. No browser parse cost, network, startup or interaction measurements collected; bundle impact remains unverified. The root `corepack pnpm build` script fails in this environment because `pnpm` executable is absent from PATH; direct `corepack pnpm --filter @agent-workbench/web build` succeeded. Do not classify missing shell shim as an application defect without verifying normal setup.
