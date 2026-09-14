const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } = require('electron')
const { DEFAULT_THEME, EndpointStore, SettingsStore, normalizeSettings } = require('./core/store.cjs')
const { normalizeEndpoint, loopbackUrl } = require('./core/endpoint.cjs')
const { SshPairingService } = require('./core/ssh-pairing.cjs')
const { TunnelManager, endpointFingerprint } = require('./core/tunnel-manager.cjs')
const { buildTrayMenuTemplate } = require('./core/tray-menu.cjs')
const { CompanionPluginManager, PLUGIN_ARCHIVE, commandEnvironment } = require('./core/companion-plugin-manager.cjs')
const {
  LocalDshManager,
  LocalPortOccupiedError,
  findNextAvailablePort,
  isPortAvailable,
} = require('./core/local-dsh-manager.cjs')
const { resolveDshRuntime } = require('./core/dsh-runtime.cjs')
const { createSerialExecutor } = require('./core/serial-executor.cjs')
const { readRemoteWebAuthUrl } = require('./core/remote-web-auth.cjs')
const { WebAuthHandoffStore } = require('./core/web-auth.cjs')

app.enableSandbox()
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

let mainWindow
let tray
let endpoints = []
let settings
let closing = false
let localDsh
let companionPlugin
const runLocalDshOperation = createSerialExecutor()
let endpointStore
let settingsStore
let webAuthHandoff
let sshPairing
let tunnels
let endpointStoreWritable = true
let bundledDshExecutable
let pluginToolDirectory
let pnpmScriptPath
const indexFile = path.join(__dirname, 'renderer', 'index.html')
const indexUrl = pathToFileURL(indexFile).toString()
const windowsIcon = path.join(__dirname, '..', 'resources', 'app-icon.ico')
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
  assertEndpointStoreWritable()
  const local = normalizeEndpoint({
    id: 'local-dsh',
    mode: 'local',
    name,
    remotePort: port,
  })
  endpoints = endpointStore.save([local, ...endpoints.filter((entry) => entry.mode !== 'local')])
  notifyEndpointsChanged()
  return local
}

function assertEndpointStoreWritable() {
  if (!endpointStoreWritable) throw new Error('主机配置当前为只读，请先修复配置文件')
}

function notifyEndpointsChanged() {
  sendToMainWindow('endpoints:changed', endpoints)
  updateTrayMenu()
}

async function openLocalDsh(port) {
  const publicUrl = `http://127.0.0.1:${port}/`
  await shell.openExternal(await localDsh.resolveOpenUrl(port))
  return publicUrl
}

async function startTunnel(id) {
  const endpoint = findEndpoint(id)
  if (endpoint.mode !== 'ssh') throw new Error('本机直连不需要 SSH 隧道')
  return tunnels.start(endpoint)
}

async function stopTunnel(id) {
  findEndpoint(id)
  return tunnels.stop(id)
}

async function resolveEndpointUrl(id) {
  const endpoint = findEndpoint(id)
  let url
  if (endpoint.mode === 'ssh') {
    const state = tunnels.get(id)
    if (state?.state !== 'connected') throw new Error('请先连接，再打开 DSH')
    url = await tunnels.resolveOpenUrl(id)
  } else {
    const state = await localDsh.inspect(endpoint.remotePort)
    if (state.state !== 'running') throw new Error('本机 DSH 尚未启动')
    url = await localDsh.resolveOpenUrl(endpoint.remotePort)
  }
  return url
}

async function openEndpoint(id) {
  await shell.openExternal(await resolveEndpointUrl(id))
  return loopbackUrl(findEndpoint(id))
}

async function startLocalDsh() {
  let port = localEndpoint()?.remotePort ?? 3080
  let state
  try {
    state = await localDsh.start(port)
  } catch (error) {
    if (!(error instanceof LocalPortOccupiedError)) throw error
    const suggestedPort = await findNextAvailablePort(port + 1)
    const options = {
      type: 'warning',
      title: '本地端口已占用',
      message: `本地端口 ${port} 已被其他程序占用`,
      detail: `可以改用 ${suggestedPort} 启动本机 DSH。`,
      buttons: [`改用 ${suggestedPort}`, '取消'],
      defaultId: 0,
      cancelId: 1,
    }
    const choice = mainWindow?.isVisible()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    if (choice.response !== 0) return { cancelled: true, state: localDsh.getState() }
    assertEndpointStoreWritable()
    port = suggestedPort
    state = await localDsh.start(port)
  }
  if (localEndpoint()?.remotePort !== port) saveLocalEndpoint(endpointStore, port)
  return { cancelled: false, state }
}

async function openLocalDshEndpoint() {
  const endpoint = localEndpoint()
  const port = endpoint?.remotePort ?? localDsh.getState().port
  const state = await localDsh.inspect(port)
  if (state.state !== 'running') throw new Error('本机 DSH 尚未启动')
  return openLocalDsh(port)
}

async function inspectCurrentLocalDsh() {
  const port = localEndpoint()?.remotePort ?? localDsh.getState().port ?? 3080
  return localDsh.inspect(port)
}

function bindLocalDshState() {
  localDsh.on('state', (state) => {
    sendToMainWindow('local-dsh:state', state)
    updateTrayMenu()
  })
}

function configureDshServices(runtime) {
  localDsh?.removeAllListeners('state')
  const environment = commandEnvironment(runtime.environmentExecutable, runtime.environment, {
    toolDirectory: pluginToolDirectory,
    pnpmScriptPath,
  })
  localDsh = new LocalDshManager({
    cwd: app.getPath('home'),
    executable: runtime.executable,
    commandArgs: runtime.commandArgs,
    resolveVersion: runtime.resolveVersion,
    noOpenSupported: runtime.noOpenSupported,
    startupTimeout: runtime.startupTimeout,
    environment,
    authHandoff: webAuthHandoff,
  })
  companionPlugin = new CompanionPluginManager({
    homeDirectory: app.getPath('home'),
    dshHome: process.env.DSH_HOME,
    dshExecutable: runtime.executable,
    dshArguments: runtime.commandArgs,
    nodeExecutable: process.execPath,
    packagePath: app.isPackaged
      ? path.join(process.resourcesPath, 'plugins', PLUGIN_ARCHIVE)
      : path.join(__dirname, '..', 'resources', 'plugins', PLUGIN_ARCHIVE),
    toolDirectory: pluginToolDirectory,
    pnpmScriptPath,
  })
  bindLocalDshState()
}

function localDshIsBusy(state = localDsh?.getState()) {
  return Boolean(localDsh?.hasOwnedProcess())
    || Boolean(state?.owned)
    || ['running', 'starting', 'stopping'].includes(state?.state)
}

function registerIpc(endpointStore, settingsStore) {
  ipcMain.handle('endpoints:list', async (event) => {
    assertSender(event)
    const localState = await inspectCurrentLocalDsh()
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
    const running = tunnels.get(normalized.id)
    if (previous && running?.active && endpointFingerprint(previous) !== endpointFingerprint(normalized)) {
      throw new Error('请先断开连接，再修改连接设置')
    }
    const ownsCurrentPort = previous?.mode === 'ssh'
      && previous.localPort === normalized.localPort
      && running?.active
    if (!ownsCurrentPort && !(await isPortAvailable(normalized.localPort))) {
      throw new Error(`本地端口 ${normalized.localPort} 已被占用，请换一个端口`)
    }
    const next = endpoints.filter((entry) => entry.id !== normalized.id)
    next.push(normalized)
    assertEndpointStoreWritable()
    endpoints = endpointStore.save(next)
    notifyEndpointsChanged()
    return normalized
  })

  ipcMain.handle('endpoints:delete', async (event, id) => {
    assertSender(event)
    const endpoint = findEndpoint(id)
    if (endpoint.mode === 'local') throw new Error('本机 DSH 固定显示，不能删除')
    await tunnels.stop(id)
    assertEndpointStoreWritable()
    endpoints = endpointStore.save(endpoints.filter((entry) => entry.id !== id))
    notifyEndpointsChanged()
    return true
  })

  ipcMain.handle('settings:get', (event) => {
    assertSender(event)
    return settings
  })

  ipcMain.handle('settings:save', (event, input) => {
    assertSender(event)
    const nextSettings = normalizeSettings(input)
    const launchCommandChanged = nextSettings.dshLaunchCommand !== settings.dshLaunchCommand
    if (launchCommandChanged && localDshIsBusy()) {
      throw new Error('请先停止本机 DSH，再修改启动命令')
    }
    const runtime = launchCommandChanged
      ? resolveDshRuntime({
          bundledExecutable: bundledDshExecutable,
          launchCommand: nextSettings.dshLaunchCommand,
        })
      : null
    settings = settingsStore.save(nextSettings)
    if (runtime) configureDshServices(runtime)
    mainWindow?.setBackgroundColor(themeBackgrounds[settings.theme])
    return settings
  })

  ipcMain.handle('companion-plugin:status', async (event) => {
    assertSender(event)
    return runLocalDshOperation(async () => companionPlugin.inspect(await inspectCurrentLocalDsh()))
  })

  ipcMain.handle('companion-plugin:install', async (event) => {
    assertSender(event)
    return runLocalDshOperation(async () => companionPlugin.install(await inspectCurrentLocalDsh()))
  })

  ipcMain.handle('companion-plugin:uninstall', async (event) => {
    assertSender(event)
    return runLocalDshOperation(async () => companionPlugin.uninstall(await inspectCurrentLocalDsh()))
  })

  ipcMain.handle('companion-plugin:show-package', (event) => {
    assertSender(event)
    shell.showItemInFolder(companionPlugin.getPackagePath())
    return true
  })

  ipcMain.handle('tunnels:start', async (event, id) => {
    assertSender(event)
    return startTunnel(id)
  })

  ipcMain.handle('ssh-pairing:inspect', async (event, id) => {
    assertSender(event)
    const endpoint = findEndpoint(id)
    if (endpoint.mode !== 'ssh') throw new Error('本机直连不需要 SSH 配对')
    return sshPairing.inspect(endpoint)
  })

  ipcMain.handle('ssh-pairing:pair', async (event, input) => {
    assertSender(event)
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('SSH 配对信息格式不正确')
    }
    const endpoint = findEndpoint(input.endpointId)
    if (endpoint.mode !== 'ssh') throw new Error('本机直连不需要 SSH 配对')
    return sshPairing.pair(endpoint, {
      password: input.password,
      approvedFingerprint: input.approvedFingerprint,
    })
  })

  ipcMain.handle('tunnels:stop', async (event, id) => {
    assertSender(event)
    return stopTunnel(id)
  })

  ipcMain.handle('endpoints:copy-link', async (event, id) => {
    assertSender(event)
    const url = await resolveEndpointUrl(id)
    clipboard.writeText(url)
    return { copied: true }
  })

  ipcMain.handle('endpoints:open', async (event, id) => {
    assertSender(event)
    return openEndpoint(id)
  })

  ipcMain.handle('local-dsh:start', async (event) => {
    assertSender(event)
    return runLocalDshOperation(startLocalDsh)
  })

  ipcMain.handle('local-dsh:save', async (event, input) => {
    assertSender(event)
    return runLocalDshOperation(async () => {
      const current = localEndpoint()
      const normalized = normalizeEndpoint({
        id: 'local-dsh',
        mode: 'local',
        name: input?.name,
        remotePort: input?.remotePort,
      })
      const portChanged = current && current.remotePort !== normalized.remotePort
      if (portChanged && localDshIsBusy()) {
        throw new Error('请先停止本机 DSH，再修改启动端口')
      }
      if (portChanged && !(await isPortAvailable(normalized.remotePort))) {
        throw new Error(`本地端口 ${normalized.remotePort} 已被占用，请换一个端口`)
      }
      saveLocalEndpoint(endpointStore, normalized.remotePort, normalized.name)
      await localDsh.inspect(normalized.remotePort)
      return normalized
    })
  })

  ipcMain.handle('local-dsh:stop', async (event) => {
    assertSender(event)
    return localDsh.stop()
  })

  ipcMain.handle('local-dsh:open', async (event) => {
    assertSender(event)
    return runLocalDshOperation(openLocalDshEndpoint)
  })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function runTrayAction(action, fallback) {
  try {
    await action()
  } catch {
    showMainWindow()
    dialog.showErrorBox('DSH Tunnel', fallback)
  } finally {
    updateTrayMenu()
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const template = buildTrayMenuTemplate({
    endpoints,
    tunnelStates: tunnels.list(),
    localState: localDsh?.getState(),
    actions: {
      showWindow: showMainWindow,
      startLocalAndOpen: () => runTrayAction(() => runLocalDshOperation(async () => {
        const result = await startLocalDsh()
        if (!result.cancelled) await openLocalDshEndpoint()
      }), '本机 DSH 启动失败，请在主窗口查看状态。'),
      openLocal: () => runTrayAction(
        () => runLocalDshOperation(openLocalDshEndpoint),
        'WebUI 无法打开，请在主窗口查看状态。',
      ),
      stopLocal: () => runTrayAction(
        () => localDsh.stop(),
        '本机 DSH 停止失败，请在主窗口查看状态。',
      ),
      connectAndOpen: (id) => runTrayAction(async () => {
        await startTunnel(id)
        await openEndpoint(id)
      }, '连接失败，请在主窗口查看状态。'),
      openRemote: (id) => runTrayAction(() => openEndpoint(id), 'DSH 无法打开，请在主窗口查看状态。'),
      disconnectRemote: (id) => runTrayAction(() => stopTunnel(id), '断开失败，请在主窗口查看状态。'),
      quit: () => app.quit(),
    },
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function createTray() {
  const filename = process.platform === 'win32' ? 'app-icon.ico' : 'trayTemplate.png'
  const resourcePath = process.platform === 'win32'
    ? windowsIcon
    : app.isPackaged
      ? path.join(process.resourcesPath, filename)
      : path.join(__dirname, '..', 'resources', filename)
  const image = nativeImage.createFromPath(resourcePath)
  if (image.isEmpty()) throw new Error(`Tray icon is missing: ${resourcePath}`)
  if (process.platform === 'darwin') image.setTemplateImage(true)

  tray = new Tray(image)
  tray.setToolTip('DSH Tunnel')
  if (process.platform === 'win32') tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  updateTrayMenu()
}

function createWindow() {
  const window = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 760,
    minHeight: 540,
    title: 'DSH Tunnel',
    icon: process.platform === 'win32' ? windowsIcon : undefined,
    backgroundColor: themeBackgrounds[settings?.theme] ?? themeBackgrounds[DEFAULT_THEME],
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (process.platform === 'win32') window.removeMenu()
  mainWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== indexUrl) event.preventDefault()
  })
  window.on('close', (event) => {
    if (closing || process.platform !== 'darwin') return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.loadFile(indexFile)
}

function sendToMainWindow(channel, state) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, state)
  }
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return
  if (process.platform === 'win32') {
    app.setAppUserModelId('app.dshtunnel.client')
    Menu.setApplicationMenu(null)
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  endpointStore = new EndpointStore(path.join(app.getPath('userData'), 'endpoints.json'))
  settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
  sshPairing = new SshPairingService({
    storageDirectory: path.join(app.getPath('userData'), 'ssh'),
    knownHostsPath: path.join(app.getPath('home'), '.ssh', 'known_hosts'),
  })
  webAuthHandoff = new WebAuthHandoffStore({ homeDirectory: app.getPath('home') })
  tunnels = new TunnelManager({
    identityFile: sshPairing.identityFile,
    resolveRemoteAuth: endpoint => readRemoteWebAuthUrl(endpoint, {
      identityFile: sshPairing.identityFile,
      knownHostsPath: sshPairing.knownHostsPath,
    }),
  })
  bundledDshExecutable = path.join(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources'),
    'dsh-runner',
    process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
  )
  pluginToolDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'plugin-tools')
    : path.join(__dirname, '..', 'resources', 'plugin-tools')
  pnpmScriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs')
    : path.join(__dirname, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const defaultLocal = normalizeEndpoint({
    id: 'local-dsh',
    mode: 'local',
    name: '本机 DSH',
    remotePort: 3080,
  })
  const endpointConfiguration = endpointStore.loadOrInitialize([defaultLocal])
  endpoints = endpointConfiguration.entries
  endpointStoreWritable = endpointConfiguration.status !== 'read-only'
  if (endpointConfiguration.status === 'recovered') {
    dialog.showErrorBox('DSH Tunnel', '主机配置已损坏。原文件已备份，并已恢复默认配置。')
  } else if (!endpointStoreWritable) {
    dialog.showErrorBox('DSH Tunnel', '无法安全读取或保存主机配置。当前将以只读模式运行。')
  }
  try {
    settings = settingsStore.load()
  } catch {
    dialog.showErrorBox('DSH Tunnel', '无法读取界面设置，已恢复默认设置。')
    settings = normalizeSettings({})
  }
  const runtime = resolveDshRuntime({
    bundledExecutable: bundledDshExecutable,
    launchCommand: settings.dshLaunchCommand,
  })
  configureDshServices(runtime)
  registerIpc(endpointStore, settingsStore)
  tunnels.on('state', (state) => {
    sendToMainWindow('tunnels:state', state)
    updateTrayMenu()
  })
  await localDsh.inspect(localEndpoint()?.remotePort ?? 3080)
  createWindow()
  createTray()
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('second-instance', showMainWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (closing) return
  event.preventDefault()
  closing = true
  const stopLocal = localDsh?.hasOwnedProcess() ? localDsh.stop() : Promise.resolve()
  Promise.all([tunnels?.stopAll() ?? Promise.resolve(), stopLocal]).then(
    () => app.quit(),
    () => {
      closing = false
      showMainWindow()
      dialog.showErrorBox('DSH Tunnel', '仍有连接或本机 DSH 未能停止，请重试。')
    },
  )
})
