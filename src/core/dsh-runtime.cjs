const { resolveDshVersion } = require('./local-dsh-manager.cjs')

const NPX_STARTUP_TIMEOUT = 300_000

function resolveDshRuntime({
  bundledExecutable,
  environment = process.env,
  versionResolver = resolveDshVersion,
} = {}) {
  if (!bundledExecutable) throw new Error('DSH 启动器不可用')
  return Object.freeze({
    executable: bundledExecutable,
    environmentExecutable: bundledExecutable,
    version: null,
    noOpenSupported: null,
    startupTimeout: NPX_STARTUP_TIMEOUT,
    resolveVersion: (executable) => versionResolver(executable, { environment }),
  })
}

module.exports = {
  resolveDshRuntime,
}
