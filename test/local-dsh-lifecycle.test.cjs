const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const { LocalDshManager, probeLocalService } = require('../src/core/local-dsh-manager.cjs')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

function exists(pid) {
  if (!Number.isInteger(pid)) return false
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(20)
  }
  assert.fail('process lifecycle condition did not settle')
}

function fixture(t, { wrapperExits = false, serve = true } = {}) {
  let wrapper
  let descendantPid
  let stderr = ''
  const childSource = `
    const http = require('node:http');
    process.on('SIGTERM', () => {});
    process.stderr.write('DSH_TEST_CHILD=' + process.pid + '\\n');
    ${serve ? "http.createServer((req, res) => res.end('<title>DeepSeek Harness</title>')).listen(Number(process.argv[1]), '127.0.0.1');" : 'setInterval(() => {}, 1000);'}
  `
  const wrapperSource = `
    const { spawn } = require('node:child_process');
    process.on('SIGUSR1', () => process.exit(2));
    process.on('SIGTERM', () => { ${wrapperExits ? 'process.exit(0);' : ''} });
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, process.argv[1]], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', () => process.exit(0));
    setInterval(() => {}, 1000);
  `
  t.after(async () => {
    // Only clean up the two processes created by this fixture if an assertion failed.
    for (const pid of [descendantPid, wrapper?.pid]) {
      if (!exists(pid)) continue
      try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await until(() => !exists(wrapper?.pid) && !exists(descendantPid))
  })
  return {
    spawnProcess(_executable, args, options) {
      const port = args[args.indexOf('--port') + 1]
      wrapper = spawn(process.execPath, ['-e', wrapperSource, port], options)
      wrapper.stderr.on('data', chunk => {
        stderr += chunk.toString()
        const match = stderr.match(/DSH_TEST_CHILD=(\d+)/u)
        if (match) descendantPid = Number(match[1])
      })
      return wrapper
    },
    get wrapperPid() { return wrapper?.pid },
    get descendantPid() { return descendantPid },
  }
}

for (const wrapperExits of [false, true]) {
  test(`stops a real POSIX process tree when the wrapper ${wrapperExits ? 'exits first' : 'ignores SIGTERM'}`, {
    skip: process.platform === 'win32', timeout: 10000,
  }, async t => {
    const port = await freePort()
    const external = http.createServer((req, res) => res.end('<title>DeepSeek Harness</title>'))
    await new Promise(resolve => external.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => external.close(resolve)))
    const externalPort = external.address().port
    const processes = fixture(t, { wrapperExits })
    const manager = new LocalDshManager({
      executable: 'test-wrapper', noOpenSupported: true,
      spawnProcess: processes.spawnProcess,
      startupTimeout: 3000, shutdownTimeout: 200, pollInterval: 10,
    })
    await manager.start(port)
    await until(() => Number.isInteger(processes.descendantPid))
    assert.equal(await probeLocalService(port), 'dsh')
    const first = manager.stop()
    const second = manager.stop()
    const [state] = await Promise.all([first, second])
    assert.equal(first, second, 'concurrent stops share one cleanup operation')
    assert.equal(state.state, 'stopped')
    assert.equal(state.owned, false)
    assert.equal(await probeLocalService(port), 'free')
    await until(() => !exists(processes.wrapperPid) && !exists(processes.descendantPid))
    assert.equal(await probeLocalService(externalPort), 'dsh', 'unrelated DSH listener is untouched')
  })
}

test('cancels a real POSIX startup and cleans its not-yet-listening descendants', {
  skip: process.platform === 'win32', timeout: 10000,
}, async t => {
  const port = await freePort()
  const processes = fixture(t, { serve: false })
  const manager = new LocalDshManager({
    executable: 'test-wrapper', noOpenSupported: true,
    spawnProcess: processes.spawnProcess,
    startupTimeout: 3000, shutdownTimeout: 200, pollInterval: 10,
  })
  const starting = manager.start(port).catch(error => error)
  await until(() => Number.isInteger(processes.descendantPid))
  const state = await manager.stop()
  await starting
  assert.equal(state.state, 'stopped')
  assert.equal(manager.hasOwnedProcess(), false)
  await until(() => !exists(processes.wrapperPid) && !exists(processes.descendantPid))
})

test('cleans remaining POSIX descendants when the wrapper crashes after startup', {
  skip: process.platform === 'win32', timeout: 10000,
}, async t => {
  const port = await freePort()
  const processes = fixture(t)
  const manager = new LocalDshManager({
    executable: 'test-wrapper', noOpenSupported: true,
    spawnProcess: processes.spawnProcess,
    startupTimeout: 3000, shutdownTimeout: 200, pollInterval: 10,
  })
  await manager.start(port)
  await until(() => Number.isInteger(processes.descendantPid))
  process.kill(processes.wrapperPid, 'SIGUSR1')
  await until(() => !manager.hasOwnedProcess())
  assert.equal(manager.getState().state, 'error')
  assert.equal(manager.getState().owned, false)
  assert.equal(await probeLocalService(port), 'free')
  await until(() => !exists(processes.wrapperPid) && !exists(processes.descendantPid))
})
