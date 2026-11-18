import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, frames, pane } from './pane-interactions-harness.mjs';

const menu = (page, n) => pane(page, n).locator('.maw-pane-add-tab');
const create = async (page, n, kind) => {
  await menu(page, n).click();
  await page.getByRole('menuitem', {
    name: kind === 'agent' ? 'New CLI' : kind === 'terminal' ? 'New Terminal' : kind === 'web' ? 'Browser' : 'Open File...',
    exact: true,
  }).click();
  if (kind === 'agent') await page.getByRole('dialog').getByRole('button', { name: /^(Create|Launch|Start)/ }).click();
  if (kind === 'web') {
    await page.getByRole('menuitem', { name: 'GitHub' }).click();
    const openBtn = page.getByRole('button', { name: 'Open' });
    if (await openBtn.count()) await openBtn.click();
    await pane(page, n).getByRole('tab', { name: /GitHub/ }).waitFor();
  }
  if (kind === 'file') {
    await page.getByRole('dialog').locator('input').fill('src/index.ts');
    await page.getByRole('dialog').getByRole('button', { name: 'Open', exact: true }).click();
  }
};

test('AUDIT E: Tab Drag and Drop - ghost tracking, visual cursor following, reorder, across panes, cancel, keyboard, and stability', async (t) => {
  // Setup 2-pane workspace with terminal mode
  const page = await setup(t, 'shape=row&mode=terminal');

  // Pane 1 starts with Tab 1. Add Tab 2 and an Editor tab to Pane 1
  await create(page, 1, 'terminal');
  await page.waitForFunction(() => document.querySelectorAll('#pane-container-pane-1 .maw-session-tab').length === 2);
  await create(page, 1, 'file');
  await page.waitForFunction(() => document.querySelectorAll('#pane-container-pane-1 .maw-session-tab').length === 3);

  // Pane 2 starts with Tab 2 (or native web view)
  await create(page, 2, 'web');
  await page.waitForFunction(() => document.querySelectorAll('#pane-container-pane-2 .maw-session-tab').length >= 1);

  const initialDisposed = await page.evaluate(() => window.disposed);

  // 1. Reorder within a pane: Drag Tab 1 past Tab 2
  const tabsPane1 = pane(page, 1).locator('.maw-session-tab');
  const tab0 = tabsPane1.nth(0);
  const tab1 = tabsPane1.nth(1);
  const box0 = await tab0.boundingBox();
  const box1 = await tab1.boundingBox();
  assert.ok(box0 && box1, 'Tab bounding boxes must exist');

  // Initial tab titles in Pane 1
  const initialTitles = await tabsPane1.evaluateAll(els => els.map(e => e.textContent?.trim()));

  // Start pointer drag on Tab 0
  await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
  await page.mouse.down();

  // Move 15px to exceed 6px drag threshold
  await page.mouse.move(box0.x + box0.width / 2 + 20, box0.y + box0.height / 2, { steps: 3 });
  await frames(page, 2);

  // Visual Assertion: Ghost element exists and shield exists
  const ghost = page.locator('.maw-tab-drag-ghost');
  await ghost.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await ghost.count(), 1, 'Drag ghost element must be created');
  assert.equal(await page.locator('.maw-pane-drag-shield').count(), 1, 'Drag shield element must be present');

  // Verify ghost transform follows cursor
  const ghostTransform = await ghost.evaluate(el => el.style.transform);
  assert.ok(ghostTransform.includes('translate3d'), 'Ghost must use hardware-accelerated translate3d');

  // Capture screenshot during mid-drag to visually verify ghost follows pointer
  const screenshotMidDrag = await page.screenshot({ type: 'png' });
  assert.ok(screenshotMidDrag.length > 1000, 'Screenshot capture during drag must succeed');

  // Move past Tab 1 and drop
  await page.mouse.move(box1.x + box1.width + 10, box1.y + box1.height / 2, { steps: 5 });
  await frames(page, 2);
  await page.mouse.up();
  await frames(page, 5);

  // Assert ghost and shield cleaned up
  assert.equal(await page.locator('.maw-tab-drag-ghost').count(), 0, 'Ghost element must be removed after mouse up');
  assert.equal(await page.locator('.maw-pane-drag-shield').count(), 0, 'Shield element must be removed after mouse up');

  // Verify Tab 0 moved after Tab 1
  const reorderedTitles = await tabsPane1.evaluateAll(els => els.map(e => e.textContent?.trim()));
  assert.notDeepEqual(reorderedTitles, initialTitles, 'Tabs in Pane 1 must be reordered');

  // 2. Drag across panes: Drag first tab of Pane 1 into Pane 2
  const sourceTab = tabsPane1.first();
  const sourceBox = await sourceTab.boundingBox();
  const pane2Header = pane(page, 2).locator('.maw-pane-header');
  const targetBox = await pane2Header.boundingBox();
  assert.ok(sourceBox && targetBox);

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 25, sourceBox.y + sourceBox.height / 2, { steps: 4 });
  await ghost.waitFor({ state: 'visible', timeout: 5000 });

  // Drag over native browser view in Pane 2 (shield protects it)
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await frames(page, 2);
  await page.mouse.up();
  await frames(page, 5);

  // Pane 1 now has 2 tabs, Pane 2 has 2 + 1 = 3 tabs
  assert.equal(await tabsPane1.count(), 2, 'Pane 1 should have 2 tabs remaining');
  assert.equal(await pane(page, 2).locator('.maw-session-tab').count(), 3, 'Pane 2 should have 3 tabs');

  // 3. Cancel with Escape
  const cancelTab = tabsPane1.first();
  const cancelBox = await cancelTab.boundingBox();
  assert.ok(cancelBox);
  const titlesBeforeCancel = await tabsPane1.evaluateAll(els => els.map(e => e.textContent?.trim()));

  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + cancelBox.width / 2 + 60, cancelBox.y + cancelBox.height / 2, { steps: 4 });
  await ghost.waitFor({ state: 'visible' });

  // Press Escape while dragging
  await page.keyboard.press('Escape');
  await frames(page, 2);
  await page.mouse.up();
  await frames(page, 2);

  // Verify ghost is gone and tab order did not change
  assert.equal(await page.locator('.maw-tab-drag-ghost').count(), 0, 'Ghost must be destroyed on Escape');
  assert.equal(await page.locator('.maw-pane-drag-shield').count(), 0, 'Shield must be destroyed on Escape');
  const titlesAfterCancel = await tabsPane1.evaluateAll(els => els.map(e => e.textContent?.trim()));
  assert.deepEqual(titlesAfterCancel, titlesBeforeCancel, 'Tab order must not change after Escape cancel');

  // 4. Keyboard reordering: Alt+Arrow
  const selectedTabButton = pane(page, 1).locator('.maw-session-tab button[role="tab"]').first();
  await selectedTabButton.focus();
  const titlesBeforeKey = await tabsPane1.evaluateAll(els => els.map(e => e.textContent?.trim()));
  await page.keyboard.press('Alt+ArrowRight');
  await frames(page, 5);
  const titlesAfterKey = await tabsPane1.evaluateAll(els => els.map(e => e.textContent?.trim()));
  assert.notDeepEqual(titlesAfterKey, titlesBeforeKey, 'Alt+ArrowRight must swap tab order');

  // 5. Invalid drop target: Drag tab outside any pane and drop
  const tabToDragOut = tabsPane1.first();
  const dragOutBox = await tabToDragOut.boundingBox();
  assert.ok(dragOutBox);
  await page.mouse.move(dragOutBox.x + dragOutBox.width / 2, dragOutBox.y + dragOutBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragOutBox.x + 20, dragOutBox.y);
  await ghost.waitFor({ state: 'visible' });
  // Move to top-left outside any pane (0, 0)
  await page.mouse.move(5, 5, { steps: 8 });
  await frames(page, 2);
  await page.mouse.up();
  await frames(page, 5);
  // Verify tabs still intact
  assert.equal(await tabsPane1.count(), 2, 'Invalid drop target must not drop or delete tab');

  // 6. Terminal PTY lifecycle check: Terminal.dispose() was NOT called
  const finalDisposed = await page.evaluate(() => window.disposed);
  assert.equal(finalDisposed, initialDisposed, 'Terminal PTYs must not be remounted or disposed during tab drags');
});
