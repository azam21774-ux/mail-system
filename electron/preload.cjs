const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openChromeProfile: (profileId, port) =>
    ipcRenderer.invoke('open-chrome-profile', profileId, port),

  startProfile: (port) =>
    ipcRenderer.invoke('start-profile', port),
})
