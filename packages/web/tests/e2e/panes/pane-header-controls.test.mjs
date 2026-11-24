import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, frames, pane, order, drag } from '../../fixtures/pane-interactions-harness.mjs';

const layout = (page) => page.evaluate(() => window.fixture.state.layout);

test('exact browser pane action order: Expand/Collapse, Drag&Drop, URL, Settings, Close', async (t) => {
  const page = await setup(t, 'mode=web&shape=row');
  const actionButtons = pane(page, 1).locator('.maw-pane-actions > *');
  assert.equal(await actionButtons.count(), 5);

  const classes = await actionButtons.evaluateAll((nodes) =>
    nodes.map((n) => {
      if (n.classList.contains('maw-pane-expand-button')) return 'expand';
      if (n.classList.contains('maw-pane-grip')) return 'grip';
      if (n.classList.contains('maw-browser-toolbar-toggle')) return 'url';
      if (n.classList.contains('maw-pane-menu-toggle')) return 'settings';
      if (n.classList.contains('maw-pane-close-button')) return 'close';
      return 'unknown';
    }),
  );
  assert.deepEqual(classes, ['expand', 'grip', 'url', 'settings', 'close']);
});

test('exact terminal pane action order: Expand/Collapse, Drag&Drop, Settings, Close', async (t) => {
  const page = await setup(t, 'mode=terminal&shape=row');
  const actionButtons = pane(page, 1).locator('.maw-pane-actions > *');
  assert.equal(await actionButtons.count(), 4);

  const classes = await actionButtons.evaluateAll((nodes) =>
    nodes.map((n) => {
      if (n.classList.contains('maw-pane-expand-button')) return 'expand';
      if (n.classList.contains('maw-pane-grip')) return 'grip';
      if (n.classList.contains('maw-browser-toolbar-toggle')) return 'url';
      if (n.classList.contains('maw-pane-menu-toggle')) return 'settings';
      if (n.classList.contains('maw-pane-close-button')) return 'close';
      return 'unknown';
    }),
  );
  assert.deepEqual(classes, ['expand', 'grip', 'settings', 'close']);
});

test('expand and collapse button toggles maximize, updates labels, and preserves split layout', async (t) => {
  const page = await setup(t, 'mode=mixed&shape=row');
  const expandBtn = pane(page, 1).locator('.maw-pane-expand-button');

  // Initial state: split layout with 2 panes
  assert.equal(await page.locator('.maw-split-pane').count(), 2);
  assert.equal(await expandBtn.getAttribute('title'), 'Expand pane');
  assert.equal(await expandBtn.getAttribute('aria-label'), 'Expand pane');
  assert.equal(await expandBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(await expandBtn.isDisabled(), false);

  // Click expand
  await expandBtn.click();
  await frames(page);

  // Maximized state: only 1 pane visible in layout
  assert.equal(await page.locator('.maw-split-pane').count(), 1);
  const maximizedLayout = await layout(page);
  assert.equal(maximizedLayout.maximizedPaneId, 'pane-1');

  // Button in maximized state
  const collapseBtn = pane(page, 1).locator('.maw-pane-expand-button');
  assert.equal(await collapseBtn.getAttribute('title'), 'Collapse pane');
  assert.equal(await collapseBtn.getAttribute('aria-label'), 'Collapse pane');
  assert.equal(await collapseBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(await collapseBtn.isDisabled(), false);

  // Click collapse to restore
  await collapseBtn.click();
  await frames(page);

  // Restored state: both panes visible
  assert.equal(await page.locator('.maw-split-pane').count(), 2);
  const restoredLayout = await layout(page);
  assert.equal(restoredLayout.maximizedPaneId, null);
  assert.deepEqual(await order(page), ['pane-1', 'pane-2']);
});

test('preservation of divider ratios across expand and collapse', async (t) => {
  const page = await setup(t, 'mode=terminal&shape=row');
  // Drag divider to change split ratio
  const divider = await page.locator('.maw-split-divider').boundingBox();
  assert.ok(divider);
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 40);
  await page.mouse.down();
  await page.mouse.move(divider.x + 80, divider.y + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await frames(page);

  const initialRatio = (await layout(page)).tree.ratio;
  assert.ok(initialRatio > 0.5);

  // Expand pane 1
  await pane(page, 1).locator('.maw-pane-expand-button').click();
  await frames(page);
  assert.equal((await layout(page)).maximizedPaneId, 'pane-1');

  // Collapse pane 1
  await pane(page, 1).locator('.maw-pane-expand-button').click();
  await frames(page);

  // Verify tree ratio is preserved
  const restored = await layout(page);
  assert.equal(restored.maximizedPaneId, null);
  assert.equal(restored.tree.ratio, initialRatio);
});

test('single-pane workspace disables expand button but keeps it visible', async (t) => {
  const page = await setup(t, 'shape=single');
  assert.equal(await page.locator('.maw-split-pane').count(), 1);

  const expandBtn = pane(page, 1).locator('.maw-pane-expand-button');
  assert.equal(await expandBtn.count(), 1);
  assert.equal(await expandBtn.isVisible(), true);
  assert.equal(await expandBtn.isDisabled(), true);
  assert.equal(await expandBtn.getAttribute('title'), 'Expand pane');
  assert.equal(await expandBtn.getAttribute('aria-label'), 'Expand pane');
  assert.equal(await expandBtn.getAttribute('aria-pressed'), 'false');
});

test('drag and drop functionality preserved in position 2', async (t) => {
  const page = await setup(t, 'mode=terminal&shape=row');
  const grip = pane(page, 1).locator('.maw-pane-grip');
  assert.equal(await grip.isVisible(), true);
  assert.equal(await grip.isDisabled(), false);

  // Keyboard swap
  await grip.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /Swap with pane 2/ }).click();
  await frames(page);
  assert.deepEqual(await order(page), ['pane-2', 'pane-1']);

  // Drag disabled when pane is maximized
  await pane(page, 2).locator('.maw-pane-expand-button').click();
  await frames(page);
  assert.equal(await pane(page, 2).locator('.maw-pane-grip').isDisabled(), true);

  // Restores after collapse
  await pane(page, 2).locator('.maw-pane-expand-button').click();
  await frames(page);
  assert.equal(await pane(page, 2).locator('.maw-pane-grip').isDisabled(), false);
});

test('URL toolbar toggle operates in position 3 without affecting web tab state', async (t) => {
  const page = await setup(t, 'mode=web&shape=row');
  const urlToggle = pane(page, 1).locator('.maw-browser-toolbar-toggle');
  assert.equal(await urlToggle.isVisible(), true);
  assert.equal(await urlToggle.getAttribute('aria-expanded'), 'false');

  // Click URL toggle to open
  await urlToggle.click();
  await frames(page);
  assert.equal(await urlToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await urlToggle.evaluate((el) => el.classList.contains('active')), true);

  // Click again to close
  await urlToggle.click();
  await frames(page);
  assert.equal(await urlToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await urlToggle.evaluate((el) => el.classList.contains('active')), false);
});

test('simplified pane settings menu removes maximize, restore, and close', async (t) => {
  const page = await setup(t, 'mode=terminal&shape=row');
  const settingsBtn = pane(page, 1).locator('.maw-pane-menu-toggle');

  await settingsBtn.click();
  await frames(page);

  const menu = page.getByRole('menu');
  assert.equal(await menu.count(), 1);

  // Removed actions must NOT exist in the menu
  assert.equal(await menu.getByRole('menuitem', { name: 'Maximize pane', exact: true }).count(), 0);
  assert.equal(await menu.getByRole('menuitem', { name: 'Restore pane', exact: true }).count(), 0);
  assert.equal(await menu.getByRole('menuitem', { name: 'Close pane', exact: true }).count(), 0);

  // Preserved actions must exist
  assert.equal(await menu.getByRole('menuitem', { name: 'Split vertically', exact: true }).count(), 1);
  assert.equal(await menu.getByRole('menuitem', { name: 'Split horizontally', exact: true }).count(), 1);

  await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0);
});

test('dedicated close button triggers close confirmation dialog', async (t) => {
  const page = await setup(t, 'mode=terminal&shape=row');
  const closeBtn = pane(page, 1).locator('[data-pane-close]');
  assert.equal(await closeBtn.isVisible(), true);

  await closeBtn.click();
  await frames(page);

  // Confirmation dialog appears
  const dialog = page.getByRole('dialog', { name: 'Close pane?' });
  assert.equal(await dialog.count(), 1);

  // Dismiss confirmation
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('.maw-split-pane').count(), 2);
});

test('narrow pane header renders all actions without wrapping or overflowing', async (t) => {
  const page = await setup(t, 'mode=web&shape=row', { width: 560, height: 400 });
  const pane1Actions = pane(page, 1).locator('.maw-pane-actions');

  const bounds = await pane1Actions.boundingBox();
  assert.ok(bounds);
  assert.ok(bounds.width > 0);

  // Ensure all 5 buttons are visible and inside header
  const buttons = pane(page, 1).locator('.maw-pane-actions > *');
  assert.equal(await buttons.count(), 5);
  for (let i = 0; i < 5; i++) {
    const btn = buttons.nth(i);
    assert.equal(await btn.isVisible(), true);
    const box = await btn.boundingBox();
    assert.ok(box);
    assert.equal(box.width, 28);
    assert.equal(box.height, 28);
  }
});

test('keyboard accessibility: focus and toggle expand button', async (t) => {
  const page = await setup(t, 'mode=terminal&shape=row');
  const expandBtn = pane(page, 1).locator('.maw-pane-expand-button');

  await expandBtn.focus();
  assert.equal(await expandBtn.evaluate((el) => el === document.activeElement), true);

  // Press Enter to expand
  await page.keyboard.press('Enter');
  await frames(page);
  assert.equal(await page.locator('.maw-split-pane').count(), 1);

  // Re-focus expand/collapse button in maximized pane and press Enter to collapse
  const collapseBtn = pane(page, 1).locator('.maw-pane-expand-button');
  assert.equal(await collapseBtn.getAttribute('aria-pressed'), 'true');
  await collapseBtn.focus();
  await page.keyboard.press('Enter');
  await frames(page);
  assert.equal(await page.locator('.maw-split-pane').count(), 2);
  assert.equal(await expandBtn.getAttribute('aria-pressed'), 'false');
});
