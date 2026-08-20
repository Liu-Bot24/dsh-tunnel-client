const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron')
const { EndpointStore } = require('./core/store.cjs')
const { normalizeEndpoint, loopbackUrl } = require('./core/endpoint.cjs')
const { TunnelManager } = require('./core/tunnel-manager.cjs')

app.enableSandbox()

let mainWindow
let endpoints = []
let closing = false
const tunnels = new TunnelManager()
const indexFile = path.join(__dirname, 'renderer', 'index.html')
const indexUrl = pathToFileURL(indexFile).toString()

function findEndpoint(id) {
  const endpoint = endpoints.find((entry) => entry.id === id)
  if (endpoint === undefined) throw new Error('Endpoint not found')
  return endpoint
}

function assertSender(event) {
  if (mainWindow === undefined || event.sender !== mainWindow.webContents || event.senderFrame.url !== indexUrl) {
    throw new Error('Untrusted IPC sender')
  }
}

function registerIpc(store) {
  ipcMain.handle('endpoints:list', (event) => {
    assertSender(event)
    return { endpoints, tunnels: tunnels.list() }
  })

  ipcMain.handle('endpoints:save', (event, input) => {
    assertSender(event)
    const normalized = normalizeEndpoint(input)
    const next = endpoints.filter((entry) => entry.id !== normalized.id)
    next.push(normalized)
    endpoints = store.save(next)
    return normalized
  })

  ipcMain.handle('endpoints:delete', async (event, id) => {
    assertSender(event)
    findEndpoint(id)
    await tunnels.stop(id)
    endpoints = store.save(endpoints.filter((entry) => entry.id !== id))
    return true
  })

  ipcMain.handle('tunnels:start', async (event, id) => {
    assertSender(event)
    return tunnels.start(findEndpoint(id))
  })

  ipcMain.handle('tunnels:stop', async (event, id) => {
    assertSender(event)
    findEndpoint(id)
    return tunnels.stop(id)
  })

  ipcMain.handle('endpoints:open', async (event, id) => {
    assertSender(event)
    const endpoint = findEndpoint(id)
    const state = tunnels.get(id)
    if (state?.state !== 'connected') throw new Error('Connect the tunnel before opening DSH')
    const url = loopbackUrl(endpoint)
    await shell.openExternal(url)
    return url
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 760,
    minHeight: 540,
    title: 'DSH Tunnel',
    backgroundColor: '#f4f2ed',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== indexUrl) event.preventDefault()
  })
  mainWindow.loadFile(indexFile)
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  const store = new EndpointStore(path.join(app.getPath('userData'), 'endpoints.json'))
  try {
    endpoints = store.load()
  } catch (error) {
    dialog.showErrorBox('DSH Tunnel', `Unable to read endpoint configuration: ${error.message}`)
    endpoints = []
  }
  registerIpc(store)
  tunnels.on('state', (state) => mainWindow?.webContents.send('tunnels:state', state))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (closing) return
  event.preventDefault()
  closing = true
  tunnels.stopAll().finally(() => app.quit())
})
