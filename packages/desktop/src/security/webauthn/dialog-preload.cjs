const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webauthnPin', Object.freeze({
  submit: (payload) => {
    if (payload && typeof payload.pin === 'string') {
      ipcRenderer.send('workbench:webauthn:pin-submit', {
        requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
        pin: payload.pin,
      });
    }
  },
  cancel: (payload) => {
    ipcRenderer.send('workbench:webauthn:pin-cancel', {
      requestId: payload && typeof payload.requestId === 'string' ? payload.requestId : '',
    });
  },
}));
