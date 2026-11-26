import { workbenchEnv } from '../../../../packages/shared/src/workbench-env.mjs';
/**
 * IPC handlers of the WebAuthn bridge.
 *
 * Only a main frame of the ChatGPT session on an allowed origin may use it, and
 * only one security key request can be in flight.
 */

import { isAllowedWebAuthnOrigin, isValidRpId } from './webauthn/policy.mjs';
import { isFido2ToolsAvailable } from './webauthn/backend.mjs';
import { requestPinDialog } from './webauthn/dialog.mjs';
import { performWebAuthnAssertion, resolveWebAuthnPaneBounds } from './webauthn/orchestrator.mjs';

export function registerWebAuthnIpc({ ipcMain, BrowserWindow, win, sessionProviderOf, attachedViews }) {
  let activeWebAuthnAbort = null;
  let assertionInProgress = false;
  const extraOrigins = (workbenchEnv('WEBAUTHN_EXTRA_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowedFrame = ({ sender, senderFrame }) => sender && !sender.isDestroyed() &&
    senderFrame && senderFrame === sender.mainFrame &&
    sessionProviderOf(sender.session) === 'chatgpt' &&
    isAllowedWebAuthnOrigin(senderFrame.origin, extraOrigins);

  ipcMain.handle('workbench:webauthn:is-available', async (event) => {
    return { available: allowedFrame(event) && await isFido2ToolsAvailable() };
  });

  ipcMain.handle('workbench:webauthn:get', async (event, options) => {
    const senderWebContents = event.sender;
    if (!allowedFrame(event)) {
      return { success: false, error: { name: 'SecurityError', message: 'WebAuthn is only permitted within the ChatGPT session' } };
    }

    const origin = event.senderFrame.origin;
    const rpId = typeof options?.rpId === 'string' ? options.rpId.toLowerCase() : options?.rpId;
    if (!isValidRpId(rpId, origin)) {
      return { success: false, error: { name: 'SecurityError', message: `Requested rpId ${options?.rpId} does not match origin ${origin}` } };
    }

    const parentWin = BrowserWindow.fromWebContents(senderWebContents) || win;
    const paneBounds = resolveWebAuthnPaneBounds({
      parentWin,
      mainWin: win,
      senderWebContents,
      attachedViews,
    });

    if (assertionInProgress) {
      return { success: false, error: { name: 'NotAllowedError', message: 'A security key request is already in progress' } };
    }
    assertionInProgress = true;
    const controller = new AbortController();
    activeWebAuthnAbort = controller;
    const abortRequest = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    const onStartNavigation = (_navEvent, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) abortRequest();
    };
    senderWebContents.on('destroyed', abortRequest);
    senderWebContents.on('render-process-gone', abortRequest);
    senderWebContents.on('did-start-navigation', onStartNavigation);
    senderWebContents.on('did-navigate', abortRequest);
    try {
      return await performWebAuthnAssertion({
        options: { ...options, rpId },
        origin,
        parentWin,
        paneBounds,
        signal: controller.signal,
        deps: { requestPinDialog },
      });
    } finally {
      if (activeWebAuthnAbort === controller) activeWebAuthnAbort = null;
      if (!senderWebContents.isDestroyed()) {
        senderWebContents.removeListener('destroyed', abortRequest);
        senderWebContents.removeListener('render-process-gone', abortRequest);
        senderWebContents.removeListener('did-start-navigation', onStartNavigation);
        senderWebContents.removeListener('did-navigate', abortRequest);
      }
      assertionInProgress = false;
    }
  });
  return { abortActive: () => { try { activeWebAuthnAbort?.abort(); } catch {} } };
}
