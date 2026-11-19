// Pure WebAuthn policy, validation, and serialization functions.
// Designed for safe FIDO2 operations with no side effects.

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const DEFAULT_WEBAUTHN_ORIGINS = Object.freeze([
  'https://chatgpt.com',
  'https://auth.openai.com',
  'https://auth0.openai.com',
  'https://openai.com',
]);

/**
 * Checks whether an origin is permitted to perform WebAuthn operations.
 * @param {string} origin
 * @param {string[]} [extraOrigins]
 * @returns {boolean}
 */
export function isAllowedWebAuthnOrigin(origin, extraOrigins = []) {
  if (typeof origin !== 'string' || !origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:') return false;
    const normalized = parsed.origin;
    if (origin !== normalized) return false;
    if (DEFAULT_WEBAUTHN_ORIGINS.includes(normalized)) return true;
    for (const extra of extraOrigins) {
      if (typeof extra === 'string' && extra.trim() === normalized) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Validates that the requested rpId is valid for the requesting origin
 * according to W3C WebAuthn Level 3 specification (Section 5.1.3).
 * @param {string} rpId
 * @param {string} origin
 * @returns {boolean}
 */
export function isValidRpId(rpId, origin) {
  if (typeof rpId !== 'string' || !rpId || typeof origin !== 'string' || !origin) return false;
  // rpId must not contain scheme, port, userinfo, path, or whitespace
  if (/[/:\\@\s]/.test(rpId)) return false;

  try {
    const originUrl = new URL(origin);
    if (originUrl.protocol !== 'https:') return false;
    const originHost = originUrl.hostname.toLowerCase();
    const candidateRpId = rpId.toLowerCase();

    // W3C WebAuthn requires a valid domain string (never an IP literal, single label, or trailing dot)
    const bareOrigin = originHost.replace(/^\[|\]$/g, '');
    const bareCandidate = candidateRpId.replace(/^\[|\]$/g, '');
    if (isIP(bareOrigin) || isIP(bareCandidate)) return false;
    if (!candidateRpId.includes('.') || candidateRpId.endsWith('.') || candidateRpId.startsWith('.')) return false;

    // Exact match
    if (originHost === candidateRpId) return true;

    // The built-in OpenAI sign-in flow uses this parent/related RP.
    // Configured extra origins accept their exact host only.
    return candidateRpId === 'openai.com' &&
      (originHost.endsWith('.openai.com') || originHost === 'chatgpt.com');
  } catch {
    return false;
  }
}

/**
 * Encodes a Buffer to a base64url string without padding.
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
export function bufferToBase64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Decodes a base64url string into a Buffer.
 * @param {string} str
 * @returns {Buffer}
 */
export function base64UrlToBuffer(str) {
  return Buffer.from(str, 'base64url');
}

export function isValidWebAuthnPin(pin) {
  return typeof pin === 'string' && pin.length > 0 && Buffer.byteLength(pin) <= 63 && !/[\r\n\0]/.test(pin);
}

function isBase64Url(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && /^[a-zA-Z0-9_-]+$/.test(value) &&
    base64UrlToBuffer(value).toString('base64url') === value;
}

export function validAssertionOptions(options, origin) {
  return options && isValidRpId(options.rpId, origin) &&
    isBase64Url(options.challenge, 4096) &&
    (options.timeout === undefined || (Number.isFinite(options.timeout) && options.timeout >= 0 && options.timeout <= 600)) &&
    (options.userVerification === undefined || ['required', 'preferred', 'discouraged'].includes(options.userVerification)) &&
    (options.allowCredentials === undefined || (
      Array.isArray(options.allowCredentials) && options.allowCredentials.length <= 16 &&
      options.allowCredentials.every(credential => credential?.type === 'public-key' && isBase64Url(credential.id, 4096))
    ));
}

export function verifyAssertionData(data, rpId, requireUv) {
  const authenticatorData = base64UrlToBuffer(data.authenticatorData);
  const rpIdHash = createHash('sha256').update(String(rpId || '').toLowerCase()).digest();
  if (authenticatorData.length < 37 || !authenticatorData.subarray(0, 32).equals(rpIdHash) ||
      !(authenticatorData[32] & 1) || (requireUv && !(authenticatorData[32] & 4))) {
    throw new Error('NotAllowedError: Invalid authenticator data or missing user verification');
  }
}

/**
 * Creates canonical clientDataJSON Buffer, string, and SHA-256 hash.
 * @param {'webauthn.get'|'webauthn.create'} type
 * @param {string} challengeBase64Url
 * @param {string} origin
 * @returns {{ clientDataJSON: string, clientDataJSONBuffer: Buffer, clientDataHash: Buffer }}
 */
export function generateClientData(type, challengeBase64Url, origin) {
  const clientData = {
    type,
    challenge: challengeBase64Url,
    origin,
    crossOrigin: false,
  };
  const jsonString = JSON.stringify(clientData);
  const clientDataJSONBuffer = Buffer.from(jsonString, 'utf8');
  const clientDataHash = createHash('sha256').update(clientDataJSONBuffer).digest();
  return {
    clientDataJSON: jsonString,
    clientDataJSONBuffer,
    clientDataHash,
  };
}

/**
 * Unwraps a CBOR major type 2 (byte string) header if present.
 * In CTAP2 responses, authenticatorData is returned as a CBOR byte string.
 * This helper unwraps the CBOR length prefix to access raw authenticator data.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function unwrapCborByteString(buf) {
  if (!buf || buf.length === 0) return buf;
  const initial = buf[0];
  const major = initial >> 5;
  const info = initial & 0x1f;

  if (major !== 2) {
    // Not a CBOR byte string; already raw authData bytes
    return buf;
  }

  if (info < 24) {
    return buf.subarray(1, 1 + info);
  } else if (info === 24 && buf.length >= 2 + buf[1]) {
    return buf.subarray(2, 2 + buf[1]);
  } else if (info === 25 && buf.length >= 3 + ((buf[1] << 8) | buf[2])) {
    const len = (buf[1] << 8) | buf[2];
    return buf.subarray(3, 3 + len);
  } else if (info === 26 && buf.length >= 5 + buf.readUInt32BE(1)) {
    const len = buf.readUInt32BE(1);
    return buf.subarray(5, 5 + len);
  }

  return buf;
}

/**
 * Parses stdout from fido2-assert -G into a structured WebAuthn assertion payload.
 * Handles both echo-line versions of fido2-tools and non-echo versions.
 * @param {string} stdout
 * @param {object} context
 * @param {string} context.rpId
 * @param {string} [context.credentialId]
 * @param {Buffer} context.clientDataJSONBuffer
 * @returns {{
 *   credentialId: string,
 *   rawId: string,
 *   authenticatorData: string,
 *   clientDataJSON: string,
 *   signature: string,
 *   userHandle: string|null,
 *   type: string
 * }}
 */
export function parseFido2AssertOutput(
  stdout,
  { rpId, credentialId = '', clientDataJSONBuffer, residentCredentials = [] } = {},
) {
  if (typeof stdout !== 'string') {
    throw new Error('NotAllowedError: Invalid fido2-assert output format');
  }

  const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('NotAllowedError: Incomplete output from fido2-assert');
  }

  // Heuristic for fido2-tools output:
  // When echoing input lines: line 0 is client data hash, line 1 is rpId.
  // Some versions echo rpId at line 0 without clientDataHash.
  // The actual assertion data lines follow:
  // data line 0: CBOR authData (base64)
  // data line 1: signature (base64)
  // data line 2 (optional): userHandle (base64)
  // Note: fido2-assert -G -r may emit multiple assertions back-to-back;
  // slice only the first assertion so a subsequent assertion's hash is not read as userHandle.
  const normalizedRpId = typeof rpId === 'string' ? rpId.toLowerCase() : '';
  const isRpLine = (idx) => normalizedRpId.length > 0 && idx < lines.length && lines[idx].toLowerCase() === normalizedRpId;

  let dataLines = lines;
  if (lines.length >= 4 && isRpLine(1)) {
    if (lines.length >= 6 && isRpLine(5)) {
      dataLines = lines.slice(2, 4);
    } else if (lines.length >= 7 && isRpLine(6)) {
      dataLines = lines.slice(2, 5);
    } else {
      dataLines = lines.slice(2, 5);
    }
  } else if (lines.length >= 3 && isRpLine(0)) {
    if (lines.length >= 4 && isRpLine(3)) {
      dataLines = lines.slice(1, 3);
    } else if (lines.length >= 5 && isRpLine(4)) {
      dataLines = lines.slice(1, 4);
    } else {
      dataLines = lines.slice(1, 4);
    }
  } else {
    dataLines = lines.slice(0, 3);
  }

  if (dataLines.length < 2) {
    throw new Error('NotAllowedError: Expected authenticator data and signature from key');
  }

  const rawAuthDataBuf = Buffer.from(dataLines[0], 'base64');
  const authDataBuf = unwrapCborByteString(rawAuthDataBuf);
  const signatureBuf = Buffer.from(dataLines[1], 'base64');

  let userHandleBase64Url = null;
  if (dataLines.length >= 3 && dataLines[2].length > 0) {
    userHandleBase64Url = bufferToBase64Url(Buffer.from(dataLines[2], 'base64'));
  }

  const matches = credentialId || !userHandleBase64Url
    ? []
    : residentCredentials.filter(entry => entry?.userId === userHandleBase64Url);
  const credId = credentialId || (matches.length === 1 ? matches[0].credentialId : '');
  if (!credId || signatureBuf.length === 0) {
    throw new Error('NotAllowedError: Could not identify the asserted credential');
  }

  return {
    credentialId: credId,
    rawId: credId,
    authenticatorData: bufferToBase64Url(authDataBuf),
    clientDataJSON: bufferToBase64Url(clientDataJSONBuffer),
    signature: bufferToBase64Url(signatureBuf),
    userHandle: userHandleBase64Url,
    type: 'public-key',
  };
}

/**
 * Classifies an error and maps it to a standard WebAuthn DOMException name.
 * @param {Error|string} err
 * @returns {{ name: string, message: string }}
 */
export function classifyWebAuthnError(err) {
  const msg = err instanceof Error ? err.message : String(err || '');
  const lower = msg.toLowerCase();

  if (lower.includes('notsupportederror') || lower.includes('not supported')) {
    return { name: 'NotSupportedError', message: msg };
  }
  if (lower.includes('securityerror') || lower.includes('origin') || lower.includes('rpid')) {
    return { name: 'SecurityError', message: msg };
  }
  if (lower.includes('invalidstateerror')) {
    return { name: 'InvalidStateError', message: msg };
  }
  if (lower.includes('notallowederror')) {
    return { name: 'NotAllowedError', message: msg };
  }
  if (lower.includes('invalid')) {
    return { name: 'InvalidStateError', message: msg };
  }
  return { name: 'NotAllowedError', message: msg || 'The operation either timed out or was not allowed.' };
}
