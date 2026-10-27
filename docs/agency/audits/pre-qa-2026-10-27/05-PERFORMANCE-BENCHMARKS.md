IN_PROGRESS

# Performance Benchmarks

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


## Preliminary build output (not a startup benchmark)

Production Vite build, offline installed dependencies, Node 24.22.0, pnpm 11.24.0: 238 modules, main JS 1,126.92 kB raw / 310.00 kB gzip, CSS 99.80 kB / 19.09 kB gzip; Vite reported build duration 2.69 s. Main bundle size agrees with prior report. No browser parse cost, network, startup or interaction measurements collected; bundle impact remains unverified. The root `corepack pnpm build` script fails in this environment because `pnpm` executable is absent from PATH; direct `corepack pnpm --filter @agent-workbench/web build` succeeded. Do not classify missing shell shim as an application defect without verifying normal setup.

## Repeated warm browser interactions, low-load fixture

Hardware: Linux x86_64, AMD Ryzen 7 250 (8 cores / 16 logical), 28.7 GiB RAM; Chrome 155.0.8059.39 headless, Node 24.22.0, pnpm 11.24.0. One production server; synthetic no-inference agent, shell, 5 small workspaces, 1440x900. No sustained terminal output. No competing build was running. Each row n=20; p95 is nearest-rank 19th; p50 averages 10th/11th. Playwright wall-clock includes client protocol/action overhead and waiting for visible workspace/aria-current, not isolated React render or input-to-paint. Dialog and sidebar values are complete open+close cycles; composer uses `fill` of ~518 characters rather than human typing latency.

| Action | p50 ms | p95 ms | max ms | n |
|---|---:|---:|---:|---:|
| Switch between two workspaces without active PTYs | 33.80 | 36.45 | 37.57 | 20 |
| Switch between agent-only and combined workspaces with idle PTYs | 56.19 | 61.49 | 64.26 | 20 |
| Profile dialog open and close | 33.61 | 44.89 | 48.80 | 20 |
| Sidebar collapse and expand | 66.74 | 70.27 | 70.91 | 20 |
| Composer fill | 3.81 | 7.10 | 9.85 | 20 |

Single run; warm cache and low load; no statistical comparison across machines, cold launches or UI under output. No basis yet for a specific optimization recommendation.

Reproduction: copy `packages/server/scripts/capture-agency-screenshots.mjs` to a temporary `.mjs`, rewrite its `playwright` and `ws` imports to the audit worktree's installed packages and `serverDir` to the audit worktree's `packages/server`, then insert the following before `await browser.close()`. Run with `PATH=/tmp/agency-audit-bin:$PATH AGENCY_SCREENSHOT_DIR=/tmp/agency-audit-shots node /tmp/agency-audit-browser-bench.mjs`; pnpm shim setup in 09. The temporary copy `/tmp/agency-audit-browser-bench.mjs` currently contains the full reproducible fixture, but may not survive a reboot.

```javascript
const results = {};
async function bench(label, count, action) {
 const values=[];
 for(let i=0;i<count;i++){const start=performance.now(); await action(i); values.push(performance.now()-start);}
 values.sort((a,b)=>a-b); const round=x=>Math.round(x*100)/100;
 results[label]={n:values.length,p50:round((values[9]+values[10])/2),p95:round(values[18]),max:round(values[19])};
}
await page.setViewportSize({width:1440,height:900});
await selectWorkspace('Empty Workspace');
await bench('switch_no_active_pty_ms',20,async i=>selectWorkspace(i%2?'Empty Workspace':'Completed Task'));
await selectWorkspace('Agent Only');
await bench('switch_active_pty_ms',20,async i=>selectWorkspace(i%2?'Agent Only':'Combined Workspace'));
await selectWorkspace('Empty Workspace');
await bench('profile_dialog_cycle_ms',20,async()=>{await page.getByRole('button',{name:'Configure profile'}).click();await page.locator('[role="dialog"]').waitFor({state:'visible'});await page.keyboard.press('Escape');await page.locator('[role="dialog"]').waitFor({state:'hidden'});});
await bench('sidebar_toggle_cycle_ms',20,async()=>{await sidebarToggle.click();await page.locator('.agency-sidebar-nav').waitFor({state:'hidden'});await sidebarToggle.click();await page.locator('.agency-sidebar-nav').waitFor({state:'visible'});});
const composer=page.locator('.agency-composer textarea');
await bench('composer_fill_ms',20,async i=>{await composer.fill('Synthetic draft '+i+' '+'.'.repeat(500));});
console.log('AUDIT_BENCHMARKS',JSON.stringify(results));
```

Still required: cold/warm startup distributions, browser parse/render, load and large transcript, sustained PTY output/reattach/resize, CPU/memory/fd/listener growth and persistence/restart distributions.
