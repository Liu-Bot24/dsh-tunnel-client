const fs = require('node:fs')
const path = require('node:path')
const spawn = process.platform === 'win32' ? require('cross-spawn') : require('node:child_process').spawn

const PLUGIN_NAME = 'dsh-plugin-artifact-preview'
const PLUGIN_VERSION = '0.1.4'
const PLUGIN_ARCHIVE = `${PLUGIN_NAME}-${PLUGIN_VERSION}.tgz`

class CompanionPluginManager {
  constructor({
    homeDirectory,
    dshHome = process.env.DSH_HOME,
    dshExecutable = 'dsh',
    packagePath,
    toolDirectory,
    pnpmScriptPath,
    platform = process.platform,
    spawnProcess = spawn,
    readFile = fs.promises.readFile,
    access = fs.promises.access,
    installTimeout = 120_000,
  }) {
    this.homeDirectory = homeDirectory
    this.dshHome = dshHome
    this.dshExecutable = dshExecutable
    this.packagePath = packagePath
    this.toolDirectory = toolDirectory
    this.pnpmScriptPath = pnpmScriptPath
    this.platform = platform
    this.spawnProcess = spawnProcess
    this.readFile = readFile
    this.access = access
    this.installTimeout = installTimeout
  }

  getPackagePath() {
    return this.packagePath
  }

  async inspect(localDshState = { state: 'stopped' }) {
    const [installedVersion, packageAvailable] = await Promise.all([
      this.#installedVersion(),
      this.#exists(this.packagePath),
    ])
    const busy = ['running', 'starting', 'stopping'].includes(localDshState?.state)
    let state = 'missing'
    if (installedVersion) {
      const comparison = compareVersions(installedVersion, PLUGIN_VERSION)
      state = comparison === 0 ? 'installed' : comparison < 0 ? 'outdated' : 'newer'
    }
    return Object.freeze({
      state,
      installedVersion,
      bundledVersion: PLUGIN_VERSION,
      packageAvailable,
      canInstall: packageAvailable && !busy && state !== 'installed' && state !== 'newer',
      blockedByRunningDsh: busy,
    })
  }

  async install(localDshState = { state: 'stopped' }) {
    const before = await this.inspect(localDshState)
    if (before.blockedByRunningDsh) throw new Error('请先停止本机 DSH，再安装配套插件')
    if (!before.packageAvailable) throw new Error('配套插件安装包不可用，请重新安装 DSH Tunnel')
    if (before.state === 'installed' || before.state === 'newer') return before

    let installError = null
    try {
      await runPluginInstall({
        executable: this.dshExecutable,
        packagePath: this.packagePath,
        toolDirectory: this.toolDirectory,
        pnpmScriptPath: this.pnpmScriptPath,
        platform: this.platform,
        spawnProcess: this.spawnProcess,
        timeout: this.installTimeout,
      })
    } catch (error) {
      installError = error
    }
    const after = await this.inspect({ state: 'stopped' })
    if (after.installedVersion && compareVersions(after.installedVersion, PLUGIN_VERSION) >= 0) {
      return after
    }
    if (installError) throw installError
    if (!after.installedVersion || compareVersions(after.installedVersion, PLUGIN_VERSION) < 0) {
      throw new Error('配套插件安装后未能验证')
    }
    return after
  }

  async #installedVersion() {
    const root = this.dshHome || path.join(this.homeDirectory, '.dsh')
    const filename = path.join(root, 'profiles', 'web', 'node_modules', PLUGIN_NAME, 'package.json')
    try {
      const parsed = JSON.parse(await this.readFile(filename, 'utf8'))
      return parsed?.name === PLUGIN_NAME && typeof parsed?.version === 'string' ? parsed.version : null
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
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
  packagePath,
  toolDirectory,
  pnpmScriptPath,
  platform = process.platform,
  spawnProcess = spawn,
  timeout = 120_000,
}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      const packageArgument = platform === 'win32' ? `\"${packagePath}\"` : packagePath
      child = spawnProcess(executable, ['plugin', '--profile', 'web', 'add', packageArgument], {
        env: commandEnvironment(executable, process.env, { toolDirectory, pnpmScriptPath }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      reject(new Error('无法启动 DSH 插件安装程序'))
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
      reject(new Error('配套插件安装超时'))
    }, timeout)
    timer.unref?.()
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('无法启动 DSH 插件安装程序'))
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(translateInstallFailure(`${stdout}\n${stderr}`))
    })
  })
}

function commandEnvironment(executable, environment = process.env, { toolDirectory, pnpmScriptPath } = {}) {
  const executableDirectory = path.isAbsolute(executable) ? path.dirname(executable) : null
  const currentPath = environment.PATH ?? environment.Path ?? environment.path ?? ''
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean)
  const preferred = [toolDirectory, executableDirectory].filter(Boolean)
  const nextPath = [...preferred, ...pathEntries.filter((entry) => !preferred.includes(entry))].join(path.delimiter)
  const next = { ...environment, PATH: nextPath }
  if (pnpmScriptPath) next.DSH_TUNNEL_PNPM_PATH = pnpmScriptPath
  return next
}

function translateInstallFailure(stderr) {
  if (/unable to open database file|ERR_SQLITE_ERROR/i.test(stderr)) {
    return new Error('DSH 插件存储不可写')
  }
  if (/EACCES|EPERM|permission denied|access is denied/i.test(stderr)) {
    return new Error('DSH 插件目录不可写')
  }
  return new Error('配套插件安装失败')
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
  runPluginInstall,
  translateInstallFailure,
}
