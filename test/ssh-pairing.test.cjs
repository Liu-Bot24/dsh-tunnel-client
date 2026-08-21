const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  SshPairingService,
  hostKeyFingerprint,
  hostToken,
  knownHostsContains,
  knownHostsLine,
  parseSshConfigOutput,
  resolveSshEndpoint,
} = require('../src/core/ssh-pairing.cjs')

function sshString(value) {
  const contents = Buffer.from(value)
  const result = Buffer.alloc(4 + contents.length)
  result.writeUInt32BE(contents.length)
  contents.copy(result, 4)
  return result
}

function fakeHostKey() {
  return Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 7))])
}

function endpoint() {
  return {
    id: 'remote-one',
    mode: 'ssh',
    name: 'Remote',
    sshHost: '192.0.2.10',
    sshUser: 'remote-user',
    sshPort: 2222,
    remotePort: 3080,
    localPort: 13080,
  }
}

test('formats and recognizes a trusted host key', () => {
  const key = fakeHostKey()
  const line = knownHostsLine('192.0.2.10', 2222, key)
  assert.match(line, /^\[192\.0\.2\.10\]:2222 ssh-ed25519 /)
  assert.equal(knownHostsContains(`${line}\n`, '192.0.2.10', 2222, key), true)
  assert.equal(knownHostsContains(`${line}\n`, '192.0.2.11', 2222, key), false)
})

test('recognizes an OpenSSH-hashed host token', () => {
  const key = fakeHostKey()
  const token = hostToken('192.0.2.10', 22)
  const salt = Buffer.alloc(20, 4)
  const digest = crypto.createHmac('sha1', salt).update(token).digest()
  const hashed = `|1|${salt.toString('base64')}|${digest.toString('base64')}`
  const line = `${hashed} ssh-ed25519 ${key.toString('base64')}`
  assert.equal(knownHostsContains(line, '192.0.2.10', 22, key), true)
})

test('resolves an SSH config alias before pairing', async () => {
  let received = null
  const resolved = await resolveSshEndpoint({
    ...endpoint(),
    sshHost: 'dsh-alias',
    sshUser: null,
    sshPort: null,
  }, {
    run: async (command, args) => {
      received = { command, args }
      return { stdout: 'host dsh-alias\nuser remote-user\nhostname 192.0.2.10\nport 2222\n' }
    },
  })

  assert.deepEqual(received, { command: 'ssh', args: ['-G', 'dsh-alias'] })
  assert.equal(resolved.sshHost, '192.0.2.10')
  assert.equal(resolved.sshUser, 'remote-user')
  assert.equal(resolved.sshPort, 2222)
})

test('rejects incomplete SSH config output', () => {
  assert.throws(() => parseSshConfigOutput('hostname 192.0.2.10\nport 22\n'), /无法解析/)
})

test('pairing installs the generated public key and persists only host trust', async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-pairing-'))
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const storageDirectory = path.join(root, 'app-ssh')
  const knownHostsPath = path.join(root, 'user-ssh', 'known_hosts')
  const key = fakeHostKey()
  const fingerprint = hostKeyFingerprint(key)
  let receivedPassword = null
  let receivedPublicKey = null
  const service = new SshPairingService({
    storageDirectory,
    knownHostsPath,
    scan: async () => ({ host: '192.0.2.10', port: 2222, rawKey: key }),
    resolve: async (value) => value,
    run: async (_command, args) => {
      const privatePath = args.at(-1)
      await fs.promises.writeFile(privatePath, 'private-key-placeholder')
      await fs.promises.writeFile(`${privatePath}.pub`, 'ssh-ed25519 AAAATEST dsh-tunnel-client\n')
    },
    install: async (_endpoint, password, publicKey) => {
      receivedPassword = password
      receivedPublicKey = publicKey
    },
  })

  const result = await service.pair(endpoint(), {
    password: 'one-time-password',
    approvedFingerprint: fingerprint,
  })

  assert.equal(result.paired, true)
  assert.equal(receivedPassword, 'one-time-password')
  assert.equal(receivedPublicKey, 'ssh-ed25519 AAAATEST dsh-tunnel-client\n')
  const knownHosts = await fs.promises.readFile(knownHostsPath, 'utf8')
  assert.equal(knownHostsContains(knownHosts, '192.0.2.10', 2222, key), true)
  assert.doesNotMatch(knownHosts, /one-time-password/)
})

test('pairing refuses a host key that changed after confirmation', async () => {
  const key = fakeHostKey()
  const service = new SshPairingService({
    storageDirectory: '/unused',
    knownHostsPath: '/unused/known_hosts',
    scan: async () => ({ host: '192.0.2.10', port: 2222, rawKey: key }),
    resolve: async (value) => value,
  })
  await assert.rejects(
    () => service.pair(endpoint(), { password: 'secret', approvedFingerprint: 'SHA256:different' }),
    /主机指纹已变化/,
  )
})
