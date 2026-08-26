const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  DshNotInstalledError,
  LocalDshManager,
  LocalPortOccupiedError,
  findNextAvailablePort,
  resolveDshExecutable,
  resolveDshVersion,
  supportsNoOpen,
  terminateChildProcess,
} = require('../src/core/local-dsh-manager.cjs')

function fakeChild() {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
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

test('reports an npx network failure without exposing npm diagnostics', async () => {
  const child = fakeChild()
  const manager = new LocalDshManager({
    probe: async () => 'free',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('npm ERR! code ENOTFOUND\nrequest to registry failed\n'))
        child.emit('exit', 1, null)
      })
      return child
    },
  })
  await assert.rejects(() => manager.start(3080), /DSH 下载失败，请检查网络连接/)
  assert.equal(manager.getState().error, 'DSH 下载失败，请检查网络连接')
})

test('emits local DSH state only when an inspection finds a real change', async () => {
  let probeResult = 'free'
  const manager = new LocalDshManager({ probe: async () => probeResult })
  const events = []
  manager.on('state', (state) => events.push(state))

  await manager.inspect(3080)
  await manager.inspect(3080)
  assert.equal(events.length, 0)

  probeResult = 'dsh'
  await manager.inspect(3080)
  await manager.inspect(3080)
  assert.equal(events.length, 1)
  assert.equal(events[0].state, 'running')

  probeResult = 'free'
  await manager.inspect(3080)
  assert.equal(events.length, 2)
  assert.equal(events[1].state, 'stopped')
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

test('starts DSH rc.8 and newer with no-open and no shell', async () => {
  const calls = []
  const child = fakeChild()
  let probeCount = 0
  const manager = new LocalDshManager({
    executable: '/example/dsh',
    resolveVersion: () => '0.1.0-rc.8',
    cwd: '/example/home',
    environment: { PATH: '/example/tools', DSH_TUNNEL_PNPM_PATH: '/example/pnpm.cjs' },
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
  assert.deepEqual(calls[0].args, ['web', '--port', '3080', '--no-open'])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.cwd, '/example/home')
  assert.equal(calls[0].options.env.DSH_TUNNEL_PNPM_PATH, '/example/pnpm.cjs')

  const stopped = await manager.stop()
  assert.equal(stopped.state, 'stopped')
  assert.equal(child.killCalls.length, 1)
})

test('keeps the legacy launch arguments for DSH rc.7', async () => {
  const calls = []
  const child = fakeChild()
  let probeCount = 0
  const manager = new LocalDshManager({
    executable: '/example/dsh',
    resolveVersion: () => '0.1.0-rc.7',
    probe: async () => child.killCalls.length > 0 ? 'free' : (probeCount++ === 0 ? 'free' : 'dsh'),
    spawnProcess: (command, args) => {
      calls.push({ command, args })
      return child
    },
    pollInterval: 1,
  })

  await manager.start(3080)
  assert.deepEqual(calls[0].args, ['web', '--port', '3080'])
  await manager.stop()
})

test('uses an explicit no-open capability without running a blocking version probe', async () => {
  const calls = []
  const child = fakeChild()
  let probeCount = 0
  let versionProbeCount = 0
  const manager = new LocalDshManager({
    executable: '/example/latest-dsh',
    noOpenSupported: true,
    resolveVersion: () => {
      versionProbeCount += 1
      return '0.1.1-rc.2'
    },
    probe: async () => child.killCalls.length > 0 ? 'free' : (probeCount++ === 0 ? 'free' : 'dsh'),
    spawnProcess: (command, args) => {
      calls.push({ command, args })
      return child
    },
    pollInterval: 1,
  })

  await manager.start(3080)
  assert.deepEqual(calls[0].args, ['web', '--port', '3080', '--no-open'])
  assert.equal(versionProbeCount, 0)
  await manager.stop()
})

test('recognizes the exact no-open version boundary', () => {
  assert.equal(supportsNoOpen('0.1.0-rc.7'), false)
  assert.equal(supportsNoOpen('0.1.0-rc.8'), true)
  assert.equal(supportsNoOpen('0.1.1-rc.1'), true)
  assert.equal(supportsNoOpen('0.1.0'), true)
  assert.equal(supportsNoOpen('unknown'), false)
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

test('finds the npm-installed Windows DSH without relying on the GUI PATH', () => {
  const expected = 'C:\\Users\\Example\\AppData\\Roaming\\npm\\dsh.cmd'
  assert.equal(resolveDshExecutable(
    'win32',
    (filename) => filename === expected,
    { APPDATA: 'C:\\Users\\Example\\AppData\\Roaming', PATH: 'C:\\Windows\\System32' },
  ), expected)
})

test('falls back to PATH on macOS when fixed install locations are absent', () => {
  assert.equal(resolveDshExecutable('darwin', () => false), 'dsh')
  assert.equal(resolveDshExecutable('darwin', (filename) => filename === '/opt/homebrew/bin/dsh'), '/opt/homebrew/bin/dsh')
})

test('version probing lets an absolute env-based DSH script find its adjacent Node executable', () => {
  const delimiter = require('node:path').delimiter
  let receivedOptions = null
  const version = resolveDshVersion('/opt/homebrew/bin/dsh', {
    environment: { PATH: ['/usr/bin', '/bin'].join(delimiter), KEEP: 'yes' },
    spawnSyncProcess: (_executable, _args, options) => {
      receivedOptions = options
      return { status: 0, stdout: '0.1.1-rc.2\n' }
    },
  })
  assert.equal(version, '0.1.1-rc.2')
  assert.deepEqual(receivedOptions.env.PATH.split(delimiter), ['/opt/homebrew/bin', '/usr/bin', '/bin'])
  assert.equal(receivedOptions.env.KEEP, 'yes')
})

test('version probing bounds a stalled system DSH command', () => {
  let receivedTimeout = null
  const version = resolveDshVersion('/example/dsh', {
    spawnSyncProcess: (_executable, _args, options) => {
      receivedTimeout = options.timeout
      return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null }
    },
  })
  assert.equal(version, null)
  assert.equal(receivedTimeout, 5_000)
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
