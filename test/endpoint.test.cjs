const test = require('node:test')
const assert = require('node:assert/strict')
const { loopbackUrl, normalizeEndpoint } = require('../src/core/endpoint.cjs')

test('normalizes an SSH config alias with stable defaults', () => {
  const endpoint = normalizeEndpoint({ name: ' Work Mac ', sshHost: 'work-mac' }, { idFactory: () => 'endpoint-1' })
  assert.deepEqual(endpoint, {
    id: 'endpoint-1',
    name: 'Work Mac',
    sshHost: 'work-mac',
    sshUser: null,
    sshPort: null,
    remotePort: 3080,
    localPort: 13080,
  })
  assert.equal(loopbackUrl(endpoint), 'http://127.0.0.1:13080/')
})
test('rejects an SSH option disguised as a host', () => {
  assert.throws(() => normalizeEndpoint({ name: 'bad', sshHost: '-oProxyCommand=evil' }), /sshHost/)
})

test('rejects invalid ports', () => {
  assert.throws(() => normalizeEndpoint({ name: 'bad', sshHost: 'host', localPort: 70000 }), /localPort/)
})
