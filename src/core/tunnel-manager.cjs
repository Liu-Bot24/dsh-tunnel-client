const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const net = require('node:net')
const { buildSshArgs } = require('./ssh.cjs')
const { loopbackUrl, normalizeEndpoint } = require('./endpoint.cjs')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHttp(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  intervalMs = 200,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(1_000), redirect: 'manual' })
      if (response.ok) return
    } catch {}
    await delay(intervalMs)
  }
  throw new Error('DSH 没有响应')
}

function assertLocalPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (error) => {
      reject(new Error(`本地端口 ${port} 已被占用，请换一个端口`))
    })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(new Error(`无法释放本地端口 ${port}`))
        else resolve()
      })
    })
  })
}

class TunnelManager extends EventEmitter {
  constructor({
    spawnImpl = spawn,
    waitForReady = waitForHttp,
    assertPortAvailable = assertLocalPortAvailable,
    sshCommand = 'ssh',
  } = {}) {
    super()
    this.spawnImpl = spawnImpl
    this.waitForReady = waitForReady
    this.assertPortAvailable = assertPortAvailable
    this.sshCommand = sshCommand
    this.records = new Map()
  }

  get(id) {
    const record = this.records.get(id)
    return record === undefined ? null : this.#view(record)
  }

  list() {
    return [...this.records.values()].map((record) => this.#view(record))
  }

  async start(input) {
    const endpoint = normalizeEndpoint(input)
    if (endpoint.mode !== 'ssh') throw new Error('本机直连不需要 SSH 隧道')
    const existing = this.records.get(endpoint.id)
    if (existing && (existing.state === 'starting' || existing.state === 'connected')) {
      return this.#view(existing)
    }

    await this.assertPortAvailable(endpoint.localPort)

    const child = this.spawnImpl(this.sshCommand, buildSshArgs(endpoint), {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const record = {
      endpoint,
      child,
      state: 'starting',
      error: null,
      stderr: '',
      intentionalStop: false,
      exited: false,
    }
    this.records.set(endpoint.id, record)
    this.#emit(record)

    const processEnded = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        record.exited = true
        if (record.state !== 'error') {
          record.state = record.intentionalStop ? 'stopped' : 'error'
          record.error = record.intentionalStop ? null : tunnelExitMessage(code, signal, record.stderr)
        }
        this.#emit(record)
        resolve({ type: 'exit', code, signal })
      })
      child.once('error', (error) => {
        record.exited = child.pid == null
        record.state = 'error'
        record.error = '无法启动 SSH'
        this.#emit(record)
        resolve({ type: 'error', error })
      })
    })
    child.stderr?.on('data', (chunk) => {
      record.stderr = `${record.stderr}${String(chunk)}`.slice(-16_384)
    })

    try {
      const ready = this.waitForReady(loopbackUrl(endpoint)).then(() => ({ type: 'ready' }))
      const outcome = await Promise.race([ready, processEnded])
      if (outcome.type === 'error') throw new Error(record.error)
      if (outcome.type !== 'ready') {
        throw new Error(tunnelExitMessage(outcome.code, outcome.signal, record.stderr))
      }
      record.state = 'connected'
      record.error = null
      this.#emit(record)
      return this.#view(record)
    } catch (error) {
      record.state = 'error'
      record.error = error.message
      this.#emit(record)
      if (!record.exited) child.kill()
      throw error
    }
  }

  async stop(id) {
    const record = this.records.get(id)
    if (record === undefined) return null
    if (record.exited || record.state === 'stopped') return this.#view(record)
    record.intentionalStop = true
    record.state = 'stopping'
    this.#emit(record)
    record.child.kill()
    for (let index = 0; index < 20 && !record.exited; index += 1) await delay(50)
    if (!record.exited) {
      record.state = 'error'
      record.error = 'SSH 断开失败'
      this.#emit(record)
    }
    return this.#view(record)
  }

  async stopAll() {
    await Promise.all([...this.records.keys()].map((id) => this.stop(id)))
  }

  #view(record) {
    return Object.freeze({
      endpointId: record.endpoint.id,
      state: record.state,
      url: loopbackUrl(record.endpoint),
      pid: record.child?.pid ?? null,
      error: record.error,
    })
  }

  #emit(record) {
    this.emit('state', this.#view(record))
  }
}

function tunnelExitMessage(code, signal, stderr) {
  const diagnostic = stderr.toLowerCase()
  if (diagnostic.includes('permission denied')) return 'SSH 认证失败'
  if (diagnostic.includes('could not resolve hostname')) return '找不到 SSH 主机'
  if (diagnostic.includes('connection refused')) return 'SSH 连接被拒绝'
  if (diagnostic.includes('host key verification failed')) return 'SSH 主机密钥未确认'
  if (diagnostic.includes('timed out') || diagnostic.includes('no route to host')) {
    return 'SSH 主机不可达'
  }
  if (signal) return 'SSH 连接已中断'
  if (Number.isInteger(code)) return 'SSH 连接已结束'
  return 'SSH 连接已结束'
}

module.exports = { TunnelManager, waitForHttp, assertLocalPortAvailable, tunnelExitMessage }
