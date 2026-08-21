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

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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

test('coalesces concurrent starts for the same port and rejects a different port', async () => {
  const firstProbe = deferred()
  const child = fakeChild()
  let probeCount = 0
  let spawnCount = 0
  const manager = new LocalDshManager({
    probe: async () => {
      probeCount += 1
      if (probeCount === 1) return firstProbe.promise
      return 'dsh'
    },
    spawnProcess: () => {
      spawnCount += 1
      return child
    },
    pollInterval: 1,
  })
  const first = manager.start(3080)
  const second = manager.start(3080)
  assert.equal(first, second)
  await assert.rejects(() => manager.start(3081), /另一个端口/)
  firstProbe.resolve('free')
  await first
  assert.equal(spawnCount, 1)
})

test('cancels startup before spawning when shutdown begins during the probe', async () => {
  const firstProbe = deferred()
  let spawnCount = 0
  const manager = new LocalDshManager({
    probe: () => firstProbe.promise,
    spawnProcess: () => {
      spawnCount += 1
      return fakeChild()
    },
  })
  const starting = manager.start(3080)
  const stopping = manager.stop()
  firstProbe.resolve('free')
  await starting
  const state = await stopping
  assert.equal(spawnCount, 0)
  assert.equal(state.state, 'stopped')
})

test('retains ownership after termination fails and allows stop to be retried', async () => {
  const child = fakeChild()
  let probeCount = 0
  let terminateCount = 0
  let exited = false
  const manager = new LocalDshManager({
    probe: async () => {
      if (exited) return 'free'
      return probeCount++ === 0 ? 'free' : 'dsh'
    },
    spawnProcess: () => child,
    terminateProcess: async () => {
      terminateCount += 1
      if (terminateCount === 1) throw new Error('terminate failed')
      exited = true
      queueMicrotask(() => child.emit('exit', 0, null))
    },
    pollInterval: 1,
    shutdownTimeout: 20,
  })
  await manager.start(3080)
  await assert.rejects(() => manager.stop(), /terminate failed/)
  assert.equal(manager.getState().owned, true)
  assert.equal(manager.hasOwnedProcess(), true)
  const stopped = await manager.stop()
  assert.equal(stopped.state, 'stopped')
  assert.equal(terminateCount, 2)
})

test('changes a running owned process to an error when it exits unexpectedly', async () => {
  const child = fakeChild()
  let probeCount = 0
  const manager = new LocalDshManager({
    probe: async () => probeCount++ === 0 ? 'free' : 'dsh',
    spawnProcess: () => child,
    pollInterval: 1,
  })
  await manager.start(3080)
  child.emit('exit', 1, null)
  assert.equal(manager.getState().state, 'error')
  assert.equal(manager.getState().owned, false)
  assert.equal(manager.getState().error, 'DSH 已停止')
})

test('lets PATH and PATHEXT resolve the Windows DSH command', () => {
  assert.equal(resolveDshExecutable('win32'), 'dsh')
})

test('falls back to PATH on macOS when fixed install locations are absent', () => {
  assert.equal(resolveDshExecutable('darwin', () => false), 'dsh')
  assert.equal(resolveDshExecutable('darwin', (filename) => filename === '/opt/homebrew/bin/dsh'), '/opt/homebrew/bin/dsh')
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
