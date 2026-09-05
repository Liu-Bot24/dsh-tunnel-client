const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  CompanionPluginManager,
  PLUGIN_ARCHIVE,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  commandEnvironment,
  compareVersions,
  environmentWithDshHome,
  installBundledArchive,
  runProfileInitialize,
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

test('initializes a profile through the selected custom DSH command without a shell', async () => {
  let invocation = null
  await runProfileInitialize({
    executable: '/opt/homebrew/bin/npx',
    commandArgs: ['--yes', '@deepseek-ai/dsh@next'],
    dshHome: '/home/example/.dsh',
    platform: 'linux',
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options }
      return fakeChild()
    },
  })
  assert.equal(invocation.command, '/opt/homebrew/bin/npx')
  assert.deepEqual(invocation.args, [
    '--yes', '@deepseek-ai/dsh@next', '--profile', 'web', '--dump-config',
  ])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.env.DSH_HOME, '/home/example/.dsh')
})

test('installs only the bundled archive and verifies the result', async () => {
  let installed = false
  let bundles = []
  let dependencies = {}
  let invocation = null
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    dshExecutable: '/usr/local/bin/dsh',
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
    installArchive: async (options) => {
      invocation = options
      installed = true
    },
  })

  const result = await manager.install({ state: 'stopped' })
  assert.equal(result.state, 'installed')
  assert.equal(invocation.packagePath, `/app/plugins/${PLUGIN_ARCHIVE}`)
  assert.equal(invocation.profileDirectory, '/home/example/.dsh/profiles/web')
  assert.equal(invocation.platform, 'linux')
  assert.equal(dependencies[PLUGIN_NAME], `file:/app/plugins/${PLUGIN_ARCHIVE}`)
})

test('rewrites a stale bundled archive reference before isolated installation', async () => {
  let manifest = {
    dsh: { profile: { bundles: [PLUGIN_NAME] } },
    dependencies: {
      [PLUGIN_NAME]: 'file:/old-app/plugins/dsh-plugin-artifact-preview-0.1.4.tgz',
      'another-plugin': '1.0.0',
    },
  }
  let installedVersion = '0.1.4'
  let manifestAtInstall = null
  const packagePath = `/new-app/plugins/${PLUGIN_ARCHIVE}`
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    packagePath,
    platform: 'linux',
    access: async () => {},
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) return JSON.stringify(manifest)
      return JSON.stringify({ name: PLUGIN_NAME, version: installedVersion })
    },
    writeFile: async (_filename, contents) => {
      manifest = JSON.parse(contents)
    },
    installArchive: async () => {
      manifestAtInstall = structuredClone(manifest)
      installedVersion = PLUGIN_VERSION
    },
  })

  const result = await manager.install({ state: 'stopped' })
  assert.equal(result.state, 'installed')
  assert.equal(manifestAtInstall.dependencies[PLUGIN_NAME], `file:${packagePath}`)
  assert.equal(manifestAtInstall.dependencies['another-plugin'], '1.0.0')
})

test('selects the Windows profile for isolated installation', async () => {
  let invocation = null
  const packagePath = 'C:\\Program Files\\DSH Tunnel\\plugin.tgz'
  const manager = new CompanionPluginManager({
    homeDirectory: 'C:\\Users\\example',
    packagePath,
    platform: 'win32',
    writeFile: async () => {},
    access: async () => {},
    readFile: async (filename) => {
      if (filename.endsWith('profiles\\web\\package.json')) {
        return JSON.stringify({ dsh: { profile: { bundles: [] } } })
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    installArchive: async (options) => {
      invocation = options
      throw new Error('配套插件安装失败')
    },
  })

  await assert.rejects(() => manager.install({ state: 'stopped' }), /配套插件安装失败/)
  assert.equal(invocation.packagePath, packagePath)
  assert.equal(invocation.profileDirectory, 'C:\\Users\\example\\.dsh\\profiles\\web')
  assert.equal(invocation.platform, 'win32')
})

test('initializes a fresh DSH web profile before installing the plugin', async () => {
  let profileReady = false
  let installed = false
  let bundles = []
  const invocations = []
  let archiveInvocation = null
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
      profileReady = true
      return fakeChild()
    },
    installArchive: async (options) => {
      archiveInvocation = options
      installed = true
    },
  })

  const result = await manager.install({ state: 'stopped' })
  assert.equal(result.state, 'installed')
  assert.deepEqual(invocations.map(({ command, args }) => ({ command, args })), [
    {
      command: '/app/dsh-runner/dsh',
      args: ['--profile', 'web', '--dump-config'],
    },
  ])
  assert.equal(invocations[0].options.env.DSH_HOME, '/home/example/.dsh')
  assert.equal(archiveInvocation.profileDirectory, '/home/example/.dsh/profiles/web')
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

test('uninstalls only the companion plugin and preserves other dependencies', async () => {
  let installed = true
  let manifest = {
    dsh: { profile: { bundles: [PLUGIN_NAME, 'another-plugin'] } },
    dependencies: {
      [PLUGIN_NAME]: `file:/app/plugins/${PLUGIN_ARCHIVE}`,
      'another-plugin': '1.0.0',
    },
  }
  let invocation = null
  const manager = new CompanionPluginManager({
    homeDirectory: '/home/example',
    platform: 'linux',
    packagePath: `/app/plugins/${PLUGIN_ARCHIVE}`,
    access: async () => {},
    writeFile: async (_filename, contents) => {
      manifest = JSON.parse(contents)
    },
    readFile: async (filename) => {
      if (filename.endsWith('/profiles/web/package.json')) {
        return JSON.stringify(manifest)
      }
      if (!installed) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION })
    },
    removePlugin: async (options) => {
      invocation = options
      installed = false
    },
  })

  const result = await manager.uninstall({ state: 'stopped' })
  assert.equal(result.state, 'missing')
  assert.equal(invocation.profileDirectory, '/home/example/.dsh/profiles/web')
  assert.deepEqual(manifest.dsh.profile.bundles, ['another-plugin'])
  assert.equal(PLUGIN_NAME in manifest.dependencies, false)
  assert.equal(manifest.dependencies['another-plugin'], '1.0.0')
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

test('accepts a verified isolated archive installation', async () => {
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
    installArchive: async () => {
      installed = true
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

test('surfaces an isolated archive failure when the plugin is absent', async () => {
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
    installArchive: async () => {
      throw new Error('配套插件安装失败')
    },
  })

  await assert.rejects(() => manager.install({ state: 'stopped' }), /配套插件安装失败/)
})

test('replaces only the companion plugin from the real bundled archive', async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-install-'))
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const profileDirectory = path.join(root, 'profiles', 'web')
  const targetDirectory = path.join(profileDirectory, 'node_modules', PLUGIN_NAME)
  const unrelatedDirectory = path.join(profileDirectory, 'node_modules', 'trace-insight-placeholder')
  await fs.promises.mkdir(targetDirectory, { recursive: true })
  await fs.promises.mkdir(unrelatedDirectory, { recursive: true })
  await fs.promises.writeFile(
    path.join(targetDirectory, 'package.json'),
    JSON.stringify({ name: PLUGIN_NAME, version: '0.1.5' }),
  )
  await fs.promises.writeFile(path.join(unrelatedDirectory, 'sentinel.txt'), 'untouched')

  await installBundledArchive({
    packagePath: path.join(__dirname, '..', 'resources', 'plugins', PLUGIN_ARCHIVE),
    profileDirectory,
    platform: process.platform,
  })

  const installed = JSON.parse(await fs.promises.readFile(path.join(targetDirectory, 'package.json'), 'utf8'))
  assert.equal(installed.version, PLUGIN_VERSION)
  assert.equal(await fs.promises.readFile(path.join(unrelatedDirectory, 'sentinel.txt'), 'utf8'), 'untouched')
  const entries = await fs.promises.readdir(path.join(profileDirectory, 'node_modules'))
  assert.equal(entries.some((entry) => entry.includes('-staging-') || entry.includes('.backup-')), false)
})

test('keeps the existing plugin when an archive fails validation', async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-invalid-'))
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const profileDirectory = path.join(root, 'profiles', 'web')
  const targetDirectory = path.join(profileDirectory, 'node_modules', PLUGIN_NAME)
  await fs.promises.mkdir(targetDirectory, { recursive: true })
  await fs.promises.writeFile(
    path.join(targetDirectory, 'package.json'),
    JSON.stringify({ name: PLUGIN_NAME, version: '0.1.5' }),
  )

  await assert.rejects(
    () => installBundledArchive({
      packagePath: '/unused/invalid.tgz',
      profileDirectory,
      platform: process.platform,
      tarImpl: {
        x: async ({ cwd }) => {
          await fs.promises.writeFile(
            path.join(cwd, 'package.json'),
            JSON.stringify({ name: 'wrong-plugin', version: PLUGIN_VERSION }),
          )
        },
      },
    }),
    /配套插件安装包格式不正确/,
  )

  const existing = JSON.parse(await fs.promises.readFile(path.join(targetDirectory, 'package.json'), 'utf8'))
  assert.equal(existing.version, '0.1.5')
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
