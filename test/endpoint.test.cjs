const test = require('node:test')
const assert = require('node:assert/strict')
const { loopbackUrl, normalizeEndpoint } = require('../src/core/endpoint.cjs')

test('normalizes an SSH config alias with stable defaults', () => {
  const endpoint = normalizeEndpoint({ name: ' Work Mac ', sshHost: 'work-mac' }, { idFactory: () => 'endpoint-1' })
  assert.deepEqual(endpoint, {
    id: 'endpoint-1',
    name: 'Work Mac',
    mode: 'ssh',
    sshHost: 'work-mac',
    sshUser: null,
    sshPort: null,
    remotePort: 3080,
    localPort: 13080,
  })
  assert.equal(loopbackUrl(endpoint), 'http://127.0.0.1:13080/')
})

test('normalizes a local endpoint without SSH fields', () => {
  const endpoint = normalizeEndpoint({
    mode: 'local',
    name: 'Local DSH',
    remotePort: 3080,
  }, { idFactory: () => 'local-1' })

  assert.deepEqual(endpoint, {
    id: 'local-dsh',
    name: 'Local DSH',
    mode: 'local',
    sshHost: null,
    sshUser: null,
    sshPort: null,
    remotePort: 3080,
    localPort: null,
  })
  assert.equal(loopbackUrl(endpoint), 'http://127.0.0.1:3080/')
})

test('reserves the fixed local endpoint id', () => {
  assert.throws(
    () => normalizeEndpoint({ id: 'local-dsh', name: 'Remote', sshHost: 'remote' }),
    /保留/,
  )
  assert.throws(
    () => normalizeEndpoint({ id: 'other-local', mode: 'local', name: 'Local', remotePort: 3080 }),
    /标识不正确/,
  )
})

test('rejects an unknown connection mode', () => {
  assert.throws(() => normalizeEndpoint({ mode: 'direct', name: 'bad' }), /连接方式不可用/)
})
test('rejects an SSH option disguised as a host', () => {
  assert.throws(() => normalizeEndpoint({ name: 'bad', sshHost: '-oProxyCommand=evil' }), /SSH 地址/)
})

test('rejects invalid ports', () => {
  assert.throws(() => normalizeEndpoint({ name: 'bad', sshHost: 'host', localPort: 70000 }), /本地端口/)
})
