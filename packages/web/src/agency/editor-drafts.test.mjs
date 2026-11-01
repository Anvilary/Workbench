import assert from 'node:assert/strict';
import test from 'node:test';
import { editorDraftStore, isDraftDirty } from './editorDraftStore.ts';

test('editorDraftStore tracks dirty state accurately based on edit changes, conflicts, and pending diffs', () => {
  editorDraftStore.clearAll();
  const tabId = 'test-tab-1';

  // 1. Initial clean draft
  editorDraftStore.setDraft(tabId, {
    edit: {
      opened: 'console.log("hello");\n',
      baseHash: 'hash-1',
      text: 'console.log("hello");\n',
      saving: false,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    mode: 'formatted',
    scrollTop: 0,
  });
  assert.equal(editorDraftStore.isDirty(tabId), false);
  assert.deepEqual(editorDraftStore.listDirtyTabIds(), []);

  // 2. Modifying text marks draft dirty
  editorDraftStore.updateEdit(tabId, (current) => ({
    ...current,
    text: 'console.log("hello world");\n',
  }));
  assert.equal(editorDraftStore.isDirty(tabId), true);
  assert.deepEqual(editorDraftStore.listDirtyTabIds(), [tabId]);

  // 3. External conflict marks draft dirty even if text is unchanged
  editorDraftStore.updateEdit(tabId, (current) => ({
    ...current,
    text: current.opened,
    conflict: { next: null },
  }));
  assert.equal(editorDraftStore.isDirty(tabId), true);

  // 4. Pending merge changes mark draft dirty
  editorDraftStore.updateEdit(tabId, (current) => ({
    ...current,
    conflict: null,
    pending: [{ kind: 'added', text: 'new line\n', newLine: 2 }],
  }));
  assert.equal(editorDraftStore.isDirty(tabId), true);

  // 5. Clean edit resets dirty state
  editorDraftStore.updateEdit(tabId, (current) => ({
    ...current,
    pending: null,
    text: current.opened,
  }));
  assert.equal(editorDraftStore.isDirty(tabId), false);
  assert.deepEqual(editorDraftStore.listDirtyTabIds(), []);
});

test('editorDraftStore preserves unsaved drafts across tab switching, pane movement, selection changes and unmounts', () => {
  editorDraftStore.clearAll();
  const tabIdA = 'editor-tab-A';
  const tabIdB = 'editor-tab-B';

  let subscriberNotified = 0;
  const unsubscribe = editorDraftStore.subscribe(() => {
    subscriberNotified++;
  });

  // User edits file in tab A in Pane 1
  editorDraftStore.setDraft(tabIdA, {
    edit: {
      opened: 'const x = 1;',
      baseHash: 'hash-a',
      text: 'const x = 1;\nconst y = 2; // unsaved draft',
      saving: false,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    mode: 'raw',
    scrollTop: 142,
    content: {
      loaded: {
        kind: 'file',
        preview: {
          path: 'src/x.ts',
          text: 'const x = 1;',
          hash: 'hash-a',
          editable: true,
          binary: false,
          truncated: false,
          size: 12,
        },
      },
      loading: false,
      failed: false,
    },
  });

  assert.equal(editorDraftStore.isDirty(tabIdA), true);
  assert.ok(subscriberNotified > 0);

  // SIMULATE TAB SWITCHING:
  // User selects Tab B (Terminal or another file). Tab A unmounts from React DOM.
  // The unmount of Tab A must NOT clear or discard the draft in editorDraftStore.
  const storedDraftAfterSwitch = editorDraftStore.getDraft(tabIdA);
  assert.ok(storedDraftAfterSwitch);
  assert.equal(storedDraftAfterSwitch.edit?.text, 'const x = 1;\nconst y = 2; // unsaved draft');
  assert.equal(storedDraftAfterSwitch.mode, 'raw');
  assert.equal(storedDraftAfterSwitch.scrollTop, 142);
  assert.equal(editorDraftStore.isDirty(tabIdA), true);

  // User switches back to Tab A:
  // Tab A remounts and rehydrates state from editorDraftStore.
  const rehydratedA = editorDraftStore.getDraft(tabIdA);
  assert.ok(rehydratedA);
  assert.equal(rehydratedA.edit?.text, 'const x = 1;\nconst y = 2; // unsaved draft');
  assert.equal(isDraftDirty(rehydratedA), true);

  // SIMULATE PANE MOVEMENT:
  // Tab A is dragged from Pane 1 into Pane 2.
  // It unmounts from Pane 1 and mounts inside Pane 2.
  // Verify draft remains intact during and after the move.
  const draftDuringPaneMove = editorDraftStore.getDraft(tabIdA);
  assert.ok(draftDuringPaneMove);
  assert.equal(draftDuringPaneMove.edit?.text, 'const x = 1;\nconst y = 2; // unsaved draft');

  // Remount in Pane 2
  const rehydratedInPane2 = editorDraftStore.getDraft(tabIdA);
  assert.ok(rehydratedInPane2);
  assert.equal(rehydratedInPane2.scrollTop, 142);
  assert.equal(rehydratedInPane2.mode, 'raw');
  assert.equal(editorDraftStore.isDirty(tabIdA), true);

  // SIMULATE SELECTION CHANGE & MULTI-PANE FOCUS:
  // User edits Tab B in Pane 1 while Tab A stays dirty in Pane 2.
  editorDraftStore.setDraft(tabIdB, {
    edit: {
      opened: 'line 1',
      baseHash: 'hash-b',
      text: 'line 1\nline 2 dirty',
      saving: false,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    mode: 'formatted',
    scrollTop: 50,
  });
  assert.deepEqual(editorDraftStore.listDirtyTabIds().sort(), [tabIdA, tabIdB].sort());

  // SIMULATE CLOSE CONFIRMATION & DISCARD:
  // Closing tab A discards its draft
  editorDraftStore.clearDraft(tabIdA);
  assert.equal(editorDraftStore.getDraft(tabIdA), undefined);
  assert.equal(editorDraftStore.isDirty(tabIdA), false);
  assert.deepEqual(editorDraftStore.listDirtyTabIds(), [tabIdB]);

  // Tab B saved successfully
  editorDraftStore.updateEdit(tabIdB, () => null);
  assert.equal(editorDraftStore.isDirty(tabIdB), false);
  assert.deepEqual(editorDraftStore.listDirtyTabIds(), []);

  unsubscribe();
});
