const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const crossSpawn = require('cross-spawn')

const {
  DEFAULT_DSH_LAUNCH_COMMAND,
  parseLaunchCommand,
  resolveDshRuntime,
} = require('../src/core/dsh-runtime.cjs')

test('automatic runtime always uses the bundled npx launcher and probes its resolved DSH version', () => {
  const environment = { PATH: '/usr/bin:/bin' }
  let received = null
  const runtime = resolveDshRuntime({
    bundledExecutable: '/app/dsh-runner/dsh',
    environment,
    versionResolver: (executable, options) => {
      received = { executable, environment: options.environment }
      return '0.1.0-rc.7'
    },
  })
  assert.equal(runtime.executable, '/app/dsh-runner/dsh')
  assert.equal(runtime.environmentExecutable, '/app/dsh-runner/dsh')
  assert.equal(runtime.launchCommand, DEFAULT_DSH_LAUNCH_COMMAND)
  assert.deepEqual(runtime.commandArgs, [])
  assert.equal(runtime.version, null)
  assert.equal(runtime.noOpenSupported, null)
  assert.equal(runtime.startupTimeout, 300_000)
  assert.equal(runtime.resolveVersion('/app/dsh-runner/dsh'), '0.1.0-rc.7')
  assert.deepEqual(received, {
    executable: '/app/dsh-runner/dsh',
    environment: {
      PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    },
  })
})

test('custom runtime parses quoted paths and preserves command arguments without a shell', () => {
  const runtime = resolveDshRuntime({
    bundledExecutable: '/app/dsh-runner/dsh',
    launchCommand: '"/Applications/Custom DSH/bin/dsh" --profile private',
    environment: { PATH: '/usr/bin:/bin' },
    platform: 'darwin',
  })
  assert.equal(runtime.executable, '/Applications/Custom DSH/bin/dsh')
  assert.deepEqual(runtime.commandArgs, ['--profile', 'private'])
  assert.equal(runtime.environment.PATH.split(path.delimiter)[0], '/opt/homebrew/bin')
})

test('custom NPX runtime resolves common GUI paths and probes the selected package', () => {
  let received = null
  const runtime = resolveDshRuntime({
    bundledExecutable: '/app/dsh-runner/dsh',
    launchCommand: 'npx --yes @deepseek-ai/dsh@0.1.2-rc.1',
    environment: { PATH: '/usr/bin:/bin' },
    platform: 'darwin',
    existsSync: filename => filename === '/opt/homebrew/bin/npx',
    versionResolver: (executable, options) => {
      received = { executable, options }
      return '0.1.2-rc.1'
    },
  })
  assert.equal(runtime.executable, '/opt/homebrew/bin/npx')
  assert.deepEqual(runtime.commandArgs, ['--yes', '@deepseek-ai/dsh@0.1.2-rc.1'])
  assert.equal(runtime.noOpenSupported, true)
  assert.equal(runtime.resolveVersion(runtime.executable), '0.1.2-rc.1')
  assert.equal(received.executable, '/opt/homebrew/bin/npx')
  assert.deepEqual(received.options.commandArgs, ['--yes', '@deepseek-ai/dsh@0.1.2-rc.1'])
})

test('exact custom DSH versions preserve the rc.7 no-open boundary', () => {
  const runtime = resolveDshRuntime({
    bundledExecutable: '/app/dsh-runner/dsh',
    launchCommand: 'npx --yes @deepseek-ai/dsh@0.1.0-rc.7',
    platform: 'darwin',
  })
  assert.equal(runtime.noOpenSupported, false)
})

test('Windows custom commands resolve from Windows PATH entries', () => {
  const runtime = resolveDshRuntime({
    bundledExecutable: 'C:\\App\\dsh.cmd',
    launchCommand: 'npx --yes @deepseek-ai/dsh@next',
    environment: { PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' },
    platform: 'win32',
    existsSync: filename => filename === 'C:\\Users\\Example\\AppData\\Roaming\\npm\\npx.cmd',
  })
  assert.equal(runtime.executable, 'C:\\Users\\Example\\AppData\\Roaming\\npm\\npx.cmd')
  assert.equal(runtime.noOpenSupported, true)
})

test('launch command parser keeps Windows paths and rejects incomplete quotes', () => {
  assert.deepEqual(
    parseLaunchCommand('"C:\\Program Files\\nodejs\\npx.cmd" --yes @deepseek-ai/dsh'),
    ['C:\\Program Files\\nodejs\\npx.cmd', '--yes', '@deepseek-ai/dsh'],
  )
  assert.throws(() => parseLaunchCommand('"C:\\Program Files\\nodejs\\npx.cmd'), /引号没有闭合/)
})

test('bundled POSIX runner uses the official npx command and preserves app arguments', {
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
      '@deepseek-ai/dsh',
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

test('bundled Windows runner uses the official npx command and preserves arguments', {
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
      '@deepseek-ai/dsh',
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
