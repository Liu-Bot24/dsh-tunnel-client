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
  environmentWithDshHome,
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

test('installs the bundled plugin offline with the app runtime and verifies the result', async () => {
  let installed = false
  let bundles = []
  let dependencies = {}
  let invocation = null
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    dshExecutable: '/usr/local/bin/dsh',
    nodeExecutable: '/app/DSH Tunnel',
    pnpmScriptPath: '/app/pnpm/bin/pnpm.cjs',
    platform: 'linux',
    access: async () => {},
    writeFile: async (_filename, contents) => {
      const manifest = JSON.parse(contents)
      bundles = manifest.dsh.profile.bundles
      dependencies = manifest.dependencies ?? dependencies
    },
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) {
        return JSON.stringify({ dsh: { profile: { bundles } }, dependencies })
      }
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
    '/app/pnpm/bin/pnpm.cjs', '--dir', '/home/example/.dsh/profiles/web',
    'add', '--offline', `/app/plugins/${PLUGIN_ARCHIVE}`,
  ])
  assert.equal(invocation.command, '/app/DSH Tunnel')
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(invocation.options.env.npm_node_execpath, '/app/DSH Tunnel')
  assert.equal(dependencies[PLUGIN_NAME], `file:/app/plugins/${PLUGIN_ARCHIVE}`)
})

test('rewrites a stale bundled archive reference before invoking pnpm', async () => {
  let manifest = {
    dsh: { profile: { bundles: [PLUGIN_NAME] } },
    dependencies: {
      [PLUGIN_NAME]: 'file:/old-app/plugins/dsh-plugin-artifact-preview-0.1.4.tgz',
      'another-plugin': '1.0.0',
    },
  }
  let installedVersion = '0.1.4'
  let manifestAtSpawn = null
  const packagePath = `/new-app/plugins/${PLUGIN_ARCHIVE}`
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath,
    nodeExecutable: '/new-app/DSH Tunnel',
    pnpmScriptPath: '/new-app/pnpm/bin/pnpm.cjs',
    platform: 'linux',
    access: async () => {},
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) return JSON.stringify(manifest)
      return JSON.stringify({ name: PLUGIN_NAME, version: installedVersion })
    },
    writeFile: async (_filename, contents) => {
      manifest = JSON.parse(contents)
    },
    spawnProcess: () => {
      manifestAtSpawn = structuredClone(manifest)
      installedVersion = PLUGIN_VERSION
      return fakeChild()
    },
  })

  const result = await manager.install({ state: 'stopped' })
  assert.equal(result.state, 'installed')
  assert.equal(manifestAtSpawn.dependencies[PLUGIN_NAME], `file:${packagePath}`)
  assert.equal(manifestAtSpawn.dependencies['another-plugin'], '1.0.0')
})

test('uses the bundled pnpm script through the app runtime on Windows', async () => {
  let invocation = null
  const packagePath = 'C:\\Program Files\\DSH Tunnel\\plugin.tgz'
  const manager = new CompanionPluginManager({
    homeDirectory: 'C:\\Users\\example',
    packagePath,
    toolDirectory: 'C:\\Program Files\\DSH Tunnel\\plugin-tools',
    pnpmScriptPath: 'C:\\Program Files\\DSH Tunnel\\pnpm\\bin\\pnpm.cjs',
    nodeExecutable: 'C:\\Program Files\\DSH Tunnel\\DSH Tunnel.exe',
    platform: 'win32',
    writeFile: async () => {},
    access: async () => {},
    readFile: async (filename) => {
      if (filename.endsWith('profiles\\web\\package.json')) {
        return JSON.stringify({ dsh: { profile: { bundles: [] } } })
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options }
      return fakeChild(1, 'ordinary failure')
    },
  })

  await assert.rejects(() => manager.install({ state: 'stopped' }), /配套插件安装失败/)
  assert.equal(invocation.command, 'C:\\Program Files\\DSH Tunnel\\DSH Tunnel.exe')
  assert.deepEqual(invocation.args, [
    'C:\\Program Files\\DSH Tunnel\\pnpm\\bin\\pnpm.cjs',
    '--dir', 'C:\\Users\\example\\.dsh\\profiles\\web', 'add', '--offline', packagePath,
  ])
  assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, '1')
})

test('initializes a fresh DSH web profile before installing the plugin', async () => {
  let profileReady = false
  let installed = false
  let bundles = []
  const invocations = []
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    dshExecutable: '/app/dsh-runner/dsh',
    nodeExecutable: '/app/DSH Tunnel',
    pnpmScriptPath: '/app/pnpm/bin/pnpm.cjs',
    platform: 'linux',
    access: async () => {},
    writeFile: async (_filename, contents) => {
      bundles = JSON.parse(contents).dsh.profile.bundles
    },
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) {
        if (!profileReady) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return JSON.stringify({ dsh: { profile: { bundles } } })
      }
      if (!installed) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION })
    },
    spawnProcess: (command, args, options) => {
      invocations.push({ command, args, options })
      if (command === '/app/dsh-runner/dsh') profileReady = true
      else installed = true
      return fakeChild()
    },
  })

  const result = await manager.install({ state: 'stopped' })
  assert.equal(result.state, 'installed')
  assert.deepEqual(invocations.map(({ command, args }) => ({ command, args })), [
    {
      command: '/app/dsh-runner/dsh',
      args: ['--profile', 'web', '--dump-config'],
    },
    {
      command: '/app/DSH Tunnel',
      args: [
        '/app/pnpm/bin/pnpm.cjs', '--dir', '/home/example/.dsh/profiles/web',
        'add', '--offline', `/app/plugins/${PLUGIN_ARCHIVE}`,
      ],
    },
  ])
  assert.equal(invocations[0].options.env.DSH_HOME, '/home/example/.dsh')
})

test('reports a clear error when a fresh DSH web profile cannot be initialized', async () => {
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    dshExecutable: '/app/dsh-runner/dsh',
    nodeExecutable: '/app/DSH Tunnel',
    pnpmScriptPath: '/app/pnpm/bin/pnpm.cjs',
    platform: 'linux',
    access: async () => {},
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
    spawnProcess: () => fakeChild(1, 'network unavailable'),
  })

  await assert.rejects(
    () => manager.install({ state: 'stopped' }),
    /^Error: DSH Web 配置初始化失败$/,
  )
})

test('refuses installation while local DSH is running and never starts a process', async () => {
  let spawnCalled = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
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

test('refuses plugin changes after a failed stop while the DSH process is still owned', async () => {
  let spawnCalled = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async () => JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION }),
    spawnProcess: () => {
      spawnCalled = true
      return fakeChild()
    },
  })

  const state = await manager.inspect({ state: 'error', owned: true })
  assert.equal(state.blockedByRunningDsh, true)
  assert.equal(state.canInstall, false)
  assert.equal(state.canUninstall, false)
  await assert.rejects(() => manager.uninstall({ state: 'error', owned: true }), /请先停止本机 DSH/)
  assert.equal(spawnCalled, false)
})

test('uninstalls the plugin with the bundled pnpm script and verifies removal', async () => {
  let installed = true
  let bundles = [PLUGIN_NAME]
  let invocation = null
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    nodeExecutable: '/app/DSH Tunnel',
    pnpmScriptPath: '/app/pnpm/bin/pnpm.cjs',
    access: async () => {},
    writeFile: async (_filename, contents) => {
      bundles = JSON.parse(contents).dsh.profile.bundles
    },
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) {
        return JSON.stringify({ dsh: { profile: { bundles } } })
      }
      if (!installed) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION })
    },
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options }
      installed = false
      return fakeChild()
    },
  })

  const result = await manager.uninstall({ state: 'stopped' })
  assert.equal(result.state, 'missing')
  assert.deepEqual(invocation.args, [
    '/app/pnpm/bin/pnpm.cjs', '--dir', '/home/example/.dsh/profiles/web',
    'remove', PLUGIN_NAME,
  ])
  assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, '1')
})

test('refuses uninstallation while local DSH is running', async () => {
  let spawnCalled = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async () => JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION }),
    spawnProcess: () => {
      spawnCalled = true
      return fakeChild()
    },
  })

  await assert.rejects(() => manager.uninstall({ state: 'running' }), /请先停止本机 DSH/)
  assert.equal(spawnCalled, false)
})

test('does not overwrite a plugin newer than the bundled version', async () => {
  let spawnCalled = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async (filename) => filename.endsWith('/profiles/web/package.json')
      ? JSON.stringify({ dsh: { profile: { bundles: [PLUGIN_NAME] } } })
      : JSON.stringify({ name: PLUGIN_NAME, version: '9.0.0' }),
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
  let bundles = []
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    writeFile: async (_filename, contents) => {
      bundles = JSON.parse(contents).dsh.profile.bundles
    },
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) {
        return JSON.stringify({ dsh: { profile: { bundles } } })
      }
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

test('repairs an installed plugin whose bundle entry is missing without reinstalling files', async () => {
  let bundles = []
  let spawnCalled = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    readFile: async (filename) => filename.endsWith('/profiles/web/package.json')
      ? JSON.stringify({ dsh: { profile: { bundles } } })
      : JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION }),
    writeFile: async (_filename, contents) => {
      bundles = JSON.parse(contents).dsh.profile.bundles
    },
    spawnProcess: () => {
      spawnCalled = true
      return fakeChild()
    },
  })

  const before = await manager.inspect({ state: 'stopped' })
  assert.equal(before.state, 'inactive')
  const after = await manager.install({ state: 'stopped' })
  assert.equal(after.state, 'installed')
  assert.equal(spawnCalled, false)
})

test('uninstall cleans a stale bundle entry even when plugin files are already missing', async () => {
  let bundles = [PLUGIN_NAME]
  let spawnCalled = false
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    writeFile: async () => {},
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) {
        return JSON.stringify({ dsh: { profile: { bundles } } })
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    writeFile: async (_filename, contents) => {
      bundles = JSON.parse(contents).dsh.profile.bundles
    },
    spawnProcess: () => {
      spawnCalled = true
      return fakeChild()
    },
  })

  const before = await manager.inspect({ state: 'stopped' })
  assert.equal(before.state, 'broken')
  assert.equal(before.canUninstall, true)
  const after = await manager.uninstall({ state: 'stopped' })
  assert.equal(after.state, 'missing')
  assert.deepEqual(bundles, [])
  assert.equal(spawnCalled, false)
})

test('still rejects a failed command when the plugin is absent', async () => {
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    writeFile: async () => {},
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) {
        return JSON.stringify({ dsh: { profile: { bundles: [] } } })
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
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
    platform: 'linux',
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

test('configures the packaged Electron executable as the Node runtime only for plugin commands', () => {
  const result = commandEnvironment(
    '/Applications/DSH Tunnel.app/Contents/MacOS/DSH Tunnel',
    { PATH: '/usr/bin:/bin', KEEP: 'yes' },
    {
      pnpmScriptPath: '/Applications/DSH Tunnel.app/Contents/Resources/pnpm/bin/pnpm.cjs',
      electronRunAsNode: true,
    },
  )
  assert.equal(result.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(result.npm_node_execpath, '/Applications/DSH Tunnel.app/Contents/MacOS/DSH Tunnel')
  assert.equal(result.npm_execpath, '/Applications/DSH Tunnel.app/Contents/Resources/pnpm/bin/pnpm.cjs')
  assert.equal(result.KEEP, 'yes')
})

test('keeps the environment unchanged when DSH is resolved through PATH', () => {
  const environment = { PATH: 'system-path' }
  assert.deepEqual(commandEnvironment('dsh', environment), environment)
})

test('sets one explicit DSH_HOME for profile initialization', () => {
  assert.deepEqual(
    environmentWithDshHome({ PATH: 'system-path', dsh_home: 'stale' }, '/home/example/.dsh'),
    { PATH: 'system-path', DSH_HOME: '/home/example/.dsh' },
  )
})

test('normalizes Windows Path casing so npm can prepend its executable directory', () => {
  const result = commandEnvironment(
    'C:\\Program Files\\DSH Tunnel\\dsh.cmd',
    { Path: 'C:\\Program Files\\nodejs', KEEP: 'yes' },
    { toolDirectory: 'C:\\Program Files\\DSH Tunnel\\plugin-tools' },
  )
  assert.equal(Object.hasOwn(result, 'Path'), false)
  assert.equal(Object.hasOwn(result, 'PATH'), true)
  assert.equal(result.KEEP, 'yes')
})

test('version comparison handles equal, older, newer, and prerelease-like values', () => {
  assert.equal(compareVersions('0.1.4', '0.1.4'), 0)
  assert.equal(compareVersions('0.1.3', '0.1.4'), -1)
  assert.equal(compareVersions('0.2.0', '0.1.4'), 1)
  assert.equal(compareVersions('0.1.4-beta.1', '0.1.4'), 0)
})
