// Hardware interaction with libfido2 CLI utilities (fido2-token, fido2-assert).
// Handles process group isolation, timeout management, clean cancellation,
// and safe PIN stdin transmission without logging secrets.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { base64UrlToBuffer, bufferToBase64Url } from './webauthn-policy.mjs';

const execFileAsync = promisify(execFile);

export const CANCELLED_MESSAGE = 'NotAllowedError: security key operation cancelled';
export const NO_DEVICE_MESSAGE = 'NotAllowedError: No FIDO2 hardware device found. Please insert your security key.';

/**
 * Checks whether system fido2-tools are available on Linux.
 * @param {string} [fido2TokenPath]
 * @returns {Promise<boolean>}
 */
export async function isFido2ToolsAvailable(fido2TokenPath = 'fido2-token') {
  if (process.platform !== 'linux') return false;
  try {
    await execFileAsync(fido2TokenPath, ['-V']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discovers connected FIDO2 devices using fido2-token -L.
 * @param {Function} [execFn]
 * @returns {Promise<Array<{ path: string, vendor: string, product: string, description: string }>>}
 */
export async function discoverFido2Devices(execFn = execFileAsync) {
  try {
    const { stdout } = await execFn('fido2-token', ['-L']);
    const devices = [];
    const lines = stdout.trim().split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: /dev/hidraw3: vendor=0x1050, product=0x0406 (Yubico YubiKey FIDO+CCID)
      const match = trimmed.match(/^([^:]+):\s*vendor=(0x[0-9a-fA-F]+),\s*product=(0x[0-9a-fA-F]+)(?:\s*\((.*)\))?/);
      if (match) {
        devices.push({
          path: match[1],
          vendor: match[2],
          product: match[3],
          description: match[4] || 'FIDO2 Device',
        });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

/**
 * Reads capabilities of the specified FIDO2 device using fido2-token -I.
 * Distinguishes confirmed absence of clientPin (`hasClientPin: false, probeError: false`)
 * from capability probe failures (`hasClientPin: null, probeError: true`).
 * @param {string} devicePath
 * @param {Function} [execFn]
 * @param {{ retries?: number, retryDelayMs?: number }} [options]
 * @returns {Promise<{ hasClientPin: boolean|null, hasCredMgmt: boolean, pinRetries: number|null, minPinLength: number, probeError: boolean, error?: string }>}
 */
export async function getDeviceCapabilities(
  devicePath,
  execFn = execFileAsync,
  { retries = 1, retryDelayMs = 50 } = {},
) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { stdout } = await execFn('fido2-token', ['-I', devicePath]);
      const optionsMatch = stdout.match(/options:\s*(.+)/);
      const options = optionsMatch ? optionsMatch[1].split(',').map(s => s.trim()) : [];
      const hasClientPin = options.includes('clientPin');
      const hasCredMgmt = options.includes('credMgmt');

      const retriesMatch = stdout.match(/pin retries:\s*(\d+)/i);
      const pinRetries = retriesMatch ? parseInt(retriesMatch[1], 10) : null;

      const minPinMatch = stdout.match(/minpinlen:\s*(\d+)/i);
      const minPinLength = minPinMatch ? parseInt(minPinMatch[1], 10) : 4;

      return {
        hasClientPin,
        hasCredMgmt,
        pinRetries,
        minPinLength,
        probeError: false,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < retries && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return {
    hasClientPin: null,
    hasCredMgmt: false,
    pinRetries: null,
    minPinLength: 4,
    probeError: true,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr || 'Capability probe failed'),
  };
}

/**
 * Lists resident (discoverable) credentials for a given rpId using `fido2-token -L -k`.
 * Returns an empty array if credential management is unsupported or querying fails.
 * @param {object} params
 * @param {string} params.devicePath
 * @param {string} params.rpId
 * @param {string|null} [params.pin]
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.spawnFn]
 * @returns {Promise<Array<{ credentialId: string, userId: string|null }>>}
 */
export function listResidentCredentials({
  devicePath,
  rpId,
  pin = null,
  timeoutMs = 5000,
  spawnFn = spawn,
}) {
  return new Promise((resolve) => {
    if (!devicePath || !rpId) {
      resolve([]);
      return;
    }

    let proc;
    try {
      proc = spawnFn('fido2-token', ['-L', '-k', rpId, devicePath], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve([]);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let pinWritten = false;

    const killProcessGroup = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try { proc.kill('SIGKILL'); } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessGroup();
      resolve([]);
    }, timeoutMs);

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (pin && !pinWritten && stderr.includes('Enter PIN for')) {
        pinWritten = true;
        try {
          proc.stdin.write(pin + '\n');
          proc.stdin.end();
        } catch {}
      }
    });

    if (!pin) {
      try { proc.stdin.end(); } catch {}
    }

    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve([]);
    });

    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve([]);
        return;
      }
      const results = [];
      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        // The display name may contain whitespace. The user ID precedes the
        // algorithm and protection fields, followed by an optional payment flag.
        const match = line.match(/^\d+:\s+(\S+)\s+.*?\s+([a-zA-Z0-9+/]+={0,2})\s+(?:es256|es384|rs256|eddsa|unknown)\s+\S+(?:\s+(?:no)?pay)?$/);
        if (!match) continue;
        try {
          const credentialId = bufferToBase64Url(Buffer.from(match[1], 'base64'));
          const userId = match[2] ? bufferToBase64Url(Buffer.from(match[2], 'base64')) : null;
          if (credentialId) results.push({ credentialId, userId });
        } catch {}
      }
      resolve(results);
    });
  });
}

/**
 * Runs fido2-assert to obtain an assertion from a FIDO2 security key.
 * Spawns the child detached in a new process group so that /dev/tty is not used,
 * allowing PIN input via stdin and clean process group termination on cancel/timeout.
 *
 * @param {object} params
 * @param {string} params.devicePath
 * @param {string} params.rpId
 * @param {Buffer} params.clientDataHash
 * @param {string} [params.credentialId]
 * @param {boolean} [params.isResident]
 * @param {string|null} [params.pin]
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.spawnFn]
 * @returns {Promise<string>} stdout output
 */
export function executeAssertion({
  devicePath,
  rpId,
  clientDataHash,
  credentialId = '',
  isResident = false,
  pin = null,
  timeoutMs = 60000,
  signal = null,
  spawnFn = spawn,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(CANCELLED_MESSAGE));
      return;
    }

    const args = ['-G'];
    if (isResident) {
      args.push('-r');
    }
    if (pin) {
      args.push('-v');
    }
    args.push(devicePath);

    const inputLines = [
      clientDataHash.toString('base64'),
      rpId,
    ];
    if (!isResident && credentialId) {
      inputLines.push(base64UrlToBuffer(credentialId).toString('base64'));
    }

    let proc;
    try {
      proc = spawnFn('fido2-assert', args, {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`NotAllowedError: Could not spawn fido2-assert: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let pinWritten = false;

    const killProcessGroup = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try { proc.kill('SIGKILL'); } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessGroup();
      reject(new Error(`NotAllowedError: fido2-assert timed out after ${timeoutMs}ms waiting for security key interaction`));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup();
      reject(new Error(CANCELLED_MESSAGE));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      stderr += text;

      // Monitor for PIN prompt from libfido2 readpassphrase fallback
      if (pin && !pinWritten && stderr.includes('Enter PIN for')) {
        pinWritten = true;
        try {
          proc.stdin.write(pin + '\n');
          proc.stdin.end();
        } catch {}
      }
    });

    // Write parameters to stdin
    try {
      proc.stdin.write(inputLines.join('\n') + '\n');
      if (!pin) {
        proc.stdin.end();
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        killProcessGroup();
        reject(err);
      }
      return;
    }

    proc.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`NotAllowedError: ${err.message}`));
    });

    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);

      if (code === 0) {
        resolve(stdout);
      } else {
        const stderrSanitized = stderr.replace(/Enter PIN for[^\n]*/g, '[PIN prompt]').trim();
        const makeFidoError = (message, fidoCode) => {
          const err = new Error(message);
          if (fidoCode) err.fidoCode = fidoCode;
          return err;
        };
        if (stderrSanitized.includes('FIDO_ERR_PIN_INVALID') || stderrSanitized.includes('bad PIN')) {
          reject(makeFidoError('NotAllowedError: Invalid PIN for security key', 'FIDO_ERR_PIN_INVALID'));
        } else if (stderrSanitized.includes('FIDO_ERR_PIN_BLOCKED')) {
          reject(makeFidoError('NotAllowedError: Security key PIN is blocked due to too many failed attempts', 'FIDO_ERR_PIN_BLOCKED'));
        } else if (stderrSanitized.includes('FIDO_ERR_PIN_AUTH_BLOCKED')) {
          reject(makeFidoError('NotAllowedError: Security key PIN authentication is temporarily blocked. Reinsert your security key.', 'FIDO_ERR_PIN_AUTH_BLOCKED'));
        } else if (stderrSanitized.includes('FIDO_ERR_PIN_NOT_SET')) {
          reject(makeFidoError('NotAllowedError: Security key does not have a PIN configured', 'FIDO_ERR_PIN_NOT_SET'));
        } else if (stderrSanitized.includes('FIDO_ERR_PIN_REQUIRED')) {
          reject(makeFidoError('NotAllowedError: Security key requires a PIN', 'FIDO_ERR_PIN_REQUIRED'));
        } else if (stderrSanitized.includes('FIDO_ERR_NO_CREDENTIALS')) {
          reject(makeFidoError('NotAllowedError: No matching credentials found on security key', 'FIDO_ERR_NO_CREDENTIALS'));
        } else {
          reject(new Error(`NotAllowedError: fido2-assert exited with code ${code}: ${stderrSanitized || 'Device error'}`));
        }
      }
    });
  });
}
