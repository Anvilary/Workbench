// Hardware interaction with libfido2 CLI utilities (fido2-token, fido2-assert).
// Handles process group isolation, timeout management, clean cancellation,
// and safe PIN stdin transmission without logging secrets.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { base64UrlToBuffer } from './webauthn-policy.mjs';

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
 * @param {string} devicePath
 * @param {Function} [execFn]
 * @returns {Promise<{ hasClientPin: boolean, pinRetries: number|null, minPinLength: number }>}
 */
export async function getDeviceCapabilities(devicePath, execFn = execFileAsync) {
  try {
    const { stdout } = await execFn('fido2-token', ['-I', devicePath]);
    const optionsMatch = stdout.match(/options:\s*(.+)/);
    const options = optionsMatch ? optionsMatch[1].split(',').map(s => s.trim()) : [];
    const hasClientPin = options.includes('clientPin');

    const retriesMatch = stdout.match(/pin retries:\s*(\d+)/i);
    const pinRetries = retriesMatch ? parseInt(retriesMatch[1], 10) : null;

    const minPinMatch = stdout.match(/minpinlen:\s*(\d+)/i);
    const minPinLength = minPinMatch ? parseInt(minPinMatch[1], 10) : 4;

    return {
      hasClientPin,
      pinRetries,
      minPinLength,
    };
  } catch {
    return {
      hasClientPin: false,
      pinRetries: null,
      minPinLength: 4,
    };
  }
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
      if (pin && !pinWritten && text.includes('Enter PIN for')) {
        pinWritten = true;
        try {
          proc.stdin.write(pin + '\n');
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
        if (stderrSanitized.includes('FIDO_ERR_PIN_INVALID') || stderrSanitized.includes('bad PIN')) {
          reject(new Error('NotAllowedError: Invalid PIN for security key'));
        } else if (stderrSanitized.includes('FIDO_ERR_PIN_BLOCKED')) {
          reject(new Error('NotAllowedError: Security key PIN is blocked due to too many failed attempts'));
        } else if (stderrSanitized.includes('FIDO_ERR_NO_CREDENTIALS')) {
          reject(new Error('NotAllowedError: No matching credentials found on security key'));
        } else {
          reject(new Error(`NotAllowedError: fido2-assert exited with code ${code}: ${stderrSanitized || 'Device error'}`));
        }
      }
    });
  });
}
