import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, pane, frames } from '../../fixtures/pane-interactions-harness.mjs';

const layout = (page) => page.evaluate(() => window.fixture.state.layout);
const id = (n) => String(n).repeat(8) + '-' + String(n).repeat(4) + '-4' + String(n).repeat(3) + '-8' + String(n).repeat(3) + '-' + String(n).repeat(12);

test('cross-site link from ChatGPT opens in the SAME pane, selects the new tab, and preserves source tab', async (t) => {
  // Mode web starts with web tabs in both panes (Pane 1: web 1, Pane 2: web 2)
  const page = await setup(t, 'mode=web&shape=row');
  const sourceTabId = id(1);

  // Initial layout: pane-1 has 1 tab, pane-2 has 1 tab
  const initial = await layout(page);
  assert.equal(initial.tree.first.tabIds.length, 1);
  assert.equal(initial.tree.first.id, 'pane-1');
  assert.equal(initial.tree.second.id, 'pane-2');

  // Trigger internal link opening from ChatGPT in pane 1 to GitHub
  await page.evaluate(({ sourceTabId }) => {
    window.fixtureBridgeSend({
      type: 'open-web-tab',
      sourceTabId,
      url: 'https://github.com/openai/openai-python',
    });
  }, { sourceTabId });

  // Wait for the webTab.create request
  await page.waitForFunction(() =>
    window.fixture.requests.some(r => r.type === 'agency.webTab.create')
  );

  const req = await page.evaluate(() =>
    window.fixture.requests.find(r => r.type === 'agency.webTab.create')
  );

  assert.equal(req.targetPaneId, 'pane-1', 'New tab must target the originating tab pane');
  assert.equal(req.url, 'https://github.com/openai/openai-python');
  assert.equal(req.provider, 'github');
  assert.equal(req.select, true);

  // Wait for layout update in pane 1: now has 2 tabs
  await page.waitForFunction(() => window.fixture.state.layout.tree.first.tabIds.length === 2);
  const updatedLayout = await layout(page);
  const pane1TabIds = updatedLayout.tree.first.tabIds;
  assert.equal(pane1TabIds.length, 2, 'Pane 1 must now hold both original and new tab');
  assert.equal(pane1TabIds[0], sourceTabId, 'Original tab is preserved in pane 1');

  // The newly created tab is selected
  const newTabId = pane1TabIds[1];
  assert.equal(updatedLayout.tree.first.selectedTabId, newTabId, 'New tab becomes active in pane 1');

  // Pane 2 remains completely intact
  assert.equal(updatedLayout.tree.second.tabIds.length, 1);

  // Tab switching: click back to the original tab in Pane 1
  const tabsInPane1 = pane(page, 1).locator('[role=tab]');
  assert.equal(await tabsInPane1.count(), 2);
  await tabsInPane1.first().click();
  await frames(page);

  const switchedLayout = await layout(page);
  assert.equal(switchedLayout.tree.first.selectedTabId, sourceTabId, 'Clicking original tab switches back to it');
});

test('link opened from a tab in Pane 2 opens in Pane 2', async (t) => {
  const page = await setup(t, 'mode=web&shape=row');
  const sourceTabId = id(2);

  // Trigger link opening from tab in pane 2 to general documentation
  await page.evaluate(({ sourceTabId }) => {
    window.fixtureBridgeSend({
      type: 'open-web-tab',
      sourceTabId,
      url: 'https://docs.anthropic.com/en/docs',
    });
  }, { sourceTabId });

  await page.waitForFunction(() =>
    window.fixture.requests.some(r => r.type === 'agency.webTab.create')
  );

  const req = await page.evaluate(() =>
    window.fixture.requests.find(r => r.type === 'agency.webTab.create')
  );

  assert.equal(req.targetPaneId, 'pane-2', 'New tab must open in pane-2 when originating from tab in pane-2');
  assert.equal(req.provider, 'other', 'External docs link classified as other');
  assert.equal(req.select, true);

  await page.waitForFunction(() => window.fixture.state.layout.tree.second.tabIds.length === 2);
  const updatedLayout = await layout(page);
  assert.equal(updatedLayout.tree.second.tabIds.length, 2);
  assert.equal(updatedLayout.tree.first.tabIds.length, 1);
});

test('dangerous schemes are rejected and do not create tabs, while local web apps are accepted', async (t) => {
  const page = await setup(t, 'mode=web&shape=row');
  const sourceTabId = id(1);

  const countBefore = await page.evaluate(() =>
    window.fixture.requests.filter(r => r.type === 'agency.webTab.create').length
  );

  // Attempt dangerous schemes
  for (const dangerous of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html;base64,PHNjcmlwdD4=']) {
    await page.evaluate(({ sourceTabId, dangerous }) => {
      window.fixtureBridgeSend({
        type: 'open-web-tab',
        sourceTabId,
        url: dangerous,
      });
    }, { sourceTabId, dangerous });
  }

  await frames(page, 5);

  const countAfterDangerous = await page.evaluate(() =>
    window.fixture.requests.filter(r => r.type === 'agency.webTab.create').length
  );

  assert.equal(countAfterDangerous, countBefore, 'Dangerous schemes must be rejected without creating a tab');

  // Attempt local web app URL (should succeed)
  await page.evaluate(({ sourceTabId }) => {
    window.fixtureBridgeSend({
      type: 'open-web-tab',
      sourceTabId,
      url: 'http://localhost:3000/admin',
    });
  }, { sourceTabId });

  await page.waitForFunction(() =>
    window.fixture.requests.some(r => r.type === 'agency.webTab.create' && r.url === 'http://localhost:3000/admin')
  );

  const req = await page.evaluate(() =>
    window.fixture.requests.find(r => r.type === 'agency.webTab.create' && r.url === 'http://localhost:3000/admin')
  );
  assert.ok(req, 'Local web app link must create a web tab');
  assert.equal(req.provider, 'other');
});
