// Old installed updaters also execute the target's build script. Fail before staging
// a release that removes the old browser runtime without installing its replacement.
import { existsSync } from 'node:fs';
import { assertRuntime, assertLauncher } from './desktop-runtime.mjs';
if (existsSync('.maw-candidate')) {
  try { await assertRuntime(process.cwd()); await assertLauncher(); }
  catch { console.error('Desktop runtime prerequisite missing or unsafe. Install the target release Ubuntu runtime (scripts/maw/install.sh --desktop), then retry maw update. No release was activated.'); process.exitCode = 1; }
}
