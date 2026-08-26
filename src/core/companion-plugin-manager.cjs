const fs = require('node:fs')
const path = require('node:path')
const spawn = process.platform === 'win32' ? require('cross-spawn') : require('node:child_process').spawn

const PLUGIN_NAME = 'dsh-plugin-artifact-preview'
const PLUGIN_VERSION = '0.1.4'
const PLUGIN_ARCHIVE = `${PLUGIN_NAME}-${PLUGIN_VERSION}.tgz`

class CompanionPluginManager {
  constructor({
    homeDirectory,
    dshHome,
    dshExecutable = 'dsh',
    nodeExecutable = process.execPath,
    packagePath,
    toolDirectory,
    pnpmScriptPath,
    platform = process.platform,
    spawnProcess = spawn,
    readFile = fs.promises.readFile,
    writeFile = fs.promises.writeFile,
    access = fs.promises.access,
    installTimeout = 120_000,
  }) {
    this.homeDirectory = homeDirectory
    this.dshHome = dshHome
    this.dshExecutable = dshExecutable
    this.nodeExecutable = nodeExecutable
    this.packagePath = packagePath
    this.toolDirectory = toolDirectory
    this.pnpmScriptPath = pnpmScriptPath
    this.platform = platform
    this.spawnProcess = spawnProcess
    this.readFile = readFile
    this.writeFile = writeFile
    this.access = access
    this.installTimeout = installTimeout
  }

  getPackagePath() {
    return this.packagePath
  }

  async inspect(localDshState = { state: 'stopped' }) {
    const [installedVersion, packageAvailable, bundleEnabled] = await Promise.all([
      this.#installedVersion(),
      this.#exists(this.packagePath),
      this.#bundleEnabled(),
    ])
    const busy = Boolean(localDshState?.owned)
      || ['running', 'starting', 'stopping'].includes(localDshState?.state)
    let state = 'missing'
    if (installedVersion && bundleEnabled) {
      const comparison = compareVersions(installedVersion, PLUGIN_VERSION)
      state = comparison === 0 ? 'installed' : comparison < 0 ? 'outdated' : 'newer'
    } else if (installedVersion) {
      state = 'inactive'
    } else if (bundleEnabled) {
      state = 'broken'
    }
    return Object.freeze({
      state,
      installedVersion,
      bundleEnabled,
      bundledVersion: PLUGIN_VERSION,
      packageAvailable,
      canInstall: packageAvailable && !busy && !['installed', 'newer'].includes(state),
      canUninstall: !busy && (Boolean(installedVersion) || bundleEnabled),
      blockedByRunningDsh: busy,
    })
  }

  async install(localDshState = { state: 'stopped' }) {
    const before = await this.inspect(localDshState)
    if (before.blockedByRunningDsh) throw new Error('请先停止本机 DSH，再安装配套插件')
    if (!before.packageAvailable) throw new Error('配套插件安装包不可用，请重新安装 DSH Tunnel')
    if (before.state === 'installed' || before.state === 'newer') return before

    if (before.installedVersion && compareVersions(before.installedVersion, PLUGIN_VERSION) >= 0) {
      await this.#setBundleEnabled(true)
      return this.inspect({ state: 'stopped' })
    }

    await this.#ensureProfile()
    let installError = null
    try {
      await runPluginInstall({
        executable: this.dshExecutable,
        nodeExecutable: this.nodeExecutable,
        packagePath: this.packagePath,
        toolDirectory: this.toolDirectory,
        pnpmScriptPath: this.pnpmScriptPath,
        platform: this.platform,
        profileDirectory: this.#profileDirectory(),
        spawnProcess: this.spawnProcess,
        timeout: this.installTimeout,
      })
    } catch (error) {
      installError = error
    }
    let after = await this.inspect({ state: 'stopped' })
    if (after.installedVersion && compareVersions(after.installedVersion, PLUGIN_VERSION) >= 0) {
      await this.#setBundleEnabled(true)
      after = await this.inspect({ state: 'stopped' })
      return after
    }
    if (installError) throw installError
    if (!after.installedVersion || compareVersions(after.installedVersion, PLUGIN_VERSION) < 0) {
      throw new Error('配套插件安装后未能验证')
    }
    return after
  }

  async uninstall(localDshState = { state: 'stopped' }) {
    const before = await this.inspect(localDshState)
    if (before.blockedByRunningDsh) throw new Error('请先停止本机 DSH，再卸载配套插件')
    if (!before.installedVersion) {
      await this.#setBundleEnabled(false)
      return this.inspect({ state: 'stopped' })
    }

    let uninstallError = null
    try {
      await runPluginRemove({
        executable: this.dshExecutable,
        nodeExecutable: this.nodeExecutable,
        toolDirectory: this.toolDirectory,
        pnpmScriptPath: this.pnpmScriptPath,
        platform: this.platform,
        profileDirectory: this.#profileDirectory(),
        spawnProcess: this.spawnProcess,
        timeout: this.installTimeout,
      })
    } catch (error) {
      uninstallError = error
    }
    let after = await this.inspect({ state: 'stopped' })
    if (!after.installedVersion) {
      await this.#setBundleEnabled(false)
      after = await this.inspect({ state: 'stopped' })
      return after
    }
    if (uninstallError) throw uninstallError
    throw new Error('配套插件卸载后未能验证')
  }

  async #installedVersion() {
    const filename = this.#path().join(this.#profileDirectory(), 'node_modules', PLUGIN_NAME, 'package.json')
    try {
      const parsed = JSON.parse(await this.readFile(filename, 'utf8'))
      return parsed?.name === PLUGIN_NAME && typeof parsed?.version === 'string' ? parsed.version : null
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  }

  async #ensureProfile() {
    if (await this.#readProfileManifest()) return
    try {
      await runProfileInitialize({
        executable: this.dshExecutable,
        dshHome: this.#dshRoot(),
        toolDirectory: this.toolDirectory,
        pnpmScriptPath: this.pnpmScriptPath,
        platform: this.platform,
        spawnProcess: this.spawnProcess,
        timeout: this.installTimeout,
      })
    } catch (error) {
      if (/^DSH 插件(?:存储|目录)不可写$/.test(error?.message ?? '')) throw error
      throw new Error('DSH Web 配置初始化失败')
    }
    if (!(await this.#readProfileManifest())) throw new Error('DSH Web 配置初始化失败')
  }

  async #bundleEnabled() {
    const manifest = await this.#readProfileManifest()
    return Array.isArray(manifest?.dsh?.profile?.bundles)
      && manifest.dsh.profile.bundles.includes(PLUGIN_NAME)
  }

  #path() {
    return this.platform === 'win32' ? path.win32 : path.posix
  }

  #profileDirectory() {
    const pathApi = this.#path()
    return pathApi.join(this.#dshRoot(), 'profiles', 'web')
  }

  #dshRoot() {
    return this.dshHome || this.#path().join(this.homeDirectory, '.dsh')
  }

  async #setBundleEnabled(enabled) {
    const manifestPath = this.#path().join(this.#profileDirectory(), 'package.json')
    const manifest = await this.#readProfileManifest()
    if (!manifest) {
      if (!enabled) return
      throw new Error('DSH 插件配置不可用')
    }
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
      ? [...manifest.dsh.profile.bundles]
      : []
    const filtered = bundles.filter((name) => name !== PLUGIN_NAME)
    if (enabled) filtered.push(PLUGIN_NAME)
    if (filtered.length === bundles.length && filtered.every((name, index) => name === bundles[index])) return
    manifest.dsh = {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: filtered,
      },
    }
    await this.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  async #readProfileManifest() {
    const manifestPath = this.#path().join(this.#profileDirectory(), 'package.json')
    try {
      return JSON.parse(await this.readFile(manifestPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      if (error instanceof SyntaxError) throw new Error('DSH 插件配置不可用')
      throw error
    }
  }

  async #exists(filename) {
    try {
      await this.access(filename, fs.constants.R_OK)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }
}

function runPluginInstall({
  executable,
  nodeExecutable,
  packagePath,
  toolDirectory,
  pnpmScriptPath,
  platform = process.platform,
  profileDirectory,
  spawnProcess = spawn,
  timeout = 120_000,
}) {
  if (nodeExecutable && pnpmScriptPath && profileDirectory) {
    return runPluginCommand({
      executable: nodeExecutable,
      args: [pnpmScriptPath, '--dir', profileDirectory, 'add', '--offline', packagePath],
      toolDirectory,
      pnpmScriptPath,
      platform,
      electronRunAsNode: true,
      spawnProcess,
      timeout,
      action: '安装',
    })
  }
  return runPluginCommand({
    executable,
    args: ['plugin', '--profile', 'web', 'add', packagePath],
    toolDirectory,
    pnpmScriptPath,
    platform,
    spawnProcess,
    timeout,
    action: '安装',
  })
}

function runProfileInitialize({
  executable,
  dshHome,
  toolDirectory,
  pnpmScriptPath,
  platform = process.platform,
  spawnProcess = spawn,
  timeout = 120_000,
}) {
  return runPluginCommand({
    executable,
    args: ['--profile', 'web', '--dump-config'],
    toolDirectory,
    pnpmScriptPath,
    platform,
    environment: environmentWithDshHome(process.env, dshHome),
    spawnProcess,
    timeout,
    action: '初始化',
  })
}

function runPluginRemove({
  executable,
  nodeExecutable,
  toolDirectory,
  pnpmScriptPath,
  platform = process.platform,
  profileDirectory,
  spawnProcess = spawn,
  timeout = 120_000,
}) {
  if (nodeExecutable && pnpmScriptPath && profileDirectory) {
    return runPluginCommand({
      executable: nodeExecutable,
      args: [pnpmScriptPath, '--dir', profileDirectory, 'remove', PLUGIN_NAME],
      toolDirectory,
      pnpmScriptPath,
      platform,
      electronRunAsNode: true,
      spawnProcess,
      timeout,
      action: '卸载',
    })
  }
  return runPluginCommand({
    executable,
    args: ['plugin', '--profile', 'web', 'remove', PLUGIN_NAME],
    toolDirectory,
    pnpmScriptPath,
    platform,
    spawnProcess,
    timeout,
    action: '卸载',
  })
}

function runPluginCommand({
  executable,
  args,
  toolDirectory,
  pnpmScriptPath,
  platform,
  environment = process.env,
  electronRunAsNode = false,
  spawnProcess,
  timeout,
  action,
}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnProcess(executable, args, {
        env: commandEnvironment(executable, environment, {
          toolDirectory,
          pnpmScriptPath,
          electronRunAsNode,
        }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      reject(new Error(`无法启动 DSH 插件${action}程序`))
      return
    }
    let settled = false
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-8192)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8192)
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`配套插件${action}超时`))
    }, timeout)
    timer.unref?.()
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法启动 DSH 插件${action}程序`))
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(translatePluginFailure(`${stdout}\n${stderr}`, action))
    })
  })
}

function environmentWithDshHome(environment, dshHome) {
  if (!dshHome) return environment
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'dsh_home'),
    ),
    DSH_HOME: dshHome,
  }
}

function commandEnvironment(
  executable,
  environment = process.env,
  { toolDirectory, pnpmScriptPath, electronRunAsNode = false } = {},
) {
  const executableDirectory = path.isAbsolute(executable) ? path.dirname(executable) : null
  const currentPath = environment.PATH ?? environment.Path ?? environment.path ?? ''
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean)
  const preferred = [toolDirectory, executableDirectory].filter(Boolean)
  const nextPath = [...preferred, ...pathEntries.filter((entry) => !preferred.includes(entry))].join(path.delimiter)
  const next = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'path'),
  )
  next.PATH = nextPath
  if (pnpmScriptPath) next.DSH_TUNNEL_PNPM_PATH = pnpmScriptPath
  if (electronRunAsNode) {
    next.ELECTRON_RUN_AS_NODE = '1'
    next.npm_node_execpath = executable
    next.npm_execpath = pnpmScriptPath
  }
  return next
}

function translateInstallFailure(stderr) {
  return translatePluginFailure(stderr, '安装')
}

function translatePluginFailure(stderr, action) {
  if (/unable to open database file|ERR_SQLITE_ERROR/i.test(stderr)) {
    return new Error('DSH 插件存储不可写')
  }
  if (/EACCES|EPERM|permission denied|access is denied/i.test(stderr)) {
    return new Error('DSH 插件目录不可写')
  }
  return new Error(`配套插件${action}失败`)
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1
  }
  return 0
}

function parseVersion(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1).map(Number) : [0, 0, 0]
}

module.exports = {
  CompanionPluginManager,
  PLUGIN_ARCHIVE,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  compareVersions,
  commandEnvironment,
  environmentWithDshHome,
  runPluginInstall,
  runPluginRemove,
  runProfileInitialize,
  translateInstallFailure,
}
