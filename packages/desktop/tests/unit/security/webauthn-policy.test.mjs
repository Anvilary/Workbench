import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  isAllowedWebAuthnOrigin,
  isValidRpId,
  bufferToBase64Url,
  base64UrlToBuffer,
  generateClientData,
  unwrapCborByteString,
  parseFido2AssertOutput,
  classifyWebAuthnError,
} from '../../../webauthn-policy.mjs';

test('isAllowedWebAuthnOrigin accepts known ChatGPT/OpenAI origins and rejects untrusted origins', () => {
  // Allowed defaults
  assert.equal(isAllowedWebAuthnOrigin('https://chatgpt.com'), true);
  assert.equal(isAllowedWebAuthnOrigin('https://auth.openai.com'), true);
  assert.equal(isAllowedWebAuthnOrigin('https://auth0.openai.com'), true);
  assert.equal(isAllowedWebAuthnOrigin('https://openai.com'), true);

  // Rejected untrusted origins
  assert.equal(isAllowedWebAuthnOrigin('http://chatgpt.com'), false);
  assert.equal(isAllowedWebAuthnOrigin('https://evil.com'), false);
  assert.equal(isAllowedWebAuthnOrigin('https://chatgpt.com.attacker.com'), false);
  assert.equal(isAllowedWebAuthnOrigin('https://auth.openai.com.phishing.io'), false);
  assert.equal(isAllowedWebAuthnOrigin('file:///etc/passwd'), false);
  assert.equal(isAllowedWebAuthnOrigin('javascript:alert(1)'), false);
  assert.equal(isAllowedWebAuthnOrigin(''), false);
  assert.equal(isAllowedWebAuthnOrigin(null), false);
  assert.equal(isAllowedWebAuthnOrigin(undefined), false);

  // Configured extra origins
  assert.equal(isAllowedWebAuthnOrigin('https://idp.enterprise.com', ['https://idp.enterprise.com']), true);
  assert.equal(isAllowedWebAuthnOrigin('https://idp.other.com', ['https://idp.enterprise.com']), false);
});

test('isValidRpId enforces W3C WebAuthn rpId constraints against origin', () => {
  // Exact match
  assert.equal(isValidRpId('auth.openai.com', 'https://auth.openai.com'), true);
  assert.equal(isValidRpId('chatgpt.com', 'https://chatgpt.com'), true);

  // Parent domain match
  assert.equal(isValidRpId('openai.com', 'https://auth.openai.com'), true);
  assert.equal(isValidRpId('openai.com', 'https://sub.auth.openai.com'), true);

  // Affiliated domain match
  assert.equal(isValidRpId('openai.com', 'https://chatgpt.com'), true);

  // Rejections: unrelated domain
  assert.equal(isValidRpId('evil.com', 'https://auth.openai.com'), false);
  assert.equal(isValidRpId('google.com', 'https://chatgpt.com'), false);
  assert.equal(isValidRpId('notopenai.com', 'https://auth.openai.com'), false);

  // Rejections: partial name collision (e.g. fakeopenai.com)
  assert.equal(isValidRpId('openai.com', 'https://fakeopenai.com'), false);

  // Rejections: invalid format (scheme, ports, paths, whitespace)
  assert.equal(isValidRpId('https://openai.com', 'https://openai.com'), false);
  assert.equal(isValidRpId('openai.com:443', 'https://openai.com'), false);
  assert.equal(isValidRpId('openai.com/path', 'https://openai.com'), false);
  assert.equal(isValidRpId('openai.com ', 'https://openai.com'), false);
  assert.equal(isValidRpId('', 'https://openai.com'), false);
  assert.equal(isValidRpId(null, 'https://openai.com'), false);

  // Rejections: top-level domain alone (e.g. .com)
  assert.equal(isValidRpId('com', 'https://openai.com'), false);
  assert.equal(isValidRpId('co.uk', 'https://login.example.co.uk'), false);
});

test('generateClientData produces canonical WebAuthn JSON and SHA-256 hash', () => {
  const challenge = 'dGVzdGNoYWxsZW5nZQ';
  const origin = 'https://auth.openai.com';
  const data = generateClientData('webauthn.get', challenge, origin);

  const parsed = JSON.parse(data.clientDataJSON);
  assert.equal(parsed.type, 'webauthn.get');
  assert.equal(parsed.challenge, challenge);
  assert.equal(parsed.origin, origin);
  assert.equal(parsed.crossOrigin, false);

  const expectedHash = createHash('sha256').update(data.clientDataJSONBuffer).digest();
  assert.deepEqual(data.clientDataHash, expectedHash);
});

test('bufferToBase64Url and base64UrlToBuffer roundtrip correctly', () => {
  const original = Buffer.from('Testing 123 !@# WebAuthn Buffer Bytes', 'utf8');
  const base64url = bufferToBase64Url(original);
  assert.ok(!base64url.includes('+'));
  assert.ok(!base64url.includes('/'));
  assert.ok(!base64url.includes('='));

  const restored = base64UrlToBuffer(base64url);
  assert.deepEqual(restored, original);
});

test('unwrapCborByteString unwraps CBOR length prefixes accurately', () => {
  // Raw bytes (not starting with major type 2: e.g. 0x00 or 0x80)
  const rawBytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  assert.deepEqual(unwrapCborByteString(rawBytes), rawBytes);

  // Empty buffer
  assert.deepEqual(unwrapCborByteString(Buffer.alloc(0)), Buffer.alloc(0));
  assert.equal(unwrapCborByteString(null), null);

  // Short byte string (<24 bytes): header is 0x40 + len
  const shortPayload = Buffer.from('hello webauthn');
  const shortCbor = Buffer.concat([Buffer.from([0x40 + shortPayload.length]), shortPayload]);
  assert.deepEqual(unwrapCborByteString(shortCbor), shortPayload);

  // 1-byte length byte string (24-255 bytes): header is 0x58, length
  const payload37 = Buffer.alloc(37, 0xaa);
  const cbor37 = Buffer.concat([Buffer.from([0x58, 37]), payload37]);
  assert.deepEqual(unwrapCborByteString(cbor37), payload37);

  // 2-byte length byte string (>255 bytes): header is 0x59, len_hi, len_lo
  const payload300 = Buffer.alloc(300, 0xbb);
  const cbor300 = Buffer.concat([Buffer.from([0x59, 0x01, 0x2c]), payload300]);
  assert.deepEqual(unwrapCborByteString(cbor300), payload300);
});

test('parseFido2AssertOutput parses raw and echoed output formats cleanly', () => {
  const clientDataJSONBuffer = Buffer.from('{"type":"webauthn.get"}');
  const fakeAuthData = Buffer.concat([Buffer.from([0x58, 37]), Buffer.alloc(37, 0x42)]);
  const fakeSig = Buffer.from([0x30, 0x45, 0x02, 0x20]);
  const fakeUserId = Buffer.from('openai-user-1234');

  const authDataBase64 = fakeAuthData.toString('base64');
  const sigBase64 = fakeSig.toString('base64');
  const userIdBase64 = fakeUserId.toString('base64');

  // Format 1: Non-echo format (authData, sig, userId)
  const stdoutNonEcho = `${authDataBase64}\n${sigBase64}\n${userIdBase64}\n`;
  const resultNonEcho = parseFido2AssertOutput(stdoutNonEcho, {
    rpId: 'auth.openai.com',
    credentialId: 'cred-999',
    clientDataJSONBuffer,
  });

  assert.equal(resultNonEcho.credentialId, 'cred-999');
  assert.equal(resultNonEcho.userHandle, bufferToBase64Url(fakeUserId));
  assert.equal(resultNonEcho.signature, bufferToBase64Url(fakeSig));
  assert.equal(resultNonEcho.authenticatorData, bufferToBase64Url(Buffer.alloc(37, 0x42)));

  // Format 2: Echo format (clientDataHash, rpId, authData, sig, userId)
  const cdhBase64 = Buffer.alloc(32, 0x11).toString('base64');
  const stdoutEcho = `${cdhBase64}\nauth.openai.com\n${authDataBase64}\n${sigBase64}\n${userIdBase64}\n`;
  const resultEcho = parseFido2AssertOutput(stdoutEcho, {
    rpId: 'auth.openai.com',
    credentialId: 'cred-999',
    clientDataJSONBuffer,
  });

  assert.equal(resultEcho.credentialId, 'cred-999');
  assert.equal(resultEcho.userHandle, bufferToBase64Url(fakeUserId));
  assert.equal(resultEcho.signature, bufferToBase64Url(fakeSig));

  // Failure cases: empty or truncated output
  assert.throws(() => parseFido2AssertOutput('', { rpId: 'auth.openai.com', clientDataJSONBuffer }), /Incomplete output/);
  assert.throws(() => parseFido2AssertOutput('only_one_line', { rpId: 'auth.openai.com', clientDataJSONBuffer }), /Incomplete output/);
});

test('classifyWebAuthnError categorizes errors into standard DOMException names', () => {
  assert.equal(classifyWebAuthnError(new Error('SecurityError: origin mismatch')).name, 'SecurityError');
  assert.equal(classifyWebAuthnError(new Error('unauthorized origin')).name, 'SecurityError');
  assert.equal(classifyWebAuthnError(new Error('rpId does not match')).name, 'SecurityError');
  assert.equal(classifyWebAuthnError(new Error('InvalidStateError: corrupted key')).name, 'InvalidStateError');
  assert.equal(classifyWebAuthnError(new Error('User cancelled operation')).name, 'NotAllowedError');
  assert.equal(classifyWebAuthnError(new Error('fido2-assert timed out')).name, 'NotAllowedError');
});
