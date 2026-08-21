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
    server.once('error', () => {
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

function endpointFingerprint(endpoint) {
  const normalized = normalizeEndpoint(endpoint)
  return JSON.stringify([
    normalized.sshHost,
    normalized.sshUser,
    normalized.sshPort,
    normalized.remotePort,
    normalized.localPort,
  ])
}

class TunnelStopError extends Error {
  constructor(endpointId) {
    super('SSH 断开失败')
    this.name = 'TunnelStopError'
    this.endpointId = endpointId
  }
}

class TunnelManager extends EventEmitter {
  constructor({
    spawnImpl = spawn,
    waitForReady = waitForHttp,
    assertPortAvailable = assertLocalPortAvailable,
    sshCommand = 'ssh',
    identityFile = null,
    stopTimeoutMs = 1_000,
    pollIntervalMs = 50,
  } = {}) {
    super()
    this.spawnImpl = spawnImpl
    this.waitForReady = waitForReady
    this.assertPortAvailable = assertPortAvailable
    this.sshCommand = sshCommand
    this.identityFile = identityFile
    this.stopTimeoutMs = stopTimeoutMs
    this.pollIntervalMs = pollIntervalMs
    this.records = new Map()
    this.portClaims = new Map()
  }

  get(id) {
    const record = this.records.get(id)
    return record === undefined ? null : this.#view(record)
  }

  list() {
    return [...this.records.values()].map((record) => this.#view(record))
  }

  start(input) {
    const endpoint = normalizeEndpoint(input)
    if (endpoint.mode !== 'ssh') return Promise.reject(new Error('本机直连不需要 SSH 隧道'))
    const fingerprint = endpointFingerprint(endpoint)
    const existing = this.records.get(endpoint.id)
    if (existing && this.#isActive(existing)) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error('请先断开连接，再修改连接设置'))
      }
      return existing.startPromise ?? Promise.resolve(this.#view(existing))
    }

    const claimedBy = this.portClaims.get(endpoint.localPort)
    if (claimedBy && claimedBy !== endpoint.id) {
      return Promise.reject(new Error(`本地端口 ${endpoint.localPort} 已分配给其他主机`))
    }

    const record = {
      endpoint,
      fingerprint,
      child: null,
      state: 'starting',
      error: null,
      stderr: '',
      intentionalStop: false,
      stopRequested: false,
      exited: false,
      exitPromise: null,
      startPromise: null,
      claimed: true,
    }
    this.records.set(endpoint.id, record)
    this.portClaims.set(endpoint.localPort, endpoint.id)
    this.#emit(record)
    record.startPromise = this.#startClaimed(record)
    return record.startPromise
  }

  async #startClaimed(record) {
    try {
      await this.assertPortAvailable(record.endpoint.localPort)
      if (record.stopRequested) throw new Error('SSH 连接已取消')

      const child = this.spawnImpl(this.sshCommand, buildSshArgs(record.endpoint, {
        identityFile: this.identityFile,
      }), {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      record.child = child
      record.exitPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
          record.exited = true
          this.#releasePort(record)
          if (record.state !== 'error') {
            record.state = record.intentionalStop ? 'stopped' : 'error'
            record.error = record.intentionalStop ? null : tunnelExitMessage(code, signal, record.stderr)
          }
          this.#emit(record)
          resolve({ type: 'exit', code, signal })
        })
        child.once('error', (error) => {
          record.exited = child.pid == null
          if (record.exited) this.#releasePort(record)
          record.state = 'error'
          record.error = '无法启动 SSH'
          this.#emit(record)
          resolve({ type: 'error', error })
        })
      })
      child.stderr?.on('data', (chunk) => {
        record.stderr = `${record.stderr}${String(chunk)}`.slice(-16_384)
      })

      if (record.stopRequested) {
        record.intentionalStop = true
        child.kill()
      }
      const ready = this.waitForReady(loopbackUrl(record.endpoint)).then(() => ({ type: 'ready' }))
      const outcome = await Promise.race([ready, record.exitPromise])
      if (outcome.type === 'error') throw new Error(record.error)
      if (outcome.type !== 'ready') {
        if (record.intentionalStop) throw new Error('SSH 连接已取消')
        throw new Error(tunnelExitMessage(outcome.code, outcome.signal, record.stderr))
      }
      if (record.stopRequested) throw new Error('SSH 连接已取消')
      record.state = 'connected'
      record.error = null
      this.#emit(record)
      return this.#view(record)
    } catch (error) {
      if (record.child && !record.exited) {
        record.intentionalStop = true
        record.child.kill()
        await Promise.race([record.exitPromise ?? Promise.resolve(), delay(this.stopTimeoutMs)])
      }
      if (!record.child || record.exited) this.#releasePort(record)
      record.state = record.stopRequested ? 'stopped' : 'error'
      record.error = record.stopRequested ? null : error.message
      this.#emit(record)
      throw error
    } finally {
      record.startPromise = null
    }
  }

  async stop(id) {
    const record = this.records.get(id)
    if (record === undefined) return null
    if (record.exited || record.state === 'stopped') return this.#view(record)
    record.stopRequested = true
    record.intentionalStop = true
    record.state = 'stopping'
    record.error = null
    this.#emit(record)

    if (!record.child) {
      try {
        await record.startPromise
      } catch {}
      if (!record.child || record.exited) {
        record.state = 'stopped'
        record.error = null
        this.#releasePort(record)
        this.#emit(record)
        return this.#view(record)
      }
    }

    record.child.kill()
    const stopped = await this.#waitForExit(record)
    if (!stopped) {
      const error = new TunnelStopError(id)
      record.state = 'error'
      record.error = error.message
      this.#emit(record)
      throw error
    }
    return this.#view(record)
  }

  async stopAll() {
    return Promise.all([...this.records.keys()].map((id) => this.stop(id)))
  }

  async #waitForExit(record) {
    const attempts = Math.max(1, Math.ceil(this.stopTimeoutMs / this.pollIntervalMs))
    for (let index = 0; index < attempts && !record.exited; index += 1) {
      await delay(this.pollIntervalMs)
    }
    return record.exited
  }

  #isActive(record) {
    return record.claimed || Boolean(record.child && !record.exited)
  }

  #releasePort(record) {
    if (this.portClaims.get(record.endpoint.localPort) === record.endpoint.id) {
      this.portClaims.delete(record.endpoint.localPort)
    }
    record.claimed = false
  }

  #view(record) {
    return Object.freeze({
      endpointId: record.endpoint.id,
      state: record.state,
      url: loopbackUrl(record.endpoint),
      pid: record.child?.pid ?? null,
      active: this.#isActive(record),
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

module.exports = {
  TunnelManager,
  TunnelStopError,
  assertLocalPortAvailable,
  endpointFingerprint,
  tunnelExitMessage,
  waitForHttp,
}
