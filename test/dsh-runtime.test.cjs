const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const crossSpawn = require('cross-spawn')

const {
  DEFAULT_DSH_RUNTIME,
  publicDshRuntime,
  resolveDshRuntime,
} = require('../src/core/dsh-runtime.cjs')

test('npx runtime uses the bundled wrapper without a blocking registry version probe', () => {
  let versionProbeCount = 0
  const runtime = resolveDshRuntime(DEFAULT_DSH_RUNTIME, {
    bundledExecutable: '/app/dsh-runner/dsh',
    versionResolver: () => {
      versionProbeCount += 1
      return '0.1.1-rc.2'
    },
  })
  assert.equal(runtime.mode, 'official-npx')
  assert.equal(runtime.executable, '/app/dsh-runner/dsh')
  assert.equal(runtime.environmentExecutable, '/app/dsh-runner/dsh')
  assert.equal(runtime.version, 'latest')
  assert.equal(runtime.noOpenSupported, true)
  assert.equal(runtime.startupTimeout, 300_000)
  assert.equal(runtime.resolveVersion(), null)
  assert.equal(versionProbeCount, 0)
  assert.deepEqual(publicDshRuntime(runtime), { mode: 'official-npx', version: 'latest' })
})

test('bundled POSIX npx runner selects the latest DSH package instead of falling back to a global dsh', {
  skip: process.platform === 'win32',
}, () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-runner-'))
  const fakeNpx = path.join(temporaryDirectory, 'npx')
  const output = path.join(temporaryDirectory, 'arguments.txt')
  fs.writeFileSync(fakeNpx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$DSH_RUNNER_TEST_OUTPUT"\n', { mode: 0o755 })

  try {
    const runner = path.join(__dirname, '..', 'resources', 'dsh-runner', 'dsh')
    const result = spawnSync(runner, ['web', '--port', '3080', '--no-open'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: temporaryDirectory,
        DSH_RUNNER_TEST_OUTPUT: output,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(output, 'utf8').trim().split('\n'), [
      '--yes',
      '--package=@deepseek-ai/dsh@latest',
      '--',
      'dsh',
      'web',
      '--port',
      '3080',
      '--no-open',
    ])
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('bundled POSIX npx runner preserves an npx failure exit code', {
  skip: process.platform === 'win32',
}, () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-runner-failure-'))
  const fakeNpx = path.join(temporaryDirectory, 'npx')
  fs.writeFileSync(fakeNpx, '#!/bin/sh\nexit 23\n', { mode: 0o755 })

  try {
    const runner = path.join(__dirname, '..', 'resources', 'dsh-runner', 'dsh')
    const result = spawnSync(runner, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: temporaryDirectory },
    })
    assert.equal(result.status, 23)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('bundled Windows npx runner selects the latest DSH package and preserves arguments', {
  skip: process.platform !== 'win32',
}, () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-win-runner-'))
  const fakeNpx = path.join(temporaryDirectory, 'npx.cmd')
  const output = path.join(temporaryDirectory, 'arguments.txt')
  fs.writeFileSync(fakeNpx, [
    '@echo off',
    ':loop',
    'if "%~1"=="" goto done',
    '>>"%DSH_RUNNER_TEST_OUTPUT%" echo %~1',
    'shift',
    'goto loop',
    ':done',
    'exit /b 0',
    '',
  ].join('\r\n'))

  try {
    const runner = path.join(__dirname, '..', 'resources', 'dsh-runner', 'dsh.cmd')
    const result = crossSpawn.sync(runner, ['web', '--port', '3080', '--no-open'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [
          temporaryDirectory,
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        ].join(path.delimiter),
        DSH_RUNNER_TEST_OUTPUT: output,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(output, 'utf8').trim().split(/\r?\n/u), [
      '--yes',
      '--package',
      '@deepseek-ai/dsh@latest',
      '--',
      'dsh',
      'web',
      '--port',
      '3080',
      '--no-open',
    ])
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('bundled Windows npx runner preserves an npx failure exit code', {
  skip: process.platform !== 'win32',
}, () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-win-runner-failure-'))
  const fakeNpx = path.join(temporaryDirectory, 'npx.cmd')
  fs.writeFileSync(fakeNpx, '@echo off\r\nexit /b 23\r\n')

  try {
    const runner = path.join(__dirname, '..', 'resources', 'dsh-runner', 'dsh.cmd')
    const result = crossSpawn.sync(runner, ['--version'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [
          temporaryDirectory,
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        ].join(path.delimiter),
      },
    })
    assert.equal(result.status, 23)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('system runtime resolves and validates the existing DSH executable', () => {
  const runtime = resolveDshRuntime('system', {
    bundledExecutable: '/unused/dsh',
    platform: 'darwin',
    existsSync: (filename) => filename === '/usr/local/bin/dsh',
    versionResolver: (executable) => executable === '/usr/local/bin/dsh' ? '0.1.1-rc.2' : null,
  })
  assert.equal(runtime.mode, 'system')
  assert.equal(runtime.executable, '/usr/local/bin/dsh')
  assert.equal(runtime.environmentExecutable, '/usr/local/bin/dsh')
  assert.equal(runtime.version, '0.1.1-rc.2')
  assert.equal(runtime.noOpenSupported, true)
  assert.equal(runtime.startupTimeout, 20_000)
  assert.equal(runtime.resolveVersion(), '0.1.1-rc.2')
})

test('system runtime forwards the desktop environment to discovery and version probing', () => {
  const environment = {
    APPDATA: 'C:\\Users\\Example\\AppData\\Roaming',
    PATH: 'C:\\Windows\\System32',
  }
  const expected = 'C:\\Users\\Example\\AppData\\Roaming\\npm\\dsh.cmd'
  let receivedEnvironment = null
  const runtime = resolveDshRuntime('system', {
    platform: 'win32',
    environment,
    existsSync: (filename) => filename === expected,
    versionResolver: (executable, options) => {
      assert.equal(executable, expected)
      receivedEnvironment = options.environment
      return '0.1.1-rc.2'
    },
  })
  assert.equal(runtime.executable, expected)
  assert.equal(runtime.version, '0.1.1-rc.2')
  assert.equal(receivedEnvironment, environment)
})

test('system runtime fails clearly when no working DSH is available', () => {
  assert.throws(() => resolveDshRuntime('system', {
    bundledExecutable: '/unused/dsh',
    platform: 'win32',
    versionResolver: () => null,
  }), /没有找到可用的系统 DSH/)
})
