import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  isAllowedWebAuthnOrigin,
  isValidRpId,
  generateClientData,
  parseFido2AssertOutput,
  classifyWebAuthnError,
} from './webauthn-policy.mjs';
import {
  discoverFido2Devices,
  getDeviceCapabilities,
  executeAssertion,
  CANCELLED_MESSAGE,
} from './webauthn-backend.mjs';

// Test harness simulating the main process WebAuthn request handler
async function simulateWebAuthnGet({
  enabled = true,
  senderSessionName = 'persist:maw-chatgpt',
  frameOrigin = 'https://auth.openai.com',
  options = { rpId: 'auth.openai.com', challenge: 'dGVzdA' },
  mockDevices = [{ path: '/dev/hidraw3', vendor: '0x1050', product: '0x0406', description: 'YubiKey' }],
  mockCaps = { hasClientPin: true, pinRetries: 5, minPinLength: 6 },
  pinPromptHandler = async () => '123456',
  executeAssertionFn = async () => 'mock-assert-output',
} = {}) {
  // 1. Opt-in gate
  if (!enabled) {
    return { success: false, error: { name: 'NotAllowedError', message: 'WebAuthn is not enabled' } };
  }

  // 2. Session isolation
  if (senderSessionName !== 'persist:maw-chatgpt') {
    return { success: false, error: { name: 'SecurityError', message: 'WebAuthn is only permitted within the ChatGPT session' } };
  }

  // 3. Origin check
  if (!isAllowedWebAuthnOrigin(frameOrigin)) {
    return { success: false, error: { name: 'SecurityError', message: `Origin ${frameOrigin} is not authorized for WebAuthn` } };
  }

  // 4. RP ID check
  if (!isValidRpId(options?.rpId, frameOrigin)) {
    return { success: false, error: { name: 'SecurityError', message: `Requested rpId ${options?.rpId} does not match origin ${frameOrigin}` } };
  }

  // 5. Device discovery
  if (!mockDevices || mockDevices.length === 0) {
    return { success: false, error: { name: 'NotAllowedError', message: 'No FIDO2 hardware device found' } };
  }

  // 6. PIN requirement
  let pin = null;
  const userVerification = options?.userVerification || 'preferred';
  const pinRequired = mockCaps.hasClientPin && (userVerification === 'required' || userVerification === 'preferred');

  if (pinRequired) {
    try {
      pin = await pinPromptHandler();
    } catch (err) {
      return { success: false, error: classifyWebAuthnError(err) };
    }
  }

  // 7. Execute assertion
  try {
    const rawOutput = await executeAssertionFn({ pin });
    return { success: true, data: rawOutput };
  } catch (err) {
    return { success: false, error: classifyWebAuthnError(err) };
  }
}

test('security boundary: fails closed when WebAuthn is disabled by default', async () => {
  const result = await simulateWebAuthnGet({ enabled: false });
  assert.equal(result.success, false);
  assert.equal(result.error.name, 'NotAllowedError');
});

test('security boundary: rejects requests from non-ChatGPT browser sessions', async () => {
  const otherSession = await simulateWebAuthnGet({ senderSessionName: 'persist:maw-browser' });
  assert.equal(otherSession.success, false);
  assert.equal(otherSession.error.name, 'SecurityError');

  const githubSession = await simulateWebAuthnGet({ senderSessionName: 'persist:maw-github' });
  assert.equal(githubSession.success, false);
  assert.equal(githubSession.error.name, 'SecurityError');
});

test('security boundary: rejects requests from unauthorized origins', async () => {
  const evilOrigin = await simulateWebAuthnGet({ frameOrigin: 'https://evil.com' });
  assert.equal(evilOrigin.success, false);
  assert.equal(evilOrigin.error.name, 'SecurityError');

  const attackerOrigin = await simulateWebAuthnGet({ frameOrigin: 'https://chatgpt.com.attacker.com' });
  assert.equal(attackerOrigin.success, false);
  assert.equal(attackerOrigin.error.name, 'SecurityError');
});

test('security boundary: rejects cross-origin RP ID spoofing attempts', async () => {
  // Page at auth.openai.com trying to claim apple.com credentials
  const spoofApple = await simulateWebAuthnGet({
    frameOrigin: 'https://auth.openai.com',
    options: { rpId: 'apple.com', challenge: 'dGVzdA' },
  });
  assert.equal(spoofApple.success, false);
  assert.equal(spoofApple.error.name, 'SecurityError');

  // Page at chatgpt.com trying to claim google.com credentials
  const spoofGoogle = await simulateWebAuthnGet({
    frameOrigin: 'https://chatgpt.com',
    options: { rpId: 'google.com', challenge: 'dGVzdA' },
  });
  assert.equal(spoofGoogle.success, false);
  assert.equal(spoofGoogle.error.name, 'SecurityError');
});

test('security boundary: rejects invalid RP ID formatting (ports, scheme, path)', async () => {
  const withPort = await simulateWebAuthnGet({
    frameOrigin: 'https://auth.openai.com',
    options: { rpId: 'openai.com:443', challenge: 'dGVzdA' },
  });
  assert.equal(withPort.success, false);
  assert.equal(withPort.error.name, 'SecurityError');

  const withScheme = await simulateWebAuthnGet({
    frameOrigin: 'https://auth.openai.com',
    options: { rpId: 'https://openai.com', challenge: 'dGVzdA' },
  });
  assert.equal(withScheme.success, false);
  assert.equal(withScheme.error.name, 'SecurityError');
});

test('hardware lifecycle: fails with NotAllowedError when no security key is connected', async () => {
  const result = await simulateWebAuthnGet({ mockDevices: [] });
  assert.equal(result.success, false);
  assert.equal(result.error.name, 'NotAllowedError');
  assert.ok(result.error.message.includes('No FIDO2 hardware device found'));
});

test('hardware lifecycle: handles user PIN cancellation gracefully', async () => {
  const result = await simulateWebAuthnGet({
    pinPromptHandler: async () => { throw new Error('NotAllowedError: PIN entry was cancelled'); },
  });
  assert.equal(result.success, false);
  assert.equal(result.error.name, 'NotAllowedError');
  assert.ok(result.error.message.includes('cancelled'));
});

test('hardware lifecycle: successful assertion returns structured data', async () => {
  const result = await simulateWebAuthnGet({
    pinPromptHandler: async () => '123456',
    executeAssertionFn: async ({ pin }) => {
      assert.equal(pin, '123456');
      return { credentialId: 'mock-cred', type: 'public-key' };
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.data.credentialId, 'mock-cred');
});
