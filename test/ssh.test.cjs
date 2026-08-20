const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSshArgs } = require('../src/core/ssh.cjs')

test('builds a non-interactive local-forward command without a shell', () => {
  const args = buildSshArgs({
    id: 'endpoint-1',
    name: 'Work Mac',
    sshHost: '192.0.2.10',
    sshUser: 'test-user',
    sshPort: 2222,
    remotePort: 3080,
    localPort: 13080,
  })
  assert.deepEqual(args.slice(-5), ['-L', '127.0.0.1:13080:127.0.0.1:3080', '-p', '2222', 'test-user@192.0.2.10'])
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
  assert.equal(args.includes('ClearAllForwardings=yes'), false)
})
