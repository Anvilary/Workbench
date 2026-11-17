const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webauthnPin', Object.freeze({
  submit: (pin) => {
    if (typeof pin === 'string') {
      ipcRenderer.send('maw:webauthn:pin-submit', pin);
    }
  },
  cancel: () => {
    ipcRenderer.send('maw:webauthn:pin-cancel');
  },
}));
