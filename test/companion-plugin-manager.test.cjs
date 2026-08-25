const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  CompanionPluginManager,
  PLUGIN_ARCHIVE,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  commandEnvironment,
  compareVersions,
  translateInstallFailure,
} = require('../src/core/companion-plugin-manager.cjs')

function fakeChild(exitCode = 0, stderr = '', stdout = '') {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    if (stderr) child.stderr.emit('data', Buffer.from(stderr))
    child.emit('exit', exitCode, null)
  })
  return child
}

test('installs the bundled plugin with one explicit DSH command and verifies the result', async () => {
  let installed = false
  let invocation = null
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    dshExecutable: '/usr/local/bin/dsh',
    platform: 'linux',
    access: async () => {},
    readFile: async () => {
      if (!installed) {
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      }
      return JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION })
    },
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options }
      installed = true
      return fakeChild()
    },
  })

  const result = await manager.install({ state: 'stopped' })
  assert.equal(result.state, 'installed')
  assert.deepEqual(invocation.args, [
    'plugin', '--profile', 'web', 'add', `/app/plugins/${PLUGIN_ARCHIVE}`,
  ])
  assert.equal(invocation.command, '/usr/local/bin/dsh')
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.env.PATH.split(require('node:path').delimiter)[0], '/usr/local/bin')
})

test('quotes the bundled package path for DSH Windows shell forwarding', async () => {
  let invocation = null
  const packagePath = 'C:\\Program Files\\DSH Tunnel\\plugin.tgz'
  const manager = new CompanionPluginManager({
    homeDirectory: 'C:\\Users\\example',
    packagePath,
    platform: 'win32',
    access: async () => {},
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options }
      return fakeChild(1, 'ordinary failure')
    },
  })

  await assert.rejects(() => manager.install({ state: 'stopped' }), /配套插件安装失败/)
  assert.equal(invocation.args.at(-1), `\"${packagePath}\"`)
})

test('refuses installation while local DSH is running and never starts a process', async () => {
  let spawnCalled = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async () => {
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    },
    spawnProcess: () => {
      spawnCalled = true
      return fakeChild()
    },
  })

  await assert.rejects(() => manager.install({ state: 'running' }), /请先停止本机 DSH/)
  assert.equal(spawnCalled, false)
})

test('does not overwrite a plugin newer than the bundled version', async () => {
  let spawnCalled = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async () => JSON.stringify({ name: PLUGIN_NAME, version: '9.0.0' }),
    spawnProcess: () => {
      spawnCalled = true
      return fakeChild()
    },
  })

  const result = await manager.install({ state: 'stopped' })
  assert.equal(result.state, 'newer')
  assert.equal(spawnCalled, false)
})

test('accepts a verified installation even when DSH exits nonzero after writing it', async () => {
  let installed = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async () => {
      if (!installed) {
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      }
      return JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION })
    },
    spawnProcess: () => {
      installed = true
      return fakeChild(1)
    },
  })

  const result = await manager.install({ state: 'stopped' })
  assert.equal(result.state, 'installed')
  assert.equal(result.installedVersion, PLUGIN_VERSION)
})

test('still rejects a failed command when the plugin is absent', async () => {
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async () => {
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    },
    spawnProcess: () => fakeChild(1),
  })

  await assert.rejects(() => manager.install({ state: 'stopped' }), /配套插件安装失败/)
})

test('classifies writable-store failures without exposing raw diagnostics', () => {
  assert.equal(translateInstallFailure('[ERR_SQLITE_ERROR] unable to open database file').message, 'DSH 插件存储不可写')
  assert.equal(translateInstallFailure('EPERM: operation not permitted').message, 'DSH 插件目录不可写')
  assert.equal(translateInstallFailure('unexpected internal output').message, '配套插件安装失败')
})

test('classifies permission diagnostics emitted on stdout', async () => {
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
    spawnProcess: () => fakeChild(1, 'dsh: pnpm failed', 'EPERM: operation not permitted'),
  })

  await assert.rejects(
    () => manager.install({ state: 'stopped' }),
    /^Error: DSH 插件目录不可写$/,
  )
})

test('prepends an absolute DSH directory while preserving the rest of PATH', () => {
  const delimiter = require('node:path').delimiter
  const result = commandEnvironment(
    '/opt/homebrew/bin/dsh',
    { PATH: ['/usr/bin', '/bin'].join(delimiter), KEEP: 'yes' },
    { toolDirectory: '/app/plugin-tools', pnpmScriptPath: '/app/pnpm/bin/pnpm.cjs' },
  )
  assert.deepEqual(result.PATH.split(delimiter), ['/app/plugin-tools', '/opt/homebrew/bin', '/usr/bin', '/bin'])
  assert.equal(result.KEEP, 'yes')
  assert.equal(result.DSH_TUNNEL_PNPM_PATH, '/app/pnpm/bin/pnpm.cjs')
})

test('keeps the environment unchanged when DSH is resolved through PATH', () => {
  const environment = { PATH: 'system-path' }
  assert.deepEqual(commandEnvironment('dsh', environment), environment)
})

test('version comparison handles equal, older, newer, and prerelease-like values', () => {
  assert.equal(compareVersions('0.1.4', '0.1.4'), 0)
  assert.equal(compareVersions('0.1.3', '0.1.4'), -1)
  assert.equal(compareVersions('0.2.0', '0.1.4'), 1)
  assert.equal(compareVersions('0.1.4-beta.1', '0.1.4'), 0)
})
