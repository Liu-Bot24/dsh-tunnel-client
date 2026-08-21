const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshTunnel', Object.freeze({
  listEndpoints: () => ipcRenderer.invoke('endpoints:list'),
  saveEndpoint: (endpoint) => ipcRenderer.invoke('endpoints:save', endpoint),
  deleteEndpoint: (id) => ipcRenderer.invoke('endpoints:delete', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  startTunnel: (id) => ipcRenderer.invoke('tunnels:start', id),
  stopTunnel: (id) => ipcRenderer.invoke('tunnels:stop', id),
  openEndpoint: (id) => ipcRenderer.invoke('endpoints:open', id),
  startLocalDsh: () => ipcRenderer.invoke('local-dsh:start'),
  saveLocalDsh: (endpoint) => ipcRenderer.invoke('local-dsh:save', endpoint),
  stopLocalDsh: () => ipcRenderer.invoke('local-dsh:stop'),
  openLocalDsh: () => ipcRenderer.invoke('local-dsh:open'),
  onTunnelState: (listener) => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('tunnels:state', handler)
    return () => ipcRenderer.removeListener('tunnels:state', handler)
  },
  onLocalDshState: (listener) => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('local-dsh:state', handler)
    return () => ipcRenderer.removeListener('local-dsh:state', handler)
  },
}))
