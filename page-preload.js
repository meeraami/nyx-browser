// Runs in every browser tab, but only Nyx's own pages (nyx://settings etc., served from a local file) get the API.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/internal\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('nyx', {
    get: what => ipcRenderer.invoke('nyx:get', what),
    do: (action, data) => ipcRenderer.invoke('nyx:do', action, data),
    on: cb => ipcRenderer.on('nyx:changed', (_e, what) => cb(what)),
  });
}
