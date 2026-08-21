const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  DshNotInstalledError,
  LocalDshManager,
  LocalPortOccupiedError,
  findNextAvailablePort,
  resolveDshExecutable,
  terminateChildProcess,
} = require('../src/core/local-dsh-manager.cjs')

function fakeChild() {
  const child = new EventEmitter()
  child.killCalls = []
  child.kill = (signal) => {
    child.killCalls.push(signal)
    queueMicrotask(() => child.emit('exit', 0, signal ?? null))
    return true
  }
  return child
}

test('recognizes an already-running DSH without taking ownership', async () => {
  const manager = new LocalDshManager({ probe: async () => 'dsh' })
  const state = await manager.start(3080)
  assert.deepEqual(state, { state: 'running', port: 3080, owned: false, error: null })
  await assert.rejects(() => manager.stop(), /由其他程序启动/)
})

test('rejects a port occupied by a non-DSH service', async () => {
  const manager = new LocalDshManager({ probe: async () => 'occupied' })
  await assert.rejects(
    () => manager.start(3080),
    (error) => error instanceof LocalPortOccupiedError && error.port === 3080,
  )
})

test('reports a missing DSH installation clearly', async () => {
  const child = fakeChild()
  const manager = new LocalDshManager({
    probe: async () => 'free',
    spawnProcess: () => {
      queueMicrotask(() => {
        const error = new Error('spawn dsh ENOENT')
        error.code = 'ENOENT'
        child.emit('error', error)
      })
      return child
    },
  })
  await assert.rejects(() => manager.start(3080), DshNotInstalledError)
  assert.equal(manager.getState().error, '本机未安装 DSH')
})

test('starts DSH with the requested port and no shell', async () => {
  const calls = []
  const child = fakeChild()
  let probeCount = 0
  const manager = new LocalDshManager({
    executable: '/example/dsh',
    cwd: '/example/home',
    probe: async () => child.killCalls.length > 0 ? 'free' : (probeCount++ === 0 ? 'free' : 'dsh'),
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options })
      return child
    },
    pollInterval: 1,
  })

  const state = await manager.start(3080)
  assert.equal(state.state, 'running')
  assert.equal(state.owned, true)
  assert.equal(calls[0].command, '/example/dsh')
  assert.deepEqual(calls[0].args, ['web', '--port', '3080'])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.cwd, '/example/home')

  const stopped = await manager.stop()
  assert.equal(stopped.state, 'stopped')
  assert.equal(child.killCalls.length, 1)
})

test('lets PATH and PATHEXT resolve the Windows DSH command', () => {
  assert.equal(resolveDshExecutable('win32'), 'dsh')
})

test('terminates the owned Windows wrapper process tree without a shell', async () => {
  const calls = []
  const killer = new EventEmitter()
  killer.stderr = new EventEmitter()
  const promise = terminateChildProcess({ pid: 1234 }, {
    platform: 'win32',
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options })
      queueMicrotask(() => killer.emit('exit', 0))
      return killer
    },
  })
  await promise
  assert.equal(calls[0].command, 'taskkill.exe')
  assert.deepEqual(calls[0].args, ['/pid', '1234', '/t', '/f'])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.windowsHide, true)
})

test('does not report stopped while the DSH port still responds', async () => {
  const child = fakeChild()
  let probeCount = 0
  const manager = new LocalDshManager({
    probe: async () => probeCount++ === 0 ? 'free' : 'dsh',
    spawnProcess: () => child,
    terminateProcess: () => {
      queueMicrotask(() => child.emit('exit', 0, null))
    },
    pollInterval: 1,
    shutdownTimeout: 5,
  })
  await manager.start(3080)
  await assert.rejects(() => manager.stop(), /端口仍在响应/)
  assert.equal(manager.getState().state, 'error')
  assert.equal(manager.getState().error, 'DSH 停止失败')
})

test('finds the first free fallback port', async () => {
  const checked = []
  const port = await findNextAvailablePort(3081, async (candidate) => {
    checked.push(candidate)
    return candidate === 3083
  })
  assert.equal(port, 3083)
  assert.deepEqual(checked, [3081, 3082, 3083])
})
