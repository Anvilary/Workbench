// Built MAW release path: production server, packaged frontend and real Electron.
// Every mutable path is isolated under a disposable HOME and Electron profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { test } from 'node:test';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT, REPO_ROOT } from '../../helpers/paths.mjs';

const here = DESKTOP_ROOT;
const repo = REPO_ROOT;
const require = createRequire(import.meta.url);
const electronExecutable = process.env.WORKBENCH_ELECTRON_EXECUTABLE || (existsSync('/opt/workbench-electron/45.2.0/electron') ? '/opt/workbench-electron/45.2.0/electron' : require('electron'));
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
    if (/^(?:WORKBENCH_|MAW_|AGENT_WORKBENCH_)|(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'home', '.codex'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    WORKBENCH_RUNTIME_DIR: path.join(root, 'runtime'),
    WORKBENCH_PERSISTENT_PTY: '0',
    WORKBENCH_DESKTOP_DATA_DIR: path.join(root, 'electron-profile'),
    WORKBENCH_DESKTOP_PRODUCTION: '1',
    WORKBENCH_NO_OPEN: '1',
    WORKBENCH_NO_RESTORE: '1',
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
    mkdir(env.XDG_CONFIG_HOME, { recursive: true }), mkdir(env.WORKBENCH_RUNTIME_DIR, { recursive: true }),
  ]);
  const sourceMarker = path.join(env.HOME, 'user-source.txt');
  await writeFile(sourceMarker, 'source directory survives workspace and project removal');
  const serverLog = { value: '' };
  let server;
  let desktop;

  const startServer = async () => {
    serverLog.value = '';
    server = spawn(process.execPath, [path.join(repo, 'packages/server/dist/index.mjs'), '--prod'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => { serverLog.value = (serverLog.value + chunk).slice(-32768); });
    server.stderr.on('data', chunk => { serverLog.value = (serverLog.value + chunk).slice(-32768); });
    const readyFile = path.join(env.WORKBENCH_RUNTIME_DIR, 'workbench-ready.json');
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
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(timer); }
    server = null;
  };

  try {
    const ready = await startServer();
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [here, '--ozone-platform=x11'],
      env: { ...env, WORKBENCH_DESKTOP_URL: ready.url },
    });
    const page = await desktop.firstWindow();
    assert.deepEqual(await desktop.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
    })), { userData: env.WORKBENCH_DESKTOP_DATA_DIR, sessionData: env.WORKBENCH_DESKTOP_DATA_DIR });
    const screenshot = async (filename) => {
      const directory = process.env.WORKBENCH_TEST_ARTIFACTS_DIR;
      if (!directory) return;
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, filename) });
    };
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(redact(error.message)));

    // The public fixture hostname is intercepted inside the isolated Other partition.
    await desktop.evaluate(({ session }) => {
      session.fromPartition('persist:workbench-browser').protocol.handle('https', request => {
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
    await screenshot('electron-sidebar.png');

    await page.locator('.wb-pane-add-tab').first().click();
    await page.getByRole('menuitem', { name: /^Web Page$/i }).click();
    const browserDialog = page.getByRole('dialog');
    const destinationInput = browserDialog.locator('input.wb-browser-dest-input');
    await destinationInput.fill('https://docs.maw-audit.com/one');
    await screenshot('electron-browser-picker.png');
    await destinationInput.press('Enter');

    const browserState = () => desktop.evaluate(async ({ session, webContents }) => {
      const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:workbench-browser'));
      return contents && { id: contents.id, url: contents.getURL(), loading: contents.isLoading(), title: contents.getTitle(), back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(), draft: await contents.executeJavaScript('document.querySelector("#draft")?.value ?? null') };
    });
    await eventually(async () => (await browserState())?.url.endsWith('/one') && !(await browserState()).loading, 'Other native page load');

    const storeFile = path.join(env.XDG_CONFIG_HOME, 'workbench', 'agency-web-tabs.json');
    const savedTabs = async () => JSON.parse(await readFile(storeFile, 'utf8')).tabs;
    await eventually(async () => (await savedTabs()).some(tab => tab.provider === 'other' && tab.url.endsWith('/one')), 'Browser metadata checkpoint');
    const created = (await savedTabs()).find(tab => tab.provider === 'other');
    assert.ok(created?.id, 'server assigned a durable Browser tab ID');

    const address = page.locator('.wb-browser-toolbar input');
    await page.locator('.wb-browser-toolbar-toggle').click();
    await address.fill('https://docs.maw-audit.com/two');
    await address.press('Enter');
    await eventually(async () => (await browserState())?.url.endsWith('/two') && !(await browserState()).loading, 'address-bar navigation');
    await eventually(async () => (await savedTabs()).find(tab => tab.id === created.id)?.url.endsWith('/two'), 'navigation URL persistence');
    await page.getByRole('button', { name: 'Back' }).click();
    await eventually(async () => (await browserState())?.url.endsWith('/one') && !(await browserState()).loading && (await browserState()).forward, 'native browser back action');
    await eventually(async () => (await savedTabs()).find(tab => tab.id === created.id)?.url.endsWith('/one'), 'back navigation persistence');

    await desktop.evaluate(async ({ session }) => session.fromPartition('persist:workbench-browser').cookies.set({
      url: 'https://docs.maw-audit.com/', name: 'staging-fixture', value: 'isolated-cookie', expirationDate: Date.now() / 1000 + 3600,
    }));
    const nativeContents = await desktop.evaluate(({ session, webContents }) => webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:workbench-browser'))?.id);
    await desktop.evaluate(({ session, webContents }) => {
      const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:workbench-browser'));
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
      const contents = webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:workbench-browser'));
      if (contents) return contents.executeJavaScript("history.pushState({}, '', '/offline-checkpoint')");
    });
    await eventually(async () => (await browserState())?.url.endsWith('/offline-checkpoint'), 'native navigation while backend is offline');
    await pause(650);
    assert.equal((await savedTabs()).find(tab => tab.id === created.id)?.url, 'https://docs.maw-audit.com/one', 'offline checkpoint stays pending until the backend returns');
    const readyAgain = await startServer();
    assert.equal(new URL(readyAgain.url).hostname, '127.0.0.1', 'backend restart remains loopback-only');
    // The desktop bridge must move the shell to the new one-boot token URL itself.
    await eventually(async () => page.url() === readyAgain.url, 'automatic shell origin/token refresh');
    await page.waitForFunction(() => window.workbench && document.readyState === 'complete');
    await eventually(async () => await page.locator('.agency-workspace-nav-button').filter({ hasText: 'Staging Browser Workspace' }).count() === 1, 'workspace reconnection');
    assert.equal(await page.evaluate(() => localStorage.getItem('maw-staging-local')), 'preserve-local');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('maw-staging-session')), 'preserve-session');
    await page.locator('.agency-workspace-nav-button').filter({ hasText: 'Staging Browser Workspace' }).click();
    await eventually(async () => await page.locator(`#tab-${created.id}`).count() === 1, 'persisted Browser tab after backend restart');
    const recoveredBrowser = await browserState();
    assert.ok(recoveredBrowser?.url.endsWith('/offline-checkpoint'), `native page after backend recovery: ${recoveredBrowser?.url ?? 'missing'}`);
    const restored = await eventually(async () => (await savedTabs()).find(tab => tab.id === created.id && tab.url.endsWith('/offline-checkpoint')), 'durable offline navigation checkpoint');
    assert.equal(restored?.url, 'https://docs.maw-audit.com/offline-checkpoint');
    assert.equal(restored?.provider, 'other');
    assert.equal(await desktop.evaluate(async ({ session }) => (await session.fromPartition('persist:workbench-browser').cookies.get({ name: 'staging-fixture' }))[0]?.value), 'isolated-cookie');
    assert.equal(await desktop.evaluate(({ session, webContents }) => webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:workbench-browser'))?.id), nativeContents, 'backend restart preserves the native WebContents');
    assert.equal(await (await browserState()).draft, 'unsaved fixture draft', 'backend restart preserves unsaved page input');

    const openBrowserSettings = async () => {
      await page.locator('.wb-menu-button').click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await page.locator('#settings-tab-browser').click();
      return page.getByRole('dialog', { name: 'Settings' });
    };
    const settings = await openBrowserSettings();
    await settings.getByRole('button', { name: 'Delete Search Engine: DuckDuckGo', exact: true }).click();
    const googleRadio = settings.getByRole('radio', { name: /Google/ });
    await eventually(() => googleRadio.isChecked(), 'persisted search engine fallback');
    await settings.getByRole('button', { name: 'Restore built-in definitions', exact: true }).click();
    const ddgRadio = settings.getByRole('radio', { name: /DuckDuckGo/ });
    await ddgRadio.waitFor({ state: 'visible' });
    await ddgRadio.click();
    await eventually(() => ddgRadio.isChecked(), 'persisted search engine selection');
    await settings.getByRole('button', { name: 'Reset to defaults', exact: true }).click();
    assert.equal(await ddgRadio.isChecked(), true);

    const profilesCard = settings.locator('#setting-card-browser-profiles');
    await profilesCard.getByRole('button', { name: 'Browser Profiles', exact: true }).click();
    assert.equal(await profilesCard.getByRole('button', { name: 'Browser Profiles', exact: true }).getAttribute('aria-expanded'), 'false');
    await settings.getByRole('searchbox', { name: 'Search settings...' }).fill('Browser Profiles');
    await settings.getByRole('option').filter({
      has: page.locator('.wb-settings-search-item-title').filter({ hasText: /^Browser Profiles$/ }),
    }).click();
    await profilesCard.locator('.wb-subsection-toggle[aria-expanded="true"]').waitFor();

    const addProfile = async (name, mode) => {
      await settings.getByRole('button', { name: /add profile/i }).click();
      await settings.getByLabel('Profile Name', { exact: true }).fill(name);
      await settings.getByLabel('Initialization').selectOption(mode);
      await settings.getByRole('button', { name: 'Save', exact: true }).click();
      await settings.locator('.wb-settings-profile-form').waitFor({ state: 'detached' });
      return await settings.locator('[data-profile-id]').filter({ hasText: name }).getAttribute('data-profile-id');
    };
    const projectProfile = await addProfile('Project identity', 'clone');
    const overrideProfile = await addProfile('Workspace identity', 'empty');
    assert.ok(projectProfile && overrideProfile && projectProfile !== overrideProfile);
    await screenshot('electron-browser-settings.png');
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });

    const sessions = await desktop.evaluate(async ({ session }, ids) => {
      const names = ['persist:workbench-browser', ...ids.map(id => `persist:workbench-profile-${id}-browser`)];
      return await Promise.all(names.map(async (name, index) => {
        const current = session.fromPartition(name);
        if (index > 0) current.protocol.handle('https', () => new Response('<title>Profile fixture</title>', { headers: { 'content-type': 'text/html' } }));
        return { path: current.getStoragePath(), cookies: (await current.cookies.get({ name: 'staging-fixture' })).map(cookie => cookie.value) };
      }));
    }, [projectProfile, overrideProfile]);
    assert.equal(new Set(sessions.map(item => item.path)).size, 3);
    assert.deepEqual(sessions.map(item => item.cookies), [['isolated-cookie'], ['isolated-cookie'], []]);
    const activeSessionPath = () => desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.find(view => view.webContents)?.webContents.session.getStoragePath());
    async function assignProfile(target, id, expectedPath) {
      await page.getByRole('button', { name: target + ' actions', exact: true }).click();
      await page.getByLabel('Browser Profiles', { exact: true }).selectOption(id);
      await page.keyboard.press('Escape');
      await eventually(async () => await activeSessionPath() === expectedPath, target + ' browser partition');
    }
    await assignProfile('Project', projectProfile, sessions[1].path);
    await assignProfile('Workspace', overrideProfile, sessions[2].path);
    await assignProfile('Workspace', 'main', sessions[0].path);
    await assignProfile('Workspace', '', sessions[1].path);

    const profileSettings = await openBrowserSettings();
    const cloneRow = profileSettings.locator('[data-profile-id]').filter({ hasText: 'Project identity' });
    await cloneRow.getByRole('button', { name: 'Clear Site Auth', exact: true }).click();
    await cloneRow.getByRole('checkbox', { name: /other/i }).check();
    await cloneRow.getByRole('button', { name: 'Clear Selected', exact: true }).click();
    await cloneRow.locator('.wb-settings-profile-clear-panel').waitFor({ state: 'detached' });
    assert.deepEqual(await desktop.evaluate(async ({ session }, id) => {
      return (await session.fromPartition(`persist:workbench-profile-${id}-browser`).cookies.get({ name: 'staging-fixture' }))
        .map(cookie => cookie.value);
    }, projectProfile), []);
    const deleteProfileButton = profileSettings.getByRole('button', { name: 'Delete profile: Project identity', exact: true });
    const profileConfirmation = page.getByRole('dialog', { name: 'Delete profile' });
    await deleteProfileButton.click();
    await profileConfirmation.waitFor();
    await page.keyboard.press('Escape');
    await profileConfirmation.waitFor({ state: 'detached' });
    assert.equal(await cloneRow.count(), 1);
    await deleteProfileButton.click();
    await profileConfirmation.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await profileConfirmation.waitFor({ state: 'detached' });
    await profileSettings.locator('[data-profile-id]').filter({ hasText: 'Project identity' }).waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await profileSettings.waitFor({ state: 'detached' });
    await eventually(async () => await activeSessionPath() === sessions[0].path, 'Main fallback after deleting an assigned profile');
    assert.equal(await desktop.evaluate(async ({ session }) => (await session.fromPartition('persist:workbench-browser').cookies.get({ name: 'staging-fixture' }))[0]?.value), 'isolated-cookie');

    await page.locator('.wb-pane-menu-toggle').click();
    await page.getByRole('menuitem', { name: 'Split vertically', exact: true }).click();
    const extraPane = page.locator('.wb-split-pane').nth(1);
    await extraPane.locator('.wb-pane-add-tab').click();
    await page.getByRole('menuitem', { name: 'New Terminal', exact: true }).click();
    await extraPane.getByRole('tab').waitFor();
    const paneClose = extraPane.locator('[data-pane-close]');
    assert.equal(await paneClose.evaluate(button => button.previousElementSibling?.classList.contains('wb-pane-menu-toggle')), true);
    await paneClose.click();
    const paneConfirmation = page.getByRole('dialog', { name: 'Close pane?', exact: true });
    const targetBounds = await extraPane.locator('.wb-pane-body').boundingBox();
    const paneConfirmationBounds = await paneConfirmation.boundingBox();
    assert.ok(targetBounds && paneConfirmationBounds);
    assert.ok(Math.abs(targetBounds.x + targetBounds.width / 2 - paneConfirmationBounds.x - paneConfirmationBounds.width / 2) < 2);
    assert.ok(Math.abs(targetBounds.y + targetBounds.height / 2 - paneConfirmationBounds.y - paneConfirmationBounds.height / 2) < 2);
    await screenshot('electron-pane-confirmation.png');
    assert.equal(await page.getByRole('dialog').count(), 1);
    await paneConfirmation.getByRole('button', { name: 'Close pane', exact: true }).click();
    await extraPane.waitFor({ state: 'detached' });
    assert.equal(await page.locator(`#tab-${created.id}`).count(), 1);
    assert.equal(await page.getByRole('dialog').count(), 0);

    const originalProject = page.locator('[data-sidebar-project-id]').filter({
      has: page.locator('.agency-project-name', { hasText: 'Staging Browser Project' }),
    });
    const originalWorkspace = originalProject.locator('.agency-workspace-nav-row', { hasText: 'Staging Browser Workspace' });
    await originalProject.getByRole('button', { name: 'Project actions', exact: true }).click();
    await page.getByRole('menuitem', { name: /add workspace/i }).click();
    await page.getByRole('dialog').getByLabel(/workspace name/i).fill('Second Workspace');
    await page.getByRole('dialog').getByRole('button', { name: /select existing folder/i }).click();
    await page.getByRole('dialog', { name: /choose workspace directory/i }).getByRole('button', { name: /use this directory/i }).click();
    const secondWorkspace = originalProject.locator('.agency-workspace-nav-row', { hasText: 'Second Workspace' });
    await secondWorkspace.waitFor();
    await originalWorkspace.locator('.agency-workspace-nav-button').click();

    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const secondProjectDialog = page.getByRole('dialog');
    await secondProjectDialog.getByRole('textbox').fill('Second Project');
    await secondProjectDialog.getByRole('button', { name: 'Create project', exact: true }).click();
    const secondProject = page.locator('.agency-project-row', { hasText: 'Second Project' });
    await secondProject.waitFor();
    await secondProjectDialog.waitFor({ state: 'detached' });
    const sidebarGhost = page.locator('.agency-sidebar-drag-ghost');
    const dragSidebarRow = async (source, target, cancel = false) => {
      const from = await source.boundingBox();
      const to = await target.boundingBox();
      assert.ok(from && to);
      const x = from.x + 40;
      await page.mouse.move(x, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, to.y + 2, { steps: 12 });
      await sidebarGhost.waitFor();
      const sidebar = await page.locator('.agency-sidebar').boundingBox();
      const preview = await sidebarGhost.boundingBox();
      assert.ok(sidebar && preview && preview.x >= sidebar.x && preview.x + preview.width <= sidebar.x + sidebar.width);
      if (cancel) {
        await screenshot('electron-sidebar-drag.png');
        await page.keyboard.press('Escape');
      }
      await page.mouse.up();
      await sidebarGhost.waitFor({ state: 'detached' });
    };
    const dataFile = path.join(env.XDG_CONFIG_HOME, 'workbench', 'agency-state.json');
    const savedAgency = async () => JSON.parse(await readFile(dataFile, 'utf8'));
    const scroller = page.locator('.agency-side-section');
    await scroller.evaluate(element => { element.style.maxHeight = '145px'; element.scrollTop = 0; });
    const scrollerBounds = await scroller.boundingBox();
    const dragSourceBounds = await originalProject.locator('.agency-project-row').boundingBox();
    assert.ok(scrollerBounds && dragSourceBounds);
    const edgeX = dragSourceBounds.x + 40;
    await page.mouse.move(edgeX, dragSourceBounds.y + dragSourceBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(edgeX, scrollerBounds.y + scrollerBounds.height - 4, { steps: 8 });
    await sidebarGhost.waitFor();
    await page.waitForFunction(() => document.querySelector('.agency-side-section').scrollTop > 0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await sidebarGhost.waitFor({ state: 'detached' });
    await scroller.evaluate(element => { element.style.removeProperty('max-height'); element.scrollTop = 0; });
    await dragSidebarRow(secondProject, originalProject.locator('.agency-project-row'), true);
    assert.equal((await savedAgency()).projects[0].name, 'Staging Browser Project');
    await dragSidebarRow(secondProject, originalProject.locator('.agency-project-row'));
    await eventually(async () => (await savedAgency()).projects[0].name === 'Second Project', 'persisted project order');
    await dragSidebarRow(secondWorkspace, originalWorkspace);
    await eventually(async () => (await savedAgency()).workspaces[0].name === 'Second Workspace', 'persisted workspace order');
    assert.equal(await originalWorkspace.locator('.agency-workspace-nav-button').getAttribute('aria-current'), 'page');
    await secondWorkspace.getByRole('button', { name: 'Workspace actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete workspace', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete workspace', exact: true }).click();
    await secondWorkspace.waitFor({ state: 'detached' });

    await originalWorkspace.getByRole('button', { name: 'Workspace actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete workspace', exact: true }).click();
    const workspaceDeletion = page.getByRole('dialog');
    const sidebarBounds = await page.locator('.agency-sidebar').boundingBox();
    const deletionBounds = await workspaceDeletion.boundingBox();
    assert.ok(sidebarBounds && deletionBounds && deletionBounds.x >= sidebarBounds.x + sidebarBounds.width);
    await screenshot('electron-workspace-delete.png');
    await workspaceDeletion.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.locator('.agency-workspace-nav-button').filter({ hasText: 'Staging Browser Workspace' }).count(), 1);

    await originalProject.getByRole('button', { name: 'Project actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete project', exact: true }).click();
    const projectDeletion = page.getByRole('dialog');
    assert.match(await projectDeletion.innerText(), /all associated workspaces/);
    await screenshot('electron-project-cascade.png');
    await projectDeletion.getByRole('button', { name: 'Delete project', exact: true }).click();
    await projectDeletion.waitFor({ state: 'detached' });
    await eventually(async () => (await savedTabs()).find(tab => tab.id === created.id)?.closedAt, 'durable browser closure after project removal');
    assert.equal(await page.locator('.agency-workspace-nav-button').count(), 0);
    assert.deepEqual((await savedAgency()).projects.map(project => project.name), ['Second Project']);
    assert.equal(await readFile(sourceMarker, 'utf8'), 'source directory survives workspace and project removal');
    await eventually(async () => !(await browserState()), 'Electron destroys the workspace browser view');
    assert.deepEqual(pageErrors, []);
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    await stopServer().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
