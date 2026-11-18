import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { browserDownloadHandler } from '../../../browser-downloads.mjs';

test('rejected downloads never alter concurrent download registrations', () => {
  const contents = {};
  const activeDownloads = new Map();
  const handler = browserDownloadHandler({
    provider: 'github', views: new Map([['tab', { webContents: contents }]]), providers: new Map([['tab', 'github']]),
    popupOwners: new Map(), popups: new Set(), activeDownloads,
    allowedOrigin: value => value === 'https://github.com', allowedDestination: value => value === 'https://github.com/file',
    windowForContents: () => null, downloadsDirectory: () => '/tmp', autoSave: () => false, send: () => {}, ready: () => {},
  });
  const item = (origin = 'https://github.com', url = 'https://github.com/file') => Object.assign(new EventEmitter(), {
    getInitiatorOrigin: () => origin, getURL: () => url, getURLChain: () => [url], getFilename: () => 'file.txt', setSaveDialogOptions: () => {},
  });
  const event = { preventDefault() { this.denied = true; } };
  const a = item(), b = item();
  handler(event, a, contents); handler(event, b, contents);
  assert.equal(activeDownloads.get('tab'), 2);
  handler(event, item('https://attacker.com'), contents);
  assert.equal(event.denied, true);
  assert.equal(activeDownloads.get('tab'), 2);
  handler(event, item('https://github.com', 'https://attacker.com/file'), contents);
  assert.equal(activeDownloads.get('tab'), 2);
  a.emit('done', {}, 'cancelled');
  assert.equal(activeDownloads.get('tab'), 1);
  a.emit('done', {}, 'cancelled');
  assert.equal(activeDownloads.get('tab'), 1);
  b.emit('done', {}, 'interrupted');
  assert.equal(activeDownloads.has('tab'), false);
});
