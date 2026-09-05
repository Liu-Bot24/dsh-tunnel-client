const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { readRemoteWebAuthUrl, MAX_HANDOFF_BYTES } = require('../src/core/remote-web-auth.cjs')
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-token'
const endpoint = { id: 'remote', mode: 'ssh', name: 'Remote', sshHost: 'remote-alias', sshUser: 'tester', sshPort: 22, remotePort: 3080, localPort: 13080 }
const url = `http://127.0.0.1:3080/?token=${TOKEN}`

function fixture(body, { code = 0, hanging = false, exists = false } = {}) {
  const calls = []
  let killed = false
  return { calls, get killed() { return killed },
    options: {
      identityFile: '/managed-key', knownHostsPath: '/known-hosts',
      fsImpl: { existsSync: () => exists },
      spawnProcess: (command, args, options) => {
        const child = new EventEmitter()
        child.stdout = new PassThrough(); child.stderr = new PassThrough()
        child.kill = () => { killed = true }
        child.stdin = { end(script) {
          calls.push({ command, args, options, script })
          if (!hanging) queueMicrotask(() => {
            child.stdout.emit('data', body)
            child.emit('close', code)
          })
        } }
        return child
      },
    },
  }
}

test('uses the configured OpenSSH identity when no application-specific key exists', async () => {
  const f = fixture(JSON.stringify({ version: 1, port: 3080, url }))
  assert.equal(await readRemoteWebAuthUrl(endpoint, f.options), url)
  const call = f.calls[0]
  assert.equal(call.command, 'ssh')
  assert.ok(call.args.includes('StrictHostKeyChecking=yes'))
  assert.ok(call.args.includes('BatchMode=yes'))
  assert.ok(call.args.includes('tester@remote-alias'))
  assert.ok(!call.args.includes('-i'))
  assert.deepEqual(call.args.slice(-2), ['node', '-'])
  assert.equal(call.options.shell, false)
  assert.match(call.script, /web-auth-3080\.json/)
  assert.ok(!JSON.stringify(call).includes(TOKEN))
})

test('also passes an existing application identity without dropping the SSH alias', async () => {
  const f = fixture(JSON.stringify({ version: 1, port: 3080, url }), { exists: true })
  assert.equal(await readRemoteWebAuthUrl(endpoint, f.options), url)
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-i') + 1], '/managed-key')
  assert.ok(f.calls[0].args.includes('tester@remote-alias'))
})

test('rejects a handoff with the wrong remote port and accepts an absent handoff as unavailable', async () => {
  const f = fixture(JSON.stringify({ version: 1, port: 3080, url: url.replace(':3080', ':3081') }))
  assert.equal(await readRemoteWebAuthUrl(endpoint, f.options), null)
  assert.equal(await readRemoteWebAuthUrl(endpoint, fixture('').options), null)
})

test('does not accept partial output from failed SSH, malformed JSON, or oversized files', async () => {
  for (const f of [fixture(JSON.stringify({ version: 1, port: 3080, url }), { code: 255 }), fixture('{bad'), fixture('x'.repeat(MAX_HANDOFF_BYTES + 1))]) {
    await assert.rejects(readRemoteWebAuthUrl(endpoint, f.options), /^Error: 无法读取远端 DSH 认证信息$/)
  }
})

test('bounds a stalled SSH reader and terminates only its child', async () => {
  const f = fixture('', { hanging: true })
  await assert.rejects(readRemoteWebAuthUrl(endpoint, { ...f.options, timeoutMs: 5 }), /无法读取远端/)
  assert.equal(f.killed, true)
})
