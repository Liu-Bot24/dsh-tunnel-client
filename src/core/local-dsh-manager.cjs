const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const childProcess = require('node:child_process')
const crossSpawn = process.platform === 'win32' ? require('cross-spawn') : null
const spawn = crossSpawn ?? childProcess.spawn
const spawnSync = crossSpawn?.sync ?? childProcess.spawnSync
const { DSH_AUTH_REQUIRED_BODY, parseDshWebUrlLine } = require('./web-auth.cjs')

const DSH_TITLE = '<title>DeepSeek Harness</title>'
const NO_OPEN_MINIMUM = Object.freeze({ major: 0, minor: 1, patch: 0, rc: 8 })

class LocalPortOccupiedError extends Error {
  constructor(port) {
    super(`本地端口 ${port} 已被其他程序占用`)
    this.name = 'LocalPortOccupiedError'
    this.port = port
  }
}

class DshNotInstalledError extends Error {
  constructor() {
    super('本机未安装 DSH')
    this.name = 'DshNotInstalledError'
  }
}

class LocalDshManager extends EventEmitter {
  constructor({
    spawnProcess = spawn,
    probe = probeLocalService,
    executable = resolveDshExecutable(),
    cwd = process.cwd(),
    environment = process.env,
    startupTimeout = 20_000,
    shutdownTimeout = 5_000,
    pollInterval = 250,
    terminateProcess = terminateChildProcess,
    resolveVersion = resolveDshVersion,
    noOpenSupported = null,
    platform = process.platform,
    authHandoff = null,
  } = {}) {
    super()
    this.spawnProcess = spawnProcess
    this.probe = probe
    this.executable = executable
    this.cwd = cwd
    this.environment = environment
    this.startupTimeout = startupTimeout
    this.shutdownTimeout = shutdownTimeout
    this.pollInterval = pollInterval
    this.terminateProcess = terminateProcess
    this.resolveVersion = resolveVersion
    this.platform = platform
    this.authHandoff = authHandoff
    this.noOpenSupported = typeof noOpenSupported === 'boolean' ? noOpenSupported : null
    this.child = null
    this.startPromise = null
    this.stopPromise = null
    this.startPort = null
    this.startCancelled = false
    this.state = Object.freeze({ state: 'stopped', port: 3080, owned: false, error: null })
  }

  getState() {
    return this.state
  }

  hasOwnedProcess() {
    return Boolean(this.child && !this.child.cleaned)
  }

  getOpenUrl(port = this.state.port) {
    if (this.child && !this.child.cleaned && this.child.port === port && this.child.authUrl) {
      return this.child.authUrl
    }
    return `http://127.0.0.1:${port}/`
  }

  setState(next) {
    const updated = { ...this.state, ...next }
    const unchanged = Object.keys(updated).every((key) => Object.is(updated[key], this.state[key]))
    if (unchanged) return this.state
    this.state = Object.freeze(updated)
    this.emit('state', this.state)
    return this.state
  }

  async inspect(port = this.state.port) {
    if (this.startPromise || this.stopPromise || this.state.state === 'stopping') return this.state
    if (this.hasOwnedProcess()) return this.state
    const result = await this.probe(port)
    if (result === 'dsh' || result === 'dsh-auth') {
      return this.setState({ state: 'running', port, owned: false, error: null })
    }
    if (result === 'occupied') {
      return this.setState({ state: 'error', port, owned: false, error: `本地端口 ${port} 已被其他程序占用` })
    }
    return this.setState({ state: 'stopped', port, owned: false, error: null })
  }

  start(port = 3080) {
    if (this.startPromise) {
      if (this.startPort === port) return this.startPromise
      return Promise.reject(new Error('本机 DSH 正在使用另一个端口启动'))
    }
    if (this.stopPromise || this.state.state === 'stopping') {
      return Promise.reject(new Error('本机 DSH 正在切换状态，请稍后再试'))
    }
    if (this.hasOwnedProcess()) {
      if (this.state.state === 'running' && this.state.port === port) return Promise.resolve(this.state)
      return Promise.reject(new Error('请先停止本机 DSH，再修改启动端口'))
    }

    this.startPort = port
    this.startCancelled = false
    this.startPromise = this.#startClaimed(port).finally(() => {
      this.startPromise = null
      this.startPort = null
      this.startCancelled = false
    })
    return this.startPromise
  }

  async #startClaimed(port) {
    const existing = await this.probe(port)
    if (this.startCancelled) {
      return this.setState({ state: 'stopped', port, owned: false, error: null })
    }
    if (existing === 'dsh' || existing === 'dsh-auth') {
      return this.setState({ state: 'running', port, owned: false, error: null })
    }
    if (existing === 'occupied') throw new LocalPortOccupiedError(port)

    await this.authHandoff?.clear(port)

    this.setState({ state: 'starting', port, owned: false, error: null })
    let child
    try {
      const args = ['web', '--port', String(port)]
      if (this.#supportsNoOpen()) args.push('--no-open')
      child = this.spawnProcess(this.executable, args, {
        cwd: this.cwd,
        env: this.environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Keep each owned POSIX tree separate from the desktop app and other DSH instances.
        detached: this.platform !== 'win32',
      })
    } catch (error) {
      const translated = translateSpawnError(error)
      this.setState({ state: 'error', port, owned: false, error: translated.message || '无法启动 DSH' })
      throw translated
    }

    const info = this.#trackChild(child, port)
    this.child = info
    this.setState({ state: 'starting', port, owned: true, error: null })

    try {
      const outcome = await Promise.race([
        waitForDsh(
          this.probe,
          port,
          this.startupTimeout,
          this.pollInterval,
          () => this.startCancelled || this.child !== info || info.exited,
          async () => {
            if (!info.authUrl) return false
            await info.authPublishPromise
            return true
          },
        ).then(() => ({ type: 'ready' })),
        info.exitPromise,
      ])
      if (outcome.type === 'error') throw translateSpawnError(outcome.error)
      if (outcome.type === 'exit') throw translateStartupFailure(outcome.stderr)
      if (info.exited) throw new Error('DSH 启动失败')
      if (this.startCancelled) throw new Error('DSH 启动已取消')
      return this.setState({ state: 'running', port, owned: true, error: null })
    } catch (error) {
      if (!info.cleaned) {
        info.intentional = true
        try {
          await this.#terminateOwnedChild(info)
        } catch {
          this.setState({ state: 'error', port, owned: true, error: 'DSH 停止失败' })
          throw error
        }
      }
      if (this.startCancelled) {
        this.setState({ state: 'stopped', port, owned: false, error: null })
      } else {
        const translated = translateSpawnError(error)
        this.setState({
          state: 'error',
          port,
          owned: this.hasOwnedProcess(),
          error: translated.message === 'DSH 启动超时' ? translated.message : (translated.message || 'DSH 启动失败'),
        })
      }
      throw error
    }
  }

  #supportsNoOpen() {
    if (this.noOpenSupported !== null) return this.noOpenSupported
    let version = null
    try {
      version = this.resolveVersion(this.executable)
    } catch {}
    this.noOpenSupported = supportsNoOpen(version)
    return this.noOpenSupported
  }

  #trackChild(child, port) {
    const info = {
      process: child,
      exited: false,
      cleaned: false,
      processGroup: this.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0,
      intentional: false,
      terminationPromise: null,
      exitPromise: null,
      port,
      stderr: '',
      stdoutBuffer: '',
      authUrl: null,
      authPublishPromise: Promise.resolve(),
    }
    child.stdout?.on('data', (chunk) => {
      info.stdoutBuffer = `${info.stdoutBuffer}${String(chunk)}`.slice(-8192)
      const lines = info.stdoutBuffer.split(/\r?\n/u)
      info.stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (info.authUrl) break
        const authUrl = parseDshWebUrlLine(line, port)
        if (!authUrl) continue
        info.authUrl = authUrl
        info.authPublishPromise = this.authHandoff
          ? this.authHandoff.publish(port, authUrl, child.pid)
          : Promise.resolve()
      }
    })
    child.stderr?.on('data', (chunk) => {
      info.stderr = `${info.stderr}${String(chunk)}`.slice(-8192)
    })
    info.exitPromise = new Promise((resolve) => {
      child.once('error', (error) => {
        if (child.pid == null) {
          info.exited = true
          info.cleaned = true
          if (this.child === info) this.child = null
        }
        resolve({ type: 'error', error })
      })
      child.once('exit', (code, signal) => {
        info.exited = true
        info.authUrl = null
        this.authHandoff?.remove(port).catch(() => undefined)
        if (!info.processGroup) {
          info.cleaned = true
          if (this.child === info) this.child = null
        }
        resolve({ type: 'exit', code, signal, stderr: info.stderr })
        if (!info.intentional) {
          this.setState({ state: 'error', port, owned: this.hasOwnedProcess(), error: 'DSH 已停止' })
          if (info.processGroup && !this.startPromise) {
            info.intentional = true
            this.#terminateOwnedChild(info).then(
              () => this.setState({ state: 'error', port, owned: this.hasOwnedProcess(), error: 'DSH 已停止' }),
              () => this.setState({ state: 'error', port, owned: true, error: 'DSH 停止失败' }),
            )
          }
        }
      })
    })
    return info
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.#stop().finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  async #stop() {
    if (this.startPromise) {
      this.startCancelled = true
      const starting = this.startPromise
      const port = this.startPort ?? this.state.port
      this.setState({ state: 'stopping', port, owned: this.hasOwnedProcess(), error: null })
      try {
        await starting
      } catch {}
      if (!this.hasOwnedProcess()) {
        return this.setState({ state: 'stopped', port, owned: false, error: null })
      }
    }
    if (this.state.state === 'stopped') return this.state
    if (!this.hasOwnedProcess()) {
      throw new Error('无法停止：DSH 由其他程序启动')
    }

    const info = this.child
    const port = this.state.port
    info.intentional = true
    this.setState({ state: 'stopping', port, owned: true, error: null })
    try {
      await this.#terminateOwnedChild(info)
      await waitForDshStop(this.probe, port, this.shutdownTimeout, this.pollInterval)
      await this.authHandoff?.remove(port)
    } catch (error) {
      this.setState({
        state: 'error',
        port,
        owned: Boolean(this.child === info && !info.cleaned),
        error: 'DSH 停止失败',
      })
      throw error
    }
    return this.setState({ state: 'stopped', port, owned: false, error: null })
  }

  async #terminateOwnedChild(info) {
    if (info.cleaned) return
    if (info.terminationPromise) return info.terminationPromise
    const termination = (async () => {
      await this.terminateProcess(info.process, {
        platform: this.platform,
        processGroup: info.processGroup,
        gracefulTimeout: this.shutdownTimeout,
        forceTimeout: this.shutdownTimeout,
        pollInterval: this.pollInterval,
      })
      if (!info.exited) await waitForChildExit(info, this.shutdownTimeout)
      if (!info.exited) throw new Error('DSH 进程未能退出')
      info.cleaned = true
      if (this.child === info) this.child = null
    })()
    info.terminationPromise = termination
    try {
      await termination
    } finally {
      if (info.terminationPromise === termination) info.terminationPromise = null
    }
  }
}

function translateSpawnError(error) {
  return error?.code === 'ENOENT' ? new DshNotInstalledError() : error
}

function translateStartupFailure(stderr) {
  const diagnostic = String(stderr ?? '')
  if (/未找到 npx|npx(?:\.cmd)?[^\n]*(?:not found|not recognized)|not recognized[^\n]*npx/i.test(diagnostic)) {
    return new Error('未找到 npx，请先安装 Node.js')
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|network request[^\n]*failed|network[^\n]*unavailable/i.test(diagnostic)) {
    return new Error('DSH 下载失败，请检查网络连接')
  }
  if (/ETIMEDOUT|fetch[^\n]*timeout|network[^\n]*timeout/i.test(diagnostic)) {
    return new Error('DSH 下载超时，请检查网络连接')
  }
  return new Error('DSH 启动失败')
}

function resolveDshVersion(executable, {
  spawnSyncProcess = spawnSync,
  environment = process.env,
  timeout = 5_000,
} = {}) {
  const executableDirectory = path.isAbsolute(executable) ? path.dirname(executable) : null
  let nextEnvironment = environment
  if (executableDirectory) {
    const currentPath = environment.PATH ?? environment.Path ?? environment.path ?? ''
    const pathEntries = currentPath.split(path.delimiter).filter(Boolean)
    nextEnvironment = Object.fromEntries(
      Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'path'),
    )
    nextEnvironment.PATH = [
      executableDirectory,
      ...pathEntries.filter((entry) => entry !== executableDirectory),
    ].join(path.delimiter)
  }
  const result = spawnSyncProcess(executable, ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    env: nextEnvironment,
    timeout,
  })
  if (result?.error || result?.status !== 0) return null
  const output = String(result?.stdout ?? '').trim()
  return output || null
}

function supportsNoOpen(version) {
  const match = String(version ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/u)
  if (!match) return false
  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[4] === undefined ? null : Number(match[4]),
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (parsed[key] !== NO_OPEN_MINIMUM[key]) return parsed[key] > NO_OPEN_MINIMUM[key]
  }
  return parsed.rc === null || parsed.rc >= NO_OPEN_MINIMUM.rc
}

async function terminateChildProcess(child, {
  platform = process.platform,
  spawnProcess = spawn,
  processGroup = false,
  signalProcess = process.kill.bind(process),
  gracefulTimeout = 5_000,
  forceTimeout = 5_000,
  pollInterval = 50,
} = {}) {
  if (platform !== 'win32' && processGroup && Number.isInteger(child.pid) && child.pid > 0) {
    const group = -child.pid
    const signal = value => {
      try { signalProcess(group, value); return true } catch (error) {
        if (error.code === 'ESRCH') return false
        throw error
      }
    }
    const gone = async timeout => {
      const deadline = Date.now() + timeout
      do {
        if (!signal(0)) return true
        await delay(Math.min(pollInterval, Math.max(1, deadline - Date.now())))
      } while (Date.now() < deadline)
      return !signal(0)
    }
    if (!signal('SIGTERM') || await gone(gracefulTimeout)) return
    if (!signal('SIGKILL') || await gone(forceTimeout)) return
    throw new Error('DSH 进程树未能退出')
  }
  if (platform !== 'win32' || !Number.isInteger(child.pid)) {
    child.kill()
    return
  }
  return new Promise((resolve, reject) => {
    const killer = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => {
      killer.kill()
      reject(new Error('DSH 进程树终止超时'))
    }, forceTimeout)
    killer.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4096)
    })
    killer.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    killer.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || '无法终止 DSH 进程树'))
    })
  })
}

function waitForChildExit(info, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH 进程未能退出')), timeout)
    info.exitPromise.then(outcome => {
      clearTimeout(timer)
      if (info.exited) resolve(outcome)
      else reject(new Error('DSH 进程未能退出'))
    })
  })
}

function resolveDshExecutable(
  platform = process.platform,
  existsSync = fs.existsSync,
  environment = process.env,
) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const candidates = platform === 'darwin'
    ? ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh']
    : platform === 'win32'
      ? [
          environment.APPDATA && pathApi.join(environment.APPDATA, 'npm', 'dsh.cmd'),
          environment.APPDATA && pathApi.join(environment.APPDATA, 'npm', 'dsh.exe'),
        ].filter(Boolean)
      : ['/usr/local/bin/dsh', '/usr/bin/dsh']
  return candidates.find((candidate) => existsSync(candidate)) ?? 'dsh'
}

function probeLocalService(port, { timeout = 800 } = {}) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/', timeout }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        if (body.length < 64_000) body += chunk
      })
      response.on('end', () => {
        if (body.includes(DSH_TITLE)) return resolve('dsh')
        if (response.statusCode === 401 && body.includes(DSH_AUTH_REQUIRED_BODY)) return resolve('dsh-auth')
        return resolve('occupied')
      })
    })
    request.once('timeout', () => {
      request.destroy()
      resolve('occupied')
    })
    request.once('error', (error) => {
      resolve(error?.code === 'ECONNREFUSED' ? 'free' : 'occupied')
    })
  })
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function findNextAvailablePort(start = 3081, available = isPortAvailable) {
  for (let port = start; port <= 65535; port += 1) {
    if (await available(port)) return port
  }
  throw new Error('没有可用的本地端口')
}

async function waitForDsh(
  probe,
  port,
  timeout,
  interval,
  cancelled = () => false,
  authenticatedReady = async () => false,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error('DSH 启动已取消')
    const result = await probe(port)
    if (result === 'dsh') return
    if (result === 'dsh-auth' && await authenticatedReady()) return
    await delay(interval)
  }
  throw new Error('DSH 启动超时')
}

async function waitForDshStop(probe, port, timeout, interval) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await probe(port) === 'free') return
    await delay(interval)
  }
  throw new Error('DSH 端口仍在响应')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
  DSH_TITLE,
  DshNotInstalledError,
  LocalDshManager,
  LocalPortOccupiedError,
  findNextAvailablePort,
  isPortAvailable,
  probeLocalService,
  resolveDshVersion,
  resolveDshExecutable,
  supportsNoOpen,
  terminateChildProcess,
  waitForDshStop,
}
