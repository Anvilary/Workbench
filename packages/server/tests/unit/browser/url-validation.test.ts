import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedChatGptUrl, validateChatGptUrl, validatePerplexityUrl, validateGithubUrl, validateOtherWebUrl, classifyWebTabUrl, webTabProviderFor, isLoopbackHost } from '@agent-workbench/shared';

test('Other tabs accept public HTTP(S), local loopback, and private network hosts while rejecting dangerous schemes and malformed hosts', () => {
  for (const url of [
    'http://example.org:8080/path',
    'https://github.com/owner/repo',
    'https://10.example.org/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://localhost/',
    'localhost:7012',
    'http://127.0.0.1:7012/',
    'http://10.0.0.1/',
    'https://192.168.1.1/',
    'http://router.home/',
    'http://hosting-bay.local:3000/',
    'http://dev-box:8080/',
  ]) {
    assert.equal(validateOtherWebUrl(url).valid, true, url);
  }
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://u:p@example.org/',
    'https://example.org/\n',
    'https://example.org./',
    'http://localhost.:3000/',
    'http://router.local./',
    'http://2130706433/',
  ]) {
    assert.equal(validateOtherWebUrl(url).valid, false, url);
  }
});

test('isLoopbackHost identifies loopback addresses accurately', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost:7012'), true);
  assert.equal(isLoopbackHost('127.0.0.1:7012'), true);
  assert.equal(isLoopbackHost('[::1]:7012'), true);
  assert.equal(isLoopbackHost('sub.localhost'), true);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  assert.equal(isLoopbackHost('10.0.0.1'), false);
  assert.equal(isLoopbackHost('172.16.0.1'), false);
  assert.equal(isLoopbackHost('example.org'), false);
  assert.equal(isLoopbackHost('router.home'), false);
});

test('URL validation: accepts canonical and valid ChatGPT URLs', () => {
  const validCases = [
    'https://chatgpt.com',
    'https://chatgpt.com/',
    'https://chatgpt.com/c/671fd123-4567-89ab-cdef-0123456789ab',
    'https://chatgpt.com/g/g-p-6745abcdef-my-custom-gpt',
    'https://chatgpt.com/share/some-share-id',
    'https://www.chatgpt.com/c/123456',
    'https://chat.openai.com',
    'https://chat.openai.com/c/abc-def',
    'https://chatgpt.com/?model=gpt-4o',
    'https://chatgpt.com/c/123#bottom',
    'https://chatgpt.com:443/c/123',
    '  https://chatgpt.com/c/spaced  ',
  ];

  for (const url of validCases) {
    const res = validateChatGptUrl(url);
    assert.equal(res.valid, true, `Expected valid for: ${url}`);
    assert.ok(res.normalizedUrl);
    assert.ok(isAllowedChatGptUrl(url));
  }
});

test('URL validation: rejects non-HTTPS protocols', () => {
  const invalidProtocols = [
    'http://chatgpt.com',
    'http://chat.openai.com',
    'ftp://chatgpt.com',
    'file:///etc/passwd',
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://chatgpt.com/uuid',
    'chrome://settings',
    'about:blank',
  ];

  for (const url of invalidProtocols) {
    const res = validateChatGptUrl(url);
    assert.equal(res.valid, false, `Expected invalid for protocol: ${url}`);
    assert.match(res.error!, /protocol/i);
    assert.equal(isAllowedChatGptUrl(url), false);
  }
});

test('URL validation: rejects local services, loopback, private IPs, and metadata endpoints (SSRF defense)', () => {
  const dangerousUrls = [
    'https://localhost',
    'https://localhost:8080',
    'https://localhost/c/123',
    'https://sub.localhost',
    'https://127.0.0.1',
    'https://127.0.0.1:3000',
    'https://127.0.0.1:34187',
    'https://[::1]',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.1',
    'https://192.168.1.1',
    'https://172.16.0.1',
    'https://metadata.google.internal',
  ];

  for (const url of dangerousUrls) {
    const res = validateChatGptUrl(url);
    assert.equal(res.valid, false, `Expected SSRF rejection for: ${url}`);
    assert.equal(isAllowedChatGptUrl(url), false);
  }
});

test('URL validation: rejects non-standard ports to prevent internal port scanning', () => {
  const portProbes = [
    'https://chatgpt.com:80',
    'https://chatgpt.com:8080',
    'https://chatgpt.com:3000',
    'https://chatgpt.com:34187',
    'https://chatgpt.com:444',
  ];

  for (const url of portProbes) {
    const res = validateChatGptUrl(url);
    assert.equal(res.valid, false, `Expected rejection for custom port: ${url}`);
    assert.match(res.error!, /custom port/i);
  }
});

test('URL validation: rejects domain spoofing and lookalikes', () => {
  const spoofed = [
    'https://evil-chatgpt.com',
    'https://notchatgpt.com',
    'https://chatgpt.com.evil.com',
    'https://chatgpt.com.attacker.org/c/123',
    'https://openai.com',
    'https://google.com',
    'https://attacker.com/chatgpt.com',
  ];

  for (const url of spoofed) {
    const res = validateChatGptUrl(url);
    assert.equal(res.valid, false, `Expected rejection for spoofed domain: ${url}`);
    assert.match(res.error!, /not an allowed ChatGPT domain/i);
  }
});

test('URL validation: rejects embedded credentials, control characters, and malformed strings', () => {
  const malformed = [
    'https://user:pass@chatgpt.com',
    'https://user@chatgpt.com/c/1',
    'https://chatgpt.com/c/1\r\nEvil-Header: true',
    'https://chatgpt.com/c/1\0null',
    '',
    '   ',
    'not-a-valid-url',
    '//chatgpt.com',
  ];

  for (const url of malformed) {
    const res = validateChatGptUrl(url);
    assert.equal(res.valid, false, `Expected rejection for malformed: ${url}`);
  }
});

test('URL validation: Perplexity accepts canonical URLs and rejects dangerous ones', () => {
  const validPerplexityCases = [
    'https://perplexity.ai',
    'https://www.perplexity.ai',
    'https://www.perplexity.ai/',
    'https://www.perplexity.ai/search?q=hello+world',
    'https://perplexity.ai/search/test-uuid',
    'https://www.perplexity.ai:443/search',
    '  https://www.perplexity.ai/search  ',
  ];

  for (const url of validPerplexityCases) {
    const res = validatePerplexityUrl(url);
    assert.equal(res.valid, true, `Expected valid for: ${url}`);
    assert.ok(res.normalizedUrl);
    const classified = classifyWebTabUrl(url);
    assert.equal(classified.valid, true);
    assert.equal(classified.provider, 'perplexity');
  }

  const invalidPerplexityCases = [
    'http://www.perplexity.ai',
    'https://evil-perplexity.ai',
    'https://perplexity.ai.attacker.com',
    'https://user:pass@www.perplexity.ai',
    'https://www.perplexity.ai:8080',
    'https://localhost',
    'https://127.0.0.1',
    'javascript:alert(1)',
  ];

  for (const url of invalidPerplexityCases) {
    const res = validatePerplexityUrl(url);
    assert.equal(res.valid, false, `Expected invalid for: ${url}`);
  }

  assert.equal(validateGithubUrl('https://github.com/example/workbench').valid, true);
  assert.equal(validateGithubUrl('https://evil.com/').valid, false);
  assert.equal(webTabProviderFor({ url: 'https://www.perplexity.ai/' }), 'perplexity');
  assert.equal(webTabProviderFor({ url: 'https://github.com/test' }), 'github');
  assert.equal(webTabProviderFor({ url: 'https://chatgpt.com/' }), 'chatgpt');
  assert.equal(webTabProviderFor({ url: 'https://other.com/', provider: 'perplexity' }), 'perplexity');
});
