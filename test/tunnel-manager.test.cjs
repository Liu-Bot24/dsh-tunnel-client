const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { TunnelManager, tunnelExitMessage } = require('../src/core/tunnel-manager.cjs')

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

const endpoint = { id: 'one', name: 'One', sshHost: 'one', localPort: 13080, remotePort: 3080 }

test('reports connected after the DSH readiness probe succeeds', async () => {
  const child = fakeChild()
  const manager = new TunnelManager({
    spawnImpl: () => child,
    waitForReady: async () => {},
    assertPortAvailable: async () => {},
  })
  const state = await manager.start(endpoint)
  assert.equal(state.state, 'connected')
  assert.equal(state.url, 'http://127.0.0.1:13080/')
  await manager.stop('one')
  assert.equal(manager.get('one').state, 'stopped')
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
