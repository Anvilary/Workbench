import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddedUrl, externalUrl, otherUrl, serviceUrl, trustedSender, validCommand, nativeBounds, isDownloadOrFileDeliveryUrl, githubUrl, githubEmbeddedUrl, perplexityUrl, perplexityEmbeddedUrl, isSameSite, targetWebProvider, authenticationUrl, decideWindowOpen } from './policy.mjs';
const id = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';
test('general web URLs cannot name local services or privileged protocols', () => {
  assert.equal(validCommand({ type: 'restore-shell-storage' }), true);
  assert.equal(validCommand({ type: 'restore-shell-storage', origin: 'https://attacker.com' }), false);
  for (const url of ['https://www.wikipedia.org/wiki/Browser', 'http://example.com:8080/', 'https://github.com/']) {
    assert.equal(otherUrl(url), true, url);
    assert.equal(validCommand({ type: 'open', id, url, provider: 'other' }), true, url);
  }
  for (const url of ['http://127.0.0.1:3000/', 'http://2130706433/', 'http://[::1]/', 'http://localhost/', 'http://localhost.:3000/', 'http://router.local./', 'http://host.local/', 'https://host.home.arpa/', 'https://host.internal/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@example.com/', 'https://example.com/\n']) {
    assert.equal(otherUrl(url), false, url);
    assert.equal(validCommand({ type: 'open', id, url, provider: 'other' }), false, url);
  }
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
  assert.equal(validCommand({ type: 'browser-action', id, action: 'open-link', url: 'http://127.0.0.1/' }), false);
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

  // Blocked / non-embeddable destinations
  assert.equal(targetWebProvider('http://localhost:3000/'), null);
  assert.equal(targetWebProvider('http://127.0.0.1:8080/'), null);
  assert.equal(targetWebProvider('http://192.168.1.1/'), null);
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
    'https://acme.okta.com/login',
    'https://tenant.auth0.com/authorize',
    'https://corp.onelogin.com/trust',
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
  ]) assert.equal(authenticationUrl(url), true, url);
  for (const url of [
    'https://accounts.google.com.evil.com/gsi/select',
    'https://evil.com/gsi/select',
    'https://evil.com/oauth/callback',
    'https://evil.com/oauth/authorized',
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
  assert.equal(decideWindowOpen({ url: auth, allowPopup: true, popupOpen: true, permitted: true, tabbable: true, external: true }), 'external');
  assert.equal(decideWindowOpen({ url: auth, allowPopup: false, permitted: true, tabbable: true, external: true }), 'external');
  assert.equal(decideWindowOpen({ url: 'about:blank', features: 'width=480,height=640', allowPopup: true }), 'popup');
  assert.equal(decideWindowOpen({ url: '', disposition: 'new-window', allowPopup: true }), 'popup');
  assert.equal(decideWindowOpen({ url: 'about:blank', allowPopup: true }), 'deny');
  assert.equal(decideWindowOpen({ url: 'https://github.com/openai/openai-python', allowPopup: true, permitted: false, tabbable: true, external: true }), 'tab');
  assert.equal(decideWindowOpen({ url: 'https://docs.python.org/3/', allowPopup: true, permitted: true, tabbable: true, external: true }), 'popup');
  assert.equal(decideWindowOpen({ url: 'https://docs.python.org/3/', allowPopup: false, permitted: true, tabbable: true, external: true }), 'tab');
  assert.equal(decideWindowOpen({ url: 'javascript:alert(1)', allowPopup: true }), 'deny');
  const longAuth = 'https://accounts.google.com/o/oauth2/v2/auth?state=' + 'a'.repeat(2500);
  assert.equal(decideWindowOpen({ url: longAuth, allowPopup: true, permitted: false, tabbable: false, external: true }), 'popup');
  assert.equal(decideWindowOpen({ url: longAuth, allowPopup: true, popupOpen: true, permitted: false, tabbable: false, external: true }), 'external');
});
