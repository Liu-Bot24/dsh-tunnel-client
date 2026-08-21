const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')

const DSH_TITLE = '<title>DeepSeek Harness</title>'

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
    pollInterval = 250,
  } = {}) {
    super()
    this.spawnProcess = spawnProcess
    this.probe = probe
    this.executable = executable
    this.cwd = cwd
    this.startupTimeout = startupTimeout
    this.pollInterval = pollInterval
    this.child = null
    this.state = Object.freeze({ state: 'stopped', port: 3080, owned: false, error: null })
  }

  getState() {
    return this.state
  }

  setState(next) {
    this.state = Object.freeze({ ...this.state, ...next })
    this.emit('state', this.state)
    return this.state
  }

  async inspect(port = this.state.port) {
    if (this.state.state === 'starting' || this.state.state === 'stopping') return this.state
    if (this.child && this.state.state === 'running' && this.state.port === port) return this.state
    const result = await this.probe(port)
    if (result === 'dsh') return this.setState({ state: 'running', port, owned: false, error: null })
    if (result === 'occupied') {
      return this.setState({ state: 'error', port, owned: false, error: `本地端口 ${port} 已被其他程序占用` })
    }
    return this.setState({ state: 'stopped', port, owned: false, error: null })
  }

  async start(port = 3080) {
    if (this.state.state === 'starting' || this.state.state === 'stopping') {
      throw new Error('本机 DSH 正在切换状态，请稍后再试')
    }
    if (this.child && this.state.state === 'running') return this.state

    const existing = await this.probe(port)
    if (existing === 'dsh') return this.setState({ state: 'running', port, owned: false, error: null })
    if (existing === 'occupied') throw new LocalPortOccupiedError(port)

    this.setState({ state: 'starting', port, owned: false, error: null })
    let child
    try {
      child = this.spawnProcess(this.executable, ['web', '--port', String(port)], {
        cwd: this.cwd,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      })
    } catch (error) {
      const translated = error?.code === 'ENOENT' ? new DshNotInstalledError() : error
      this.setState({ state: 'error', port, owned: false, error: translated.message || '无法启动 DSH' })
      throw translated
    }
    this.child = child

    const exitPromise = new Promise((_, reject) => {
      child.once('error', (error) => {
        if (this.child === child) this.child = null
        const translated = error?.code === 'ENOENT' ? new DshNotInstalledError() : error
        this.setState({ state: 'error', port, owned: false, error: translated.message || '无法启动 DSH' })
        reject(translated)
      })
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = null
        if (this.state.state === 'stopping') {
          this.setState({ state: 'stopped', port, owned: false, error: null })
          return
        }
        this.setState({ state: 'error', port, owned: false, error: 'DSH 启动失败' })
        reject(new Error(this.state.error))
      })
    })

    try {
      await Promise.race([
        waitForDsh(this.probe, port, this.startupTimeout, this.pollInterval, () => this.child !== child),
        exitPromise,
      ])
      return this.setState({ state: 'running', port, owned: true, error: null })
    } catch (error) {
      if (this.child === child) {
        child.kill()
        this.child = null
      }
      if (this.state.state !== 'error') {
        this.setState({ state: 'error', port, owned: false, error: 'DSH 启动超时' })
      }
      throw error
    }
  }

  async stop() {
    if (this.state.state === 'stopped') return this.state
    if (!this.child || !this.state.owned) {
      throw new Error('无法停止：DSH 由其他程序启动')
    }
    const child = this.child
    const port = this.state.port
    this.setState({ state: 'stopping', port, owned: true, error: null })
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.kill()
    })
    this.child = null
    return this.setState({ state: 'stopped', port, owned: false, error: null })
  }
}

function resolveDshExecutable(platform = process.platform) {
  const candidates = platform === 'darwin'
    ? ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh']
    : platform === 'win32'
      ? ['dsh.cmd', 'dsh.exe']
      : ['/usr/local/bin/dsh', '/usr/bin/dsh']
  return candidates.find((candidate) => candidate.includes('/') && fs.existsSync(candidate)) ?? candidates.at(-1) ?? 'dsh'
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
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('DSH 启动超时')
}

module.exports = {
  DSH_TITLE,
  DshNotInstalledError,
  LocalDshManager,
  LocalPortOccupiedError,
  findNextAvailablePort,
  isPortAvailable,
  probeLocalService,
  resolveDshExecutable,
}
