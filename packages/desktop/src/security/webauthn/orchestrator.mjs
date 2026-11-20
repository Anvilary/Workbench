/**
 * WebAuthn assertion orchestration for hardware FIDO2 security keys.
 * Handles bounded device/credential iteration, multi-attempt PIN retries,
 * popup-safe dialog bounds resolution, resident credential ID lookup,
 * and clear error diagnostics.
 */

import {
  generateClientData,
  parseFido2AssertOutput,
  classifyWebAuthnError,
  isValidWebAuthnPin,
  validAssertionOptions,
  verifyAssertionData,
} from './policy.mjs';
import {
  CANCELLED_MESSAGE,
  NO_DEVICE_MESSAGE,
  discoverFido2Devices,
  getDeviceCapabilities,
  listResidentCredentials,
  executeAssertion,
} from './backend.mjs';

export const MAX_WEBAUTHN_DEVICES = 8;
export const MAX_PIN_ATTEMPTS = 3;

/**
 * Resolves PIN dialog positioning bounds relative to the owning BrowserWindow.
 * For authentication popups (`parentWin !== mainWin`), returns `null` so the
 * dialog centers inside the popup window rather than using main-window view bounds.
 */
export function resolveWebAuthnPaneBounds({
  parentWin,
  mainWin,
  senderWebContents,
  attachedViews,
}) {
  if (!parentWin || parentWin !== mainWin || !attachedViews) {
    return null;
  }
  for (const view of attachedViews.values()) {
    if (view?.webContents === senderWebContents) {
      try {
        return view.getBounds();
      } catch {
        return null;
      }
    }
  }
  return null;
}

function hasFidoError(err, code, fallbackSubstring) {
  if (!err) return false;
  if (err.fidoCode === code) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(code) || (fallbackSubstring ? msg.includes(fallbackSubstring) : false);
}

/**
 * Orchestrates WebAuthn assertion across discovered FIDO2 HID devices and
 * `allowCredentials` with up to 3 PIN retry attempts on invalid PIN.
 */
export async function performWebAuthnAssertion({
  options,
  origin,
  parentWin = null,
  paneBounds = null,
  signal = null,
  deps = {},
}) {
  const discoverDevices = deps.discoverFido2Devices || discoverFido2Devices;
  const readCaps = deps.getDeviceCapabilities || getDeviceCapabilities;
  const listResident = deps.listResidentCredentials || listResidentCredentials;
  const runAssertion = deps.executeAssertion || executeAssertion;
  const promptPin = deps.requestPinDialog;
  const parseOutput = deps.parseFido2AssertOutput || parseFido2AssertOutput;
  const classifyError = deps.classifyWebAuthnError || classifyWebAuthnError;

  const cancelledResult = () => ({
    success: false,
    error: { name: 'NotAllowedError', message: CANCELLED_MESSAGE },
  });

  if (signal?.aborted) {
    return cancelledResult();
  }

  if (!validAssertionOptions(options, origin)) {
    return { success: false, error: { name: 'SecurityError', message: 'Invalid WebAuthn assertion options' } };
  }

  const discovered = deps.discoverFido2Devices
    ? await discoverDevices({ signal })
    : await discoverDevices(undefined, { signal });
  if (signal?.aborted) {
    return cancelledResult();
  }
  if (!Array.isArray(discovered) || discovered.length === 0) {
    return {
      success: false,
      error: { name: 'NotAllowedError', message: NO_DEVICE_MESSAGE },
    };
  }

  const devices = discovered.slice(0, MAX_WEBAUTHN_DEVICES);
  const probed = [];
  for (const device of devices) {
    if (signal?.aborted) {
      return cancelledResult();
    }
    const caps = deps.getDeviceCapabilities
      ? await readCaps(device.path, { signal })
      : await readCaps(device.path, undefined, { signal });
    probed.push({ device, caps });
  }
  if (signal?.aborted) {
    return cancelledResult();
  }

  // Prefer devices whose capability probe succeeded before devices with probe errors.
  const orderedDevices = [
    ...probed.filter(entry => !entry.caps?.probeError),
    ...probed.filter(entry => entry.caps?.probeError),
  ];

  const rpId = String(options.rpId).toLowerCase();
  const challengeBase64Url = options?.challenge || '';
  const { clientDataJSONBuffer, clientDataHash } = generateClientData('webauthn.get', challengeBase64Url, origin);
  const userVerification = options?.userVerification || 'preferred';
  const timeoutMs = Math.max(1000, Math.min(60000, (options.timeout ?? 60) * 1000));
  const allowCredentials = options.allowCredentials ?? [];
  const isResident = allowCredentials.length === 0;

  let lastError = null;

  const tryDeviceWithPin = async (device, caps, pin) => {
    if (signal?.aborted) {
      throw new Error(CANCELLED_MESSAGE);
    }
    if (isResident) {
      const stdout = await runAssertion({
        devicePath: device.path,
        rpId,
        clientDataHash,
        credentialId: '',
        isResident: true,
        pin,
        timeoutMs,
        signal,
      });

      if (signal?.aborted) {
        throw new Error(CANCELLED_MESSAGE);
      }

      let residentCredentials = [];
      if (pin && caps?.hasCredMgmt !== false && typeof listResident === 'function') {
        try {
          residentCredentials = await listResident({
            devicePath: device.path,
            rpId,
            pin,
            signal,
          });
        } catch {
          residentCredentials = [];
        }
      }

      if (signal?.aborted) {
        throw new Error(CANCELLED_MESSAGE);
      }

      const data = parseOutput(stdout, {
        rpId,
        credentialId: '',
        clientDataJSONBuffer,
        residentCredentials,
      });
      verifyAssertionData(data, rpId, userVerification === 'required');
      return { matched: true, data };
    }

    for (const cred of allowCredentials) {
      if (signal?.aborted) {
        throw new Error(CANCELLED_MESSAGE);
      }
      try {
        const stdout = await runAssertion({
          devicePath: device.path,
          rpId,
          clientDataHash,
          credentialId: cred.id,
          isResident: false,
          pin,
          timeoutMs,
          signal,
        });
        const data = parseOutput(stdout, {
          rpId,
          credentialId: cred.id,
          clientDataJSONBuffer,
        });
        verifyAssertionData(data, rpId, userVerification === 'required');
        return { matched: true, data };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (hasFidoError(err, 'FIDO_ERR_NO_CREDENTIALS', 'No matching credentials')) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    return { matched: false };
  };

  for (const { device, caps } of orderedDevices) {
    if (signal?.aborted) {
      return cancelledResult();
    }
    if (userVerification === 'required' && caps?.hasClientPin === false && !caps?.probeError) {
      lastError = new Error('NotAllowedError: Security key cannot verify the user with a PIN');
      continue;
    }
    let needsPin =
      (caps?.hasClientPin === true || caps?.probeError === true) &&
      (userVerification === 'required' || userVerification === 'preferred');

    if (needsPin && caps?.pinRetries === 0) {
      lastError = new Error('NotAllowedError: Security key PIN is blocked due to too many failed attempts');
      continue;
    }

    if (!needsPin) {
      try {
        const res = await tryDeviceWithPin(device, caps, null);
        if (res.matched) {
          return { success: true, data: res.data };
        }
        continue;
      } catch (err) {
        if (signal?.aborted) {
          return cancelledResult();
        }
        if (hasFidoError(err, 'FIDO_ERR_PIN_REQUIRED', 'requires a PIN') && typeof promptPin === 'function') {
          needsPin = true;
        } else if (hasFidoError(err, 'FIDO_ERR_NO_CREDENTIALS', 'No matching credentials')) {
          lastError = err;
          continue;
        } else {
          lastError = err;
          continue;
        }
      }
    }

    if (needsPin) {
      if (typeof promptPin !== 'function') {
        return {
          success: false,
          error: { name: 'NotAllowedError', message: 'NotAllowedError: PIN dialog handler unavailable' },
        };
      }

      let pinError = '';
      const maxAttempts = Math.min(MAX_PIN_ATTEMPTS, caps?.pinRetries ?? MAX_PIN_ATTEMPTS);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
          return cancelledResult();
        }
        let pin = null;
        try {
          pin = await promptPin({
            parentWindow: parentWin,
            paneBounds,
            rpId,
            title: 'Security Key PIN',
            error: pinError,
            signal,
          });
        } catch (dialogErr) {
          return { success: false, error: classifyError(dialogErr) };
        }
        if (signal?.aborted) {
          return cancelledResult();
        }
        if (!isValidWebAuthnPin(pin)) {
          return { success: false, error: { name: 'NotAllowedError', message: 'Invalid security key PIN input' } };
        }

        try {
          const res = await tryDeviceWithPin(device, caps, pin);
          if (res.matched) {
            return { success: true, data: res.data };
          }
          break;
        } catch (err) {
          if (signal?.aborted) {
            return cancelledResult();
          }
          if (hasFidoError(err, 'FIDO_ERR_PIN_BLOCKED', 'PIN is blocked') ||
              hasFidoError(err, 'FIDO_ERR_PIN_AUTH_BLOCKED', 'temporarily blocked')) {
            return { success: false, error: classifyError(err) };
          }
          if (userVerification !== 'required' && hasFidoError(err, 'FIDO_ERR_PIN_NOT_SET', 'does not have a PIN')) {
            try {
              const fallbackRes = await tryDeviceWithPin(device, caps, null);
              if (fallbackRes.matched) {
                return { success: true, data: fallbackRes.data };
              }
              break;
            } catch (fallbackErr) {
              if (signal?.aborted) {
                return cancelledResult();
              }
              lastError = fallbackErr;
              break;
            }
          }
          if (hasFidoError(err, 'FIDO_ERR_PIN_INVALID', 'Invalid PIN')) {
            lastError = err;
            if (attempt < maxAttempts) {
              const remaining = maxAttempts - attempt;
              pinError = `Incorrect PIN. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`;
              continue;
            }
            return { success: false, error: classifyError(err) };
          }
          if (hasFidoError(err, 'FIDO_ERR_NO_CREDENTIALS', 'No matching credentials')) {
            lastError = err;
            break;
          }
          lastError = err;
          break;
        } finally {
          pin = null;
        }
      }
    }
  }

  return {
    success: false,
    error: classifyError(lastError || new Error('NotAllowedError: No matching credentials found on security key')),
  };
}
