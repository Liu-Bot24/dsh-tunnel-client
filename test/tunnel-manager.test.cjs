const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { TunnelManager } = require('../src/core/tunnel-manager.cjs')

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
    waitForReady: async () => { throw new Error('DSH did not become ready') },
    assertPortAvailable: async () => {},
  })
  await assert.rejects(() => manager.start(endpoint), /did not become ready/)
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

  await assert.rejects(() => manager.start(endpoint), /Could not start SSH: spawn ssh ENOENT/)
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
    assertPortAvailable: async () => { throw new Error('Local port 13080 is unavailable') },
  })

  await assert.rejects(() => manager.start(endpoint), /Local port 13080 is unavailable/)
  assert.equal(spawnCalled, false)
})
