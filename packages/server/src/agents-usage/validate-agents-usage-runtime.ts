/**
 * Runtime validation and browser acceptance test for Settings > Agents Usage.
 *
 * Exercises the actual MAW production server, live telemetry collectors,
 * real WebSocket connection, and web UI in headless Chromium via Playwright.
 * Captures screenshot evidence to the artifact directory.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { attachTerminalSocket } from '../terminal-socket.js';
import { TerminalRegistry } from '../terminal-registry.js';
import { createAgentRegistry } from '../agents/registry.js';
import { WorkspaceStore } from '../workspace-store.js';
import { SessionIndex } from '../session-index.js';
import { ArchivedSessions } from '../archived-sessions.js';
import { VaultCatalog } from '../vault/catalog.js';
import { WorktreeLinks } from '../worktrees/links.js';
import { WorktreeStore } from '../worktrees/store.js';
import { VaultService } from '../vault/service.js';
import { WorktreeService } from '../worktrees/service.js';
import { AppSettingsService } from '../app-settings-service.js';
import { SettingsStore } from '../settings-store.js';
import { NotesStore } from '../notes-store.js';
import { DraftStore } from '../draft-store.js';
import { ConversationHub } from '../conversation-hub.js';
import { RepoHub } from '../repo-hub.js';
import { MemoryHub } from '../memory-hub.js';
import { RemoteAccessService } from '../remote-access-service.js';
import { RemoteDevicesStore } from '../remote-devices-store.js';
import { AgencyWorkspaceStore } from '../agency/store.js';
import { AgencyProfileStore } from '../agency/agency-profile-store.js';
import { AgencySessionRuntime } from '../agency/agency-session-runtime.js';
import { SplitAgencySessionStore } from '../agency/agency-session-store.js';
import { WorkspaceMutex } from '../agency/workspace-lock.js';
import { AgentsUsageCollector } from './collector.js';

const CHROMIUM_BIN = '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const ARTIFACT_DIR = process.env.MAW_ARTIFACT_DIR || '/home/user/.local/share/agy-5-profile/home/.gemini/antigravity-cli/brain/f0773a47-1405-4e18-b2a1-20552c87aeee';
const TOKEN = 'maw-runtime-validation-token-2026';

async function run() {
  console.log('--- Starting MAW Agents Usage Runtime Validation ---');
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-val-runtime-'));
  const app = express();
  const webDist = path.resolve('../web/dist');

  // Serve static UI assets and index.html
  app.use(express.static(webDist, { index: false }));
  app.get(/.*/, (req, res) => {
    if (req.path.startsWith('/ws')) return;
    res.sendFile(path.join(webDist, 'index.html'));
  });

  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address() as any;
  const port = address.port;
  console.log(`MAW validation server listening on http://127.0.0.1:${port}`);

  // Setup MAW server services
  const settings = new SettingsStore(path.join(tempDir, 'settings.json'));
  await settings.load();
  const agents = createAgentRegistry([]);
  const store = new WorkspaceStore();
  await store.load();
  const archived = new ArchivedSessions();
  await archived.load();
  const worktreeStore = new WorktreeStore(path.join(tempDir, 'worktrees.json'));
  await worktreeStore.load();
  const worktreeLinks = new WorktreeLinks(worktreeStore);
  const catalog = new VaultCatalog();
  const index = new SessionIndex(agents, archived, catalog, worktreeLinks);
  const vault = new VaultService({ agents, index, archived, settings, catalog, platform: process.platform });
  const registry = new TerminalRegistry(
    agents,
    { file: process.execPath, args: ['-e', 'process.exit(0)'], name: 'synthetic-shell' },
    store,
    () => null,
    async () => null,
    () => path.join(tempDir, 'shell-integration'),
  );
  const worktrees = new WorktreeService({
    store: worktreeStore,
    registry,
    projectCwd: () => null,
    findSession: () => null,
    sessionsUnder: () => [],
    history: () => null,
  });
  const appSettings = new AppSettingsService({ settings, agents, shells: [], onShellChange: () => {} });
  const notes = new NotesStore(path.join(tempDir, 'notes.json'));
  await notes.load();
  const drafts = new DraftStore({ statePath: path.join(tempDir, 'drafts.json') });
  await drafts.load();
  const remote = new RemoteAccessService({
    settings,
    store: new RemoteDevicesStore(path.join(tempDir, 'devices.json')),
    listening: { port, fixed: false, fixedPortBusy: false },
  });
  await remote.load();
  const agencyWorkspaceStore = new AgencyWorkspaceStore(path.join(tempDir, 'agency-state.json'));
  await agencyWorkspaceStore.load();
  const agencyProfileStore = new AgencyProfileStore(path.join(tempDir, 'agency-profiles.json'));
  await agencyProfileStore.listDefinitions();
  const agencyRuntime = new AgencySessionRuntime({
    registry,
    workspaces: { protectedDirectories: () => [], withSessionReservation: (_id, action) => action(null) },
    profiles: { resolveLaunch: async () => ({}) as any },
    store: new SplitAgencySessionStore(path.join(tempDir, 'agency-sessions.json')),
  });
  await agencyRuntime.initialize();

  // Live real collectors across user's actual profile configurations!
  const realCollector = new AgentsUsageCollector({ cacheTtlMs: 2000 });

  const detachSocket = attachTerminalSocket({
    httpServer,
    port,
    token: TOKEN,
    appSettings,
    registry,
    index,
    archived,
    notes,
    drafts,
    conversations: new ConversationHub(registry, agents),
    repos: new RepoHub(registry),
    memory: new MemoryHub(registry),
    agents,
    defaultCwd: tempDir,
    vault,
    remote,
    worktrees,
    noAuth: true,
    agencyWorkspaceStore,
    agencyProfileStore,
    agencyRuntime,
    workspaceLock: new WorkspaceMutex(),
    agentsUsageCollector: realCollector,
  });

  // Launch Playwright
  console.log('Launching headless Chromium...');
  const browser = await chromium.launch({
    executablePath: CHROMIUM_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  try {
    const targetUrl = `http://127.0.0.1:${port}/?token=${TOKEN}&view=workbench`;
    console.log(`Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    // Open Settings Dialog (header gear button)
    console.log('Opening Settings Dialog in Workbench...');
    const gear = page.locator('button.icon-button').filter({ hasText: '⚙' }).first();
    await gear.waitFor({ state: 'visible', timeout: 5000 });
    await gear.click();

    // Wait for modal settings dialog
    const dialog = page.locator('.settings-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Settings Dialog opened successfully.');

    // Verify tabs: General vs Agents Usage
    const tabBar = page.locator('.settings-tab-bar');
    await tabBar.waitFor({ state: 'visible', timeout: 2000 });
    const usageTabBtn = tabBar.locator('.settings-tab-btn:has-text("Agents Usage")');
    assert.equal(await usageTabBtn.count(), 1, 'Must have Agents Usage tab button');

    // Click on "Agents Usage" tab
    console.log('Navigating to Agents Usage tab...');
    await usageTabBtn.click();

    // Verify Agents Usage View is visible and container expanded to wide dialog
    const usageView = page.locator('.agents-usage-view');
    await usageView.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok(await dialog.evaluate((el) => el.classList.contains('settings-dialog-wide')));

    // Wait for telemetry snapshot to populate
    console.log('Waiting for live agents usage telemetry...');
    const summaryCards = usageView.locator('.agents-usage-summary-card');
    await summaryCards.first().waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await summaryCards.count(), 4, 'Must display 4 aggregated summary cards');

    // Verify 12 profiles monitored
    const profilesMonitoredVal = await summaryCards.nth(0).locator('.summary-value').textContent();
    console.log('Profiles monitored metric:', profilesMonitoredVal?.trim());
    assert.ok(profilesMonitoredVal?.includes('12'), 'Must monitor 12 profiles');

    // Verify Provider Overview section
    const providerCards = usageView.locator('.provider-card');
    assert.equal(await providerCards.count(), 3, 'Must display 3 provider overview cards (OpenAI, Google, Anthropic)');

    // Verify Profile Cards list
    const profileCards = usageView.locator('.profile-usage-card');
    const profileCount = await profileCards.count();
    console.log(`Found ${profileCount} individual profile cards rendered.`);
    assert.equal(profileCount, 12, 'Must render all 12 monitored profile cards');

    // Verify individual profile identities
    const renderedIds = await profileCards.locator('.profile-id').allTextContents();
    console.log('Rendered profile IDs:', renderedIds);
    assert.ok(renderedIds.includes('codex-0'));
    assert.ok(renderedIds.includes('codex-1'));
    assert.ok(renderedIds.includes('codex-2'));
    assert.ok(renderedIds.includes('agy-0'));
    assert.ok(renderedIds.includes('agy-7'));
    assert.ok(renderedIds.includes('claude-code'));

    // Test Provider Filter tab: click "OpenAI"
    console.log('Testing provider filter: OpenAI...');
    const openAiTab = page.locator('.filter-tab:has-text("OpenAI")');
    await openAiTab.click();
    const openAiCount = await page.locator('.profile-usage-card').count();
    assert.equal(openAiCount, 3, 'OpenAI filter must show exactly 3 profiles');

    // Test Search input: type "Sonnet"
    console.log('Testing search filter: "Sonnet"...');
    await page.locator('.filter-tab:has-text("All Profiles")').click();
    const searchInput = page.locator('.filter-search-input');
    await searchInput.fill('Sonnet');
    const searchCount = await page.locator('.profile-usage-card').count();
    assert.equal(searchCount, 1, 'Search for "Sonnet" must show 1 profile (agy-7)');
    const sonnetCardId = await page.locator('.profile-usage-card .profile-id').textContent();
    assert.equal(sonnetCardId, 'agy-7');

    // Clear search to show full list again
    await page.locator('.filter-search-clear').click();
    assert.equal(await page.locator('.profile-usage-card').count(), 12);

    // Capture screenshot evidence to artifact directory
    const screenshotPath = path.join(ARTIFACT_DIR, 'agents-usage-settings.png');
    console.log(`Capturing screenshot to ${screenshotPath}...`);
    await dialog.screenshot({ path: screenshotPath });
    console.log('Screenshot captured successfully!');

    // Test Agency Mode
    const agencyUrl = `http://127.0.0.1:${port}/?token=${TOKEN}`;
    console.log(`Navigating to Agency view: ${agencyUrl}...`);
    await page.goto(agencyUrl, { waitUntil: 'networkidle' });

    // Open workspace menu
    console.log('Opening workspace menu in Agency view...');
    const menuBtn = page.locator('.maw-menu-button');
    await menuBtn.waitFor({ state: 'visible', timeout: 5000 });
    await menuBtn.click();

    // Click "Agents Usage" menu item
    const usageMenuItem = page.locator('.agency-dropdown-item:has-text("Agents Usage")');
    await usageMenuItem.waitFor({ state: 'visible', timeout: 3000 });
    await usageMenuItem.click();

    // Verify modal dialog opened
    const agencyModal = page.locator('.modal.settings-dialog');
    await agencyModal.waitFor({ state: 'visible', timeout: 5000 });
    const agencyScreenshotPath = path.join(ARTIFACT_DIR, 'agents-usage-agency.png');
    console.log(`Capturing Agency screenshot to ${agencyScreenshotPath}...`);
    await agencyModal.screenshot({ path: agencyScreenshotPath });
    console.log('Agency screenshot captured successfully!');

    console.log('--- All Agents Usage Runtime Checks PASSED! ---');
  } finally {
    await browser.close();
    await detachSocket();
    await new Promise((resolve) => httpServer.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
