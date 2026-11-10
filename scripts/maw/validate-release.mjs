// All application state, sockets and downloads are private to this validation run.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync, createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const phase = process.argv[2] ?? 'all';
const evidence = path.resolve(process.argv[3] ?? '/tmp/maw-release-validation');
await mkdir(evidence, { recursive: true });
const home = await mkdtemp(path.join(tmpdir(), 'maw-release-validation-home-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('MAW_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime'),
  MAW_AUTO_SPAWN_PTYD: '1',
  COREPACK_HOME: process.env.COREPACK_HOME ?? path.join(homedir(), '.cache/node/corepack'), COREPACK_ENABLE_NETWORK: '0',
  ELECTRON_OVERRIDE_DIST_PATH: '/opt/maw-electron/45.2.0' });
await mkdir(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
const cache = path.join(homedir(), '.cache/ms-playwright');
env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? [
  chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/brave-browser',
  ...(existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse()
    .map(name => path.join(cache, name, 'chrome-headless-shell-linux64/chrome-headless-shell')) : []),
].find(file => existsSync(file));
if (!env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) delete env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const results = [];
async function run(name, command, cwd = root) {
  const start = Date.now();
  const stream = createWriteStream(path.join(evidence, `${name}.log`));
  const child = spawn('/bin/sh', ['-c', command], { cwd,
    env: { ...env, PATH: `${path.join(cwd, 'node_modules/.bin')}:${path.join(root, 'node_modules/.bin')}:${env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'] });
  for (const source of [child.stdout, child.stderr]) source.on('data', data => stream.write(data));
  // Private D-Bus helpers can inherit stdout beyond the test runner's lifetime.
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); resolve(code); }, 50));
  });
  await new Promise(resolve => stream.end(resolve));
  const result = { name, command, code, durationSeconds: +((Date.now() - start) / 1000).toFixed(2) };
  results.push(result);
  console.log(JSON.stringify(result));
}
try {
  if (['all', 'build'].includes(phase)) await run('build', 'corepack pnpm build');
  if (['all', 'unit', 'server', 'web'].includes(phase)) {
    if (['all', 'unit'].includes(phase)) await run('typecheck', 'corepack pnpm typecheck');
    for (const pkg of ['desktop', 'server', 'web']) {
      if (['server', 'web'].includes(phase) && phase !== pkg) continue;
      const json = JSON.parse(await readFile(path.join(root, `packages/${pkg}/package.json`), 'utf8'));
      await run(`${pkg}-test`, json.scripts.test.replace('--test ', '--test --test-concurrency=1 '), path.join(root, `packages/${pkg}`));
    }
  }
  if (['all', 'build'].includes(phase)) {
    await run('checks', 'corepack pnpm check');
    await run('desktop-package', 'node scripts/maw/build-desktop-deb.mjs');
    await run('desktop-production', 'node --test --test-concurrency=1 packages/desktop/production.test.mjs');
  }
  if (['all', 'desktop', 'acceptance'].includes(phase)) {
    const desktop = JSON.parse(await readFile(path.join(root, 'packages/desktop/package.json'), 'utf8'));
    if (phase !== 'acceptance') await run('electron', `GSK_RENDERER=cairo LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a dbus-run-session env MAW_NAUTILUS_TEST_ISOLATED=1 ${desktop.scripts['test:electron']}`, path.join(root, 'packages/desktop'));
    await run('browser-acceptance', 'node --test --test-concurrency=1 packages/web/src/agency/browser-tabs.test.mjs packages/web/src/maw-root.test.mjs packages/web/src/terminal-webgl.test.mjs packages/web/src/agency/native-layout-coordinator.test.mjs packages/web/src/agency/split/terminal-scrollback-20k.test.mjs');
  }
  if (['all', 'desktop', 'staging'].includes(phase)) await run('staging', 'xvfb-run -a node --test packages/desktop/staging-release.test.mjs');
} finally {
  await writeFile(path.join(evidence, `${phase}.json`), JSON.stringify({ phase, results }, null, 2) + '\n');
  await rm(home, { recursive: true, force: true });
}
if (results.some(result => result.code !== 0)) process.exitCode = 1;
