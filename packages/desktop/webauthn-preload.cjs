// Isolated preload script for WebAuthn support in ChatGPT WebContents.
// Runs with contextIsolation: true and sandbox: true.
// Wraps navigator.credentials.get and .create in the main world.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Expose minimal, unprivileged WebAuthn bridge to the isolated world
contextBridge.exposeInMainWorld('__mawWebAuthn', Object.freeze({
  get: (options) => ipcRenderer.invoke('maw:webauthn:get', options),
  isAvailable: () => ipcRenderer.invoke('maw:webauthn:is-available'),
}));

// Install the navigator.credentials wrapper in the main world
const injectScript = `
(() => {
  if (!navigator.credentials || !window.__mawWebAuthn) return;
  if (window.__mawWebAuthnInstalled) return;
  window.__mawWebAuthnInstalled = true;

  const originalGet = navigator.credentials.get.bind(navigator.credentials);

  function bufferToBase64Url(buf) {
    if (!buf) return '';
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBuffer(str) {
    if (!str) return new ArrayBuffer(0);
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  navigator.credentials.get = async function(options) {
    if (!options || !options.publicKey) {
      return originalGet(options);
    }

    // Pass through conditional mediation (ambient passkey autofill probes)
    if (options.mediation === 'conditional') {
      return originalGet(options);
    }
    if (!(await window.__mawWebAuthn.isAvailable()).available) {
      return originalGet(options);
    }

    const publicKey = options.publicKey;
    const serialized = {
      challenge: bufferToBase64Url(publicKey.challenge),
      rpId: publicKey.rpId || window.location.hostname,
      timeout: publicKey.timeout ? Math.floor(publicKey.timeout / 1000) : 60,
      userVerification: publicKey.userVerification || 'preferred',
      allowCredentials: (publicKey.allowCredentials || []).map(c => ({
        id: bufferToBase64Url(c.id),
        type: c.type || 'public-key',
        transports: c.transports || ['usb'],
      })),
    };

    const res = await window.__mawWebAuthn.get(serialized);
    if (!res || !res.success) {
      const errName = res?.error?.name || 'NotAllowedError';
      const errMsg = res?.error?.message || 'WebAuthn assertion failed';
      throw new DOMException(errMsg, errName);
    }

    const data = res.data;
    const authDataBuf = base64UrlToBuffer(data.authenticatorData);
    const clientDataBuf = base64UrlToBuffer(data.clientDataJSON);
    const sigBuf = base64UrlToBuffer(data.signature);
    const userHandleBuf = data.userHandle ? base64UrlToBuffer(data.userHandle) : null;
    const rawIdBuf = base64UrlToBuffer(data.rawId);

    const response = Object.create(AuthenticatorAssertionResponse.prototype, {
      authenticatorData: { value: authDataBuf, enumerable: true },
      clientDataJSON: { value: clientDataBuf, enumerable: true },
      signature: { value: sigBuf, enumerable: true },
      userHandle: { value: userHandleBuf, enumerable: true },
      getAuthenticatorData: { value: () => authDataBuf, enumerable: false },
    });

    const credential = Object.create(PublicKeyCredential.prototype, {
      id: { value: data.credentialId, enumerable: true },
      rawId: { value: rawIdBuf, enumerable: true },
      type: { value: 'public-key', enumerable: true },
      authenticatorAttachment: { value: 'cross-platform', enumerable: true },
      response: { value: response, enumerable: true },
      getClientExtensionResults: { value: () => ({}), enumerable: true },
      toJSON: {
        value: () => ({
          id: data.credentialId,
          rawId: data.rawId,
          type: 'public-key',
          authenticatorAttachment: 'cross-platform',
          clientExtensionResults: {},
          response: {
            authenticatorData: data.authenticatorData,
            clientDataJSON: data.clientDataJSON,
            signature: data.signature,
            userHandle: data.userHandle || null,
          },
        }),
        enumerable: true,
      },
    });

    return credential;
  };

})();
`;

void webFrame.executeJavaScript(injectScript).catch(() => {});
