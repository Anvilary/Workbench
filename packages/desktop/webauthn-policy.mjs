// Pure WebAuthn policy, validation, and serialization functions.
// Designed for safe FIDO2 operations with no side effects.

import { createHash } from 'node:crypto';

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

    // Exact match
    if (originHost === candidateRpId) return true;

    // Subdomain match: originHost ends with .candidateRpId
    if (originHost.endsWith('.' + candidateRpId) && originHost.length > candidateRpId.length + 1) {
      // Must not allow public suffixes like ".com" or ".co.uk" alone
      const parts = candidateRpId.split('.');
      if (parts.length >= 2 && parts[parts.length - 1].length > 0) {
        return true;
      }
    }

    // Special recognized affiliation: chatgpt.com is affiliated with openai.com
    if ((originHost === 'chatgpt.com' || originHost.endsWith('.chatgpt.com')) && candidateRpId === 'openai.com') {
      return true;
    }

    return false;
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
export function parseFido2AssertOutput(stdout, { rpId, credentialId = '', clientDataJSONBuffer }) {
  if (typeof stdout !== 'string') {
    throw new Error('NotAllowedError: Invalid fido2-assert output format');
  }

  const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('NotAllowedError: Incomplete output from fido2-assert');
  }

  // Heuristic for fido2-tools output:
  // When echoing input lines: line 0 may be client data hash, line 1 may be rpId.
  // The actual assertion data lines follow:
  // data line 0: CBOR authData (base64)
  // data line 1: signature (base64)
  // data line 2 (optional): userHandle (base64)
  let dataLines = lines;
  if (lines.length >= 4 && (lines[1] === rpId || lines[0] === rpId)) {
    dataLines = lines.slice(2);
  } else if (lines.length >= 3 && lines[0] === rpId) {
    dataLines = lines.slice(1);
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

  const credId = credentialId || (userHandleBase64Url ? userHandleBase64Url : 'fido2-credential');

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

  if (lower.includes('securityerror') || lower.includes('origin') || lower.includes('rpid')) {
    return { name: 'SecurityError', message: msg };
  }
  if (lower.includes('invalidstateerror') || lower.includes('invalid')) {
    return { name: 'InvalidStateError', message: msg };
  }
  return { name: 'NotAllowedError', message: msg || 'The operation either timed out or was not allowed.' };
}
