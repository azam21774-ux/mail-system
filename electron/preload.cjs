const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openChromeProfile: (profileId, port) =>
    ipcRenderer.invoke('open-chrome-profile', profileId, port),

  startProfile: (port) =>
    ipcRenderer.invoke('start-profile', port),

  runCampaign: (payload) =>
    ipcRenderer.invoke('run-campaign', payload),

  stopCampaign: (campaignId) =>
    ipcRenderer.invoke('stop-campaign', campaignId),

  convertPngToHeic: (payload) =>
    ipcRenderer.invoke('convert-png-to-heic', payload),

  onCampaignProgress: (handler) => {
    const listener = (_event, progress) => handler(progress)
    ipcRenderer.on('campaign-progress', listener)

    return () => ipcRenderer.removeListener('campaign-progress', listener)
  },
})
