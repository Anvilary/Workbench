const { contextBridge, ipcRenderer } = require('electron');
// Only the trusted local MAW renderer receives this preload. Never the website.
contextBridge.exposeInMainWorld('mawChatGpt', Object.freeze({
  command: command => ipcRenderer.invoke('maw:chatgpt', command),
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('maw:chatgpt:state', listener);
    return () => ipcRenderer.removeListener('maw:chatgpt:state', listener);
  },
}));
