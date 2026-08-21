const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron')
const { DEFAULT_THEME, EndpointStore, SettingsStore } = require('./core/store.cjs')
const { normalizeEndpoint, loopbackUrl } = require('./core/endpoint.cjs')
const { TunnelManager } = require('./core/tunnel-manager.cjs')
const {
  LocalDshManager,
  LocalPortOccupiedError,
  findNextAvailablePort,
  isPortAvailable,
} = require('./core/local-dsh-manager.cjs')

app.enableSandbox()

let mainWindow
let endpoints = []
let settings
let closing = false
let localDsh
const tunnels = new TunnelManager()
const indexFile = path.join(__dirname, 'renderer', 'index.html')
const indexUrl = pathToFileURL(indexFile).toString()
const themeBackgrounds = {
  'whale-song': '#061923',
  'nautical-chart': '#f7f3e4',
  phosphor: '#050806',
  'bauhaus-signal': '#f1eedf',
  'soft-porcelain': '#fbfafd',
}

function findEndpoint(id) {
  const endpoint = endpoints.find((entry) => entry.id === id)
  if (endpoint === undefined) throw new Error('没有找到这台主机')
  return endpoint
}

function assertSender(event) {
  if (mainWindow === undefined || event.sender !== mainWindow.webContents || event.senderFrame.url !== indexUrl) {
    throw new Error('请求来源不受信任')
  }
}

function localEndpoint() {
  return endpoints.find((entry) => entry.mode === 'local') ?? null
}

function saveLocalEndpoint(endpointStore, port, name = localEndpoint()?.name ?? '本机 DSH') {
  const local = normalizeEndpoint({
    id: 'local-dsh',
    mode: 'local',
    name,
    remotePort: port,
  })
  endpoints = endpointStore.save([local, ...endpoints.filter((entry) => entry.mode !== 'local')])
  return local
}

async function openLocalDsh(port) {
  const url = `http://127.0.0.1:${port}/`
  await shell.openExternal(url)
  return url
}

function registerIpc(endpointStore, settingsStore) {
  ipcMain.handle('endpoints:list', async (event) => {
    assertSender(event)
    const port = localEndpoint()?.remotePort ?? localDsh.getState().port ?? 3080
    const localState = await localDsh.inspect(port)
    endpoints = [
      ...endpoints.filter((entry) => entry.mode === 'local'),
      ...endpoints.filter((entry) => entry.mode !== 'local'),
    ]
    return { endpoints, tunnels: tunnels.list(), localDsh: localState }
  })

  ipcMain.handle('endpoints:save', async (event, input) => {
    assertSender(event)
    const normalized = normalizeEndpoint(input)
    if (normalized.mode !== 'ssh') throw new Error('本机 DSH 由启动按钮管理')
    const previous = endpoints.find((entry) => entry.id === normalized.id)
    const ownsCurrentPort = previous?.mode === 'ssh'
      && previous.localPort === normalized.localPort
      && tunnels.get(normalized.id)?.state === 'connected'
    if (!ownsCurrentPort && !(await isPortAvailable(normalized.localPort))) {
      throw new Error(`本地端口 ${normalized.localPort} 已被占用，请换一个端口`)
    }
    const next = endpoints.filter((entry) => entry.id !== normalized.id)
    next.push(normalized)
    endpoints = endpointStore.save(next)
    return normalized
  })

  ipcMain.handle('endpoints:delete', async (event, id) => {
    assertSender(event)
    const endpoint = findEndpoint(id)
    if (endpoint.mode === 'local') throw new Error('本机 DSH 固定显示，不能删除')
    await tunnels.stop(id)
    endpoints = endpointStore.save(endpoints.filter((entry) => entry.id !== id))
    return true
  })

  ipcMain.handle('settings:get', (event) => {
    assertSender(event)
    return settings
  })

  ipcMain.handle('settings:save', (event, input) => {
    assertSender(event)
    settings = settingsStore.save(input)
    mainWindow?.setBackgroundColor(themeBackgrounds[settings.theme])
    return settings
  })

  ipcMain.handle('tunnels:start', async (event, id) => {
    assertSender(event)
    const endpoint = findEndpoint(id)
    if (endpoint.mode !== 'ssh') throw new Error('本机直连不需要 SSH 隧道')
    return tunnels.start(endpoint)
  })

  ipcMain.handle('tunnels:stop', async (event, id) => {
    assertSender(event)
    findEndpoint(id)
    return tunnels.stop(id)
  })

  ipcMain.handle('endpoints:open', async (event, id) => {
    assertSender(event)
    const endpoint = findEndpoint(id)
    if (endpoint.mode === 'ssh') {
      const state = tunnels.get(id)
      if (state?.state !== 'connected') throw new Error('请先连接，再打开 DSH')
    } else {
      const state = await localDsh.inspect(endpoint.remotePort)
      if (state.state !== 'running') throw new Error('本机 DSH 尚未启动')
    }
    const url = loopbackUrl(endpoint)
    await shell.openExternal(url)
    return url
  })

  ipcMain.handle('local-dsh:start', async (event) => {
    assertSender(event)
    let port = localEndpoint()?.remotePort ?? 3080
    let state
    try {
      state = await localDsh.start(port)
    } catch (error) {
      if (!(error instanceof LocalPortOccupiedError)) throw error
      const suggestedPort = await findNextAvailablePort(port + 1)
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '本地端口已占用',
        message: `本地端口 ${port} 已被其他程序占用`,
        detail: `可以改用 ${suggestedPort} 启动本机 DSH。`,
        buttons: [`改用 ${suggestedPort}`, '取消'],
        defaultId: 0,
        cancelId: 1,
      })
      if (choice.response !== 0) return { cancelled: true, state: localDsh.getState() }
      port = suggestedPort
      state = await localDsh.start(port)
    }
    saveLocalEndpoint(endpointStore, port)
    return { cancelled: false, state }
  })

  ipcMain.handle('local-dsh:save', async (event, input) => {
    assertSender(event)
    const current = localEndpoint()
    const normalized = normalizeEndpoint({
      id: 'local-dsh',
      mode: 'local',
      name: input?.name,
      remotePort: input?.remotePort,
    })
    const portChanged = current && current.remotePort !== normalized.remotePort
    if (portChanged && localDsh.getState().state === 'running') {
      throw new Error('请先停止本机 DSH，再修改启动端口')
    }
    if (portChanged && !(await isPortAvailable(normalized.remotePort))) {
      throw new Error(`本地端口 ${normalized.remotePort} 已被占用，请换一个端口`)
    }
    saveLocalEndpoint(endpointStore, normalized.remotePort, normalized.name)
    await localDsh.inspect(normalized.remotePort)
    return normalized
  })

  ipcMain.handle('local-dsh:stop', async (event) => {
    assertSender(event)
    return localDsh.stop()
  })

  ipcMain.handle('local-dsh:open', async (event) => {
    assertSender(event)
    const endpoint = localEndpoint()
    const port = endpoint?.remotePort ?? localDsh.getState().port
    const state = await localDsh.inspect(port)
    if (state.state !== 'running') throw new Error('本机 DSH 尚未启动')
    return openLocalDsh(port)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 760,
    minHeight: 540,
    title: 'DSH Tunnel',
    backgroundColor: themeBackgrounds[settings?.theme] ?? themeBackgrounds[DEFAULT_THEME],
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
  const endpointStore = new EndpointStore(path.join(app.getPath('userData'), 'endpoints.json'))
  const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
  localDsh = new LocalDshManager({ cwd: app.getPath('home') })
  try {
    endpoints = endpointStore.load()
  } catch {
    dialog.showErrorBox('DSH Tunnel', '无法读取主机配置。请检查配置文件的格式和权限。')
    endpoints = []
  }
  saveLocalEndpoint(
    endpointStore,
    localEndpoint()?.remotePort ?? 3080,
    localEndpoint()?.name ?? '本机 DSH',
  )
  try {
    settings = settingsStore.load()
  } catch {
    dialog.showErrorBox('DSH Tunnel', '无法读取界面设置，已恢复默认主题。')
    settings = { theme: DEFAULT_THEME }
  }
  registerIpc(endpointStore, settingsStore)
  tunnels.on('state', (state) => mainWindow?.webContents.send('tunnels:state', state))
  localDsh.on('state', (state) => mainWindow?.webContents.send('local-dsh:state', state))
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
  const stopLocal = localDsh?.getState().owned ? localDsh.stop().catch(() => undefined) : Promise.resolve()
  Promise.all([tunnels.stopAll(), stopLocal]).finally(() => app.quit())
})
