const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const childProcess = require('node:child_process')
const crossSpawn = process.platform === 'win32' ? require('cross-spawn') : null
const spawn = crossSpawn ?? childProcess.spawn
const spawnSync = crossSpawn?.sync ?? childProcess.spawnSync

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
    startupTimeout = 20_000,
    shutdownTimeout = 5_000,
    pollInterval = 250,
    terminateProcess = terminateChildProcess,
    resolveVersion = resolveDshVersion,
  } = {}) {
    super()
    this.spawnProcess = spawnProcess
    this.probe = probe
    this.executable = executable
    this.cwd = cwd
    this.startupTimeout = startupTimeout
    this.shutdownTimeout = shutdownTimeout
    this.pollInterval = pollInterval
    this.terminateProcess = terminateProcess
    this.resolveVersion = resolveVersion
    this.noOpenSupported = null
    this.child = null
    this.startPromise = null
    this.startPort = null
    this.startCancelled = false
    this.state = Object.freeze({ state: 'stopped', port: 3080, owned: false, error: null })
  }

  getState() {
    return this.state
  }

  hasOwnedProcess() {
    return Boolean(this.child && !this.child.exited)
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
    if (this.startPromise || this.state.state === 'stopping') return this.state
    if (this.hasOwnedProcess()) return this.state
    const result = await this.probe(port)
    if (result === 'dsh') return this.setState({ state: 'running', port, owned: false, error: null })
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
    if (this.state.state === 'stopping') {
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
    if (existing === 'dsh') return this.setState({ state: 'running', port, owned: false, error: null })
    if (existing === 'occupied') throw new LocalPortOccupiedError(port)

    this.setState({ state: 'starting', port, owned: false, error: null })
    let child
    try {
      const args = ['web', '--port', String(port)]
      if (this.#supportsNoOpen()) args.push('--no-open')
      child = this.spawnProcess(this.executable, args, {
        cwd: this.cwd,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
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
        waitForDsh(this.probe, port, this.startupTimeout, this.pollInterval, () => (
          this.startCancelled || this.child !== info || info.exited
        )).then(() => ({ type: 'ready' })),
        info.exitPromise,
      ])
      if (outcome.type === 'error') throw translateSpawnError(outcome.error)
      if (outcome.type === 'exit') throw new Error('DSH 启动失败')
      if (info.exited) throw new Error('DSH 启动失败')
      if (this.startCancelled) throw new Error('DSH 启动已取消')
      return this.setState({ state: 'running', port, owned: true, error: null })
    } catch (error) {
      if (!info.exited) {
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
      intentional: false,
      exitPromise: null,
    }
    info.exitPromise = new Promise((resolve) => {
      child.once('error', (error) => {
        if (child.pid == null) {
          info.exited = true
          if (this.child === info) this.child = null
        }
        resolve({ type: 'error', error })
      })
      child.once('exit', (code, signal) => {
        info.exited = true
        if (this.child === info) this.child = null
        if (!info.intentional) {
          this.setState({ state: 'error', port, owned: false, error: 'DSH 已停止' })
        }
        resolve({ type: 'exit', code, signal })
      })
    })
    return info
  }

  async stop() {
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
    } catch (error) {
      this.setState({
        state: 'error',
        port,
        owned: Boolean(this.child === info && !info.exited),
        error: 'DSH 停止失败',
      })
      throw error
    }
    return this.setState({ state: 'stopped', port, owned: false, error: null })
  }

  async #terminateOwnedChild(info) {
    await this.terminateProcess(info.process)
    const outcome = await Promise.race([
      info.exitPromise,
      delay(this.shutdownTimeout).then(() => ({ type: 'timeout' })),
    ])
    if (outcome.type === 'timeout' && !info.exited) throw new Error('DSH 进程未能退出')
    if (!info.exited) throw new Error('DSH 进程未能退出')
  }
}

function translateSpawnError(error) {
  return error?.code === 'ENOENT' ? new DshNotInstalledError() : error
}

function resolveDshVersion(executable, { spawnSyncProcess = spawnSync } = {}) {
  const result = spawnSyncProcess(executable, ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
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

function terminateChildProcess(child, {
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  if (platform !== 'win32' || !Number.isInteger(child.pid)) {
    child.kill()
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const killer = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    killer.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4096)
    })
    killer.once('error', reject)
    killer.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || '无法终止 DSH 进程树'))
    })
  })
}

function resolveDshExecutable(platform = process.platform, existsSync = fs.existsSync) {
  const candidates = platform === 'darwin'
    ? ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh']
    : platform === 'win32'
      ? []
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
      response.on('end', () => resolve(body.includes(DSH_TITLE) ? 'dsh' : 'occupied'))
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

async function waitForDsh(probe, port, timeout, interval, cancelled = () => false) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error('DSH 启动已取消')
    if (await probe(port) === 'dsh') return
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
