import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('repository test launcher replaces live paths and removes inherited Workbench settings', () => {
  const redirected = '/production-sentinel';
  const directories = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'];
  const settings = ['RUNTIME_DIR', 'RELEASES_DIR', 'ENV_FILE', 'PTYD_RUNTIME_DIR', 'PTYD_SOCKET', 'PTYD_AUTH_FILE', 'UNSAFE_LOCAL_NO_AUTH'];
  const ignored = ['WORKBENCH_', 'MAW_', 'AGENT_WORKBENCH_'].flatMap(prefix => settings.map(key => prefix + key));
  const launcher = fileURLToPath(new URL('./run-isolated-tests.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [launcher, '-p', 'JSON.stringify(process.env)'], { encoding: 'utf8', env: {
    ...process.env,
    ...Object.fromEntries([...directories, ...ignored].map(key => [key, redirected])),
    WORKBENCH_NAUTILUS_TEST_ISOLATED: '1',
  } });
  const env = JSON.parse(out);
  for (const key of ignored) assert.equal(env[key], undefined, key);
  const root = path.dirname(env.HOME);
  assert.match(path.basename(root), /^workbench-tests-/);
  for (const key of directories) assert.ok(path.relative(root, env[key]).split(path.sep)[0] !== '..', key);
  assert.equal(env.WORKBENCH_NAUTILUS_TEST_ISOLATED, '1');
  assert.equal(existsSync(root), false);
});
