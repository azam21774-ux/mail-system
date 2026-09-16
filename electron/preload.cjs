const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openChromeProfile: (profileId, port) =>
    ipcRenderer.invoke('open-chrome-profile', profileId, port),

  checkChromeProfile: (port) =>
    ipcRenderer.invoke('check-chrome-profile', port),

  startProfile: (port) =>
    ipcRenderer.invoke('start-profile', port),

  runCampaign: (payload) =>
    ipcRenderer.invoke('run-campaign', payload),

  runApiCampaign: (payload) =>
    ipcRenderer.invoke('run-api-campaign', payload),

  stopCampaign: (campaignId) =>
    ipcRenderer.invoke('stop-campaign', campaignId),

  connectGmail: (clientId) => ipcRenderer.invoke('connect-gmail', clientId),

  listGmailAccounts: () => ipcRenderer.invoke('list-gmail-accounts'),

  disconnectGmail: (accountId) =>
    ipcRenderer.invoke('disconnect-gmail', accountId),

  renderHtmlAsset: (payload) =>
    ipcRenderer.invoke('render-html-asset', payload),

  createXlsxFromImage: (payload) =>
    ipcRenderer.invoke('create-xlsx-from-image', payload),

  convertPngToHeic: (payload) =>
    ipcRenderer.invoke('convert-png-to-heic', payload),

  onCampaignProgress: (handler) => {
    const listener = (_event, progress) => handler(progress)
    ipcRenderer.on('campaign-progress', listener)

    return () => ipcRenderer.removeListener('campaign-progress', listener)
  },
})
