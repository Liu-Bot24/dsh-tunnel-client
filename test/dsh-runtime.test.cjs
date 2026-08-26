const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const crossSpawn = require('cross-spawn')

const { resolveDshRuntime } = require('../src/core/dsh-runtime.cjs')

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
  assert.equal(runtime.version, null)
  assert.equal(runtime.noOpenSupported, null)
  assert.equal(runtime.startupTimeout, 300_000)
  assert.equal(runtime.resolveVersion('/app/dsh-runner/dsh'), '0.1.0-rc.7')
  assert.deepEqual(received, {
    executable: '/app/dsh-runner/dsh',
    environment,
  })
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
