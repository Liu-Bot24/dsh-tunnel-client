const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { TunnelManager, tunnelExitMessage, waitForHttp } = require('../src/core/tunnel-manager.cjs')
const { DSH_AUTH_REQUIRED_BODY } = require('../src/core/web-auth.cjs')

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 42
  child.exitCode = null
  child.signalCode = null
  child.stderr = new EventEmitter()
  child.kill = () => {
    child.exitCode = 0
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  return child
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const endpoint = { id: 'one', name: 'One', sshHost: 'one', localPort: 13080, remotePort: 3080 }

test('treats the exact RC.1 authentication response as a ready DSH listener', async () => {
  const result = await waitForHttp('http://127.0.0.1:13080/', {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => DSH_AUTH_REQUIRED_BODY,
    }),
    timeoutMs: 20,
    intervalMs: 1,
  })
  assert.deepEqual(result, { authRequired: true })
})

test('reports connected after the DSH readiness probe succeeds', async () => {
  const child = fakeChild()
  const manager = new TunnelManager({
    spawnImpl: () => child,
    waitForReady: async () => {},
    assertPortAvailable: async () => {},
  })
  const state = await manager.start(endpoint)
  assert.equal(state.state, 'connected')
  assert.equal(state.url, 'http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  assert.equal(manager.getOpenUrl('one'), state.url)
  await manager.stop('one')
  assert.equal(manager.get('one').state, 'stopped')
})

test('keeps a remote launch token private while using it for the forwarded browser URL', async () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-token'
  const child = fakeChild()
  const manager = new TunnelManager({
    spawnImpl: () => child,
    waitForReady: async () => ({ authRequired: true }),
    resolveRemoteAuth: async () => `http://127.0.0.1:3080/?token=${token}`,
    assertPortAvailable: async () => {},
  })

  const state = await manager.start(endpoint)
  assert.equal(state.authRequired, true)
  assert.equal(state.authAvailable, true)
  assert.doesNotMatch(JSON.stringify(state), /token/u)
  const openUrl = new URL(manager.getOpenUrl(endpoint.id))
  assert.equal(openUrl.origin, 'http://127.0.0.1:13080')
  assert.equal(openUrl.searchParams.get('token'), token)
  assert.equal(new URLSearchParams(openUrl.hash.slice(1)).get('dsh_tunnel_preview'), 'web')
  await manager.stop(endpoint.id)
  assert.throws(() => manager.getOpenUrl(endpoint.id), /请先连接/u)
})

test('keeps the tunnel usable when RC.1 needs auth but the remote handoff is unavailable', async () => {
  const child = fakeChild()
  const manager = new TunnelManager({
    spawnImpl: () => child,
    waitForReady: async () => ({ authRequired: true }),
    resolveRemoteAuth: async () => null,
    assertPortAvailable: async () => {},
  })

  const state = await manager.start(endpoint)
  assert.equal(state.authRequired, true)
  assert.equal(state.authAvailable, false)
  assert.equal(manager.getOpenUrl(endpoint.id), state.url)
  await manager.stop(endpoint.id)
})

test('kills the SSH process when readiness fails', async () => {
  const child = fakeChild()
  let killed = false
  child.kill = () => {
    killed = true
    child.exitCode = 1
    queueMicrotask(() => child.emit('exit', 1, null))
    return true
  }
  const manager = new TunnelManager({
    spawnImpl: () => child,
    waitForReady: async () => { throw new Error('SSH 已连接，但 DSH 没有响应') },
    assertPortAvailable: async () => {},
  })
  await assert.rejects(() => manager.start(endpoint), /DSH 没有响应/)
  assert.equal(killed, true)
  assert.equal(manager.get('one').state, 'error')
})

test('force-terminates SSH when readiness cleanup ignores the graceful signal', async () => {
  const child = fakeChild()
  const signals = []
  child.kill = (signal) => {
    signals.push(signal ?? 'SIGTERM')
    return true
  }
  const manager = new TunnelManager({
    spawnImpl: () => child,
    waitForReady: async () => { throw new Error('DSH 没有响应') },
    assertPortAvailable: async () => {},
    forceTerminateProcess: async () => {
      signals.push('forced')
      queueMicrotask(() => child.emit('exit', 1, 'SIGKILL'))
    },
    stopTimeoutMs: 5,
    pollIntervalMs: 1,
  })

  await assert.rejects(() => manager.start(endpoint), /DSH 没有响应/)
  assert.deepEqual(signals, ['SIGTERM', 'forced'])
  assert.equal(manager.get(endpoint.id).active, false)
  assert.equal(manager.get(endpoint.id).state, 'error')
})

test('reports a spawn error immediately when OpenSSH cannot start', async () => {
  const child = fakeChild()
  child.pid = undefined
  let readyProbeFinished = false
  const manager = new TunnelManager({
    spawnImpl: () => {
      queueMicrotask(() => child.emit('error', new Error('spawn ssh ENOENT')))
      return child
    },
    waitForReady: () => new Promise((resolve) => {
      setTimeout(() => {
        readyProbeFinished = true
        resolve()
      }, 1_000)
    }),
    assertPortAvailable: async () => {},
  })

  await assert.rejects(() => manager.start(endpoint), /无法启动 SSH/)
  assert.equal(readyProbeFinished, false)
  assert.equal(manager.get('one').state, 'error')
})

test('does not start SSH when the selected local port is already occupied', async () => {
  let spawnCalled = false
  const manager = new TunnelManager({
    spawnImpl: () => {
      spawnCalled = true
      return fakeChild()
    },
    assertPortAvailable: async () => { throw new Error('本地端口 13080 已被占用，请换一个端口') },
  })

  await assert.rejects(() => manager.start(endpoint), /本地端口 13080 已被占用/)
  assert.equal(spawnCalled, false)
})

test('releases a failed pre-spawn claim so the endpoint can be retried', async () => {
  let checkCount = 0
  let spawnCount = 0
  const manager = new TunnelManager({
    spawnImpl: () => {
      spawnCount += 1
      return fakeChild()
    },
    waitForReady: async () => {},
    assertPortAvailable: async () => {
      checkCount += 1
      if (checkCount === 1) throw new Error('本地端口 13080 已被占用，请换一个端口')
    },
  })
  await assert.rejects(() => manager.start(endpoint), /已被占用/)
  assert.equal(manager.get(endpoint.id).active, false)
  const state = await manager.start(endpoint)
  assert.equal(state.state, 'connected')
  assert.equal(spawnCount, 1)
})

test('coalesces concurrent starts for the same endpoint before the port check', async () => {
  const portCheck = deferred()
  let spawnCount = 0
  const manager = new TunnelManager({
    spawnImpl: () => {
      spawnCount += 1
      return fakeChild()
    },
    waitForReady: async () => {},
    assertPortAvailable: () => portCheck.promise,
  })
  const first = manager.start(endpoint)
  const second = manager.start(endpoint)
  assert.equal(first, second)
  assert.equal(spawnCount, 0)
  portCheck.resolve()
  await first
  assert.equal(spawnCount, 1)
})

test('rejects another endpoint claiming the same local port while startup is pending', async () => {
  const portCheck = deferred()
  const manager = new TunnelManager({
    spawnImpl: () => fakeChild(),
    waitForReady: async () => {},
    assertPortAvailable: () => portCheck.promise,
  })
  const first = manager.start(endpoint)
  await assert.rejects(
    () => manager.start({ ...endpoint, id: 'two', name: 'Two', sshHost: 'two' }),
    /已分配给其他主机/,
  )
  portCheck.resolve()
  await first
})

test('cancels a pending start without spawning an SSH process', async () => {
  const portCheck = deferred()
  let spawnCount = 0
  const manager = new TunnelManager({
    spawnImpl: () => {
      spawnCount += 1
      return fakeChild()
    },
    assertPortAvailable: () => portCheck.promise,
  })
  const starting = manager.start(endpoint)
  const rejected = assert.rejects(starting, /已取消/)
  const stopping = manager.stop(endpoint.id)
  portCheck.resolve()
  await rejected
  const state = await stopping
  assert.equal(spawnCount, 0)
  assert.equal(state.state, 'stopped')
})

test('rejects connection-field changes while an endpoint is active', async () => {
  const manager = new TunnelManager({
    spawnImpl: () => fakeChild(),
    waitForReady: async () => {},
    assertPortAvailable: async () => {},
  })
  await manager.start(endpoint)
  await assert.rejects(
    () => manager.start({ ...endpoint, remotePort: 3081 }),
    /先断开连接/,
  )
})

test('reports stop failure and keeps the live tunnel available for retry', async () => {
  const child = fakeChild()
  child.kill = () => true
  const manager = new TunnelManager({
    spawnImpl: () => child,
    waitForReady: async () => {},
    assertPortAvailable: async () => {},
    forceTerminateProcess: async () => {},
    stopTimeoutMs: 5,
    pollIntervalMs: 1,
  })
  await manager.start(endpoint)
  await assert.rejects(() => manager.stop(endpoint.id), /SSH 断开失败/)
  assert.equal(manager.get(endpoint.id).active, true)

  child.kill = () => {
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  const stopped = await manager.stop(endpoint.id)
  assert.equal(stopped.state, 'stopped')
})

test('does not start an SSH process for a local endpoint', async () => {
  let spawnCalled = false
  const manager = new TunnelManager({
    spawnImpl: () => {
      spawnCalled = true
      return fakeChild()
    },
  })

  await assert.rejects(() => manager.start({ mode: 'local', name: 'Local DSH' }), /不需要 SSH 隧道/)
  assert.equal(spawnCalled, false)
})

test('turns an SSH authentication diagnostic into a safe user message', () => {
  const message = tunnelExitMessage(255, null, 'remote-user@my-pc: Permission denied (publickey).')
  assert.equal(message, 'SSH 认证失败')
  assert.doesNotMatch(message, /remote-user|my-pc/)
})

test('does not expose an unknown SSH diagnostic', () => {
  const message = tunnelExitMessage(255, null, 'unexpected internal diagnostic')
  assert.equal(message, 'SSH 连接已结束')
  assert.doesNotMatch(message, /internal diagnostic/)
})
