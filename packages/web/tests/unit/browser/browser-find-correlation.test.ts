import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFindCorrelationController, type FindCorrelationState } from '../../../src/features/browser/find-correlation.js';

test('BrowserFindCorrelation: Search A vs Search B race condition', async () => {
  const commands: any[] = [];
  let currentState: FindCorrelationState = { matchCount: 0, activeOrdinal: 0, counterText: '' };

  const controller = createFindCorrelationController({
    tabId: 'tab-1',
    debounceMs: 50,
    dispatchCommand: async (cmd) => {
      commands.push(cmd);
      return { ok: true, requestId: commands.length };
    },
    onStateChange: (state) => {
      currentState = state;
    },
  });

  // 1. Search A starts
  controller.setQuery('apple');
  await new Promise((r) => setTimeout(r, 60)); // Wait for debounce

  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'find-in-page');
  assert.equal(commands[0].text, 'apple');
  assert.equal(commands[0].searchId, 1);
  const searchASeq = commands[0].searchId;

  // 2. Search B starts before Search A returns
  controller.setQuery('banana');
  await new Promise((r) => setTimeout(r, 60)); // Wait for debounce

  assert.equal(commands.length, 2);
  assert.equal(commands[1].type, 'find-in-page');
  assert.equal(commands[1].text, 'banana');
  assert.equal(commands[1].searchId, 2);
  const searchBSeq = commands[1].searchId;

  // 3. Search A returns late
  const acceptedA = controller.handleEvent({
    type: 'found-in-page',
    id: 'tab-1',
    matches: 10,
    activeMatchOrdinal: 1,
    searchId: searchASeq,
    searchText: 'apple',
    requestId: 1,
  });

  assert.equal(acceptedA, false, 'Late Search A result must be rejected');
  assert.equal(currentState.matchCount, 0, 'UI match count must not be updated by Search A');
  assert.equal(currentState.counterText, '', 'UI counter text must remain empty');

  // 4. Search B returns afterward
  const acceptedB = controller.handleEvent({
    type: 'found-in-page',
    id: 'tab-1',
    matches: 3,
    activeMatchOrdinal: 1,
    searchId: searchBSeq,
    searchText: 'banana',
    requestId: 2,
  });

  assert.equal(acceptedB, true, 'Search B result must be accepted');
  assert.equal(currentState.matchCount, 3);
  assert.equal(currentState.activeOrdinal, 1);
  assert.equal(currentState.counterText, '1/3');

  controller.destroy();
});

test('BrowserFindCorrelation: Invalidation during debounce interval', async () => {
  const commands: any[] = [];
  let currentState: FindCorrelationState = { matchCount: 0, activeOrdinal: 0, counterText: '' };

  const controller = createFindCorrelationController({
    tabId: 'tab-1',
    debounceMs: 50,
    dispatchCommand: async (cmd) => {
      commands.push(cmd);
      return { ok: true, requestId: 1 };
    },
    onStateChange: (state) => {
      currentState = state;
    },
  });

  // Search 1 executed
  controller.setQuery('cat');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(commands.length, 1);

  // User alters query to 'cats' (debounce running)
  controller.setQuery('cats');
  assert.equal(currentState.matchCount, 0, 'Match count must immediately reset during typing');
  assert.equal(currentState.counterText, '', 'Counter text must be empty during debounce');

  // Old Search 1 arrives during debounce interval
  const accepted = controller.handleEvent({
    type: 'found-in-page',
    id: 'tab-1',
    matches: 5,
    activeMatchOrdinal: 1,
    searchId: 1,
    searchText: 'cat',
    requestId: 1,
  });

  assert.equal(accepted, false, 'Old search result during debounce interval must be rejected');
  assert.equal(currentState.matchCount, 0);
  assert.equal(currentState.counterText, '');

  controller.destroy();
});

test('BrowserFindCorrelation: Empty queries reset state and send stop command', async () => {
  const commands: any[] = [];
  let currentState: FindCorrelationState = { matchCount: 0, activeOrdinal: 0, counterText: '' };

  const controller = createFindCorrelationController({
    tabId: 'tab-1',
    debounceMs: 50,
    dispatchCommand: async (cmd) => {
      commands.push(cmd);
      return { ok: true };
    },
    onStateChange: (state) => {
      currentState = state;
    },
  });

  // Start with query
  controller.setQuery('hello');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(commands.length, 1);

  // Clear query
  controller.setQuery('   ');
  assert.equal(commands.length, 2);
  assert.equal(commands[1].type, 'stop-find-in-page');
  assert.equal(commands[1].action, 'clearSelection');
  assert.equal(currentState.matchCount, 0);
  assert.equal(currentState.counterText, '');

  // Subsequent event arriving for previous search is rejected
  const accepted = controller.handleEvent({
    type: 'found-in-page',
    id: 'tab-1',
    matches: 4,
    activeMatchOrdinal: 1,
    searchId: 1,
    searchText: 'hello',
  });
  assert.equal(accepted, false);

  controller.destroy();
});

test('BrowserFindCorrelation: Rapid query replacement debounces to final query only', async () => {
  const commands: any[] = [];
  const controller = createFindCorrelationController({
    tabId: 'tab-1',
    debounceMs: 50,
    dispatchCommand: async (cmd) => {
      commands.push(cmd);
      return { ok: true };
    },
    onStateChange: () => {},
  });

  controller.setQuery('a');
  await new Promise((r) => setTimeout(r, 10));
  controller.setQuery('ab');
  await new Promise((r) => setTimeout(r, 10));
  controller.setQuery('abc');
  await new Promise((r) => setTimeout(r, 10));
  controller.setQuery('abcd');

  await new Promise((r) => setTimeout(r, 70));

  // Only 1 search command should have been dispatched, for 'abcd'
  assert.equal(commands.length, 1);
  assert.equal(commands[0].text, 'abcd');

  controller.destroy();
});

test('BrowserFindCorrelation: Close and destroy clear selection and drop late events', async () => {
  const commands: any[] = [];
  const controller = createFindCorrelationController({
    tabId: 'tab-1',
    debounceMs: 50,
    dispatchCommand: async (cmd) => {
      commands.push(cmd);
      return { ok: true };
    },
    onStateChange: () => {},
  });

  controller.setQuery('target');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(commands.length, 1);

  controller.close();
  assert.equal(commands.length, 2);
  assert.equal(commands[1].type, 'stop-find-in-page');

  const accepted = controller.handleEvent({
    type: 'found-in-page',
    id: 'tab-1',
    matches: 2,
    activeMatchOrdinal: 1,
    searchId: 1,
    searchText: 'target',
  });
  assert.equal(accepted, false, 'Late event after close must be dropped');

  controller.destroy();
});

test('BrowserFindCorrelation: Navigation resets search state', async () => {
  let currentState: FindCorrelationState = { matchCount: 0, activeOrdinal: 0, counterText: '' };
  const controller = createFindCorrelationController({
    tabId: 'tab-1',
    debounceMs: 50,
    dispatchCommand: async () => ({ ok: true }),
    onStateChange: (state) => {
      currentState = state;
    },
  });

  controller.setQuery('target');
  await new Promise((r) => setTimeout(r, 60));

  controller.handleEvent({
    type: 'found-in-page',
    id: 'tab-1',
    matches: 3,
    activeMatchOrdinal: 1,
    searchId: 1,
    searchText: 'target',
  });
  assert.equal(currentState.matchCount, 3);

  // Navigation event received
  controller.handleEvent({
    type: 'navigation',
    id: 'tab-1',
    url: 'https://example.com/new-page',
  });

  assert.equal(currentState.matchCount, 0, 'Navigation must reset match count');
  assert.equal(currentState.counterText, '', 'Navigation must clear counter text');

  controller.destroy();
});

test('BrowserFindCorrelation: Tab isolation rejects events for other tabs', () => {
  const controller = createFindCorrelationController({
    tabId: 'tab-1',
    debounceMs: 50,
    dispatchCommand: async () => ({ ok: true }),
    onStateChange: () => {},
  });

  const accepted = controller.handleEvent({
    type: 'found-in-page',
    id: 'tab-2',
    matches: 5,
    activeMatchOrdinal: 1,
    searchId: 1,
    searchText: 'target',
  });

  assert.equal(accepted, false, 'Events for other tabs must be ignored');
  controller.destroy();
});

test('BrowserFindCorrelation: Delayed Electron command responses', async () => {
  let resolveCommand: (val: any) => void = () => {};
  const commandPromise = new Promise((resolve) => {
    resolveCommand = resolve;
  });

  let currentState: FindCorrelationState = { matchCount: 0, activeOrdinal: 0, counterText: '' };
  const controller = createFindCorrelationController({
    tabId: 'tab-1',
    debounceMs: 50,
    dispatchCommand: async () => commandPromise,
    onStateChange: (state) => {
      currentState = state;
    },
  });

  controller.setQuery('asyncSearch');
  await new Promise((r) => setTimeout(r, 60));

  // Electron webContents sends found-in-page event before command IPC invoke resolves
  const accepted = controller.handleEvent({
    type: 'found-in-page',
    id: 'tab-1',
    matches: 7,
    activeMatchOrdinal: 2,
    searchId: 1,
    searchText: 'asyncSearch',
    requestId: 42,
  });

  assert.equal(accepted, true, 'Event matching searchId must be accepted even before IPC promise resolves');
  assert.equal(currentState.matchCount, 7);
  assert.equal(currentState.activeOrdinal, 2);

  // Now resolve the command response
  resolveCommand({ ok: true, requestId: 42 });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(currentState.matchCount, 7);

  controller.destroy();
});
