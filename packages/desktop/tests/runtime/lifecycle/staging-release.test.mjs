// Built MAW release path: production server, packaged frontend and real Electron.
// Every mutable path is isolated under a disposable HOME and Electron profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT, REPO_ROOT } from '../../helpers/paths.mjs';

const here = DESKTOP_ROOT;
const repo = REPO_ROOT;
const require = createRequire(import.meta.url);
const electronExecutable = process.env.MAW_ELECTRON_EXECUTABLE || (existsSync('/opt/maw-electron/45.2.0/electron') ? '/opt/maw-electron/45.2.0/electron' : require('electron'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(check, description, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await pause(40);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function isolatedEnv(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^MAW_|^AGENT_WORKBENCH_PORT$|(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'home', '.codex'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    MAW_RUNTIME_DIR: path.join(root, 'runtime'),
    MAW_PERSISTENT_PTY: '0',
    MAW_DESKTOP_DATA_DIR: path.join(root, 'electron-profile'),
    AGENT_WORKBENCH_NO_OPEN: '1',
    AGENT_WORKBENCH_NO_RESTORE: '1',
    SHELL: '/bin/bash',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  });
  return env;
}

function redact(value) {
  return String(value).replace(/([?&](?:token|auth|key)=)[^&\s]+/gi, '$1[redacted]');
}

test('staging release creates and restores a general Browser tab through the real UI', { timeout: 180000 }, async t => {
  if (!process.env.DISPLAY) {
    t.skip('Run under xvfb-run to exercise the native Electron window');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'maw-staging-release-'));
  const env = isolatedEnv(root);
  await Promise.all([
    mkdir(env.HOME, { recursive: true }), mkdir(env.CODEX_HOME, { recursive: true }),
    mkdir(env.XDG_CONFIG_HOME, { recursive: true }), mkdir(env.MAW_RUNTIME_DIR, { recursive: true }),
  ]);
  const serverLog = { value: '' };
  let server;
  let desktop;

  const startServer = async () => {
    serverLog.value = '';
    server = spawn(process.execPath, [path.join(repo, 'packages/server/dist/index.mjs'), '--prod'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => { serverLog.value = (serverLog.value + chunk).slice(-32768); });
    server.stderr.on('data', chunk => { serverLog.value = (serverLog.value + chunk).slice(-32768); });
    const readyFile = path.join(env.MAW_RUNTIME_DIR, 'maw-ready.json');
    return eventually(async () => {
      if (server.exitCode !== null) throw new Error(`Built server exited: ${redact(serverLog.value)}`);
      try {
        const ready = JSON.parse(await readFile(readyFile, 'utf8'));
        return typeof ready.url === 'string' && ready.url.startsWith('http://127.0.0.1:') ? ready : null;
      } catch { return null; }
    }, 'built server readiness');
  };

  const stopServer = async () => {
    const child = server;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      pause(8000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
    ]);
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    server = null;
  };

  try {
    const ready = await startServer();
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [here, '--ozone-platform=x11'],
      env: { ...env, MAW_DESKTOP_URL: ready.url },
    });
    const page = await desktop.firstWindow();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(redact(error.message)));

    // The public fixture hostname is intercepted inside the isolated Other partition.
    await desktop.evaluate(({ session }) => {
      session.fromPartition('persist:maw-browser').protocol.handle('https', request => {
        const url = new URL(request.url);
        if (url.hostname !== 'docs.maw-audit.com') return new Response('fixture host only', { status: 404 });
        const page = url.pathname === '/two' ? 'two' : 'one';
        return new Response(`<!doctype html><title>Fixture ${page}</title><input id="draft" value="initial"><main id="page">Fixture ${page}</main>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      });
    });

    await page.getByRole('button', { name: /create first project/i }).click();
    const projectDialog = page.getByRole('dialog');
    await projectDialog.getByRole('textbox').fill('Staging Browser Project');
    await projectDialog.getByRole('button', { name: /create project/i }).click();
    await page.getByRole('button', { name: /new workspace/i }).first().click();
    const workspaceDialog = page.getByRole('dialog');
    await workspaceDialog.getByLabel(/workspace name/i).fill('Staging Browser Workspace');
    await workspaceDialog.getByRole('button', { name: /select existing folder/i }).click();
    const picker = page.getByRole('dialog', { name: /choose workspace directory/i });
    await picker.getByRole('button', { name: /use this directory/i }).click();
    await eventually(async () => await page.locator('.agency-workspace-nav-button').filter({ hasText: 'Staging Browser Workspace' }).count() === 1, 'workspace creation through the UI');

    await page.locator('.maw-pane-add-tab').first().click();
    await page.getByRole('menuitem', { name: /^browser$/i }).click();
    const browserDialog = page.getByRole('dialog');
    await browserDialog.getByLabel('Browser provider').selectOption('other');
    await browserDialog.locator('input:not([type="url"])').fill('Staging Browser');
    await browserDialog.locator('input[type="url"]').fill('https://docs.maw-audit.com/one');
    await browserDialog.locator('input[type="url"]').press('Enter');

    const browserState = () => desktop.evaluate(async ({ session, webContents }) => {
      const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:maw-browser'));
      return contents && { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), title: contents.getTitle(), back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(), draft: await contents.executeJavaScript('document.querySelector("#draft")?.value ?? null') };
    });
    await eventually(async () => (await browserState())?.url.endsWith('/one') && !(await browserState()).loading, 'Other native page load');

    const storeFile = path.join(env.XDG_CONFIG_HOME, 'agent-workbench', 'agency-web-tabs.json');
    const savedTabs = async () => JSON.parse(await readFile(storeFile, 'utf8')).tabs;
    await eventually(async () => (await savedTabs()).some(tab => tab.provider === 'other' && tab.url.endsWith('/one')), 'Browser metadata checkpoint');
    const created = (await savedTabs()).find(tab => tab.provider === 'other');
    assert.ok(created?.id, 'server assigned a durable Browser tab ID');

    const address = page.locator('.maw-browser-toolbar input');
    await address.fill('https://docs.maw-audit.com/two');
    await address.press('Enter');
    await eventually(async () => (await browserState())?.url.endsWith('/two') && !(await browserState()).loading, 'address-bar navigation');
    await eventually(async () => (await savedTabs()).find(tab => tab.id === created.id)?.url.endsWith('/two'), 'navigation URL persistence');
    await page.getByRole('button', { name: 'Back' }).click();
    await eventually(async () => (await browserState())?.url.endsWith('/one') && !(await browserState()).loading && (await browserState()).forward, 'native browser back action');
    await eventually(async () => (await savedTabs()).find(tab => tab.id === created.id)?.url.endsWith('/one'), 'back navigation persistence');

    await desktop.evaluate(async ({ session }) => session.fromPartition('persist:maw-browser').cookies.set({
      url: 'https://docs.maw-audit.com/', name: 'staging-fixture', value: 'isolated-cookie', expirationDate: Date.now() / 1000 + 3600,
    }));
    const nativeContents = await desktop.evaluate(({ session, webContents }) => webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:maw-browser'))?.id);
    await desktop.evaluate(({ session, webContents }) => {
      const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:maw-browser'));
      if (contents) return contents.executeJavaScript('document.querySelector("#draft").value = "unsaved fixture draft"');
    });
    await page.evaluate(() => {
      localStorage.setItem('maw-staging-local', 'preserve-local');
      sessionStorage.setItem('maw-staging-session', 'preserve-session');
    });
    const profileTabs = await savedTabs();
    assert.equal(profileTabs.find(tab => tab.id === created.id)?.provider, 'other');

    // Restart only the isolated backend process; the Electron app and its temp profile remain running.
    await stopServer();
    await desktop.evaluate(({ session, webContents }) => {
      const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:maw-browser'));
      if (contents) return contents.executeJavaScript("history.pushState({}, '', '/offline-checkpoint')");
    });
    await eventually(async () => (await browserState())?.url.endsWith('/offline-checkpoint'), 'native navigation while backend is offline');
    await pause(650);
    assert.equal((await savedTabs()).find(tab => tab.id === created.id)?.url, 'https://docs.maw-audit.com/one', 'offline checkpoint stays pending until the backend returns');
    const readyAgain = await startServer();
    assert.equal(new URL(readyAgain.url).hostname, '127.0.0.1', 'backend restart remains loopback-only');
    // The desktop bridge must move the shell to the new one-boot token URL itself.
    await eventually(async () => page.url() === readyAgain.url, 'automatic shell origin/token refresh');
    await page.waitForFunction(() => window.mawChatGpt && document.readyState === 'complete');
    assert.equal(await page.evaluate(() => localStorage.getItem('maw-staging-local')), 'preserve-local');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('maw-staging-session')), 'preserve-session');
    await eventually(async () => await page.locator('.agency-workspace-nav-button').filter({ hasText: 'Staging Browser Workspace' }).count() === 1, 'workspace reconnection');
    await page.locator('.agency-workspace-nav-button').filter({ hasText: 'Staging Browser Workspace' }).click();
    await eventually(async () => await page.locator(`#tab-${created.id}`).count() === 1, 'persisted Browser tab after backend restart');
    const recoveredBrowser = await browserState();
    assert.ok(recoveredBrowser?.url.endsWith('/offline-checkpoint'), `native page after backend recovery: ${recoveredBrowser?.url ?? 'missing'}`);
    const restored = await eventually(async () => (await savedTabs()).find(tab => tab.id === created.id && tab.url.endsWith('/offline-checkpoint')), 'durable offline navigation checkpoint');
    assert.equal(restored?.url, 'https://docs.maw-audit.com/offline-checkpoint');
    assert.equal(restored?.provider, 'other');
    assert.equal(await desktop.evaluate(async ({ session }) => (await session.fromPartition('persist:maw-browser').cookies.get({ name: 'staging-fixture' }))[0]?.value), 'isolated-cookie');
    assert.equal(await desktop.evaluate(({ session, webContents }) => webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:maw-browser'))?.id), nativeContents, 'backend restart preserves the native WebContents');
    assert.equal(await (await browserState()).draft, 'unsaved fixture draft', 'backend restart preserves unsaved page input');
    assert.deepEqual(pageErrors, []);
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    await stopServer().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
