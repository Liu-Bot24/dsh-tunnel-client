const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')

const { readRemoteWebAuthUrl } = require('../src/core/remote-web-auth.cjs')

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-token'
const endpoint = {
  id: 'remote',
  mode: 'ssh',
  name: 'Remote',
  sshHost: 'remote-alias',
  sshUser: 'tester',
  sshPort: 22,
  remotePort: 3080,
  localPort: 13080,
}

function clientReturning(body) {
  return class FakeClient extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'))
    }

    sftp(callback) {
      callback(null, {
        realpath(_value, done) { done(null, '/Users/tester') },
        createReadStream() {
          const stream = new PassThrough()
          queueMicrotask(() => stream.end(body))
          return stream
        },
      })
    }

    end() {}
  }
}

test('reads and validates a remote DSH Tunnel handoff without rewriting it in the reader', async () => {
  const url = `http://127.0.0.1:3080/?token=${TOKEN}`
  const result = await readRemoteWebAuthUrl(endpoint, {
    identityFile: '/identity',
    knownHostsPath: '/known-hosts',
    ClientCtor: clientReturning(`${JSON.stringify({ version: 1, port: 3080, url })}\n`),
    fsImpl: { promises: { readFile: async filename => filename === '/identity' ? Buffer.from('key') : 'hosts' } },
    resolve: async value => value,
  })
  assert.equal(result, url)
})

test('rejects a handoff whose URL does not match the configured remote port', async () => {
  const url = `http://127.0.0.1:3081/?token=${TOKEN}`
  const result = await readRemoteWebAuthUrl(endpoint, {
    identityFile: '/identity',
    knownHostsPath: '/known-hosts',
    ClientCtor: clientReturning(`${JSON.stringify({ version: 1, port: 3080, url })}\n`),
    fsImpl: { promises: { readFile: async filename => filename === '/identity' ? Buffer.from('key') : 'hosts' } },
    resolve: async value => value,
  })
  assert.equal(result, null)
})
