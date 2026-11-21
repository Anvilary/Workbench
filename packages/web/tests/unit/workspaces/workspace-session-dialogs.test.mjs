import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { WorkspaceSessionDialogs } from '../../../src/features/workspaces/WorkspaceSessionDialogs.js';

globalThis.React = React;

test('WorkspaceSessionDialogs renders web page close confirmation correctly', () => {
  const closingWebTab = {
    id: 'tab-web-1',
    kind: 'web',
    web: {
      id: 'web-1',
      title: 'Documentation Portal - Internal',
      url: 'https://docs.example.com',
      provider: 'other',
    },
  };

  let confirmedTab = null;
  let dismissed = false;

  const html = renderToString(
    React.createElement(WorkspaceSessionDialogs, {
      closing: closingWebTab,
      fileDialog: null,
      configuringProfileOpen: false,
      inFlight: false,
      busy: false,
      online: true,
      filePathInput: '',
      profiles: [],
      unsavedTabIds: new Set(),
      onChangeFilePathInput: () => {},
      onDismiss: () => { dismissed = true; },
      onConfirmClose: (tab) => { confirmedTab = tab; },
      onConfirmOpenFile: () => {},
    })
  );

  // Dialog container and title
  assert.ok(html.includes('maw-session-dialog'), 'Session dialog id is present');
  assert.ok(html.includes('Close web page?'), 'Renders Close web page title');

  // Confirmation message and web page title
  assert.ok(html.includes('Are you sure you want to close this page?'), 'Renders confirmation question');
  assert.ok(html.includes('Documentation Portal - Internal'), 'Displays the specific web tab title');
  assert.ok(html.includes('maw-close-web-page-title'), 'Uses dedicated web title class');

  // Action button: Close Page (not Close Session)
  assert.ok(html.includes('Close Page'), 'Primary action button says Close Page');
  assert.ok(html.includes('Cancel'), 'Cancel button is present');
});
