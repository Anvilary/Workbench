import { workbenchEnv } from './env.mjs';
// Old installed updaters also execute the target's build script. Fail before staging
// a release that removes the old browser runtime without installing its replacement.
import { existsSync } from 'node:fs';
import { assertRuntime, assertLauncher, assertActivationHelper } from './desktop-runtime.mjs';
if (existsSync('.workbench-candidate')) {
  const headless = workbenchEnv('HEADLESS') === '1' || workbenchEnv('SKIP_DESKTOP_CHECK') === '1';
  if (!headless) {
    try { await assertRuntime(process.cwd()); await assertLauncher(); }
    catch { console.error('Desktop runtime prerequisite missing or unsafe. Install the target release Ubuntu runtime (scripts/workbench/install.sh --desktop), or set WORKBENCH_HEADLESS=1 for headless server installs, then retry. No release was activated.'); process.exitCode = 1; }
  }
  if (!process.exitCode) {
    try { await assertActivationHelper(); }
    catch { console.error('Activation helper bootstrap required. From the reviewed source run: sh scripts/workbench/install.sh --integrate-desktop (or --commands-only for headless use). Then retry. No release was activated.'); process.exitCode = 1; }
  }
}
