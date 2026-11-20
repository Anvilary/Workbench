import assert from 'node:assert/strict';
import test from 'node:test';
import { editorDraftStore, isDraftDirty, shouldFlagReadPreviewConflict, EditorSession } from '../../../src/features/editor/editorDraftStore.ts';

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

function createMockConnection() {
  const messageListeners = new Set();
  const reopenListeners = new Set();
  const sentMessages = [];
  return {
    sentMessages,
    send: (msg) => {
      sentMessages.push(msg);
    },
    onMessage: (fn) => {
      messageListeners.add(fn);
      return () => messageListeners.delete(fn);
    },
    onReopen: (fn) => {
      reopenListeners.add(fn);
      return () => reopenListeners.delete(fn);
    },
    emitMessage: (msg) => {
      for (const fn of messageListeners) fn(msg);
    },
    emitReopen: () => {
      for (const fn of reopenListeners) fn();
    },
  };
}

test('P2 in-flight save: save succeeds while unmounted', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const detach = editorDraftStore.attachConnection(conn);

  const tabId = 'save-unmounted-success';
  editorDraftStore.setDraft(tabId, {
    edit: {
      opened: 'original text',
      baseHash: 'hash-orig',
      text: 'updated text to save',
      saving: true,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    pendingSaveRequestId: 'req-save-1',
    mode: 'raw',
    scrollTop: 10,
  });

  assert.equal(editorDraftStore.getPendingSave(tabId), 'req-save-1');
  assert.equal(editorDraftStore.isDirty(tabId), true);

  // While unmounted, files.saved arrives with outcome: 'saved'
  conn.emitMessage({
    type: 'files.saved',
    requestId: 'req-save-1',
    outcome: 'saved',
    preview: {
      path: 'test.txt',
      text: 'updated text to save',
      hash: 'hash-saved-1',
      editable: true,
      binary: false,
      truncated: false,
      size: 20,
    },
  });

  const resolvedDraft = editorDraftStore.getDraft(tabId);
  assert.ok(resolvedDraft);
  assert.equal(resolvedDraft.edit, null);
  assert.equal(resolvedDraft.pendingSaveRequestId, null);
  assert.equal(editorDraftStore.getPendingSave(tabId), null);
  assert.equal(resolvedDraft.content?.loaded?.preview?.text, 'updated text to save');
  assert.equal(editorDraftStore.isDirty(tabId), false);

  detach();
});

test('P2 in-flight save: conflict while unmounted preserves user text and conflict protection', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const detach = editorDraftStore.attachConnection(conn);

  const tabId = 'save-unmounted-conflict';
  const userText = 'user modifications';
  editorDraftStore.setDraft(tabId, {
    edit: {
      opened: 'base text',
      baseHash: 'hash-base',
      text: userText,
      saving: true,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    pendingSaveRequestId: 'req-conflict-1',
    mode: 'formatted',
    scrollTop: 0,
  });

  // While unmounted, files.saved arrives with outcome: 'conflict'
  conn.emitMessage({
    type: 'files.saved',
    requestId: 'req-conflict-1',
    outcome: 'conflict',
    preview: {
      path: 'test.txt',
      text: 'concurrent external edit',
      hash: 'hash-external',
      editable: true,
      binary: false,
      truncated: false,
      size: 24,
    },
  });

  const draftAfterConflict = editorDraftStore.getDraft(tabId);
  assert.ok(draftAfterConflict);
  assert.ok(draftAfterConflict.edit);
  assert.equal(draftAfterConflict.edit.saving, false);
  assert.equal(draftAfterConflict.edit.text, userText);
  assert.ok(draftAfterConflict.edit.conflict);
  assert.equal(draftAfterConflict.edit.conflict.next?.text, 'concurrent external edit');
  assert.equal(draftAfterConflict.pendingSaveRequestId, null);
  assert.equal(editorDraftStore.isDirty(tabId), true);

  detach();
});

test('P2 in-flight save: failed save while unmounted preserves user text and records failure', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const detach = editorDraftStore.attachConnection(conn);

  const tabId = 'save-unmounted-fail';
  const userText = 'unsaved important edits';
  editorDraftStore.setDraft(tabId, {
    edit: {
      opened: 'original',
      baseHash: 'hash-0',
      text: userText,
      saving: true,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    pendingSaveRequestId: 'req-fail-1',
    mode: 'formatted',
    scrollTop: 0,
  });

  // While unmounted, server responds with error
  conn.emitMessage({
    type: 'error',
    requestId: 'req-fail-1',
    text: 'Permission denied / disk write error',
  });

  const draftAfterFail = editorDraftStore.getDraft(tabId);
  assert.ok(draftAfterFail);
  assert.ok(draftAfterFail.edit);
  assert.equal(draftAfterFail.edit.saving, false);
  assert.equal(draftAfterFail.edit.text, userText);
  assert.ok(draftAfterFail.edit.failure);
  assert.equal(draftAfterFail.edit.failure.text, 'Permission denied / disk write error');
  assert.equal(draftAfterFail.pendingSaveRequestId, null);
  assert.equal(editorDraftStore.isDirty(tabId), true);

  detach();
});

test('P2 in-flight save: disconnect while saving resets saving flag without losing edited text', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const detach = editorDraftStore.attachConnection(conn);

  const tabId = 'save-disconnect';
  const userText = 'critical offline progress';
  editorDraftStore.setDraft(tabId, {
    edit: {
      opened: 'initial text',
      baseHash: 'hash-initial',
      text: userText,
      saving: true,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    pendingSaveRequestId: 'req-dc-1',
    mode: 'formatted',
    scrollTop: 15,
  });

  assert.equal(editorDraftStore.getDraft(tabId)?.edit?.saving, true);

  // Disconnect triggered
  editorDraftStore.handleDisconnect();

  const draftAfterDc = editorDraftStore.getDraft(tabId);
  assert.ok(draftAfterDc);
  assert.ok(draftAfterDc.edit);
  assert.equal(draftAfterDc.edit.saving, false);
  assert.equal(draftAfterDc.edit.text, userText);
  assert.equal(draftAfterDc.pendingSaveRequestId, null);
  assert.equal(editorDraftStore.isDirty(tabId), true);

  // Also verify onReopen triggers disconnect recovery
  editorDraftStore.setDraft(tabId, {
    ...draftAfterDc,
    edit: { ...draftAfterDc.edit, saving: true },
    pendingSaveRequestId: 'req-dc-2',
  });
  assert.equal(editorDraftStore.getDraft(tabId)?.edit?.saving, true);
  conn.emitReopen();
  assert.equal(editorDraftStore.getDraft(tabId)?.edit?.saving, false);
  assert.equal(editorDraftStore.getDraft(tabId)?.edit?.text, userText);

  detach();
});

test('regression 1: delayed files.preview while a save is pending never acknowledges, cancels, or conflicts the write', () => {
  editorDraftStore.clearAll();
  const tabId = 'delayed-preview-while-saving';
  const userText = 'user in-flight edits';
  const edit = {
    opened: 'disk base',
    baseHash: 'hash-disk-base',
    text: userText,
    saving: true,
    failure: null,
    conflict: null,
    pending: null,
    closing: false,
  };
  editorDraftStore.setDraft(tabId, {
    edit,
    pendingSaveRequestId: 'req-save-delayed-preview',
    mode: 'formatted',
    scrollTop: 0,
  });

  // Stale read preview from disk arriving while write is pending
  const staleReadPreview = {
    path: 'doc.txt',
    text: 'disk base',
    hash: 'hash-disk-other',
    editable: true,
    binary: false,
    truncated: false,
    size: 9,
  };

  // Must not flag conflict
  assert.equal(shouldFlagReadPreviewConflict(edit, staleReadPreview), false);
  // Reconcile must never acknowledge or settle a write on read preview
  const outcome = editorDraftStore.reconcilePendingSave(tabId, staleReadPreview);
  assert.equal(outcome.saved, false);

  // Even if read preview text matches user edit text, read preview must never acknowledge write
  const matchingReadPreview = { ...staleReadPreview, text: userText, hash: 'hash-disk-matching' };
  assert.equal(shouldFlagReadPreviewConflict(edit, matchingReadPreview), false);
  const outcomeMatching = editorDraftStore.reconcilePendingSave(tabId, matchingReadPreview);
  assert.equal(outcomeMatching.saved, false);

  // In-flight write must remain active and pending
  const draft = editorDraftStore.getDraft(tabId);
  assert.ok(draft);
  assert.equal(draft.pendingSaveRequestId, 'req-save-delayed-preview');
  assert.equal(draft.edit?.saving, true);
  assert.equal(draft.edit?.text, userText);
  assert.equal(draft.edit?.conflict, null);
  assert.equal(editorDraftStore.isDirty(tabId), true);
  editorDraftStore.clearAll();
});

test('regression 2: files.saved arriving after delayed preview correctly settles the pending write', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const detach = editorDraftStore.attachConnection(conn);

  const tabId = 'save-after-preview';
  const userText = 'content to be saved';
  const edit = {
    opened: 'original text',
    baseHash: 'hash-original',
    text: userText,
    saving: true,
    failure: null,
    conflict: null,
    pending: null,
    closing: false,
  };
  editorDraftStore.setDraft(tabId, {
    edit,
    pendingSaveRequestId: 'req-save-after-prev',
    mode: 'raw',
    scrollTop: 10,
  });

  // Delayed preview arrived first while save was pending
  const delayedPreview = {
    path: 'file.txt',
    text: 'original text',
    hash: 'hash-original',
    editable: true,
    binary: false,
    truncated: false,
    size: 13,
  };
  assert.equal(shouldFlagReadPreviewConflict(edit, delayedPreview), false);
  assert.equal(editorDraftStore.reconcilePendingSave(tabId, delayedPreview).saved, false);
  assert.equal(editorDraftStore.getPendingSave(tabId), 'req-save-after-prev');

  // Now files.saved arrives with matching requestId
  conn.emitMessage({
    type: 'files.saved',
    requestId: 'req-save-after-prev',
    outcome: 'saved',
    preview: {
      path: 'file.txt',
      text: userText,
      hash: 'hash-saved-new',
      editable: true,
      binary: false,
      truncated: false,
      size: userText.length,
    },
  });

  const settledDraft = editorDraftStore.getDraft(tabId);
  assert.ok(settledDraft);
  assert.equal(settledDraft.edit, null);
  assert.equal(settledDraft.pendingSaveRequestId, null);
  assert.equal(editorDraftStore.getPendingSave(tabId), null);
  assert.equal(settledDraft.content?.loaded?.preview?.hash, 'hash-saved-new');
  assert.equal(settledDraft.content?.loaded?.preview?.text, userText);
  assert.equal(editorDraftStore.isDirty(tabId), false);

  detach();
  editorDraftStore.clearAll();
});

test('regression 3: actual write conflict preserves unsaved user text and attaches external preview', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const detach = editorDraftStore.attachConnection(conn);

  const tabId = 'actual-write-conflict';
  const userText = 'user edits that clashed';
  editorDraftStore.setDraft(tabId, {
    edit: {
      opened: 'base text',
      baseHash: 'hash-base',
      text: userText,
      saving: true,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    pendingSaveRequestId: 'req-conflict-write',
    mode: 'formatted',
    scrollTop: 0,
  });

  // Server indicates write conflict outcome on save response
  conn.emitMessage({
    type: 'files.saved',
    requestId: 'req-conflict-write',
    outcome: 'conflict',
    preview: {
      path: 'file.txt',
      text: 'remote concurrent change on disk',
      hash: 'hash-remote-conflict',
      editable: true,
      binary: false,
      truncated: false,
      size: 32,
    },
  });

  const conflictDraft = editorDraftStore.getDraft(tabId);
  assert.ok(conflictDraft);
  assert.ok(conflictDraft.edit);
  assert.equal(conflictDraft.pendingSaveRequestId, null);
  assert.equal(conflictDraft.edit.saving, false);
  assert.equal(conflictDraft.edit.text, userText); // User's unsaved text preserved!
  assert.ok(conflictDraft.edit.conflict);
  assert.equal(conflictDraft.edit.conflict.next?.text, 'remote concurrent change on disk');
  assert.equal(conflictDraft.edit.conflict.next?.hash, 'hash-remote-conflict');
  assert.equal(editorDraftStore.isDirty(tabId), true);

  detach();
  editorDraftStore.clearAll();
});

test('regression 4: remount during an in-flight save preserves pending save and settles on matching files.saved', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const detach = editorDraftStore.attachConnection(conn);

  const tabId = 'remount-in-flight-save';
  const userText = 'text saving while unmounted';
  editorDraftStore.setDraft(tabId, {
    edit: {
      opened: 'old base',
      baseHash: 'hash-old',
      text: userText,
      saving: true,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    pendingSaveRequestId: 'req-remount-inflight',
    mode: 'raw',
    scrollTop: 24,
  });

  // Simulate component remount: initialDraft reads persisted draft with pending save
  const remountInitialDraft = editorDraftStore.getDraft(tabId);
  assert.ok(remountInitialDraft);
  assert.equal(remountInitialDraft.pendingSaveRequestId, 'req-remount-inflight');
  assert.equal(remountInitialDraft.edit?.saving, true);

  // During remount, delayed files.preview arrives
  const remountPreview = {
    path: 'doc.txt',
    text: userText,
    hash: 'hash-disk-preview',
    editable: true,
    binary: false,
    truncated: false,
    size: userText.length,
  };
  // Read preview must never acknowledge or settle write on remount
  assert.equal(shouldFlagReadPreviewConflict(remountInitialDraft.edit, remountPreview), false);
  assert.equal(editorDraftStore.reconcilePendingSave(tabId, remountPreview).saved, false);
  assert.equal(editorDraftStore.getPendingSave(tabId), 'req-remount-inflight');

  // Authoritative files.saved arrives after remount
  conn.emitMessage({
    type: 'files.saved',
    requestId: 'req-remount-inflight',
    outcome: 'saved',
    preview: {
      path: 'doc.txt',
      text: userText,
      hash: 'hash-authoritative-save',
      editable: true,
      binary: false,
      truncated: false,
      size: userText.length,
    },
  });

  const settledAfterRemount = editorDraftStore.getDraft(tabId);
  assert.ok(settledAfterRemount);
  assert.equal(settledAfterRemount.edit, null);
  assert.equal(settledAfterRemount.pendingSaveRequestId, null);
  assert.equal(settledAfterRemount.content?.loaded?.preview?.hash, 'hash-authoritative-save');
  assert.equal(editorDraftStore.isDirty(tabId), false);

  detach();
  editorDraftStore.clearAll();
});

test('regression 5: disconnect during an in-flight save clears pending save and resets saving flag while preserving user text', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const detach = editorDraftStore.attachConnection(conn);

  const tabId = 'disconnect-in-flight-save';
  const userText = 'critical unsaved draft before connection drop';
  editorDraftStore.setDraft(tabId, {
    edit: {
      opened: 'original',
      baseHash: 'hash-orig',
      text: userText,
      saving: true,
      failure: null,
      conflict: null,
      pending: null,
      closing: false,
    },
    pendingSaveRequestId: 'req-dc-inflight',
    mode: 'formatted',
    scrollTop: 80,
  });

  assert.equal(editorDraftStore.getDraft(tabId)?.edit?.saving, true);
  assert.equal(editorDraftStore.getPendingSave(tabId), 'req-dc-inflight');

  // Connection disconnect / reopen occurs
  conn.emitReopen();

  const draftAfterDisconnect = editorDraftStore.getDraft(tabId);
  assert.ok(draftAfterDisconnect);
  assert.ok(draftAfterDisconnect.edit);
  assert.equal(draftAfterDisconnect.edit.saving, false);
  assert.equal(draftAfterDisconnect.edit.text, userText); // User text strictly preserved
  assert.equal(draftAfterDisconnect.pendingSaveRequestId, null);
  assert.equal(editorDraftStore.getPendingSave(tabId), null);
  assert.equal(editorDraftStore.isDirty(tabId), true); // Remains dirty so user can retry

  detach();
  editorDraftStore.clearAll();
});

function createTestEditorSession(tab, workspaceId, conn) {
  const session = new EditorSession({
    tab,
    workspaceId,
    connection: conn,
  });
  const unbindMessage = conn.onMessage((msg) => session.handleMessage(msg));
  const unbindReopen = conn.onReopen(() => {
    session.handleDisconnect();
    session.readFile();
  });
  return {
    session,
    dispose: () => {
      unbindMessage();
      unbindReopen();
    },
  };
}

test('integration: Read A, write, successful save, read B, late response A, response B', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const tab = { id: 'tab-ab', title: 'test.ts', filePath: '/workspace/test.ts' };
  const { session, dispose } = createTestEditorSession(tab, 'ws-1', conn);

  // 1. Read A issued
  session.readFile('req-read-A');
  assert.equal(conn.sentMessages.length, 1);
  assert.deepEqual(conn.sentMessages[0], {
    type: 'files.read',
    requestId: 'req-read-A',
    terminalId: 'ws-1',
    path: '/workspace/test.ts',
  });
  assert.equal(session.getActiveReadRequestId(), 'req-read-A');

  // 2. Write issued
  session.setEdit({
    opened: 'initial content\n',
    baseHash: 'hash-orig',
    text: 'edited content\n',
    saving: false,
    failure: null,
    conflict: null,
    pending: null,
    closing: false,
  });
  session.save('req-write-1');
  assert.equal(conn.sentMessages.length, 2);
  assert.equal(conn.sentMessages[1].type, 'files.write');
  assert.equal(conn.sentMessages[1].requestId, 'req-write-1');
  assert.equal(conn.sentMessages[1].text, 'edited content\n');

  // 3. Successful save arrives
  conn.emitMessage({
    type: 'files.saved',
    outcome: 'saved',
    requestId: 'req-write-1',
    preview: {
      path: '/workspace/test.ts',
      text: 'edited content\n',
      hash: 'hash-saved',
      editable: true,
    },
  });
  assert.equal(session.getPendingSave(), null);
  assert.equal(session.getEdit(), null);
  assert.equal(session.getContent()?.loaded?.preview?.text, 'edited content\n');
  assert.equal(session.isDirty(), false);

  // 4. Read B issued
  session.readFile('req-read-B');
  assert.equal(session.getActiveReadRequestId(), 'req-read-B');

  // 5. Late response A arrives (must be rejected)
  conn.emitMessage({
    type: 'files.preview',
    terminalId: 'ws-1',
    requestId: 'req-read-A',
    preview: {
      path: '/workspace/test.ts',
      text: 'stale preview A\n',
      hash: 'hash-stale-A',
      editable: true,
    },
  });
  // Content MUST NOT be overwritten with stale A
  assert.equal(session.getContent()?.loaded?.preview?.text, 'edited content\n');
  assert.equal(session.getContent()?.loaded?.preview?.hash, 'hash-saved');

  // 6. Response B arrives (must be accepted)
  conn.emitMessage({
    type: 'files.preview',
    terminalId: 'ws-1',
    requestId: 'req-read-B',
    preview: {
      path: '/workspace/test.ts',
      text: 'fresh preview B\n',
      hash: 'hash-B',
      editable: true,
    },
  });
  assert.equal(session.getContent()?.loaded?.preview?.text, 'fresh preview B\n');
  assert.equal(session.getContent()?.loaded?.preview?.hash, 'hash-B');

  dispose();
  editorDraftStore.clearAll();
});

test('integration: a stale preview cannot overwrite saved content', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const tab = { id: 'tab-saved', title: 'file.ts', filePath: '/workspace/file.ts' };
  const { session, dispose } = createTestEditorSession(tab, 'ws-1', conn);

  session.readFile('req-read-stale');
  session.setEdit({
    opened: 'v1',
    baseHash: 'h1',
    text: 'v2 saved content',
    saving: false,
    failure: null,
    conflict: null,
    pending: null,
    closing: false,
  });
  session.save('req-write-v2');

  conn.emitMessage({
    type: 'files.saved',
    outcome: 'saved',
    requestId: 'req-write-v2',
    preview: {
      path: '/workspace/file.ts',
      text: 'v2 saved content',
      hash: 'h2',
      editable: true,
    },
  });
  assert.equal(session.getContent()?.loaded?.preview?.text, 'v2 saved content');

  // Correlated stale preview A arriving late
  conn.emitMessage({
    type: 'files.preview',
    terminalId: 'ws-1',
    requestId: 'req-read-stale',
    preview: {
      path: '/workspace/file.ts',
      text: 'stale old v1',
      hash: 'h1',
      editable: true,
    },
  });
  assert.equal(session.getContent()?.loaded?.preview?.text, 'v2 saved content');

  // Un-correlated preview arriving after save
  conn.emitMessage({
    type: 'files.preview',
    terminalId: 'ws-1',
    preview: {
      path: '/workspace/file.ts',
      text: 'uncorrelated disk content',
      hash: 'h-random',
      editable: true,
    },
  });
  assert.equal(session.getContent()?.loaded?.preview?.text, 'v2 saved content');

  dispose();
  editorDraftStore.clearAll();
});

test('integration: a current read detects a genuine external change', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const tab = { id: 'tab-ext', title: 'file.ts', filePath: '/workspace/file.ts' };
  const { session, dispose } = createTestEditorSession(tab, 'ws-1', conn);

  // User has active edit based on hash-v1
  session.setEdit({
    opened: 'original disk text\n',
    baseHash: 'hash-v1',
    text: 'user local draft\n',
    saving: false,
    failure: null,
    conflict: null,
    pending: null,
    closing: false,
  });
  assert.equal(session.isDirty(), true);

  // A current read is requested
  session.readFile('req-read-ext');

  // External change is received with matching requestId
  conn.emitMessage({
    type: 'files.preview',
    terminalId: 'ws-1',
    requestId: 'req-read-ext',
    preview: {
      path: '/workspace/file.ts',
      text: 'external process changed file\n',
      hash: 'hash-v2-external',
      editable: true,
    },
  });

  // External change is detected and flagged as conflict
  const edit = session.getEdit();
  assert.ok(edit);
  assert.equal(edit.text, 'user local draft\n'); // User edits strictly preserved
  assert.ok(edit.conflict);
  assert.equal(edit.conflict.next?.hash, 'hash-v2-external');
  assert.equal(edit.conflict.next?.text, 'external process changed file\n');
  assert.equal(session.isDirty(), true);

  dispose();
  editorDraftStore.clearAll();
});

test('integration: a delayed preview cannot settle an in-flight write', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const tab = { id: 'tab-inflight', title: 'file.ts', filePath: '/workspace/file.ts' };
  const { session, dispose } = createTestEditorSession(tab, 'ws-1', conn);

  session.readFile('req-read-prior');
  session.setEdit({
    opened: 'initial',
    baseHash: 'h-init',
    text: 'in-flight changes',
    saving: false,
    failure: null,
    conflict: null,
    pending: null,
    closing: false,
  });

  // Start save
  session.save('req-write-flying');
  assert.equal(session.getPendingSave(), 'req-write-flying');
  assert.equal(session.getEdit()?.saving, true);

  // Delayed preview arrives
  conn.emitMessage({
    type: 'files.preview',
    terminalId: 'ws-1',
    requestId: 'req-read-prior',
    preview: {
      path: '/workspace/file.ts',
      text: 'delayed preview text',
      hash: 'h-delayed',
      editable: true,
    },
  });

  // Preview must NOT settle or cancel the write
  assert.equal(session.getPendingSave(), 'req-write-flying');
  assert.equal(session.getEdit()?.saving, true);
  assert.equal(session.getEdit()?.text, 'in-flight changes');

  // Authoritative files.saved arrives
  conn.emitMessage({
    type: 'files.saved',
    outcome: 'saved',
    requestId: 'req-write-flying',
    preview: {
      path: '/workspace/file.ts',
      text: 'in-flight changes',
      hash: 'h-settled',
      editable: true,
    },
  });

  // Now the write settles
  assert.equal(session.getPendingSave(), null);
  assert.equal(session.getEdit(), null);
  assert.equal(session.getContent()?.loaded?.preview?.text, 'in-flight changes');

  dispose();
  editorDraftStore.clearAll();
});

test('integration: a real files.saved conflict preserves user edits', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const tab = { id: 'tab-conflict', title: 'file.ts', filePath: '/workspace/file.ts' };
  const { session, dispose } = createTestEditorSession(tab, 'ws-1', conn);

  const unsavedUserWork = 'critical unsaved modifications';
  session.setEdit({
    opened: 'base text',
    baseHash: 'h-base',
    text: unsavedUserWork,
    saving: false,
    failure: null,
    conflict: null,
    pending: null,
    closing: false,
  });

  session.save('req-write-race');
  assert.equal(session.getEdit()?.saving, true);

  // Server signals conflict
  conn.emitMessage({
    type: 'files.saved',
    outcome: 'conflict',
    requestId: 'req-write-race',
    preview: {
      path: '/workspace/file.ts',
      text: 'concurrent modification on remote',
      hash: 'h-concurrent',
      editable: true,
    },
  });

  const edit = session.getEdit();
  assert.ok(edit);
  assert.equal(edit.saving, false);
  assert.equal(edit.text, unsavedUserWork); // User work preserved!
  assert.ok(edit.conflict);
  assert.equal(edit.conflict.next?.hash, 'h-concurrent');
  assert.equal(session.isDirty(), true);

  dispose();
  editorDraftStore.clearAll();
});

test('integration: reconnection and remount retain correct state', () => {
  editorDraftStore.clearAll();
  const conn = createMockConnection();
  const tab = { id: 'tab-lifecycle', title: 'file.ts', filePath: '/workspace/file.ts' };

  // Mount 1
  const harness1 = createTestEditorSession(tab, 'ws-1', conn);
  harness1.session.setEdit({
    opened: 'orig',
    baseHash: 'h-orig',
    text: 'important user draft edit',
    saving: false,
    failure: null,
    conflict: null,
    pending: null,
    closing: false,
  });
  harness1.session.save('req-save-lifecycle');
  assert.equal(editorDraftStore.getPendingSave(tab.id), 'req-save-lifecycle');

  // Component unmounts
  harness1.dispose();

  // Component remounts (re-attaches to draftStore)
  const harness2 = createTestEditorSession(tab, 'ws-1', conn);
  assert.equal(harness2.session.getPendingSave(), 'req-save-lifecycle');
  assert.equal(harness2.session.getEdit()?.saving, true);
  assert.equal(harness2.session.getEdit()?.text, 'important user draft edit');

  // Connection drop / reopen occurs
  conn.emitReopen();

  // Reset saving flag, clear pending save, retain dirty draft
  assert.equal(harness2.session.getPendingSave(), null);
  assert.equal(harness2.session.getEdit()?.saving, false);
  assert.equal(harness2.session.getEdit()?.text, 'important user draft edit');
  assert.equal(harness2.session.isDirty(), true);

  // Connection should have sent a re-sync read request
  const readMsgs = conn.sentMessages.filter((m) => m.type === 'files.read');
  assert.ok(readMsgs.length >= 1);

  harness2.dispose();
  editorDraftStore.clearAll();
});
