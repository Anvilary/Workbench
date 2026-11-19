// Hardware interaction with libfido2 CLI utilities (fido2-token, fido2-assert).
// Handles process group isolation, timeout management, clean cancellation,
// and safe PIN stdin transmission without logging secrets.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { base64UrlToBuffer, bufferToBase64Url } from './webauthn-policy.mjs';

const execFileAsync = promisify(execFile);

export const CANCELLED_MESSAGE = 'NotAllowedError: security key operation cancelled';
export const NO_DEVICE_MESSAGE = 'NotAllowedError: No FIDO2 hardware device found. Please insert your security key.';
export const DEFAULT_FIDO2_PROBE_TIMEOUT_MS = 5000;

function attachStreamErrorGuards(proc) {
  for (const stream of [proc?.stdin, proc?.stdout, proc?.stderr]) {
    if (stream && typeof stream.on === 'function') {
      stream.on('error', () => {});
    }
  }
}

function safeWriteStdin(stdin, data, shouldEnd = false) {
  if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
  try {
    if (typeof data === 'string' && data.length > 0 && typeof stdin.write === 'function') {
      stdin.write(data);
    }
    if (shouldEnd && typeof stdin.end === 'function') {
      stdin.end();
    }
    return true;
  } catch {
    return false;
  }
}

function execWithTimeout(execFn, cmd, args, { timeoutMs = DEFAULT_FIDO2_PROBE_TIMEOUT_MS, signal = null } = {}) {
  if (signal?.aborted) {
    return Promise.reject(new Error(CANCELLED_MESSAGE));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new Error(CANCELLED_MESSAGE));
    const timer = setTimeout(
      () => finish(reject, new Error(`NotAllowedError: ${cmd} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (typeof timer.unref === 'function') timer.unref();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const execOptions = { timeout: timeoutMs, killSignal: 'SIGKILL' };
    if (signal) execOptions.signal = signal;

    Promise.resolve()
      .then(() => execFn(cmd, args, execOptions))
      .then(
        (res) => finish(resolve, res),
        (err) => finish(reject, err),
      );
  });
}

function waitWithSignal(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error(CANCELLED_MESSAGE));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(CANCELLED_MESSAGE));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Checks whether system fido2-tools are available on Linux.
 * @param {string} [fido2TokenPath]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function isFido2ToolsAvailable(fido2TokenPath = 'fido2-token', { timeoutMs = DEFAULT_FIDO2_PROBE_TIMEOUT_MS } = {}) {
  if (process.platform !== 'linux') return false;
  try {
    await execWithTimeout(execFileAsync, fido2TokenPath, ['-V'], { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Discovers connected FIDO2 devices using fido2-token -L.
 * @param {Function} [execFn]
 * @param {{ timeoutMs?: number, signal?: AbortSignal|null }} [options]
 * @returns {Promise<Array<{ path: string, vendor: string, product: string, description: string }>>}
 */
export async function discoverFido2Devices(
  execFn = execFileAsync,
  { timeoutMs = DEFAULT_FIDO2_PROBE_TIMEOUT_MS, signal = null } = {},
) {
  if (signal?.aborted) return [];
  try {
    const { stdout } = await execWithTimeout(execFn, 'fido2-token', ['-L'], { timeoutMs, signal });
    const devices = [];
    const lines = String(stdout || '').trim().split('\n');

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
 * @param {{ retries?: number, retryDelayMs?: number, timeoutMs?: number, signal?: AbortSignal|null }} [options]
 * @returns {Promise<{ hasClientPin: boolean|null, hasCredMgmt: boolean, pinRetries: number|null, minPinLength: number, probeError: boolean, error?: string }>}
 */
export async function getDeviceCapabilities(
  devicePath,
  execFn = execFileAsync,
  { retries = 1, retryDelayMs = 50, timeoutMs = DEFAULT_FIDO2_PROBE_TIMEOUT_MS, signal = null } = {},
) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      lastErr = new Error(CANCELLED_MESSAGE);
      break;
    }
    try {
      const { stdout } = await execWithTimeout(execFn, 'fido2-token', ['-I', devicePath], { timeoutMs, signal });
      const text = String(stdout || '');
      const optionsMatch = text.match(/options:\s*(.+)/);
      const options = optionsMatch ? optionsMatch[1].split(',').map(s => s.trim()) : [];
      const hasClientPin = options.includes('clientPin');
      const hasCredMgmt = options.includes('credMgmt');

      const retriesMatch = text.match(/pin retries:\s*(\d+)/i);
      const pinRetries = retriesMatch ? parseInt(retriesMatch[1], 10) : null;

      const minPinMatch = text.match(/minpinlen:\s*(\d+)/i);
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
      if (signal?.aborted) break;
      if (attempt < retries && retryDelayMs > 0) {
        try {
          await waitWithSignal(retryDelayMs, signal);
        } catch (abortErr) {
          lastErr = abortErr;
          break;
        }
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
 * @param {AbortSignal|null} [params.signal]
 * @param {Function} [params.spawnFn]
 * @returns {Promise<Array<{ credentialId: string, userId: string|null }>>}
 */
export function listResidentCredentials({
  devicePath,
  rpId,
  pin = null,
  timeoutMs = 5000,
  signal = null,
  spawnFn = spawn,
}) {
  return new Promise((resolve) => {
    if (!devicePath || !rpId || signal?.aborted) {
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

    attachStreamErrorGuards(proc);

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

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessGroup();
      resolve([]);
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessGroup();
      resolve([]);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (pin && !pinWritten && stderr.includes('Enter PIN for')) {
        pinWritten = true;
        safeWriteStdin(proc.stdin, pin + '\n', true);
      }
    });

    if (!pin) {
      safeWriteStdin(proc.stdin, '', true);
    }

    proc.on('error', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve([]);
    });

    proc.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
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

    attachStreamErrorGuards(proc);

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
      if (signal) signal.removeEventListener('abort', onAbort);
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
        safeWriteStdin(proc.stdin, pin + '\n', true);
      }
    });

    // Write parameters to stdin (async EPIPE errors are absorbed by attachStreamErrorGuards)
    if (!safeWriteStdin(proc.stdin, inputLines.join('\n') + '\n', !pin)) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        killProcessGroup();
        reject(new Error('NotAllowedError: Failed to write assertion parameters to fido2-assert'));
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
