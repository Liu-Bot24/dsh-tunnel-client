const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshTunnel', Object.freeze({
  listEndpoints: () => ipcRenderer.invoke('endpoints:list'),
  saveEndpoint: (endpoint) => ipcRenderer.invoke('endpoints:save', endpoint),
  deleteEndpoint: (id) => ipcRenderer.invoke('endpoints:delete', id),
  startTunnel: (id) => ipcRenderer.invoke('tunnels:start', id),
  stopTunnel: (id) => ipcRenderer.invoke('tunnels:stop', id),
  openEndpoint: (id) => ipcRenderer.invoke('endpoints:open', id),
  onTunnelState: (listener) => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('tunnels:state', handler)
    return () => ipcRenderer.removeListener('tunnels:state', handler)
  },
}))
