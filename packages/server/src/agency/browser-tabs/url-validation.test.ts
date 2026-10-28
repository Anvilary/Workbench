import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedChatGptUrl, validateChatGptUrl } from '@agent-workbench/shared';

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
