import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddedUrl, externalUrl, otherUrl, serviceUrl, trustedSender, validCommand, nativeBounds, isDownloadOrFileDeliveryUrl, githubUrl, githubEmbeddedUrl, perplexityUrl, perplexityEmbeddedUrl, isSameSite, targetWebProvider, authenticationUrl, decideWindowOpen, getBrowserZoomAction, validateFaviconUrl, selectBestFavicon, downloadOriginAllowed, downloadDestinationAllowed, isAllowedBlobDownloadUrl, isProviderFileDeliveryUrl } from '../../../policy.mjs';
const id = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';
test('getBrowserZoomAction: recognizes zoom shortcuts and rejects unrelated keys', () => {
  // Zoom in
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: '+', code: 'Equal', shift: true }), 'zoom-in');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: '=', code: 'Equal' }), 'zoom-in');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: 'Add', code: 'NumpadAdd' }), 'zoom-in');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: '+', code: 'NumpadAdd' }), 'zoom-in');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', meta: true, key: '=', code: 'Equal' }), 'zoom-in');

  // Zoom out
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: '-', code: 'Minus' }), 'zoom-out');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: '_', code: 'Minus', shift: true }), 'zoom-out');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: 'Subtract', code: 'NumpadSubtract' }), 'zoom-out');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: '-', code: 'NumpadSubtract' }), 'zoom-out');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', meta: true, key: '-', code: 'Minus' }), 'zoom-out');

  // Zoom reset
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: '0', code: 'Digit0' }), 'zoom-reset');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: '0', code: 'Numpad0' }), 'zoom-reset');
  assert.equal(getBrowserZoomAction({ type: 'keyDown', meta: true, key: '0', code: 'Digit0' }), 'zoom-reset');

  // Ignored / preserved shortcuts
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: 'l', code: 'KeyL' }), null);
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: 'w', code: 'KeyW' }), null);
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, key: 'Tab', code: 'Tab' }), null);
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: false, meta: false, key: '+', code: 'Equal' }), null);
  assert.equal(getBrowserZoomAction({ type: 'keyDown', control: true, alt: true, key: '0', code: 'Digit0' }), null);
  assert.equal(getBrowserZoomAction({ type: 'keyUp', control: true, key: '0', code: 'Digit0' }), null);
});

test('general web URLs support public websites and local applications while rejecting dangerous schemes', () => {
  assert.equal(validCommand({ type: 'restore-shell-storage' }), true);
  assert.equal(validCommand({ type: 'restore-shell-storage', origin: 'https://attacker.com' }), false);
  for (const url of [
    'https://www.wikipedia.org/wiki/Browser',
    'http://example.com:8080/',
    'https://github.com/',
    'http://127.0.0.1:3000/',
    'http://[::1]/',
    'http://localhost/',
    'http://host.local/',
    'https://host.home.arpa/',
    'https://host.internal/',
    'http://192.168.1.100:9000/',
    'http://10.0.0.5:8080/',
    'http://dev-box:3000/',
  ]) {
    assert.equal(otherUrl(url), true, url);
    assert.equal(validCommand({ type: 'open', id, url, provider: 'other' }), true, url);
  }
  for (const url of [
    'http://2130706433/',
    'http://localhost.:3000/',
    'http://router.local./',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://u:p@example.com/',
    'https://example.com/\n',
  ]) {
    assert.equal(otherUrl(url), false, url);
    assert.equal(validCommand({ type: 'open', id, url, provider: 'other' }), false, url);
  }
  // Workbench backend loopback port rejection
  assert.equal(otherUrl('http://127.0.0.1:52341/', 2048, { backendPort: 52341 }), false);
  assert.equal(otherUrl('http://localhost:52341/api', 2048, { backendPort: 52341 }), false);
});
test('exact HTTPS navigation and initial ChatGPT URL allowlist', () => {
  for (const url of ['https://chatgpt.com/', 'https://auth.openai.com/log-in', 'https://accounts.google.com/o/oauth2/auth', 'https://appleid.apple.com/auth/authorize']) assert.equal(embeddedUrl(url), true, url);
  for (const url of ['http://chatgpt.com/', 'https://chatgpt.com.evil.com', 'https://evil.com/?chatgpt.com', 'https://chatgpt.com:444/', 'https://user@chatgpt.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://chatgpt.com./', 'https://127.0.0.1/']) assert.equal(embeddedUrl(url), false, url);
  assert.equal(validCommand({ type: 'open', id, url: 'https://auth.openai.com/' }), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://chatgpt.com/', preload: 'anything' }), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://chatgpt.com/' }), true);
  assert.equal(githubUrl('https://github.com/user/My-Amazing-Workspace'), true);
  assert.equal(githubUrl('https://gist.github.com/example'), true);
  assert.equal(githubUrl('https://github.com.evil.com/'), false);
  assert.equal(githubUrl('https://chatgpt.com/'), false);
  assert.equal(githubEmbeddedUrl('https://objects.githubusercontent.com/a'), true);
  assert.equal(githubEmbeddedUrl('https://evil.githubusercontent.com.attacker/a'), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://github.com/', provider: 'github' }), true);
  assert.equal(validCommand({ type: 'open', id, url: 'https://github.com/', provider: 'chatgpt' }), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://chatgpt.com/', provider: 'github' }), false);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'reload' }), true);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'open-link', url: 'https://example.com/a' }), true);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'open-link', url: 'http://127.0.0.1:3000/' }), true);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'open-link', url: 'javascript:alert(1)' }), false);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'open-link-external', url: 'https://example.com/a' }), true);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'open-link-external', url: 'http://127.0.0.1:3000/' }), true);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'open-link-external', url: 'file:///etc/passwd' }), false);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'copy-link', url: 'https://example.com/a' }), true);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'copy-link', url: 'javascript:alert(1)' }), false);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'replace-misspelling', word: 'correct' }), true);
  assert.equal(validCommand({ type: 'browser-action', id, action: 'replace-misspelling', word: 'a'.repeat(300) }), false);
  assert.equal(validCommand({ type: 'find-in-page', id, text: 'hello' }), true);
  assert.equal(validCommand({ type: 'find-in-page', id, text: 'hello', forward: true, findNext: false, matchCase: true }), true);
  assert.equal(validCommand({ type: 'find-in-page', id, text: 'hello', invalidOption: true }), false);
  assert.equal(validCommand({ type: 'stop-find-in-page', id }), true);
  assert.equal(validCommand({ type: 'stop-find-in-page', id, action: 'clearSelection' }), true);
  assert.equal(validCommand({ type: 'stop-find-in-page', id, action: 'invalidAction' }), false);
  assert.equal(validCommand({ type: 'copy-file', cwd: '/work/demo', relative: 'src/app.ts' }), true);
  assert.equal(validCommand({ type: 'copy-file', cwd: '/work/demo', relative: '/etc/passwd' }), false);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: 'terminal text' }), true);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: '' }), true);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: 123 }), false);
  assert.equal(validCommand({ type: 'write-clipboard-text' }), false);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: 'a', extra: 'bad' }), false);
  assert.equal(validCommand({ type: 'read-clipboard-text' }), true);
  assert.equal(validCommand({ type: 'read-clipboard-text', extra: true }), false);
  assert.equal(validCommand({ type: 'open', id: [id], url: 'https://chatgpt.com/' }), false);
  assert.equal(embeddedUrl('https://chatgpt.com/\npath'), false);
});
test('external browser boundary rejects local hosts, credentials, ports and protocols', () => {
  assert.equal(externalUrl('https://help.openai.com/'), true);
  for (const url of ['https://localhost/', 'https://foo.local/', 'https://192.168.1.1/', 'https://[::1]/', 'https://2130706433/', 'https://host.internal/', 'https://user:pass@example.com/', 'mailto:a@b.com', 'http://public.com/', 'https://host.test/', 'https://public.com:9000/']) assert.equal(externalUrl(url), false, url);
});
test('only one configured loopback origin and its main frame can send IPC', () => {
  assert.equal(serviceUrl('http://127.0.0.1:3000/?token=example').origin, 'http://127.0.0.1:3000');
  for (const url of ['https://remote.com/', 'http://localhost:3000/', 'http://127.0.0.1:3000/other', 'http://u:p@127.0.0.1:3000/', 'http://127.0.0.1/']) assert.throws(() => serviceUrl(url));
  const contents = { mainFrame: { url: 'http://127.0.0.1:3000/' } };
  assert.equal(trustedSender({ sender: contents, senderFrame: contents.mainFrame }, contents, 'http://127.0.0.1:3000'), true);
  for (const event of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: { url: contents.mainFrame.url } }]) assert.equal(trustedSender(event, contents, 'http://127.0.0.1:3000'), false);
  contents.mainFrame.url = 'https://chatgpt.com/';
  assert.equal(trustedSender({ sender: contents, senderFrame: contents.mainFrame }, contents, 'http://127.0.0.1:3000'), false);
});
test('bounds fail closed for invalid payloads, stale viewport, clipping and zoom', () => {
  const command = { type: 'layout', id, bounds: { x: 200, y: 80, width: 800, height: 620 }, viewport: { width: 1000, height: 700 } };
  assert.equal(validCommand(command), true);
  assert.deepEqual(nativeBounds(command, [1250, 875], 1.25), { x: 250, y: 100, width: 1000, height: 775 });
  assert.equal(nativeBounds(command, [900, 700], 1), null);
  assert.equal(nativeBounds({ ...command, bounds: { ...command.bounds, x: 300 } }, [1000, 700], 1), null);
  for (const patch of [{ id: '../../etc' }, { id: {} }, { bounds: { ...command.bounds, x: -1 } }, { bounds: { ...command.bounds, width: NaN } }, { viewport: { width: Infinity, height: 700 } }, { action: 'exec' }]) assert.equal(validCommand({ ...command, ...patch }), false);
  assert.equal(nativeBounds({ ...command, id: null }, [1000, 700], 1), null);
});

test('multi-view layout validation enforces maximum 4 views and non-overlapping bounds', () => {
  const id1 = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';
  const id2 = 'f52e047f-d947-426c-a0fa-c349d035d338';
  const id3 = '11111111-1111-4111-8111-111111111111';
  const id4 = '22222222-2222-4222-8222-222222222222';
  const id5 = '33333333-3333-4333-8333-333333333333';

  // Valid 2-pane side-by-side
  const valid2Pane = {
    type: 'layout',
    views: [
      { id: id1, bounds: { x: 0, y: 0, width: 500, height: 600 } },
      { id: id2, bounds: { x: 500, y: 0, width: 500, height: 600 } },
    ],
    viewport: { width: 1000, height: 600 },
    focusedId: id1,
  };
  assert.equal(validCommand(valid2Pane), true);

  // Valid 4-pane 2x2 grid
  const valid4Pane = {
    type: 'layout',
    views: [
      { id: id1, bounds: { x: 0, y: 0, width: 500, height: 300 } },
      { id: id2, bounds: { x: 500, y: 0, width: 500, height: 300 } },
      { id: id3, bounds: { x: 0, y: 300, width: 500, height: 300 } },
      { id: id4, bounds: { x: 500, y: 300, width: 500, height: 300 } },
    ],
    viewport: { width: 1000, height: 600 },
  };
  assert.equal(validCommand(valid4Pane), true);

  // Reject 5 panes (max 4 leaves invariant)
  const reject5Pane = {
    type: 'layout',
    views: [
      ...valid4Pane.views,
      { id: id5, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ],
    viewport: { width: 1000, height: 600 },
  };
  assert.equal(validCommand(reject5Pane), false);

  // Reject overlapping rectangles
  const overlapping = {
    type: 'layout',
    views: [
      { id: id1, bounds: { x: 0, y: 0, width: 600, height: 600 } },
      { id: id2, bounds: { x: 500, y: 0, width: 500, height: 600 } }, // Overlaps from x=500 to x=600!
    ],
    viewport: { width: 1000, height: 600 },
  };
  assert.equal(validCommand(overlapping), false);
});

test('FEATURE 10: file delivery and download URL policy', () => {
  assert.equal(isDownloadOrFileDeliveryUrl('https://files.oaiusercontent.com/file-123'), true);
  assert.equal(isDownloadOrFileDeliveryUrl('https://sub.oaiusercontent.com/asset'), true);
  assert.equal(isDownloadOrFileDeliveryUrl('https://oaistatic.com/script.js'), true);
  assert.equal(isDownloadOrFileDeliveryUrl('blob:https://chatgpt.com/some-uuid'), true);
  assert.equal(isDownloadOrFileDeliveryUrl('blob:https://chat.openai.com/some-uuid'), true);
  assert.equal(isDownloadOrFileDeliveryUrl('https://evil.com/fake.pdf'), false);
  assert.equal(isDownloadOrFileDeliveryUrl('blob:https://evil.com/fake'), false);
  assert.equal(isDownloadOrFileDeliveryUrl('http://files.oaiusercontent.com/file'), false);

  // Provider-scoped download origins, file delivery hosts, and Blob validation
  assert.equal(downloadOriginAllowed('perplexity', 'https://www.perplexity.ai'), true);
  assert.equal(downloadOriginAllowed('perplexity', 'https://perplexity.ai'), true);
  assert.equal(downloadOriginAllowed('perplexity', 'https://chatgpt.com'), false);
  assert.equal(downloadOriginAllowed('github', 'https://github.com'), true);
  assert.equal(downloadOriginAllowed('github', 'https://objects.githubusercontent.com'), true);
  assert.equal(downloadOriginAllowed('other', 'https://docs.python.org'), true);
  assert.equal(downloadOriginAllowed('other', 'http://127.0.0.1:8080'), true);
  assert.equal(downloadOriginAllowed('other', 'http://127.0.0.1.:8080'), false);
  assert.equal(downloadOriginAllowed('other', 'javascript:alert(1)'), false);

  assert.equal(isProviderFileDeliveryUrl('perplexity', 'https://cdn.perplexity.ai/export.md'), true);
  assert.equal(isProviderFileDeliveryUrl('perplexity', 'https://pplx-res.cloudinary.com/image.png'), true);
  assert.equal(isProviderFileDeliveryUrl('perplexity', 'blob:https://www.perplexity.ai/uuid-1'), true);
  assert.equal(isProviderFileDeliveryUrl('perplexity', 'https://files.oaiusercontent.com/file-1'), false);
  assert.equal(isProviderFileDeliveryUrl('github', 'https://objects.githubusercontent.com/archive.zip'), true);
  assert.equal(isProviderFileDeliveryUrl('github', 'blob:https://github.com/uuid-1'), true);

  assert.equal(isAllowedBlobDownloadUrl('perplexity', 'blob:https://www.perplexity.ai/uuid-1', 'https://www.perplexity.ai'), true);
  assert.equal(isAllowedBlobDownloadUrl('perplexity', 'blob:https://perplexity.ai/uuid-1', 'https://www.perplexity.ai'), true);
  assert.equal(isAllowedBlobDownloadUrl('perplexity', 'blob:https://evil.com/uuid-1', 'https://www.perplexity.ai'), false);
  assert.equal(isAllowedBlobDownloadUrl('perplexity', 'blob:https://chatgpt.com/uuid-1', 'https://www.perplexity.ai'), false);
  assert.equal(isAllowedBlobDownloadUrl('perplexity', 'blob:null/uuid-1', 'https://www.perplexity.ai'), false);
  assert.equal(isAllowedBlobDownloadUrl('other', 'blob:https://example.com/uuid-1', 'https://example.com'), true);
  assert.equal(isAllowedBlobDownloadUrl('other', 'blob:https://other.com/uuid-1', 'https://example.com'), false);

  assert.equal(downloadDestinationAllowed('perplexity', 'https://www.perplexity.ai/export.md'), true);
  assert.equal(downloadDestinationAllowed('perplexity', 'https://cdn.perplexity.ai/export.md'), true);
  assert.equal(downloadDestinationAllowed('perplexity', 'blob:https://www.perplexity.ai/uuid-1'), true);
  assert.equal(downloadDestinationAllowed('perplexity', 'https://accounts.google.com/o/oauth2/auth'), false);
  assert.equal(downloadDestinationAllowed('perplexity', 'https://untrusted.example.com/evil.pdf'), false);
  assert.equal(downloadDestinationAllowed('github', 'https://objects.githubusercontent.com/a.tar.gz'), true);
  assert.equal(downloadDestinationAllowed('github', 'https://untrusted.example.com/a.tar.gz'), false);
  assert.equal(downloadDestinationAllowed('other', 'https://example.org/file.pdf'), true);
  assert.equal(downloadDestinationAllowed('other', 'http://127.0.0.1:3000/file.pdf'), true);
  assert.equal(downloadDestinationAllowed('other', 'http://127.0.0.1.:3000/file.pdf'), false);
  assert.equal(downloadDestinationAllowed('other', 'file:///etc/passwd'), false);
});

test('FEATURE 11: Perplexity URL and embedded auth navigation policy', () => {
  assert.equal(perplexityUrl('https://perplexity.ai/'), true);
  assert.equal(perplexityUrl('https://www.perplexity.ai/'), true);
  assert.equal(perplexityUrl('https://perplexity.ai/search?q=test'), true);
  assert.equal(perplexityUrl('https://perplexity.ai.evil.com/'), false);
  assert.equal(perplexityUrl('https://chatgpt.com/'), false);
  assert.equal(perplexityUrl('https://github.com/'), false);
  assert.equal(perplexityEmbeddedUrl('https://auth.perplexity.ai/callback'), true);
  assert.equal(perplexityEmbeddedUrl('https://cdn.perplexity.ai/main.js'), true);
  assert.equal(perplexityEmbeddedUrl('https://accounts.google.com/o/oauth2/v2/auth'), true);
  assert.equal(perplexityEmbeddedUrl('https://appleid.apple.com/auth/authorize'), true);
  assert.equal(perplexityEmbeddedUrl('https://evil.perplexity.ai.attacker/'), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://www.perplexity.ai/', provider: 'perplexity' }), true);
  assert.equal(validCommand({ type: 'open', id, url: 'https://www.perplexity.ai/', provider: 'chatgpt' }), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://www.perplexity.ai/', provider: 'github' }), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://chatgpt.com/', provider: 'perplexity' }), false);
});

test('endpoint rediscovery command validation', () => {
  assert.equal(validCommand({ type: 'get-backend-endpoint' }), true);
  assert.equal(validCommand({ type: 'get-backend-endpoint', extra: 'unauthorized' }), false);
  assert.equal(validCommand({ type: 'close', id }), true);
});

test('FEATURE: isSameSite evaluation', () => {
  assert.equal(isSameSite('https://example.com/page1', 'https://example.com/page2'), true);
  assert.equal(isSameSite('https://sub.example.com/a', 'https://api.example.com/b'), true);
  assert.equal(isSameSite('https://docs.python.org/3/tutorial/', 'https://docs.python.org/3/library/'), true);
  assert.equal(isSameSite('https://example.com/', 'https://other.com/'), false);
  assert.equal(isSameSite('https://example.com/', 'http://example.com/'), false);
  assert.equal(isSameSite('https://attacker.co.uk/', 'https://victim.co.uk/'), false);
  assert.equal(isSameSite('https://sub.victim.co.uk/', 'https://api.victim.co.uk/'), true);
  assert.equal(isSameSite('not a url', 'https://example.com'), false);
});

test('FEATURE: targetWebProvider classification and boundary safety', () => {
  assert.equal(targetWebProvider('https://chatgpt.com/'), 'chatgpt');
  assert.equal(targetWebProvider('https://chat.openai.com/'), 'chatgpt');
  assert.equal(targetWebProvider('https://github.com/microsoft/vscode'), 'github');
  assert.equal(targetWebProvider('https://perplexity.ai/search'), 'perplexity');
  assert.equal(targetWebProvider('https://en.wikipedia.org/wiki/Main_Page'), 'other');
  assert.equal(targetWebProvider('https://docs.anthropic.com/en/docs'), 'other');

  // Local web applications and services resolve to other provider
  assert.equal(targetWebProvider('http://localhost:3000/'), 'other');
  assert.equal(targetWebProvider('http://127.0.0.1:8080/'), 'other');
  assert.equal(targetWebProvider('http://192.168.1.1/'), 'other');
  assert.equal(targetWebProvider('http://hosting-bay.local:3000/'), 'other');

  // Blocked / non-embeddable destinations
  assert.equal(targetWebProvider('file:///etc/passwd'), null);
  assert.equal(targetWebProvider('javascript:alert(1)'), null);
  assert.equal(targetWebProvider('data:text/html,<h1>hi</h1>'), null);
  assert.equal(targetWebProvider('mailto:alice@example.com'), null);
});

test('authentication URLs stay distinguishable from ordinary pages and private hosts', () => {
  const longAuth = 'https://accounts.google.com/o/oauth2/v2/auth?state=' + 'a'.repeat(2500);
  assert.equal(longAuth.length > 2048, true);
  assert.equal(authenticationUrl(longAuth), true);
  assert.equal(otherUrl(longAuth), false);
  assert.equal(authenticationUrl('https://accounts.google.com/o/oauth2/v2/auth?state=' + 'a'.repeat(9000)), false);
  for (const url of [
    'https://accounts.google.com/gsi/select?client_id=fixture',
    'https://accounts.youtube.com/',
    'https://myaccount.google.com/',
    'https://appleid.apple.com/auth/authorize',
    'https://login.microsoftonline.com/',
    'https://login.live.com/',
    'https://login.microsoft.com/',
    'https://auth.openai.com/authorize',
    'https://auth0.openai.com/',
    'https://auth.perplexity.ai/authorize',
    'https://acme.okta.com/login',
    'https://tenant.auth0.com/authorize',
    'https://corp.onelogin.com/trust',
  ]) assert.equal(authenticationUrl(url), true, url);
  for (const url of [
    'https://accounts.google.com.evil.com/gsi/select',
    'https://evil.com/gsi/select',
    'https://evil.com/oauth/authorize',
    'https://evil.com/oauth2/authorize',
    'https://evil.com/o/oauth2/v2/auth',
    'https://evil.com/oauth/callback',
    'https://evil.com/oauth/authorized',
    'https://login.example.com/oauth/authorize',
    'https://idp.example.com/oauth/authorize/extra',
    'https://idp.example.com/oauth/v2/authorize',
    'https://idp.example.com/oauth2/authorize',
    'https://idp.example.com/o/oauth2/v2/auth',
    'https://idp.example.com/signin/oauth/consent',
    'https://idp.example.com/login/oauth/authorize',
    'https://idp.example.com/saml/SSO',
    'https://idp.example.com/saml2/acs',
    'https://idp.example.com/openid-connect/auth',
    'https://okta.com/login',
    'https://notokta.com/login',
    'https://login.example/oauth/authorize',
    'http://accounts.google.com/o/oauth2/v2/auth',
    'https://user:pass@accounts.google.com/',
    'https://accounts.google.com:444/',
    'https://127.0.0.1/oauth/authorize',
    'https://localhost/oauth/authorize',
    'javascript:alert(1)',
    'file:///etc/passwd',
  ]) assert.equal(authenticationUrl(url), false, url);
});

test('window.open keeps authentication popups out of workspace tabs', () => {
  const auth = 'https://accounts.google.com/gsi/select?client_id=fixture';
  assert.equal(decideWindowOpen({ url: auth, allowPopup: true, permitted: true, tabbable: true, external: true }), 'popup');
  assert.equal(decideWindowOpen({ url: auth, disposition: 'default', allowPopup: true, permitted: true, tabbable: true, external: true }), 'popup');
  assert.equal(decideWindowOpen({ url: auth, disposition: 'new-window', allowPopup: true, permitted: true, tabbable: true, external: true }), 'popup');
  assert.equal(decideWindowOpen({ url: auth, disposition: 'foreground-tab', allowPopup: true, permitted: true, tabbable: true, external: true }), 'external');
  assert.equal(decideWindowOpen({ url: auth, disposition: 'foreground-tab', features: 'width=500,height=600', allowPopup: true, permitted: true, tabbable: true, external: true }), 'popup');
  assert.equal(decideWindowOpen({ url: auth, disposition: 'background-tab', allowPopup: true, permitted: true, tabbable: true, external: true }), 'external');
  assert.equal(decideWindowOpen({ url: auth, allowPopup: true, popupOpen: true, permitted: true, tabbable: true, external: true }), 'external');
  assert.equal(decideWindowOpen({ url: auth, allowPopup: false, permitted: true, tabbable: true, external: true }), 'external');
  assert.equal(decideWindowOpen({ url: 'about:blank', features: 'width=480,height=640', allowPopup: true }), 'popup');
  assert.equal(decideWindowOpen({ url: '', disposition: 'new-window', features: 'width=480,height=640', allowPopup: true }), 'popup');
  assert.equal(decideWindowOpen({ url: '', disposition: 'new-window', allowPopup: true }), 'deny');
  assert.equal(decideWindowOpen({ url: 'about:blank', allowPopup: true }), 'deny');
  assert.equal(decideWindowOpen({ url: 'https://github.com/openai/openai-python', allowPopup: true, permitted: false, tabbable: true, external: true }), 'tab');
  assert.equal(decideWindowOpen({ url: 'https://docs.python.org/3/', allowPopup: true, permitted: true, tabbable: true, external: true }), 'tab');
  assert.equal(decideWindowOpen({ url: 'https://docs.python.org/3/', disposition: 'foreground-tab', allowPopup: true, permitted: true, tabbable: true, external: true }), 'tab');
  assert.equal(decideWindowOpen({ url: 'https://docs.python.org/3/', disposition: 'background-tab', allowPopup: true, permitted: true, tabbable: true, external: true }), 'tab');
  assert.equal(decideWindowOpen({ url: 'https://docs.python.org/3/', disposition: 'new-window', allowPopup: true, permitted: true, tabbable: true, external: true }), 'tab');
  assert.equal(decideWindowOpen({ url: 'https://docs.python.org/3/', disposition: 'new-window', features: 'width=600,height=500', allowPopup: true, permitted: true, tabbable: true, external: true }), 'popup');
  assert.equal(decideWindowOpen({ url: 'https://docs.python.org/3/', allowPopup: false, permitted: true, tabbable: true, external: true }), 'tab');
  assert.equal(decideWindowOpen({ url: 'javascript:alert(1)', allowPopup: true }), 'deny');
  assert.equal(decideWindowOpen({ url: 'javascript:alert(1)', features: 'width=480,height=640', allowPopup: true }), 'deny');
  const longAuth = 'https://accounts.google.com/o/oauth2/v2/auth?state=' + 'a'.repeat(2500);
  assert.equal(decideWindowOpen({ url: longAuth, allowPopup: true, permitted: false, tabbable: false, external: true }), 'popup');
  assert.equal(decideWindowOpen({ url: longAuth, allowPopup: true, popupOpen: true, permitted: false, tabbable: false, external: true }), 'external');
});

test('validateFaviconUrl: validates HTTPS URLs, data URIs, and rejects dangerous schemes', () => {
  // Valid HTTPS favicons
  assert.equal(validateFaviconUrl('https://chatgpt.com/favicon.ico'), 'https://chatgpt.com/favicon.ico');
  assert.equal(validateFaviconUrl('https://github.githubassets.com/favicons/favicon.png'), 'https://github.githubassets.com/favicons/favicon.png');
  assert.equal(validateFaviconUrl('https://www.perplexity.ai/favicon.svg'), 'https://www.perplexity.ai/favicon.svg');

  // Valid base64 data URIs
  const validDataPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal(validateFaviconUrl(validDataPng), validDataPng);
  const validDataSvg = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PC9zdmc+';
  assert.equal(validateFaviconUrl(validDataSvg), validDataSvg);

  // Dangerous / forbidden schemes must be rejected
  assert.equal(validateFaviconUrl('file:///etc/passwd'), null);
  assert.equal(validateFaviconUrl('javascript:alert(1)'), null);
  assert.equal(validateFaviconUrl('chrome://settings'), null);
  assert.equal(validateFaviconUrl('about:blank'), null);
  assert.equal(validateFaviconUrl('blob:https://chatgpt.com/12345'), null);

  // URLs with credentials or forbidden ports
  assert.equal(validateFaviconUrl('https://user:pass@chatgpt.com/favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://chatgpt.com:8080/favicon.ico'), null);

  // Local/private/loopback/HTTP addresses must always be rejected (SSRF defense)
  assert.equal(validateFaviconUrl('http://localhost:3000/favicon.ico'), null);
  assert.equal(validateFaviconUrl('http://127.0.0.1:8080/favicon.ico'), null);
  assert.equal(validateFaviconUrl('http://127.0.0.2:8080/favicon.ico'), null);
  assert.equal(validateFaviconUrl('http://[::1]:8080/favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://[::1]/favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://127.0.0.1/favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://localhost/favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://localhost./favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://192.168.1.1/favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://intranet/favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://host.home.arpa/favicon.ico'), null);
  assert.equal(validateFaviconUrl('https://host.local./favicon.ico'), null);
  assert.equal(validateFaviconUrl('http://example.com/favicon.ico'), null);

  // Even if callers pass legacy allowLoopback option, loopback/private favicons stay rejected
  assert.equal(validateFaviconUrl('http://localhost:3000/favicon.ico', { allowLoopback: true }), null);
  assert.equal(validateFaviconUrl('http://127.0.0.1:8080/favicon.ico', { allowLoopback: true }), null);
  assert.equal(validateFaviconUrl('https://localhost/favicon.ico', { allowLoopback: true }), null);

  // Invalid data URIs and oversized payloads
  assert.equal(validateFaviconUrl('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.equal(validateFaviconUrl('data:image/png;base64,' + 'A'.repeat(70000)), null);
  assert.equal(validateFaviconUrl(''), null);
  assert.equal(validateFaviconUrl(null), null);
  assert.equal(validateFaviconUrl(undefined), null);

  // selectBestFavicon picks the first valid favicon
  const candidates = [
    'file:///secret/icon.png',
    'javascript:alert(1)',
    'https://chatgpt.com/favicon.ico',
    validDataPng,
  ];
  assert.equal(selectBestFavicon(candidates), 'https://chatgpt.com/favicon.ico');
  assert.equal(selectBestFavicon(['file:///etc/hosts']), null);
  assert.equal(selectBestFavicon(null), null);
});

test('validCommand: supports get-favicons', () => {
  assert.equal(validCommand({ type: 'get-favicons' }), true);
  assert.equal(validCommand({ type: 'get-favicons', extra: 1 }), false);
});
