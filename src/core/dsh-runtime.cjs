const {
  resolveDshExecutable,
  resolveDshVersion,
  supportsNoOpen,
} = require('./local-dsh-manager.cjs')

const DEFAULT_DSH_RUNTIME = 'official-npx'
const SUPPORTED_DSH_RUNTIMES = Object.freeze([DEFAULT_DSH_RUNTIME, 'system'])
const NPX_STARTUP_TIMEOUT = 300_000
const SYSTEM_STARTUP_TIMEOUT = 20_000

function resolveDshRuntime(mode, {
  bundledExecutable,
  platform = process.platform,
  existsSync,
  environment = process.env,
  versionResolver = resolveDshVersion,
} = {}) {
  if (!SUPPORTED_DSH_RUNTIMES.includes(mode)) throw new Error('这个 DSH 运行方式不可用')
  if (mode === DEFAULT_DSH_RUNTIME) {
    if (!bundledExecutable) throw new Error('官方 npx DSH 启动器不可用')
    return Object.freeze({
      mode,
      executable: bundledExecutable,
      environmentExecutable: bundledExecutable,
      version: 'latest',
      noOpenSupported: true,
      startupTimeout: NPX_STARTUP_TIMEOUT,
      resolveVersion: () => null,
    })
  }

  const executable = resolveDshExecutable(platform, existsSync, environment)
  const version = versionResolver(executable, { environment })
  if (!version) throw new Error('没有找到可用的系统 DSH')
  return Object.freeze({
    mode,
    executable,
    environmentExecutable: executable,
    version,
    noOpenSupported: supportsNoOpen(version),
    startupTimeout: SYSTEM_STARTUP_TIMEOUT,
    resolveVersion: () => version,
  })
}

function publicDshRuntime(runtime) {
  return Object.freeze({ mode: runtime.mode, version: runtime.version })
}

module.exports = {
  DEFAULT_DSH_RUNTIME,
  SUPPORTED_DSH_RUNTIMES,
  publicDshRuntime,
  resolveDshRuntime,
}
