import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FocusTracker } from '../../../src/features/panes/focus-tracker.js';

test('FocusTracker: window focus, visibility, and native view focus modeling', () => {
  const origDoc = globalThis.document;
  const origWin = globalThis.window;

  try {
    let hasFocusVal = true;
    let hiddenVal = false;
    let visibilityVal = 'visible';

    (globalThis as any).document = {
      hasFocus: () => hasFocusVal,
      get hidden() { return hiddenVal; },
      get visibilityState() { return visibilityVal as DocumentVisibilityState; },
    };

    let bridgeHandler: ((event: any) => void) | null = null;
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      mawChatGpt: {
        subscribe: (fn: any) => {
          bridgeHandler = fn;
          return () => { bridgeHandler = null; };
        },
      },
    };

    const tracker = new FocusTracker();

    // 1. Initial focused & visible state
    assert.equal(tracker.isWindowFocused(), true);
    assert.equal(tracker.isDocumentHidden(), false);

    // 2. Document hidden (e.g. minimized)
    hiddenVal = true;
    visibilityVal = 'hidden';
    assert.equal(tracker.isDocumentHidden(), true);
    assert.equal(tracker.isWindowFocused(), false);

    // 3. Restore visibility, but lose document.hasFocus (e.g. clicked outside MAW)
    hiddenVal = false;
    visibilityVal = 'visible';
    hasFocusVal = false;
    assert.equal(tracker.isWindowFocused(), false);

    // 4. Native view focus: user clicks inside ChatGPT child WebContentsView
    // document.hasFocus is false, but bridge emits focused
    assert.ok(bridgeHandler);
    (bridgeHandler as any)({ type: 'focused', id: 'tab-chatgpt-1' });
    assert.equal(tracker.isWindowFocused(), true, 'Native view focus counts as window focus');
    assert.equal(tracker.getNativeFocusedTabId(), 'tab-chatgpt-1');

    tracker.dispose();
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});

test('FocusTracker: isSessionActivelyViewed matrix', () => {
  const origDoc = globalThis.document;
  const origWin = globalThis.window;

  try {
    let hasFocusVal = true;
    let hiddenVal = false;

    (globalThis as any).document = {
      hasFocus: () => hasFocusVal,
      get hidden() { return hiddenVal; },
      get visibilityState() { return (hiddenVal ? 'hidden' : 'visible') as DocumentVisibilityState; },
    };
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const tracker = new FocusTracker();

    const session = { workspaceId: 'ws-1', tabId: 'tab-1' };

    // Case 1: Active workspace, active tab, window focused -> TRUE
    assert.equal(
      tracker.isSessionActivelyViewed(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: false,
        activeTabId: 'tab-1',
      }),
      true,
    );

    // Case 2: Different workspace -> FALSE
    assert.equal(
      tracker.isSessionActivelyViewed(session, {
        activeWorkspaceId: 'ws-2',
        showingDone: false,
        activeTabId: 'tab-1',
      }),
      false,
    );

    // Case 3: Same workspace, different tab -> FALSE
    assert.equal(
      tracker.isSessionActivelyViewed(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: false,
        activeTabId: 'tab-2',
      }),
      false,
    );

    // Case 4: Showing Done archive view -> FALSE
    assert.equal(
      tracker.isSessionActivelyViewed(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: true,
        activeTabId: 'tab-1',
      }),
      false,
    );

    // Case 5: Window blurred to another application -> FALSE
    hasFocusVal = false;
    assert.equal(
      tracker.isSessionActivelyViewed(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: false,
        activeTabId: 'tab-1',
      }),
      false,
    );

    // Case 6: Window minimized/hidden -> FALSE
    hasFocusVal = true;
    hiddenVal = true;
    assert.equal(
      tracker.isSessionActivelyViewed(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: false,
        activeTabId: 'tab-1',
      }),
      false,
    );

    tracker.dispose();
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});

test('FocusTracker: determineDeliveryChannel routing policy', () => {
  const origDoc = globalThis.document;
  const origWin = globalThis.window;

  try {
    let hasFocusVal = true;
    let hiddenVal = false;

    (globalThis as any).document = {
      hasFocus: () => hasFocusVal,
      get hidden() { return hiddenVal; },
      get visibilityState() { return (hiddenVal ? 'hidden' : 'visible') as DocumentVisibilityState; },
    };
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const tracker = new FocusTracker();
    const session = { workspaceId: 'ws-1', tabId: 'tab-1' };

    // 1. Actively viewed session -> 'suppress'
    assert.equal(
      tracker.determineDeliveryChannel(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: false,
        activeTabId: 'tab-1',
      }),
      'suppress',
    );

    // 2. Focused in MAW, but session is in another tab -> 'toast'
    assert.equal(
      tracker.determineDeliveryChannel(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: false,
        activeTabId: 'tab-2',
      }),
      'toast',
    );

    // 3. Focused in MAW, but session is in another workspace -> 'toast'
    assert.equal(
      tracker.determineDeliveryChannel(session, {
        activeWorkspaceId: 'ws-2',
        showingDone: false,
        activeTabId: 'tab-1',
      }),
      'toast',
    );

    // 4. MAW is blurred/unfocused (user in another OS app) -> 'os'
    hasFocusVal = false;
    assert.equal(
      tracker.determineDeliveryChannel(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: false,
        activeTabId: 'tab-1',
      }),
      'os',
    );

    // 5. MAW is minimized -> 'os'
    hasFocusVal = true;
    hiddenVal = true;
    assert.equal(
      tracker.determineDeliveryChannel(session, {
        activeWorkspaceId: 'ws-1',
        showingDone: false,
        activeTabId: 'tab-1',
      }),
      'os',
    );

    tracker.dispose();
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});
