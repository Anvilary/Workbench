const { contextBridge, ipcRenderer } = require('electron');
// Only the trusted local MAW renderer receives this preload. Never the website.
contextBridge.exposeInMainWorld('workbench', Object.freeze({
  command: command => ipcRenderer.invoke('workbench:chatgpt', command),
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('workbench:chatgpt:state', listener);
    return () => ipcRenderer.removeListener('workbench:chatgpt:state', listener);
  },
  browseExecutable: options => {
    const command = typeof options?.title === 'string' && options.title
      ? { type: 'browse-executable', title: options.title }
      : { type: 'browse-executable' };
    return ipcRenderer.invoke('workbench:chatgpt', command).then(res => (res && res.ok ? res.path ?? null : null));
  },
}));
