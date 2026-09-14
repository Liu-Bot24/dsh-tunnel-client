const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const net = require('node:net')
const { buildSshArgs } = require('./ssh.cjs')
const { loopbackUrl, normalizeEndpoint } = require('./endpoint.cjs')
const { resolveAccessLink } = require('./access-link.cjs')
const { DSH_AUTH_REQUIRED_BODY, rewriteAuthenticatedWebUrl } = require('./web-auth.cjs')

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
      if (response.ok) return { authRequired: false }
      if (response.status === 401) {
        const body = await response.text()
        if (body.includes(DSH_AUTH_REQUIRED_BODY)) return { authRequired: true }
      }
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
    forceTerminateProcess = forceTerminateTunnelProcess,
    resolveRemoteAuth = async () => null,
    sshCommand = 'ssh',
    identityFile = null,
    stopTimeoutMs = 1_000,
    pollIntervalMs = 50,
  } = {}) {
    super()
    this.spawnImpl = spawnImpl
    this.waitForReady = waitForReady
    this.assertPortAvailable = assertPortAvailable
    this.forceTerminateProcess = forceTerminateProcess
    this.resolveRemoteAuth = resolveRemoteAuth
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
      authUrl: null,
      authRequired: false,
      authAvailable: false,
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
          record.authUrl = null
          record.authAvailable = false
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
      const ready = this.waitForReady(loopbackUrl(record.endpoint)).then(result => ({
        type: 'ready',
        authRequired: Boolean(result?.authRequired),
      }))
      const outcome = await Promise.race([ready, record.exitPromise])
      if (outcome.type === 'error') throw new Error(record.error)
      if (outcome.type !== 'ready') {
        if (record.intentionalStop) throw new Error('SSH 连接已取消')
        throw new Error(tunnelExitMessage(outcome.code, outcome.signal, record.stderr))
      }
      if (record.stopRequested) throw new Error('SSH 连接已取消')
      record.authRequired = outcome.authRequired
      if (record.authRequired) {
        try {
          const remoteAuthUrl = await this.resolveRemoteAuth(record.endpoint)
          record.authUrl = remoteAuthUrl
            ? rewriteAuthenticatedWebUrl(remoteAuthUrl, record.endpoint)
            : null
        } catch {
          record.authUrl = null
        }
        record.authAvailable = Boolean(record.authUrl)
      }
      record.state = 'connected'
      record.error = null
      this.#emit(record)
      return this.#view(record)
    } catch (error) {
      let cleanupError = null
      if (record.child && !record.exited) {
        record.intentionalStop = true
        if (!(await this.#terminateChild(record))) cleanupError = new TunnelStopError(record.endpoint.id)
      }
      if (!record.child || record.exited) this.#releasePort(record)
      record.state = record.stopRequested && !cleanupError ? 'stopped' : 'error'
      record.authUrl = null
      record.authAvailable = false
      record.error = record.stopRequested && !cleanupError ? null : (cleanupError?.message ?? error.message)
      this.#emit(record)
      throw cleanupError ?? error
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

    const stopped = await this.#terminateChild(record)
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

  async resolveOpenUrl(id) {
    const record = this.records.get(id)
    if (!record || record.state !== 'connected') throw new Error('请先连接，再打开 DSH')
    const url = await resolveAccessLink({
      port: record.endpoint.localPort,
      cachedUrl: record.authUrl,
      preview: true,
      readFreshUrl: async () => {
        const fresh = await this.resolveRemoteAuth(record.endpoint)
        return fresh ? rewriteAuthenticatedWebUrl(fresh, record.endpoint) : null
      },
    })
    if (this.records.get(id) !== record || record.state !== 'connected' || record.exited) throw new Error('SSH 连接已中断')
    record.authUrl = new URL(url).searchParams.has('token') ? url : null
    record.authAvailable = Boolean(record.authUrl)
    this.#emit(record)
    return url
  }

  getOpenUrl(id) {
    const record = this.records.get(id)
    if (record === undefined || record.state !== 'connected') throw new Error('请先连接，再打开 DSH')
    return record.authUrl ?? loopbackUrl(record.endpoint)
  }

  async #waitForExit(record) {
    const attempts = Math.max(1, Math.ceil(this.stopTimeoutMs / this.pollIntervalMs))
    for (let index = 0; index < attempts && !record.exited; index += 1) {
      await delay(this.pollIntervalMs)
    }
    return record.exited
  }

  async #terminateChild(record) {
    if (!record.child || record.exited) return true
    record.child.kill()
    if (await this.#waitForExit(record)) return true
    try {
      await this.forceTerminateProcess(record.child)
    } catch {
      return false
    }
    return this.#waitForExit(record)
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
      authRequired: record.authRequired,
      authAvailable: record.authAvailable,
    })
  }

  #emit(record) {
    this.emit('state', this.#view(record))
  }
}

function forceTerminateTunnelProcess(child, {
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  if (platform !== 'win32') {
    child.kill('SIGKILL')
    return Promise.resolve()
  }
  if (!Number.isInteger(child.pid)) return Promise.reject(new Error('SSH 进程标识不可用'))
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
      else reject(new Error(stderr.trim() || '无法强制终止 SSH 进程树'))
    })
  })
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
  forceTerminateTunnelProcess,
  tunnelExitMessage,
  waitForHttp,
}
